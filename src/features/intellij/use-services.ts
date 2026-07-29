import { useCallback, useEffect, useMemo, useRef, useState } from "react"
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
  /**
   * 프로젝트 규약에서 알아낸 예상 서비스 포트(cowork: `attic-port.yml`).
   * 실행 전에도 어떤 포트로 뜰지 보여 준다 — ApiGatewayApplication 처럼 같은 설정이
   * 프로필별로 다른 포트를 쓰는 경우를 구분하는 데 특히 쓸모 있다. 모르면 null.
   */
  expected_port: number | null
  /**
   * IDE 로그 동기화("Save console output to file") 상태.
   * `true` 켜짐 · `false` 꺼짐(켤 수 있음) · `null` 실행 설정이 프로젝트 파일로
   * 저장돼 있지 않아 손댈 수 없음.
   */
  log_sync: boolean | null
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

/** 순차 실행 진행 상황. Rust 의 `intellij:sequence` 이벤트와 대응. */
export interface SequenceProgress {
  /** 진행 중인 단계(1부터). */
  stage: number
  total: number
  /** 이 단계에서 띄우는 설정들. */
  names: string[]
  phase: "starting" | "waiting" | "done" | "failed" | "canceled"
  /** 실패·취소 사유(있을 때만). */
  message: string | null
}

interface SequenceStatus {
  running: boolean
  last: SequenceProgress | null
}

