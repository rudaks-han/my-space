import { useEffect, useState } from "react"
import { getVersion } from "@tauri-apps/api/app"
import type { LucideIcon } from "lucide-react"
import {
  BellIcon,
  BotIcon,
  CheckSquareIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  SettingsIcon,
} from "lucide-react"

import { ClaudeBrandIcon } from "@/components/brand-icons"
import {
  useClaudeUsage,
  type ClaudeUsage,
  type UsageWindow,
} from "@/features/claude-bridge/use-claude-usage"
import { useHerdr } from "@/features/claude-bridge/use-herdr"
import { reminderNextAt } from "@/features/home/home-utils"
import { useNow } from "@/lib/use-now"
import { useReminders } from "@/features/reminder/use-reminders"
import { useSlack } from "@/features/slack/use-slack"
import { useStickies } from "@/features/todo/use-todos"
import { SETTINGS_ID } from "@/lib/use-open-tabs"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"

/**
 * 앱 버전 — **하드코딩하지 않는다.** `getVersion()` 이 tauri.conf.json 의 `version` 을
 * 그대로 돌려주므로, 릴리스 때 거기만 올리면 상태바도 따라온다(예전엔 별도 상수라
 * 실제 설치 버전과 어긋났다). 브라우저 등 Tauri 밖에서는 표시하지 않는다.
 */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    getVersion()
      .then((v) => alive && setVersion(v))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return version
}

/** 개수 강조 색 — Slack 팔레트(안읽음 빨강 / 진행 초록 / 대기 노랑). */
type StatusTone = "error" | "success" | "warning"

const TONE_CLASS: Record<StatusTone, string> = {
  error: "text-ui-error font-bold",
  success: "text-ui-success font-bold",
  warning: "text-ui-warning font-bold",
}

interface StatusItemProps {
  icon: LucideIcon
  /** 아이콘 뒤에 붙는 라벨. 없으면 아이콘만. */
  text?: string
  /** 접근성 라벨(아이콘만 있는 항목에 필요). */
  ariaLabel: string
  /** 개수 강조 색. 없으면 크롬 기본 색을 쓴다. */
  tone?: StatusTone
  /** 없으면 클릭할 수 없는 표시 전용 항목이 된다. */
  onClick?: () => void
}

