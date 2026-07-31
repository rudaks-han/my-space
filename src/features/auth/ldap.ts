import { isTauri, trackedInvoke } from "@/lib/tauri"
import type { AuthUser } from "@/features/auth/auth-context"

/**
 * 아이디·비밀번호로 사내 LDAP 인증을 한다. 성공하면 표시용 사용자 정보를 돌려주고,
 * 실패하면 Rust 가 올린 한국어 메시지를 그대로 throw 한다.
 */
export async function ldapLogin(
  username: string,
  password: string
): Promise<AuthUser> {
  if (!isTauri()) {
    throw new Error("데스크톱 앱에서만 로그인할 수 있습니다.")
  }
  return trackedInvoke<AuthUser>("ldap_login", { username, password })
}
