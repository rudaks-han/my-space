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

/** 도메인 비밀번호 정책 + 이 사용자의 만료 예정일. 값은 Rust 가 AD 에서 그때그때 읽어 온다. */
export interface PasswordPolicy {
  /** 최소 길이. */
  minLength: number
  /** 복잡도(문자 종류 3가지 이상) 요구 여부. */
  complexity: boolean
  /** 재사용이 금지되는 최근 비밀번호 개수. */
  historyLength: number
  /** 만료 주기(일). 만료 없으면 null. */
  maxAgeDays: number | null
  /** 변경 후 재변경까지 기다려야 하는 기간(일). 없으면 null. */
  minAgeDays: number | null
  /** 마지막 변경 시각(epoch ms). "다음 로그온 시 변경"이면 null. */
  lastSetAt: number | null
  /** 만료 예정 시각(epoch ms). 만료 없는 계정이면 null. */
  expiresAt: number | null
  /** 계정에 사용 기간 제한 없음이 걸려 있는지. */
  neverExpires: boolean
}

/** 도메인 정책과 만료일을 읽는다(조회만 — 비밀번호를 보내지 않는다). */
export async function fetchPasswordPolicy(
  username: string
): Promise<PasswordPolicy> {
  if (!isTauri()) {
    throw new Error("데스크톱 앱에서만 사용할 수 있습니다.")
  }
  return trackedInvoke<PasswordPolicy>("ldap_password_policy", { username })
}

/**
 * 사내 LDAP 비밀번호를 바꾼다. 현재 비밀번호로 본인 확인을 한 뒤 AD 의 "본인 변경"
 * 방식으로 수정하므로, 실패 사유(정책 위반·최소 사용 기간 등)는 서버가 판정한 것이
 * 한국어 메시지로 올라온다.
 */
export async function changeLdapPassword(
  username: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  if (!isTauri()) {
    throw new Error("데스크톱 앱에서만 사용할 수 있습니다.")
  }
  await trackedInvoke<null>("ldap_change_password", {
    username,
    currentPassword,
    newPassword,
  })
}
