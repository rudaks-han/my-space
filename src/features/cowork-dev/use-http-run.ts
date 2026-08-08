/**
 * IntelliJ Cowork 화면의 `.http` 실행기 — 환경·전역 변수·실행 결과를 **탭 여러 개가 함께**
 * 쓰는 모양으로 다시 짠 것.
 *
 * `intellij-http` 의 `useHttpFiles` 를 그대로 쓰지 않는 이유가 둘이다.
 *  1. 저쪽은 **열린 파일이 하나**라는 전제로 짜여 있다 — `run` 이 자기 `openPath` 를
 *     클로저로 물고 있어서, 탭이 여러 개인 여기서는 `< ./include` 를 엉뚱한 파일 기준으로
 *     풀고 응답도 엉뚱한 키에 쌓인다. 그래서 `run(req, filePath)` 로 **파일을 인자로** 받는다.
 *  2. 저쪽의 localStorage 키(`myspace.intellijHttp.*`)를 같이 쓰면 IntelliJ HTTP 탭과
 *     서로의 값을 덮어쓴다 — 두 화면 다 keep-alive 라 동시에 열려 있는 게 기본이다.
 *     그래서 키는 전부 `NS` 아래에 둔다.
 *
 * 파일 목록·편집 버퍼는 여기 없다. 그건 왼쪽 프로젝트 트리와 가운데 탭 모델의 몫이고,
 * 이 훅은 "실행에 필요한 것"만 들고 있다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isTauri } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import {
  readEnvFiles,
  type HttpEnvs,
} from "@/features/intellij-http/http-client"
import {
  requestLabel,
  type HttpRequest,
} from "@/features/intellij-http/http-parse"
import {
  runRequest,
  type RunResult,
} from "@/features/intellij-http/run-request"
import { NS } from "./types"

/** 전역 변수(`client.global.set`)는 프로젝트별로 남긴다 — 토큰을 받아 두고 앱을 껐다 켜도 이어 쓴다. */
const GLOBALS_KEY = `${NS}.http.globals`
/** 고른 환경 이름도 프로젝트별. 파일마다 다르게 고르는 사용법은 없었다. */
const ENV_KEY = `${NS}.http.env`

const inTauri = isTauri()

const EMPTY_ENVS: HttpEnvs = { envs: [], sources: [] }

/** 파일 경로 + 요청 순번 → 응답을 기억하는 키. */
export function responseKey(filePath: string, index: number): string {
  return `${filePath}#${index}`
}

/**
 * 이 파일의 환경 사슬에서 실제로 쓸 변수표를 고른다.
 *
 * 이름이 없거나 사슬에 없으면 **첫 환경으로 떨어진다**. 환경은 `.http` 파일이 든 폴더에서
 * 루트까지 거슬러 찾으므로 파일마다 사슬이 다른데, 이름이 안 맞는다고 빈 표를 쓰면
 * `{{host}}` 하나 못 풀고 요청이 통째로 실패한다 — 아무것도 안 되는 것보다 낫다.
 */
function pickEnv(envs: HttpEnvs, want: string | null): Record<string, string> {
  if (envs.envs.length === 0) return {}
  const found = want ? envs.envs.find((e) => e.name === want) : undefined
  return (found ?? envs.envs[0]).vars
}

