import { useEffect, useRef, useState } from "react"

/**
 * localStorage 와 동기화되는 state 훅.
 * 값이 바뀌면 자동 저장되고, 재실행해도 유지된다.
 *
 * localStorage 는 앱의 모든 창(메인 창 · "새 창으로 열기" 창 · 위젯)이 공유하므로
 * 다른 창의 변경(`storage` 이벤트)도 이쪽 state 로 반영한다. 반영하지 않으면 각 창이
 * 오래된 스냅샷을 들고 있다가 다음 저장 때 다른 창의 변경을 덮어써 버린다.
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

  // 이 창이 마지막으로 쓴/읽은 원본 문자열. 다른 창에서 받은 값을 그대로 되쓰지 않기 위한
  // 표시다 — 되쓰면 두 창이 같은 값을 서로에게 계속 통보하는 왕복이 생긴다.
  const lastRaw = useRef<string | null>(null)

  useEffect(() => {
    try {
      const raw = JSON.stringify(value)
      if (raw === lastRaw.current) return
      lastRaw.current = raw
      localStorage.setItem(key, raw)
    } catch {
      // 저장 실패는 무시 (용량 초과 등)
    }
  }, [key, value])

  // 다른 창이 같은 키를 바꾸면 따라간다(같은 창에서 낸 변경은 이벤트가 오지 않는다).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return
      if (e.newValue === lastRaw.current) return
      try {
        const parsed = JSON.parse(e.newValue) as T
        lastRaw.current = e.newValue
        setValue(parsed)
      } catch {
        // 깨진 값은 무시하고 현재 state 를 유지한다.
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [key])

  return [value, setValue] as const
}
