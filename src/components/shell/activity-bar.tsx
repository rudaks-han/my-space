import * as React from "react"
import {
  MoonIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  SunIcon,
} from "lucide-react"

import { useIsDark, useTheme } from "@/components/theme-provider"
import {
  FloatingMenu,
  FloatingMenuItem,
} from "@/components/shell/floating-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useSettings } from "@/features/settings/settings-context"
import { usePinnedMenus } from "@/lib/use-pinned-menus"
import { cn } from "@/lib/utils"
import { MENUS, hiddenMenuIds, unsupportedReason, type MenuItem } from "@/menus"

/** 사이드바에서 끌어온 항목을 레일이 받아 주는 영역 표시(드롭 판정에 쓰는 속성 이름). */
export const PIN_DROP_ATTR = "data-pin-drop"

/** 클릭과 드래그를 가르는 이동 거리(px) — 사이드바 항목 드래그와 같은 값. */
const DRAG_THRESHOLD = 4

interface ActivityBarProps {
  /** 하단 톱니 클릭 → 설정 탭 열기. */
  onOpenSettings: () => void
  /** 설정 탭이 활성인지. */
  settingsActive: boolean
  /** 활성 탭 id — 레일에 꽂아 둔 메뉴 중 열려 있는 것을 강조한다. */
  activeId: string
  /** 꽂아 둔 아이콘 클릭 → 그 메뉴 탭 열기. */
  onSelectMenu: (id: string) => void
}

/** 레일 하단 아이콘 버튼(라벨 없음) 공통 클래스. */
function railIconClass(active: boolean) {
  return cn(
    "flex size-9 cursor-pointer items-center justify-center rounded-[10px] transition-colors disabled:cursor-default disabled:opacity-50",
    active ? "bg-ui-chrome-active" : "hover:bg-ui-chrome-hover"
  )
}

/** 레일 항목(아이콘 타일 + 11px 라벨) 골격. */
function RailItem({
  icon: Icon,
  label,
  active,
  className,
  children,
  ...rest
}: {
  icon: MenuItem["icon"]
  label: string
  active: boolean
  className?: string
  /** 아이콘 타일 위에 겹쳐 그릴 것(안 읽음 배지 등). */
  children?: React.ReactNode
  // Tooltip(base-ui)이 render 로 끼워 넣을 때 ref 도 props 로 넘어온다 —
  // ...rest 에 담겨 button 으로 그대로 전달돼야 툴팁이 위치를 잡는다(React 19).
} & React.ComponentPropsWithRef<"button">) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "group flex w-full cursor-pointer flex-col items-center gap-0.5 py-1.5 transition-colors",
        active
          ? "font-semibold text-ui-chrome-fg"
          : "text-ui-chrome-muted-fg hover:text-ui-chrome-fg",
        className
      )}
      {...rest}
    >
      <span
        className={cn(
          "relative flex size-9 items-center justify-center rounded-[10px] transition-colors",
          active ? "bg-ui-chrome-active" : "group-hover:bg-ui-chrome-hover"
        )}
      >
        <Icon className="size-5" />
        {children}
      </span>
      {/* 64px 레일에는 "Cowork 서비스" 같은 이름이 한 줄로 안 들어간다. 잘라서 "Cowork …"
          로 만드는 대신 낱말 단위로 접어 두 줄까지 보여 준다(그보다 길면 말줄임 —
          전체 이름은 툴팁이 맡는다). 낱말 하나가 줄보다 길면 그 낱말도 쪼갠다. */}
      <span className="line-clamp-2 w-full px-0.5 text-center text-[11px] leading-tight font-medium break-words">
        {label}
      </span>
    </button>
  )
}

/** 우클릭 메뉴 상태(레일에 꽂힌 아이콘 대상). */
interface PinMenuState {
  x: number
  y: number
  item: MenuItem
}

