import { useState } from "react"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useClaudeActivity } from "@/features/claude-bridge/use-claude-activity"
import { useHerdr } from "@/features/claude-bridge/use-herdr"
import { useGcal } from "@/features/gcal/use-gcal"
import { useReminders } from "@/features/reminder/use-reminders"
import { useSlack } from "@/features/slack/use-slack"
import { useStickies } from "@/features/todo/use-todos"

import { ActionRequiredCard } from "./cards/action-required-card"
import { BriefingStrip } from "./cards/briefing-strip"
import { ClaudeActivityCard } from "./cards/claude-activity-card"
import { ClaudeTasksCard } from "./cards/claude-tasks-card"
import { ReminderCard } from "./cards/reminder-card"
import { SlackUnreadCard } from "./cards/slack-unread-card"
import { TodayScheduleCard } from "./cards/today-schedule-card"
import { TodoCard } from "./cards/todo-card"
import { fmtToday, greeting, nextEvent, reminderNextAt } from "./home-utils"
import { useNow } from "./use-now"

/**
 * 홈 — "지금 내가 봐야 할 것"을 한 화면에 모은다.
 *
 * 위에서 아래로 ① 요약 스트립 ② 내 응답을 기다리는 항목 ③ Claude Code 진행·이력
 * ④ 오늘 일정·안 읽은 메시지·할 일·알림 순서로 배치한다.
 *
 * 데이터 훅은 이 컴포넌트에서 한 번만 호출하고 카드에는 props 로 내려준다
 * (카드마다 useGcal 을 부르면 5분 폴링이 카드 수만큼 늘어난다).
 */
export function HomeView() {
  // 상대 시간·"지금" 구분선을 30초마다 다시 그린다.
  const now = useNow()

  const {
    workspaces,
    watching,
    error: herdrError,
    refresh: refreshHerdr,
    focusWorkspace,
  } = useHerdr()
  const { activities, clear: clearActivities } = useClaudeActivity()
  const { status: gcalStatus, events, refresh: refreshGcal } = useGcal()
  const {
    status: slackStatus,
    channels,
    openMessage,
    refresh: refreshSlack,
  } = useSlack()
  const { reminders } = useReminders()
  const { notes, toggleTodo } = useStickies()

  const [refreshing, setRefreshing] = useState(false)

  const refreshAll = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.allSettled([
        refreshHerdr(),
        gcalStatus?.connected ? refreshGcal() : Promise.resolve(),
        slackStatus?.connected ? refreshSlack() : Promise.resolve(),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const focus = (session: string, workspaceId: string) => {
    void focusWorkspace(session, workspaceId)
  }
  const openSlackMessage = (
    channelId: string,
    ts: string,
    threadTs: string | null
  ) => {
    void openMessage(channelId, ts, threadTs)
  }

  // 요약 스트립 수치.
  const blocked = workspaces.filter((w) => w.agent_status === "blocked").length
  const working = workspaces.filter((w) => w.agent_status === "working").length
  const unread = channels.reduce((sum, c) => sum + c.unread, 0)
  const undoneTodos = notes.reduce(
    (sum, n) => sum + n.todos.filter((t) => !t.done).length,
    0
  )
  const activeReminders = reminders.filter(
    (r) => reminderNextAt(r, now) != null
  ).length

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-end gap-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate font-heading text-lg font-semibold">
            {greeting(now)} 👋
          </h2>
          <p className="text-sm text-muted-foreground">{fmtToday(now)}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0"
          onClick={() => void refreshAll()}
          disabled={refreshing}
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          새로고침
        </Button>
      </header>

      <BriefingStrip
        blocked={blocked}
        working={working}
        unread={unread}
        next={nextEvent(events, now)}
        todos={undoneTodos}
        reminders={activeReminders}
      />

      <ActionRequiredCard
        workspaces={workspaces}
        events={events}
        channels={channels}
        reminders={reminders}
        now={now}
        onFocusWorkspace={focus}
        onOpenMessage={openSlackMessage}
      />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ClaudeTasksCard
          workspaces={workspaces}
          watching={watching}
          error={herdrError}
          now={now}
          onFocus={focus}
        />
        <TodayScheduleCard status={gcalStatus} events={events} now={now} />
        <ClaudeActivityCard
          activities={activities}
          onClear={clearActivities}
          onFocus={focus}
        />
        <SlackUnreadCard
          connected={slackStatus?.connected ?? false}
          channels={channels}
          onOpenMessage={openSlackMessage}
        />
        <TodoCard notes={notes} onToggle={toggleTodo} />
        <ReminderCard reminders={reminders} now={now} />
      </div>
    </div>
  )
}
