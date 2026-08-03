import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import { BACKENDS, type ServicesBackend } from "./use-services"

/** `<backend>:status` 이벤트에서 배지가 쓰는 부분만. 전체 모양은 use-services.ts 에 있다. */
interface StatusEvent {
  name: string
  running: boolean
}

/**
 * 안전망 재조회 주기. 이벤트가 이미 대부분을 실시간으로 덮으므로(아래 참고) 여기는
 * "혹시 놓쳤으면 따라잡는" 용도라 느긋해도 된다 — `standalone_running` 은 실행 설정
 * XML 을 다시 읽고 `ps` 를 훑으므로 공짜가 아니다.
 */
const SAFETY_POLL_MS = 60_000

const inTauri = isTauri()

/** localStorage 에서 ide 백엔드가 고른 프로젝트 경로를 읽는다(쓰지는 않는다). */
function readStoredProject(key: string): string | null {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? (JSON.parse(raw) as string | null) : null
  } catch {
    return null
  }
}

/**
 * 지금 실행 중인 서비스 개수만 세는 가벼운 훅 — 사이드바 배지용.
 *
 * `useServices()` 를 그냥 쓰지 않는 이유: 그쪽은 MCP 연결 확인 · 실행 설정 목록 ·
 * 로그 버퍼까지 끌고 오는데, 배지는 숫자 하나만 필요하고 **앱이 켜져 있는 내내
 * 마운트돼 있다**. 뷰와 같이 열려 있으면 같은 조회를 두 벌 돌리는 셈이 된다.
 *
 * 정확도는 세 갈래로 유지한다.
 *  1. 마운트 시 `<prefix>_running` 한 번 — 앱을 켜기 전부터 돌던 프로세스를 여기서
 *     흡수한다(ide 는 IntelliJ 가 띄운 것, standalone 은 지난번 실행이 남긴 것).
 *  2. `<backend>:status` 구독 — 시작·중지·크래시는 Rust 가 그때그때 알려 주므로
 *     앱을 통해 일어나는 변화는 폴링 없이 즉시 반영된다.
 *  3. ide 는 추가로 `intellij_watch_project` 를 걸어 둔다. IntelliJ 에서 직접 Run 을
 *     누른 건 알림이 없어서 Rust 감시 스레드의 주기적 흡수로만 잡히는데, 그 스레드는
 *     지금까지 서비스 뷰를 한 번 열어야 시작됐다. 배지가 걸어 두면 앱을 켠 순간부터
 *     맞는 숫자가 나온다(스레드는 프로세스당 하나이고 중복 호출은 무시된다).
 */
export function useRunningCount(backend: ServicesBackend): number {
  const b = BACKENDS[backend]
  const isIde = backend === "ide"

  // 프로젝트를 정하는 방식은 `useServices` 와 같다 — ide 는 뷰가 localStorage 에 적어
  // 둔 선택, standalone 은 설정값. 다만 ide 쪽은 `useLocalStorage` 로 붙들지 않고 조회할
  // 때마다 다시 읽는다: 같은 창의 `useLocalStorage` 끼리는 서로의 변경을 통보받지 못하므로
  // (`storage` 이벤트는 다른 창에서만 온다) 붙들면 뷰에서 프로젝트를 바꿔도 배지는
  // 옛 경로를 계속 본다. 매번 읽으면 다음 조회에서 저절로 맞춰진다.
  const { settings } = useSettings()
  const configured = settings.cowork.home.trim()
  const project = useCallback(
    () => (isIde ? readStoredProject(b.projectKey) : configured || null),
    [isIde, b.projectKey, configured]
  )

  const [running, setRunning] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    if (!inTauri) return
    const path = project()
    if (!path) {
      setRunning(new Set())
      return
    }
    try {
      const run = await trackedInvoke<{ name: string }[]>(
        `${b.prefix}_running`,
        { project: path }
      )
      setRunning(new Set(run.map((r) => r.name)))
    } catch {
      // 배지는 부가 정보다 — 실패하면 직전 숫자를 그대로 둔다. 사이드바에는 오류를
      // 내보일 자리가 없고, 서비스 뷰를 열면 같은 실패를 제대로 설명해 준다.
    }
  }, [project, b.prefix])

  // 최초 조회 + 안전망 주기 조회.
  useEffect(() => {
    // 데이터 페칭 목적의 의도된 setState 다(use-services.ts 의 refresh 와 같은 이유).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    const t = setInterval(() => void refresh(), SAFETY_POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  // 상태 이벤트 구독 — 시작·중지·크래시를 실시간으로 반영한다.
  useEffect(() => {
    if (!inTauri) return
    let un: (() => void) | null = null
    let disposed = false

    void listen<StatusEvent>(`${b.event}:status`, (e) => {
      const { name, running: isRunning } = e.payload
      setRunning((prev) => {
        if (prev.has(name) === isRunning) return prev
        const next = new Set(prev)
        if (isRunning) next.add(name)
        else next.delete(name)
        return next
      })
    }).then((f) => (disposed ? f() : (un = f)))

    return () => {
      disposed = true
      un?.()
    }
  }, [b.event])

  // ide: IntelliJ 에서 직접 띄운 실행을 Rust 가 계속 따라잡도록 감시를 걸어 둔다.
  // 감시 스레드는 앱이 끝날 때까지 돌기 때문에 언마운트 시 끄지 않는다(끄면 서비스 뷰가
  // 열려 있는 동안의 감시까지 같이 끊긴다).
  useEffect(() => {
    if (!inTauri || !isIde) return
    const path = project()
    if (!path) return
    void trackedInvoke("intellij_watch_project", { project: path }).catch(
      () => {
        // 감시 등록 실패는 배지가 IDE 발 실행을 늦게 아는 것뿐이라 치명적이지 않다.
      }
    )
  }, [isIde, project])

  return running.size
}
