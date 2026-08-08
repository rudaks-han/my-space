import type { PointerEvent } from "react"

import { cn } from "@/lib/utils"

/**
 * **흐름 안에 들어가는** 분할선. `useResizableWidth` / `useResizableHeight` 와 짝으로 쓴다.
 *
 * `ResizeHandle`(`absolute`, 패널 바깥 3~7px)과 무엇이 다른가: 이쪽은 진짜 flex 자식이라
 * **경계선 자리를 자기가 차지한다.** 그래서 잡히는 영역이 곧 눈에 보이는 것이고,
 * "부모에 `gap-3` 이 있어야 간격 가운데에 떨어진다"는 암묵적 계약도, 넘침에 잘릴 위험도,
 * z-index 경쟁도 없다. 간격 없이 실선으로 딱 붙은 레이아웃(IntelliJ Cowork 의 3분할, `gap-2`
 * 인 서비스 독)에서 절대 배치 손잡이는 보이는 선과 몇 px 어긋난 채 이웃 내용 위에 놓여
 * 선을 겨냥할수록 빗나갔다 — 그 자리를 이 컴포넌트가 대신한다. 이미 잘 동작하던
 * `intellij-http-view` 의 인라인 분할선을 그대로 컴포넌트로 뽑은 것이다.
 *
 * ## 계약
 * - flex 자식이므로 **부모에 `gap` 을 주지 않는다** — 이 바가 곧 간격이다. `gap` 이
 *   있으면 바 양옆에 죽은 여백이 생겨 다시 겨냥이 어려워진다.
 * - **이웃 패널의 `border-r` / `border-t` 는 뺀다** — 이 바가 그 구분선이다. 남겨 두면
 *   선이 두 줄로 보인다.
 * - 쉬는 상태에서도 **보여야 한다**(경계선을 대신하므로 `bg-border`). 마우스를 올리면
 *   `bg-ui-selection/60`, 끄는 동안은 `bg-ui-selection` 으로 진해진다.
 * - `onDoubleClick`(접기/기본값 복귀)은 넣지 않았다 — 필요한 화면에서 `className` 이
 *   아니라 감싸는 쪽에서 붙이거나, 여기에 명시적으로 추가할 것.
 *
 * `orientation` 은 **선의 방향**이다(`aria-orientation` 과 같은 뜻):
 * - `"vertical"` = 좌우로 끄는 **열** 구분선 → 폭 5px, `cursor-col-resize`
 * - `"horizontal"` = 위아래로 끄는 **행** 구분선 → 높이 5px, `cursor-row-resize`
 */
export function SplitBar({
  orientation,
  resizing,
  onPointerDown,
  label,
  className,
}: {
  /** 선의 방향. 좌우로 끄는 열 구분선이면 `"vertical"`. */
  orientation: "vertical" | "horizontal"
  resizing: boolean
  onPointerDown: (e: PointerEvent) => void
  /** 스크린리더용 설명 (예: "서비스 독 높이 조절"). */
  label: string
  className?: string
}) {
  const vertical = orientation === "vertical"
  return (
    <div
      onPointerDown={onPointerDown}
      // pointerdown 의 preventDefault 만으로는 부족하다 — WebKit 은 마우스 입력에서
      // 포인터 이벤트를 합성하는데, *마우스* pointerdown 취소를 존중하는 정도가
      // 예전부터 들쭉날쭉했다. 네이티브 선택 드래그를 확실히 막는 것은 mousedown 의
      // 기본 동작을 막는 쪽이다. 포커스를 받지 않는 `role="separator"` div 라서
      // mousedown 의 포커스 부수효과를 잃어도 잃을 것이 없다. (`body` 의
      // `user-select: none` 은 `<textarea>` 안쪽 선택을 못 막으므로 — WebKit UA
      // 스타일시트가 `-webkit-user-select: text` 를 다시 세운다 — 이 분할선이 편집기
      // textarea 바로 옆에 있는 한 고칠 자리는 CSS 가 아니라 이벤트 발생 지점이다.)
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        "shrink-0 touch-none bg-border transition-colors select-none hover:bg-ui-selection/60",
        // 클래스 이름을 조립하지 않는다 — Tailwind v4 는 소스를 글자로 훑으므로
        // `cursor-${axis}-resize` 로 만들면 규칙이 생성되지 않고 조용히 사라진다.
        vertical ? "w-[5px] cursor-col-resize" : "h-[5px] cursor-row-resize",
        resizing && "bg-ui-selection",
        className
      )}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
    />
  )
}
