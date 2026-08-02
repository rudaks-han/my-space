import { useEffect, useState } from "react"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import type { UnlistenFn } from "@tauri-apps/api/event"

import { isTauri } from "@/lib/tauri"

/**
 * 파일을 뷰 위로 끌어다 놓는 것을 받는다.
 *
 * **HTML5 의 `dragover`/`drop` 은 쓸 수 없다.** Tauri 웹뷰는 드래그앤드롭을 네이티브에서
 * 가로채(`dragDropEnabled` 기본값) 웹 이벤트로 내려 주지 않는다. 대신 웹뷰의
 * `onDragDropEvent` 가 **파일 경로**를 주는데, 이건 창 전체에 걸린 이벤트라 두 가지를
 * 직접 해야 한다.
 *
 *  1. **탭이 보일 때만 듣는다.** 탭은 keep-alive 라 닫기 전까지 마운트된 채이므로
 *     (`useTabActive()`), 이 조건이 없으면 다른 메뉴를 보는 중에 떨어뜨린 파일까지
 *     이 뷰가 삼킨다.
 *  2. **좌표로 영역을 가른다.** 이벤트의 좌표는 물리 픽셀(창 기준)이라 `devicePixelRatio`
 *     로 나눠 CSS 픽셀로 바꾼 뒤 대상 영역의 사각형과 비교한다. 이걸로 "여기 놓으세요"
 *     강조(hovering)도 정확한 위치에서만 뜬다.
 */
export function useFileDrop({
  enabled,
  zoneRef,
  onDrop,
}: {
  /** 지금 이 뷰가 화면에 있는지(꺼져 있으면 아무것도 듣지 않는다). */
  enabled: boolean
  /** 드롭을 받을 영역. */
  zoneRef: React.RefObject<HTMLElement | null>
  /**
   * 놓인 파일 경로들. **호출부에서 `useCallback` 으로 고정해야 한다** — 매 렌더 새 함수를
   * 넘기면 그때마다 네이티브 리스너를 떼었다 붙인다.
   */
  onDrop: (paths: string[]) => void
}): boolean {
  const [hovering, setHovering] = useState(false)

  useEffect(() => {
    if (!enabled || !isTauri()) return
    let unlisten: UnlistenFn | undefined
    let disposed = false

    const inside = (p: { x: number; y: number }): boolean => {
      const el = zoneRef.current
      if (!el) return false
      const r = el.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      const x = p.x / dpr
      const y = p.y / dpr
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    }

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === "enter" || p.type === "over") {
          setHovering(inside(p.position))
          return
        }
        if (p.type === "drop") {
          setHovering(false)
          if (inside(p.position) && p.paths.length) onDrop(p.paths)
          return
        }
        setHovering(false)
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })

    return () => {
      disposed = true
      unlisten?.()
      // 탭을 벗어나는 순간 강조가 켜져 있었다면 남지 않게 끈다.
      setHovering(false)
    }
  }, [enabled, zoneRef, onDrop])

  return hovering
}
