import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { getCurrentWindow } from "@tauri-apps/api/window"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import {
  GmailContext,
  matchesInterest,
  type GmailBody,
  type GmailFolder,
  type GmailMessage,
  type GmailPage,
  type GmailStatus,
} from "./use-gmail"

/** 받은편지함 자동 새로고침 주기(5분) — 배지가 항상 최신 미읽음을 반영하도록. */
const POLL_MS = 300_000

/**
 * Gmail 연결 상태·받은편지함을 전역으로 보유한다.
 * client_id/secret·토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 * 상태를 Context 로 공유해 사이드바 배지와 Gmail 화면이 같은 받은편지함·안 읽음 수를
 * 보게 하고, Gmail 화면을 열지 않아도 백그라운드 폴링이 계속 돌게 한다(Slack 과 동일).
 */
export function GmailProvider({ children }: { children: ReactNode }) {
  // "관심 대상" 필터는 설정(설정 → Gmail)에서 가져온다.
  const { senders, keywords } = useSettings().settings.gmail

  const [status, setStatus] = useState<GmailStatus | null>(null)
  const [inbox, setInbox] = useState<GmailMessage[]>([])
  const [totalUnread, setTotalUnread] = useState(0)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const refreshInbox = useCallback(async () => {
    setInboxLoading(true)
    setError(null)
    try {
      // 배지는 받은편지함 첫 페이지의 안 읽은 관심 메일만 세면 충분하다.
      const page = await trackedInvoke<GmailPage>("gmail_messages", {
        folder: "inbox",
      })
      setInbox(page.messages)
      setUpdatedAt(Date.now())
      // 전체 안읽음 총계(정확값)도 함께 갱신 — 실패해도 목록엔 영향 없다.
      trackedInvoke<number>("gmail_unread_count")
        .then(setTotalUnread)
        .catch(() => {})
    } catch (e) {
      setError(String(e))
    } finally {
      setInboxLoading(false)
    }
  }, [])

  const loadPage = useCallback(
    (folder: GmailFolder, pageToken?: string) =>
      trackedInvoke<GmailPage>("gmail_messages", { folder, pageToken }),
    []
  )

  const loadBody = useCallback(
    (id: string) => trackedInvoke<GmailBody>("gmail_message_body", { id }),
    []
  )

  const markRead = useCallback(
    async (id: string) => {
      // 낙관적으로 받은편지함 캐시를 읽음 처리 → 배지(관심·전체)가 즉시 갱신된다.
      setInbox((prev) =>
        prev.map((m) => (m.id === id ? { ...m, unread: false } : m))
      )
      setTotalUnread((n) => Math.max(0, n - 1))
      try {
        await trackedInvoke("gmail_mark_read", { id })
        // 성공: 낙관적 -1 이 정확하므로 곧바로 다시 조회하지 않는다. 전체 안읽음 집계
        // (messagesUnread)는 몇 초 지연될 수 있어 즉시 재조회하면 옛 값으로 되돌아간다.
        // 실제 보정은 5분 주기 폴링·창 포커스에서 이뤄진다.
      } catch (e) {
        // 실패(예: 권한 부족) → 서버 실제 상태로 되돌린 뒤, 사유를 표시한다.
        // (refreshInbox 가 setError(null) 하므로 반드시 그 뒤에 setError 한다.)
        await refreshInbox()
        setError(String(e))
      }
    },
    [refreshInbox]
  )

  const isInterest = useCallback(
    (m: Pick<GmailMessage, "from_email" | "subject" | "snippet">) =>
      matchesInterest(m, senders, keywords),
    [senders, keywords]
  )

  // 받은편지함에서 안 읽은 "관심" 메일 수(배지). 필터가 비어 있으면 0.
  const unreadInterest = useMemo(
    () =>
      inbox.filter((m) => m.unread && matchesInterest(m, senders, keywords))
        .length,
    [inbox, senders, keywords]
  )

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      setError(null)
      try {
        // 브라우저 로그인 완료까지 대기(최대 3분) — 완료되면 상태가 채워진다.
        const s = await trackedInvoke<GmailStatus>("gmail_start_auth", {
          clientId,
          clientSecret,
        })
        setStatus(s)
        if (s.connected) void refreshInbox()
      } catch (e) {
        setError(String(e))
      }
    },
    [refreshInbox]
  )

  const disconnect = useCallback(async () => {
    await trackedInvoke("gmail_disconnect")
    setStatus({ connected: false, email: null })
    setInbox([])
    setTotalUnread(0)
    setUpdatedAt(null)
    setError(null)
  }, [])

  // 최초 진입 시 연결 상태를 확인하고, 연결돼 있으면 받은편지함을 바로 불러온다.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<GmailStatus>("gmail_status")
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        if (s.connected) void refreshInbox()
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, email: null })
      })
    return () => {
      cancelled = true
    }
  }, [refreshInbox])

  // 연결된 동안 주기적으로 받은편지함을 새로고침한다(interval 콜백에서만 setState).
  useEffect(() => {
    if (!status?.connected) return
    const timer = setInterval(() => void refreshInbox(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.connected, refreshInbox])

  // 창이 다시 포커스되면(예: Gmail 웹에서 읽고 돌아옴) 받은편지함을 새로고침해 배지를
  // 맞춘다. 잦은 포커스 토글에 폭주하지 않도록 최소 간격(3초)을 둔다.
  useEffect(() => {
    if (!isTauri() || !status?.connected) return
    let last = 0
    const unlisten = getCurrentWindow().onFocusChanged(
      ({ payload: focused }) => {
        if (!focused) return
        const now = performance.now()
        if (now - last < 3000) return
        last = now
        void refreshInbox()
      }
    )
    return () => {
      void unlisten.then((f) => f())
    }
  }, [status?.connected, refreshInbox])

  return (
    <GmailContext.Provider
      value={{
        status,
        inbox,
        inboxLoading,
        error,
        updatedAt,
        unreadInterest,
        totalUnread,
        connect,
        disconnect,
        refreshInbox,
        loadPage,
        loadBody,
        markRead,
        isInterest,
      }}
    >
      {children}
    </GmailContext.Provider>
  )
}
