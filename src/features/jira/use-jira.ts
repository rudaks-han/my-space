import { useCallback, useEffect, useState } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"

export interface JiraStatus {
  connected: boolean
  url: string | null
  user: string | null
  display_name: string | null
}

/** Jira 상태 분류(색·그룹핑용). Jira 의 statusCategory key 와 같다. */
export type JiraStatusCategory = "new" | "indeterminate" | "done" | "undefined"

export interface JiraIssue {
  key: string
  summary: string
  status: string
  status_category: JiraStatusCategory
  priority: string | null
  issue_type: string
  project_key: string
  project_name: string
  updated: string
  created: string
  due_date: string | null
  /** 상위 이슈(에픽/부모) "KEY · 제목". 없으면 null. */
  parent: string | null
  url: string
}

export interface JiraComment {
  id: string
  author: string
  created: string
  body: string
}

export interface JiraIssueDetail extends JiraIssue {
  assignee: string | null
  reporter: string | null
  labels: string[]
  resolution: string | null
  /** ADF 를 Rust 에서 평문화한 본문. */
  description: string
  comments: JiraComment[]
  comments_truncated: boolean
}

/** 이슈 목록 자동 새로고침 주기(5분) — 캘린더와 같은 간격. */
const POLL_MS = 300_000

/**
 * Jira 연결 상태만 관리한다(연결/해제는 설정 화면에서 한다).
 * 사이트 주소·이메일·API 토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 */
export function useJiraConnection() {
  const [status, setStatus] = useState<JiraStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(
    async (url: string, user: string, token: string) => {
      setError(null)
      try {
        setStatus(
          await trackedInvoke<JiraStatus>("jira_save_config", {
            url,
            user,
            token,
          })
        )
      } catch (e) {
        setError(String(e))
        throw e
      }
    },
    []
  )

  const disconnect = useCallback(async () => {
    await trackedInvoke("jira_disconnect")
    setStatus({ connected: false, url: null, user: null, display_name: null })
    setError(null)
  }, [])

  // 최초 1회 연동 상태 확인.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<JiraStatus>("jira_status")
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled)
          setStatus({
            connected: false,
            url: null,
            user: null,
            display_name: null,
          })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { status, error, connect, disconnect }
}

/**
 * 연결 상태 + 내가 담당인 이슈 목록. 연결돼 있을 때만 목록을 불러온다.
 * `includeDone` 을 켜면 완료된 이슈까지 포함한다(기본은 진행 중인 것만).
 */
export function useJira() {
  const { status, error: connError, disconnect } = useJiraConnection()
  const tabActive = useTabActive()
  const [issues, setIssues] = useState<JiraIssue[]>([])
  const [includeDone, setIncludeDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await trackedInvoke<JiraIssue[]>("jira_my_issues", {
        includeDone,
      })
      setIssues(data)
      setUpdatedAt(Date.now())
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [includeDone])

  // 연결이 확인되면 목록을 불러온다.
  // (includeDone 이 바뀌면 refresh 가 새로 만들어져 즉시 다시 불러온다.)
  useEffect(() => {
    if (!status?.connected) return
    // 연결 확인 직후 첫 로드(데이터 페칭 목적의 의도된 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [status?.connected, refresh])

  // 주기 새로고침은 이 탭이 보일 때만 돈다. 숨은 탭은 마지막 목록을 그대로 유지하며,
  // 다시 들어와도 재조회하지 않는다(첫 로드 effect 와 분리해 둔 이유).
  useEffect(() => {
    if (!status?.connected || !tabActive) return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [status?.connected, tabActive, refresh])

  return {
    status,
    issues,
    loading,
    error: connError ?? error,
    updatedAt,
    includeDone,
    setIncludeDone,
    disconnect,
    refresh,
  }
}

/**
 * 선택된 이슈의 상세(본문·댓글)를 가져온다. key 가 바뀌면 이전 요청 결과는 버린다.
 */
export function useJiraIssueDetail(key: string | null) {
  // 결과를 "어떤 key 로 받은 것인지"와 함께 담는다. 선택이 바뀌면 key 가 어긋나므로
  // 이전 이슈 내용이 잠깐 보이는 일 없이, 렌더 중에 곧바로 로딩으로 판정할 수 있다
  // (이펙트 안에서 상태를 되돌리지 않아도 된다).
  const [result, setResult] = useState<{
    key: string
    detail: JiraIssueDetail | null
    error: string | null
  } | null>(null)

  useEffect(() => {
    if (!key) return
    let cancelled = false
    trackedInvoke<JiraIssueDetail>("jira_issue_detail", { key })
      .then((detail) => {
        if (!cancelled) setResult({ key, detail, error: null })
      })
      .catch((e) => {
        if (!cancelled) setResult({ key, detail: null, error: String(e) })
      })
    return () => {
      cancelled = true
    }
  }, [key])

  const fresh = result && result.key === key ? result : null
  return {
    detail: fresh?.detail ?? null,
    loading: key !== null && fresh === null,
    error: fresh?.error ?? null,
  }
}

/** 이슈를 시스템 브라우저에서 연다. */
export async function openIssueInBrowser(key: string) {
  await trackedInvoke("jira_open_issue", { key })
}
