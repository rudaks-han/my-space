import type { PointerEvent } from "react"

import { cn } from "@/lib/utils"

/**
 * 패널 오른쪽 끝의 폭 조절 손잡이. `useResizableWidth` 와 짝으로 쓴다.
 *
 * 부모 패널은 `relative` 여야 하고, 패널과 본문 사이 12px(`gap-3`) 간격 가운데에
 * 놓이도록 `-right-2` 로 살짝 밀어 둔다 — 패널 안쪽에 두면 내용과 겹쳐 보인다.
 */
export function ResizeHandle({
  resizing,
  onPointerDown,
  label,
}: {
  resizing: boolean
  onPointerDown: (e: PointerEvent) => void
  /** 스크린리더용 설명 (예: "토픽 목록 폭 조절"). */
  label: string
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 -right-2 z-10 w-[4px] cursor-col-resize rounded-full transition-colors hover:bg-ui-selection/60",
        resizing && "bg-ui-selection/60"
      )}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
    />
  )
}
