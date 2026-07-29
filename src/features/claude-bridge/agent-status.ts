/**
 * herdr agent_status 표시 규칙(작업목록 화면과 홈 화면이 공유한다).
 * 상태 값: working(진행중) / idle(완료·대기) / blocked(입력 대기) / done / unknown(에이전트 없음).
 */

/** 상태 정렬 우선순위(작은 값이 위). 진행 중 > 입력 대기 > 완료 > 대기 > 기타. */
export const STATUS_ORDER: Record<string, number> = {
  working: 0,
  blocked: 1,
  done: 2,
  idle: 3,
}

export interface StatusInfo {
  /** 사용자용 라벨. */
  text: string
  /** 카드 왼쪽 스트라이프 border 색. */
  border: string
  /**
   * 상태 칩 클래스. Slack 의 알약 칩 그대로 — rounded-full · 11px bold · 15% 틴트 배경.
   * 호출부는 배치 클래스(inline-flex/gap 등)만 덧붙이면 된다.
   */
  chip: string
  /** 진행 중일 때 깜빡임. */
  pulse: boolean
}

/** agent_status → 사용자용 라벨 + 색상. */
export function statusInfo(status: string): StatusInfo {
  switch (status) {
    case "working":
      return {
        text: "진행 중",
        border: "border-l-ui-success",
        chip: "rounded-full bg-ui-success/15 px-2 text-[11px] font-bold text-ui-success",
        pulse: true,
      }
    case "blocked":
      return {
        text: "입력 대기",
        border: "border-l-ui-warning",
        chip: "rounded-full bg-ui-warning/15 px-2 text-[11px] font-bold text-ui-warning",
        pulse: false,
      }
    case "done":
      return {
        text: "완료",
        border: "border-l-ui-info",
        chip: "rounded-full bg-ui-info/15 px-2 text-[11px] font-bold text-ui-info",
        pulse: false,
      }
    case "idle":
      return {
        text: "대기",
        border: "border-l-muted-foreground/40",
        chip: "rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground",
        pulse: false,
      }
    default:
      return {
        text: status,
        border: "border-l-muted-foreground/30",
        chip: "rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground",
        pulse: false,
      }
  }
}
