import * as React from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react"

import { PIN_DROP_ATTR } from "@/components/shell/activity-bar"
import {
  FloatingMenu,
  FloatingMenuItem,
} from "@/components/shell/floating-menu"
import { useSettings } from "@/features/settings/settings-context"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useMenuOrder } from "@/lib/use-menu-order"
import { usePinnedMenus } from "@/lib/use-pinned-menus"
import { cn } from "@/lib/utils"
import { unsupportedReason, type MenuItem } from "@/menus"

/** 사이드바 폭(px) — 저장 키와 허용 범위. */
const WIDTH_KEY = "myspace.sidebarWidth"
const DEFAULT_WIDTH = 260
const MIN_WIDTH = 200
const MAX_WIDTH = 520

/** 섹션(그룹) 접힘 상태 저장 키. true = 접힘. */
const SECTIONS_KEY = "myspace.sidebarSections"

/**
 * 내비 항목 한 줄 공통 클래스. Slack 사이드바는 28px 높이의 8px 라운드 알약이고
 * 활성 항목만 와인색으로 채워진다(좌우 6px 여백 때문에 폭을 그만큼 줄인다).
 *
 * `nested` 는 섹션(그룹) 아래에 딸린 항목이다. 왼쪽 여백을 섹션 헤더의
 * `px-3`(0.75rem) + 셰브론(1rem) + `gap-1.5`(0.375rem) = 2.125rem 으로 맞춰서
 * 항목 아이콘이 섹션 제목 글자와 같은 x 에 오도록 들여쓴다 — 이 값이 없으면 아이콘이
 * 셰브론보다 왼쪽에 놓여 중첩이 아니라 형제 항목처럼 보인다.
 */
function rowClass(active: boolean, nested = false) {
  return cn(
    "mx-1.5 flex h-(--ui-row-h) w-[calc(100%-0.75rem)] cursor-pointer items-center gap-2 rounded-lg pr-2 text-left text-[15px] transition-colors",
    nested ? "pl-[2.125rem]" : "pl-2",
    active
      ? "bg-ui-list-active font-bold text-ui-list-active-fg"
      : "hover:bg-ui-list-hover"
  )
}

/** 우클릭 메뉴 위치와 대상. */
interface MenuState {
  x: number
  y: number
  item: MenuItem
  pinned: boolean
}

interface SideBarProps {
  /** 활성 탭 id(트리에서 강조). */
  activeId: string
  /** 항목 클릭 → 탭 열기. */
  onSelectMenu: (id: string) => void
}

/**
 * Slack 채널 사이드바.
 *
 * 라벤더 크롬 위에 얹힌 흰 패널처럼 보이도록 좌상단만 라운드를 준다. 헤더는 17px bold
 * 워크스페이스명이고, 그 아래 그룹(섹션) 트리를 그린다.
 * 항목은 그룹 안에서 드래그로 재정렬 가능하고(순서는 `use-menu-order` 가 localStorage 에 저장),
 * 왼쪽 레일로 끌어다 놓으면 바로가기로 꽂힌다(`use-pinned-menus`).
 * 우측 끝 4px 는 폭 조절 핸들이다(폭도 localStorage 에 저장).
 */
