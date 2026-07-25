import { createContext, useContext } from "react"

export interface SlackStatus {
  connected: boolean
  team: string | null
  user: string | null
}

export interface UnreadMessage {
  user: string
  text: string
  ts: string
  /** 스레드 답글이면 부모 메시지 ts. 최상위 메시지면 null. */
  thread_ts: string | null
}

export type ChannelKind = "channel" | "private" | "mpim" | "im"

export interface ChannelInfo {
  id: string
  name: string
  kind: ChannelKind
}

export interface ChannelUnread {
  id: string
  name: string
  kind: ChannelKind
  unread: number
  has_more: boolean
  messages: UnreadMessage[]
}

export interface SlackContextValue {
  /** status === null 은 "확인 중"을 뜻한다. */
  status: SlackStatus | null
  channels: ChannelUnread[]
  loading: boolean
  error: string | null
  updatedAt: number | null
  selected: string[]
  channelsList: ChannelInfo[]
  channelsLoading: boolean
  /** 채널 목록을 마지막으로 서버에서 가져온 시각(epoch ms). 캐시 표시용. */
  channelsFetchedAt: number | null
  connect: (token: string) => Promise<void>
  disconnect: () => Promise<void>
  refresh: () => Promise<void>
  loadChannels: () => Promise<void>
  saveSelected: (ids: string[]) => Promise<void>
  /** 채널을 ts 시점까지 읽음 처리한다(conversations.mark). 최상위 미읽음만 사라진다(스레드 제외). */
  markRead: (channel: string, ts: string) => Promise<void>
  /** 현재 보이는 모든 채널을 각자의 최신 ts 까지 읽음 처리한다. */
  markAllRead: () => Promise<void>
  /** 안 읽은 메시지를 클릭하면 Slack 앱을 해당 채널·메시지(스레드면 스레드)로 연다. */
  openMessage: (
    channel: string,
    ts: string,
    threadTs?: string | null
  ) => Promise<void>
}

export const SlackContext = createContext<SlackContextValue | null>(null)

/**
 * Slack 연결 상태·선택 채널·안 읽은 메시지를 제공하는 훅.
 * `SlackProvider` 안에서만 쓸 수 있다. 상태가 전역이므로 사이드바 배지와
 * Slack 화면이 같은 안 읽음 개수를 공유한다.
 */
export function useSlack() {
  const ctx = useContext(SlackContext)
  if (!ctx) {
    throw new Error("useSlack 는 SlackProvider 안에서만 사용할 수 있습니다.")
  }
  return ctx
}
