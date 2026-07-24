import { BellRingIcon } from "lucide-react"
import { getCurrentWindow } from "@tauri-apps/api/window"

/** 팝오버에 표시할 알림 내용(Rust `ReminderPayload` 와 대응). */
export interface ReminderPayload {
  id: string
  title: string
  body: string
}

/** 다시 알림(스누즈) 선택지 — 분 단위. */
const SNOOZE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5분 후" },
  { minutes: 30, label: "30분 후" },
  { minutes: 60, label: "1시간 후" },
]

/**
 * 메뉴바 트레이 팝오버에 알림을 표시한다. 예정 시각이 되면 Rust `reminder_fire` 가
 * 팝오버 창을 직접 띄우고 이 내용을 상태에 저장한다(widget-root 가 조회·전달).
 * 확인을 누르면 Rust `reminder_dismiss` 로 팝오버를 닫고, "다시 알림"을 누르면
 * `reminder_snooze` 로 팝오버를 닫은 뒤 선택한 시간 후에 다시 띄운다.
 */
export function WidgetReminder({
  reminder,
  onDismiss,
  onSnooze,
}: {
  reminder: ReminderPayload
  onDismiss: () => void
  onSnooze: (minutes: number) => void
}) {
  return (
    <div className="bg-background fixed inset-0 flex flex-col overflow-hidden rounded-lg border text-left">
      {/* 헤더를 드래그하면 팝오버 창을 이동할 수 있다(네이티브 창 드래그). */}
      <div
        onPointerDown={(e) => {
          if (e.button === 0) void getCurrentWindow().startDragging()
        }}
        className="flex cursor-move items-center gap-2 border-b px-3 py-2 select-none"
      >
        <BellRingIcon className="text-primary size-3.5" />
        <span className="text-muted-foreground text-xs">알림</span>
      </div>

      <div className="flex flex-1 flex-col justify-center px-4 py-3">
        <p className="text-sm leading-relaxed font-medium break-words whitespace-pre-wrap">
          {reminder.title}
        </p>
        {reminder.body && (
          <p className="text-muted-foreground mt-1 text-xs">{reminder.body}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">다시 알림</span>
          <div className="ml-auto flex gap-1">
            {SNOOZE_OPTIONS.map((o) => (
              <button
                key={o.minutes}
                type="button"
                onClick={() => onSnooze(o.minutes)}
                className="hover:bg-muted rounded-md border px-2 py-1 text-xs font-medium transition-colors"
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          >
            확인
          </button>
        </div>
      </div>
    </div>
  )
}
