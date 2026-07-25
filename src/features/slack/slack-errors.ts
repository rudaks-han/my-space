/** Slack API 오류 코드를 사용자용 한국어 메시지로. */
export function friendlyError(code: string): string {
  if (code.includes("missing_scope"))
    return "토큰에 메시지 읽기 권한(*:history)이 없습니다. OAuth & Permissions 에서 아래 스코프를 모두 추가하고 Reinstall to Workspace 후 새 토큰으로 다시 연결하세요."
  if (code.includes("invalid_auth") || code.includes("not_authed"))
    return "토큰이 유효하지 않습니다. xoxp- 로 시작하는 User OAuth Token 인지 확인하세요."
  if (code.includes("token_revoked") || code.includes("account_inactive"))
    return "토큰이 만료/취소되었습니다. 새로 발급해 주세요."
  if (code.includes("rate_limited"))
    return "Slack 요청 한도에 걸렸습니다. 잠시 후 다시 시도하세요."
  return `오류: ${code}`
}
