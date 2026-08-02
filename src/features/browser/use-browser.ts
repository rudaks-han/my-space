import { useCallback, useMemo } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { browserLabel } from "@/lib/window-role"

export interface BrowserTab {
  id: string
  /** 현재 표시 중인 URL */
  url: string
  /** 탭에 보여줄 제목 (호스트명 기반) */
  title: string
}

/** 새 탭 기본 페이지 */
export const HOME_URL = "https://www.google.com"

/**
 * 메모리 회수용 빈 페이지(Rust 의 `BLANK_URL`). 탭의 주소로 저장돼서는 안 되는 값이다 —
 * 저장되면 그 탭이 원래 어디였는지 잃는다.
 */
const BLANK_URL = "about:blank"

/**
 * 탭 id → Rust 쪽 웹뷰 라벨. lib.rs 의 BROWSER_PREFIX 와 일치해야 하고,
 * 창마다 달라야 한다(메인 창과 "새 창으로 열기" 창이 같은 웹뷰를 다투지 않도록).
 */
export function labelFor(id: string) {
  return browserLabel(id)
}

/**
 * 주소창 입력을 실제 이동할 URL 로 정규화한다 (크롬 옴니박스처럼).
 * - http(s):// 로 시작하면 그대로
 * - 공백 없고 점이 있으면 도메인으로 보고 https:// 를 붙임
 * - 그 외에는 구글 검색
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return HOME_URL

  // 공백이 없을 때만 URL 후보로 본다. scheme 이 없으면 https:// 를 붙인다.
  if (!/\s/.test(trimmed)) {
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`
    try {
      const u = new URL(candidate)
      // 정상적인 ASCII 도메인 형태(점 포함)일 때만 URL 로 인정한다.
      // 그렇지 않으면(예: IME 로 섞인 전각 문자로 host 가 깨진 경우) 검색으로 폴백.
      if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) {
        return u.toString()
      }
    } catch {
      // 파싱 실패 → 검색으로 폴백
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
}

/** URL 에서 탭 제목으로 쓸 호스트명을 뽑는다. */
export function hostLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    return host || url
  } catch {
    return url
  }
}

export function useBrowser() {
  const [stored, setTabs] = useLocalStorage<BrowserTab[]>(
    "myspace.browser.tabs",
    []
  )

  // 주소가 `about:blank` 로 저장된 탭은 홈으로 되돌린다. 메모리 회수가 비워 둔 페이지를
  // 탭 주소로 받아 적던 시절(이제 Rust 의 on_page_load 가 그 알림을 걸러낸다)에 생긴
  // 저장값을 복구하기 위한 것으로, 그대로 두면 그 탭은 영영 빈 페이지만 연다.
  const tabs = useMemo(
    () =>
      stored.some((t) => t.url === BLANK_URL)
        ? stored.map((t) =>
            t.url === BLANK_URL
              ? { ...t, url: HOME_URL, title: hostLabel(HOME_URL) }
              : t
          )
        : stored,
    [stored]
  )
  const [activeId, setActiveId] = useLocalStorage<string | null>(
    "myspace.browser.activeTab",
    null
  )

  const addTab = useCallback(
    (url: string = HOME_URL) => {
      const id = crypto.randomUUID()
      setTabs((prev) => [...prev, { id, url, title: hostLabel(url) }])
      setActiveId(id)
      return id
    },
    [setTabs, setActiveId]
  )

  /** 탭 목록에서 제거하고, 닫은 탭이 활성 탭이면 인접 탭을 활성화한다. */
  const removeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === id)
        if (idx === -1) return prev
        const next = prev.filter((t) => t.id !== id)
        setActiveId((current) => {
          if (current !== id) return current
          if (next.length === 0) return null
          // 닫은 위치의 다음 탭, 없으면 이전 탭
          return (next[idx] ?? next[idx - 1]).id
        })
        return next
      })
    },
    [setTabs, setActiveId]
  )

  /** 탭의 URL/제목을 갱신한다 (주소창 이동, 또는 웹뷰 내부 이동 이벤트 반영). */
  const setTabUrl = useCallback(
    (id: string, url: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, url, title: hostLabel(url) } : t
        )
      )
    },
    [setTabs]
  )

  return { tabs, activeId, setActiveId, addTab, removeTab, setTabUrl }
}
