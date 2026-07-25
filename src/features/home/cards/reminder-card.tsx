import { BellIcon, RepeatIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { Reminder } from "@/features/reminder/use-reminders"
import { HomeCard, HomeEmpty } from "../home-card"
import { fmtClock, isRecentlyFired, reminderNextAt } from "../home-utils"

/** 홈에 보여줄 최대 알림 수. */
const MAX_ROWS = 5
/** 하루(ms). */
const DAY_MS = 86_400_000

/** 예정 시각을 "14:30 / 내일 09:00 / 8월 2일 09:00" 형태로. */
function whenText(at: number, now: number): string {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const days = Math.floor((at - today.getTime()) / DAY_MS)
  if (days === 0) return fmtClock(at)
  if (days === 1) return `내일 ${fmtClock(at)}`
  return `${new Date(at).toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
  })} ${fmtClock(at)}`
}

/**
 * 다가오는 알림 — 켜져 있는 알림의 다음 예정 시각을 가까운 순으로.
 * 최근에 울린 1회성 알림은 "울림" 으로 함께 표시한다.
 */
export function ReminderCard({
  reminders,
  now,
}: {
  reminders: Reminder[]
  /** 현재 시각(epoch ms) — 홈 화면이 주기적으로 갱신해 내려준다. */
  now: number
}) {
  const upcoming = reminders
    .map((r) => ({ r, at: reminderNextAt(r, now) }))
    .filter((x): x is { r: Reminder; at: number } => x.at != null)
    .sort((a, b) => a.at - b.at)

  const fired = reminders.filter((r) => isRecentlyFired(r, now))
  const rows = upcoming.slice(0, MAX_ROWS)

  return (
    <HomeCard
      icon={BellIcon}
      title="다가오는 알림"
      count={upcoming.length}
      menuId="reminder"
    >
      {rows.length === 0 && fired.length === 0 ? (
        <HomeEmpty>예정된 알림이 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-1">
          {fired.map((r) => (
            <li
              key={`fired-${r.id}`}
              className="flex items-center gap-2 rounded-lg bg-rose-500/5 px-2 py-1.5"
            >
              <span className="w-16 shrink-0 text-xs font-medium text-rose-600 tabular-nums dark:text-rose-400">
                {fmtClock(r.firedAt!)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
              <span className="shrink-0 rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400">
                울림
              </span>
            </li>
          ))}
          {rows.map(({ r, at }) => (
            <li key={r.id} className="flex items-center gap-2 px-2 py-1.5">
              <span
                className={cn(
                  "w-16 shrink-0 text-xs font-medium tabular-nums",
                  at - now < 60 * 60_000
                    ? "text-primary"
                    : "text-muted-foreground"
                )}
              >
                {whenText(at, now)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
              {r.repeat === "daily" && (
                <span className="shrink-0" title="매일 반복">
                  <RepeatIcon className="size-3 text-muted-foreground" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {upcoming.length > rows.length && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          외 {upcoming.length - rows.length}건
        </p>
      )}
    </HomeCard>
  )
}
