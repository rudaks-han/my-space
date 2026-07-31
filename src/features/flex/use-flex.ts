import { useCallback, useEffect, useMemo, useState } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useTabActive } from "@/lib/use-tab-active"

/** 자동 새로고침 주기(5분). */
const POLL_MS = 300_000

/** 조직 구성원 캐시 저장 키(새로고침 전까지 재사용). */
const COWORKERS_KEY = "myspace.flexCoworkers"

/** 내 정보(primary 캘린더) 캐시 저장 키 — 내 부서를 알아야 같은 부서를 강조할 수 있다. */
const ME_KEY = "myspace.flexMe"

/** 설정에서 직접 고른 내 부서(자동 감지가 안 될 때의 기준). */
const MY_DEPT_KEY = "myspace.flexMyDept"

/** 정규화한 구성원 한 명. */
export interface FlexCoworker {
  id: string
  name: string
  department: string | null
  profileImageUrl: string | null
}

/** 정규화한 일정 하나. */
export interface FlexEvent {
  id: string
  /** MEETING | TIME_OFF | WORK_RECORD | BIRTHDAY | COMPANY_JOIN_DAY | 기타 */
  type: string
  title: string
  allDay: boolean
  start: string
  end: string
  coworkerId: string | null
  /** 구성원 캐시로 해석한 이름(없으면 이벤트 자체의 이름). */
  personName: string | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 여러 후보 키 중 처음으로 값이 있는 것을 고른다. */
function pick(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined
  for (const k of keys) {
    const v = obj[k]
    if (v !== undefined && v !== null && v !== "") return v
  }
  return undefined
}

/** flex 응답에서 배열(list/calendars/data…)을 유연하게 꺼낸다. */
function extractArray(raw: any, keys: string[]): any[] {
  if (Array.isArray(raw)) return raw
  for (const k of keys) {
    if (Array.isArray(raw?.[k])) return raw[k]
  }
  // { data: { list: [...] } } 처럼 한 겹 더 들어간 경우도 시도.
  if (raw?.data && typeof raw.data === "object")
    return extractArray(raw.data, keys)
  return []
}

/**
 * flexEventJson.title 에서 사람 이름만 뽑는다.
 * 제목은 "🌴 [송주경] 휴가" / "🧑‍💻 [백기환] 출장/상주 - 9:00 AM ~ 6:00 PM" 처럼
 * 이모지·요약·시간이 섞여 있고, 대괄호 안이 이름이다.
 */
function personFromTitle(title: unknown): string | undefined {
  if (typeof title !== "string") return undefined
  const m = title.match(/\[([^\]]+)\]/)
  return m ? m[1].trim() : undefined
}

/** 부서명에서 괄호 이후를 떼어낸다(예: "고객개발팀(서울)" → "고객개발팀"). */
function stripParen(name: string): string {
  const i = name.indexOf("(")
  return i > -1 ? name.slice(0, i) : name
}

/** startAt/endAtExclusive 처럼 {dateTime|date} 또는 문자열인 값을 문자열로. */
function dateField(v: any): string | undefined {
  if (v == null) return undefined
  if (typeof v === "string") return v
  return pick(v, ["dateTime", "date"])
}

function normalizeCoworker(c: any): FlexCoworker | null {
  // coworkers 응답: { calendars: [{ token, userDisplayName, departmentName }] }
  // token 이 곧 calendarId(ULID) — events POST 의 calendarIds 로 이 값을 쓴다.
  const id = pick(c, ["token", "calendarId", "id", "coworkerId", "userId"])
  if (id === undefined) return null
  const dept = pick(c, ["departmentName", "deptName", "department", "teamName"])
  return {
    id: String(id),
    name: String(
      pick(c, ["userDisplayName", "userName", "name", "displayName"]) ??
        "(이름 없음)"
    ),
    department: dept != null ? stripParen(String(dept)) : null,
    profileImageUrl:
      pick(c, ["profileImageUrl", "profileImage", "imageUrl", "photoUrl"]) ??
      null,
  }
}

/** Rust `FlexMe` 와 같은 모양 — 내 이름·부서. */
interface FlexMeInfo {
  userIdHash: string
  name: string
  department: string | null
}

/**
 * primary 응답에서 내 캘린더(구성원)를 뽑는다. token 이 곧 내 calendarId.
 * primary 에는 **이름도 부서도 없어서**(그대로 두면 내 휴가가 "(이름 없음)" 으로
 * 나온다) 둘 다 `flex_me`(구성원 검색) 응답에서 받아 채운다.
 */
