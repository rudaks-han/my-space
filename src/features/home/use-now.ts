import { useEffect, useState } from "react"

/**
 * 일정 주기로 현재 시각(epoch ms)을 갱신한다.
 * 홈 화면의 "3분 전", "40분 후", "지금" 구분선처럼 시간이 흐르면 저절로 틀려지는
 * 표시를 주기적으로 다시 그리기 위한 훅.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