export function useHttpRun(project: string) {
  const [globalsByProject, setGlobalsByProject] = useLocalStorage<
    Record<string, Record<string, string>>
  >(GLOBALS_KEY, {})
  const [envByProject, setEnvByProject] = useLocalStorage<
    Record<string, string>
  >(ENV_KEY, {})

  const [results, setResults] = useState<Record<string, RunResult>>({})
  const [running, setRunning] = useState<Set<string>>(new Set())
  /**
   * 마지막 실행 — **키가 아니라 실행 자체**를 신호로 삼는다.
   *
   * 키만 상태로 두면 같은 요청을 다시 보낼 때 값이 그대로라 React 가 리렌더를
   * 건너뛰고(Object.is), "실행했으니 응답 칸을 보여라"는 이펙트가 아예 돌지 않는다.
   * 요청을 다시 보내는 건 HTTP 클라이언트의 기본 동작이라 그게 곧 죽은 ▶ 가 된다.
   * 그래서 실행마다 증가하는 순번을 함께 담아 매번 새 객체가 되게 한다.
   */
  const [lastRun, setLastRun] = useState<{ key: string; seq: number } | null>(
    null
  )
  const runSeq = useRef(0)
  const [envError, setEnvError] = useState<string | null>(null)

  /* ── 환경 파일 — 파일별로 캐시한다 ── */

  /**
   * 캐시를 ref 와 state 두 벌로 든다: `run` 은 렌더를 기다릴 수 없어 ref 를 읽고,
   * 화면(환경 목록)은 state 를 읽는다. 하나로 줄이면 둘 중 하나가 항상 한 박자 늦는다.
   */
  const envsRef = useRef<Record<string, HttpEnvs>>({})
  const [envsByFile, setEnvsByFile] = useState<Record<string, HttpEnvs>>({})
  /** 같은 파일에 대한 중복 호출을 하나로 묶는다(탭 활성화와 실행이 같은 tick 에 겹친다). */
  const pendingRef = useRef(new Map<string, Promise<HttpEnvs>>())
  /** 지금 화면이 보고 있는 파일 — 환경 목록이 어느 사슬의 것인지 정한다. */
  const [envFile, setEnvFile] = useState<string | null>(null)

  // 프로젝트가 바뀌면 사슬 자체가 달라진다(탐색이 프로젝트 루트에서 멈춘다).
  useEffect(() => {
    envsRef.current = {}
    pendingRef.current.clear()
    // 캐시 무효화 목적의 의도된 setState(다른 뷰들과 같은 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnvsByFile({})
  }, [project])

  const ensureEnvs = useCallback(
    (filePath: string): Promise<HttpEnvs> => {
      const hit = envsRef.current[filePath]
      if (hit) return Promise.resolve(hit)
      const inflight = pendingRef.current.get(filePath)
      if (inflight) return inflight

      const load = (async (): Promise<HttpEnvs> => {
        if (!inTauri || !project) return EMPTY_ENVS
        try {
          const envs = await readEnvFiles(project, filePath)
          setEnvError(null)
          return envs
        } catch (e) {
          setEnvError(String(e))
          return EMPTY_ENVS
        }
      })().then((envs) => {
        envsRef.current = { ...envsRef.current, [filePath]: envs }
        setEnvsByFile(envsRef.current)
        pendingRef.current.delete(filePath)
        return envs
      })

      pendingRef.current.set(filePath, load)
      return load
    },
    [project]
  )

  /** 이 파일을 "지금 보는 파일"로 삼고 환경 사슬을 읽어 둔다. */
  const loadEnvs = useCallback(
    async (filePath: string) => {
      setEnvFile(filePath)
      await ensureEnvs(filePath)
    },
    [ensureEnvs]
  )

  const envNames = useMemo(() => {
    const envs = envFile ? envsByFile[envFile] : undefined
    return envs ? envs.envs.map((e) => e.name) : []
  }, [envFile, envsByFile])

  const storedEnv = envByProject[project] ?? null

  /**
   * 화면에 보여 줄 환경 이름은 **저장값이 아니라 지금 파일에서 실제로 쓰이는 이름**이다.
   * 저장값이 이 파일의 사슬에 없으면 `pickEnv` 가 첫 환경으로 떨어지는데, 선택 상자만
   * 옛 이름을 붙들고 있으면 화면과 실행이 서로 다른 말을 한다.
   */
  const envName = useMemo(() => {
    if (envNames.length === 0) return null
    if (storedEnv && envNames.includes(storedEnv)) return storedEnv
    return envNames[0]
  }, [storedEnv, envNames])

  const setEnvName = useCallback(
    (name: string | null) => {
      setEnvByProject((prev) => {
        const next = { ...prev }
        if (name) next[project] = name
        else delete next[project]
        return next
      })
    },
    [project, setEnvByProject]
  )

  /** 지금 보는 파일에서 유효한 변수표 — 편집기의 `{{var}}` 해결 여부 판정에 쓴다. */
  const envVars = useMemo(() => {
    const envs = envFile ? envsByFile[envFile] : undefined
    return envs ? pickEnv(envs, storedEnv) : {}
  }, [envFile, envsByFile, storedEnv])

  /* ── 전역 변수 ── */
  const globals = useMemo(
    () => globalsByProject[project] ?? {},
    [globalsByProject, project]
  )

  /**
   * 실행이 읽는 전역 변수는 **ref 가 정답이다.**
   *
   * "전체 실행"은 요청을 순차로 도는 한 번의 async 루프인데, 그 안의 `run` 은 자기가
   * 만들어질 때의 `globals` 를 클로저로 물고 있다. 상태만 갱신하면 1번 요청이 발급한
   * 토큰을 2번 요청이 못 본다 — 로그인 → 토큰 → 다음 요청이라는 이 기능의 핵심 흐름이
   * 조용히 깨진다. 그래서 `runRequest` 가 돌려주는 변경분을 **다음 await 전에** ref 에
   * 동기로 반영하고, 표시용 상태(localStorage)는 그와 별개로 따라간다.
   */
  const globalsRef = useRef(globals)
  useEffect(() => {
    globalsRef.current = globals
  }, [globals])

  const applyGlobalUpdates = useCallback(
    (updates: Record<string, string | null>) => {
      if (Object.keys(updates).length === 0) return
      const next = { ...globalsRef.current }
      Object.entries(updates).forEach(([k, v]) => {
        if (v === null) delete next[k]
        else next[k] = v
      })
      globalsRef.current = next
      setGlobalsByProject((prev) => ({ ...prev, [project]: next }))
    },
    [project, setGlobalsByProject]
  )

  /** 전역 변수를 통째로 바꾼다(비우기·직접 편집). ref 도 같은 자리에서 맞춰 둔다. */
  const setGlobals = useCallback(
    (next: Record<string, string>) => {
      globalsRef.current = next
      setGlobalsByProject((prev) => ({ ...prev, [project]: next }))
    },
    [project, setGlobalsByProject]
  )

  /* ── 실행 ── */
  const run = useCallback(
    async (req: HttpRequest, filePath: string) => {
      const key = responseKey(filePath, req.index)
      setLastRun({ key, seq: ++runSeq.current })
      setRunning((prev) => new Set(prev).add(key))
      try {
        const envs = await ensureEnvs(filePath)
        const result = await runRequest({
          req,
          // `< ./include` 와 `>> ./out.json` 의 기준이 되는 파일 — 탭마다 다르므로
          // 훅이 아니라 호출부가 알려 준다.
          filePath,
          globals: globalsRef.current,
          env: pickEnv(envs, storedEnv),
          label: requestLabel(req),
        })
        setResults((prev) => ({ ...prev, [key]: result }))
        applyGlobalUpdates(result.globalUpdates)
      } finally {
        setRunning((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [ensureEnvs, storedEnv, applyGlobalUpdates]
  )

  /**
   * 파일의 요청을 **차례로** 실행한다.
   *
   * 동시에 보내지 않는 이유: 토큰을 받아 다음 요청에서 쓰는 흐름이 흔해 순서가 곧
   * 의미다(IntelliJ 의 "Run all requests in file" 도 순차다). 위 ref 규칙이 지켜져야
   * 이 루프가 실제로 이어진다.
   */
  const runAll = useCallback(
    async (reqs: HttpRequest[], filePath: string) => {
      for (const req of reqs) {
        await run(req, filePath)
      }
    },
    [run]
  )

  /** 결과를 지운다. 키를 주면 그 하나만, 없으면 전부(툴바의 ⌫지우기). */
  const clear = useCallback((key?: string) => {
    if (!key) {
      setResults({})
      setLastRun(null)
      return
    }
    setResults((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    setLastRun((cur) => (cur?.key === key ? null : cur))
  }, [])

  return {
    /* 전역 변수 */
    globals,
    setGlobals,
    /* 실행 결과 */
    results,
    running,
    run,
    runAll,
    /** 마지막으로 실행한 요청의 결과 키(표시용). */
    lastKey: lastRun?.key ?? null,
    /** 같은 요청을 다시 보내도 바뀌는 실행 신호 — 이펙트는 반드시 이쪽을 볼 것. */
    lastRun,
    clear,
    /* 환경 */
    envName,
    setEnvName,
    envNames,
    envVars,
    loadEnvs,
    envError,
  }
}
