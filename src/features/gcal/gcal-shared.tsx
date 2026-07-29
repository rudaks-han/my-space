import { MapPinIcon, UsersIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import { dayKey, dayLabel, hhmm, isNow, isToday } from "./gcal-util"
import type { Attendee, CalendarEvent } from "./use-gcal"

/** 참석 응답 상태 한글 라벨(툴팁용). */
const RESPONSE_LABEL: Record<string, string> = {
  accepted: "수락",
  declined: "거절",
  tentative: "미정",
  needsAction: "응답 없음",
}

/** 제목 아래 한 줄로 붙는 참석자 — 이름만 나열하고, 넘치면 잘린다(전체는 툴팁). */
function AttendeeLine({ attendees }: { attendees: Attendee[] }) {
  const tooltip = attendees
    .map(
      (a) =>
        `${a.name}${a.organizer ? " (주최자)" : ""} · ${
          RESPONSE_LABEL[a.response_status] ?? "응답 없음"
        }`
    )
    .join("\n")

  return (
    <div
      className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
      title={tooltip}
    >
      <UsersIcon className="size-3.5 shrink-0" />
      <span className="shrink-0 font-semibold">{attendees.length}명</span>
      <span className="truncate">
        {attendees.map((a, i) => (
          <span
            key={`${a.email}-${i}`}
            // 거절한 사람은 취소선으로 한 단계 더 물러난다.
            className={cn(a.response_status === "declined" && "line-through")}
          >
            {a.name}
            {i < attendees.length - 1 && ", "}
          </span>
        ))}
      </span>
    </div>
  )
}

/** 일정 한 줄 — Slack 리스트 행처럼 36px·8px 라운드·호버 하이라이트. */
export function EventRow({ ev }: { ev: CalendarEvent }) {
  const now = isNow(ev)
  const attendees = ev.attendees ?? []
  return (
    <div
      className={cn(
        "ui-selectable flex min-h-9 items-start gap-3 rounded-lg px-3 py-1.5 text-[15px] transition-colors",
        now ? "bg-ui-info/15" : "hover:bg-ui-list-hover"
      )}
    >
      <span className="w-[148px] shrink-0 pt-px text-right text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">
        {ev.all_day ? "종일" : `${hhmm(ev.start)}–${hhmm(ev.end)}`}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-3">
          {/* 제목은 Slack 처럼 굵게 — 시각·장소·참석자는 보조 정보로 한 단계 물러난다. */}
          <span className="min-w-0 flex-1 truncate font-bold">
            {ev.summary}
          </span>
          {now && (
            <span className="shrink-0 rounded-full bg-ui-info/15 px-2 text-[11px] font-bold text-ui-info">
              진행 중
            </span>
          )}
          {ev.location && (
            <span className="flex min-w-0 shrink items-center gap-1 text-[13px] text-muted-foreground">
              <MapPinIcon className="size-3.5 shrink-0" />
              <span className="truncate">{ev.location}</span>
            </span>
          )}
        </div>
        {attendees.length > 0 && <AttendeeLine attendees={attendees} />}
      </div>
    </div>
  )
}

/** 한 주치 일정을 날짜별로 묶어 구분선과 함께 그린다. */
export function WeekSection({
  title,
  events,
}: {
  title: string
  events: CalendarEvent[]
}) {
  const days: {
    key: string
    iso: string
    today: boolean
    items: CalendarEvent[]
  }[] = []
  for (const ev of events) {
    const key = dayKey(ev.start)
    const last = days[days.length - 1]
    if (last && last.key === key) last.items.push(ev)
    else
      days.push({ key, iso: ev.start, today: isToday(ev.start), items: [ev] })
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
          예정된 일정이 없습니다.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5 rounded-[10px] border border-border bg-card p-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {days.map((day) => (
            <div
              key={day.key}
              className={cn(
                "flex flex-col gap-0.5",
                // 오늘 날짜 묶음은 브랜드 색을 옅게 깐 블록으로 띄운다.
                day.today &&
                  // 행 호버 색(불투명 회색)이 블록 배경을 지우지 않도록 같은 계열로 덮는다.
                  "rounded-[10px] bg-ui-selection/8 py-1 ring-1 ring-ui-selection/20 [&_.ui-selectable:hover]:bg-ui-selection/15"
              )}
            >
              <div className="flex items-center gap-2 px-3 pt-1.5 pb-0.5">
                <span
                  className={cn(
                    "text-[13px]",
                    day.today
                      ? "font-bold text-ui-selection"
                      : "font-semibold text-muted-foreground"
                  )}
                >
                  {dayLabel(day.iso)}
                </span>
                {day.today && (
                  <span className="rounded-full bg-ui-selection px-2 text-[11px] font-bold text-ui-selection-fg">
                    오늘
                  </span>
                )}
                <span
                  className={cn(
                    "h-px flex-1",
                    day.today ? "bg-ui-selection/25" : "bg-border"
                  )}
                />
              </div>
              {day.items.map((ev, i) => (
                <EventRow key={`${ev.start}-${i}`} ev={ev} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
