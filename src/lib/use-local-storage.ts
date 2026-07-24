import { useEffect, useState } from "react"

/**
 * localStorage 와 동기화되는 state 훅.
 * 값이 바뀌면 자동 저장되고, 재실행해도 유지된다.
 */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initialValue
    } catch {
      return initialValue
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // 저장 실패는 무시 (용량 초과 등)
    }
  }, [key, value])

  return [value, setValue] as const
}
