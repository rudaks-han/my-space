import {
  AtSignIcon,
  HashIcon,
  LockIcon,
  MessageSquareIcon,
  UsersIcon,
} from "lucide-react"

import type { ChannelKind, ChannelUnread } from "@/features/slack/use-slack"
import { HomeCard, HomeEmpty } from "../home-card"

/** 홈에 보여줄 최대 채널 수. */
const MAX_ROWS = 6

const KIND_ICON: Record<ChannelKind, typeof HashIcon> = {
  channel: HashIcon,
  private: LockIcon,
  mpim: UsersIcon,
  im: AtSignIcon,
}

/**
 * 안 읽은 Slack 메시지 — 채널별 건수와 마지막 메시지 미리보기.
 * 클릭하면 Slack 앱의 해당 채널·메시지로 이동한다.
 */
export function SlackUnreadCard({
  connected,
  channels,
  onOpenMessage,
}: {
  connected: boolean
  channels: ChannelUnread[]
  onOpenMessage: (
    channelId: string,
    ts: string,
    threadTs: string | null
  ) => void
}) {
  const unread = channels.filter((c) => c.unread > 0)
  const total = unread.reduce((sum, c) => sum + c.unread, 0)
  const rows = unread.slice(0, MAX_ROWS)

  return (
    <HomeCard
      icon={MessageSquareIcon}
      title="안 읽은 Slack"
      count={total}
      menuId="slack"
    >
      {!connected ? (
        <HomeEmpty>
          Slack 이 연결되지 않았습니다 — 설정에서 연결해 주세요.
        </HomeEmpty>
      ) : rows.length === 0 ? (
        <HomeEmpty>안 읽은 메시지가 없습니다.</HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((c) => {
            const Icon = KIND_ICON[c.kind]
            const latest = c.messages.at(-1)
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (latest) onOpenMessage(c.id, latest.ts, latest.thread_ts)
                  }}
                  className="flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">
                      {c.name}
                    </span>
                    {latest && (
                      <span className="line-clamp-1 text-xs text-muted-foreground">
                        {latest.user}: {latest.text}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-blue-600 tabular-nums dark:text-blue-400">
                    {c.unread}
                    {c.has_more ? "+" : ""}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {unread.length > rows.length && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          외 {unread.length - rows.length}개 채널
        </p>
      )}
    </HomeCard>
  )
}
