import {
  CalendarIcon,
  CheckIcon,
  DoorOpenIcon,
  RefreshCwIcon,
} from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { trackedInvoke } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { suppressWebviews } from "@/lib/webview-overlay"

import { friendlyError } from "./gcal-error"
import { looksLikeKnownRoom, readSavedRooms } from "./gcal-rooms"
import {
  ceilToHour,
  DAY_MS,
  hhmm,
  localMidnight,
  parseLocalDateTime,
  PILL,
  slotStatus,
  toHm,
  toYmd,
  upcomingRange,
  type Interval,
  type SlotStatus,
} from "./gcal-util"
import {
  bookRoom,
  fetchRoomEvents,
  useGcalConnection,
  type CalendarEvent,
  type CalendarInfo,
  type RoomRef,
} from "./use-gcal"

/** 예약 기본 길이(1시간). */
const HOUR_MS = 3_600_000

/** 회의 길이 프리셋 — 시작 시각만 정하면 종료가 따라온다. */
const DURATIONS = [
  { label: "30분", ms: 1_800_000 },
  { label: "1시간", ms: HOUR_MS },
  { label: "2시간", ms: 2 * HOUR_MS },
]

/**
 * `startTs` 에서 `ms` 만큼 갔을 때 같은 날 안에 머무는지.
 *
 * 자정을 넘거나 정확히 자정에 끝나는 길이는 "HH:MM" 두 개로 표현할 수 없다(종료가
 * 00:00 이 되어 시작보다 앞서 버린다). 그런 프리셋은 눌러 봐야 오류만 나므로 잠근다.
 */
function fitsInDay(startTs: number, ms: number): boolean {
  return startTs + ms < localMidnight(startTs) + DAY_MS
}

/** 네이티브 date/time input 을 Slack 톤으로 — Input 컴포넌트와 높이·라운드를 맞춘다. */
const FIELD =
  "h-8 w-full rounded-lg border border-border bg-card px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

/** 회의실 하나 + 그 시간대의 상태. */
interface RoomSlot {
  room: RoomRef
  status: SlotStatus
}

/** 상태 한 줄 요약 — 비었으면 초록, 사용 중이면 언제까지 누가 쓰는지. */
function StatusLine({ status }: { status: SlotStatus }) {
  if (status.free)
    return (
      <span className="text-[13px] font-semibold text-ui-success">
        예약 가능
      </span>
    )
  return (
    <span className="truncate text-[13px] text-muted-foreground">
      <span className="font-semibold text-ui-error">
        {status.busyUntil ? `${hhmm(status.busyUntil)}까지 사용 중` : "사용 중"}
      </span>
      {status.conflict?.summary ? ` · ${status.conflict.summary}` : ""}
    </span>
  )
}

/**
 * 상단바 오른쪽의 **회의실 예약**.
 *
 * 필드를 누르면 아래로 열리고, 지금(다음 정각부터 1시간) 기준으로 회의실이 비었는지
 * 아닌지를 한 줄씩 보여준다 — 예약 가능한 방이 위로 온다. 날짜·시간을 바꾸면 판정만
 * 다시 하고 조회는 하지 않는다(회의실 일정은 이번주+다음주치를 한 번에 받아 둔다).
 *
 * 회의실 목록은 캘린더 → 회의실 탭이 저장해 둔 것을 **읽기만** 한다(`gcal-rooms.ts` 의
 * `readSavedRooms`). 저장된 게 없으면 내 캘린더 목록에서 알려진 회의실을 자동으로
 * 추천하되 저장하지는 않는다 — 두 화면이 같은 키를 서로 덮어쓰지 않게 하기 위해서다.
 *
 * 폴링은 붙이지 않는다. 상단바는 늘 떠 있어 `useTabActive()` 로 게이트할 수단이
 * 없으므로, 주기 조회를 달면 앱을 켜 둔 내내 회의실 수만큼 호출이 나간다.
 */
