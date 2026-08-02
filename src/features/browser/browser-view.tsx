import { useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { info } from "@tauri-apps/plugin-log"
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
import { useSettings } from "@/features/settings/settings-context"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"
import { useWebviewsSuppressed } from "@/lib/webview-overlay"
import { useWebviewBounds } from "@/lib/use-webview-bounds"
import { cn } from "@/lib/utils"
import { labelFor, normalizeUrl, useBrowser } from "./use-browser"

// isTauri 는 함수이므로 한 번 호출해 boolean 으로 둔다 (Tauri 앱 안에서 실행 중인지).
const inTauri = isTauri()

/** 안 보는 탭을 회수할 때가 됐는지 검사하는 주기(ms). */
const DISCARD_TICK_MS = 30_000

export function BrowserView() {
  const { tabs, activeId, setActiveId, addTab, removeTab, setTabUrl } =
    useBrowser()

  // 이 뷰가 보이는 탭인지(숨은 동안 네이티브 웹뷰도 같이 숨겨야 한다).
  const tabActive = useTabActive()
  // 웹뷰 위에 HTML 오버레이(탭 목록 드롭다운 등)가 떠 있으면 잠시 비켜 준다.
  const suppressed = useWebviewsSuppressed()
  // 웹뷰를 실제로 화면에 보여야 하는 조건 — 활성 탭이면서 오버레이에 가려지지 않을 때만.
  const visible = tabActive && !suppressed

  const contentRef = useRef<HTMLDivElement>(null)
  // 네이티브 웹뷰를 겹쳐 그릴 영역(레이아웃이 안정되기 전에는 null).
  const rect = useWebviewBounds(contentRef)

  // ── 메모리 회수 ───────────────────────────────────────────────────────────
  // 탭 하나가 WKWebView 하나이고, 그것이 곧 WebContent 프로세스 하나(요즘 페이지는
  // 200~400MB)다. 숨기는 것만으로는 프로세스가 사라지지 않으므로, 오래 안 본 탭은
  // 웹뷰를 닫고 탭 목록에만 남긴다 — 다시 누르면 저장해 둔 URL 로 새로 연다.
  const { settings } = useSettings()
  const discardMinutes = settings.browser.discardMinutes

  // 웹뷰가 살아 있는 탭 → 마지막으로 '보고 있던' 시각(ms). 여기 없으면 웹뷰도 없다는 뜻
  // (앱을 새로 켠 직후도 그러하며, 그래서 처음에는 활성 탭 하나만 로드된다).
  const liveRef = useRef(new Map<string, number>())
  // 탭 목록에 "해제됨"으로 표시할 탭들.
  const [discarded, setDiscarded] = useState<string[]>([])

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
    if (!inTauri || !rect || !visible) return
    const active = tabs.find((t) => t.id === activeId)
    if (active) {
      // 웹뷰가 (다시) 살아난 시각. 회수 타이머가 이 값을 기준으로 경과를 잰다.
      liveRef.current.set(active.id, Date.now())
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
  }, [activeId, rect, tabs, visible])

  // 다른 메뉴 탭으로 넘어가거나 웹뷰 위에 오버레이가 뜨면 네이티브 웹뷰를 숨긴다.
  // 웹뷰는 창 위에 겹쳐 그려지므로 CSS 로 감춰지지 않는다 — 숨기지 않으면 다른 화면(과
  // 그 위 드롭다운)을 덮는다. 웹뷰 자체는 살려 두므로 돌아왔을 때 페이지가 그대로 남아 있다.
  useEffect(() => {
    if (!inTauri || visible) return
    for (const t of tabsRef.current) {
      void trackedInvoke("browser_hide", { label: labelFor(t.id) })
    }
  }, [visible])

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

  // 브라우저 메뉴 탭 자체를 닫으면 모든 탭의 메모리를 즉시 회수한다(웹뷰 껍데기는 남긴다 —
  // 닫아 봐야 메모리가 돌아오지 않는 이유는 Rust 쪽 `browser_discard` 주석 참고).
  // 숨기기만 하면 보이지도 않는 페이지들이 탭당 수백 MB 를 계속 쥐고 있고, 메뉴를 닫았다는
  // 건 당분간 안 보겠다는 뜻이다. 다시 열면 활성 탭이 저장된 주소로 되살아난다.
  useEffect(() => {
    if (!inTauri) return
    const live = liveRef.current
    return () => {
      for (const t of tabsRef.current) {
        void trackedInvoke("browser_discard", { label: labelFor(t.id) })
      }
      live.clear()
    }
  }, [])

  // 창이 포커스를 잃으면(= 다른 앱을 쓰는 중) 브라우저도 '안 보는' 것으로 센다.
  //
  // **이것을 `visible` 에 섞으면 안 된다.** `visible` 은 네이티브 웹뷰를 화면에 그릴지
  // 여부라서, 포커스를 잃을 때마다 웹뷰가 숨어 창을 옆에 두고 쓰는 게 불가능해진다.
  // 회수 판정에만 쓴다 — 트레이 상주 앱이라 브라우저 탭을 켠 채 다른 앱을 쓰는 시간이
  // 대부분이고, 그때가 정확히 메모리를 돌려받아야 할 때다.
  const [windowFocused, setWindowFocused] = useState(true)
  useEffect(() => {
    if (!inTauri) return
    const win = getCurrentWindow()
    void win.isFocused().then(setWindowFocused)
    const unlisten = win.onFocusChanged(({ payload }) =>
      setWindowFocused(payload)
    )
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [])

  // 타이머 콜백에서 '지금 무엇을 보고 있는지'를 알기 위한 ref. 의존성으로 넣으면 탭을
  // 옮길 때마다 타이머가 리셋돼 경과 시간이 영영 차지 않는다.
  const watchingRef = useRef<string | null>(null)
  useEffect(() => {
    watchingRef.current = visible && windowFocused ? activeId : null
  })

  // 오래 안 본 탭 회수. **다른 메뉴 탭에 가 있는 동안에도 돌아야 한다** — 그때가 바로
  // 회수할 때라서, useTabActive() 로 막는 다른 주기 작업들과 목적이 정반대다.
  useEffect(() => {
    if (!inTauri || discardMinutes <= 0) return
    const limit = discardMinutes * 60_000
    const timer = setInterval(() => {
      const now = Date.now()
      const watching = watchingRef.current
      const dead: string[] = []
      for (const [id, seenAt] of liveRef.current) {
        // 보고 있는 탭은 시계를 계속 되감는다.
        if (id === watching) liveRef.current.set(id, now)
        else if (now - seenAt >= limit) dead.push(id)
      }
      if (dead.length === 0) return
      // 왜 회수됐는지 나중에 로그만 보고 알 수 있게 남긴다(회수는 눈에 잘 안 띈다).
      void info(
        `[browser] ${discardMinutes}분 넘게 안 본 탭 ${dead.length}개 회수 ` +
          `(보는 중: ${watching?.slice(0, 8) ?? "없음"})`
      )
      for (const id of dead) {
        liveRef.current.delete(id)
        // 웹뷰를 닫는 게 아니라 그 페이지의 프로세스를 죽인다 — 닫으면 메모리는 그대로면서
        // 다음에 웹뷰가 하나 더 생긴다(Rust 쪽 `browser_discard` 주석).
        void trackedInvoke("browser_discard", { label: labelFor(id) })
      }
      setDiscarded((prev) => [
        ...prev,
        ...dead.filter((id) => !prev.includes(id)),
      ])
    }, DISCARD_TICK_MS)
    return () => clearInterval(timer)
  }, [discardMinutes])

  // 회수된 활성 탭을 다시 볼 때 되살린다.
  //
  // 위의 배치 이펙트만으로는 부족하다. 브라우저 메뉴 탭을 켜 둔 채 다른 앱을 쓰면
  // `visible` 은 계속 true 인 채로 활성 탭이 회수되는데(그게 이 기능의 핵심 시나리오다),
  // 그때 돌아오면서 바뀌는 값은 `windowFocused` 뿐이라 배치 이펙트는 다시 돌지 않는다.
  // 그렇다고 `windowFocused` 를 그쪽 의존성에 넣으면 포커스를 **잃는** 순간에도 이펙트가
  // 돌아 방금 회수한 탭을 도로 살려 버린다. 그래서 "죽은 활성 탭을 볼 때만" 여는 이펙트를
  // 따로 둔다 — 되살릴 게 없으면(liveRef 에 있으면) 아무 일도 하지 않는다.
  useEffect(() => {
    if (!inTauri || !rect || !visible || !windowFocused || !activeId) return
    if (liveRef.current.has(activeId)) return
    const active = tabs.find((t) => t.id === activeId)
    if (!active) return
    liveRef.current.set(active.id, Date.now())
    void trackedInvoke("browser_open", {
      label: labelFor(active.id),
      url: active.url,
      ...rect,
    })
  }, [activeId, rect, tabs, visible, windowFocused])

  // 해제됐던 탭이 다시 화면에 올라오면 표시를 지운다 — 렌더 중 상태 조정
  // (실제 재생성은 바로 위 되살리기 이펙트가 하므로 조건도 그쪽과 같아야 한다).
  if (visible && windowFocused && activeId && discarded.includes(activeId)) {
    setDiscarded(discarded.filter((id) => id !== activeId))
  }

  const closeTab = (id: string) => {
    if (inTauri) void trackedInvoke("browser_close", { label: labelFor(id) })
    liveRef.current.delete(id)
    setDiscarded((prev) => prev.filter((x) => x !== id))
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
          // 메모리 회수로 페이지를 닫아 둔 탭 — 눌러야 다시 불러온다.
          const released = discarded.includes(t.id)
          return (
            <div
              key={t.id}
              onClick={() => setActiveId(t.id)}
              title={
                released
                  ? `메모리 해제됨 — 누르면 다시 불러옵니다\n${t.url}`
                  : t.url
              }
              className={cn(
                "group relative flex max-w-[200px] min-w-0 cursor-pointer items-center gap-1.5 px-2.5 text-[15px] whitespace-nowrap transition-colors",
                active
                  ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                  : "text-ui-tab-inactive-fg hover:text-foreground"
              )}
            >
              <GlobeIcon
                className={cn("size-4 shrink-0", released && "opacity-40")}
              />
              <span className={cn("flex-1 truncate", released && "opacity-55")}>
                {t.title || "새 탭"}
              </span>
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
