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

/** 타일 톤 — 상태색은 --ui-* 토큰으로만(하드코딩 팔레트 금지). value 가 0 이면 muted 로 죽인다. */
type Tone = "success" | "warning" | "info" | "violet" | "primary" | "muted"

const TONE: Record<Tone, { tile: string; value: string; ring: string }> = {
  success: {
    tile: "bg-ui-success/15 text-ui-success",
    value: "text-ui-success",
    ring: "group-hover:ring-ui-success/30",
  },
  warning: {
    tile: "bg-ui-warning/15 text-ui-warning",
    value: "text-ui-warning",
    ring: "group-hover:ring-ui-warning/30",
  },
  info: {
    tile: "bg-ui-info/15 text-ui-info",
    value: "text-ui-info",
    ring: "group-hover:ring-ui-info/30",
  },
  violet: {
    tile: "bg-chart-5/15 text-chart-5",
    value: "text-chart-5",
    ring: "group-hover:ring-chart-5/30",
  },
  primary: {
    tile: "bg-primary/15 text-primary",
    value: "text-primary",
    ring: "group-hover:ring-primary/30",
  },
  muted: {
    tile: "bg-muted text-muted-foreground",
    value: "text-muted-foreground",
    ring: "",
  },
}

/** KPI 타일 하나. 클릭하면 해당 메뉴로 이동한다. */
function Tile({
  icon: Icon,
  label,
  value,
  menuId,
  tone,
  pulse,
}: {
  icon: LucideIcon
  label: string
  value: number
  menuId: string
  tone: Tone
  pulse?: boolean
}) {
  const navigate = useNavigate()
  // 값이 0 이면 색을 죽여, 남아 있는 색이 곧 "지금 신경 쓸 것" 을 뜻하게 한다.
  const t = TONE[value > 0 ? tone : "muted"]
  return (
    <button
      type="button"
      onClick={() => navigate(menuId)}
      className={cn(
        "group flex cursor-pointer items-center gap-3 rounded-[10px] border border-border bg-card p-3 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06)] ring-2 ring-transparent transition-all hover:bg-ui-list-hover",
        t.ring
      )}
    >
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          t.tile
        )}
      >
        <Icon
          className={cn("size-[18px]", pulse && value > 0 && "animate-pulse")}
        />
      </span>
      <span className="flex min-w-0 flex-col">
        {/* 대시보드 히어로 숫자 — 훑을 때 가장 먼저 걸리도록 20px bold. */}
        <span
          className={cn(
            "text-[20px] leading-none font-bold tabular-nums",
            t.value
          )}
        >
          {value}
        </span>
        <span className="mt-1 truncate text-[13px] text-muted-foreground">
          {label}
        </span>
      </span>
    </button>
  )
}

/**
 * 홈 최상단 KPI 스트립 — 진행 중·입력 대기·안 읽음·오늘 일정·할 일·알림 건수를
 * 색상 타일로 한 줄에 보여주고, 클릭하면 해당 메뉴로 바로 이동한다.
 * 좁은 폭에서는 2열 → 3열 → 6열로 접힌다.
 */
export function StatStrip({
  working,
  blocked,
  unread,
  events,
  todos,
  reminders,
}: {
  working: number
  blocked: number
  unread: number
  events: number
  todos: number
  reminders: number
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Tile
        icon={CircleDotIcon}
        label="진행 중"
        value={working}
        menuId="claude-bridge"
        tone="success"
        pulse
      />
      <Tile
        icon={PauseCircleIcon}
        label="입력 대기"
        value={blocked}
        menuId="claude-bridge"
        tone="warning"
      />
      <Tile
        icon={MessageSquareIcon}
        label="안 읽은 메시지"
        value={unread}
        menuId="slack"
        tone="info"
      />
      <Tile
        icon={CalendarIcon}
        label="오늘 일정"
        value={events}
        menuId="gcal"
        tone="violet"
      />
      <Tile
        icon={CheckSquareIcon}
        label="남은 할 일"
        value={todos}
        menuId="todo"
        tone="primary"
      />
      <Tile
        icon={BellIcon}
        label="예정된 알림"
        value={reminders}
        menuId="reminder"
        tone="muted"
      />
    </div>
  )
}
