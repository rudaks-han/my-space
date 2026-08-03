import { useCallback, useEffect, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"
import { gitStatus, type GitStatus } from "./git-client"

/** 상태 자동 새로고침 주기. 파일 변경을 감시하지 않으므로(폴링) 5초로 둔다. */
const POLL_MS = 5000

/**
 * 저장소 상태를 읽고, 상태를 바꾸는 git 작업을 한 곳에서 실행한다.
 *
 * 두 가지가 이 훅의 전부다:
 * - **폴링은 탭이 보일 때만** 돈다(`useTabActive`). 탭은 닫을 때까지 마운트된 채라
 *   게이트하지 않으면 열어 둔 모든 탭이 동시에 git 을 부른다. 첫 로드 effect 와
 *   주기 effect 를 나눠 둔 것도 같은 이유 — 합치면 탭을 옮길 때마다 다시 읽는다.
 * - **작업 중에는 폴링을 쉰다**(`busy`). 커밋·롤백은 인덱스를 몇 단계에 걸쳐 바꾸므로,
 *   그 사이에 읽은 상태를 화면에 그리면 파일이 잠깐 사라졌다 나타난다.
 */
export function useGit(home: string) {
  const tabActive = useTabActive()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 진행 중인 작업 이름(버튼 비활성화 + 상태줄 표시). 없으면 null. */
  const [busy, setBusy] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  /** 폴링 콜백이 최신 busy 를 보도록 ref 로도 들고 있는다(effect 재생성 방지). */
  const busyRef = useRef<string | null>(null)

  const refresh = useCallback(
    async (quiet = false) => {
      if (!isTauri()) {
        setError("데스크톱 앱에서만 사용할 수 있습니다.")
        return
      }
      if (!quiet) setLoading(true)
      try {
        const next = await gitStatus(home)
        setStatus(next)
        setError(null)
        setUpdatedAt(Date.now())
      } catch (e) {
        setError(String(e))
        if (!quiet) setStatus(null)
      } finally {
        if (!quiet) setLoading(false)
      }
    },
    [home]
  )

  useEffect(() => {
    // 진입/홈 변경 시 한 번 읽는다(데이터 페칭 목적의 의도된 setState).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!tabActive) return
    const timer = setInterval(() => {
      if (!busyRef.current) void refresh(true)
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [tabActive, refresh])

  /**
   * git 작업 하나를 실행하고 끝나면 상태를 다시 읽는다.
   * 성공하면 명령 출력(있으면)을, 실패하면 에러 메시지를 돌려준다.
   */
  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      setBusy(label)
      busyRef.current = label
      try {
        const out = await fn()
        await refresh(true)
        return { ok: true as const, text: typeof out === "string" ? out : "" }
      } catch (e) {
        await refresh(true)
        return { ok: false as const, text: String(e) }
      } finally {
        busyRef.current = null
        setBusy(null)
      }
    },
    [refresh]
  )

  return { status, loading, error, busy, updatedAt, refresh, run }
}
