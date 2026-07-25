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
  /** 상태 칩 배경·글자색. */
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
        border: "border-l-green-500",
        chip: "bg-green-500/15 text-green-600 dark:text-green-400",
        pulse: true,
      }
    case "blocked":
      return {
        text: "입력 대기",
        border: "border-l-amber-500",
        chip: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        pulse: false,
      }
    case "done":
      return {
        text: "완료",
        border: "border-l-blue-500",
        chip: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
        pulse: false,
      }
    case "idle":
      return {
        text: "대기",
        border: "border-l-muted-foreground/40",
        chip: "bg-muted text-muted-foreground",
        pulse: false,
      }
    default:
      return {
        text: status,
        border: "border-l-muted-foreground/30",
        chip: "bg-muted text-muted-foreground",
        pulse: false,
      }
  }
}
