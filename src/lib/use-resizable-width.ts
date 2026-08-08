import { useEffect, useRef, useState, type PointerEvent } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/** 패널이 어느 쪽에 붙어 있는지 — 드래그 방향의 부호를 정한다. */
export type ResizeDirection = "ltr" | "rtl"

/**
 * 드래그로 폭을 조절하는 패널용 훅 (ES/Kafka 뷰어의 왼쪽 목록 패널).
 *
 * 셸 사이드바(`src/components/shell/side-bar.tsx`)가 쓰던 방식을 그대로 뽑아낸 것이다.
 * pointerdown 으로 시작하고 이동/종료는 **window** 에서 듣는다 — 핸들이 4px 밖에 안 돼서
 * 조금만 빨리 끌어도 포인터가 핸들을 벗어나는데, 요소에서 들으면 그 순간 드래그가 끊긴다.
 *
 * 폭은 localStorage 에 저장되므로 앱을 다시 켜도 유지된다.
 *
 * `direction` 은 패널이 **어느 쪽에 붙어 있는지**다. 왼쪽 패널(`"ltr"`, 기본값)은
 * 오른쪽 모서리를 오른쪽으로 끌면 커지므로 `width + (x - x0)` 이지만, 오른쪽에 도킹된
 * 패널(`"rtl"`)은 손잡이가 **왼쪽** 모서리에 있어 포인터가 왼쪽으로 갈수록 커진다 —
 * 그래서 부호를 뒤집어 `width - (x - x0)` 로 계산한다. 부호를 안 뒤집으면 패널이
 * 포인터를 등지고 반대로 움직여서, 오류 없이 그냥 "고장 난 것처럼" 보인다.
 *
 * ## 드래그 중 글자가 선택돼 보이는 문제
 *
 * "resize bar 를 움직이면 글자가 선택되는 것처럼 보인다"는 증상의 원인은 CSS 가 아니라
 * **이벤트**였다. 세 가지가 겹쳐 있었다:
 * 1. `pointerdown` 의 기본 동작이 호환용 `mousedown` 을 만들고, 그 기본 동작이 곧
 *    "네이티브 선택 드래그 시작"이다 — WebKit 은 누른 첫 순간부터 선택을 시작한다.
 *    그래서 `startResize` 가 **가장 먼저** `preventDefault()` 를 부른다.
 * 2. `user-select: none` 은 **이미 있는 선택을 지우지 않는다.** 조금 전 콘솔 로그에서
 *    긁어 둔 하이라이트가 드래그 내내 칠해진 채 남는 것이 실제로 눈에 보이는 증상이다 —
 *    그래서 `removeAllRanges()` 로 직접 지운다.
 * 3. `pointercancel`(OS 가 제스처를 가로챈 경우)을 듣지 않아 `resizing` 이 `true` 로
 *    굳고 `body` 의 `userSelect` 가 세션이 끝날 때까지 `"none"` 에 박혀 있었다.
 *
 * 아래 효과의 `userSelect` 저장·복원은 **2차 방어선으로만** 남겨 둔다. `startResize`
 * 에서 미리 `"none"` 을 넣으면 효과가 읽는 `prevSelect` 가 이미 `"none"` 이어서
 * 정리 단계가 `"none"` 을 되돌려 놓고, 첫 드래그 이후 앱 전체에서 글자 선택이 죽는다.
 *
 * 그리고 `body` 의 `user-select: none` 은 `<textarea>`·`<input>` 안쪽 선택을 절대
 * 막지 못한다(WebKit UA 스타일시트가 `-webkit-user-select: text` 를 다시 세운다).
 * 이 분할선들은 `TextEditor` 의 textarea 바로 위에 놓이므로, 고칠 자리는 CSS 가 아니라
 * 이벤트 발생 지점이다.
 *
 * @returns `width` 를 패널 style 에, `startResize` 를 핸들의 onPointerDown 에 연결한다.
 */
export function useResizableWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number,
  direction: ResizeDirection = "ltr"
) {
  const [stored, setWidth] = useLocalStorage<number>(key, defaultWidth)
  const [resizing, setResizing] = useState(false)
  const origin = useRef({ x: 0, width: defaultWidth })

  /*
   * 저장값을 **읽을 때도** 범위로 자른다 — 자세한 이유는 `useResizableHeight` 의 같은
   * 자리에 적어 두었다(큰 창에서 넓혀 둔 값이 좁은 창에서 되살아나면, `shrink-0` 인
   * 패널들이 자리를 다 먹고 가운데 영역이 0px 이 된다). 저장소에는 되쓰지 않는다.
   */
  const width = Math.min(max, Math.max(min, stored))

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: globalThis.PointerEvent) => {
      const delta = e.clientX - origin.current.x
      const next =
        direction === "rtl"
          ? origin.current.width - delta
          : origin.current.width + delta
      setWidth(Math.round(Math.min(max, Math.max(min, next))))
    }
    const onUp = () => setResizing(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    // `pointercancel` 도 같은 핸들러로 받는다 — OS 가 제스처를 가로채면 `pointerup` 이
    // 오지 않아 `resizing` 이 true 로 굳고 아래의 `userSelect` 복원도 영영 안 돈다.
    window.addEventListener("pointercancel", onUp)
    // 드래그 중 텍스트 선택을 막는 2차 방어선. 1차는 `startResize` 의 preventDefault 다
    // (이 효과는 제스처가 시작된 뒤 최소 한 프레임 뒤에 돌아서, WebKit 에서 이미
    // 진행 중인 선택 드래그를 여기서 중단시킬 수는 없다).
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      document.body.style.userSelect = prevSelect
    }
  }, [resizing, setWidth, min, max, direction])

  const startResize = (e: PointerEvent) => {
    if (e.button !== 0) return
    // 순서가 중요하다. preventDefault 가 호환용 mousedown 을 막아 네이티브 선택 드래그가
    // 시작되는 것 자체를 없애고, removeAllRanges 가 **이미 칠해져 있던** 선택을 지운다
    // (user-select 로는 지워지지 않아, 드래그 내내 하이라이트가 남는 그 증상이다).
    e.preventDefault()
    window.getSelection()?.removeAllRanges()
    origin.current = { x: e.clientX, width }
    setResizing(true)
    // 포인터를 캡처해 두면 빠르게 끌어 손잡이를 벗어나도 이벤트가 계속 온다. 없어도
    // window 에서 듣기 때문에 동작하지만, 캡처가 있으면 브라우저가 이 제스처를
    // "요소를 끄는 중"으로 확정해 중간에 선택으로 승격시키지 않는다.
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }

  return { width, resizing, startResize }
}
