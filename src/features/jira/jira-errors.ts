/**
 * Rust 에서 올라온 Jira 오류 문자열을 사람이 읽을 수 있는 한국어 문장으로 바꾼다.
 * (Rust 는 "unauthorized" 같은 짧은 코드나 "http_500: ..." 형태로 준다.)
 */
export function friendlyError(raw: string): string {
  const msg = raw.replace(/^Error:\s*/, "").trim()

  if (msg === "no_config")
    return "Jira 설정이 없습니다. 설정 → Jira 에서 사이트 주소·이메일·API 토큰을 입력해 주세요."
  if (msg === "unauthorized")
    return "인증에 실패했습니다. 이메일과 API 토큰을 확인해 주세요(비밀번호가 아니라 API 토큰이어야 합니다)."
  if (msg === "forbidden")
    return "권한이 없습니다. 해당 사이트·프로젝트에 접근 권한이 있는 계정인지 확인해 주세요."
  if (msg === "empty_url") return "사이트 주소를 입력해 주세요."
  if (msg === "empty_user") return "계정 이메일을 입력해 주세요."
  if (msg === "empty_token") return "API 토큰을 입력해 주세요."
  if (msg.startsWith("not_found:"))
    return "요청한 API 를 찾을 수 없습니다. 사이트 주소가 올바른지 확인해 주세요."
  if (msg.startsWith("network:"))
    return "네트워크 오류입니다. 사이트 주소와 인터넷 연결(사내망/VPN)을 확인해 주세요."
  if (msg.startsWith("invalid_json"))
    return "Jira 응답을 해석하지 못했습니다. 사이트 주소가 Jira Cloud 주소인지 확인해 주세요."
  if (msg.startsWith("http_429"))
    return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요."

  return msg
}
