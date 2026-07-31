import { useSyncExternalStore } from "react"

/**
 * 네이티브 자식 웹뷰(브라우저·cowork-ai·claude-design)는 창 **위에** 겹쳐 그려져
 * CSS 로 가려지지 않는다. 그래서 그 영역을 덮는 HTML 오버레이(탭 목록 드롭다운 등)를
 * 띄우면 오버레이가 웹뷰 아래로 숨는다. 이 스토어는 "지금 웹뷰를 잠시 숨겨야 하는
 * 오버레이가 떠 있는가?" 한 가지 신호를 전역으로 공유한다 — 오버레이를 여는 쪽은
 * suppressWebviews() 로 요청하고, 웹뷰를 심는 뷰는 useWebviewsSuppressed() 로 구독해
 * 그동안 browser_hide 로 비켜 준다. 여러 오버레이가 겹쳐도 되도록 카운터로 센다.
 */
let count = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** 오버레이가 열려 있는 동안 웹뷰 숨김을 요청한다. 반환된 함수를 호출하면 해제된다. */
export function suppressWebviews(): () => void {
  count += 1
  emit()
  let released = false
  return () => {
    if (released) return
    released = true
    count -= 1
    emit()
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function snapshot() {
  return count > 0
}

/** 네이티브 웹뷰를 지금 숨겨야 하는지. */
export function useWebviewsSuppressed(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
