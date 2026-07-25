import { CalendarIcon, MapPinIcon, VideoIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { CalendarEvent, GcalStatus } from "@/features/gcal/use-gcal"
import { HomeCard, HomeEmpty } from "../home-card"
import { fmtClock, isEventNow } from "../home-utils"

/**
 * 오늘 일정 — 시간순으로 보여주고, 지난 일정은 흐리게, 현재 시각에 구분선을 넣는다.
 */
export function TodayScheduleCard({
  status,
  events,
  now,
}: {
  status: GcalStatus | null
  events: CalendarEvent[]
  /** 현재 시각(epoch ms) — 홈 화면이 주기적으로 갱신해 내려준다. */
  now: number
}) {
  const sorted = [...events].sort((a, b) => {
    if (a.all_day !== b.all_day) return a.all_day ? -1 : 1
    return new Date(a.start).getTime() - new Date(b.start).getTime()
  })
  // "지금" 선을 넣을 위치 = 아직 끝나지 않은 첫 일정의 인덱스.
  const nowIndex = sorted.findIndex(
    (e) => !e.all_day && new Date(e.end).getTime() > now
  )

  return (
    <HomeCard
      icon={CalendarIcon}
      title="오늘 일정"
      count={events.length}
      menuId="gcal"
    >
      {status && !status.connected ? (
        <HomeEmpty>
          Google 캘린더가 연결되지 않았습니다 — 설정에서 연결해 주세요.
        </HomeEmpty>
      ) : sorted.length === 0 ? (
        <HomeEmpty>오늘 일정이 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-1">
          {sorted.map((ev, i) => {
            const running = isEventNow(ev, now)
            const past = !ev.all_day && new Date(ev.end).getTime() <= now
            return (
              <li key={`${ev.start}-${ev.summary}`} className="flex flex-col">
                {i === nowIndex && nowIndex > 0 && (
                  <div className="my-1 flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-primary" />
                    <span className="h-px flex-1 bg-primary/40" />
                    <span className="text-[10px] font-medium text-primary">
                      지금 {fmtClock(now)}
                    </span>
                  </div>
                )}
                <div
                  className={cn(
                    "flex items-start gap-3 rounded-lg px-2 py-1.5",
                    running && "bg-primary/5 ring-1 ring-primary/30",
                    past && "opacity-45"
                  )}
                >
                  <span className="w-11 shrink-0 pt-0.5 text-xs font-medium tabular-nums">
                    {ev.all_day ? "종일" : fmtClock(ev.start)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{ev.summary}</span>
                    {ev.location && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPinIcon className="size-3 shrink-0" />
                        <span className="truncate">{ev.location}</span>
                      </span>
                    )}
                  </div>
                  {ev.meet_link && (
                    <a
                      href={ev.meet_link}
                      title="화상 회의 참여"
                      className="shrink-0 pt-0.5 text-primary hover:underline"
                    >
                      <VideoIcon className="size-4" />
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </HomeCard>
  )
}
