import * as React from "react"

import type { MenuIcon } from "@/menus"
import { cn } from "@/lib/utils"

/** 화면 가장자리에서 메뉴가 잘리지 않도록 남겨 두는 여백(px). */
const EDGE = 8

/**
 * 마우스 좌표에 뜨는 작은 우클릭 메뉴. 바깥 클릭·스크롤·Esc 면 닫힌다.
 * (사이드바 항목과 레일 아이콘이 같은 메뉴 모양을 쓰도록 셸 공용으로 둔다.)
 */
export function FloatingMenu({
  x,
  y,
  title,
  onClose,
  children,
}: {
  x: number
  y: number
  /** 메뉴 위에 붙는 대상 이름. 어떤 항목을 눌렀는지 확인시켜 준다. */
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState({ x, y })

  // 실제 크기를 재서 화면 안으로 밀어 넣는다(레일 아래쪽에서 우클릭하면 그냥 두면 잘린다).
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos({
      x: Math.min(x, window.innerWidth - el.offsetWidth - EDGE),
      y: Math.min(y, window.innerHeight - el.offsetHeight - EDGE),
    })
  }, [x, y])

  React.useEffect(() => {
    /*
     * 바깥 클릭·스크롤·Esc 면 닫는다. **메뉴 안에서 시작한 mousedown 은 `ref.contains` 로
     * 걸러야 한다** — 아래 div 에서 `stopPropagation()` 하는 것으로는 막을 수 없다.
     * capture 는 `document` 에서 시작하고 React 의 합성 핸들러는 루트 컨테이너의 bubble
     * 단계에 붙으므로 이 리스너가 항상 먼저 돌고, 그러면 항목을 누르는 순간 메뉴가
     * 언마운트되어 버튼이 사라진다 — `click` 이 발생하지 않아 아무것도 실행되지 않는다.
     */
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("mousedown", close, true)
    document.addEventListener("scroll", close, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", close, true)
      document.removeEventListener("scroll", close, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-48 overflow-hidden rounded-[10px] border border-border bg-popover py-1 text-popover-foreground shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="truncate px-3 py-1 text-[11px] font-bold text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  )
}

/** 우클릭 메뉴 한 줄. */
export function FloatingMenuItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon?: MenuIcon
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left text-[13px] hover:bg-ui-list-hover",
        danger && "text-ui-error"
      )}
      onClick={onClick}
    >
      {Icon && <Icon className="size-4 shrink-0" />}
      {label}
    </button>
  )
}
