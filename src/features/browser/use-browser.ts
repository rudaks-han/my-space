import { useCallback } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

export interface BrowserTab {
  id: string
  /** 현재 표시 중인 URL */
  url: string
  /** 탭에 보여줄 제목 (호스트명 기반) */
  title: string
}

/** 새 탭 기본 페이지 */
export const HOME_URL = "https://www.google.com"

/** 탭 id → Rust 쪽 웹뷰 라벨. lib.rs 의 BROWSER_PREFIX 와 일치해야 한다. */
export function labelFor(id: string) {
  return `browser-tab-${id}`
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
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
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
  const [tabs, setTabs] = useLocalStorage<BrowserTab[]>(
    "myspace.browser.tabs",
    [],
  )
  const [activeId, setActiveId] = useLocalStorage<string | null>(
    "myspace.browser.activeTab",
    null,
  )

  const addTab = useCallback(
    (url: string = HOME_URL) => {
      const id = crypto.randomUUID()
      setTabs((prev) => [...prev, { id, url, title: hostLabel(url) }])
      setActiveId(id)
      return id
    },
    [setTabs, setActiveId],
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
    [setTabs, setActiveId],
  )

  /** 탭의 URL/제목을 갱신한다 (주소창 이동, 또는 웹뷰 내부 이동 이벤트 반영). */
  const setTabUrl = useCallback(
    (id: string, url: string) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id ? { ...t, url, title: hostLabel(url) } : t,
        ),
      )
    },
    [setTabs],
  )

  return { tabs, activeId, setActiveId, addTab, removeTab, setTabUrl }
}
