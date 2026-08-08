import type { PointerEvent } from "react"

import { cn } from "@/lib/utils"

/**
 * 패널 모서리의 폭 조절 손잡이. `useResizableWidth` 와 짝으로 쓴다.
 *
 * 부모 패널은 `relative` 여야 하고, 패널과 본문 사이 12px(`gap-3`) 간격 가운데에
 * 놓이도록 `-right-2` 로 살짝 밀어 둔다 — 패널 안쪽에 두면 내용과 겹쳐 보인다.
 *
 * ⚠️ **간격이 없는 레이아웃에는 이 손잡이를 쓰지 말고 `SplitBar` 를 쓸 것.**
 * 이 손잡이는 패널 바깥 7.5px(`-right-2`) 에 떠 있으므로 "부모 flex 행에 `gap-3` 이
 * 있어서 빈 간격 가운데에 떨어진다"는 암묵적 계약을 지고 있다. 열이 실선 경계로 딱
 * 붙어 있는 화면(IntelliJ Cowork 의 3분할처럼)에서는 눈에 보이는 경계선과 실제로 잡히는
 * 띠가 몇 px 어긋난 채 이웃 내용 위에 놓여, 선을 겨냥할수록 빗나간다. 그런 자리에는
 * 흐름 안에 들어가는 `@/components/split-bar` 를 쓴다.
 *
 * ⚠️ 손잡이는 패널 **바깥**에 있으므로 패널에 `overflow-hidden` 을 걸면 그대로 잘려
 * 사라진다. 오류도 경고도 없이 "드래그가 안 되는" 상태가 되므로, 스크롤이 필요하면
 * 패널이 아니라 그 **안쪽** 요소에 걸 것.
 *
 * `side` 는 손잡이가 붙는 모서리다. 오른쪽에 도킹된 패널은 왼쪽 모서리를 잡아야 하므로
 * `"left"` 를 주고, 훅에는 같은 뜻으로 `direction: "rtl"` 을 준다 — 둘이 어긋나면
 * 손잡이는 왼쪽에 있는데 패널이 반대로 움직인다.
 */
export function ResizeHandle({
  resizing,
  onPointerDown,
  label,
  side = "right",
}: {
  resizing: boolean
  onPointerDown: (e: PointerEvent) => void
  /** 스크린리더용 설명 (예: "토픽 목록 폭 조절"). */
  label: string
  /** 손잡이를 붙일 모서리. 오른쪽 도킹 패널이면 `"left"`. */
  side?: "left" | "right"
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      // pointerdown 의 preventDefault 만으로는 부족하다 — WebKit 은 마우스 입력에서
      // 포인터 이벤트를 합성하는데, *마우스* pointerdown 취소를 존중하는 정도가
      // 예전부터 들쭉날쭉했다. 네이티브 선택 드래그를 확실히 막는 것은 mousedown 의
      // 기본 동작을 막는 쪽이다. 이 손잡이는 포커스를 받지 않는 `role="separator"`
      // div 라서 mousedown 이 주는 포커스 부수효과를 잃어도 잃을 것이 없다.
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        // 두께는 4px → 7px 로 넓혔지만 **패널 경계 안으로는 들어가지 않는다**. `-right-2`
        // 가 7.5px 밖이므로 띠는 [+0.5px, +7.5px], 즉 `gap-3`(11.25px) 간격 안에만 있다.
        // 안쪽으로 걸치게 두면(예: `-right-[3px]`) 패널 내용의 마지막 4px 을 덮어, 목록
        // 행의 오른쪽 끝 클릭이나 textarea 의 끝 글자 드래그가 폭 조절로 먹힌다.
        "absolute inset-y-0 z-30 w-[7px] cursor-col-resize touch-none rounded-full transition-colors select-none hover:bg-ui-selection/60",
        // z-30 인 이유: `DataGrid` 의 행 번호 열이 불투명한 `sticky left-0 z-10 bg-card`
        // 라서 z-10 이면 같은 쌓임 문맥에서 나중에 나오는 그쪽이 이겨 손잡이를 통째로
        // 덮어 버린다(테이블/SQL 탭이 열려 있을 때 트리 폭 조절이 안 되던 원인).
        // 이 앱에서 이보다 위는 `fixed z-50` 다이얼로그뿐이라 z-30 은 안전하다.
        // 클래스 이름을 조립하지 않는다 — Tailwind v4 는 소스를 글자로 훑으므로
        // `-${side}-2` 로 만들면 규칙이 생성되지 않고 조용히 위치만 사라진다.
        side === "left" ? "-left-2" : "-right-2",
        resizing && "bg-ui-selection/60"
      )}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
    />
  )
}
