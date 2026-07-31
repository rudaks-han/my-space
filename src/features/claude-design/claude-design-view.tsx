import { useEffect, useRef } from "react"
import { ArrowLeftIcon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"
import { useWebviewsSuppressed } from "@/lib/webview-overlay"
import { useWebviewBounds } from "@/lib/use-webview-bounds"
import { browserLabel } from "@/lib/window-role"

/** 표시할 Claude Design 주소. */
export const CLAUDE_DESIGN_URL = "https://claude.ai/design"

/**
 * 네이티브 웹뷰 라벨. lib.rs 의 BROWSER_PREFIX(`browser-tab-`) 로 시작해야
 * 페이지 내부 링크 이동이 외부 브라우저로 가로채이지 않고 앱 안에서 열린다.
 * 창마다 다른 라벨을 써야 한다 — 메인 창과 "새 창으로 열기" 창이 같은 웹뷰를 다투지 않도록.
 */
const LABEL = browserLabel("claude-design")

const inTauri = isTauri()

/**
 * Claude Design 을 앱 안에 임베드한다.
 * iframe 이 아니라 브라우저 기능과 같은 네이티브 자식 웹뷰를 쓰므로(쿠키·로그인 세션 유지,
 * X-Frame-Options 제약 없음) 표시 영역 좌표를 재서 Rust 에 넘긴다.
 */
export function ClaudeDesignView() {
  // 이 뷰가 보이는 탭인지(숨은 동안 네이티브 웹뷰도 같이 숨겨야 한다).
  const tabActive = useTabActive()
  // 웹뷰 위에 HTML 오버레이(탭 목록 드롭다운 등)가 떠 있으면 잠시 비켜 준다.
  const suppressed = useWebviewsSuppressed()
  const visible = tabActive && !suppressed
  const contentRef = useRef<HTMLDivElement>(null)
  const rect = useWebviewBounds(contentRef)

  // 영역이 확정되면 웹뷰를 만들고(이후에는 재배치만) 리사이즈·사이드바 토글에 따라 위치를 맞춘다.
  // 탭이 다시 보이게 될 때도 이 effect 가 돌아 화면 밖에서 제자리로 돌아온다.
  useEffect(() => {
    if (!inTauri || !rect || !visible) return
    void trackedInvoke("browser_open", {
      label: LABEL,
      url: CLAUDE_DESIGN_URL,
      ...rect,
    })
  }, [rect, visible])

  // 다른 탭으로 전환하거나 웹뷰 위에 오버레이가 뜨면 화면 밖으로 숨긴다. 네이티브 웹뷰는
  // 창 위에 겹쳐 그려져 CSS 로 감춰지지 않으므로, 숨기지 않으면 다른 화면을 덮는다.
  useEffect(() => {
    if (!inTauri || visible) return
    void trackedInvoke("browser_hide", { label: LABEL })
  }, [visible])

  // 탭을 닫으면(언마운트) 숨긴다(웹뷰는 살려 두어 로그인·스크롤 상태 유지).
  useEffect(() => {
    if (!inTauri) return
    return () => {
      void trackedInvoke("browser_hide", { label: LABEL })
    }
  }, [])

  const nav = (command: "browser_back" | "browser_reload") => {
    if (inTauri) void trackedInvoke(command, { label: LABEL })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 툴바 — Slack 패널 머리말 톤(배경 칠하지 않고 아래 테두리로만 구분) */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border px-3">
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_back")}
          aria-label="뒤로"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_reload")}
          aria-label="새로고침"
        >
          <RotateCwIcon />
        </Button>
        {/* 주소는 Slack 의 테두리 알약 칩으로 보여 준다 */}
        <span className="ml-1 flex h-7 min-w-0 items-center rounded-full border border-border px-3 text-[13px] text-muted-foreground">
          <span className="truncate">{CLAUDE_DESIGN_URL}</span>
        </span>
      </div>

      {/* 웹뷰가 그려질 영역 — 네이티브 웹뷰가 이 위에 겹쳐서 렌더된다 */}
      <div ref={contentRef} className="relative flex-1 bg-background">
        {!inTauri && (
          <div className="absolute inset-0 grid place-items-center p-8 text-center text-[15px] text-muted-foreground">
            이 화면은 Tauri 앱(bun run tauri dev)에서만 표시됩니다.
          </div>
        )}
      </div>
    </div>
  )
}
