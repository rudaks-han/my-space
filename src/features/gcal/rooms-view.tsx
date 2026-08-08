import {
  CheckIcon,
  DoorOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  SettingsIcon,
} from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useLocalStorage } from "@/lib/use-local-storage"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gcal-error"
import { looksLikeKnownRoom, ROOMS_KEY } from "./gcal-rooms"
import { WeekSection } from "./gcal-shared"
import {
  type BookingPrefill,
  ceilToHour,
  PILL,
  splitByWeek,
  toHm,
  toYmd,
} from "./gcal-util"
import { RoomTimeline } from "./room-timeline"
import {
  bookRoom,
  useGcalCalendars,
  useGcalConnection,
  useRoomSchedule,
  type RoomRef,
} from "./use-gcal"

/** 네이티브 input 을 Slack 톤으로 — Input 컴포넌트와 높이·라운드를 맞춘다. */
const FIELD =
  "h-9 rounded-lg border border-border bg-card px-3 text-[15px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

/** 회의실 선택 패널 — 내 캘린더 목록에서 회의실을 골라 저장한다. */
function RoomPicker({
  saved,
  onSave,
  onClose,
}: {
  saved: RoomRef[]
  onSave: (rooms: RoomRef[]) => void
  onClose: () => void
}) {
  const { calendars, loading, error, load } = useGcalCalendars()
  const [selected, setSelected] = useState<Record<string, RoomRef>>(() =>
    Object.fromEntries(saved.map((r) => [r.id, r]))
  )
  const [autofilled, setAutofilled] = useState(false)

  // 패널이 열리면 캘린더 목록을 불러온다.
  useEffect(() => {
    void load()
  }, [load])

  // 저장된 회의실이 없던 경우, 목록이 오면 알려진 회의실을 한 번 자동 선택해 준다.
  // (비동기로 도착한 목록에서 파생 선택을 채우는 의도된 동기화 — 최초 1회만.)
  useEffect(() => {
    if (autofilled || saved.length > 0 || !calendars) return
    const auto: Record<string, RoomRef> = {}
    for (const c of calendars) {
      if (!c.primary && looksLikeKnownRoom(c.summary))
        auto[c.id] = { id: c.id, name: c.summary }
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (Object.keys(auto).length > 0) setSelected(auto)
    setAutofilled(true)
  }, [calendars, saved.length, autofilled])

  function toggle(id: string, name: string) {
    setSelected((prev) => {
      const next = { ...prev }
      if (next[id]) delete next[id]
      else next[id] = { id, name }
      return next
    })
  }

  // 회의실(비-primary)을 위로, 이름순 정렬.
  const rooms = (calendars ?? [])
    .filter((c) => !c.primary)
    .sort((a, b) => a.summary.localeCompare(b.summary, "ko"))

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <div className="flex items-center gap-2">
        <span className="text-[15px] font-semibold">회의실 선택</span>
        {loading && (
          <RefreshCwIcon className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <Button
          variant="ghost"
          className={cn(PILL, "ml-auto")}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "animate-spin")}
          />
          목록 새로고침
        </Button>
      </div>

      <p className="text-[13px] text-muted-foreground">
        예약하려는 회의실을 고르세요. 목록에 없으면 구글 캘린더 웹에서 해당
        회의실 캘린더를 먼저 추가(구독)해야 합니다.
      </p>

      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[13px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}

      <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
        {rooms.length === 0 && !loading ? (
          <p className="px-3 py-2 text-[13px] text-muted-foreground">
            선택할 수 있는 캘린더가 없습니다.
          </p>
        ) : (
          rooms.map((c) => {
            const on = !!selected[c.id]
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id, c.summary)}
                className={cn(
                  "flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors hover:bg-ui-list-hover",
                  on && "bg-ui-selection/10"
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-md border",
                    on
                      ? "border-ui-selection bg-ui-selection text-ui-selection-fg"
                      : "border-border"
                  )}
                >
                  {on && <CheckIcon className="size-3.5" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.summary}</span>
              </button>
            )
          })
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" className={PILL} onClick={onClose}>
          취소
        </Button>
        <Button
          className={PILL}
          onClick={() => {
            onSave(Object.values(selected))
            onClose()
          }}
        >
          저장
        </Button>
      </div>
    </div>
  )
}

