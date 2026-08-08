import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDownIcon, ExternalLinkIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { SETTINGS_ID } from "@/lib/use-open-tabs"
import { useTabOverflow } from "@/lib/use-tab-overflow"
import { cn } from "@/lib/utils"
import { viewHeaderAction, viewInfo, type ViewInfo } from "@/lib/view-info"
import { suppressWebviews } from "@/lib/webview-overlay"

const inTauri = isTauri()

/**
 * 현재 화면을 독립 창(`view-<id>`)으로 띄운다. 이미 그 창이 열려 있으면 Rust 가
 * 새로 만들지 않고 앞으로 가져온다.
 */
function openInNewWindow(view: ViewInfo) {
  void trackedInvoke("open_view_window", {
    id: view.id,
    title: view.title,
  }).catch((e) => {
    console.error("새 창 열기 실패:", e)
    toast.error("새 창을 열지 못했습니다.")
  })
}

interface TabBarProps {
  /** 열린 탭 id 순서. */
  openIds: string[]
  /** 활성 탭 id. */
  activeId: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** 모든 탭을 닫는다(홈만 남는다). */
  onCloseAll: () => void
  /** 드래그 재정렬 — draggedId 를 targetId 의 앞/뒤로 옮긴다. */
  onMove: (draggedId: string, targetId: string, before: boolean) => void
}

/**
 * Slack 밑줄 탭 행(42px) + 뷰 헤더(52px).
 *
 * 탭은 배경색으로 구분하지 않는다 — 활성 탭만 굵은 글자에 2px 밑줄이 붙는 Slack 방식이다.
 * 그 아래 뷰 헤더는 Slack 의 채널 헤더처럼 18px bold 제목 + 13px 그룹명을 보여준다.
 * 헤더 맨 오른쪽에는 지금 화면을 독립 창으로 띄우는 "새 창으로 열기" 버튼이 있다
 * (탭은 그대로 남는다 — 창과 탭을 나란히 볼 수 있다).
 * 닫기는 X 버튼 또는 마우스 가운데 클릭이며, 마지막 한 개는 닫을 수 없다.
 *
 * 탭은 **줄어들지 않는다**(`shrink-0` + 최소 폭) — 많이 열려도 이름이 뭉개지지 않는다.
 * 대신 행이 넘치면 IntelliJ 처럼 우측에 목록 버튼이 나타나 가려진 탭 수를 보여 주고,
 * 드롭다운에서 전체 탭을 골라 열 수 있다. 순서는 드래그로 바꿀 수 있다 — HTML5
 * drag&drop 대신 pointer 이벤트로 직접 끈다(macOS WKWebView 는 HTML5 네이티브
 * 드래그가 불안정해 탭이 안 잡히는 경우가 있다). 커서 x 좌표가 어느 탭의 좌/우
 * 절반에 있는지로 삽입 위치를 정하며, 4px 이상 움직여야 드래그로 인정한다(그 안이면
 * 그냥 탭 선택 클릭으로 처리).
 */
