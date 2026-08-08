/**
 * "이 `connId` 는 방금 닫혔다"를 같은 창의 다른 화면에 알리는 통로.
 *
 * 왜 필요한가: `connId` 는 Java 브리지의 접속 맵 키이고, 데이터베이스 뷰어와 IntelliJ Cowork 은
 * **같은 id 를 일부러 공유한다**(저장된 비밀번호가 그 id 로 잠겨 있어서, 화면별로 접미사를
 * 붙이면 비밀번호를 잃는다 — `use-db-session.ts` 의 (a) 참고). 그래서 `db_disconnect(connId)`
 * 는 그 접속을 **모든 화면에서** 닫는데, 부른 쪽만 자기 상태를 정리한다. 남은 화면은
 * 여전히 "연결됨"으로 보이고, 이미 롤백된 편집에 대해 커밋을 권하고, 다음 질의는 전부
 * 브리지의 "접속을 찾을 수 없습니다"로 떨어진다.
 *
 * 왜 Rust 이벤트가 아니라 창 안의 이벤트인가: 두 화면은 탭이 keep-alive 라 **같은 webview
 * 안에** 동시에 떠 있는 것이 기본이고, 그것이 실제로 부딪히는 유일한 배치다. 창을 나눠
 * 띄운 경우(팝아웃)까지 덮으려면 `db.rs` 가 이벤트를 emit 해야 하는데, 그건 이 통로를
 * `listen("db:disconnected")` 로 바꿔 끼우면 되는 일이라 나중에 옮길 수 있다.
 * `useLocalStorage` 의 `storage` 이벤트를 쓸 수는 없다 — 그건 상태를 저장하는 통로이고,
 * 여기 필요한 것은 저장할 값이 없는 **일회성 신호**다.
 */

const EVENT = "myspace:db-disconnected"

/** 접속을 닫은 쪽이 부른다. 부른 화면 자신도 듣게 되므로 자기 정리는 따로 해야 한다. */
export function announceDisconnect(connId: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: connId }))
}

/**
 * 다른 화면이 접속을 닫았을 때 불릴 콜백을 등록한다. 반환값을 effect 정리에서 부를 것.
 *
 * 콜백은 **자기 화면이 그 접속을 쓰고 있었는지 스스로 판단**해야 한다 — 여기서는
 * 누가 무엇을 열어 두었는지 알 수 없다.
 */
export function onDisconnected(fn: (connId: string) => void): () => void {
  const h = (e: Event) => {
    const id = (e as CustomEvent<string>).detail
    if (typeof id === "string") fn(id)
  }
  window.addEventListener(EVENT, h)
  return () => window.removeEventListener(EVENT, h)
}
