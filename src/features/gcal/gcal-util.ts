import type { CalendarEvent } from "./use-gcal"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
export const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/**
 * 일정의 성격 — 색과 라벨을 고르는 데 쓴다.
 * 구글의 `eventType` 이 1순위(부재중/집중시간/근무지는 구글이 직접 표시해 준다)이고,
 * 사내에서 그냥 일반 일정으로 잡는 휴가·외근은 제목 키워드로 잡는다.
 */
export type EventKind = "leave" | "out" | "focus" | "meeting"

const LEAVE_WORDS = ["휴가", "연차", "반차", "월차", "경조", "휴무", "병가"]
const OUT_WORDS = ["외근", "출장", "재택", "교육", "세미나 참석", "파견"]

export function eventKind(ev: CalendarEvent): EventKind {
  switch (ev.event_type) {
    case "outOfOffice":
      return "leave"
    case "focusTime":
      return "focus"
    case "workingLocation":
      return "out"
  }
  const s = ev.summary
  if (LEAVE_WORDS.some((w) => s.includes(w))) return "leave"
  if (OUT_WORDS.some((w) => s.includes(w))) return "out"
  return "meeting"
}

/** 성격별 한글 라벨 — 타임라인 범례와 배지에 쓴다. */
export const KIND_LABEL: Record<EventKind, string> = {
  leave: "휴가·부재",
  out: "외근·출장",
  focus: "집중 시간",
  meeting: "회의",
}

/**
 * 성격별 색. 블록(배경+테두리)과 글자를 따로 두는 건, 종일 칩은 글자가 배경 위에
 * 얹히고 타임라인 블록은 아주 얇을 수도 있어 대비 기준이 다르기 때문이다.
 */
export const KIND_STYLE: Record<EventKind, { block: string; text: string }> = {
  leave: {
    block: "bg-ui-warning/25 ring-ui-warning/45",
    text: "text-ui-warning",
  },
  out: {
    block: "bg-ui-success/25 ring-ui-success/45",
    text: "text-ui-success",
  },
  focus: {
    block: "bg-muted-foreground/20 ring-muted-foreground/35",
    text: "text-muted-foreground",
  },
  meeting: { block: "bg-ui-info/25 ring-ui-info/45", text: "text-ui-info" },
}

/** 지금 진행 중인 일정인지(현재 시각이 start~end 사이). */
export function isNow(ev: CalendarEvent): boolean {
  if (ev.all_day) return false
  const now = Date.now()
  return new Date(ev.start).getTime() <= now && now < new Date(ev.end).getTime()
}

/** hh:mm 한 조각. iso 문자열 또는 epoch ms 를 받는다. */
export function hhmm(iso: string | number): string {
  return new Date(iso).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 로컬 자정 기준 다음주 월요일(주 시작 = 월요일). 이번주/다음주 경계로 쓴다. */
export function nextMondayStart(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  // getDay(): 일=0…토=6 → 월요일까지 남은 일수.
  const daysUntilNextMonday = (8 - d.getDay()) % 7 || 7
  d.setDate(d.getDate() + daysUntilNextMonday)
  return d.getTime()
}

/** "YYYY-MM-DD"(로컬) — 날짜별 그룹 키. */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** 오늘 날짜인지 — 날짜 그룹을 강조 표시할 때 쓴다. */
export function isToday(iso: string): boolean {
  return dayKey(iso) === dayKey(new Date().toISOString())
}

/** "7월 27일 (월)" 같은 날짜 구분선 라벨. */
export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  })
}

/** 이번주/다음주로 나눈다(경계 = 다음주 월요일 자정). */
export function splitByWeek(events: CalendarEvent[]): {
  thisWeek: CalendarEvent[]
  nextWeek: CalendarEvent[]
} {
  const threshold = nextMondayStart()
  const thisWeek: CalendarEvent[] = []
  const nextWeek: CalendarEvent[] = []
  for (const ev of events) {
    if (new Date(ev.start).getTime() < threshold) thisWeek.push(ev)
    else nextWeek.push(ev)
  }
  return { thisWeek, nextWeek }
}

/** 시간 구간(epoch ms). 예약된 구간·빈 구간 표현에 쓴다. */
export interface Interval {
  start: number
  end: number
}

