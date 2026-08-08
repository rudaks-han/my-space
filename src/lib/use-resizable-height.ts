import { useEffect, useRef, useState, type PointerEvent } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/** 패널이 위·아래 중 어디에 붙어 있는지 — 드래그 방향의 부호를 정한다. */
export type ResizeEdge = "bottom" | "top"

/**
 * 드래그로 높이를 조절하는 패널용 훅. `useResizableWidth` 의 세로축 짝이고,
 * 구조·동작·저장 방식이 전부 같다 — 축만 다르다.
 *
 * pointerdown 으로 시작하고 이동/종료는 **window** 에서 듣는다 — 손잡이가 4px 밖에 안 돼서
 * 조금만 빨리 끌어도 포인터가 손잡이를 벗어나는데, 요소에서 들으면 그 순간 드래그가 끊긴다.
 *
 * `edge` 는 패널이 **붙어 있는 쪽**이다. 아래 독(`"bottom"`, 기본값)은 손잡이가 자기
 * **위쪽** 모서리에 있으므로 아래로 끌면 작아진다 — `height - (y - y0)`. 위에 붙은
 * 패널(`"top"`)은 손잡이가 아래 모서리라 아래로 끌면 커지므로 부호가 반대다.
 * 부호를 잘못 주면 패널이 포인터를 등지고 움직여, 오류 없이 고장 난 것처럼 보인다.
 *
 * 드래그 중 글자가 선택돼 보이는 문제의 원인과 처방은 `useResizableWidth` 의 주석에
 * 자세히 적어 두었다 — 여기서도 **똑같이** 적용한다(preventDefault → 기존 선택 지우기 →
 * 포인터 캡처, 그리고 `pointercancel` 청취). 한 축만 고치면 세로 분할선에서만 증상이
 * 남아 "어떤 바는 되고 어떤 바는 안 된다"가 된다.
 *
 * 높이는 localStorage 에 저장되므로 앱을 다시 켜도 유지된다.
 *
 * @returns `height` 를 패널 style 에, `startResize` 를 손잡이의 onPointerDown 에 연결한다.
 */
export function useResizableHeight(
  key: string,
  defaultHeight: number,
  min: number,
  max: number,
  edge: ResizeEdge = "bottom"
) {
  const [stored, setHeight] = useLocalStorage<number>(key, defaultHeight)
  const [resizing, setResizing] = useState(false)
  const origin = useRef({ y: 0, height: defaultHeight })

  /*
   * 저장값을 **읽을 때도** 범위로 자른다. 드래그 핸들러에서만 자르면, 큰 창에서 크게
   * 늘려 둔 값이 작은 창에서 그대로 되살아난다 — 아래 독은 `shrink-0` 이라 형제인
   * `flex-1` 편집 영역의 높이가 0 이 되고(루트가 `overflow-hidden` 이라 스크롤도 없다),
   * 분할선을 더블클릭해야 한다는 걸 모르면 빠져나올 수 없다.
   * 저장소에는 되쓰지 않는다(렌더 중 부수효과가 되고, 창을 다시 키우면 원래 크기로
   * 돌아오는 편이 낫다). 다음 드래그가 잘린 값을 기준으로 저장한다.
   */
  const height = Math.min(max, Math.max(min, stored))

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: globalThis.PointerEvent) => {
      const delta = e.clientY - origin.current.y
      const next =
        edge === "top"
          ? origin.current.height + delta
          : origin.current.height - delta
      setHeight(Math.round(Math.min(max, Math.max(min, next))))
    }
    const onUp = () => setResizing(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    // `pointercancel` 도 같은 핸들러로 받는다 — OS 가 제스처를 가로채면 `pointerup` 이
    // 오지 않아 `resizing` 이 true 로 굳고 아래의 `userSelect` 복원도 영영 안 돈다.
    window.addEventListener("pointercancel", onUp)
    // 드래그 중 텍스트 선택을 막는 2차 방어선. 1차는 `startResize` 의 preventDefault 다
    // (이 효과는 제스처가 시작된 뒤 최소 한 프레임 뒤에 돌아서, WebKit 에서 이미
    // 진행 중인 선택 드래그를 여기서 중단시킬 수는 없다). 여기서 저장·복원하는 값을
    // `startResize` 에서 미리 `"none"` 으로 바꿔 두면 정리 단계가 `"none"` 을 되돌려
    // 놓아 첫 드래그 뒤 앱 전체에서 선택이 죽으므로, 이 두 줄은 이 자리에 남긴다.
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      document.body.style.userSelect = prevSelect
    }
  }, [resizing, setHeight, min, max, edge])

  const startResize = (e: PointerEvent) => {
    if (e.button !== 0) return
    // 순서가 중요하다. preventDefault 가 호환용 mousedown 을 막아 네이티브 선택 드래그가
    // 시작되는 것 자체를 없애고, removeAllRanges 가 **이미 칠해져 있던** 선택을 지운다
    // (user-select 로는 지워지지 않아, 드래그 내내 하이라이트가 남는 그 증상이다).
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    origin.current = { y: e.clientY, height }
    setResizing(true)
    // 포인터 캡처: 빠르게 끌어 손잡이를 벗어나도 이벤트가 계속 오고, 브라우저가 이
    // 제스처를 "요소를 끄는 중"으로 확정해 중간에 선택으로 승격시키지 않는다.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  return { height, resizing, startResize }
}