function extractSelf(primary: any, me: FlexMeInfo | null): FlexCoworker | null {
  if (!primary || typeof primary !== "object") return null
  // { calendar: {...} } / { data: {...} } / 최상위에 token 이 있는 형태 모두 시도.
  const obj =
    (primary.token ? primary : undefined) ??
    primary.calendar ??
    primary.data ??
    primary
  const self = normalizeCoworker(obj)
  if (!self) return null
  return {
    ...self,
    name: me?.name || self.name,
    department: me?.department ?? self.department,
  }
}

function normalizeEvent(
  e: any,
  byId: Record<string, FlexCoworker>
): FlexEvent | null {
  // events 응답: { list: [{ flexEventType, startAt:{dateTime|date},
  //   endAtExclusive:{dateTime|date}, summary, flexEventJson:{title} }] }
  const startObj = pick(e, ["startAt", "startedAt", "startDateTime", "start"])
  const endObj = pick(e, ["endAtExclusive", "endedAt", "endDateTime", "end"])
  const start = dateField(startObj)
  const end = dateField(endObj)
  if (start === undefined) return null

  const flexJson = pick(e, ["flexEventJson"])
  const coworkerId = pick(e, ["calendarId", "coworkerId", "userId", "ownerId"])
  const cid = coworkerId !== undefined ? String(coworkerId) : null

  // 사람은 calendarId 로 구성원 캐시에서 찾는 게 정확하다 — 실제 응답에서 모든 이벤트의
  // calendarId 가 구성원과 맞는다. 캐시에 없을 때만 제목의 "[이름]" 을 쓴다.
  const personName =
    (cid ? byId[cid]?.name : undefined) ??
    personFromTitle(flexJson ? pick(flexJson, ["title"]) : undefined) ??
    pick(e, ["coworkerName", "userName"]) ??
    null

  // 종일 = startAt 에 dateTime 없이 date 만 있을 때.
  const allDay =
    (typeof startObj === "object" &&
      startObj?.date != null &&
      startObj?.dateTime == null) ||
    (typeof start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(start))

  return {
    id: String(pick(e, ["id", "eventId"]) ?? `${start}-${personName ?? ""}`),
    type: String(pick(e, ["flexEventType", "eventType", "type"]) ?? "UNKNOWN"),
    // summary(휴가 종류 등)를 보조 설명으로.
    title: String(pick(e, ["summary"]) ?? ""),
    allDay,
    start: String(start),
    end: String(end ?? start),
    coworkerId: cid,
    personName: personName ? String(personName) : null,
  }
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** 사용자 오류 메시지 한국어화. */
export function flexFriendlyError(code: string): string {
  if (code.includes("not_logged_in") || code.includes("no_credentials"))
    return "Flex 로그인 세션을 찾지 못했습니다. 설정 → Flex 휴가에서 계정을 저장하면 앱이 자동으로 로그인합니다(또는 Chrome 에서 flex.team 에 로그인한 뒤 새로고침)."
  // Chrome 쿠키 DB 접근/복사/열기 실패는 모두 "쿠키를 못 읽었다"로 묶어 안내한다.
  if (
    code.includes("쿠키 DB") ||
    code.includes("Chrome 쿠키") ||
    code.includes("Safe Storage") ||
    code.includes("Keychain")
  )
    return "Chrome 쿠키를 읽지 못했습니다. Chrome 이 켜져 있고 flex.team 에 로그인돼 있는지 확인한 뒤, 키체인 접근을 허용하고 새로고침해 주세요."
  if (code.includes("json_parse"))
    return "Flex 응답을 해석하지 못했습니다(형식 변경 가능)."
  // 자동 로그인 중 flex 서버가 준 한국어 메시지는 그대로 보여 준다.
  if (/[가-힣]/.test(code)) return code
  return `오류: ${code}`
}

/**
 * Flex 조직 구성원 — 새로고침 전까지 localStorage 캐시를 재사용한다.
 * 캐시가 비어 있으면 최초 1회 자동으로 불러온다.
 */
export function useFlexCoworkers() {
  const [coworkers, setCoworkers] = useLocalStorage<FlexCoworker[]>(
    COWORKERS_KEY,
    []
  )
  // 나 자신(primary). coworkers 목록 안에도 들어가지만 그 안에서는 누가 나인지 구분할
  // 수 없으므로 따로 캐시한다.
  const [me, setMe] = useLocalStorage<FlexCoworker | null>(ME_KEY, null)
  const [raw, setRaw] = useState<unknown>(null)
  // primary 원본 — 이 응답에 부서(departmentName)가 들어오는지는 워크스페이스마다
  // 다를 수 있어서 디버그 패널에서 눈으로 확인할 수 있게 남겨 둔다.
  const [primaryRaw, setPrimaryRaw] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 조직도 + 내 캘린더(primary) + 내 이름·부서(flex_me)를 함께 가져온다. 나 자신은
      // coworkers 에 포함되지 않으므로 primary.token 으로 별도 추가해야 내 휴가도
      // 보이고, 이름·부서는 primary 에 없어서 flex_me 로 채운다.
      const [data, primary, meInfo] = await Promise.all([
        trackedInvoke<unknown>("flex_coworkers"),
        trackedInvoke<unknown>("flex_primary").catch(() => null),
        trackedInvoke<FlexMeInfo>("flex_me").catch(() => null),
      ])
      setRaw(data)
      setPrimaryRaw(primary)
      const list = extractArray(data, [
        "calendars",
        "coworkers",
        "results",
        "items",
      ])
        .map(normalizeCoworker)
        .filter((c): c is FlexCoworker => c !== null)

      // primary 응답에서 내 캘린더를 뽑아 목록 맨 앞에 추가(중복이면 제외).
      const self = extractSelf(primary, meInfo)
      if (self) setMe(self)
      if (self && !list.some((c) => c.id === self.id)) list.unshift(self)

      setCoworkers(list)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [setCoworkers, setMe])

  // 캐시가 없을 때만 최초 1회 로드(있으면 재사용 — 새로고침은 수동).
  useEffect(() => {
    if (coworkers.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void refresh()
      return
    }
    // 구성원 캐시는 있는데 내 정보가 없거나 부서가 비어 있는 경우(이전 버전 캐시) —
    // 구성원 전체를 다시 받지 않고 내 정보만 가볍게 한 번 더 읽는다.
    if (me?.department) return
    void (async () => {
      try {
        const [primary, meInfo] = await Promise.all([
          trackedInvoke<unknown>("flex_primary"),
          trackedInvoke<FlexMeInfo>("flex_me").catch(() => null),
        ])
        setPrimaryRaw(primary)
        const self = extractSelf(primary, meInfo)
        if (self) setMe(self)
      } catch {
        // 실패해도 같은 부서 강조만 못 하므로 화면에 오류를 띄우지 않는다.
      }
    })()
    // 최초 마운트 시 한 번만. (coworkers 를 deps 에 넣으면 매번 재실행된다.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const byId = useMemo(() => {
    const m: Record<string, FlexCoworker> = {}
    for (const c of coworkers) m[c.id] = c
    return m
  }, [coworkers])

  return { coworkers, byId, me, raw, primaryRaw, loading, error, refresh }
}

