import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { isTauri } from "@/lib/tauri"

export interface WebviewBounds {
  x: number
  y: number
  width: number
  height: number
}

const sameBounds = (a: WebviewBounds | null, b: WebviewBounds) =>
  a !== null &&
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height

// isTauri 는 함수이므로 한 번 호출해 boolean 으로 둔다 (Tauri 앱 안에서 실행 중인지).
const inTauri = isTauri()

/**
 * 네이티브 자식 웹뷰를 겹쳐 그릴 영역의 좌표·크기를 측정한다.
 * 반환값은 웹뷰 좌표계로 보정된 사각형이며, 레이아웃이 안정되기 전에는 null 이다
 * (그 전에 웹뷰를 만들면 잘못된 위치에 생겨 툴바를 덮는다).
 *
 * 사용법: 웹뷰가 들어갈 div 에 ref 를 달고, 반환된 rect 가 null 이 아닐 때만
 * browser_open / browser_set_bounds 를 호출한다.
 */
export function useWebviewBounds(
  ref: RefObject<HTMLElement | null>
): WebviewBounds | null {
  const [bounds, setBounds] = useState<WebviewBounds | null>(null)
  // 레이아웃이 안정되기 전에는 웹뷰를 만들지 않는다. dev 모드(Vite)는 CSS 가 JS 로 주입돼
  // 첫 프레임이 스타일 적용 전일 수 있고, 그때 잘못된 위치에 웹뷰가 생성되면 툴바를 덮는다.
  const [settled, setSettled] = useState(false)

  // DOM 뷰포트 좌표와 네이티브 자식 웹뷰 좌표 사이의 오프셋을 런타임에 계산해 보정한다.
  // (창 데코레이션/타이틀바 높이 등으로 상수 오프셋이 생길 수 있음)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(
    inTauri ? null : { x: 0, y: 0 }
  )
  // 핵심: macOS(wry)는 자식 웹뷰 y 원점을 '창 최상단(타이틀바 포함)' 기준으로 잡는 반면,
  // DOM 좌표(getBoundingClientRect)는 타이틀바 아래가 0 이다. 그 차이(=타이틀바 높이)만큼
  // 웹뷰가 위로 그려져 툴바를 덮었다. 이 차이는 '창 inner 크기 − DOM 뷰포트 크기' 로 구할 수 있다
  // (타이틀바가 없는 OS 에선 0 이 되어 그대로 동작).
  useEffect(() => {
    if (!inTauri) return
    let cancelled = false
    ;(async () => {
      try {
        const win = getCurrentWindow()
        const [size, scale] = await Promise.all([
          win.innerSize(),
          win.scaleFactor(),
        ])
        if (cancelled) return
        const winW = size.width / scale
        const winH = size.height / scale
        setOffset({
          x: Math.max(0, Math.round(winW - window.innerWidth)),
          y: Math.max(0, Math.round(winH - window.innerHeight)),
        })
      } catch {
        if (!cancelled) setOffset({ x: 0, y: 0 })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 웹뷰가 차지할 영역의 뷰포트 기준 좌표·크기를 측정한다.
  // 네이티브 웹뷰는 이 위에 겹쳐 그려지므로 좌표가 조금이라도 어긋나면 툴바를 덮어버린다.
  // ResizeObserver 는 '크기' 변화만 감지해 위치만 바뀌는 경우(CSS 로딩·헤더 높이 확정 등)를
  // 놓친다. 그래서 매 프레임 실제 사각형을 다시 재어 값이 바뀔 때만 갱신한다(변화 없으면 렌더 없음).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let last: WebviewBounds | null = null
    let stable = 0
    let isSettled = false
    const tick = () => {
      const r = el.getBoundingClientRect()
      const next: WebviewBounds = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
      if (sameBounds(last, next)) {
        // 같은 값이 연속 3프레임 유지되면 레이아웃이 안정된 것으로 보고 웹뷰 생성을 허용
        if (!isSettled && next.height > 0 && ++stable >= 3) {
          isSettled = true
          setSettled(true)
        }
      } else {
        last = next
        stable = 0
        setBounds(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ref])

  // bounds/offset 은 값이 바뀔 때만 새 객체가 되므로 memo 결과도 그때만 바뀐다
  // (호출부에서 effect 의존성으로 그대로 쓸 수 있다).
  return useMemo(
    () =>
      bounds && settled && offset
        ? {
            x: bounds.x + offset.x,
            y: bounds.y + offset.y,
            width: bounds.width,
            height: bounds.height,
          }
        : null,
    [bounds, settled, offset]
  )
}
