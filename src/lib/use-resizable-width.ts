import { useEffect, useRef, useState, type PointerEvent } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/**
 * 드래그로 폭을 조절하는 패널용 훅 (ES/Kafka 뷰어의 왼쪽 목록 패널).
 *
 * 셸 사이드바(`src/components/shell/side-bar.tsx`)가 쓰던 방식을 그대로 뽑아낸 것이다.
 * pointerdown 으로 시작하고 이동/종료는 **window** 에서 듣는다 — 핸들이 4px 밖에 안 돼서
 * 조금만 빨리 끌어도 포인터가 핸들을 벗어나는데, 요소에서 들으면 그 순간 드래그가 끊긴다.
 *
 * 폭은 localStorage 에 저장되므로 앱을 다시 켜도 유지된다.
 *
 * @returns `width` 를 패널 style 에, `startResize` 를 핸들의 onPointerDown 에 연결한다.
 */
export function useResizableWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number
) {
  const [width, setWidth] = useLocalStorage<number>(key, defaultWidth)
  const [resizing, setResizing] = useState(false)
  const origin = useRef({ x: 0, width: defaultWidth })

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: globalThis.PointerEvent) => {
      const next = origin.current.width + (e.clientX - origin.current.x)
      setWidth(Math.round(Math.min(max, Math.max(min, next))))
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
  }, [resizing, setWidth, min, max])

  const startResize = (e: PointerEvent) => {
    if (e.button !== 0) return
    origin.current = { x: e.clientX, width }
    setResizing(true)
  }

  return { width, resizing, startResize }
}
