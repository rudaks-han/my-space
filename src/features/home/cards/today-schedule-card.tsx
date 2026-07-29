import { CalendarIcon, MapPinIcon, VideoIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { CalendarEvent, GcalStatus } from "@/features/gcal/use-gcal"
import { HomeCard, HomeEmpty } from "../home-card"
import { fmtClock, isEventNow } from "../home-utils"

/** 1시간(ms). */
const HOUR_MS = 3_600_000

/**
 * 하루 타임라인 — 시간대 위에 일정 블록을 얹고 "지금" 을 세로선으로 표시해,
 * 리스트를 훑기 전에 오늘의 밀도와 다음 빈 시간이 한눈에 잡히도록 한다.
 * 창(window)은 08:00~20:00 을 기본으로 하되 일정·현재 시각을 포함하도록 늘린다.
 * 종일 일정은 시간이 없어 타임라인에서 제외한다(블록은 시간 일정만).
 */
function DayTimeline({
  events,
  now,
}: {
  events: CalendarEvent[]
  now: number
}) {
  const timed = events.filter((e) => !e.all_day)
  if (timed.length === 0) return null

  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const day0 = day.getTime()
  const bounds = timed.flatMap((e) => [
    new Date(e.start).getTime(),
    new Date(e.end).getTime(),
  ])
  const lo =
    Math.floor(Math.min(now, day0 + 8 * HOUR_MS, ...bounds) / HOUR_MS) * HOUR_MS
  const hi =
    Math.ceil(Math.max(now, day0 + 20 * HOUR_MS, ...bounds) / HOUR_MS) * HOUR_MS
  const span = Math.max(hi - lo, HOUR_MS)
  const pct = (t: number) => ((t - lo) / span) * 100
  const nowPct = Math.min(Math.max(pct(now), 0), 100)

  return (
    <div className="mb-1.5 px-3 pt-1">
      <div className="relative h-8 overflow-hidden rounded-lg bg-muted/60">
        {timed.map((ev) => {
          const s = new Date(ev.start).getTime()
          const e = new Date(ev.end).getTime()
          const left = pct(s)
          const width = Math.max(pct(e) - left, 1.5)
          const running = isEventNow(ev, now)
          const past = e <= now
          return (
            <div
              key={`${ev.start}-${ev.summary}`}
              title={`${fmtClock(ev.start)}~${fmtClock(ev.end)} · ${ev.summary}`}
              className={cn(
                "absolute inset-y-1 rounded-[4px]",
                // 진행 중=브랜드 와인색, 지난 일정=흐리게, 앞으로=인포 블루.
                running
                  ? "bg-primary"
                  : past
                    ? "bg-muted-foreground/25"
                    : "bg-ui-info/70"
              )}
              style={{ left: `${left}%`, width: `${width}%` }}
            />
          )
        })}
        {/* "지금" 세로선 — 위쪽에 작은 점을 얹어 눈에 걸리게 한다. */}
        <div
          className="absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-foreground"
          style={{ left: `${nowPct}%` }}
        >
          <span className="absolute -top-0 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground" />
        </div>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{fmtClock(lo)}</span>
        <span className="font-semibold text-foreground">
          지금 {fmtClock(now)}
        </span>
        <span>{fmtClock(hi)}</span>
      </div>
    </div>
  )
}

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
        <>
          <DayTimeline events={sorted} now={now} />
          <ul className="flex flex-col gap-0.5">
            {sorted.map((ev, i) => {
              const running = isEventNow(ev, now)
              const past = !ev.all_day && new Date(ev.end).getTime() <= now
              return (
                <li key={`${ev.start}-${ev.summary}`} className="flex flex-col">
                  {i === nowIndex && nowIndex > 0 && (
                    // "지금" 선은 Slack 의 날짜 구분선처럼 rounded-full 알약 + 가는 선.
                    <div className="my-1.5 flex items-center gap-2 px-3">
                      <span className="h-px flex-1 bg-border" />
                      <span className="shrink-0 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-bold text-primary tabular-nums">
                        지금 {fmtClock(now)}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 transition-colors",
                      // 진행 중인 일정만 와인색 알약으로 채운다(Slack 의 선택 행).
                      running
                        ? "bg-ui-list-active font-bold text-ui-list-active-fg"
                        : "hover:bg-ui-list-hover",
                      past && "opacity-45"
                    )}
                  >
                    <span className="w-12 shrink-0 text-[13px] tabular-nums">
                      {ev.all_day ? "종일" : fmtClock(ev.start)}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px]">{ev.summary}</span>
                      {ev.location && (
                        <span
                          className={cn(
                            "flex items-center gap-1 text-[13px] font-normal",
                            running
                              ? "text-ui-list-active-fg/80"
                              : "text-muted-foreground"
                          )}
                        >
                          <MapPinIcon className="size-3.5 shrink-0" />
                          <span className="truncate">{ev.location}</span>
                        </span>
                      )}
                    </div>
                    {ev.meet_link && (
                      <a
                        href={ev.meet_link}
                        title="화상 회의 참여"
                        className={cn(
                          "shrink-0 hover:underline",
                          running ? "text-ui-list-active-fg" : "text-ui-link"
                        )}
                      >
                        <VideoIcon className="size-4" />
                      </a>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </HomeCard>
  )
}
