import { useCallback, useEffect, useState, type ReactNode } from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useSettings } from "@/features/settings/settings-context"
import {
  SlackContext,
  type ChannelInfo,
  type ChannelUnread,
  type SlackStatus,
} from "./use-slack"
/** 채널 목록 캐시 저장 키(선택 UI 를 즉시 띄우기 위함). */
const CHANNELS_CACHE_KEY = "myspace.slackChannels"
const CHANNELS_FETCHED_AT_KEY = "myspace.slackChannelsFetchedAt"

/**
 * Slack 연결 상태·선택 채널·안 읽은 메시지를 전역으로 보유한다.
 * 토큰과 선택 목록은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 * 상태를 Context 로 공유해 사이드바 배지와 Slack 화면이 같은 안 읽음 개수를
 * 보게 하고, Slack 화면을 열지 않아도 백그라운드 폴링이 계속 돌게 한다.
 */
export function SlackProvider({ children }: { children: ReactNode }) {
  // 폴링 주기는 설정(설정 → Slack → 새로고침 주기)에서 가져온다.
  const pollSeconds = useSettings().settings.slack.pollSeconds
  // status === null 은 "확인 중"을 뜻한다.
  const [status, setStatus] = useState<SlackStatus | null>(null)
  const [channels, setChannels] = useState<ChannelUnread[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const [selected, setSelected] = useState<string[]>([])
  // 채널 목록은 로컬에 캐시해 선택 UI 를 즉시 띄운다. 새로고침 시에만 서버 재조회.
  const [channelsList, setChannelsList] = useLocalStorage<ChannelInfo[]>(
    CHANNELS_CACHE_KEY,
    []
  )
  const [channelsFetchedAt, setChannelsFetchedAt] = useLocalStorage<
    number | null
  >(CHANNELS_FETCHED_AT_KEY, null)
  const [channelsLoading, setChannelsLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await trackedInvoke<ChannelUnread[]>("slack_unreads")
      setChannels(data)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadChannels = useCallback(async () => {
    setChannelsLoading(true)
    setError(null)
    try {
      const list = await trackedInvoke<ChannelInfo[]>("slack_channels")
      setChannelsList(list)
      setChannelsFetchedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setChannelsLoading(false)
    }
  }, [setChannelsList, setChannelsFetchedAt])

  const openMessage = useCallback(
    async (channel: string, ts: string, threadTs?: string | null) => {
      try {
        await trackedInvoke("slack_open_message", { channel, ts, threadTs })
        // Slack 이 읽음 처리할 시간을 준 뒤 새로고침해 뱃지 수를 실제 상태로 맞춘다.
        // (돌아와서 창이 포커스될 때도 아래 effect 가 한 번 더 갱신한다.)
        setTimeout(() => void refresh(), 2500)
      } catch (e) {
        setError(String(e))
      }
    },
    [refresh]
  )

  const saveSelected = useCallback(
    async (ids: string[]) => {
      try {
        await trackedInvoke("slack_set_selected", { ids })
        setSelected(ids)
        void refresh()
      } catch (e) {
        setError(String(e))
      }
    },
    [refresh]
  )

  const connect = useCallback(
    async (token: string) => {
      setError(null)
      let s: SlackStatus
      try {
        s = await trackedInvoke<SlackStatus>("slack_save_token", { token })
      } catch (e) {
        // 토큰 검증 실패(invalid_auth/missing_scope/네트워크 등)를 화면에 표시한다.
        setError(String(e))
        throw e
      }
      setStatus(s)
      if (s.connected) {
        try {
          setSelected(await trackedInvoke<string[]>("slack_get_selected"))
        } catch {
          /* 무시 */
        }
        void refresh()
      }
    },
    [refresh]
  )

  const disconnect = useCallback(async () => {
    await trackedInvoke("slack_disconnect")
    setStatus({ connected: false, team: null, user: null })
    setChannels([])
    setChannelsList([])
    setChannelsFetchedAt(null)
    setError(null)
    setUpdatedAt(null)
  }, [setChannelsList, setChannelsFetchedAt])

  // 최초 진입 시 연결 상태·선택 목록을 확인하고, 연결돼 있으면 바로 불러온다.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<SlackStatus>("slack_status")
      .then(async (s) => {
        if (cancelled) return
        setStatus(s)
        if (!s.connected) return
        try {
          const ids = await trackedInvoke<string[]>("slack_get_selected")
          if (!cancelled) setSelected(ids)
        } catch {
          /* 무시 */
        }
        if (!cancelled) void refresh()
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, team: null, user: null })
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  // 연결된 동안 주기적으로 새로고침한다(interval 콜백에서만 → effect 본문은 setState 없음).
  // 주기(pollSeconds)가 바뀌면 타이머를 다시 만든다.
  useEffect(() => {
    if (!status?.connected) return
    const timer = setInterval(() => void refresh(), pollSeconds * 1000)
    return () => clearInterval(timer)
  }, [status?.connected, refresh, pollSeconds])

  // 창이 다시 포커스되면(예: Slack 에서 읽고 돌아옴) 안 읽음을 새로고침해 뱃지를 맞춘다.
  // 잦은 포커스 토글에 폭주하지 않도록 최소 간격(3초)을 둔다.
  useEffect(() => {
    if (!isTauri() || !status?.connected) return
    let last = 0
    const unlisten = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (!focused) return
        const now = performance.now()
        if (now - last < 3000) return
        last = now
        void refresh()
      }
    )
    return () => {
      void unlisten.then((f) => f())
    }
  }, [status?.connected, refresh])

  return (
    <SlackContext.Provider
      value={{
        status,
        channels,
        loading,
        error,
        updatedAt,
        selected,
        channelsList,
        channelsLoading,
        channelsFetchedAt,
        connect,
        disconnect,
        refresh,
        loadChannels,
        saveSelected,
        openMessage,
      }}
    >
      {children}
    </SlackContext.Provider>
  )
}