const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** ts(epoch ms)가 속한 로컬 자정(그날 00:00). */
export function localMidnight(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 하루치 타임라인에 그릴 시간 창(업무시간, 기본 08:00–20:00).
 * `dayMid` 는 대상 날짜의 로컬 자정. 그날 일정이 창 밖으로 나가면
 * 시(hour) 단위로 창을 넓혀 다 보이게 한다.
 */
export function dayWindow(events: CalendarEvent[], dayMid: number): Interval {
  let startH = 8
  let endH = 20
  for (const ev of events) {
    if (ev.all_day) continue
    const s = new Date(ev.start)
    if (s.getTime() < dayMid || s.getTime() >= dayMid + DAY_MS) continue // 그날 것만
    const e = new Date(ev.end)
    startH = Math.min(startH, s.getHours())
    // 정각이 아니면 다음 시까지 올려 블록이 잘리지 않게 한다.
    const endHour =
      e.getMinutes() > 0 || e.getSeconds() > 0 ? e.getHours() + 1 : e.getHours()
    endH = Math.max(endH, endHour)
  }
  startH = Math.max(0, startH)
  endH = Math.min(24, Math.max(endH, startH + 1))
  return { start: dayMid + startH * HOUR_MS, end: dayMid + endH * HOUR_MS }
}

/**
 * 창(win) 안에서 회의실이 "사용 중"인 구간들을 겹침 병합해 돌려준다.
 * 종일 일정은 (앱 전체의 `isNow` 규칙과 맞춰) 점유로 치지 않는다.
 */
export function busyIntervals(
  events: CalendarEvent[],
  win: Interval
): Interval[] {
  const raw: Interval[] = []
  for (const ev of events) {
    if (ev.all_day) continue
    const s = Math.max(new Date(ev.start).getTime(), win.start)
    const e = Math.min(new Date(ev.end).getTime(), win.end)
    if (e > s) raw.push({ start: s, end: e })
  }
  raw.sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const iv of raw) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end)
    else merged.push({ ...iv })
  }
  return merged
}

/**
 * 겹치는 구간을 위아래 레인으로 나눈다 — 같은 레인 안에서는 절대 겹치지 않는다.
 * 회의실 타임라인은 겹침을 병합하면 그만이지만(방은 하나), 사람 타임라인은 겹친 일정
 * 하나하나가 다른 회의라 제목이 다 보여야 한다.
 */
export function layoutLanes<T extends Interval>(
  items: T[]
): { lanes: number; placed: { item: T; lane: number }[] } {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end)
  // laneEnds[i] = i 번 레인에 마지막으로 놓인 구간의 끝.
  const laneEnds: number[] = []
  const placed = sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.start)
    if (lane === -1) lane = laneEnds.length
    laneEnds[lane] = item.end
    return { item, lane }
  })
  return { lanes: Math.max(1, laneEnds.length), placed }
}

/**
 * `from` 시각 이후(포함) 처음으로 비는 구간. 창 끝까지 계속 차 있으면 null.
 * `from` 이 이미 빈 시간이면 그 시각부터 시작하는 구간을 돌려준다.
 */
export function nextFreeSlot(
  busy: Interval[],
  from: number,
  winEnd: number
): Interval | null {
  let cursor = from
  if (cursor >= winEnd) return null
  for (const b of busy) {
    if (b.end <= cursor) continue
    if (b.start <= cursor) {
      cursor = b.end // 지금 사용 중 — 이 예약이 끝날 때로 건너뛴다.
      if (cursor >= winEnd) return null
    } else {
      return { start: cursor, end: b.start } // 다음 예약 전까지 빈 구간.
    }
  }
  return { start: cursor, end: winEnd }
}

/**
 * 일정 조회가 실제로 덮는 범위(오늘 자정 ~ 다음주 일요일 끝).
 *
 * Rust 의 `upcoming_range()` 와 같은 값이어야 한다 — `gcal_calendar_events` 는 이
 * 범위만 돌려주므로, 밖의 날짜는 "일정이 없다" 가 아니라 "모른다" 다. 그 구분을
 * 하지 않으면 3주 뒤 날짜에서 모든 회의실이 비어 보인다.
 */
export function upcomingRange(): Interval {
  return {
    start: localMidnight(Date.now()),
    end: nextMondayStart() + 7 * DAY_MS,
  }
}

/**
 * `from` 이후로 `durationMs` 가 통째로 들어가는 첫 빈 구간. 없으면 null.
 *
 * `nextFreeSlot` 은 "다음 예약 전까지" 를 돌려줄 뿐이라 그 틈이 요청 길이보다 짧을 수
 * 있다 — 10분짜리 틈을 "가능" 이라고 제안하면 눌러 봐야 겹친다. 짧은 틈은 건너뛰고
 * 다시 찾는다. 커서는 매번 앞으로만 가므로(빈 구간의 끝 → 그 뒤 예약의 끝) 반드시 끝난다.
 */
