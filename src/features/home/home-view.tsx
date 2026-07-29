import { useState } from "react"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useHerdr } from "@/features/claude-bridge/use-herdr"
import { useGcal } from "@/features/gcal/use-gcal"
import { useReminders } from "@/features/reminder/use-reminders"
import { useSlack } from "@/features/slack/use-slack"
import { useStickies } from "@/features/todo/use-todos"
import { useNow } from "@/lib/use-now"

import { ActionRequiredCard } from "./cards/action-required-card"
import { ClaudeTasksCard } from "./cards/claude-tasks-card"
import { ReminderCard } from "./cards/reminder-card"
import { SlackUnreadCard } from "./cards/slack-unread-card"
import { StatStrip } from "./cards/stat-strip"
import { TodayScheduleCard } from "./cards/today-schedule-card"
import { TodoCard } from "./cards/todo-card"
import { fmtToday, greeting, reminderNextAt } from "./home-utils"

/**
 * 홈 — "지금 내가 봐야 할 것"을 한 화면에 모은다.
 *
 * 위에서 아래로 ① 색상 KPI 타일(현재 상태를 숫자로) ② 지금 바로 확인이 필요한 항목
 * (없으면 통째로 숨긴다) ③ 진행 중인 작업·오늘 일정·할 일·메시지·알림 순으로 배치한다.
 * "지금 무슨 작업을 하고 있고 다음에 뭘 해야 하는지"가 위에서부터 순서대로 읽히도록 했다.
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

  // KPI 타일 수치.
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
    <div className="flex flex-col gap-3">
      <header className="flex items-end gap-3">
        <div className="flex min-w-0 flex-col">
          {/* Slack 채널 헤더와 같은 18px bold 제목. */}
          <h2 className="truncate font-heading text-[18px] font-bold tracking-[-0.01em]">
            {greeting(now)} 👋
          </h2>
          <p className="text-[13px] text-muted-foreground">{fmtToday(now)}</p>
        </div>
        {/* 우측 상단 액션은 Slack 처럼 테두리 알약으로. */}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto shrink-0 rounded-full px-3 text-[13px]"
          onClick={() => void refreshAll()}
          disabled={refreshing}
        >
          <RefreshCwIcon
            className={cn("size-3.5", refreshing && "animate-spin")}
          />
          새로고침
        </Button>
      </header>

      <StatStrip
        working={working}
        blocked={blocked}
        unread={unread}
        events={events.length}
        todos={undoneTodos}
        reminders={activeReminders}
      />

      {/* 내 응답·참여를 기다리는 항목만. 하나도 없으면 카드 자체가 렌더되지 않는다. */}
      <ActionRequiredCard
        workspaces={workspaces}
        events={events}
        channels={channels}
        reminders={reminders}
        now={now}
        onFocusWorkspace={focus}
        onOpenMessage={openSlackMessage}
      />

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <ClaudeTasksCard
          workspaces={workspaces}
          watching={watching}
          error={herdrError}
          now={now}
          onFocus={focus}
        />
        <TodayScheduleCard status={gcalStatus} events={events} now={now} />
        <TodoCard notes={notes} onToggle={toggleTodo} />
        <SlackUnreadCard
          connected={slackStatus?.connected ?? false}
          channels={channels}
          onOpenMessage={openSlackMessage}
        />
        <ReminderCard reminders={reminders} now={now} />
      </div>
    </div>
  )
}
