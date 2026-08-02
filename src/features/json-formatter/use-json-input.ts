import { useEffect, useRef, useState } from "react"

const KEY = "myspace.jsonFormatter.input"
/** 이보다 큰 입력은 저장하지 않는다 — localStorage 총량(보통 5MB)을 혼자 다 먹는다. */
const MAX_PERSIST = 256 * 1024
const DEBOUNCE_MS = 400

/**
 * 입력 JSON 을 담는 state. `useLocalStorage` 를 쓰지 않는 이유는 두 가지다.
 *  - 저장을 **디바운스** 한다: 붙여넣는 텍스트가 MB 단위일 수 있어 키 입력마다
 *    `JSON.stringify` + `setItem` 을 하면 타이핑이 걸린다.
 *  - 문자열을 **날것으로** 넣는다(JSON 인코딩 없이): 크기가 절반이고, 이 키를
 *    읽는 곳은 여기뿐이다.
 * 상한을 넘는 입력은 저장을 포기하고 저장된 값을 지운다 — 그래야 다음 실행에서
 * 잘린 옛 내용이 되살아나지 않는다.
 */
export function useJsonInput() {
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? ""
    } catch {
      return ""
    }
  })
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      try {
        if (input.length <= MAX_PERSIST) localStorage.setItem(KEY, input)
        else localStorage.removeItem(KEY)
      } catch {
        // 용량 초과 등 저장 실패는 무시한다(화면 상태는 그대로 유지).
      }
    }, DEBOUNCE_MS)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [input])

  return [input, setInput] as const
}
