import { useEffect, useRef, useState } from "react"
import { ArrowLeftIcon, RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useWebviewBounds } from "@/lib/use-webview-bounds"

/** 표시할 GitHub 저장소 주소. */
export const GITHUB_COWORK_URL = "https://github.com/spectrakr/cowork"

/**
 * 네이티브 웹뷰 라벨. lib.rs 의 BROWSER_PREFIX(`browser-tab-`) 로 시작해야
 * 페이지 내부 링크 이동이 외부 브라우저로 가로채이지 않고 앱 안에서 열린다.
 */
const LABEL = "browser-tab-github-cowork"

const inTauri = isTauri()

/**
 * GitHub 의 spectrakr/cowork 저장소를 앱 안에 임베드한다.
 * iframe 이 아니라 브라우저 기능과 같은 네이티브 자식 웹뷰를 쓰므로(쿠키·로그인 세션 유지,
 * X-Frame-Options 제약 없음) 표시 영역 좌표를 재서 Rust 에 넘긴다.
 *
 * 최초 진입 시, 로컬 Chrome 에 github.com 로그인 쿠키가 있으면 그걸 웹뷰에 주입해
 * 별도 로그인 없이 바로 로그인 상태가 되도록 한다(github_import_chrome_cookies).
 */
export function GithubCoworkView() {
  const contentRef = useRef<HTMLDivElement>(null)
  const rect = useWebviewBounds(contentRef)

  // 웹뷰 생성 여부. 최초 1회는 github_import_chrome_cookies 로 만들고(쿠키 주입 후 이동),
  // 이후 리사이즈/사이드바 토글 때는 browser_open 으로 재배치만 한다.
  const [created, setCreated] = useState(false)
  const creating = useRef(false)

  // 영역이 확정되면(최초 1회) Chrome 쿠키를 주입하며 웹뷰를 만든다.
  // Rust 쪽에서 쿠키를 복호화해 넣은 뒤 URL 로 이동시키므로, 로그인돼 있으면 바로 로그인 상태로 뜬다.
  useEffect(() => {
    if (!inTauri || !rect || creating.current) return
    creating.current = true
    void trackedInvoke("github_import_chrome_cookies", {
      label: LABEL,
      url: GITHUB_COWORK_URL,
      ...rect,
    })
      .catch((e) => {
        // 실패해도(Chrome 미설치·미로그인·권한 등) 그냥 로그인 화면을 띄운다.
        console.warn("Chrome 쿠키 가져오기 실패:", e)
      })
      .finally(() => setCreated(true))
  }, [rect])

  // 생성 이후에는 표시 영역이 바뀔 때 재배치만 한다(웹뷰 재생성/재이동 없음).
  useEffect(() => {
    if (!inTauri || !rect || !created) return
    void trackedInvoke("browser_open", {
      label: LABEL,
      url: GITHUB_COWORK_URL,
      ...rect,
    })
  }, [rect, created])

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
          {GITHUB_COWORK_URL}
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
