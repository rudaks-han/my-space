import { useEffect, useRef } from "react"
import { ArrowLeftIcon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useWebviewBounds } from "@/lib/use-webview-bounds"

/** 표시할 대시보드 주소. */
export const COWORK_AI_URL = "https://cowork-ai-dashboard.spectra.co.kr/"

/**
 * 네이티브 웹뷰 라벨. lib.rs 의 BROWSER_PREFIX(`browser-tab-`) 로 시작해야
 * 페이지 내부 링크 이동이 외부 브라우저로 가로채이지 않고 앱 안에서 열린다.
 */
const LABEL = "browser-tab-cowork-ai-dashboard"

const inTauri = isTauri()

/**
 * Cowork AI 대시보드를 앱 안에 임베드한다.
 * iframe 이 아니라 브라우저 기능과 같은 네이티브 자식 웹뷰를 쓰므로(쿠키·로그인 세션 유지,
 * X-Frame-Options 제약 없음) 표시 영역 좌표를 재서 Rust 에 넘긴다.
 */
export function CoworkAiView() {
  const contentRef = useRef<HTMLDivElement>(null)
  const rect = useWebviewBounds(contentRef)

  // 영역이 확정되면 웹뷰를 만들고(이후에는 재배치만) 리사이즈·사이드바 토글에 따라 위치를 맞춘다.
  useEffect(() => {
    if (!inTauri || !rect) return
    void trackedInvoke("browser_open", {
      label: LABEL,
      url: COWORK_AI_URL,
      ...rect,
    })
  }, [rect])

  // 다른 메뉴로 전환하면 화면 밖으로 숨긴다(웹뷰는 살려 두어 로그인·스크롤 상태 유지).
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
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
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
        <span className="truncate px-1 text-xs text-muted-foreground">
          {COWORK_AI_URL}
        </span>
      </div>

      {/* 웹뷰가 그려질 영역 — 네이티브 웹뷰가 이 위에 겹쳐서 렌더된다 */}
      <div ref={contentRef} className="relative flex-1 bg-muted/20">
        {!inTauri && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            이 화면은 Tauri 앱(bun run tauri dev)에서만 표시됩니다.
          </div>
        )}
      </div>
    </div>
  )
}
