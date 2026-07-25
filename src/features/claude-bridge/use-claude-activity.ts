import { createContext, useContext } from "react"

/** 작업 이력 한 줄의 종류. started=시작, blocked=입력 대기 진입, done=완료. */
export type ClaudeActivityKind = "started" | "blocked" | "done"

/** Claude Code 작업 이력 한 건(상태 전환 시점의 스냅샷). */
export interface ClaudeActivity {
  id: string
  kind: ClaudeActivityKind
  /** herdr 세션 이름(default 세션이면 "default"). "이동" 라우팅에 사용. */
  session: string
  workspaceId: string
  /** 표시용 이름(마지막 프롬프트 요약 우선). */
  label: string
  /** 완료 시점의 recap 요약. 없으면 null. */
  recap: string | null
  /** 발생 시각(epoch ms). */
  at: number
  /** done 일 때 working 진입부터 걸린 시간(ms). 알 수 없으면 null. */
  durationMs: number | null
}

export interface ClaudeActivityContextValue {
  /** 최근순(최신이 먼저) 이력. 최근 24시간·최대 100건만 유지된다. */
  activities: ClaudeActivity[]
  /** 이력을 모두 비운다. */
  clear: () => void
}

export const ClaudeActivityContext =
  createContext<ClaudeActivityContextValue | null>(null)

/**
 * Claude Code 작업 이력(시작·입력 대기·완료)을 제공하는 훅.
 * `ClaudeActivityProvider` 안에서만 쓸 수 있다.
 */
export function useClaudeActivity() {
  const ctx = useContext(ClaudeActivityContext)
  if (!ctx) {
    throw new Error(
      "useClaudeActivity 는 ClaudeActivityProvider 안에서만 사용할 수 있습니다."
    )
  }
  return ctx
}
