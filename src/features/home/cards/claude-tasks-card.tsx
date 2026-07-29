import { BotIcon, ClockIcon, CoinsIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { STATUS_ORDER, statusInfo } from "@/features/claude-bridge/agent-status"
import type { HerdrWorkspace } from "@/features/claude-bridge/use-herdr"
import { HomeCard, HomeEmpty } from "../home-card"
import { fmtAgo } from "../home-utils"

/** 홈에 보여줄 최대 작업 수(나머지는 "전체 보기"로). */
const MAX_ROWS = 5

/** 토큰 수를 1.2k / 34k 형태로. */
function fmtTokens(n: number | null): string | null {
  if (!n || n <= 0) return null
  if (n < 1000) return `${n}`
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/**
 * Claude Code 진행 현황 — "지금 살아 있는" 세션만 본다.
 * 진행 중(working) → 입력 대기(blocked) 순으로 정렬하고, 완료·대기(done/idle)와
 * 에이전트 없음(unknown)은 제외한다(작업 이력은 홈에서 다루지 않는다).
 * "이동"을 누르면 해당 터미널로 전환한다.
 */
export function ClaudeTasksCard({
  workspaces,
  watching,
  error,
  now,
  onFocus,
}: {
  workspaces: HerdrWorkspace[]
  watching: boolean
  error: string | null
  /** 현재 시각(epoch ms) — 홈 화면이 주기적으로 갱신해 내려준다. */
  now: number
  onFocus: (session: string, workspaceId: string) => void
}) {
  const tasks = workspaces
    .filter((w) => w.agent_status === "working" || w.agent_status === "blocked")
    .sort((a, b) => {
      const sa = STATUS_ORDER[a.agent_status] ?? 9
      const sb = STATUS_ORDER[b.agent_status] ?? 9
      if (sa !== sb) return sa - sb
      return (b.last_prompt_at ?? "").localeCompare(a.last_prompt_at ?? "")
    })
  const rows = tasks.slice(0, MAX_ROWS)
  const workingCount = tasks.filter((w) => w.agent_status === "working").length
  const blockedCount = tasks.length - workingCount
  // 여러 herdr 세션이 동시에 떠 있으면 어느 세션인지 태그로 구분해 준다.
  const multiSession = new Set(tasks.map((t) => t.session)).size > 1

  return (
    <HomeCard
      icon={BotIcon}
      title="진행 중인 작업"
      count={tasks.length}
      menuId="claude-bridge"
      action={
        tasks.length > 0 ? (
          // 진행/대기 비율을 한 줄 요약으로 — 카드를 열지 않아도 상태가 잡힌다.
          <span className="flex items-center gap-2.5 text-[13px] font-semibold">
            {workingCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-ui-success">
                <span className="inline-block size-1.5 rounded-full bg-ui-success" />
                진행 {workingCount}
              </span>
            )}
            {blockedCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-ui-warning">
                <span className="inline-block size-1.5 rounded-full bg-ui-warning" />
                대기 {blockedCount}
              </span>
            )}
          </span>
        ) : undefined
      }
    >
      {!watching && (
        <p className="mb-1.5 px-3 text-[13px] text-muted-foreground">
          작업 감시가 꺼져 있습니다 — 설정 → Claude Code 에서 켜면 갱신됩니다.
        </p>
      )}
      {error && (
        <p className="mb-1.5 px-3 text-[13px] font-semibold text-ui-error">
          herdr 응답 없음: {error}
        </p>
      )}
      {rows.length === 0 ? (
        <HomeEmpty>실행 중인 작업이 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {rows.map((w) => {
            const s = statusInfo(w.agent_status)
            const elapsed = w.last_prompt_at
              ? fmtAgo(new Date(w.last_prompt_at).getTime(), now)
              : null
            const tokens = fmtTokens(w.token_usage)
            return (
              <li
                key={`${w.session} ${w.workspace_id}`}
                className="flex min-h-9 items-start gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-ui-list-hover"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2">
                    {multiSession && (
                      // 세션 꼬리표 — 아주 작은 회색 알약(§2.4 의 꼬리표 규칙).
                      <span className="shrink-0 rounded-full bg-muted px-2 font-mono text-[11px] font-bold text-muted-foreground">
                        {w.session}
                      </span>
                    )}
                    <span className="truncate text-[15px] font-bold">
                      {w.label || w.workspace_id}
                    </span>
                  </span>
                  {(w.recap || w.last_prompt) && (
                    <span
                      title={w.recap ?? w.last_prompt ?? undefined}
                      className="line-clamp-1 text-[13px] text-muted-foreground"
                    >
                      {w.recap ?? w.last_prompt}
                    </span>
                  )}
                  {(elapsed || tokens) && (
                    <span className="mt-0.5 flex items-center gap-3 text-[13px] text-muted-foreground">
                      {elapsed && (
                        <span className="inline-flex items-center gap-1">
                          <ClockIcon className="size-3.5" />
                          {elapsed}
                        </span>
                      )}
                      {tokens && (
                        <span className="inline-flex items-center gap-1">
                          <CoinsIcon className="size-3.5" />
                          {tokens} tok
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={cn(
                      "inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] font-bold",
                      s.chip,
                      s.pulse && "animate-pulse"
                    )}
                  >
                    {s.pulse && (
                      <span className="inline-block size-1.5 rounded-full bg-current" />
                    )}
                    {s.text}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="rounded-full px-2.5 text-[13px]"
                    onClick={() => onFocus(w.session, w.workspace_id)}
                  >
                    이동 →
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {tasks.length > rows.length && (
        <p className="mt-1.5 text-center text-[13px] text-muted-foreground">
          외 {tasks.length - rows.length}건
        </p>
      )}
    </HomeCard>
  )
}
