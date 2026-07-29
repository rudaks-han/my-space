import { useEffect, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"

/** 사용량 창 하나. utilization 은 0~100(%) 사용률, resetsAt 은 초기화 UTC 시각(ISO). */
export interface UsageWindow {
  utilization: number
  resets_at: string | null
}

/** `/usage` 응답 — 세 창 모두 없을 수 있다. */
export interface ClaudeUsage {
  /** 5시간 세션 사용률. */
  five_hour: UsageWindow | null
  /** 주간(7일) 사용률 — 상태바의 "week". */
  seven_day: UsageWindow | null
  /** 주간 Sonnet 전용 사용률. */
  seven_day_sonnet: UsageWindow | null
}

/** 사용량 폴링 주기(2분). 원격 호출이라 잦게 부를 필요가 없다. */
const POLL_MS = 2 * 60 * 1000

/**
 * Claude Code 사용량(5시간·주간 rate-limit)을 조회한다.
 *
 * Rust `claude_usage` 커맨드가 Keychain/파일에서 OAuth 토큰을 읽어 authoritative
 * `/usage` 엔드포인트를 호출한다. 자격증명이 없거나 오프라인이면 `usage` 는 null 로 두고
 * `error` 에 사유를 담는다(호출부는 조용히 표시를 숨기면 된다).
 *
 * 상태바는 항상 떠 있는 셸 요소라 탭 활성화 게이팅이 필요 없다 —
 * 훅 인스턴스가 하나뿐이므로 폴러도 하나다.
 */
export function useClaudeUsage() {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    let alive = true

    const load = async () => {
      try {
        const u = await trackedInvoke<ClaudeUsage>("claude_usage")
        if (!alive) return
        setUsage(u)
        setError(null)
      } catch (e) {
        if (!alive) return
        setError(String(e))
      }
    }

    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return { usage, error }
}