/**
 * Slack 좌측 레일(64px).
 *
 * 라벤더 크롬 위에 아이콘을 올리고 그 아래 11px 라벨을 붙이는 Slack 레일 구조다.
 * 활성 항목은 아이콘 자리에 둥근 사각 타일이 채워지고 글자가 진해진다(좌측 인디케이터 없음).
 * 위쪽은 사용자가 꽂아 둔 메뉴 바로가기이고(비어 있으면 아무것도 없다), 하단에는 Slack 의
 * 달 아이콘처럼 테마 토글을 두고 그 아래 설정을 둔다.
 *
 * 사이드바 컨테이너 아이콘("탐색기")은 없앴다 — 컨테이너가 하나뿐이라 고를 게 없었고,
 * 사이드바 접기/펴기는 타이틀 바의 토글이 맡는다.
 */
export function ActivityBar({
  onOpenSettings,
  settingsActive,
  activeId,
  onSelectMenu,
}: ActivityBarProps) {
  const { setTheme, forcedTheme } = useTheme()
  const isDark = useIsDark()
  const { settings } = useSettings()
  const { ids, unpin, move, dragMenuId } = usePinnedMenus()
  const [menu, setMenu] = React.useState<PinMenuState | null>(null)
  // 사이드바에서 끌고 온 항목이 레일 위에 올라와 있는지(놓기 자리 강조).
  const [dropHover, setDropHover] = React.useState(false)
  // 레일 안에서 아이콘을 끌어 순서를 바꾸는 중일 때의 상태.
  const [dragId, setDragId] = React.useState<string | null>(null)
  const [dropAt, setDropAt] = React.useState<{
    id: string
    before: boolean
  } | null>(null)

  // 설정에서 끈 메뉴는 레일에서도 뺀다(목록에서 지우지는 않으므로 다시 켜면 돌아온다).
  const hidden = hiddenMenuIds(
    settings.menus.hiddenGroups,
    settings.menus.hiddenItems
  )
  const pinned = ids
    .map((id) => MENUS.find((m) => m.id === id))
    .filter((m): m is MenuItem => m !== undefined && !hidden.has(m.id))

  // 사이드바에서 아직 안 꽂힌 메뉴를 끌고 오는 중이면 맨 아래에 놓기 자리를 띄운다.
  const showDropSlot = dragMenuId !== null && !ids.includes(dragMenuId)

  /**
   * 레일 안에서의 아이콘 드래그.
   * - 다른 꽂힌 아이콘 위에 놓으면 순서 변경
   * - 레일 **밖**에 놓으면 고정 해제(macOS Dock 과 같은 몸짓 — 우클릭 메뉴로도 뺄 수 있다)
   * - 움직이지 않았으면 클릭으로 보고 그 메뉴 탭을 연다
   */
  const startPinDrag = (e: React.PointerEvent, itemId: string) => {
    if (e.button !== 0 || e.ctrlKey) return
    const startX = e.clientX
    const startY = e.clientY
    let started = false

    const targetAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      const row = el?.closest<HTMLElement>("[data-pin-item]")
      if (!row) return null
      const targetId = row.dataset.pinItem
      if (!targetId || targetId === itemId) return null
      const rect = row.getBoundingClientRect()
      return { id: targetId, before: y < rect.top + rect.height / 2 }
    }

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
        document.body.style.userSelect = "none"
      }
      setDropAt(targetAt(ev.clientX, ev.clientY))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      if (!started) {
        onSelectMenu(itemId)
      } else {
        const target = targetAt(ev.clientX, ev.clientY)
        const inRail = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest(`[${PIN_DROP_ATTR}]`)
        if (target) move(itemId, target.id, target.before)
        else if (!inRail) unpin(itemId)
      }
      setDragId(null)
      setDropAt(null)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <nav
      {...{ [PIN_DROP_ATTR]: "" }}
      onPointerEnter={() => setDropHover(true)}
      onPointerLeave={() => setDropHover(false)}
      className={cn(
        "flex w-(--ui-activitybar-w) shrink-0 flex-col items-center gap-1 bg-ui-chrome pt-1.5 pb-2 text-ui-chrome-fg select-none",
        // 사이드바에서 끌고 온 항목이 레일 위에 있으면 받을 수 있다는 걸 알린다.
        showDropSlot && dropHover && "bg-ui-chrome-hover"
      )}
    >
      {/* 꽂아 둔 메뉴 — 개수가 많아지면 이 영역만 스크롤한다(하단 설정은 항상 보여야 한다). */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {pinned.map((m) => {
          const blocked = unsupportedReason(m)
          const isDragging = dragId === m.id
          const drop = dropAt?.id === m.id && !isDragging ? dropAt : null
          return (
            <Tooltip key={m.id}>
              <TooltipTrigger
                render={
                  <RailItem
                    icon={m.icon}
                    label={m.title}
                    active={activeId === m.id}
                    data-pin-item={m.id}
                    onPointerDown={(e) => startPinDrag(e, m.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, item: m })
                    }}
                    className={cn(
                      "relative touch-none",
                      isDragging && "opacity-40",
                      blocked && "opacity-55",
                      // 삽입 위치는 타일 폭에 맞춘 2px 선으로 표시한다.
                      drop &&
                        "before:absolute before:inset-x-3 before:h-0.5 before:rounded-full before:bg-ui-chrome-fg",
                      drop && (drop.before ? "before:top-0" : "before:bottom-0")
                    )}
                  >
                    {/* 사이드바에서 쓰는 안 읽음 배지를 타일 오른쪽 위에 겹친다. */}
                    {!blocked && m.badge && (
                      <span className="absolute -top-1 -right-1 flex origin-top-right scale-90 items-center">
                        {m.badge}
                      </span>
                    )}
                  </RailItem>
                }
              />
              <TooltipContent side="right">
                {blocked ? `${m.title} (이 OS 에서는 사용불가)` : m.title}
              </TooltipContent>
            </Tooltip>
          )
        })}

        {/* 사이드바에서 끌고 오는 중일 때만 나타나는 놓기 자리. */}
        {showDropSlot && (
          <div
            className={cn(
              "flex w-full flex-col items-center gap-0.5 py-1.5 text-ui-chrome-muted-fg",
              dropHover && "text-ui-chrome-fg"
            )}
          >
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-[10px] border border-dashed border-current/50",
                dropHover && "bg-ui-chrome-active"
              )}
            >
              <PinIcon className="size-5" />
            </span>
            <span className="text-[11px] leading-tight font-medium">
              여기에 고정
            </span>
          </div>
        )}
      </div>

      <div className="mt-auto flex shrink-0 flex-col items-center gap-1 pt-1">
        {/* 테마 토글 — 프리셋이 모드를 고정한 동안에는 비활성. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={forcedTheme !== undefined}
                aria-label={
                  forcedTheme
                    ? "현재 테마는 모드가 고정되어 있습니다"
                    : isDark
                      ? "라이트 모드로 전환"
                      : "다크 모드로 전환"
                }
                onClick={() => setTheme(isDark ? "light" : "dark")}
                className={railIconClass(false)}
              >
                {isDark ? (
                  <SunIcon className="size-5" />
                ) : (
                  <MoonIcon className="size-5" />
                )}
              </button>
            }
          />
          <TooltipContent side="right">
            {forcedTheme
              ? "이 테마는 다크 전용입니다"
              : isDark
                ? "라이트 모드"
                : "다크 모드"}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="설정"
                onClick={onOpenSettings}
                className={railIconClass(settingsActive)}
              >
                <SettingsIcon className="size-5" />
              </button>
            }
          />
          <TooltipContent side="right">설정</TooltipContent>
        </Tooltip>
      </div>

      {menu && (
        <FloatingMenu
          x={menu.x}
          y={menu.y}
          title={menu.item.title}
          onClose={() => setMenu(null)}
        >
          <FloatingMenuItem
            icon={PinOffIcon}
            label="레일에서 빼기"
            onClick={() => {
              setMenu(null)
              unpin(menu.item.id)
            }}
          />
        </FloatingMenu>
      )}
    </nav>
  )
}
