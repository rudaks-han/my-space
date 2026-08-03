import { useCallback, useEffect, useRef, useState } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"

export interface GcalStatus {
  connected: boolean
  email: string | null
  /** 회의실 예약(쓰기)이 가능한지. false 면 재연결이 필요하다. */
  can_write: boolean
  /** 도메인 주소록으로 참석자 이름을 채울 수 있는지. false 면 재연결이 필요하다. */
  can_directory: boolean
  /** 저장된 OAuth 클라이언트 ID(재연결 폼 자동 채움). 없으면 null. */
  client_id: string | null
  /** 보안 비밀이 저장돼 있는지. 값 자체는 Rust 밖으로 나오지 않는다. */
  has_secret: boolean
}

/** 연결이 전혀 없는 상태(상태 조회 실패 시의 안전한 기본값). */
const DISCONNECTED: GcalStatus = {
  connected: false,
  email: null,
  can_write: false,
  can_directory: false,
  client_id: null,
  has_secret: false,
}

/** 내 구글 캘린더 목록 항목(회의실 선택용). */
export interface CalendarInfo {
  id: string
  summary: string
  primary: boolean
}

/** 저장한 회의실 하나(로컬 저장). */
export interface RoomRef {
  id: string
  name: string
}

/** 일정 참석자 한 명. */
export interface Attendee {
  /** displayName, 없으면 이메일의 로컬 파트. */
  name: string
  email: string
  response_status: "accepted" | "declined" | "tentative" | "needsAction"
  organizer: boolean
  /** 나 자신인지. */
  is_self: boolean
}

export interface CalendarEvent {
  summary: string
  /** RFC3339 dateTime, all-day 면 "YYYY-MM-DD". */
  start: string
  end: string
  all_day: boolean
  location: string | null
  html_link: string | null
  meet_link: string | null
  /** 주최자 → 나 → 나머지 순. 회의실 등 리소스는 빠져 있다. */
  attendees: Attendee[]
  /** 구글의 eventType — "default" | "outOfOffice" | "focusTime" | "workingLocation" | … */
  event_type: string
}

/** 도메인 구성원 한 명(전체 일정 탭의 검색·선택 대상). */
export interface Person {
  email: string
  name: string
}

/** 구성원 한 명의 일정 조회 결과. */
export interface PersonSchedule {
  email: string
  /** "full" = 제목까지, "busy" = 바쁨 구간만, "denied" = 볼 수 없음. */
  access: "full" | "busy" | "denied"
  events: CalendarEvent[]
  error: string | null
}

/** 오늘 일정 자동 새로고침 주기(5분). */
const POLL_MS = 300_000

/**
 * Google 캘린더 연결 상태만 관리한다(연결/해제는 설정 화면에서 한다).
 * client_id/secret·토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 */
export function useGcalConnection() {
  const [status, setStatus] = useState<GcalStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      setError(null)
      try {
        // 브라우저 로그인 완료까지 대기(최대 3분) — 완료되면 상태가 채워진다.
        // 빈 문자열을 넘기면 Rust 가 저장된 클라이언트 정보를 쓴다.
        setStatus(
          await trackedInvoke<GcalStatus>("gcal_start_auth", {
            clientId,
            clientSecret,
          })
        )
      } catch (e) {
        setError(String(e))
      }
    },
    []
  )

  const disconnect = useCallback(async (forgetClient = false) => {
    // 해제 후 상태는 Rust 가 돌려준다 — 클라이언트 정보가 남았는지 여기서 추측하지 않는다.
    setStatus(
      await trackedInvoke<GcalStatus>("gcal_disconnect", { forgetClient })
    )
    setError(null)
  }, [])

  // 최초 1회 연동 상태 확인.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<GcalStatus>("gcal_status")
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus(DISCONNECTED)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { status, error, connect, disconnect }
}

/** "today" = 오늘만(홈 카드), "upcoming" = 이번주+다음주(캘린더 뷰). */
export type GcalRange = "today" | "upcoming"

/**
 * 연결 상태 + 일정을 관리한다. 연결돼 있을 때만 일정을 불러온다.
 * range 로 조회 범위를 고른다(기본 "today").
 */