export function firstFittingSlot(
  busy: Interval[],
  from: number,
  winEnd: number,
  durationMs: number
): Interval | null {
  let cursor = from
  for (;;) {
    const gap = nextFreeSlot(busy, cursor, winEnd)
    if (!gap) return null
    if (gap.end - gap.start >= durationMs)
      return { start: gap.start, end: gap.start + durationMs }
    // 이 틈은 좁다 — 다음 예약 뒤에서 다시 찾는다.
    cursor = gap.end + 1
  }
}

/** 요청한 시간대에서 회의실 한 곳의 상태. */
export interface SlotStatus {
  /** 요청 구간 내내 비어 있는지. */
  free: boolean
  /** 겹치는 예약이 모두 끝나는 시각(사용 중일 때만). */
  busyUntil: number | null
  /** 겹치는 예약 중 가장 먼저 시작하는 일정(누가 쓰는지 보여준다). */
  conflict: CalendarEvent | null
  /** 사용 중일 때, 같은 길이가 들어가는 그날의 첫 대안 구간. */
  suggestion: Interval | null
}

/**
 * 회의실 일정과 요청 구간을 견줘 예약 가능 여부를 낸다.
 *
 * 종일 일정은 점유로 치지 않는다 — 앱 전체의 `isNow`·`busyIntervals` 규칙과 같다.
 * 대안 구간은 **그날 자정까지** 안에서 찾는다(업무시간으로 좁히면 18시 이후에 여는
 * 회의실이 "가능한 시간 없음" 으로 보인다).
 */
export function slotStatus(
  events: CalendarEvent[],
  slot: Interval
): SlotStatus {
  const dayMid = localMidnight(slot.start)
  const win = { start: dayMid, end: dayMid + DAY_MS }
  const busy = busyIntervals(events, win)
  const overlapping = busy.filter(
    (b) => b.start < slot.end && b.end > slot.start
  )
  if (overlapping.length === 0)
    return { free: true, busyUntil: null, conflict: null, suggestion: null }

  const busyUntil = Math.max(...overlapping.map((b) => b.end))
  // 병합된 구간에는 제목이 없으므로, 겹치는 원본 일정에서 가장 이른 것을 집어 온다.
  const conflict =
    events
      .filter(
        (ev) =>
          !ev.all_day &&
          new Date(ev.start).getTime() < slot.end &&
          new Date(ev.end).getTime() > slot.start
      )
      .sort(
        (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
      )[0] ?? null

  return {
    free: false,
    busyUntil,
    conflict,
    suggestion: firstFittingSlot(
      busy,
      busyUntil,
      win.end,
      slot.end - slot.start
    ),
  }
}

/**
 * "YYYY-MM-DD" + "HH:MM" → epoch ms(로컬). 형식이 깨졌으면 null.
 * 타임존 없는 ISO 문자열은 로컬 시각으로 파싱된다 — 예약도 로컬 기준이라 맞다.
 */
export function parseLocalDateTime(ymd: string, hm: string): number | null {
  const ts = new Date(`${ymd}T${hm}`).getTime()
  return Number.isNaN(ts) ? null : ts
}

/** Date → "YYYY-MM-DD"(로컬). date input 및 예약 요청에 쓴다. */
export function toYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** epoch ms → "HH:MM"(24시간, 로컬). time input 값에 쓴다. */
export function toHm(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, "0")
  const m = String(d.getMinutes()).padStart(2, "0")
  return `${h}:${m}`
}

/**
 * ts(epoch ms)를 다음 정각으로 올린 epoch ms(이미 정각이면 그대로).
 * 예약 시작 기본값에 쓴다 — 09:10 이면 10:00.
 */
export function ceilToHour(ts: number): number {
  const d = new Date(ts)
  if (d.getMinutes() !== 0 || d.getSeconds() !== 0 || d.getMilliseconds() !== 0)
    d.setHours(d.getHours() + 1, 0, 0, 0)
  return d.getTime()
}

/** 타임라인에서 고른 슬롯 → 예약 폼 자동 채움 값. */
export interface BookingPrefill {
  roomId: string
  /** "YYYY-MM-DD" */
  date: string
  /** "HH:MM" */
  startHm: string
  endHm: string
}
