import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { trackedInvoke } from "@/lib/tauri"
import type { HerdrNotice } from "@/features/claude-bridge/use-herdr"

/**
 * 트레이 팝오버 상단에 뜨는 Claude Code 알림(입력 대기/작업 완료).
 * Rust 감시 루프가 상태 전환을 감지해 `herdr_notify` 로 등록하고, 활성 목록을 `herdr:notices`
 * 이벤트로 방출한다(만료되면 Rust 가 목록에서 빼고 팝오버도 닫는다). 여기서는 그 목록을 표시만 하고,
 * 항목의 "이동"을 누르면 해당 herdr 워크스페이스(터미널)로 전환한다.
 */
export function WidgetNotice() {
  const [notices, setNotices] = useState<HerdrNotice[]>([])

  useEffect(() => {
    void trackedInvoke<HerdrNotice[]>("herdr_current_notices").then((ns) => {
      if (ns && ns.length) setNotices(ns)
    })
    const unlisten = listen<HerdrNotice[]>("herdr:notices", (e) => {
      setNotices(e.payload || [])
    })
    return () => {
      void unlisten.then((f) => f())
    }
  }, [])

  // 알림을 누르면 해당 터미널로 이동하고, 그 알림은 목록에서 제거한다(완료 알림도 이때 사라짐).
  const openNotice = useCallback(async (n: HerdrNotice) => {
    try {
      await trackedInvoke("herdr_focus_workspace", {
        session: n.session,
        workspaceId: n.workspace_id,
      })
    } catch (err) {
      console.error("herdr_focus_workspace 실패:", err)
    }
    try {
      await trackedInvoke("herdr_dismiss_notice", { id: n.id })
    } catch {
      /* 무시 */
    }
  }, [])

  if (notices.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 border-b p-2">
      {notices.map((n) => {
        const done = n.kind === "done"
        return (
          <button
            key={n.id}
            type="button"
            onClick={() => void openNotice(n)}
            className="hover:bg-accent flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors"
          >
            <div className="flex w-full items-center gap-2">
              <span
                className={
                  done
                    ? "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400"
                    : "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400"
                }
              >
                {done ? "작업 완료" : "입력 대기"}
              </span>
              <span className="text-primary ml-auto shrink-0 text-[11px]">
                이동 →
              </span>
            </div>
            {/* 알림 메시지 = 사용자가 입력했던 프롬프트 */}
            <span className="text-foreground line-clamp-2 w-full text-xs leading-snug">
              {n.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