export function TabBar({
  openIds,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  onMove,
}: TabBarProps) {
  const tabs = openIds.map(viewInfo).filter((t): t is ViewInfo => t !== null)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  const closable = tabs.length > 1
  const ActiveIcon = active?.icon

  // 넘침 측정(가려진 탭 목록·⌄ 버튼 노출)은 IntelliJ Cowork 화면의 내부 탭 행과 공유하는
  // 훅이 맡는다. 스크롤러의 `relative` 와 `onScroll={measure}`, 그리고 ⌄ 버튼을 스크롤러
  // 밖 형제로 두는 배치가 그 훅의 계약이다 — 자세한 이유는 훅 주석에 있다.
  const { scrollRef, tabRef, nodes, overflowing, hiddenIds, measure } =
    useTabOverflow(openIds, activeId)
  // 넘침 목록 드롭다운 열림 상태. 열려 있는 동안 네이티브 웹뷰를 비켜 준다(아래 effect).
  const [listOpen, setListOpen] = useState(false)
  // 드래그 중인 탭과, 드롭선을 그릴 위치(대상 탭 id + 그 탭의 앞/뒤).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(
    null
  )
  // pointerdown 부터 pointerup 까지의 진행 상태(끌기 시작점·실제 드래그 여부).
  const pointerDrag = useRef<{
    id: string
    startX: number
    moved: boolean
  } | null>(null)

  const endDrag = useCallback(() => {
    setDragId(null)
    setDropAt(null)
  }, [])

  // 넘침 목록 드롭다운은 네이티브 웹뷰(브라우저 등) 위에 뜨는데, 웹뷰가 창 위에 겹쳐
  // 그려져 드롭다운을 덮어 버린다. 열려 있는 동안만 웹뷰 숨김을 요청한다.
  useEffect(() => {
    if (!listOpen) return
    return suppressWebviews()
  }, [listOpen])

  // 커서 x 좌표가 놓인 탭과 그 앞/뒤를 좌표로 찾는다(포인터 캡처 중이라도 좌표만 보면 된다).
  // 어떤 탭의 중앙보다 왼쪽이면 그 탭 앞, 모든 중앙을 지나쳤으면 마지막 탭 뒤에 넣는다.
  const findDropTarget = useCallback(
    (clientX: number): { id: string; before: boolean } | null => {
      let last: { id: string; before: boolean } | null = null
      for (const id of openIds) {
        const node = nodes.current.get(id)
        if (!node) continue
        const r = node.getBoundingClientRect()
        if (clientX < r.left + r.width / 2) return { id, before: true }
        last = { id, before: false }
      }
      return last
    },
    [openIds, nodes]
  )

  return (
    <div className="flex shrink-0 flex-col select-none">
      <div className="flex h-(--ui-tabbar-h) shrink-0 items-stretch border-b border-ui-tab-border bg-background">
        <div
          ref={scrollRef}
          onScroll={measure}
          className="relative flex min-w-0 flex-1 [scrollbar-width:none] items-stretch gap-1 overflow-x-auto px-3 [&::-webkit-scrollbar]:hidden"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon
            const isActive = tab.id === activeId
            return (
              <div
                key={tab.id}
                ref={tabRef(tab.id)}
                role="tab"
                aria-selected={isActive}
                tabIndex={-1}
                onAuxClick={(e) => {
                  // 마우스 가운데 클릭으로 닫기.
                  if (e.button !== 1) return
                  e.preventDefault()
                  onClose(tab.id)
                }}
                onPointerDown={(e) => {
                  // 좌클릭만, 닫기 버튼 위는 제외(그건 버튼 자체가 처리한다).
                  if (e.button !== 0) return
                  if ((e.target as HTMLElement).closest("button")) return
                  pointerDrag.current = {
                    id: tab.id,
                    startX: e.clientX,
                    moved: false,
                  }
                  // 포인터를 이 탭에 고정해 커서가 탭 밖으로 나가도 move/up 을 계속 받는다.
                  e.currentTarget.setPointerCapture(e.pointerId)
                }}
                onPointerMove={(e) => {
                  const st = pointerDrag.current
                  if (!st) return
                  if (!st.moved) {
                    // 4px 이상 움직여야 드래그로 인정(그 안이면 클릭으로 처리).
                    if (Math.abs(e.clientX - st.startX) < 4) return
                    st.moved = true
                    setDragId(st.id)
                  }
                  const target = findDropTarget(e.clientX)
                  if (target && target.id !== st.id) {
                    setDropAt((prev) =>
                      prev?.id === target.id && prev.before === target.before
                        ? prev
                        : target
                    )
                  } else {
                    setDropAt(null)
                  }
                }}
                onPointerUp={(e) => {
                  const st = pointerDrag.current
                  pointerDrag.current = null
                  if (!st) return
                  e.currentTarget.releasePointerCapture?.(e.pointerId)
                  if (st.moved) {
                    const target = findDropTarget(e.clientX)
                    if (target && target.id !== st.id)
                      onMove(st.id, target.id, target.before)
                  } else {
                    // 움직임 없이 뗐으면 그냥 탭 선택.
                    onSelect(st.id)
                  }
                  endDrag()
                }}
                onPointerCancel={() => {
                  pointerDrag.current = null
                  endDrag()
                }}
                className={cn(
                  // shrink-0: 탭이 많아도 좁아지지 않는다(넘치면 우측 목록 버튼으로 처리).
                  "group relative flex h-full max-w-[240px] min-w-[112px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2.5 text-[15px] whitespace-nowrap transition-colors hover:bg-ui-list-hover",
                  isActive
                    ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                    : "text-ui-tab-inactive-fg hover:text-foreground",
                  dragId === tab.id && "opacity-40",
                  // 드롭 위치는 탭 사이 간격에 2px 둥근 세로선으로 표시한다.
                  dropAt?.id === tab.id &&
                    "before:absolute before:inset-y-1 before:w-0.5 before:rounded-full before:bg-ui-selection",
                  dropAt?.id === tab.id &&
                    (dropAt.before ? "before:-left-1" : "before:-right-1")
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{tab.title}</span>
                {closable && (
                  <button
                    type="button"
                    aria-label={`${tab.title} 탭 닫기`}
                    data-active={isActive}
                    onClick={(e) => {
                      e.stopPropagation()
                      onClose(tab.id)
                    }}
                    // 탭 자체의 hover 색(ui-list-hover) 위에 얹히므로 한 단계 진한 색을 쓴다.
                    className="ml-auto flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 transition-colors group-hover:opacity-100 hover:bg-ui-tab-border data-[active=true]:opacity-100"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {/* 넘칠 때만 보이는 탭 목록(IntelliJ 의 탭 리스트 화살표). */}
        {overflowing && (
          <div className="flex shrink-0 items-center border-l border-ui-tab-border px-1.5">
            <DropdownMenu open={listOpen} onOpenChange={setListOpen}>
              <DropdownMenuTrigger
                aria-label="열린 탭 목록"
                title="열린 탭 목록"
                className="flex h-7 cursor-pointer items-center gap-0.5 rounded-lg px-1.5 text-ui-tab-inactive-fg transition-colors hover:bg-ui-list-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
              >
                <ChevronDownIcon className="size-4" />
                {hiddenIds.length > 0 && (
                  <span className="text-[11px] font-bold">
                    {hiddenIds.length}
                  </span>
                )}
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-auto max-w-[340px] min-w-[220px]"
              >
                {tabs.map((tab) => {
                  const Icon = tab.icon
                  const isActive = tab.id === activeId
                  return (
                    <DropdownMenuItem
                      key={tab.id}
                      onClick={() => onSelect(tab.id)}
                      className={cn(isActive && "font-bold")}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="truncate">{tab.title}</span>
                      {tab.id !== SETTINGS_ID && (
                        <span className="ml-auto shrink-0 pl-3 text-[13px] font-normal text-muted-foreground group-focus/dropdown-menu-item:text-ui-list-active-fg group-data-highlighted/dropdown-menu-item:text-ui-list-active-fg">
                          {tab.group}
                        </span>
                      )}
                    </DropdownMenuItem>
                  )
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onCloseAll}>
                  <XIcon className="size-4 shrink-0" />
                  <span>모두 닫기</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      {/* 뷰 헤더 — Slack 채널 헤더 톤(굵은 제목 + 옅은 그룹명) + 우측 액션. */}
      <div className="flex h-(--ui-breadcrumb-h) shrink-0 items-center gap-2 border-b border-ui-tab-border px-5">
        {active && ActiveIcon && (
          <>
            <ActiveIcon className="size-[18px] shrink-0" />
            <span className="truncate text-[18px] font-bold tracking-[-0.01em]">
              {active.title}
            </span>
            {active.id !== SETTINGS_ID && (
              <span className="truncate text-[13px] text-muted-foreground">
                {active.group}
              </span>
            )}
            {/* 화면별 버튼(예: IntelliJ Cowork 의 다크 모드) — 어느 화면이 무엇을 내는지는
                레지스트리가 정한다(`viewHeaderAction`). 오른쪽의 새 창 버튼과 달리 제목
                옆에 있는 것은 창이 아니라 **그 화면의 상태**를 다루기 때문이다. */}
            {viewHeaderAction(active.id)}
            {inTauri && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto shrink-0"
                      aria-label={`${active.title} 새 창으로 열기`}
                      onClick={() => openInNewWindow(active)}
                    >
                      <ExternalLinkIcon />
                    </Button>
                  }
                />
                <TooltipContent>새 창으로 열기</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  )
}
