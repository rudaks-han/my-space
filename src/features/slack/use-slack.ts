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
  /** 스레드 답글일 때 부모(스레드 루트) 작성자. 댓글 구조로 묶어 보여주기 위한 맥락. */
  parent_user?: string | null
  /** 스레드 답글일 때 부모(스레드 루트) 본문. */
  parent_text?: string | null
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
