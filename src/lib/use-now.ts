import { useEffect, useState } from "react"

import { useTabActive } from "@/lib/use-tab-active"

/**
 * 일정 주기로 현재 시각(epoch ms)을 갱신한다.
 * 홈 화면의 "3분 전", "40분 후", "지금" 구분선처럼 시간이 흐르면 저절로 틀려지는
 * 표시를 주기적으로 다시 그리기 위한 훅.
 *
 * 탭은 닫을 때까지 마운트된 채로 남으므로, 숨어 있는 동안에는 tick 을 멈춘다(보이지 않는
 * 화면을 30초마다 다시 그릴 이유가 없다). 다시 보이게 되면 그 즉시 현재 시각으로 맞춘다.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  const tabActive = useTabActive()
  useEffect(() => {
    if (!tabActive) return
    // 숨어 있는 동안 흐른 시간을 먼저 반영한다(의도된 패턴 — 외부 시계와의 동기화).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs, tabActive])
  return now
}
