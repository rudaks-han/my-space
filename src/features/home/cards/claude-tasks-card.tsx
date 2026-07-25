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
 * Claude Code 작업 현황 — 진행 중 → 입력 대기 → 완료 순으로 상위 몇 건만.
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
  const tasks = [
    ...workspaces.filter((w) => w.agent_status !== "unknown"),
  ].sort((a, b) => {
    const sa = STATUS_ORDER[a.agent_status] ?? 9
    const sb = STATUS_ORDER[b.agent_status] ?? 9
    if (sa !== sb) return sa - sb
    return (b.last_prompt_at ?? "").localeCompare(a.last_prompt_at ?? "")
  })
  const rows = tasks.slice(0, MAX_ROWS)
  // 여러 herdr 세션이 동시에 떠 있으면 어느 세션인지 태그로 구분해 준다.
  const multiSession = new Set(tasks.map((t) => t.session)).size > 1

  return (
    <HomeCard
      icon={BotIcon}
      title="Claude Code 작업"
      count={tasks.length}
      menuId="claude-bridge"
    >
      {!watching && (
        <p className="mb-2 text-xs text-muted-foreground">
          작업 감시가 꺼져 있습니다 — 설정 → Claude Code 에서 켜면 갱신됩니다.
        </p>
      )}
      {error && (
        <p className="mb-2 text-xs text-destructive">
          herdr 응답 없음: {error}
        </p>
      )}
      {rows.length === 0 ? (
        <HomeEmpty>실행 중인 작업이 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((w) => {
            const s = statusInfo(w.agent_status)
            const elapsed = w.last_prompt_at
              ? fmtAgo(new Date(w.last_prompt_at).getTime(), now)
              : null
            const tokens = fmtTokens(w.token_usage)
            return (
              <li
                key={`${w.session} ${w.workspace_id}`}
                className={cn(
                  "flex items-start gap-2 rounded-lg border border-l-4 bg-muted/30 px-3 py-2",
                  s.border
                )}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5">
                    {multiSession && (
                      <span className="shrink-0 rounded bg-muted px-1 font-mono text-[11px] text-muted-foreground">
                        {w.session}
                      </span>
                    )}
                    <span className="truncate text-sm font-medium">
                      {w.label || w.workspace_id}
                    </span>
                  </span>
                  {(w.recap || w.last_prompt) && (
                    <span
                      title={w.recap ?? w.last_prompt ?? undefined}
                      className="line-clamp-1 text-xs text-muted-foreground"
                    >
                      {w.recap ?? w.last_prompt}
                    </span>
                  )}
                  {(elapsed || tokens) && (
                    <span className="flex items-center gap-2.5 text-[11px] text-muted-foreground/80">
                      {elapsed && (
                        <span className="inline-flex items-center gap-1">
                          <ClockIcon className="size-3" />
                          {elapsed}
                        </span>
                      )}
                      {tokens && (
                        <span className="inline-flex items-center gap-1">
                          <CoinsIcon className="size-3" />
                          {tokens} tok
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
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
                    className="h-6 px-2 text-xs"
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
        <p className="mt-2 text-center text-xs text-muted-foreground">
          외 {tasks.length - rows.length}건
        </p>
      )}
    </HomeCard>
  )
}