/** 아직 끝나지 않은 진행 상태인지. */
function isSequenceActive(p: SequenceProgress | null): boolean {
  return p != null && (p.phase === "starting" || p.phase === "waiting")
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
/** 최근 실행 목록(프로젝트 경로 → 이름들, 최근 것이 앞). */
const RECENT_KEY = "myspace.intellij.recentServices"
/** 최근 실행 스트립에 남겨 두는 최대 개수. */
const MAX_RECENT = 10
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
  const [sequence, setSequence] = useState<SequenceProgress | null>(null)

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

  // 순차 실행은 화면과 무관하게 Rust 에서 계속 진행된다. 화면에 들어왔을 때 아직
  // 돌고 있으면 진행 표시를 복원한다(이벤트는 단계가 바뀔 때만 오므로 몇 분을 기다릴 수 있다).
  useEffect(() => {
    if (!inTauri) return
    void trackedInvoke<SequenceStatus>("intellij_sequence_status")
      .then((s) => {
        if (s.running && s.last) setSequence(s.last)
      })
      .catch(() => {
        // 복원 실패는 표시만 비는 것이라 무해하다(진행 자체는 계속된다).
      })
  }, [])

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

    listen<SequenceProgress>("intellij:sequence", (e) => {
      setSequence(e.payload)
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

  /**
   * 이 앱에서 시작한 설정을 프로젝트별로 기억한다 — 상단 "최근 실행" 스트립의 재료.
   *
   * IntelliJ 에서 직접 띄운 것(`adopt_external` 이 보내는 상태 이벤트)은 넣지 않는다.
   * 앱을 켤 때 이미 떠 있던 서비스가 한꺼번에 흡수되면서 목록이 임의의 순서로
   * 채워져 버리기 때문이다 — "여기서 눌러 띄운 것" 만 담아야 순서가 뜻을 갖는다.
   */
  const [recentMap, setRecentMap] = useLocalStorage<Record<string, string[]>>(
    RECENT_KEY,
    {}
  )

  const recent = useMemo(
    () => (projectPath ? (recentMap[projectPath] ?? []) : []),
    [recentMap, projectPath]
  )

  /** `names` 를 최근 목록 맨 앞으로(주어진 순서 그대로) 올린다. */
  const pushRecent = useCallback(
    (names: string[]) => {
      if (!projectPath || names.length === 0) return
      setRecentMap((prev) => {
        const cur = prev[projectPath] ?? []
        const next = [...names, ...cur.filter((n) => !names.includes(n))].slice(
          0,
          MAX_RECENT
        )
        if (next.length === cur.length && next.every((n, i) => n === cur[i]))
          return prev
        return { ...prev, [projectPath]: next }
      })
    },
    [projectPath, setRecentMap]
  )

  /** 최근 목록에서 뺀다(스트립의 X). 서비스 자체에는 영향이 없다. */
  const removeRecent = useCallback(
    (name: string) => {
      if (!projectPath) return
      setRecentMap((prev) => {
        const cur = prev[projectPath]
        if (!cur?.includes(name)) return prev
        return { ...prev, [projectPath]: cur.filter((n) => n !== name) }
      })
    },
    [projectPath, setRecentMap]
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
      pushRecent([name])
      // HTTP Request 설정은 장기 서비스가 아니라 한 번 실행 → 응답 표시라, Rust 가
      // 종류에 따라 실행 방식을 달리한다(waitForExit). 종류를 함께 넘긴다.
      const kind = services.find((s) => s.name === name)?.type ?? null
      return withPending(name, () =>
        trackedInvoke("intellij_start_service", {
          project: projectPath,
          name,
          kind,
        })
      )
    },
    [projectPath, withPending, clearFailed, pushRecent, services]
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
      pushRecent([name])
      const kind = services.find((s) => s.name === name)?.type ?? null
      return withPending(name, () =>
        trackedInvoke("intellij_restart_service", {
          project: projectPath,
          name,
          kind,
        })
      )
    },
    [projectPath, withPending, clearFailed, pushRecent, services]
  )

  const stop = useCallback(
    (name: string) =>
      withPending(name, () => trackedInvoke("intellij_stop_service", { name })),
    [withPending]
  )

  /**
   * 여러 설정을 **차례로** 시작한다(목록에서 ⌘ 클릭으로 여러 개를 고른 경우).
   *
   * 동시에 요청하지 않는 이유는 순차 실행(`run_sequence`)과 같다 — IntelliJ 는 실행 요청마다
   * Make 를 돌리므로 한꺼번에 밀어 넣으면 IDE 가 요청을 섞어 처리한다. 이미 실행 중인 것은
   * 건너뛴다(다시 띄우면 그것에 의존하는 서비스가 끊긴다).
   */
  const startMany = useCallback(
    async (names: string[]) => {
      for (const name of names) {
        if (running.has(name)) continue
        await start(name)
      }
    },
    [running, start]
  )

  /** 여러 설정을 한꺼번에 내린다. 종료는 SIGTERM 한 방이라 동시에 보내도 된다. */
  const stopMany = useCallback(
    (names: string[]) => Promise.all(names.map((n) => stop(n))),
    [stop]
  )

  /**
   * 실행 중이면서 종료를 제어할 수 있는(stoppable) 서비스를 한꺼번에 내린다.
   * IntelliJ Services 창의 "Stop All" 과 같은 역할 — 일괄 실행으로 띄운 것을 한 번에 끈다.
   */
  const stopAll = useCallback(() => {
    const targets = services.filter((s) => running.has(s.name) && s.stoppable)
    return stopMany(targets.map((s) => s.name))
  }, [services, running, stopMany])

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

  /**
   * 실행 설정의 "Save console output to file"(Logs 탭)을 켠다.
   *
   * IDE 의 Run 버튼으로 띄운 프로세스의 콘솔은 IntelliJ 안에만 있어 밖에서 읽을 수 없다.
   * 이 옵션을 켜 두면 IDE 가 콘솔을 파일로도 남기고, Rust 가 그 파일을 tail 해서 여기에
   * 흘려준다. **이미 떠 있는 프로세스에는 적용되지 않는다** — 다음 실행부터다.
   *
   * 켠 뒤 목록을 다시 읽어 `log_sync` 표시를 갱신한다.
   */
  const enableLogSync = useCallback(
    (name: string) => {
      if (!projectPath) return Promise.resolve()
      return withPending(name, async () => {
        await trackedInvoke<string[]>("intellij_enable_log_sync", {
          project: projectPath,
          name,
        })
        await refresh()
      })
    },
    [projectPath, withPending, refresh]
  )

  /**
   * 프리셋 단계대로 순차 실행을 시작한다. 진행은 Rust 가 맡고(화면을 떠나도 계속됨)
   * 여기서는 `intellij:sequence` 이벤트로 상태만 따라간다.
   */
  const startSequence = useCallback(
    async (stages: string[][]) => {
      if (!inTauri || !projectPath) return
      setError(null)
      // 일괄 실행으로 뜬 것들도 최근 목록에 담는다 — 그중 하나만 다시 올리는 일이
      // 잦은데, 단계 순서대로 넣어 두면 스트립이 실행 순서 그대로 보인다.
      pushRecent([...new Set(stages.flat())])
      // 첫 이벤트가 도착하기 전에도 버튼이 진행 중으로 보이게 낙관적으로 채운다.
      setSequence({
        stage: 1,
        total: stages.length,
        names: stages[0] ?? [],
        phase: "starting",
        message: null,
      })
      try {
        await trackedInvoke("intellij_start_sequence", {
          project: projectPath,
          stages,
        })
      } catch (e) {
        setError(String(e))
        setSequence(null)
      }
    },
    [projectPath, pushRecent]
  )

  /** 다음 단계로 넘어가기 전에 멈춘다. 이미 뜬 서비스는 그대로 둔다. */
  const cancelSequence = useCallback(() => {
    void trackedInvoke("intellij_cancel_sequence").catch(() => {})
  }, [])

  /** 완료·실패 표시를 닫는다. */
  const dismissSequence = useCallback(() => setSequence(null), [])

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
    sequence,
    /** 이 앱에서 최근에 시작한 설정 이름(최근 것이 앞). 상단 "최근 실행" 스트립용. */
    recent,
    removeRecent,
    /** 순차 실행이 아직 진행 중인지(버튼을 중단으로 바꾸는 기준). */
    sequenceActive: isSequenceActive(sequence),
    refresh,
    loadLogs,
    start,
    restart,
    stop,
    startMany,
    stopMany,
    stopAll,
    enableLogSync,
    startSequence,
    cancelSequence,
    dismissSequence,
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
