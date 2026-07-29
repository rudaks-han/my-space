/** Google 캘린더 오류 코드를 사용자용 한국어 메시지로. */
export function friendlyError(code: string): string {
  if (code.includes("invalid_grant"))
    return "연결이 만료되었거나 취소되었습니다. 설정 → Google Calendar 에서 연결을 해제하고 다시 로그인해 주세요."
  if (code.includes("refresh_token"))
    return "권한 승인이 완료되지 않았습니다. 구글 동의 화면에서 캘린더 접근을 허용해 주세요."
  if (code.includes("timeout"))
    return "로그인 대기 시간이 초과되었습니다. '연결'을 다시 눌러 진행해 주세요."
  if (code.includes("access_denied"))
    return "접근이 거부되었습니다. 동의 화면에서 허용해야 합니다."
  if (code.includes("not_connected")) return "아직 연결되지 않았습니다."
  if (code.includes("need_reconnect"))
    return "회의실 예약 권한이 없습니다. 설정 → Google Calendar 에서 연결을 해제하고 다시 로그인하면 예약 권한을 받습니다."
  if (code.includes("need_directory_scope"))
    return "구성원 주소록 권한이 없습니다. 설정 → Google Calendar 에서 연결을 해제하고 다시 로그인해 주세요."
  if (code.includes("directory_unavailable"))
    return "도메인 주소록을 불러오지 못했습니다. Workspace 관리자가 주소록 공유를 켜야 구성원을 검색할 수 있습니다."
  if (code.includes("이미 예약")) return "해당 시간대에 이미 예약이 있습니다."
  return `오류: ${code}`
}
