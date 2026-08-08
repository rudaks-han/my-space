import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { useEffect, useSyncExternalStore } from "react"

import { useSettings } from "@/features/settings/settings-context"
import { isTauri, trackedInvoke } from "@/lib/tauri"

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
 * 백엔드 하나의 실행 중 서비스 집합 — **컴포넌트가 아니라 모듈이 들고 있다**.
 *
 * 배지가 붙은 메뉴가 여러 개이기 때문이다: Cowork 서비스와 IntelliJ Cowork 는 둘 다
 * standalone 을 본다. 훅 안에서 폴링하면 배지 수만큼 `<prefix>_running` 이 나가는데,
 * 그건 실행 설정 XML 을 읽고 `ps` 를 훑는 호출이라 공짜가 아니고 레일 고정까지 하면 더
 * 늘어난다. 구독자가 몇이든 백엔드당 폴링은 하나다.
 *
 * Context 대신 모듈 스토어인 이유: 배지는 사이드바·레일·팝아웃 창 어디에나 붙는데,
 * Provider 로 하면 그 트리마다 감싸 줘야 하고 빠뜨리면 조용히 0 이 된다.
 */
interface BackendStore {
  running: Set<string>
  /** standalone 이 쓰는 설정값. 모듈에서는 React context 를 못 읽어 훅이 넣어 준다. */
  configured: string | null
  listeners: Set<() => void>
  /** 구독자가 생기면 채워지고, 마지막 구독자가 떠나면 정리된다. */
  stop: (() => void) | null
  /** ide 감시를 이미 걸어 둔 프로젝트 경로(같은 경로로 두 번 걸지 않는다). */
  watched: string | null
}

function newStore(): BackendStore {
  return {
    running: new Set(),
    configured: null,
    listeners: new Set(),
    stop: null,
    watched: null,
  }
}

const STORES: Record<ServicesBackend, BackendStore> = {
  ide: newStore(),
  standalone: newStore(),
}

function emit(store: BackendStore) {
  for (const l of store.listeners) l()
}

/** 이 백엔드가 대상으로 삼는 프로젝트 경로. 정하는 방식은 `useServices` 와 같다. */
function projectOf(backend: ServicesBackend): string | null {
  return backend === "ide"
    ? readStoredProject(BACKENDS.ide.projectKey)
    : STORES.standalone.configured
}

async function refresh(backend: ServicesBackend) {
  if (!inTauri) return
  const store = STORES[backend]
  const path = projectOf(backend)
  if (!path) {
    if (store.running.size > 0) {
      store.running = new Set()
      emit(store)
    }
    return
  }
  try {
    const run = await trackedInvoke<{ name: string }[]>(
      `${BACKENDS[backend].prefix}_running`,
      { project: path }
    )
    store.running = new Set(run.map((r) => r.name))
    emit(store)
  } catch {
    // 배지는 부가 정보다 — 실패하면 직전 숫자를 그대로 둔다. 사이드바에는 오류를
    // 내보일 자리가 없고, 서비스 뷰를 열면 같은 실패를 제대로 설명해 준다.
  }
}

/**
 * ide 는 IntelliJ 에서 직접 누른 Run 을 알림으로 받지 못한다 — Rust 감시 스레드의
 * 주기적 흡수로만 잡히는데, 그 스레드는 서비스 뷰를 한 번 열어야 시작됐다. 배지가 걸어
 * 두면 앱을 켠 순간부터 맞는 숫자가 나온다(스레드는 프로세스당 하나, 중복 호출은 무시).
 */
function watchIdeProject() {
  const store = STORES.ide
  const path = projectOf("ide")
  if (!inTauri || !path || store.watched === path) return
  store.watched = path
  void trackedInvoke("intellij_watch_project", { project: path }).catch(() => {
    // 감시 등록 실패는 배지가 IDE 발 실행을 늦게 아는 것뿐이라 치명적이지 않다.
    store.watched = null
  })
}