export function SideBar({ activeId, onSelectMenu }: SideBarProps) {
  const { groups: allGroups, moveItem } = useMenuOrder()
  const { isPinned, pin, toggle, setDragMenuId } = usePinnedMenus()
  const { settings } = useSettings()
  const [width, setWidth] = useLocalStorage<number>(WIDTH_KEY, DEFAULT_WIDTH)
  const [sections, setSections] = useLocalStorage<Record<string, boolean>>(
    SECTIONS_KEY,
    {}
  )
  const [menu, setMenu] = React.useState<MenuState | null>(null)

  // 설정 → 메뉴 설정에서 끈 그룹·메뉴는 트리에서 뺀다. 항목이 하나도 남지 않은 그룹은
  // 제목만 남아 빈 섹션이 되므로 그룹째 감춘다.
  const { hiddenGroups, hiddenItems } = settings.menus
  const groups = allGroups
    .filter((g) => !hiddenGroups.includes(g.id))
    .map((g) => ({
      ...g,
      items: g.items.filter((m) => !hiddenItems.includes(m.id)),
    }))
    .filter((g) => g.items.length > 0)

  // 드래그 중인 항목과 그룹, 드롭 대상 표시용 상태. groupId 로 같은 그룹 안에서만 재정렬.
  // dropAt.before = 대상 항목의 위쪽 절반(= 그 앞에 넣기), false = 아래쪽 절반(= 뒤에 넣기).
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dragGroup, setDragGroup] = React.useState<string | null>(null)
  const [dropAt, setDropAt] = React.useState<{
    id: string
    before: boolean
  } | null>(null)

  // pointerdown 부터 threshold 이상 움직이면 드래그로 간주, 아니면 클릭(=탭 열기)으로 처리한다.
  // WKWebView(Tauri)에서 HTML5 draggable 이 동작하지 않으므로 pointer 이벤트로 직접 구현한다.
  const DRAG_THRESHOLD = 4
  const startItemDrag = (
    e: React.PointerEvent,
    itemId: string,
    groupId: string
  ) => {
    // macOS 의 ctrl+클릭은 왼쪽 버튼으로 들어오면서 contextmenu 도 낸다 — 걸러 내지
    // 않으면 우클릭 메뉴를 띄우면서 탭까지 열린다.
    if (e.button !== 0 || e.ctrlKey) return
    const startX = e.clientX
    const startY = e.clientY
    let started = false

    // 포인터 아래에 있는 같은 그룹의 대상 행을 찾아 { id, before } 를 돌려준다.
    const targetAt = (x: number, y: number) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-menu-item]")
      if (!row) return null
      const targetId = row.dataset.menuItem
      if (!targetId || targetId === itemId || row.dataset.menuGroup !== groupId)
        return null
      const rect = row.getBoundingClientRect()
      return { id: targetId, before: y < rect.top + rect.height / 2 }
    }

    /** 포인터가 왼쪽 레일 위에 있으면 true(= 놓으면 바로가기로 꽂힌다). */
    const overRail = (x: number, y: number) =>
      !!document.elementFromPoint(x, y)?.closest(`[${PIN_DROP_ATTR}]`)

    const onMove = (ev: PointerEvent) => {
      if (
        !started &&
        Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
        Math.abs(ev.clientY - startY) < DRAG_THRESHOLD
      )
        return
      if (!started) {
        started = true
        setDragId(itemId)
        setDragGroup(groupId)
        // 레일이 "여기에 고정" 자리를 띄우도록 알린다.
        setDragMenuId(itemId)
        document.body.style.userSelect = "none"
      }
      setDropAt(targetAt(ev.clientX, ev.clientY))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      if (!started) {
        // 움직이지 않았으면 클릭으로 간주해 탭을 연다.
        onSelectMenu(itemId)
      } else if (overRail(ev.clientX, ev.clientY)) {
        // 레일 위에 놓았으면 순서 변경이 아니라 바로가기 고정이다.
        pin(itemId)
      } else {
        const target = targetAt(ev.clientX, ev.clientY)
        if (target) moveItem(groupId, itemId, target.id, target.before)
      }
      setDragId(null)
      setDragGroup(null)
      setDropAt(null)
      setDragMenuId(null)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  // 폭 조절: pointerdown 으로 시작하고, 이동/종료는 window 에서 듣는다(핸들 밖으로 나가도 유지).
  const [resizing, setResizing] = React.useState(false)
  const dragOrigin = React.useRef({ x: 0, width: DEFAULT_WIDTH })

  React.useEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => {
      const next = dragOrigin.current.width + (e.clientX - dragOrigin.current.x)
      setWidth(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))))
    }
    const onUp = () => setResizing(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    // 드래그 중 텍스트가 선택되는 것을 막는다.
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = prevSelect
    }
  }, [resizing, setWidth])

  const toggleSection = (groupId: string) => {
    setSections((prev) => ({ ...prev, [groupId]: !prev[groupId] }))
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col rounded-tl-[var(--ui-panel-radius)] border-r border-sidebar-border bg-sidebar text-sidebar-foreground select-none"
      style={{ width }}
    >
      {/* 워크스페이스 헤더 */}
      <div className="flex h-(--ui-sidebar-header-h) shrink-0 items-center gap-1 px-3">
        <span className="truncate text-[17px] font-bold">My Space</span>
        <ChevronDownIcon className="size-4 shrink-0" />
        <button
          type="button"
          aria-label="추가 작업"
          className="ml-auto flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-ui-list-hover"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pt-1 pb-2">
        {groups.map((group) => {
          const isFolded = sections[group.id] === true
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggleSection(group.id)}
                className="mx-1.5 flex h-7 w-[calc(100%-0.75rem)] cursor-pointer items-center gap-1.5 rounded-lg px-3 text-left text-[14px] font-semibold text-ui-section-header-fg transition-colors hover:bg-ui-list-hover"
              >
                {isFolded ? (
                  <ChevronRightIcon className="size-4 shrink-0" />
                ) : (
                  <ChevronDownIcon className="size-4 shrink-0" />
                )}
                {/* label 이 null 인 그룹(general)도 섹션 구조를 맞추려고 "일반"으로 표시한다. */}
                <span className="truncate">{group.label ?? "일반"}</span>
              </button>

              {!isFolded &&
                group.items.map((m) => {
                  const Icon = m.icon
                  const isDragging = dragId === m.id
                  // 이 OS 에서 못 쓰는 메뉴: 아이콘·이름만 흐리게 하고 "사용불가" 칩을
                  // 붙인다. 행 전체에 opacity 를 주면 활성 상태(와인색 알약)일 때
                  // 칩까지 같이 옅어져 읽기 어려워진다.
                  const blocked = unsupportedReason(m)
                  // 같은 그룹의 다른 항목 위에 있을 때만 삽입 위치를 그린다.
                  const drop =
                    dragGroup === group.id && dropAt?.id === m.id && !isDragging
                      ? dropAt
                      : null
                  return (
                    // WKWebView(Tauri)에서는 HTML5 draggable 이벤트가 잘 발생하지
                    // 않아 pointer 이벤트로 직접 재정렬한다(폭 조절 핸들과 동일한 방식).
                    // data-menu-* 로 포인터 아래의 대상 행을 elementFromPoint 로 찾는다.
                    <div
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      data-menu-item={m.id}
                      data-menu-group={group.id}
                      onPointerDown={(e) => startItemDrag(e, m.id, group.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        setMenu({
                          x: e.clientX,
                          y: e.clientY,
                          item: m,
                          pinned: isPinned(m.id),
                        })
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return
                        e.preventDefault()
                        onSelectMenu(m.id)
                      }}
                      className={cn(
                        rowClass(activeId === m.id, true),
                        "relative touch-none select-none",
                        isDragging && "opacity-40",
                        // 드롭 위치는 알약 폭에 맞춘 2px 둥근 선으로 표시한다.
                        drop &&
                          "before:absolute before:inset-x-0 before:h-0.5 before:rounded-full before:bg-ui-selection",
                        drop &&
                          (drop.before ? "before:-top-px" : "before:-bottom-px")
                      )}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          blocked && "opacity-55"
                        )}
                      />
                      <span className={cn("truncate", blocked && "opacity-55")}>
                        {m.title}
                      </span>
                      {/* 사용불가일 때는 안 읽음 배지 자리를 칩이 가져간다 — 어차피
                            데이터가 오지 않으므로 둘을 같이 띄울 이유가 없다. */}
                      {blocked ? (
                        <span
                          title={blocked}
                          className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[11px] font-bold text-muted-foreground"
                        >
                          사용불가
                        </span>
                      ) : (
                        // 배지와 "레일에 꽂힘" 표시를 한 상자에 담아 오른쪽 끝으로 민다.
                        // 둘 다 ml-auto 를 쓰면 남는 공간을 나눠 가져 핀이 가운데로 뜬다.
                        <span className="ml-auto flex shrink-0 items-center gap-1">
                          {m.badge}
                          {isPinned(m.id) && (
                            <PinIcon className="size-3 shrink-0 opacity-45" />
                          )}
                        </span>
                      )}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>

      {menu && (
        <FloatingMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.title}
          onClose={() => setMenu(null)}
        >
          <FloatingMenuItem
            icon={menu.pinned ? PinOffIcon : PinIcon}
            label={menu.pinned ? "왼쪽 레일에서 빼기" : "왼쪽 레일에 고정"}
            onClick={() => {
              setMenu(null)
              toggle(menu.item.id)
            }}
          />
        </FloatingMenu>
      )}

      {/* 폭 조절 핸들 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="사이드바 너비 조절"
        onPointerDown={(e) => {
          e.preventDefault()
          dragOrigin.current = { x: e.clientX, width }
          setResizing(true)
        }}
        className={cn(
          "absolute inset-y-0 -right-[2px] z-10 w-[4px] cursor-col-resize transition-colors hover:bg-ui-selection/60",
          resizing && "bg-ui-selection/60"
        )}
      />
    </aside>
  )
}