/** 상태바 항목 한 칸(알약 hover). */
function StatusItem({
  icon: Icon,
  text,
  ariaLabel,
  tone,
  onClick,
}: StatusItemProps) {
  const base =
    "flex h-full items-center gap-1.5 rounded-lg px-2 transition-colors"
  const label = text && (
    <span className={tone ? TONE_CLASS[tone] : undefined}>{text}</span>
  )
  if (!onClick) {
    return (
      <span className={cn(base, "cursor-default")} aria-label={ariaLabel}>
        <Icon className="size-3.5" />
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(base, "cursor-pointer hover:bg-ui-statusbar-hover")}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

/** 사용률(%) → 게이지 색. 여유(초록) → 임박(노랑) → 한계 근접(빨강). */
function usageBarClass(pct: number): string {
  if (pct >= 90) return "bg-ui-error"
  if (pct >= 70) return "bg-ui-warning"
  return "bg-ui-success"
}

/** resets_at(ISO UTC) → epoch ms. 없거나 파싱 실패 시 null. */
function resetAt(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/** resets_at(ISO UTC) → 로컬 "HH:MM". 파싱 실패 시 null. */
function fmtReset(iso: string | null): string | null {
  const t = resetAt(iso)
  if (t == null) return null
  return new Date(t).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * 초기화까지 남은 시간 → 상태바용 짧은 표기("2d 5h" / "3h 12m" / "45m" / "1m").
 * 이미 지난 창은 다음 폴링에서 새 resets_at 이 오므로 null 로 두고 표시하지 않는다.
 */
function fmtRemaining(iso: string | null, now: number): string | null {
  const t = resetAt(iso)
  if (t == null) return null
  const mins = Math.ceil((t - now) / 60_000)
  if (mins <= 0) return null
  const days = Math.floor(mins / (24 * 60))
  const hours = Math.floor((mins % (24 * 60)) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  const rest = mins % 60
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}

/** 툴팁용 한국어 남은 시간("2일 5시간 남음"). */
function fmtRemainingKo(iso: string | null, now: number): string | null {
  const short = fmtRemaining(iso, now)
  if (!short) return null
  const ko = short
    .replace(/(\d+)d/, "$1일")
    .replace(/(\d+)h/, "$1시간")
    .replace(/(\d+)m/, "$1분")
  return `${ko} 남음`
}

/**
 * 사용량 창 하나 — 자기 사용률만큼 채운 게이지 + `65% 5h (1h 14m)` 텍스트.
 * 게이지 색은 **그 창의** 사용률로 정한다(5h·주간이 서로 다른 색일 수 있다).
 */
function UsageSegment({
  label,
  win,
  now,
}: {
  label: string
  win: UsageWindow
  now: number
}) {
  const left = fmtRemaining(win.resets_at, now)
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-1.5 w-8 overflow-hidden rounded-full bg-ui-chrome-active">
        <span
          className={cn(
            "block h-full rounded-full",
            usageBarClass(win.utilization)
          )}
          style={{ width: `${Math.min(win.utilization, 100)}%` }}
        />
      </span>
      <span className="tabular-nums">
        {Math.round(win.utilization)}% {label}
        {left && ` (${left})`}
      </span>
    </span>
  )
}

/**
 * Claude Code 남은 사용량 — 5시간 세션·주간(week) 사용률을 **각각** 게이지 + 퍼센트로
 * 나란히 그린다(`65% 5h (1h 14m) · 81% week (2d 12h)`). 하나의 바로 합치면 더 높은 창의
 * 값이 낮은 창의 숫자 옆에 붙어 오해를 부르므로(예: 바는 81%, 숫자는 65%), 창마다 자기
 * 바를 갖는다. 초기화 시각은 툴팁에 있고, 자격증명이 없거나 두 창 모두 비면 그리지 않는다.
 */
function UsageMeter({ usage, now }: { usage: ClaudeUsage; now: number }) {
  const five = usage.five_hour
  const week = usage.seven_day
  if (!five && !week) return null

  const parts = [
    five &&
      [
        `5시간 ${Math.round(five.utilization)}%`,
        fmtRemainingKo(five.resets_at, now),
        fmtReset(five.resets_at) && `${fmtReset(five.resets_at)} 초기화`,
      ]
        .filter(Boolean)
        .join(" · "),
    week &&
      [
        `주간 ${Math.round(week.utilization)}%`,
        fmtRemainingKo(week.resets_at, now),
        fmtReset(week.resets_at) && `${fmtReset(week.resets_at)} 초기화`,
      ]
        .filter(Boolean)
        .join(" · "),
  ].filter(Boolean)

  return (
    <span
      className="flex h-full cursor-default items-center gap-1.5 px-2"
      title={parts.join("\n")}
      aria-label={`Claude Code 사용량 — ${parts.join(", ")}`}
    >
      {/* Claude 브랜드 로고(주황 선버스트) — 메뉴 아이콘과 같은 애셋을 재사용. */}
      <ClaudeBrandIcon className="size-3.5 shrink-0" />
      {five && <UsageSegment label="5h" win={five} now={now} />}
      {five && week && <span className="text-ui-chrome-muted-fg">·</span>}
      {week && <UsageSegment label="week" win={week} now={now} />}
    </span>
  )
}

interface StatusBarProps {
  /** 항목 클릭 → 해당 메뉴 탭 열기. */
  onOpen: (id: string) => void
}

/**
 * 상태바(26px). 파란 바를 버리고 상단바·레일과 같은 라벤더 크롬 색을 쓴다.
 *
 * 표시하는 수치는 새 폴링을 만들지 않는 소스만 쓴다 — Slack/알림은 Provider 로 공유되는
 * 스토어, 할 일은 localStorage, Claude 진행 현황은 Rust 가 밀어 주는 `herdr:*` 이벤트다.
 * 0건인 항목은 표시하지 않고, 남은 개수는 Slack 색으로 강조한다.
 */
export function StatusBar({ onOpen }: StatusBarProps) {
  const now = useNow()
  const { channels } = useSlack()
  const { workspaces } = useHerdr()
  const { notes } = useStickies()
  const { reminders } = useReminders()
  const { usage } = useClaudeUsage()
  const appVersion = useAppVersion()

  const unread = channels.reduce((sum, c) => sum + c.unread, 0)
  const working = workspaces.filter((w) => w.agent_status === "working").length
  const undoneTodos = notes.reduce(
    (sum, n) => sum + n.todos.filter((t) => !t.done).length,
    0
  )
  const activeReminders = reminders.filter(
    (r) => reminderNextAt(r, now) != null
  ).length

  return (
    <footer className="flex h-(--ui-statusbar-h) shrink-0 items-center gap-0 bg-ui-statusbar px-1 text-[12px] text-ui-chrome-muted-fg select-none">
      <StatusItem
        icon={LayoutGridIcon}
        text="My Space"
        ariaLabel="홈으로"
        onClick={() => onOpen("home")}
      />
      {unread > 0 && (
        <StatusItem
          icon={MessageSquareIcon}
          text={String(unread)}
          tone="error"
          ariaLabel={`안 읽은 Slack 메시지 ${unread}건`}
          onClick={() => onOpen("slack")}
        />
      )}
      {working > 0 && (
        <StatusItem
          icon={BotIcon}
          text={String(working)}
          tone="success"
          ariaLabel={`실행 중인 Claude Code 작업 ${working}건`}
          onClick={() => onOpen("claude-bridge")}
        />
      )}
      {undoneTodos > 0 && (
        <StatusItem
          icon={CheckSquareIcon}
          text={String(undoneTodos)}
          tone="warning"
          ariaLabel={`남은 할 일 ${undoneTodos}건`}
          onClick={() => onOpen("todo")}
        />
      )}

      <div className="ml-auto flex h-full items-center">
        {usage && <UsageMeter usage={usage} now={now} />}
        <StatusItem
          icon={BellIcon}
          text={activeReminders > 0 ? String(activeReminders) : undefined}
          ariaLabel={`예정된 알림 ${activeReminders}건`}
          onClick={() => onOpen("reminder")}
        />
        {appVersion && (
          <span className="flex h-full cursor-default items-center px-2">
            v{appVersion}
          </span>
        )}
        <StatusItem
          icon={SettingsIcon}
          ariaLabel="설정"
          onClick={() => onOpen(SETTINGS_ID)}
        />
      </div>
    </footer>
  )
}
