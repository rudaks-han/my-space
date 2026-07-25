import {
  AlertCircleIcon,
  AtSignIcon,
  BellRingIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  PauseCircleIcon,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useNavigate } from "@/lib/use-navigation"
import type { HerdrWorkspace } from "@/features/claude-bridge/use-herdr"
import type { CalendarEvent } from "@/features/gcal/use-gcal"
import type { Reminder } from "@/features/reminder/use-reminders"
import type { ChannelUnread } from "@/features/slack/use-slack"
import { HomeCard } from "../home-card"
import {
  fmtAgo,
  fmtClock,
  isEventNow,
  isRecentlyFired,
  minutesUntil,
} from "../home-utils"

/** 일정이 곧 시작한다고 볼 기준(분). */
const SOON_MIN = 15

interface ActionItem {
  id: string
  icon: LucideIcon
  /** 왼쪽 스트라이프 + 아이콘 색. */
  tone: "amber" | "blue" | "violet" | "rose"
  title: string
  sub: ReactNode
  actionLabel: string
  onAction: () => void
}

const TONE = {
  amber: {
    border: "border-l-amber-500",
    icon: "text-amber-600 dark:text-amber-400",
  },
  blue: {
    border: "border-l-blue-500",
    icon: "text-blue-600 dark:text-blue-400",
  },
  violet: {
    border: "border-l-violet-500",
    icon: "text-violet-600 dark:text-violet-400",
  },
  rose: {
    border: "border-l-rose-500",
    icon: "text-rose-600 dark:text-rose-400",
  },
}

/**
 * "지금 확인 필요" — 내 응답을 기다리는 것만 모아 홈 최상단에 보여준다.
 * 우선순위: Claude 입력 대기 → 진행 중·곧 시작할 일정 → 나에게 온 Slack 메시지(DM·그룹DM)
 * → 최근에 울린 1회성 알림. 모두 시간이 지나면 자연히 사라지는 항목들만 넣는다
 * (읽음 처리 개념이 없는 항목을 넣으면 영구히 남아 카드가 무의미해진다).
 */
export function ActionRequiredCard({
  workspaces,
  events,
  channels,
  reminders,
  now,
  onFocusWorkspace,
  onOpenMessage,
}: {
  workspaces: HerdrWorkspace[]
  events: CalendarEvent[]
  channels: ChannelUnread[]
  reminders: Reminder[]
  /** 현재 시각(epoch ms) — 홈 화면이 주기적으로 갱신해 내려준다. */
  now: number
  onFocusWorkspace: (session: string, workspaceId: string) => void
  onOpenMessage: (
    channelId: string,
    ts: string,
    threadTs: string | null
  ) => void
}) {
  const navigate = useNavigate()
  const items: ActionItem[] = []

  // 1) Claude Code 입력 대기 — 가장 급하다(작업이 멈춰 있다).
  for (const w of workspaces.filter((w) => w.agent_status === "blocked")) {
    items.push({
      id: `ws-${w.session}-${w.workspace_id}`,
      icon: PauseCircleIcon,
      tone: "amber",
      title: w.label || w.workspace_id,
      sub: w.last_prompt ?? "선택이나 응답을 기다리고 있습니다.",
      actionLabel: "이동",
      onAction: () => onFocusWorkspace(w.session, w.workspace_id),
    })
  }

  // 2) 지금 진행 중이거나 곧 시작하는 일정.
  for (const ev of events) {
    const running = isEventNow(ev, now)
    const min = minutesUntil(ev, now)
    const soon = min != null && min >= 0 && min <= SOON_MIN
    if (!running && !soon) continue
    items.push({
      id: `ev-${ev.start}-${ev.summary}`,
      icon: CalendarClockIcon,
      tone: "violet",
      title: ev.summary,
      sub: running
        ? `진행 중 · ${fmtClock(ev.start)} ~ ${fmtClock(ev.end)}`
        : `${min}분 후 시작 · ${fmtClock(ev.start)}`,
      actionLabel: ev.meet_link ? "회의 참여" : "일정 보기",
      onAction: () => {
        // 링크는 시스템 브라우저로 연다(ExternalLinkGuard 는 <a> 클릭만 가로채므로 직접 호출).
        // 정적 import 하면 opener 플러그인이 메인 번들로 끌려오므로 동적 import 로 맞춘다.
        const link = ev.meet_link ?? ev.html_link
        if (!link) {
          navigate("gcal")
          return
        }
        void import("@tauri-apps/plugin-opener").then(({ openUrl }) =>
          openUrl(link)
        )
      },
    })
  }

  // 3) 나에게 직접 온 Slack 메시지(DM·그룹 DM)만. 일반 채널은 아래 별도 카드에서 본다.
  for (const c of channels.filter(
    (c) => (c.kind === "im" || c.kind === "mpim") && c.unread > 0
  )) {
    const latest = c.messages.at(-1)
    items.push({
      id: `slack-${c.id}`,
      icon: AtSignIcon,
      tone: "blue",
      title: c.name,
      sub: latest
        ? `${latest.user}: ${latest.text}`
        : `안 읽은 메시지 ${c.unread}건`,
      actionLabel: "열기",
      onAction: () => {
        if (latest) onOpenMessage(c.id, latest.ts, latest.thread_ts)
        else navigate("slack")
      },
    })
  }

  // 4) 최근 2시간 안에 울린 1회성 알림 — 트레이 팝오버를 놓쳤을 수 있다.
  for (const r of reminders.filter((r) => isRecentlyFired(r, now))) {
    items.push({
      id: `rem-${r.id}`,
      icon: BellRingIcon,
      tone: "rose",
      title: r.title,
      sub: `${fmtAgo(r.firedAt!, now)} 알림이 울렸습니다.`,
      actionLabel: "알림 보기",
      onAction: () => navigate("reminder"),
    })
  }

  const empty = items.length === 0

  return (
    <HomeCard
      icon={empty ? CheckCircle2Icon : AlertCircleIcon}
      title="지금 확인 필요"
      count={items.length}
      tone={empty ? "default" : "alert"}
    >
      {empty ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          확인할 항목이 없습니다 ✨
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => {
            const tone = TONE[it.tone]
            return (
              <li
                key={it.id}
                className={cn(
                  "flex items-center gap-3 rounded-lg border border-l-4 bg-muted/30 px-3 py-2",
                  tone.border
                )}
              >
                <it.icon className={cn("size-4 shrink-0", tone.icon)} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {it.title}
                  </span>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {it.sub}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={it.onAction}
                >
                  {it.actionLabel}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </HomeCard>
  )
}
