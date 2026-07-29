import { ChevronLeftIcon, ChevronRightIcon, EyeOffIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

import {
  DAY_MS,
  dayWindow,
  eventKind,
  hhmm,
  KIND_LABEL,
  KIND_STYLE,
  layoutLanes,
  localMidnight,
  nextMondayStart,
  type EventKind,
} from "./gcal-util"
import type { CalendarEvent, Person, PersonSchedule } from "./use-gcal"

const HOUR_MS = 3_600_000
/** 레인(겹친 일정) 한 줄 높이와 간격 — 트랙 높이는 레인 수에 따라 늘어난다. */
const LANE_H = 20
const LANE_GAP = 2

/** 그날에 걸치는 일정만 남긴다(종일 일정은 날짜 범위로 판단). */
function eventsOnDay(events: CalendarEvent[], dayMid: number) {
  const dayEnd = dayMid + DAY_MS
  const timed: { start: number; end: number; ev: CalendarEvent }[] = []
  const allDay: CalendarEvent[] = []
  for (const ev of events) {
    const s = new Date(ev.start).getTime()
    // 구글의 종일 일정 end 는 배타적("YYYY-MM-DD" 다음날) — 그대로 비교하면 된다.
    const e = new Date(ev.end).getTime()
    if (e <= dayMid || s >= dayEnd) continue
    if (ev.all_day) allDay.push(ev)
    else timed.push({ start: s, end: e, ev })
  }
  return { timed, allDay }
}

/** 날짜 이동 라벨 — 0=오늘, 1=내일, 2=모레, 그 외엔 날짜만. */
function dayHeading(dayMid: number, offset: number) {
  return {
    label:
      offset === 0
        ? "오늘"
        : offset === 1
          ? "내일"
          : offset === 2
            ? "모레"
            : "",
    date: new Date(dayMid).toLocaleDateString("ko-KR", {
      month: "long",
      day: "numeric",
      weekday: "short",
    }),
  }
}

/**
 * 선택한 구성원들의 하루치 일정을 한 화면에 겹쳐 본다 — "이 사람 지금 뭐 하나 / 언제 비나"
 * 를 사람 단위로 스크롤하지 않고 확인하기 위한 뷰.
 *  - 한 사람이 한 줄, 가로축은 업무시간(그날 일정에 맞춰 넓어진다).
 *  - 종일 일정(휴가 등)은 시간축에 그릴 수 없으니 트랙 위 칩으로 따로 뺀다.
 *  - 겹친 회의는 병합하지 않고 레인으로 쌓는다 — 제목이 각각 보여야 하기 때문.
 */
export function PeopleTimeline({
  people,
  byPerson,
}: {
  people: Person[]
  byPerson: Record<string, PersonSchedule>
}) {
  // 30초마다 현재 시각선을 다시 그린다.
  const now = useNow(30_000)
  const [dayOffset, setDayOffset] = useState(0)

  const todayMid = localMidnight(now)
  // 조회 범위는 이번주+다음주 — 마지막으로 볼 수 있는 날은 다음주 일요일.
  const lastDataMid = nextMondayStart() + 6 * DAY_MS
  const maxOffset = Math.max(0, Math.round((lastDataMid - todayMid) / DAY_MS))
  const offset = Math.min(Math.max(dayOffset, 0), maxOffset)
  const dayMid = todayMid + offset * DAY_MS
  const isToday = offset === 0

  const rows = people.map((person) => {
    const schedule = byPerson[person.email]
    const { timed, allDay } = eventsOnDay(schedule?.events ?? [], dayMid)
    return { person, schedule, timed, allDay }
  })

  // 창(시간축 범위)은 그날 모든 사람의 일정을 합쳐 계산한다.
  const win = dayWindow(
    rows.flatMap((r) => r.timed.map((t) => t.ev)),
    dayMid
  )
  const span = win.end - win.start
  const pct = (t: number) => ((t - win.start) / span) * 100

  const nowInWindow = isToday && now >= win.start && now < win.end

  // 정각 눈금.
  const startH = new Date(win.start).getHours()
  const endH = startH + Math.round(span / HOUR_MS)
  const hours: number[] = []
  for (let h = startH; h <= endH; h++) hours.push(h)

  const { label, date } = dayHeading(dayMid, offset)
  // 범례는 그날 실제로 나온 성격만 — 안 쓰는 색을 설명해 봐야 읽는 부담만 는다.
  const kinds = new Set<EventKind>()
  for (const r of rows) {
    for (const t of r.timed) kinds.add(eventKind(t.ev))
    for (const ev of r.allDay) kinds.add(eventKind(ev))
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 날짜 이동 */}
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          className="size-7 rounded-full p-0"
          onClick={() => setDayOffset((v) => Math.max(0, v - 1))}
          disabled={offset <= 0}
          aria-label="이전 날"
        >
          <ChevronLeftIcon className="size-4" />
        </Button>
        <div className="flex items-baseline gap-1.5">
          {label && <span className="text-[15px] font-bold">{label}</span>}
          <span
            className={cn(
              "text-[13px]",
              label ? "text-muted-foreground" : "text-[15px] font-bold"
            )}
          >
            {date}
          </span>
        </div>
        <Button
          variant="ghost"
          className="size-7 rounded-full p-0"
          onClick={() => setDayOffset((v) => Math.min(maxOffset, v + 1))}
          disabled={offset >= maxOffset}
          aria-label="다음 날"
        >
          <ChevronRightIcon className="size-4" />
        </Button>
        {offset !== 0 && (
          <Button
            variant="ghost"
            className="ml-1 h-7 rounded-full px-2.5 text-[13px] font-semibold"
            onClick={() => setDayOffset(0)}
          >
            오늘로
          </Button>
        )}
      </div>

      {/* 시간축 눈금 */}
      <div className="grid grid-cols-[11rem_1fr] items-end gap-x-3">
        <div />
        <div className="relative h-4">
          {hours.map((h) => (
            <span
              key={h}
              className="absolute -translate-x-1/2 text-[11px] text-muted-foreground tabular-nums"
              style={{ left: `${pct(dayMid + h * HOUR_MS)}%` }}
            >
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>

      {/* 사람 행 */}
      <div className="flex flex-col gap-2">
        {rows.map(({ person, schedule, timed, allDay }) => {
          const { lanes, placed } = layoutLanes(timed)
          const trackH = lanes * LANE_H + (lanes - 1) * LANE_GAP
          const denied = schedule?.access === "denied"
          return (
            <div
              key={person.email}
              className="grid grid-cols-[11rem_1fr] items-start gap-x-3"
            >
              <div className="flex min-w-0 items-center gap-1.5 pt-0.5">
                <span
                  className="min-w-0 truncate text-[13px] font-bold"
                  title={`${person.name} · ${person.email}`}
                >
                  {person.name}
                </span>
                {schedule?.access === "busy" && (
                  <span
                    className="shrink-0 text-muted-foreground"
                    title="공개 범위가 ‘한가함/바쁨’ 이라 제목은 볼 수 없습니다"
                  >
                    <EyeOffIcon className="size-3.5" />
                  </span>
                )}
              </div>

              <div className="flex min-w-0 flex-col gap-1">
                {allDay.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {allDay.map((ev, i) => {
                      const style = KIND_STYLE[eventKind(ev)]
                      return (
                        <span
                          key={`${ev.start}-${i}`}
                          title={`종일 · ${ev.summary}`}
                          className={cn(
                            "max-w-full truncate rounded-full px-2 py-px text-[11px] font-bold ring-1 ring-inset",
                            style.block,
                            style.text
                          )}
                        >
                          {ev.summary}
                        </span>
                      )
                    })}
                  </div>
                )}

                <div
                  className={cn(
                    "relative overflow-hidden rounded-md",
                    denied ? "bg-foreground/5" : "bg-ui-success/10"
                  )}
                  style={{ height: `${Math.max(trackH, LANE_H)}px` }}
                >
                  {/* 정각 눈금선 */}
                  {hours.slice(1, -1).map((h) => (
                    <span
                      key={h}
                      className="absolute inset-y-0 w-px bg-border/60"
                      style={{ left: `${pct(dayMid + h * HOUR_MS)}%` }}
                    />
                  ))}

                  {/* 지난 시간대는 살짝 어둡게 — 시선을 남은 시간에 모은다. */}
                  {nowInWindow && (
                    <span
                      className="absolute inset-y-0 left-0 bg-foreground/8"
                      style={{ width: `${pct(now)}%` }}
                    />
                  )}

                  {denied && (
                    <span className="absolute inset-0 flex items-center px-2 text-[11px] text-muted-foreground">
                      일정을 볼 수 없습니다
                    </span>
                  )}

                  {placed.map(({ item, lane }, i) => {
                    const style = KIND_STYLE[eventKind(item.ev)]
                    const left = Math.max(pct(item.start), 0)
                    const right = Math.min(pct(item.end), 100)
                    return (
                      <span
                        key={`${item.start}-${i}`}
                        title={`${hhmm(item.start)}–${hhmm(item.end)} · ${
                          item.ev.summary
                        }`}
                        className={cn(
                          "absolute flex items-center overflow-hidden rounded-sm px-1.5 ring-1 ring-inset",
                          style.block
                        )}
                        style={{
                          top: `${lane * (LANE_H + LANE_GAP)}px`,
                          height: `${LANE_H}px`,
                          left: `${left}%`,
                          width: `${Math.max(right - left, 0)}%`,
                        }}
                      >
                        <span
                          className={cn(
                            "truncate text-[10px] font-semibold",
                            style.text
                          )}
                        >
                          {item.ev.summary}
                        </span>
                      </span>
                    )
                  })}

                  {/* 현재 시각선 */}
                  {nowInWindow && (
                    <span
                      className="absolute inset-y-0 z-30 w-0.5 bg-ui-selection"
                      style={{ left: `${pct(now)}%` }}
                    >
                      <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-ui-selection" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {([...kinds] as EventKind[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-2.5 rounded-sm ring-1 ring-inset",
                KIND_STYLE[k].block
              )}
            />
            {KIND_LABEL[k]}
          </span>
        ))}
        {isToday && (
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-0.5 bg-ui-selection" />
            현재 시각
          </span>
        )}
      </div>
    </div>
  )
}
