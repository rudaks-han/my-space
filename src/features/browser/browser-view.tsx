import { useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CodeIcon,
  GlobeIcon,
  PlusIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useWebviewBounds } from "@/lib/use-webview-bounds"
import { cn } from "@/lib/utils"
import { labelFor, normalizeUrl, useBrowser } from "./use-browser"

// isTauri 는 함수이므로 한 번 호출해 boolean 으로 둔다 (Tauri 앱 안에서 실행 중인지).
const inTauri = isTauri()

export function BrowserView() {
  const { tabs, activeId, setActiveId, addTab, removeTab, setTabUrl } =
    useBrowser()

  const contentRef = useRef<HTMLDivElement>(null)
  // 네이티브 웹뷰를 겹쳐 그릴 영역(레이아웃이 안정되기 전에는 null).
  const rect = useWebviewBounds(contentRef)

  // 주소창은 활성 탭의 현재 URL 을 반영하되 편집 가능해야 한다.
  // 활성 탭이나 그 URL(탭 전환·페이지 내부 이동)이 바뀌면 입력값을 재동기화한다
  // — 렌더 중 상태 조정 패턴(https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  const activeTab = tabs.find((t) => t.id === activeId)
  const activeUrl = activeTab?.url ?? ""
  const [address, setAddress] = useState(activeUrl)
  const [syncedKey, setSyncedKey] = useState<string | null>(null)
  const currentKey = `${activeId ?? ""}:${activeUrl}`
  if (syncedKey !== currentKey) {
    setSyncedKey(currentKey)
    setAddress(activeUrl)
  }

  // 최신 tabs 를 클로저 밖(이벤트 리스너·언마운트 정리)에서 참조하기 위한 ref
  const tabsRef = useRef(tabs)
  useEffect(() => {
    tabsRef.current = tabs
  })
  const didInit = useRef(false)

  // 탭이 하나도 없으면 최초 진입 시 기본 탭 하나 생성 (StrictMode 중복 방지: ref 가드)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    if (tabs.length === 0) addTab()
  }, [tabs.length, addTab])

  // 활성 탭을 현재 영역에 표시(없으면 생성)하고 나머지는 숨긴다.
  // 이미 존재하는 웹뷰는 재배치만 하므로 탭 전환·리사이즈로 페이지가 다시 로드되지 않는다.
  useEffect(() => {
    if (!inTauri || !rect) return
    const active = tabs.find((t) => t.id === activeId)
    if (active) {
      void trackedInvoke("browser_open", {
        label: labelFor(active.id),
        url: active.url,
        ...rect,
      })
    }
    for (const t of tabs) {
      if (t.id !== activeId) {
        void trackedInvoke("browser_hide", { label: labelFor(t.id) })
      }
    }
  }, [activeId, rect, tabs])

  // 웹뷰 내부 이동(링크 클릭 등)을 Rust 가 알려주면 탭 URL·제목을 동기화한다.
  useEffect(() => {
    if (!inTauri) return
    const unlisten = listen<{ label: string; url: string }>(
      "browser:navigated",
      (event) => {
        const { label, url } = event.payload
        const tab = tabsRef.current.find((t) => labelFor(t.id) === label)
        if (tab && tab.url !== url) setTabUrl(tab.id, url)
      }
    )
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [setTabUrl])

  // window.open / target="_blank" 로 새 창이 요청되면(Rust 에서 방출) 새 탭으로 연다.
  useEffect(() => {
    if (!inTauri) return
    const unlisten = listen<string>("browser:new-tab", (event) => {
      const url = event.payload
      if (url && /^https?:/i.test(url)) addTab(url)
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [addTab])

  // 브라우저 메뉴를 떠나면 모든 탭 웹뷰를 화면 밖으로 숨긴다 (웹뷰는 살려 상태 유지).
  useEffect(() => {
    if (!inTauri) return
    return () => {
      for (const t of tabsRef.current) {
        void trackedInvoke("browser_hide", { label: labelFor(t.id) })
      }
    }
  }, [])

  const closeTab = (id: string) => {
    if (inTauri) void trackedInvoke("browser_close", { label: labelFor(id) })
    removeTab(id)
  }

  const submitAddress = (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeId) return
    const url = normalizeUrl(address)
    setTabUrl(activeId, url)
    if (inTauri)
      void trackedInvoke("browser_navigate", { label: labelFor(activeId), url })
  }

  const nav = (
    command:
      "browser_back" | "browser_forward" | "browser_reload" | "browser_devtools"
  ) => {
    if (activeId && inTauri)
      void trackedInvoke(command, { label: labelFor(activeId) })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border bg-card">
      {/* 탭 스트립 */}
      <div className="flex items-center gap-1 overflow-x-auto border-b bg-muted/40 px-1.5 py-1">
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                "group flex h-8 max-w-52 min-w-32 cursor-default items-center gap-2 rounded-md px-2.5 text-sm transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60"
              )}
            >
              <GlobeIcon className="size-3.5 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{t.title || "새 탭"}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                aria-label="탭 닫기"
                className="grid size-4 shrink-0 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted-foreground/20"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          )
        })}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => addTab()}
          aria-label="새 탭"
          className="shrink-0"
        >
          <PlusIcon />
        </Button>
      </div>

      {/* 주소 표시줄 */}
      <form
        onSubmit={submitAddress}
        className="flex items-center gap-1 border-b px-2 py-1.5"
      >
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_back")}
          disabled={!activeId}
          aria-label="뒤로"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_forward")}
          disabled={!activeId}
          aria-label="앞으로"
        >
          <ArrowRightIcon />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_reload")}
          disabled={!activeId}
          aria-label="새로고침"
        >
          <RotateCwIcon />
        </Button>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="URL 을 입력하거나 검색어를 입력하세요"
          disabled={!activeId}
          className="h-8"
          spellCheck={false}
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => nav("browser_devtools")}
          disabled={!activeId}
          aria-label="개발자도구"
          title="개발자도구 열기/닫기"
        >
          <CodeIcon />
        </Button>
      </form>

      {/* 웹뷰가 그려질 영역 — 네이티브 웹뷰가 이 위에 겹쳐서 렌더된다 */}
      <div ref={contentRef} className="relative flex-1 bg-muted/20">
        {(!inTauri || tabs.length === 0) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">
            {inTauri
              ? "‘+’ 를 눌러 새 탭을 여세요."
              : "브라우저 기능은 Tauri 앱(bun run tauri dev)에서만 동작합니다."}
          </div>
        )}
      </div>
    </div>
  )
}
