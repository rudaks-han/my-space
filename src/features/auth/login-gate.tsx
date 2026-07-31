import type { ReactNode } from "react"

import { useAuth } from "@/features/auth/auth-context"
import { LoginView } from "@/features/auth/login-view"

/**
 * 로그인 여부에 따라 셸(children) 또는 로그인 폼을 그린다.
 *
 * 로그인 전에는 children 이 렌더되지 않으므로 각 탭 뷰가 마운트되지 않는다(폴링·조회
 * 시작 안 됨). AuthProvider 안에 있어야 한다.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth()
  return isAuthenticated ? <>{children}</> : <LoginView />
}