export function RoomBookingPalette() {
  const [open, setOpen] = useState(false)
  const [rooms, setRooms] = useState<RoomRef[]>([])
  const [byRoom, setByRoom] = useState<Record<string, CalendarEvent[]>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 방금 받아 온 일정이 덮는 범위. 조회 시점에 기록한다 — 렌더 중 `Date.now()` 를 부르면
   * `react-hooks/purity` 규칙에 걸리고, 무엇보다 "이 데이터가 아는 구간" 은 조회 시점의
   * 값이라야 맞다.
   */
  const [range, setRange] = useState<Interval | null>(null)

  const [date, setDate] = useState(() => toYmd(new Date()))
  const [start, setStart] = useState("09:00")
  const [end, setEnd] = useState("10:00")
  const [title, setTitle] = useState("")

  /** 예약 진행 중인 회의실 id(그 행의 버튼만 잠근다). */
  const [booking, setBooking] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  /** 이번에 열려 있는 동안 이미 불러왔는지(닫으면 풀린다). */
  const loadedRef = useRef(false)
  /** label ↔ input 연결용 접두사(팝아웃 창과 id 가 겹치지 않게). */
  const uid = useId()
  const { status } = useGcalConnection()
  const connected = status?.connected === true
  const canWrite = status?.can_write ?? false

  // 바깥을 누르면 닫는다(구성원 검색 팔레트와 같은 방식).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("pointerdown", onDown)
    return () => window.removeEventListener("pointerdown", onDown)
  }, [open])

  // 드롭다운은 네이티브 웹뷰(브라우저 등) 위로 내려오는데, 웹뷰는 창 위에 겹쳐 그려져
  // CSS 로 가려지지 않는다. 열려 있는 동안만 웹뷰 숨김을 요청한다(탭 넘침 목록과 같은 방식).
  useEffect(() => {
    if (!open) return
    return suppressWebviews()
  }, [open])

  /**
   * 회의실 목록과 일정을 받아 온다. 저장된 목록이 비어 있으면 내 캘린더에서 알려진
   * 회의실을 추천해 그것으로 진행한다(저장하지 않는다).
   */
  const load = useCallback(async (saved: RoomRef[]) => {
    setLoading(true)
    setError(null)
    try {
      let target = saved
      if (target.length === 0) {
        const cals = await trackedInvoke<CalendarInfo[]>("gcal_calendars")
        target = cals
          .filter((c) => !c.primary && looksLikeKnownRoom(c.summary))
          .map((c) => ({ id: c.id, name: c.summary }))
        setRooms(target)
      }
      setByRoom(target.length > 0 ? await fetchRoomEvents(target) : {})
      setRange(upcomingRange())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  /**
   * 열 때마다 시간 기본값을 지금 기준으로 다시 잡는다 — 트레이 상주 앱이라 어제 열어
   * 둔 값이 남아 있으면 "지금 비어 있는 방" 이라는 물음에 엉뚱하게 답한다.
   * (effect 가 아니라 클릭 핸들러에서 하므로 `set-state-in-effect` 규칙에 걸리지 않는다.)
   */
  function openPalette() {
    const s = ceilToHour(Date.now())
    setDate(toYmd(new Date(s)))
    setStart(toHm(s))
    setEnd(toHm(s + HOUR_MS))
    setMsg(null)
    // 목록 뼈대는 즉시 보여 주고, 실제 조회는 아래 effect 가 연결 확인 후에 건다.
    setRooms(readSavedRooms())
    setOpen(true)
  }

  function toggle() {
    if (open) setOpen(false)
    else openPalette()
  }

  /**
   * 열려 있고 연결이 확인되면 한 번 불러온다.
   *
   * 여는 순간에 바로 부르지 않는 이유는 `gcal_status` 가 아직 도착하지 않았을 수 있어서다
   * (앱을 켜자마자 누른 경우). 그때 조회를 건너뛰면 연결돼 있는데도 빈 화면이 남는다.
   */
  useEffect(() => {
    if (!open) {
      loadedRef.current = false
      return
    }
    if (!connected || loadedRef.current) return
    loadedRef.current = true
    void load(readSavedRooms())
  }, [open, connected, load])

  /** 고른 시간대(epoch ms). 형식이 깨졌거나 끝이 시작보다 앞이면 null. */
  const slotStart = parseLocalDateTime(date, start)
  const slotEnd = parseLocalDateTime(date, end)
  const slot: Interval | null =
    slotStart !== null && slotEnd !== null && slotEnd > slotStart
      ? { start: slotStart, end: slotEnd }
      : null

  /**
   * 받아 둔 일정이 이 시간대를 덮지 못하면(조회 범위 밖 날짜) 가용 여부를 말할 수 없다.
   * 이때 "비어 있음" 으로 보여 주면 없는 정보를 지어내는 셈이라, 판정을 아예 접는다.
   */
  const outOfRange =
    slot !== null &&
    range !== null &&
    (slot.start < range.start || slot.end > range.end)

  // 목록은 그때그때 계산한다 — 회의실 수가 한 자릿수라 메모할 값이 아니다.
  const slots: RoomSlot[] =
    slot && !outOfRange
      ? rooms
          .map((room) => ({
            room,
            status: slotStatus(byRoom[room.id] ?? [], slot),
          }))
          // 예약 가능한 방이 위로. 같은 상태끼리는 이름순.
          .sort(
            (a, b) =>
              Number(b.status.free) - Number(a.status.free) ||
              a.room.name.localeCompare(b.room.name, "ko")
          )
      : rooms.map((room) => ({
          room,
          // 모르는 구간 — 아래에서 상태 줄 대신 안내를 띄운다.
          status: {
            free: false,
            busyUntil: null,
            conflict: null,
            suggestion: null,
          },
        }))
  const freeCount = slots.filter((s) => s.status.free).length

  /** 길이 프리셋 — 시작은 그대로 두고 종료만 옮긴다. */
  function setDuration(ms: number) {
    if (slotStart === null) return
    setEnd(toHm(slotStart + ms))
    setMsg(null)
  }

  /** 대안 구간을 그대로 폼에 반영한다 — 그러면 그 방이 '예약 가능' 으로 바뀐다. */
  function applySuggestion(iv: Interval) {
    setDate(toYmd(new Date(iv.start)))
    setStart(toHm(iv.start))
    setEnd(toHm(iv.end))
    setMsg(null)
  }

  async function submit(room: RoomRef) {
    if (!slot || booking) return
    setBooking(room.id)
    setMsg(null)
    try {
      await bookRoom({
        roomId: room.id,
        roomName: room.name,
        title,
        date,
        startHm: start,
        endHm: end,
      })
      setMsg({
        ok: true,
        text: `${room.name} · ${start}–${end} 예약 완료`,
      })
      setTitle("")
      // 방금 만든 일정이 목록에 반영되도록 다시 읽는다.
      await load(rooms)
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(String(e)) })
    } finally {
      setBooking(null)
    }
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* 상단바 알약 — 구성원 검색과 같은 톤. 드래그 영역으로 만들지 않는다. */}
      <button
        type="button"
        aria-label="회의실 예약"
        onClick={toggle}
        className="flex h-7 w-[150px] cursor-pointer items-center gap-2 rounded-full border border-ui-chrome-fg/20 bg-ui-chrome-hover px-3 text-[13px] text-ui-chrome-muted-fg transition-colors hover:bg-ui-chrome-active"
      >
        <DoorOpenIcon className="size-3.5 shrink-0" />
        <span className="truncate">회의실 예약</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 z-[100] mt-1 flex max-h-[72vh] w-[min(520px,92vw)] flex-col overflow-hidden rounded-[10px] border border-border bg-card text-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
          {status === null ? (
            // 연결 상태를 아직 모른다 — 미연결로 단정하면 잠깐 틀린 안내가 뜬다.
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              연결 상태를 확인하는 중…
            </p>
          ) : !connected ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <CalendarIcon className="size-8 text-muted-foreground" />
              <p className="text-[15px] font-bold">
                Google 캘린더가 연결되지 않았습니다.
              </p>
              <p className="text-[13px] text-muted-foreground">
                설정 → Google Calendar 에서 계정을 연결하면 회의실을 예약할 수
                있습니다.
              </p>
            </div>
          ) : (
            <>
              {/* 시간대 — 아래 목록의 가용 여부가 전부 이 값 기준이다. */}
              <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`${uid}-date`}
                    className="w-8 shrink-0 text-[13px] text-muted-foreground"
                  >
                    날짜
                  </label>
                  <input
                    id={`${uid}-date`}
                    type="date"
                    className={cn(FIELD, "w-[150px] shrink-0")}
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                  <Button
                    variant="ghost"
                    className={cn(PILL, "ml-auto shrink-0")}
                    onClick={() => void load(rooms)}
                    disabled={loading}
                    aria-label="회의실 일정 새로고침"
                  >
                    <RefreshCwIcon
                      className={cn("size-3.5", loading && "animate-spin")}
                    />
                  </Button>
                </div>

                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`${uid}-start`}
                    className="w-8 shrink-0 text-[13px] text-muted-foreground"
                  >
                    시간
                  </label>
                  <input
                    id={`${uid}-start`}
                    type="time"
                    aria-label="시작 시각"
                    className={cn(FIELD, "w-[96px] shrink-0")}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                  <span className="shrink-0 text-muted-foreground">–</span>
                  <input
                    type="time"
                    aria-label="종료 시각"
                    className={cn(FIELD, "w-[96px] shrink-0")}
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                  />
                  {/* 길이 프리셋 — 시작만 정하면 종료가 따라온다(회의는 길이로 잡는 게 보통이다). */}
                  <div className="ml-1 flex items-center gap-1">
                    {DURATIONS.map((d) => (
                      <button
                        key={d.ms}
                        type="button"
                        onClick={() => setDuration(d.ms)}
                        // 그날 안에 못 들어가는 길이는 누르면 오류가 될 뿐이라 잠근다.
                        disabled={
                          slotStart === null || !fitsInDay(slotStart, d.ms)
                        }
                        className={cn(
                          "h-7 shrink-0 rounded-full px-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40",
                          slot && slot.end - slot.start === d.ms
                            ? "bg-ui-selection text-ui-selection-fg"
                            : "border border-border hover:bg-ui-list-hover"
                        )}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`${uid}-title`}
                    className="w-8 shrink-0 text-[13px] text-muted-foreground"
                  >
                    제목
                  </label>
                  <Input
                    id={`${uid}-title`}
                    className="h-8 text-[13px]"
                    placeholder="비우면 ‘회의’"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </div>
              </div>

              {/* 예약 가능한 회의실 목록. */}
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
                {!slot ? (
                  <p className="px-3 py-2 text-[13px] text-ui-warning">
                    종료 시각이 시작 시각보다 뒤여야 합니다.
                  </p>
                ) : error ? (
                  <p className="px-3 py-2 text-[13px] text-ui-error">
                    {friendlyError(error)}
                  </p>
                ) : loading && rooms.length === 0 ? (
                  <p className="px-3 py-2 text-[13px] text-muted-foreground">
                    회의실을 불러오는 중…
                  </p>
                ) : rooms.length === 0 ? (
                  <p className="px-3 py-2 text-[13px] text-muted-foreground">
                    선택된 회의실이 없습니다 — 캘린더 → 회의실 탭의 ‘회의실
                    선택’ 에서 먼저 골라 주세요.
                  </p>
                ) : (
                  slots.map(({ room, status: st }) => {
                    // 지역 변수로 받아 두면 아래 클로저 안에서도 좁혀진 타입이 유지된다.
                    const suggestion = st.suggestion
                    return (
                      <div
                        key={room.id}
                        className={cn(
                          "flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 transition-colors",
                          st.free ? "hover:bg-ui-list-hover" : "opacity-80"
                        )}
                      >
                        <DoorOpenIcon
                          className={cn(
                            "size-4 shrink-0",
                            st.free
                              ? "text-ui-success"
                              : "text-muted-foreground"
                          )}
                        />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-[15px] font-semibold">
                            {room.name}
                          </span>
                          {outOfRange ? (
                            <span className="truncate text-[13px] text-muted-foreground">
                              가용 여부 확인 불가
                            </span>
                          ) : (
                            <StatusLine status={st} />
                          )}
                        </div>

                        {!st.free && suggestion && (
                          <button
                            type="button"
                            onClick={() => applySuggestion(suggestion)}
                            className="shrink-0 rounded-full px-2 py-1 text-[13px] font-semibold text-ui-link transition-colors hover:bg-ui-list-hover"
                          >
                            {hhmm(suggestion.start)}부터
                          </button>
                        )}

                        <Button
                          className={cn(PILL, "shrink-0")}
                          variant={st.free ? "default" : "outline"}
                          onClick={() => void submit(room)}
                          disabled={!canWrite || booking !== null}
                        >
                          {booking === room.id ? "예약 중…" : "예약"}
                        </Button>
                      </div>
                    )
                  })
                )}
              </div>

              {/* 결과·경고는 목록 아래에 고정해 스크롤과 무관하게 보이게 한다. */}
              {(msg || rooms.length > 0) && (
                <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
                  {slot && rooms.length > 0 && (
                    <p
                      className={cn(
                        "text-[13px]",
                        outOfRange ? "text-ui-warning" : "text-muted-foreground"
                      )}
                    >
                      {loading
                        ? "일정을 확인하는 중…"
                        : outOfRange
                          ? "이번주·다음주 밖 날짜는 일정을 조회하지 않아 빈 방인지 알 수 없습니다 — 예약은 그대로 됩니다."
                          : `${rooms.length}개 중 ${freeCount}개 예약 가능`}
                    </p>
                  )}
                  {rooms.length > 0 && !canWrite && (
                    <p className="rounded-lg bg-ui-warning/15 px-3 py-2 text-[13px] text-ui-warning">
                      예약하려면 설정 → Google Calendar 에서 연결을 해제하고
                      다시 로그인해야 합니다(쓰기 권한 필요).
                    </p>
                  )}
                  {msg && (
                    <p
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px]",
                        msg.ok
                          ? "bg-ui-success/15 text-ui-success"
                          : "bg-ui-error/15 text-ui-error"
                      )}
                    >
                      {msg.ok && <CheckIcon className="size-3.5 shrink-0" />}
                      {msg.text}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
