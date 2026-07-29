import {
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
} from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useNow } from "@/lib/use-now"
import { cn } from "@/lib/utils"

import {
  type BookingPrefill,
  busyIntervals,
  ceilToHour,
  DAY_MS,
  dayWindow,
  hhmm,
  localMidnight,
  nextFreeSlot,
  nextMondayStart,
  PILL,
  toHm,
  toYmd,
} from "./gcal-util"
import type { CalendarEvent, RoomRef } from "./use-gcal"

const HOUR_MS = 3_600_000

/** 한 회의실의 하루치 계산 결과. */
interface Row {
  room: RoomRef
  /** 사용 중(병합된) 구간. */
  busy: { start: number; end: number }[]
  /** 기준 시각 이후 처음 비는 구간 — 없으면 null. */
  free: { start: number; end: number } | null
  /** 지금 이 순간(오늘일 때만) 비어 있는지. */
  freeNow: boolean
}

/** 날짜 이동 라벨 — 0=오늘, 1=내일, 2=모레, 그 외엔 "7월 31일 (금)". */
function dayHeading(
  dayMid: number,
  offset: number
): { label: string; date: string } {
  const label =
    offset === 0 ? "오늘" : offset === 1 ? "내일" : offset === 2 ? "모레" : ""
  const date = new Date(dayMid).toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  })
  return { label, date }
}

/**
 * 회의실 예약 현황을 하루 단위 시간축 타임라인으로 보여준다.
 * "언제/어느 방이 비는가"를 한눈에 찾기 위한 뷰:
 *  - 가로축 = 업무시간, 각 회의실이 한 줄, 예약된 구간은 블록으로 채운다.
 *  - 세로선 = 현재 시각(오늘일 때만). 그 오른쪽의 빈 칸이 곧 예약 가능한 시간이다.
 *  - 행은 "가장 빨리 비는 순"으로 정렬 → 맨 위가 그날 잡기 가장 좋은 방.
 *  - ◀ ▶ 로 오늘·내일·다음날(다음주 말까지, 데이터 범위 내)을 넘겨본다.
 */
