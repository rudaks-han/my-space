import {
  CakeIcon,
  CalendarIcon,
  ExternalLinkIcon,
  PalmtreeIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react"
import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { trackedInvoke } from "@/lib/tauri"
import { cn } from "@/lib/utils"

import {
  flexFriendlyError,
  useFlexCoworkers,
  useFlexEvents,
  useFlexMyDept,
  type FlexEvent,
} from "./use-flex"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** 유형 → 한글 라벨·배지색. */
const TYPE_META: Record<string, { label: string; cls: string }> = {
  TIME_OFF: { label: "휴가", cls: "bg-ui-warning/15 text-ui-warning" },
  MEETING: { label: "회의", cls: "bg-ui-info/15 text-ui-info" },
  WORK_RECORD: { label: "근무", cls: "bg-ui-success/15 text-ui-success" },
  BIRTHDAY: { label: "생일", cls: "bg-ui-mention text-ui-mention-fg" },
  COMPANY_JOIN_DAY: {
    label: "입사일",
    cls: "bg-ui-highlight text-foreground",
  },
}

function typeLabel(t: string): string {
  return TYPE_META[t]?.label ?? t
}

/** RFC3339(로컬 오프셋 포함) 문자열. flex API 의 dateTimeMin 형식과 맞춘다. */
function rfc3339Local(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const tz = -d.getTimezoneOffset() // KST = +540
  const sign = tz >= 0 ? "+" : "-"
  const th = pad(Math.floor(Math.abs(tz) / 60))
  const tm = pad(Math.abs(tz) % 60)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${th}:${tm}`
  )
}

/**
 * 화면에는 이번주·다음주만 보여주지만, **조회는 그 앞뒤로 한 주씩 더 넓게** 한다.
 * 연속 휴가 구간(아래 `buildSpans`)을 경계에서 잘리지 않게 계산하려면 표시 범위
 * 바깥의 휴가도 알아야 한다 — 없으면 지난주 금요일부터 시작한 휴가가 "월요일 ~"
 * 로 잘려 보인다. flex 는 일요일 시작.
 */
function useWeekRange() {
  return useMemo(() => {
    const now = new Date()
    const thisSun = new Date(now)
    thisSun.setHours(0, 0, 0, 0)
    thisSun.setDate(thisSun.getDate() - thisSun.getDay())
    const nextSun = new Date(thisSun)
    nextSun.setDate(nextSun.getDate() + 7)
    const displayEnd = new Date(thisSun)
    displayEnd.setDate(displayEnd.getDate() + 14)
    // 조회 범위: 표시 범위 ±1주.
    const fetchMin = new Date(thisSun)
    fetchMin.setDate(fetchMin.getDate() - 7)
    const fetchMax = new Date(displayEnd)
    fetchMax.setDate(fetchMax.getDate() + 7)
    return {
      dateMin: rfc3339Local(fetchMin),
      dateMax: rfc3339Local(fetchMax),
      thisWeekStart: thisSun.getTime(),
      nextWeekStart: nextSun.getTime(),
      displayEnd: displayEnd.getTime(),
    }
    // 마운트 시 한 번 계산(하루 안에서는 값이 안 변한다).
  }, [])
}

function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  })
}

/** "7월 1일" — 연속 휴가 구간 표기용(요일 없이 짧게). */
function shortDayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
  })
}

/** 연속된 휴가 한 구간. `days` 는 실제 휴가일 수(사이의 주말은 세지 않는다). */
interface VacationSpan {
  startMs: number
  endMs: number
  days: number
}

function midnight(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d
}

function isWeekend(d: Date): boolean {
  const g = d.getDay()
  return g === 0 || g === 6
}

/**
 * 이벤트가 걸쳐 있는 날짜들(로컬 자정 기준). `end` 는 flex 의 endAtExclusive 라
 * 종일 일정은 마지막 날을 하루 뺀다(7/1 종일 = 7/1 ~ 7/2 exclusive).
 */
function coveredDates(ev: FlexEvent): Date[] {
  const start = midnight(new Date(ev.start).getTime())
  if (Number.isNaN(start.getTime())) return []
  const endRaw = new Date(ev.end).getTime()
  if (Number.isNaN(endRaw)) return [start]
  const end = midnight(endRaw)
  if (ev.allDay) end.setDate(end.getDate() - 1)
  const out: Date[] = []
  // 잘못된 응답으로 무한 루프가 나지 않게 상한을 둔다.
  for (
    const d = new Date(start);
    out.length < 366;
    d.setDate(d.getDate() + 1)
  ) {
    if (d.getTime() > end.getTime()) break
    out.push(new Date(d))
  }
  return out.length > 0 ? out : [start]
}

/**
 * 두 휴가일이 이어지는지 — **사이에 낀 날이 모두 주말**이면 연속으로 본다.
 * 금(7/3)과 월(7/6) 사이에는 토·일만 있으므로 한 구간, 사이에 평일이 하루라도
 * 있으면 다른 구간이다.
 */
function bridged(prevMs: number, ms: number): boolean {
  const d = midnight(prevMs)
  d.setDate(d.getDate() + 1)
  while (d.getTime() < ms) {
    if (!isWeekend(d)) return false
    d.setDate(d.getDate() + 1)
  }
  return true
}

/** 사람 식별 키 — calendarId 가 정확하고, 없을 때만 이름으로 대체한다. */
function personKeyOf(ev: FlexEvent): string {
  return ev.coworkerId ?? ev.personName ?? ev.id
}

/**
 * 휴가 이벤트를 사람별 연속 구간으로 묶고, **이벤트 id → 그 이벤트가 속한 구간**
 * 을 돌려준다. 하루짜리 휴가는 표기할 게 없으므로 넣지 않는다.
 */
function buildSpans(events: FlexEvent[]): Map<string, VacationSpan> {
  // 사람별 휴가 날짜 집합(ymd 로 중복 제거 — 오전/오후 반차가 같은 날에 겹칠 수 있다).
  const byPerson = new Map<string, Map<number, true>>()
  for (const ev of events) {
    const key = personKeyOf(ev)
    let days = byPerson.get(key)
    if (!days) {
      days = new Map()
      byPerson.set(key, days)
    }
    for (const d of coveredDates(ev)) days.set(d.getTime(), true)
  }

  const runsByPerson = new Map<string, VacationSpan[]>()
  for (const [key, days] of byPerson) {
    const sorted = [...days.keys()].sort((a, b) => a - b)
    const runs: VacationSpan[] = []
    for (const ms of sorted) {
      const last = runs[runs.length - 1]
      if (last && bridged(last.endMs, ms)) {
        last.endMs = ms
        last.days += 1
      } else {
        runs.push({ startMs: ms, endMs: ms, days: 1 })
      }
    }
    runsByPerson.set(key, runs)
  }

  const out = new Map<string, VacationSpan>()
  for (const ev of events) {
    const t = midnight(new Date(ev.start).getTime()).getTime()
    const run = runsByPerson
      .get(personKeyOf(ev))
      ?.find((r) => t >= r.startMs && t <= r.endMs)
    if (run && run.days > 1) out.set(ev.id, run)
  }
  return out
}

/**
 * 일정 한 줄 — 사람 이름을 굵게, 부서·유형 배지 + 시간.
 * `sameDept`(나와 같은 부서)면 이름과 부서를 멘션 칩 색으로 칠해 한눈에 구분한다.
 */
function EventRow({
  ev,
  dept,
  sameDept,
  span,
}: {
  ev: FlexEvent
  dept: string | null
  sameDept: boolean
  span: VacationSpan | undefined
}) {
  const meta = TYPE_META[ev.type]
  return (
    <div className="flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 text-[15px] transition-colors hover:bg-ui-list-hover">
      {/* 시간 칸: 연속 휴가면 그 뒤에 전체 기간을 붙인다. 기간이 붙어도 유형 배지가
          어긋나지 않게 고정폭이 아니라 min-w 로 잡는다. */}
      <span className="min-w-[176px] shrink-0 text-right text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
        {ev.allDay ? "종일" : `${hhmm(ev.start)}–${hhmm(ev.end)}`}
        {span &&
          `(${shortDayLabel(span.startMs)} ~ ${shortDayLabel(span.endMs)})`}
      </span>
      <span
        className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
          meta?.cls ?? "bg-muted text-muted-foreground"
        )}
      >
        {typeLabel(ev.type)}
      </span>
      <span
        className={cn(
          "shrink-0 font-bold",
          sameDept &&
            "rounded-full bg-ui-mention px-2 py-0.5 text-ui-mention-fg"
        )}
      >
        {ev.personName ?? "—"}
      </span>
      {dept && (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
            sameDept
              ? "bg-ui-mention text-ui-mention-fg"
              : "bg-muted text-muted-foreground"
          )}
        >
          {dept}
        </span>
      )}
      {/* 유형 배지와 같은 말이면(휴가/휴가) 굳이 반복하지 않는다. */}
      {ev.title && ev.title !== typeLabel(ev.type) && (
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
          {ev.title}
        </span>
      )}
    </div>
  )
}

/**
 * 한 주치 일정을 날짜별로 묶어 보여준다. deptOf 로 각 일정에 부서를 붙이고,
 * myDept 와 같으면 칩으로 강조한다.
 */
function WeekSection({
  title,
  events,
  deptOf,
  myDept,
  spans,
}: {
  title: string
  events: FlexEvent[]
  deptOf: (ev: FlexEvent) => string | null
  myDept: string | null
  spans: Map<string, VacationSpan>
}) {
  const days: { key: string; iso: string; items: FlexEvent[] }[] = []
  for (const ev of events) {
    const key = dayKey(ev.start)
    const last = days[days.length - 1]
    if (last && last.key === key) last.items.push(ev)
    else days.push({ key, iso: ev.start, items: [ev] })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-bold">{title}</span>
        <span className="text-[13px] text-muted-foreground">
          {events.length}건
        </span>
      </div>
      {events.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-muted-foreground">
          일정이 없습니다.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 rounded-[10px] border border-border bg-card p-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {days.map((day) => (
            <div key={day.key} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2 px-3 pt-1.5 pb-0.5">
                <span className="text-[13px] font-semibold text-muted-foreground">
                  {dayLabel(day.iso)}
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {day.items.map((ev) => {
                const dept = deptOf(ev)
                return (
                  <EventRow
                    key={ev.id}
                    ev={ev}
                    dept={dept}
                    sameDept={myDept !== null && dept === myDept}
                    span={spans.get(ev.id)}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function FlexView() {
  const { dateMin, dateMax, thisWeekStart, nextWeekStart, displayEnd } =
    useWeekRange()
  const {
    byId,
    coworkers,
    me,
    raw: coworkersRaw,
    primaryRaw,
    loading: cwLoading,
    error: cwError,
    refresh: refreshCoworkers,
  } = useFlexCoworkers()
  // events POST 에 넘길 구성원 캘린더 ID 목록(캐시된 구성원 전체).
  const calendarIds = useMemo(() => coworkers.map((c) => c.id), [coworkers])
  const { events, raw, loading, error, updatedAt, refresh } = useFlexEvents(
    dateMin,
    dateMax,
    calendarIds,
    byId
  )

  // 부서는 이벤트의 calendarId 로 구성원을 찾아 붙인다(정확한 키). 구성원 캐시가
  // 오래돼 그 id 가 없을 때만 이름으로 한 번 더 시도한다.
  const deptByName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of coworkers) if (c.department) m[c.name] = c.department
    return m
  }, [coworkers])
  const deptOf = (ev: FlexEvent) =>
    (ev.coworkerId ? byId[ev.coworkerId]?.department : null) ??
    (ev.personName ? (deptByName[ev.personName] ?? null) : null)

  // 내 부서 — 설정에서 고른 값이 우선, 없으면 primary 가 준 부서. 둘 다 없으면 강조하지 않는다.
  const { dept: myDept } = useFlexMyDept(me)

  // 연속 휴가 구간은 **표시 범위로 자르기 전의 전체 응답**으로 계산해야 한다 —
  // 지난주·다다음주까지 이어지는 휴가도 온전한 기간으로 보여주기 위해서.
  const spans = useMemo(
    () => buildSpans(events.filter((e) => e.type === "TIME_OFF")),
    [events]
  )

  // 휴가만 볼지 전체를 볼지.
  const [onlyVacation, setOnlyVacation] = useState(true)
  // 조회는 ±1주 넓게 했으므로 표시 단계에서 이번주·다음주로 되돌린다.
  const filtered = events.filter((e) => {
    if (onlyVacation && e.type !== "TIME_OFF") return false
    const t = new Date(e.start).getTime()
    return t >= thisWeekStart && t < displayEnd
  })

  // 날짜(시작 시각) 오름차순 정렬 — 날짜별 그룹이 어긋나지 않도록 그룹핑 전에 정렬한다.
  const sorted = [...filtered].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  )

  const thisWeek = sorted.filter(
    (e) => new Date(e.start).getTime() < nextWeekStart
  )
  const nextWeek = sorted.filter(
    (e) => new Date(e.start).getTime() >= nextWeekStart
  )

  const shownError = error ?? cwError

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <PalmtreeIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">Flex 휴가 · 일정</span>
        {/* 칩 색이 무슨 뜻인지 알 수 있게 내 부서명을 같은 칩으로 한 번 보여 준다.
            부서를 모를 때는(설정 미지정 + primary 에 부서 없음) 어디서 정하는지 알려 준다. */}
        {myDept ? (
          <span className="rounded-full bg-ui-mention px-2 py-0.5 text-[11px] font-bold text-ui-mention-fg">
            {myDept}
          </span>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            내 부서를 아직 못 읽었습니다 — 구성원 새로고침을 누르거나 설정 →
            Flex 휴가에서 직접 고르면 같은 부서를 칩으로 강조합니다
          </span>
        )}
        <span className="text-[13px] text-muted-foreground">
          구성원 {coworkers.length}명
          {updatedAt &&
            ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })} 업데이트`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void trackedInvoke("flex_open_time_off")}
            title="flex.team 휴가 신청 화면을 브라우저에서 엽니다"
          >
            <ExternalLinkIcon className="size-3.5" />
            휴가 신청
          </Button>
          <Button
            variant={onlyVacation ? "default" : "outline"}
            className={PILL}
            onClick={() => setOnlyVacation((v) => !v)}
          >
            {onlyVacation ? (
              <PalmtreeIcon className="size-3.5" />
            ) : (
              <CalendarIcon className="size-3.5" />
            )}
            {onlyVacation ? "휴가만" : "전체"}
          </Button>
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refreshCoworkers()}
            disabled={cwLoading}
            title="구성원 목록 새로고침"
          >
            <UsersIcon
              className={cn("size-3.5", cwLoading && "animate-spin")}
            />
            구성원
          </Button>
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
            새로고침
          </Button>
        </div>
      </div>

      {shownError && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {flexFriendlyError(shownError)}
        </p>
      )}

      {loading && events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
          일정을 불러오는 중…
        </div>
      ) : filtered.length === 0 && !shownError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <CakeIcon className="size-9 text-muted-foreground" />
          <p className="text-[15px] text-muted-foreground">
            {onlyVacation
              ? "이번주·다음주 휴가가 없습니다."
              : "이번주·다음주 일정이 없습니다."}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <WeekSection
            title="이번주"
            events={thisWeek}
            deptOf={deptOf}
            myDept={myDept}
            spans={spans}
          />
          <WeekSection
            title="다음주"
            events={nextWeek}
            deptOf={deptOf}
            myDept={myDept}
            spans={spans}
          />
        </div>
      )}

      {/* 스키마 확인용 원본 JSON — 필드 매핑이 어긋나면 여기서 실제 응답을 확인한다. */}
      <details className="mt-2 rounded-[10px] border border-border bg-card p-3 text-[13px]">
        <summary className="cursor-pointer font-semibold text-muted-foreground">
          원본 JSON 보기 (디버그)
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          <div>
            <p className="mb-1 font-semibold">events</p>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 font-mono text-[12px]">
              {JSON.stringify(raw, null, 2)}
            </pre>
          </div>
          <div>
            <p className="mb-1 font-semibold">coworkers</p>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 font-mono text-[12px]">
              {JSON.stringify(coworkersRaw, null, 2)}
            </pre>
          </div>
          {/* 내 부서 자동 감지가 되는지는 여기서 확인한다 — departmentName 이 있으면 자동, 없으면 설정에서 지정. */}
          <div>
            <p className="mb-1 font-semibold">primary (내 정보)</p>
            <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-2 font-mono text-[12px]">
              {JSON.stringify(primaryRaw, null, 2)}
            </pre>
          </div>
        </div>
      </details>
    </div>
  )
}
