import { useSyncExternalStore } from "react"

/**
 * "터미널 뷰를 이 herdr 세션으로 붙여 달라"는 요청을 담는 **모듈 수준 스토어**.
 *
 * 세션 목록의 「앱 터미널에서 열기」가 이 값을 채우고 터미널 뷰가 받아 간다. `useLocalStorage`
 * 로 넘기지 않는 이유는 이 저장소가 이미 여러 번 부딪힌 함정이다 — **같은 창에서 같은 키로
 * `useLocalStorage` 를 두 번 부르면 서로의 쓰기를 보지 못한다**(`storage` 이벤트는 다른 창에만
 * 간다). 세션 목록이 키를 쓰더라도 이미 마운트돼 있는 터미널 뷰의 스냅샷은 그대로라, 눌러도
 * 아무 일이 없는 것처럼 보인다.
 *
 * Provider 가 아니라 모듈 스토어인 것은 `use-running-count.ts` 와 같은 판단이다: 이 값을
 * 읽는 쪽과 쓰는 쪽이 서로 다른 트리(사이드바 탭 / 팝아웃 창)에 있을 수 있어, Provider 로
 * 두면 감싸야 할 트리를 하나 빼먹는 순간 조용히 동작하지 않는다.
 *
 * **요청은 한 번 쓰이고 사라진다.** 남겨 두면 터미널 뷰가 세션을 바꿀 때마다 이 값이
 * 되돌려 놓아, 드롭다운으로 다른 세션을 고를 수 없게 된다.
 */
let requested: string | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const f of listeners) f()
}

function subscribe(f: () => void) {
  listeners.add(f)
  return () => listeners.delete(f)
}

/** 터미널 뷰에게 이 세션으로 붙어 달라고 요청한다. */
export function requestTerminalSession(session: string) {
  requested = session
  emit()
}

/** 요청을 소비했음을 알린다(같은 요청이 다시 적용되지 않도록). */
export function clearTerminalSessionRequest() {
  if (requested === null) return
  requested = null
  emit()
}

/** 지금 대기 중인 요청. 없으면 null. */
export function useTerminalSessionRequest(): string | null {
  return useSyncExternalStore(subscribe, () => requested)
}