/**
 * 첫 구독자가 붙을 때 조회·구독을 시작한다.
 *
 * 정확도는 세 갈래로 유지한다.
 *  1. 시작 시 `<prefix>_running` 한 번 — 앱을 켜기 전부터 돌던 프로세스를 흡수한다
 *     (ide 는 IntelliJ 가 띄운 것, standalone 은 지난번 실행이 남긴 것).
 *  2. `<backend>:status` 구독 — 시작·중지·크래시는 Rust 가 그때그때 알려 주므로
 *     앱을 통해 일어나는 변화는 폴링 없이 즉시 반영된다.
 *  3. ide 는 `intellij_watch_project` 로 IDE 발 실행까지 따라잡는다(위 참고).
 */
function start(backend: ServicesBackend) {
  const store = STORES[backend]
  if (store.stop) return

  const timer = setInterval(() => void refresh(backend), SAFETY_POLL_MS)
  let disposed = false
  let un: UnlistenFn | null = null

  if (inTauri) {
    void listen<StatusEvent>(`${BACKENDS[backend].event}:status`, (e) => {
      const { name, running: isRunning } = e.payload
      const s = STORES[backend]
      if (s.running.has(name) === isRunning) return
      const next = new Set(s.running)
      if (isRunning) next.add(name)
      else next.delete(name)
      s.running = next
      emit(s)
    }).then((f) => (disposed ? f() : (un = f)))
  }

  store.stop = () => {
    disposed = true
    clearInterval(timer)
    un?.()
    un = null
    store.stop = null
  }

  void refresh(backend)
  if (backend === "ide") watchIdeProject()
}

function subscribe(backend: ServicesBackend, onChange: () => void): () => void {
  const store = STORES[backend]
  store.listeners.add(onChange)
  start(backend)
  return () => {
    store.listeners.delete(onChange)
    if (store.listeners.size === 0) store.stop?.()
  }
}

// `useSyncExternalStore` 의 구독 함수는 렌더마다 같은 참조여야 한다 — 새로 만들면
// 매 렌더 재구독이 돌고, 그때마다 구독자가 0 을 스쳐 폴링이 껐다 켜진다.
const subscribeIde = (onChange: () => void) => subscribe("ide", onChange)
const subscribeStandalone = (onChange: () => void) =>
  subscribe("standalone", onChange)

/**
 * 지금 실행 중인 서비스 개수만 세는 가벼운 훅 — 사이드바·레일 배지용.
 *
 * `useServices()` 를 그냥 쓰지 않는 이유: 그쪽은 MCP 연결 확인 · 실행 설정 목록 ·
 * 로그 버퍼까지 끌고 오는데, 배지는 숫자 하나만 필요하고 **앱이 켜져 있는 내내
 * 마운트돼 있다**. 뷰와 같이 열려 있으면 같은 조회를 두 벌 돌리는 셈이 된다.
 *
 * 실제 조회는 위 모듈 스토어가 백엔드당 한 번만 돌린다 — 배지를 몇 개 붙이든 같다.
 */
export function useRunningCount(backend: ServicesBackend): number {
  // standalone 의 대상 프로젝트는 설정값 하나다(설정 → Cowork 의 홈 디렉터리).
  // ide 쪽은 뷰가 localStorage 에 적어 둔 선택을 조회할 때마다 다시 읽는다 — 같은 창의
  // `useLocalStorage` 끼리는 서로의 변경을 통보받지 못하므로(`storage` 이벤트는 다른
  // 창에서만 온다) 붙들면 뷰에서 프로젝트를 바꿔도 배지가 옛 경로를 계속 본다.
  const { settings } = useSettings()
  const configured = settings.cowork.home.trim() || null

  // 홈 디렉터리가 바뀌면 대상 프로젝트가 바뀐 것이라 곧바로 다시 센다.
  useEffect(() => {
    if (backend !== "standalone") return
    const store = STORES.standalone
    if (store.configured === configured) return
    store.configured = configured
    void refresh("standalone")
  }, [backend, configured])

  return useSyncExternalStore(
    backend === "ide" ? subscribeIde : subscribeStandalone,
    () => STORES[backend].running.size
  )
}