/**
 * 같은 부서 강조의 기준이 되는 **내 부서**.
 *
 * 기본은 `flex_me` 가 읽어 온 내 소속(`me.department`)이고, 설정에서 고른 값이 있으면
 * 그게 이긴다 — 자동으로 읽히는 단위가 본부인데 팀 단위로 강조하고 싶을 수 있다.
 */
export function useFlexMyDept(me: FlexCoworker | null) {
  const [picked, setPicked] = useLocalStorage<string | null>(MY_DEPT_KEY, null)
  return { dept: picked ?? me?.department ?? null, picked, setPicked }
}

/**
 * 기간 내 Flex 일정. byId(구성원 캐시)로 사람 이름을 해석한다.
 * useGcal 과 같은 keep-alive 패턴: 초기 로드와 tabActive 폴링 effect 를 분리한다.
 */
export function useFlexEvents(
  dateMin: string,
  dateMax: string,
  calendarIds: string[],
  byId: Record<string, FlexCoworker>
) {
  const tabActive = useTabActive()
  const [events, setEvents] = useState<FlexEvent[]>([])
  const [raw, setRaw] = useState<unknown>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // calendarIds 집합이 바뀔 때만 refresh 가 갱신되도록 안정적인 키를 쓴다.
  const idsKey = calendarIds.join(",")

  const refresh = useCallback(async () => {
    // 조회할 구성원 캘린더가 없으면(구성원 캐시 로드 전) 아직 호출하지 않는다.
    if (calendarIds.length === 0) {
      setEvents([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await trackedInvoke<unknown>("flex_events", {
        dateMin,
        dateMax,
        calendarIds,
      })
      setRaw(data)
      const list = extractArray(data, ["list", "events", "results", "items"])
        .map((e) => normalizeEvent(e, byId))
        .filter((e): e is FlexEvent => e !== null)
      setEvents(list)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
    // idsKey 로 캘린더 집합 변화를 추적(배열 identity 무시).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateMin, dateMax, idsKey, byId])

  // 기간/구성원 캐시가 정해지면 로드.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // 주기 새로고침은 이 탭이 보일 때만.
  useEffect(() => {
    if (!tabActive) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [tabActive, refresh])

  return { events, raw, loading, error, updatedAt, refresh }
}
