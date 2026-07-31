import { useCallback, useMemo, useState, type ReactNode } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import {
  AUTH_STORAGE_KEY,
  AuthContext,
  DEFAULT_AUTH,
  type AuthUser,
  type PersistedAuth,
} from "@/features/auth/auth-context"

/**
 * 로그인 상태를 앱 전역에 공유한다.
 *
 * 저장(localStorage)과 세션(메모리)을 나눠 둔다:
 *  - 저장(`persisted`): 자동 로그인이 켜져 있을 때만 사용자 정보를 담는다. 앱을 다시 켜면
 *    이 값으로 로그인 상태를 복원한다(자동 로그인 = LDAP 재요청 없이 통과).
 *  - 세션(`sessionUser`): 지금 창에서 로그인돼 있는지. 처음에는 저장값(자동 로그인)에서
 *    복원하고, 이후 login/logout 으로 바뀐다.
 *
 * 타입·useAuth 훅은 auth-context.ts 에 있다.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [persisted, setPersisted] = useLocalStorage<PersistedAuth>(
    AUTH_STORAGE_KEY,
    DEFAULT_AUTH
  )

  // 자동 로그인이 켜져 있고 저장된 사용자가 있으면 바로 로그인된 상태로 시작한다.
  const [sessionUser, setSessionUser] = useState<AuthUser | null>(() =>
    persisted.autoLogin ? persisted.user : null
  )

  const login = useCallback(
    (user: AuthUser, autoLogin: boolean) => {
      setSessionUser(user)
      setPersisted({
        // 자동 로그인일 때만 사용자를 저장한다(꺼져 있으면 다음 실행에서 다시 폼).
        user: autoLogin ? user : null,
        autoLogin,
        lastUsername: user.username,
      })
    },
    [setPersisted]
  )

  const logout = useCallback(() => {
    setSessionUser(null)
    setPersisted((prev) => ({
      user: null,
      autoLogin: false,
      // 아이디는 다음 로그인 폼을 위해 남겨 둔다.
      lastUsername: prev.lastUsername,
    }))
  }, [setPersisted])

  const value = useMemo(
    () => ({
      user: sessionUser,
      isAuthenticated: sessionUser !== null,
      lastUsername: persisted.lastUsername,
      login,
      logout,
    }),
    [sessionUser, persisted.lastUsername, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
