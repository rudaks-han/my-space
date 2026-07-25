import type { CalendarEvent } from "@/features/gcal/use-gcal"
import type { Reminder } from "@/features/reminder/use-reminders"

/** 하루(ms). */
const DAY_MS = 86_400_000

/** epoch ms 기준 경과 시간을 "방금 / 3분 전 / 2시간 전" 형태로. */
export function fmtAgo(at: number, now: number = Date.now()): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return "방금"
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

/** 소요 시간을 "42초 / 18분 / 1시간 5분" 형태로. */
export function fmtDuration(ms: number | null): string | null {
  if (ms == null || ms < 0) return null
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}초`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}분`
  return `${Math.floor(min / 60)}시간 ${min % 60}분`
}

/** "14:30" 형태의 시각. */
export function fmtClock(value: number | string | Date): string {
  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 오늘 날짜를 "7월 25일 금요일" 형태로. */
export function fmtToday(now: number = Date.now()): string {
  return new Date(now).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  })
}

/** 시각대로 인사말. */
export function greeting(now: number = Date.now()): string {
  const h = new Date(now).getHours()
  if (h < 6) return "늦은 시간까지 고생 많으세요"
  if (h < 12) return "좋은 아침입니다"
  if (h < 18) return "오늘도 힘내세요"
  return "오늘 하루 마무리해 볼까요"
}

/** 일정이 지금 진행 중인지(종일 일정은 제외). */
export function isEventNow(
  ev: CalendarEvent,
  now: number = Date.now()
): boolean {
  if (ev.all_day) return false
  return new Date(ev.start).getTime() <= now && now < new Date(ev.end).getTime()
}

/** 일정 시작까지 남은 분(이미 시작했으면 음수). 종일 일정은 null. */
export function minutesUntil(
  ev: CalendarEvent,
  now: number = Date.now()
): number | null {
  if (ev.all_day) return null
  return Math.round((new Date(ev.start).getTime() - now) / 60_000)
}

/** 아직 시작하지 않은 가장 가까운 일정. 없으면 null. */
export function nextEvent(
  events: CalendarEvent[],
  now: number = Date.now()
): CalendarEvent | null {
  const upcoming = events
    .filter((e) => !e.all_day && new Date(e.start).getTime() > now)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  return upcoming[0] ?? null
}

/**
 * 알림의 다음 예정 시각(epoch ms). 꺼져 있거나 이미 끝난 1회성 알림은 null.
 * 매일 알림은 오늘 시각이 지났으면 내일로 계산한다.
 */
export function reminderNextAt(
  r: Reminder,
  now: number = Date.now()
): number | null {
  if (!r.enabled) return null
  if (r.repeat === "once") return r.firedAt == null ? r.at : null
  const [h, m] = r.time.split(":").map((n) => parseInt(n, 10))
  const d = new Date(now)
  d.setHours(h || 0, m || 0, 0, 0)
  const t = d.getTime()
  return t > now ? t : t + DAY_MS
}

/** 최근에 울린 1회성 알림인지(기본 2시간 이내) — 놓쳤을 수 있어 홈에서 한 번 더 보여준다. */
export function isRecentlyFired(
  r: Reminder,
  now: number = Date.now(),
  windowMs = 2 * 60 * 60 * 1000
): boolean {
  return (
    r.repeat === "once" &&
    r.enabled &&
    r.firedAt != null &&
    now - r.firedAt < windowMs
  )
}
