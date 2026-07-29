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
import { useTabActive } from "@/lib/use-tab-active"
import { useWebviewBounds } from "@/lib/use-webview-bounds"
import { cn } from "@/lib/utils"
import { labelFor, normalizeUrl, useBrowser } from "./use-browser"

// isTauri 는 함수이므로 한 번 호출해 boolean 으로 둔다 (Tauri 앱 안에서 실행 중인지).
const inTauri = isTauri()

export function BrowserView() {
  const { tabs, activeId, setActiveId, addTab, removeTab, setTabUrl } =
    useBrowser()

  // 이 뷰가 보이는 탭인지(숨은 동안 네이티브 웹뷰도 같이 숨겨야 한다).
  const tabActive = useTabActive()

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
    if (!inTauri || !rect || !tabActive) return
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
  }, [activeId, rect, tabs, tabActive])

  // 다른 메뉴 탭으로 넘어가면(뷰는 그대로 마운트돼 있다) 네이티브 웹뷰를 숨긴다.
  // 웹뷰는 창 위에 겹쳐 그려지므로 CSS 로 감춰지지 않는다 — 숨기지 않으면 다른 화면을 덮는다.
  // 웹뷰 자체는 살려 두므로 돌아왔을 때 페이지가 그대로 남아 있다.
  useEffect(() => {
    if (!inTauri || tabActive) return
    for (const t of tabsRef.current) {
      void trackedInvoke("browser_hide", { label: labelFor(t.id) })
    }
  }, [tabActive])

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
    <div className="flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 탭 스트립 — Slack 밑줄 탭(배경 채움 없이 활성 탭만 굵은 글자 + 2px 밑줄) */}
      <div className="flex h-(--ui-tabbar-h) shrink-0 items-stretch gap-1 overflow-x-auto border-b border-ui-tab-border px-2">
        {tabs.map((t) => {
          const active = t.id === activeId
          return (
            <div
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={cn(
                "group relative flex max-w-[200px] min-w-0 cursor-pointer items-center gap-1.5 px-2.5 text-[15px] whitespace-nowrap transition-colors",
                active
                  ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                  : "text-ui-tab-inactive-fg hover:text-foreground"
              )}
            >
              <GlobeIcon className="size-4 shrink-0" />
              <span className="flex-1 truncate">{t.title || "새 탭"}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
                aria-label="탭 닫기"
                className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 transition-colors group-hover:opacity-100 hover:bg-ui-list-hover"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          )
        })}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => addTab()}
          aria-label="새 탭"
          className="mx-1 shrink-0 self-center rounded-lg"
        >
          <PlusIcon />
        </Button>
      </div>

      {/* 주소 표시줄 — 주소창은 상단바 검색과 같은 알약 모양으로 맞춘다. */}
      <form
        onSubmit={submitAddress}
        className="flex h-(--ui-breadcrumb-h) shrink-0 items-center gap-1.5 border-b border-border px-3"
      >
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => nav("browser_back")}
          disabled={!activeId}
          aria-label="뒤로"
          className="rounded-lg"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => nav("browser_forward")}
          disabled={!activeId}
          aria-label="앞으로"
          className="rounded-lg"
        >
          <ArrowRightIcon />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => nav("browser_reload")}
          disabled={!activeId}
          aria-label="새로고침"
          className="rounded-lg"
        >
          <RotateCwIcon />
        </Button>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="URL 을 입력하거나 검색어를 입력하세요"
          disabled={!activeId}
          className="ui-selectable h-8 rounded-full px-3.5 text-[15px]"
          spellCheck={false}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => nav("browser_devtools")}
          disabled={!activeId}
          aria-label="개발자도구"
          title="개발자도구 열기/닫기"
          className="rounded-lg"
        >
          <CodeIcon />
        </Button>
      </form>

      {/* 웹뷰가 그려질 영역 — 네이티브 웹뷰가 이 위에 겹쳐서 렌더된다 */}
      <div ref={contentRef} className="relative flex-1 bg-background">
        {(!inTauri || tabs.length === 0) && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-[15px] text-muted-foreground">
            {inTauri
              ? "‘+’ 를 눌러 새 탭을 여세요."
              : "브라우저 기능은 Tauri 앱(bun run tauri dev)에서만 동작합니다."}
          </div>
        )}
      </div>
    </div>
  )
}
