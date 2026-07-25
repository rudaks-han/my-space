import {
  CheckCircle2Icon,
  HistoryIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type {
  ClaudeActivity,
  ClaudeActivityKind,
} from "@/features/claude-bridge/use-claude-activity"
import { HomeCard, HomeEmpty } from "../home-card"
import { fmtClock, fmtDuration } from "../home-utils"

/** 홈에 보여줄 최대 이력 수. */
const MAX_ROWS = 8

const KIND: Record<
  ClaudeActivityKind,
  { icon: LucideIcon; text: string; color: string; dot: string }
> = {
  started: {
    icon: PlayCircleIcon,
    text: "시작",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
  blocked: {
    icon: PauseCircleIcon,
    text: "입력 대기",
    color: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  done: {
    icon: CheckCircle2Icon,
    text: "완료",
    color: "text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
  },
}

/**
 * Claude Code 작업 이력 타임라인 — 자리를 비운 동안 무엇이 시작·완료됐는지 본다.
 * 데이터는 ClaudeActivityProvider 가 herdr 상태 전환을 감지해 최근 24시간만 쌓아 둔다.
 */
export function ClaudeActivityCard({
  activities,
  onClear,
  onFocus,
}: {
  activities: ClaudeActivity[]
  onClear: () => void
  onFocus: (session: string, workspaceId: string) => void
}) {
  const rows = activities.slice(0, MAX_ROWS)

  return (
    <HomeCard
      icon={HistoryIcon}
      title="작업 이력 (최근 24시간)"
      count={activities.length}
      action={
        activities.length > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            비우기
          </button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <HomeEmpty>아직 기록된 작업이 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col">
          {rows.map((a, i) => {
            const k = KIND[a.kind]
            const duration = fmtDuration(a.durationMs)
            const last = i === rows.length - 1
            return (
              <li key={a.id} className="flex gap-3">
                {/* 왼쪽 타임라인 축 */}
                <div className="flex flex-col items-center pt-1.5">
                  <span className={cn("size-2 shrink-0 rounded-full", k.dot)} />
                  {!last && <span className="w-px flex-1 bg-border" />}
                </div>
                <div
                  className={cn(
                    "flex min-w-0 flex-1 items-start gap-2",
                    last ? "pb-0" : "pb-3"
                  )}
                >
                  <span className="w-10 shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    {fmtClock(a.at)}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline gap-1.5">
                      <span
                        className={cn(
                          "shrink-0 text-xs font-semibold",
                          k.color
                        )}
                      >
                        {k.text}
                      </span>
                      <span className="truncate text-sm">{a.label}</span>
                    </span>
                    {(duration || a.recap) && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {duration && `${duration} 소요`}
                        {duration && a.recap && " · "}
                        {a.recap}
                      </span>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-xs"
                    onClick={() => onFocus(a.session, a.workspaceId)}
                  >
                    이동 →
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </HomeCard>
  )
}
