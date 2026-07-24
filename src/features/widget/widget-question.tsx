import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { trackedInvoke } from "@/lib/tauri"
import type { AskQuestion } from "@/features/claude-bridge/use-herdr"

/**
 * 트레이 팝오버(위젯 창)에 "선택 대기 중인 AskUserQuestion" 목록을 알림으로 표시한다.
 * 답변은 하지 않는다 — 항목을 클릭하면 그 herdr 워크스페이스로 이동(focus)하고,
 * 실제 선택은 사용자가 터미널에서 한다. 여러 개가 동시에 대기할 수 있어 리스트로 보여준다.
 * 터미널에서 답하면 워처가 목록에서 제거하고, 목록이 비면 팝오버가 닫힌다.
 */
export function WidgetQuestion() {
  const [questions, setQuestions] = useState<AskQuestion[]>([])

  useEffect(() => {
    // 마운트 시 현재 대기 목록 조회(팝오버 창이 막 떠서 웹뷰가 로드된 경우 포함).
    void trackedInvoke<AskQuestion[]>("herdr_current_questions").then((qs) => {
      if (qs && qs.length) setQuestions(qs)
    })
    const unlisten = listen<AskQuestion[]>("herdr:questions", (e) => {
      setQuestions(e.payload || [])
    })
    return () => {
      void unlisten.then((f) => f())
    }
  }, [])

  const focus = useCallback(async (session: string, paneId: string) => {
    try {
      await trackedInvoke("herdr_focus_pane", { session, paneId })
    } catch (err) {
      console.error("herdr_focus_pane 실패:", err)
    }
  }, [])

  const close = useCallback(async () => {
    try {
      await trackedInvoke("herdr_hide_popover")
    } catch {
      /* 무시 */
    }
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden text-left">
      {/* 헤더를 드래그하면 팝오버 창을 이동할 수 있다. */}
      <div
        onPointerDown={(e) => {
          if (e.button === 0) void getCurrentWindow().startDragging()
        }}
        className="flex cursor-move items-center gap-2 border-b px-3 py-2 select-none"
      >
        <span className="bg-primary text-primary-foreground rounded px-1.5 py-0.5 text-[10px] font-medium">
          Claude
        </span>
        <span className="text-xs font-medium">
          {questions.length ? `선택 대기 ${questions.length}건` : "Claude Code"}
        </span>
        <button
          type="button"
          onClick={() => void close()}
          className="text-muted-foreground hover:text-foreground ml-auto text-sm"
          aria-label="닫기"
          title="닫기"
        >
          ✕
        </button>
      </div>

      {questions.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-4 text-center text-xs">
          대기 중인 선택이 없습니다
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            <div className="flex flex-col gap-1.5">
              {questions.map((q) => (
                <button
                  key={`${q.session} ${q.pane_id}`}
                  type="button"
                  onClick={() => void focus(q.session, q.pane_id)}
                  className="hover:bg-accent flex flex-col items-start gap-1 rounded-md border px-2.5 py-2 text-left transition-colors"
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="bg-muted rounded px-1 py-0.5 font-mono text-[10px]">
                      {q.pane_id}
                    </span>
                    {q.header && (
                      <span className="text-[11px] font-medium">{q.header}</span>
                    )}
                    <span className="text-primary ml-auto text-[10px]">이동 →</span>
                  </div>
                  {q.question && (
                    <span className="text-muted-foreground max-h-10 overflow-hidden text-[11px] leading-snug whitespace-pre-wrap">
                      {q.question}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <div className="text-muted-foreground border-t px-3 py-1.5 text-[10px]">
            항목을 클릭하면 해당 터미널로 이동합니다 · 선택은 터미널에서
          </div>
        </>
      )}
    </div>
  )
}