export function RoomTimeline({
  rooms,
  byRoom,
  onPick,
  selected,
}: {
  rooms: RoomRef[]
  byRoom: Record<string, CalendarEvent[]>
  /** 빈 슬롯을 고르면 예약 폼에 채울 값을 올려보낸다. */
  onPick: (p: BookingPrefill) => void
  /** 현재 예약 폼에 채워진(=선택된) 슬롯 — 타임라인에 강조 표시한다. */
  selected: BookingPrefill | null
}) {
  // 30초마다 현재 시각선을 다시 그린다(회의가 끝나면 자동으로 빈 칸이 열린다).
  const now = useNow(30_000)
  const [dayOffset, setDayOffset] = useState(0)

  const todayMid = localMidnight(now)
  // 조회 가능한 마지막 날 = 다음주 일요일(useRoomSchedule 이 이번주+다음주만 받아온다).
  const lastDataMid = nextMondayStart() + 6 * DAY_MS
  const maxOffset = Math.max(0, Math.round((lastDataMid - todayMid) / DAY_MS))
  const offset = Math.min(Math.max(dayOffset, 0), maxOffset)
  const dayMid = todayMid + offset * DAY_MS
  const isToday = offset === 0

  // 선택된 슬롯은 "지금 보고 있는 날"의 것일 때만 강조한다.
  const dayYmd = toYmd(new Date(dayMid))
  const sel = selected && selected.date === dayYmd ? selected : null
  const hmToMs = (hm: string) => {
    const [h, m] = hm.split(":").map(Number)
    return dayMid + h * HOUR_MS + m * 60_000
  }

  // 창(시간축 범위)은 그날 모든 회의실 일정을 합쳐 계산한다.
  const allEvents = rooms.flatMap((r) => byRoom[r.id] ?? [])
  const win = dayWindow(allEvents, dayMid)
  const span = win.end - win.start
  const pct = (t: number) => ((t - win.start) / span) * 100

  // 오늘이면 "지금"부터, 미래 날이면 업무 시작부터 빈 자리를 찾는다.
  const from = isToday ? Math.max(now, win.start) : win.start
  const nowInWindow = isToday && now >= win.start && now < win.end

  const rows: Row[] = rooms.map((room) => {
    const busy = busyIntervals(byRoom[room.id] ?? [], win)
    const free = nextFreeSlot(busy, from, win.end)
    const freeNow = nowInWindow && free !== null && free.start <= now
    return { room, busy, free, freeNow }
  })

  // 가장 빨리 비는 순 정렬 — 이른 시각 → 그날 자리 없음(맨 뒤).
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ta = a.r.free ? a.r.free.start : Infinity
      const tb = b.r.free ? b.r.free.start : Infinity
      return ta - tb || a.i - b.i
    })
    .map(({ r }) => r)

  const best = sorted.find((r) => r.free)

  // 클릭 지점을 30분 격자로 "내림"한다 — 12:05 클릭이면 12:00, 12:40 이면 12:30.
  // (KST 는 +9h 라 epoch 30분 격자가 로컬 :00/:30 과 일치.)
  const STEP_MS = 30 * 60_000
  const snap30 = (ms: number) => Math.floor(ms / STEP_MS) * STEP_MS

  // 회의실의 "가장 빠른" 빈 슬롯을 골라 예약 폼으로 올린다(이름/요약 버튼용).
  // 지금 비어 있으면 시작은 현재 시각을 정각으로 올린 값(09:10 → 10:00),
  // 앞으로 빌 예정이면 그 빈 구간의 시작 시각을 쓴다. 종료는 +1시간.
  function pick(row: Row) {
    if (!row.free) return
    const startMs = row.freeNow ? ceilToHour(now) : row.free.start
    onPick({
      roomId: row.room.id,
      date: dayYmd,
      startHm: toHm(startMs),
      endHm: toHm(startMs + HOUR_MS),
    })
  }

  // 트랙에서 "클릭한 시각"을 30분 내림해 그대로 시작으로 쓴다. 이미 예약된 구간이든
  // 과거든 상관없이 클릭한 자리를 선택한다(현재 시각/기존 예약 기준 보정 없음).
  function pickAt(row: Row, ms: number) {
    const clicked = Math.min(Math.max(ms, win.start), win.end)
    let startMs = Math.max(snap30(clicked), win.start)
    // 창 끝에 딱 붙게 찍었을 때 0분짜리가 되지 않도록 한 칸 당긴다.
    if (startMs >= win.end - STEP_MS) startMs = win.end - STEP_MS
    const endMs = Math.min(startMs + HOUR_MS, win.end)
    onPick({
      roomId: row.room.id,
      date: dayYmd,
      startHm: toHm(startMs),
      endHm: toHm(endMs),
    })
  }

  // 정각 눈금.
  const startH = new Date(win.start).getHours()
  const endH = startH + Math.round(span / HOUR_MS)
  const hours: number[] = []
  for (let h = startH; h <= endH; h++) hours.push(h)

  const { label, date } = dayHeading(dayMid, offset)

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

      {/* 한 줄 요약 — 지금 바로 잡을 수 있는 방, 없으면 가장 빨리 비는 방. */}
      <div className="flex items-center gap-2">
        {best?.freeNow ? (
          <>
            <CheckCircle2Icon className="size-4 shrink-0 text-ui-success" />
            <span className="text-[15px] font-semibold">지금 예약 가능</span>
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              {sorted.filter((r) => r.freeNow).length}곳 ·{" "}
              <span className="font-semibold text-ui-success">
                {best.room.name}
              </span>{" "}
              바로 사용 가능
            </span>
          </>
        ) : best?.free ? (
          <>
            <ClockIcon className="size-4 shrink-0 text-ui-warning" />
            <span className="text-[15px] font-semibold">가장 빨리 비는 곳</span>
            <span className="min-w-0 truncate text-[13px] text-muted-foreground">
              <span className="font-semibold text-foreground">
                {best.room.name}
              </span>{" "}
              · {hhmm(best.free.start)}부터
            </span>
          </>
        ) : (
          <>
            <ClockIcon className="size-4 shrink-0 text-ui-error" />
            <span className="text-[15px] font-semibold">
              {isToday
                ? "오늘 남은 빈 자리가 없습니다"
                : "이 날 빈 자리가 없습니다"}
            </span>
          </>
        )}
        {best && (
          <Button
            className={cn(PILL, "ml-auto shrink-0")}
            onClick={() => pick(best)}
          >
            이 시간으로 예약
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
              style={{ left: `${pct((h - startH) * HOUR_MS + win.start)}%` }}
            >
              {String(h).padStart(2, "0")}
            </span>
          ))}
        </div>
      </div>

      {/* 회의실 행 */}
      <div className="flex flex-col gap-1.5">
        {sorted.map((row) => {
          const isSel = sel?.roomId === row.room.id
          return (
            <div
              key={row.room.id}
              className={cn(
                "grid grid-cols-[11rem_1fr] items-center gap-x-3 rounded-lg py-0.5",
                isSel && "bg-ui-selection/10 ring-1 ring-ui-selection/40"
              )}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    row.freeNow
                      ? "bg-ui-success"
                      : row.free
                        ? "bg-ui-warning"
                        : "bg-ui-error"
                  )}
                />
                <span
                  className="min-w-0 truncate text-[13px] font-bold"
                  title={row.room.name}
                >
                  {row.room.name}
                </span>
                {isSel && (
                  <span className="shrink-0 rounded-full bg-ui-selection px-1.5 text-[10px] font-bold text-ui-selection-fg">
                    선택됨
                  </span>
                )}
              </div>

              <button
                type="button"
                title="클릭한 시간대로 예약 시각 선택(예약된 곳도 선택 가능)"
                onClick={(e) => {
                  // 키보드로 활성화(detail 0)면 가장 빠른 시각, 마우스면 클릭 위치.
                  if (e.detail === 0) {
                    pick(row)
                    return
                  }
                  const rect = e.currentTarget.getBoundingClientRect()
                  const ratio =
                    rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0
                  pickAt(row, win.start + ratio * span)
                }}
                className="relative block h-7 w-full cursor-pointer overflow-hidden rounded-md bg-ui-success/10 transition-shadow hover:ring-2 hover:ring-ui-selection/30 hover:ring-inset"
              >
                {/* 정각 눈금선 */}
                {hours.slice(1, -1).map((h) => (
                  <span
                    key={h}
                    className="absolute inset-y-0 w-px bg-border/60"
                    style={{
                      left: `${pct((h - startH) * HOUR_MS + win.start)}%`,
                    }}
                  />
                ))}

                {/* 지난 시간대는 살짝 어둡게 — 시선을 앞으로 남은 빈 칸에 모은다. */}
                {nowInWindow && (
                  <span
                    className="absolute inset-y-0 left-0 bg-foreground/8"
                    style={{ width: `${pct(now)}%` }}
                  />
                )}

                {/* 예약된 구간 */}
                {row.busy.map((b, i) => (
                  <span
                    key={i}
                    title={`${hhmm(b.start)}–${hhmm(b.end)} 예약됨`}
                    className="absolute inset-y-0.5 flex items-center overflow-hidden rounded-sm bg-ui-error/30 px-1.5 ring-1 ring-ui-error/40 ring-inset"
                    style={{
                      left: `${pct(b.start)}%`,
                      width: `${Math.max(pct(b.end) - pct(b.start), 0)}%`,
                    }}
                  >
                    <span className="truncate text-[10px] font-semibold text-ui-error">
                      {hhmm(b.start)}
                    </span>
                  </span>
                ))}

                {/* 선택한 슬롯 강조 */}
                {isSel && sel && (
                  <span
                    className="absolute inset-y-0.5 z-20 flex items-center justify-center overflow-hidden rounded-sm bg-ui-selection/25 px-1 ring-2 ring-ui-selection ring-inset"
                    style={{
                      left: `${pct(hmToMs(sel.startHm))}%`,
                      width: `${Math.max(
                        pct(hmToMs(sel.endHm)) - pct(hmToMs(sel.startHm)),
                        0
                      )}%`,
                    }}
                  >
                    <span className="truncate text-[10px] font-bold text-ui-selection">
                      {sel.startHm}
                    </span>
                  </span>
                )}

                {/* 현재 시각선 */}
                {nowInWindow && (
                  <span
                    className="absolute inset-y-0 z-30 w-0.5 bg-ui-selection"
                    style={{ left: `${pct(now)}%` }}
                  >
                    <span className="absolute -top-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-ui-selection" />
                  </span>
                )}
              </button>
            </div>
          )
        })}
      </div>

      {/* 범례 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-ui-success/20 ring-1 ring-ui-success/30 ring-inset" />
          비어있음
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-ui-error/30 ring-1 ring-ui-error/40 ring-inset" />
          예약됨
        </span>
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
