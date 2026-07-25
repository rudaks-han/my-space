import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { trackedInvoke } from "@/lib/tauri"
import { WidgetNotice } from "./widget-notice"
import { WidgetQuestion } from "./widget-question"
import { WidgetReminder, type ReminderPayload } from "./widget-reminder"

/**
 * 트레이 팝오버 창(`widget`)의 진입점. 같은 창을 알림 팝오버와 herdr 질문 팝오버가
 * 공유하므로, 여기서 어느 것을 표시할지 정한다. 알림이 떠 있으면 알림을 우선 표시하고,
 * 없으면 herdr 질문 화면으로 넘어간다.
 */
export function WidgetRoot() {
  const [reminder, setReminder] = useState<ReminderPayload | null>(null)

  useEffect(() => {
    // 마운트 시(팝오버 창이 막 떠서 웹뷰가 로드된 경우 포함) 현재 알림을 조회.
    void trackedInvoke<ReminderPayload | null>("reminder_current").then((r) => {
      if (r) setReminder(r)
    })

    const unlistenFire = listen<ReminderPayload>("reminder:fire", (e) => {
      setReminder(e.payload)
    })
    const unlistenDismiss = listen("reminder:dismiss", () => {
      setReminder(null)
    })
    return () => {
      void unlistenFire.then((f) => f())
      void unlistenDismiss.then((f) => f())
    }
  }, [])

  const dismiss = useCallback(async () => {
    try {
      await trackedInvoke("reminder_dismiss")
    } catch (err) {
      console.error("reminder_dismiss 실패:", err)
    }
    setReminder(null)
  }, [])

  const snooze = useCallback(async (minutes: number) => {
    try {
      await trackedInvoke("reminder_snooze", { minutes })
    } catch (err) {
      console.error("reminder_snooze 실패:", err)
    }
    setReminder(null)
  }, [])

  if (reminder) {
    return (
      <WidgetReminder
        reminder={reminder}
        onDismiss={dismiss}
        onSnooze={snooze}
      />
    )
  }
  // 알림(입력 대기/작업 완료)을 상단에, 그 아래에 herdr 질문 화면을 함께 표시한다.
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden rounded-lg border bg-background text-left">
      <WidgetNotice />
      <WidgetQuestion />
    </div>
  )
}