export function useGcal(range: GcalRange = "today") {
  const { status, error: connError, disconnect } = useGcalConnection()
  const tabActive = useTabActive()
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const command = range === "upcoming" ? "gcal_upcoming" : "gcal_today"
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await trackedInvoke<CalendarEvent[]>(command)
      setEvents(data)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [command])

  // 연결이 확인되면 일정을 한 번 불러온다.
  useEffect(() => {
    if (!status?.connected) return
    // 연결 확인 직후 첫 로드(데이터 페칭 목적의 의도된 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [status?.connected, refresh])

  // 주기 새로고침은 이 탭이 보일 때만 돈다. 숨은 탭은 마지막으로 받은 일정을 그대로 들고
  // 있고, 다시 들어와도 재조회하지 않는다(첫 로드 effect 와 분리해 둔 이유).
  useEffect(() => {
    if (!status?.connected || !tabActive) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.connected, tabActive, refresh])

  return {
    status,
    events,
    loading,
    error: connError ?? error,
    updatedAt,
    disconnect,
    refresh,
  }
}

/** 내 캘린더 목록을 필요할 때 한 번 불러온다(회의실 선택 다이얼로그용). */
export function useGcalCalendars() {
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setCalendars(await trackedInvoke<CalendarInfo[]>("gcal_calendars"))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  return { calendars, loading, error, load }
}

/**
 * 선택한 회의실들의 이번주+다음주 일정을 회의실별로 불러온다.
 * useGcal 과 같은 패턴: 초기 로드 effect 와 tabActive 로 게이트된 폴링 effect 를 분리한다.
 */
export function useRoomSchedule(rooms: RoomRef[]) {
  const tabActive = useTabActive()
  const [byRoom, setByRoom] = useState<Record<string, CalendarEvent[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  // 회의실 집합이 바뀔 때만 effect 가 다시 돌도록 안정적인 키를 쓴다.
  const roomsKey = rooms.map((r) => r.id).join(",")

  const refresh = useCallback(async () => {
    if (rooms.length === 0) {
      setByRoom({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const results = await Promise.all(
        rooms.map((r) =>
          trackedInvoke<CalendarEvent[]>("gcal_calendar_events", {
            calendarId: r.id,
          })
            .then((events) => ({ id: r.id, events }))
            .catch(() => ({ id: r.id, events: [] as CalendarEvent[] }))
        )
      )
      const next: Record<string, CalendarEvent[]> = {}
      for (const { id, events } of results) next[id] = events
      setByRoom(next)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
    // roomsKey 로 회의실 집합 변화만 추적한다(배열 identity 무시).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsKey])

  // 회의실 집합이 정해지면 한 번 불러온다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // 주기 새로고침은 이 탭이 보일 때만.
  useEffect(() => {
    if (!tabActive || rooms.length === 0) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [tabActive, rooms.length, refresh])

  return { byRoom, loading, error, updatedAt, refresh }
}

/**
 * 도메인 주소록(구성원 검색용). 목록 전체를 한 번 받아 두고 검색은 로컬에서 한다 —
 * 주소록은 하루에도 거의 바뀌지 않고, Rust 가 7일 캐시를 들고 있어 재호출도 싸다.
 */
export function useGcalPeople() {
  const [people, setPeople] = useState<Person[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      setPeople(await trackedInvoke<Person[]>("gcal_people", { force }))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  return { people, loading, error, load }
}

/**
 * 선택한 구성원들의 이번주+다음주 일정을 사람별로 불러온다.
 *
 * 사람은 검색하다 하나씩 늘어나므로 useRoomSchedule 과 달리 **증분**으로 받아온다 —
 * 한 명 추가할 때마다 이미 보고 있던 사람들까지 다시 부르면 화면이 매번 통째로 새로고침된다.
 * 이미 받아 둔 사람은 목록에서 뺐다가 다시 넣어도 즉시 보인다(refresh 로만 다시 부른다).
 */
export function usePeopleSchedule(people: Person[]) {
  const tabActive = useTabActive()
  const [byPerson, setByPerson] = useState<Record<string, PersonSchedule>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  /** 한 번이라도 조회를 건 이메일 — 연속 클릭 시 같은 사람을 두 번 부르지 않는다. */
  const requested = useRef<Set<string>>(new Set())
  /** 진행 중인 조회 수. 증분 조회가 겹칠 수 있어 개수로 센다. */
  const inflight = useRef(0)

  // 사람 집합이 바뀔 때만 effect 가 다시 돌도록 안정적인 키를 쓴다.
  const peopleKey = people.map((p) => p.email).join(",")

  /** 주어진 사람들만 조회해 기존 결과에 합친다. */
  const fetchThese = useCallback(async (emails: string[]) => {
    if (emails.length === 0) return
    inflight.current += 1
    setLoading(true)
    setError(null)
    try {
      // 한 명이 실패해도 나머지는 보여야 한다 — 실패는 그 사람의 denied 로 접는다.
      const results = await Promise.all(
        emails.map((email) =>
          trackedInvoke<PersonSchedule>("gcal_person_events", { email }).catch(
            (e): PersonSchedule => ({
              email,
              access: "denied",
              events: [],
              error: String(e),
            })
          )
        )
      )
      setByPerson((prev) => {
        const next = { ...prev }
        for (const r of results) next[r.email] = r
        return next
      })
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      inflight.current -= 1
      if (inflight.current === 0) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => {
    const emails = peopleKey ? peopleKey.split(",") : []
    for (const e of emails) requested.current.add(e)
    return fetchThese(emails)
  }, [peopleKey, fetchThese])

  // 새로 추가된 사람만 불러온다.
  useEffect(() => {
    const emails = peopleKey ? peopleKey.split(",") : []
    const missing = emails.filter((e) => !requested.current.has(e))
    for (const e of missing) requested.current.add(e)
    void fetchThese(missing)
  }, [peopleKey, fetchThese])

  // 주기 새로고침은 이 탭이 보일 때만.
  useEffect(() => {
    if (!tabActive || people.length === 0) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [tabActive, people.length, refresh])

  return { byPerson, loading, error, updatedAt, refresh }
}

/** 회의실 예약 요청. 성공 시 생성된 일정을 반환한다. */
export interface BookRoomInput {
  roomId: string
  roomName: string
  title: string
  /** "YYYY-MM-DD" */
  date: string
  /** "HH:MM" */
  startHm: string
  endHm: string
}

export async function bookRoom(input: BookRoomInput): Promise<CalendarEvent> {
  return trackedInvoke<CalendarEvent>("gcal_book_room", {
    roomId: input.roomId,
    roomName: input.roomName,
    title: input.title,
    date: input.date,
    startHm: input.startHm,
    endHm: input.endHm,
  })
}