/** 회의실 예약 폼 — 내 캘린더에 일정을 만들고 회의실을 리소스로 첨부한다. */
function BookingForm({
  rooms,
  canWrite,
  onBooked,
  prefill,
}: {
  rooms: RoomRef[]
  canWrite: boolean
  onBooked: () => void
  /**
   * 타임라인에서 고른 슬롯. 부모가 고를 때마다 이 컴포넌트를 key 로 리마운트하므로,
   * 아래 초기값들이 매번 새 prefill 로 다시 계산된다(effect 없이 리셋되는 패턴).
   */
  prefill: BookingPrefill | null
}) {
  const [roomId, setRoomId] = useState(prefill?.roomId ?? rooms[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [date, setDate] = useState(() => prefill?.date ?? toYmd(new Date()))
  // 시작 기본값 = 현재 시각을 다음 정각으로 올린 값(09:10 → 10:00), 종료는 +1시간.
  const [start, setStart] = useState(
    () => prefill?.startHm ?? toHm(ceilToHour(new Date().getTime()))
  )
  const [end, setEnd] = useState(
    () => prefill?.endHm ?? toHm(ceilToHour(new Date().getTime()) + 3_600_000)
  )
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // 저장된 회의실이 바뀌어 선택이 사라지면 첫 회의실로 폴백(파생값 — effect 불필요).
  const effRoomId = rooms.some((r) => r.id === roomId)
    ? roomId
    : (rooms[0]?.id ?? "")

  async function submit() {
    const room = rooms.find((r) => r.id === effRoomId)
    if (!room || busy) return
    setBusy(true)
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
      setMsg({ ok: true, text: `${room.name} 예약 완료` })
      setTitle("")
      onBooked()
    } catch (e) {
      setMsg({ ok: false, text: friendlyError(String(e)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      <span className="text-[15px] font-semibold">회의실 예약</span>

      {!canWrite && (
        <p className="rounded-lg bg-ui-warning/15 px-3 py-2 text-[13px] text-ui-warning">
          예약하려면 설정 → Google Calendar 에서 연결을 해제하고 다시 로그인해야
          합니다(쓰기 권한 필요).
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="book-room">회의실</Label>
          <select
            id="book-room"
            className={FIELD}
            value={effRoomId}
            onChange={(e) => setRoomId(e.target.value)}
          >
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="book-title">제목</Label>
          <Input
            id="book-title"
            placeholder="회의"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="book-date">날짜</Label>
          <input
            id="book-date"
            type="date"
            className={FIELD}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="book-start">시작</Label>
            <input
              id="book-start"
              type="time"
              className={FIELD}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <span className="pb-2 text-muted-foreground">–</span>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="book-end">종료</Label>
            <input
              id="book-end"
              type="time"
              className={FIELD}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
      </div>

      {msg && (
        <p
          className={cn(
            "rounded-lg px-3 py-2 text-[13px]",
            msg.ok
              ? "bg-ui-success/15 text-ui-success"
              : "bg-ui-error/15 text-ui-error"
          )}
        >
          {msg.text}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          className={PILL}
          onClick={() => void submit()}
          disabled={busy || !canWrite || !effRoomId}
        >
          <PlusIcon className="size-3.5" />
          {busy ? "예약 중…" : "예약하기"}
        </Button>
      </div>
    </div>
  )
}

export function RoomsView() {
  const { status } = useGcalConnection()
  const [rooms, setRooms] = useLocalStorage<RoomRef[]>(ROOMS_KEY, [])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [prefill, setPrefill] = useState<BookingPrefill | null>(null)
  // 슬롯을 고를 때마다 증가 → BookingForm 을 리마운트해 폼을 새 값으로 리셋한다.
  const [prefillKey, setPrefillKey] = useState(0)
  const { byRoom, loading, error, updatedAt, refresh } = useRoomSchedule(rooms)

  function handlePick(p: BookingPrefill) {
    setPrefill(p)
    setPrefillKey((k) => k + 1)
  }

  const canWrite = status?.can_write ?? false

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DoorOpenIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">회의실 일정</span>
        <span className="text-[13px] text-muted-foreground">
          {rooms.length}개 회의실
          {updatedAt &&
            ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })} 업데이트`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            className={PILL}
            onClick={() => setPickerOpen((v) => !v)}
          >
            <SettingsIcon className="size-3.5" />
            회의실 선택
          </Button>
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refresh()}
            disabled={loading || rooms.length === 0}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
            새로고침
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}

      {pickerOpen && (
        <RoomPicker
          saved={rooms}
          onSave={setRooms}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {rooms.length === 0 ? (
        !pickerOpen && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <DoorOpenIcon className="size-9 text-muted-foreground" />
            <p className="text-[15px] font-bold">선택된 회의실이 없습니다.</p>
            <p className="text-[13px] text-muted-foreground">
              위의 ‘회의실 선택’ 으로 자주 쓰는 회의실을 골라 주세요.
            </p>
          </div>
        )
      ) : (
        <>
          <RoomTimeline
            rooms={rooms}
            byRoom={byRoom}
            onPick={handlePick}
            selected={prefill}
          />

          <BookingForm
            key={prefillKey}
            rooms={rooms}
            canWrite={canWrite}
            onBooked={refresh}
            prefill={prefill}
          />

          <div className="flex flex-col gap-5">
            {rooms.map((room) => {
              const { thisWeek, nextWeek } = splitByWeek(byRoom[room.id] ?? [])
              return (
                <div key={room.id} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <DoorOpenIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="text-[15px] font-bold">{room.name}</span>
                  </div>
                  <div className="flex flex-col gap-3 pl-1">
                    <WeekSection title="이번주" events={thisWeek} />
                    <WeekSection title="다음주" events={nextWeek} />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
