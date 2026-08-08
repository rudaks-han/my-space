import type { PointerEvent } from "react"

import { cn } from "@/lib/utils"

/**
 * 패널 위·아래 모서리의 높이 조절 손잡이. `useResizableHeight` 와 짝으로 쓴다.
 * `ResizeHandle` 의 세로축 짝이라 두께(7px)·모양·색이 전부 같고 축만 다르다.
 *
 * 부모 패널은 `relative` 여야 하고, 패널과 본문 사이 간격 가운데에 놓이도록
 * `-top-2` 로 살짝 밀어 둔다 — 패널 안쪽에 두면 내용과 겹쳐 보인다.
 *
 * ⚠️ **간격이 없는 레이아웃에는 쓰지 말고 `@/components/split-bar` 를 쓸 것.** 이
 * 손잡이는 패널 바깥에 떠 있어서 "부모에 `gap-3` 이 있어 빈 간격 가운데에 떨어진다"는
 * 암묵적 계약을 지고 있다. `gap-2`(7.5px) 나 간격이 아예 없는 자리에서는 잡히는 띠가
 * 눈에 보이는 경계선과 어긋난 채 이웃 내용 위에 놓여, 선을 겨냥할수록 빗나간다.
 *
 * ⚠️ 손잡이는 패널 **바깥**에 있으므로 패널에 `overflow-hidden` 을 걸면 그대로 잘려
 * 사라진다. 오류도 경고도 없이 "드래그가 안 되는" 상태가 되므로, 스크롤이 필요하면
 * 패널이 아니라 그 **안쪽** 요소에 걸 것.
 *
 * `edge` 는 손잡이가 붙는 모서리다. 아래 독은 위쪽을 잡으므로 `"top"`(기본값)이고,
 * 훅에는 같은 뜻으로 `edge: "bottom"`(패널이 아래에 붙어 있다)을 준다 — 이름이 서로
 * 반대인 이유이자, 둘이 어긋나면 패널이 포인터와 반대로 움직이는 이유다.
 */
export function ResizeHandleH({
  resizing,
  onPointerDown,
  label,
  edge = "top",
}: {
  resizing: boolean
  onPointerDown: (e: PointerEvent) => void
  /** 스크린리더용 설명 (예: "콘솔 높이 조절"). */
  label: string
  /** 손잡이를 붙일 모서리. 아래 독이면 `"top"`. */
  edge?: "top" | "bottom"
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      // pointerdown 의 preventDefault 만으로는 부족하다 — WebKit 은 마우스 입력에서
      // 포인터 이벤트를 합성하는데, *마우스* pointerdown 취소를 존중하는 정도가
      // 예전부터 들쭉날쭉했다. 네이티브 선택 드래그를 확실히 막는 것은 mousedown 의
      // 기본 동작을 막는 쪽이다. 포커스를 받지 않는 `role="separator"` div 라서
      // mousedown 의 포커스 부수효과를 잃어도 잃을 것이 없다.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        // 두께는 7px 이지만 패널 경계 **안으로는 들어가지 않는다**(자세한 이유는
        // `ResizeHandle` 주석 참고 — 안쪽으로 걸치면 이웃 내용의 클릭을 삼킨다).
        "absolute inset-x-0 z-30 h-[7px] cursor-row-resize touch-none rounded-full transition-colors select-none hover:bg-ui-selection/60",
        // z-30 인 이유: 불투명한 `sticky … z-10` 거터(`DataGrid` 의 행 번호 열 등)가
        // 같은 쌓임 문맥에서 나중에 나오면 z-10 손잡이를 통째로 덮는다. 이보다 위는
        // `fixed z-50` 다이얼로그뿐이라 z-30 은 안전하다.
        // 클래스 이름을 조립하지 않는다 — Tailwind v4 는 소스를 글자로 훑으므로
        // `-${edge}-2` 로 만들면 규칙이 생성되지 않고 조용히 위치만 사라진다.
        edge === "bottom" ? "-bottom-2" : "-top-2",
        resizing && "bg-ui-selection/60"
      )}
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
    />
  )
}
