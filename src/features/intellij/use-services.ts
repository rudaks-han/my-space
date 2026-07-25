import { useCallback, useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"

/** IntelliJ 실행 설정 하나. Rust 의 Service 와 대응. */
export interface Service {
  name: string
  /** "spring-boot" | "multirun" | "junit" | "java" | "http" | "other" */
  type: string
  /** IntelliJ 가 준 설명(예: "Spring Boot Application"). */
  description: string | null
  module: string | null
  main_class: string | null
  profiles: string | null
  vm_parameters: string | null
  /** Multirun 이 참조하는 하위 설정 이름들. */
  children: string[]
  /** 이 앱에서 종료까지 제어할 수 있는지(메인 클래스를 알아야 가능). */
  stoppable: boolean
}

export interface RecentProject {
  name: string
  path: string
}

/** IntelliJ MCP 서버 연결 상태. */
export interface McpStatus {
  connected: boolean
  url: string | null
  error: string | null
}

interface LogEvent {
  name: string
  line: string
}

interface StatusEvent {
  name: string
  running: boolean
  pid: number | null
  /** LISTEN 포트. 기동 직후에는 null 이고, 바인딩되면 다시 이벤트가 온다. */
  port: number | null
  /** 시작 실패·실행 중 크래시면 그 사유. 정상이면 null. 다음 시작까지 유지된다. */
  failed: string | null
}

const PROJECT_KEY = "myspace.intellij.project"
/** 서비스별 로그 링버퍼 최대 줄 수(메모리 보호). */
const MAX_LOG_LINES = 2000

const inTauri = isTauri()

/**
 * IntelliJ 실행 설정을 다루는 훅.
 *
 * 목록·실행 모두 **IntelliJ 내장 MCP 서버**를 통해 IDE 가 직접 처리한다
 * (Maven/Gradle 로 재현하지 않는다). 상태와 로그는 Rust 가 방출하는
 * `intellij:status`·`intellij:log` 이벤트로 실시간 갱신한다.
 */
export function useServices() {
  const [projectPath, setProjectPath] = useLocalStorage<string | null>(
    PROJECT_KEY,
    null
  )
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [running, setRunning] = useState<Set<string>>(new Set())
  // 시작 실패·크래시로 종료된 서비스: name → 사유. 다음 시작/재시작 때 지운다.
  const [failed, setFailed] = useState<Map<string, string>>(new Map())
  const [pids, setPids] = useState<Record<string, number>>({})
  const [ports, setPorts] = useState<Record<string, number>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [mcp, setMcp] = useState<McpStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // 최근 프로젝트 로드 + 저장된 선택이 없으면 기본값(cowork 우선) 지정.
  useEffect(() => {
    if (!inTauri) return
    trackedInvoke<RecentProject[]>("intellij_recent_projects")
      .then((ps) => {
        setProjects(ps)
        setProjectPath(
          (cur) =>
            cur ??
            ps.find((p) => p.name === "cowork")?.path ??
            ps[0]?.path ??
            null
        )
      })
      .catch((e) => setError(String(e)))
  }, [setProjectPath])

  const refresh = useCallback(async () => {
    if (!inTauri || !projectPath) {
      setServices([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const status = await trackedInvoke<McpStatus>("intellij_mcp_status")
      setMcp(status)
      if (!status.connected) {
        setServices([])
        return
      }
      const [list, run] = await Promise.all([
        trackedInvoke<Service[]>("intellij_list_services", {
          project: projectPath,
        }),
        // IntelliJ 에서 직접 띄운 서비스도 여기서 찾아 실행 중으로 잡아 준다.
        trackedInvoke<{ name: string; pid: number; port: number | null }[]>(
          "intellij_running",
          { project: projectPath }
        ),
      ])
      setServices(list)
      const runningNames = new Set(run.map((r) => r.name))
      setRunning(runningNames)
      // 지금 실행 중으로 확인된 서비스는 실패 표시를 지운다(과거 실패는 유지).
      setFailed((prev) => {
        if (![...runningNames].some((n) => prev.has(n))) return prev
        const next = new Map(prev)
        runningNames.forEach((n) => next.delete(n))
        return next
      })
      setPids(Object.fromEntries(run.map((r) => [r.name, r.pid])))
      setPorts(
        Object.fromEntries(
          run
            .filter((r) => r.port != null)
            .map((r) => [r.name, r.port as number])
        )
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [projectPath])

  // 프로젝트가 바뀌면 목록 재조회.
  useEffect(() => {
    // refresh 는 내부에서 setLoading 을 부르지만, 데이터 페칭 목적의 의도된 패턴이다.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  // IntelliJ 에서 직접 시작한 실행을 Rust 가 계속 따라잡도록 감시 대상을 알려준다.
  // 감시 스레드는 이 화면을 떠나도 계속 돌기 때문에 언마운트 시 끄지 않는다 —
  // 다시 들어왔을 때 이미 상태가 맞아 있고, 상태 이벤트는 어차피 구독 중일 때만 쓰인다.
  useEffect(() => {
    if (!inTauri || !projectPath) return
    void trackedInvoke("intellij_watch_project", {
      project: projectPath,
    }).catch(() => {
      // 감시 등록 실패는 치명적이지 않다(수동 새로고침으로 여전히 따라잡을 수 있다).
    })
  }, [projectPath])

  // 상태/로그 이벤트 구독.
  useEffect(() => {
    if (!inTauri) return
    const unlisteners: Array<() => void> = []
    let disposed = false

    listen<StatusEvent>("intellij:status", (e) => {
      const {
        name,
        running: isRunning,
        pid,
        port,
        failed: failReason,
      } = e.payload
      setRunning((prev) => {
        const next = new Set(prev)
        if (isRunning) next.add(name)
        else next.delete(name)
        return next
      })
      setFailed((prev) => {
        // 실행 중이면 실패 표시 제거, 실패 사유가 오면 기록, 정상 중지면 제거.
        const has = prev.has(name)
        if (failReason) {
          if (prev.get(name) === failReason) return prev
          return new Map(prev).set(name, failReason)
        }
        if (!has) return prev
        const next = new Map(prev)
        next.delete(name)
        return next
      })
      setPids((prev) => {
        if (isRunning && pid != null) return { ...prev, [name]: pid }
        if (!(name in prev)) return prev
        const rest = { ...prev }
        delete rest[name]
        return rest
      })
      setPorts((prev) => {
        // 포트는 나중에 채워지므로, running 이벤트에 포트가 없으면 기존 값을 지우지 않는다.
        if (isRunning) return port != null ? { ...prev, [name]: port } : prev
        if (!(name in prev)) return prev
        const rest = { ...prev }
        delete rest[name]
        return rest
      })
    }).then((un) => (disposed ? un() : unlisteners.push(un)))

    listen<LogEvent>("intellij:log", (e) => {
      const { name, line } = e.payload
      setLogs((prev) => {
        const cur = prev[name] ?? []
        const next =
          cur.length >= MAX_LOG_LINES
            ? cur.slice(-MAX_LOG_LINES + 1)
            : cur.slice()
        next.push(line)
        return { ...prev, [name]: next }
      })
    }).then((un) => (disposed ? un() : unlisteners.push(un)))

    return () => {
      disposed = true
      unlisteners.forEach((un) => un())
    }
  }, [])

  /** 진행 중인 시작/재시작/종료 요청. 버튼 중복 클릭을 막는다. */
  const [pending, setPending] = useState<Set<string>>(new Set())

  const withPending = useCallback(
    async (name: string, fn: () => Promise<unknown>) => {
      setPending((prev) => new Set(prev).add(name))
      setError(null)
      try {
        await fn()
      } catch (e) {
        setError(String(e))
      } finally {
        setPending((prev) => {
          const next = new Set(prev)
          next.delete(name)
          return next
        })
      }
    },
    []
  )

  /** 시작/재시작 시 이전 실패 표시를 즉시 지운다(다음 시작까지 유지 규칙의 해제 지점). */
  const clearFailed = useCallback((name: string) => {
    setFailed((prev) => {
      if (!prev.has(name)) return prev
      const next = new Map(prev)
      next.delete(name)
      return next
    })
  }, [])

  const start = useCallback(
    (name: string) => {
      if (!projectPath) return Promise.resolve()
      // 시작 시 이전 로그를 비워 새 실행만 보이게 한다.
      setLogs((prev) => ({ ...prev, [name]: [] }))
      clearFailed(name)
      return withPending(name, () =>
        trackedInvoke("intellij_start_service", { project: projectPath, name })
      )
    },
    [projectPath, withPending, clearFailed]
  )

  /**
   * 실행 중인 서비스를 내렸다가 다시 띄운다. Rust 가 이전 프로세스의 완전 종료를
   * 확인한 뒤 실행하므로(포트 충돌 방지) 응답까지 몇 초 걸린다.
   */
  const restart = useCallback(
    (name: string) => {
      if (!projectPath) return Promise.resolve()
      setLogs((prev) => ({ ...prev, [name]: [] }))
      clearFailed(name)
      return withPending(name, () =>
        trackedInvoke("intellij_restart_service", {
          project: projectPath,
          name,
        })
      )
    },
    [projectPath, withPending, clearFailed]
  )

  const stop = useCallback(
    (name: string) =>
      withPending(name, () => trackedInvoke("intellij_stop_service", { name })),
    [withPending]
  )

  /**
   * Rust 에 보관된 로그로 콘솔을 복원한다.
   *
   * 프론트의 로그 상태는 이 화면을 떠나면(메뉴 전환 → 언마운트) 사라진다. Rust 는
   * 계속 tail 하며 버퍼에 쌓아 두므로, 화면에 들어오거나 서비스를 고를 때 여기서 받아온다.
   */
  const loadLogs = useCallback(async (name: string) => {
    if (!inTauri) return
    try {
      const lines = await trackedInvoke<string[]>("intellij_logs", { name })
      // 버퍼가 지금까지의 전부이므로 그대로 교체한다. 이 호출과 겹쳐 도착한 줄은
      // 이벤트로 뒤에 덧붙는다(경계에서 한 줄이 겹칠 수 있으나 무해하다).
      setLogs((prev) => ({ ...prev, [name]: lines }))
    } catch {
      // 로그 복원 실패는 치명적이지 않다(라이브 이벤트는 계속 들어온다).
    }
  }, [])

  const clearLogs = useCallback((name: string) => {
    setLogs((prev) => ({ ...prev, [name]: [] }))
    // Rust 버퍼도 비운다. 남겨 두면 화면을 다시 열 때 지운 로그가 되살아난다.
    void trackedInvoke("intellij_clear_logs", { name }).catch(() => {})
  }, [])

  return {
    projects,
    projectPath,
    setProjectPath,
    services,
    running,
    failed,
    pids,
    ports,
    logs,
    mcp,
    error,
    loading,
    pending,
    refresh,
    loadLogs,
    start,
    restart,
    stop,
    clearLogs,
  }
}

/**
 * 로그 영역을 새 줄이 올 때 맨 아래로 붙여 주는 ref.
 * 사용자가 위로 스크롤해 과거 로그를 보고 있으면 따라가지 않는다.
 */
export function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      // 바닥에서 40px 이내면 "따라가는 중"으로 본다.
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener("scroll", onScroll)
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])

  return ref
}
