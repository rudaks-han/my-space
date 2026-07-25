import {
  CalendarIcon,
  ClockIcon,
  MapPinIcon,
  RefreshCwIcon,
  VideoIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

import { friendlyError } from "./gcal-error"
import { useGcal, type CalendarEvent } from "./use-gcal"

/** 지금 진행 중인 일정인지(현재 시각이 start~end 사이). */
function isNow(ev: CalendarEvent): boolean {
  if (ev.all_day) return false
  const now = Date.now()
  return new Date(ev.start).getTime() <= now && now < new Date(ev.end).getTime()
}

function EventRow({ ev }: { ev: CalendarEvent }) {
  const now = isNow(ev)
  return (
    <div
      className={`ui-selectable flex gap-3 rounded-lg border p-3 ${
        now ? "border-primary/50 bg-primary/5" : ""
      }`}
    >
      <div className="flex w-24 shrink-0 flex-col">
        <span className="text-sm font-medium tabular-nums">
          {ev.all_day
            ? "종일"
            : new Date(ev.start).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
        </span>
        {!ev.all_day && (
          <span className="text-xs text-muted-foreground tabular-nums">
            ~{" "}
            {new Date(ev.end).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{ev.summary}</span>
          {now && <Badge className="shrink-0">진행 중</Badge>}
        </div>
        {ev.location && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPinIcon className="size-3 shrink-0" />
            <span className="truncate">{ev.location}</span>
          </span>
        )}
        {ev.meet_link && (
          <a
            href={ev.meet_link}
            className="flex w-fit items-center gap-1 text-xs text-primary hover:underline"
          >
            <VideoIcon className="size-3" />
            화상 회의 참여
          </a>
        )}
      </div>
    </div>
  )
}

/** 아직 계정이 연결되지 않았을 때 — 연결은 설정 화면에서 한다. */
function NotConnectedView() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <CalendarIcon className="size-8 text-muted-foreground" />
      <p className="text-sm font-medium">
        Google 캘린더가 연결되지 않았습니다.
      </p>
      <p className="text-xs text-muted-foreground">
        사이드바 아래 톱니 아이콘 → 설정 → Google Calendar 에서 계정을 연결해
        주세요.
      </p>
    </div>
  )
}

export function GcalView() {
  const { status, events, loading, error, updatedAt, refresh } = useGcal()

  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  if (!status.connected) {
    return <NotConnectedView />
  }

  const todayLabel = new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  })

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-5" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">{todayLabel}</span>
            <span className="text-xs text-muted-foreground">
              {status.email ?? "Google 캘린더"}
              {updatedAt &&
                ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })} 업데이트`}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
            새로고침
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {friendlyError(error)}
        </p>
      )}

      {loading && events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          일정을 불러오는 중…
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <ClockIcon className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            오늘 예정된 일정이 없습니다.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((ev, i) => (
            <EventRow key={`${ev.start}-${i}`} ev={ev} />
          ))}
        </div>
      )}
    </div>
  )
}
