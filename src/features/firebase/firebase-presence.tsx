import { useEffect } from "react"

import { useAuth } from "@/features/auth/auth-context"
import { trackedInvoke } from "@/lib/tauri"
import { isMainWindow } from "@/lib/window-role"

/**
 * 로그인한 사람을 Rust 쪽 실행 기록(`src-tauri/src/firebase.rs`)에 알린다.
 *
 * Firebase 의 `status` 는 LDAP 아이디별로 노드가 갈리는데, Rust 는 그 아이디를 스스로 알 수
 * 없다 — 로그인 정보는 이 웹뷰의 localStorage 에만 있다. 그래서 로그인이 확정되는(자동
 * 로그인 복원 포함) 이 자리에서 한 번 넘겨 준다. Rust 는 같은 사용자로 다시 불리면 무시하고,
 * 사람이 바뀌면 앞사람을 닫고 새 사람을 연다.
 *
 * 두 가지를 지켜야 한다.
 *  - **`LoginGate` 바깥(위)에 마운트한다.** 게이트 안에 두면 로그아웃하는 순간 언마운트돼
 *    로그아웃을 알릴 기회가 사라지고, 그 사람 노드가 `online: true` 로 굳는다.
 *  - **메인 창에서만 보낸다.** 팝아웃 창(`view-*`)도 같은 `AuthProvider` 를 쓰므로, 게이트가
 *    없으면 창을 열 때마다 로그인/로그아웃이 중복으로 오간다.
 */
export function FirebasePresence() {
  const { user } = useAuth()

  useEffect(() => {
    if (!isMainWindow) return
    if (user) {
      void trackedInvoke("firebase_set_user", {
        username: user.username,
        displayName: user.displayName,
        email: user.email,
      })
    } else {
      // 로그인 전 첫 렌더에서도 불리지만, 기록 중인 세션이 없으면 Rust 가 무시한다.
      void trackedInvoke("firebase_clear_user")
    }
  }, [user])

  return null
}
