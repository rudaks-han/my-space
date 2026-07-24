import { useCallback, useEffect, useState } from "react"

import { trackedInvoke } from "@/lib/tauri"

export interface GcalStatus {
  connected: boolean
  email: string | null
}

export interface CalendarEvent {
  summary: string
  /** RFC3339 dateTime, all-day 면 "YYYY-MM-DD". */
  start: string
  end: string
  all_day: boolean
  location: string | null
  html_link: string | null
  meet_link: string | null
}

/** 오늘 일정 자동 새로고침 주기(5분). */
const POLL_MS = 300_000

/**
 * Google 캘린더 연동 상태와 오늘 일정을 관리한다.
 * client_id/secret·토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 */
export function useGcal() {
  const [status, setStatus] = useState<GcalStatus | null>(null)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await trackedInvoke<CalendarEvent[]>("gcal_today")
      setEvents(data)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      setError(null)
      // 브라우저 로그인 완료까지 대기(최대 3분) — 완료되면 상태가 채워진다.
      const s = await trackedInvoke<GcalStatus>("gcal_start_auth", {
        clientId,
        clientSecret,
      })
      setStatus(s)
      if (s.connected) void refresh()
    },
    [refresh],
  )

  const disconnect = useCallback(async () => {
    await trackedInvoke("gcal_disconnect")
    setStatus({ connected: false, email: null })
    setEvents([])
    setError(null)
    setUpdatedAt(null)
  }, [])

  // 최초: 연동 상태 확인 후 연결돼 있으면 오늘 일정 로드.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<GcalStatus>("gcal_status")
      .then((s) => {
        if (cancelled) return
        setStatus(s)
        if (s.connected) void refresh()
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, email: null })
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  // 연결된 동안 주기적으로 새로고침(interval 콜백에서만 → effect 본문은 setState 없음).
  useEffect(() => {
    if (!status?.connected) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.connected, refresh])

  return { status, events, loading, error, updatedAt, connect, disconnect, refresh }
}
