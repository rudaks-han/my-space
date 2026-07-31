import { createContext, useContext } from "react"

/*
 * 로그인 상태의 타입·Context·훅. AuthProvider(컴포넌트)는 auth-store.tsx 에 있다.
 * 컴포넌트 파일이 컴포넌트 외의 값을 export 하면 fast refresh 가 깨지므로 여기로 분리했다.
 */

/** LDAP 로그인 성공 시 받는 표시용 사용자 정보(Rust `ldap_login` 이 돌려주는 모양과 같다). */
export interface AuthUser {
  /** 로그인 계정(sAMAccountName). */
  username: string
  /** 사용자 전체 DN. */
  dn: string
  /** 표시 이름. */
  displayName: string
  /** 이메일. */
  email: string
}

/**
 * localStorage 에 저장하는 로그인 상태.
 *
 * 자동 로그인이 켜져 있을 때만 `user` 를 저장한다 — 그래야 다음 실행에서 LDAP 요청 없이
 * 바로 로그인된 상태로 들어간다. 자동 로그인이 꺼져 있으면 `user` 는 저장하지 않으므로
 * 다음 실행에서 다시 로그인 폼을 띄운다. `lastUsername` 은 폼 아이디 칸을 채워 주기 위해
 * 자동 로그인 여부와 무관하게 마지막 로그인 아이디를 기억해 둔다.
 */
export interface PersistedAuth {
  user: AuthUser | null
  autoLogin: boolean
  lastUsername: string
}

export const AUTH_STORAGE_KEY = "myspace.auth"

export const DEFAULT_AUTH: PersistedAuth = {
  user: null,
  autoLogin: false,
  lastUsername: "",
}

export interface AuthContextValue {
  /** 현재 세션의 로그인 사용자(로그인 안 됐으면 null). */
  user: AuthUser | null
  /** 로그인 여부. */
  isAuthenticated: boolean
  /** 마지막으로 로그인한 아이디(폼 자동 채움용). */
  lastUsername: string
  /** LDAP 인증에 성공한 뒤 호출한다. autoLogin 이 true 면 다음 실행부터 자동 로그인된다. */
  login: (user: AuthUser, autoLogin: boolean) => void
  /** 로그아웃 — 세션과 저장된 자동 로그인 정보를 지운다. */
  logout: () => void
}

export const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error("useAuth 는 AuthProvider 안에서만 사용할 수 있습니다.")
  }
  return ctx
}
