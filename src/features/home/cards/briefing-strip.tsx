import {
  BellIcon,
  CalendarIcon,
  CheckSquareIcon,
  CircleDotIcon,
  MessageSquareIcon,
  PauseCircleIcon,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { useNavigate } from "@/lib/use-navigation"
import type { CalendarEvent } from "@/features/gcal/use-gcal"
import { fmtClock, minutesUntil } from "../home-utils"

/** 요약 칩 하나. 클릭하면 해당 메뉴로 이동한다. */
function Chip({
  icon: Icon,
  label,
  value,
  menuId,
  tone = "muted",
  pulse,
}: {
  icon: LucideIcon
  label: string
  value: string
  menuId: string
  tone?: "muted" | "amber" | "green" | "blue"
  pulse?: boolean
}) {
  const navigate = useNavigate()
  const toneClass = {
    muted: "text-muted-foreground",
    amber: "text-amber-600 dark:text-amber-400",
    green: "text-green-600 dark:text-green-400",
    blue: "text-blue-600 dark:text-blue-400",
  }[tone]
  return (
    <button
      type="button"
      onClick={() => navigate(menuId)}
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-accent"
    >
      <Icon
        className={cn("size-4 shrink-0", toneClass, pulse && "animate-pulse")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={cn("truncate text-sm font-semibold", toneClass)}>
          {value}
        </span>
      </span>
    </button>
  )
}

/**
 * 홈 최상단 요약 스트립 — 입력 대기·진행 중·안 읽음·다음 일정·할 일·알림 건수를
 * 한 줄로 보여주고, 클릭하면 해당 메뉴로 바로 이동한다.
 */
export function BriefingStrip({
  blocked,
  working,
  unread,
  next,
  todos,
  reminders,
}: {
  blocked: number
  working: number
  unread: number
  next: CalendarEvent | null
  todos: number
  reminders: number
}) {
  const nextText = (() => {
    if (!next) return "없음"
    const min = minutesUntil(next)
    const when =
      min != null && min < 60
        ? `${Math.max(min, 0)}분 후`
        : fmtClock(next.start)
    return `${when} · ${next.summary}`
  })()

  return (
    <div className="flex flex-wrap items-stretch gap-1 rounded-xl bg-card p-1 ring-1 ring-foreground/10">
      <Chip
        icon={PauseCircleIcon}
        label="입력 대기"
        value={blocked > 0 ? `${blocked}건` : "없음"}
        menuId="claude-bridge"
        tone={blocked > 0 ? "amber" : "muted"}
      />
      <Chip
        icon={CircleDotIcon}
        label="진행 중"
        value={working > 0 ? `${working}건` : "없음"}
        menuId="claude-bridge"
        tone={working > 0 ? "green" : "muted"}
        pulse={working > 0}
      />
      <Chip
        icon={MessageSquareIcon}
        label="안 읽은 메시지"
        value={unread > 0 ? `${unread}건` : "없음"}
        menuId="slack"
        tone={unread > 0 ? "blue" : "muted"}
      />
      <Chip
        icon={CalendarIcon}
        label="다음 일정"
        value={nextText}
        menuId="gcal"
        tone="muted"
      />
      <Chip
        icon={CheckSquareIcon}
        label="남은 할 일"
        value={todos > 0 ? `${todos}건` : "없음"}
        menuId="todo"
        tone="muted"
      />
      <Chip
        icon={BellIcon}
        label="예정된 알림"
        value={reminders > 0 ? `${reminders}건` : "없음"}
        menuId="reminder"
        tone="muted"
      />
    </div>
  )
}
