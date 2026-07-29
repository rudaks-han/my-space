import { useMemo, useState } from "react"
import {
  BellIcon,
  BellOffIcon,
  CheckIcon,
  PencilIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import {
  useReminders,
  type Reminder,
  type ReminderRepeat,
} from "./use-reminders"

const REPEATS: { key: ReminderRepeat; label: string }[] = [
  { key: "once", label: "한 번" },
  { key: "daily", label: "매일" },
]

/** datetime-local 기본값: 현재 시각 + 5분(로컬), "YYYY-MM-DDTHH:MM". */
function defaultDateTime() {
  const d = new Date(Date.now() + 5 * 60_000)
  d.setSeconds(0, 0)
  return toLocalInput(d.getTime())
}

/** epoch ms → datetime-local 값 "YYYY-MM-DDTHH:MM"(로컬). */
function toLocalInput(ms: number) {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 목록에 표시할 예정 시각 문구. */
function scheduleText(r: Reminder) {
  if (r.repeat === "daily")
    return `매일 ${r.time}${r.excludeWeekends ? " (평일만)" : ""}`
  return new Date(r.at).toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** 한 번짜리 알림이 이미 울렸는지. */
function isFiredOnce(r: Reminder) {
  return r.repeat === "once" && r.firedAt != null
}

/** 폼 필드 라벨 — Slack 은 대문자 마이크로 라벨을 쓰지 않는다(13px semibold). */
const FIELD_LABEL = "text-[13px] font-semibold text-muted-foreground"

export function ReminderView() {
  const { reminders, add, update, toggle, remove } = useReminders()
  const [title, setTitle] = useState("")
  const [repeat, setRepeat] = useState<ReminderRepeat>("once")
  const [at, setAt] = useState(defaultDateTime)
  const [time, setTime] = useState("09:00")
  const [excludeWeekends, setExcludeWeekends] = useState(false)

  const activeCount = useMemo(
    () => reminders.filter((r) => r.enabled && !isFiredOnce(r)).length,
    [reminders]
  )

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    add({ title, repeat, at, time, excludeWeekends })
    setTitle("")
    setAt(defaultDateTime())
  }

  return (
    <div className="mx-auto w-full max-w-2xl rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 패널 헤더 — Slack 톤(15px semibold, 배경색 없음, 개수는 알약 배지). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <span className="text-[15px] font-semibold">알림</span>
        <span className="ml-auto rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground tabular-nums">
          예정 {activeCount}
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] text-muted-foreground">
          시간이 되면 메뉴바 팝오버로 알려줍니다.
        </p>

        <form className="flex flex-col gap-3" onSubmit={submit}>
          <Input
            placeholder="알림 내용을 입력하세요"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className={FIELD_LABEL}>반복</Label>
              {/* 반복 선택 — Slack 의 테두리 알약 버튼 군. 활성만 와인색으로 채운다. */}
              <div className="flex gap-1.5">
                {REPEATS.map((r) => {
                  const active = repeat === r.key
                  return (
                    <button
                      key={r.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setRepeat(r.key)}
                      className={cn(
                        "h-7 cursor-pointer rounded-full border px-3 text-[13px] font-semibold transition-colors",
                        active
                          ? "border-transparent bg-ui-list-active text-ui-list-active-fg"
                          : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
                      )}
                    >
                      {r.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className={FIELD_LABEL}>
                {repeat === "daily" ? "매일 이 시각" : "예정 일시"}
              </Label>
              {repeat === "daily" ? (
                <Input
                  type="time"
                  className="w-28"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              ) : (
                <Input
                  type="datetime-local"
                  // 한국어 로케일 표시("2026. 07. 27. 오후 08:00")가 잘리지 않게 넉넉히.
                  className="w-60"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                />
              )}
            </div>

            <Button type="submit" disabled={!title.trim()}>
              추가
            </Button>
          </div>

          {/* 주말 제외 — 매일 반복일 때만. Slack 체크박스 + 15px 라벨. */}
          {repeat === "daily" && (
            <Label className="flex w-fit cursor-pointer items-center gap-2 text-[15px] font-normal">
              <Checkbox
                checked={excludeWeekends}
                onCheckedChange={(v) => setExcludeWeekends(v === true)}
              />
              주말(토·일) 제외
            </Label>
          )}
        </form>
      </div>

      {/* 목록 — Slack 리스트 행(36px, 8px 라운드, 행 테두리 없이 여백으로 구분). */}
      <ul className="flex flex-col gap-0.5 border-t border-border p-2">
        {reminders.length === 0 && (
          <li className="py-8 text-center text-[15px] text-muted-foreground">
            등록된 알림이 없습니다.
          </li>
        )}
        {reminders.map((r) => (
          <ReminderRow
            key={r.id}
            reminder={r}
            onToggle={() => toggle(r.id)}
            onRemove={() => remove(r.id)}
            onUpdate={(patch) => update(r.id, patch)}
          />
        ))}
      </ul>
    </div>
  )
}

/**
 * 목록의 알림 한 행. 평소엔 읽기 전용이고, 연필 버튼을 누르면 같은 자리에서
 * 이름·시간·(매일이면)주말 제외를 고칠 수 있는 편집 모드로 바뀐다.
 */
function ReminderRow({
  reminder: r,
  onToggle,
  onRemove,
  onUpdate,
}: {
  reminder: Reminder
  onToggle: () => void
  onRemove: () => void
  onUpdate: (patch: {
    title?: string
    time?: string
    at?: string
    excludeWeekends?: boolean
  }) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(r.title)
  const [time, setTime] = useState(r.time || "09:00")
  const [at, setAt] = useState(() => toLocalInput(r.at))
  const [excludeWeekends, setExcludeWeekends] = useState(r.excludeWeekends)

  const startEdit = () => {
    // 최신 값으로 폼을 채운 뒤 편집 모드로 — 취소 시 원래 값이 남지 않게 한다.
    setTitle(r.title)
    setTime(r.time || "09:00")
    setAt(toLocalInput(r.at))
    setExcludeWeekends(r.excludeWeekends)
    setEditing(true)
  }

  const save = () => {
    if (!title.trim()) return
    onUpdate(
      r.repeat === "daily" ? { title, time, excludeWeekends } : { title, at }
    )
    setEditing(false)
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-3 rounded-lg bg-ui-list-hover px-3 py-3">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="알림 내용을 입력하세요"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
            if (e.key === "Escape") setEditing(false)
          }}
        />

        <div className="flex flex-wrap items-center gap-3">
          {r.repeat === "daily" ? (
            <>
              <Input
                type="time"
                className="w-28"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
              <Label className="flex cursor-pointer items-center gap-2 text-[15px] font-normal">
                <Checkbox
                  checked={excludeWeekends}
                  onCheckedChange={(v) => setExcludeWeekends(v === true)}
                />
                주말(토·일) 제외
              </Label>
            </>
          ) : (
            <Input
              type="datetime-local"
              // 한국어 로케일 표시("2026. 07. 27. 오후 08:00")가 잘리지 않게 넉넉히.
              className="w-60"
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={save} disabled={!title.trim()}>
              <CheckIcon className="size-4" />
              저장
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <XIcon className="size-4" />
              취소
            </Button>
          </div>
        </div>
      </li>
    )
  }

  const fired = isFiredOnce(r)
  const dimmed = !r.enabled || fired

  return (
    <li className="group flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 transition-colors hover:bg-ui-list-hover">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggle}
        aria-label={r.enabled ? "알림 끄기" : "알림 켜기"}
        title={r.enabled ? "알림 끄기" : "알림 켜기"}
        className={cn(
          "shrink-0",
          r.enabled ? "text-ui-link" : "text-muted-foreground"
        )}
      >
        {r.enabled ? (
          <BellIcon className="size-4" />
        ) : (
          <BellOffIcon className="size-4" />
        )}
      </Button>

      {/* 알림 내용은 Slack 처럼 굵게 — 행에서 가장 먼저 읽혀야 한다. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[15px] font-bold",
          dimmed && "font-normal text-muted-foreground line-through"
        )}
      >
        {r.title}
      </span>

      <span className="shrink-0 text-[13px] text-muted-foreground">
        {scheduleText(r)}
      </span>
      {fired && (
        <span className="shrink-0 rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground">
          완료
        </span>
      )}

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={startEdit}
        aria-label="수정"
        title="수정"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
      >
        <PencilIcon className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onRemove}
        aria-label="삭제"
        className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
      >
        <Trash2Icon className="size-4" />
      </Button>
    </li>
  )
}
