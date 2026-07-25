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
 * Google 캘린더 연결 상태만 관리한다(연결/해제는 설정 화면에서 한다).
 * client_id/secret·토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 */
export function useGcalConnection() {
  const [status, setStatus] = useState<GcalStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      setError(null)
      try {
        // 브라우저 로그인 완료까지 대기(최대 3분) — 완료되면 상태가 채워진다.
        setStatus(
          await trackedInvoke<GcalStatus>("gcal_start_auth", {
            clientId,
            clientSecret,
          })
        )
      } catch (e) {
        setError(String(e))
      }
    },
    []
  )

  const disconnect = useCallback(async () => {
    await trackedInvoke("gcal_disconnect")
    setStatus({ connected: false, email: null })
    setError(null)
  }, [])

  // 최초 1회 연동 상태 확인.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<GcalStatus>("gcal_status")
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus({ connected: false, email: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { status, error, connect, disconnect }
}

/**
 * 연결 상태 + 오늘 일정을 관리한다. 연결돼 있을 때만 일정을 불러온다.
 */
export function useGcal() {
  const { status, error: connError, disconnect } = useGcalConnection()
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

  // 연결이 확인되면 일정을 불러오고, 연결된 동안 주기적으로 새로고침한다.
  useEffect(() => {
    if (!status?.connected) return
    // 연결 확인 직후 첫 로드(데이터 페칭 목적의 의도된 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.connected, refresh])

  return {
    status,
    events,
    loading,
    error: connError ?? error,
    updatedAt,
    disconnect,
    refresh,
  }
}
