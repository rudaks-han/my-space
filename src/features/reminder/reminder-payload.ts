/**
 * 지금 떠 있는 알림 한 건 — Rust `reminder::ReminderPayload` 와 대응한다.
 *
 * 알림 목록 자체(`use-reminders.ts` 의 `Reminder`)와는 다른 타입이다: 저장된 알림에서
 * 표시에 필요한 것만 뽑아 `reminder_fire` 로 넘긴 뒤, `reminder:fire` 이벤트와
 * `reminder_current` 조회로 되돌려 받는 모양이다.
 *
 * 별도 파일로 둔 이유: 표시하는 쪽은 펫 창(`use-pet-mood.ts`)이고, 스케줄러
 * (`reminder-store.tsx`)는 메인 창에만 마운트된다 — 펫이 스토어 모듈을 끌어오지 않도록
 * 타입만 따로 뺀다.
 */
export interface ReminderPayload {
  /** 프론트엔드 알림 id(중복 발생 방지·닫기 매칭용). */
  id: string
  title: string
  /** 부제(예: 예정 시각 문구). 없으면 빈 문자열. */
  body: string
}
