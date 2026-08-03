/**
 * IntelliJ HTTP 화면의 상태 묶음 — 프로젝트 선택, `.http` 파일 목록, 편집 버퍼,
 * 환경 변수, 전역 변수, 실행 결과.
 *
 * 편집 버퍼를 파일별로 들고 있는 이유: IDE 처럼 다른 파일을 눌렀다가 돌아와도 고치던
 * 내용이 남아 있어야 한다. 그래서 저장 안 한 내용을 잃게 되는 "정말 이동할까요?" 확인
 * 창이 아예 필요 없고, 트리에는 수정된 파일에 점만 찍는다.
 *
 * 전역 변수(`client.global.set`)는 **프로젝트별로 localStorage 에 남긴다** — 토큰을
 * 받아 두고 앱을 껐다 켜도 이어서 쓰는 게 이 기능의 실제 사용법이다.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import {
  createHttpFile,
  listHttpFiles,
  readEnvFiles,
  readHttpFile,
  writeHttpFile,
  type HttpEnvs,
  type HttpFileEntry,
} from "./http-client"
import { parseHttpFile, requestLabel, type HttpRequest } from "./http-parse"
import { runRequest, type RunResult } from "./run-request"

/** IntelliJ 최근 프로젝트(intellij.rs 의 `RecentProject`). */
interface RecentProject {
  name: string
  path: string
}

/** 열려 있는 파일 하나의 편집 상태. */
export interface Buffer {
  path: string
  name: string
  /** 편집 중인 원문. */
  text: string
  /** 마지막으로 읽거나 저장한 원문 — 수정 여부 판정 기준. */
  saved: string
}

const PROJECT_KEY = "myspace.intellijHttp.project"
/** IntelliJ 서비스 화면이 고른 프로젝트 — 처음 들어왔을 때 기본값으로 빌려 쓴다. */
const IDE_PROJECT_KEY = "myspace.intellij.project"
const LAST_FILE_KEY = "myspace.intellijHttp.lastFile"
const ENV_KEY = "myspace.intellijHttp.env"
const GLOBALS_KEY = "myspace.intellijHttp.globals"

const inTauri = isTauri()

/** localStorage 에서 문자열 하나를 조용히 읽는다(다른 화면의 키를 빌릴 때만 쓴다). */
function readStored(key: string): string | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw)
    return typeof v === "string" && v ? v : null
  } catch {
    return null
  }
}

/** 파일 경로 + 요청 순번 → 응답을 기억하는 키. */
export function responseKey(path: string, index: number): string {
  return `${path}#${index}`
}

export function useHttpFiles() {
  const [projects, setProjects] = useState<RecentProject[]>([])
  const [project, setProject] = useLocalStorage<string | null>(
    PROJECT_KEY,
    null
  )
  const [lastFile, setLastFile] = useLocalStorage<string | null>(
    LAST_FILE_KEY,
    null
  )
  const [envByProject, setEnvByProject] = useLocalStorage<
    Record<string, string>
  >(ENV_KEY, {})
  const [globalsByProject, setGlobalsByProject] = useLocalStorage<
    Record<string, Record<string, string>>
  >(GLOBALS_KEY, {})

  const [files, setFiles] = useState<HttpFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [buffers, setBuffers] = useState<Record<string, Buffer>>({})
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [envs, setEnvs] = useState<HttpEnvs>({ envs: [], sources: [] })

  const [results, setResults] = useState<Record<string, RunResult>>({})
  const [running, setRunning] = useState<Set<string>>(new Set())

  /* ── 프로젝트 목록 ── */
  useEffect(() => {
    if (!inTauri) return
    trackedInvoke<RecentProject[]>("intellij_recent_projects")
      .then((ps) => {
        setProjects(ps)
        setProject(
          (cur) => cur ?? readStored(IDE_PROJECT_KEY) ?? ps[0]?.path ?? null
        )
      })
      .catch((e) => setError(String(e)))
  }, [setProject])

  /* ── 파일 목록 ── */
  const refresh = useCallback(async () => {
    if (!inTauri || !project) {
      setFiles([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setFiles(await listHttpFiles(project))
    } catch (e) {
      setFiles([])
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [project])

  useEffect(() => {
    // 데이터 로딩 목적의 의도된 setState(다른 뷰들과 같은 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  /* ── 파일 열기 ── */
  const openFile = useCallback(
    async (path: string) => {
      setLastFile(path)
      setOpenPath(path)
      if (buffers[path]) return
      try {
        const file = await readHttpFile(path)
        setBuffers((prev) => ({
          ...prev,
          [path]: {
            path: file.path,
            name: file.name,
            text: file.text,
            saved: file.text,
          },
        }))
      } catch (e) {
        setError(String(e))
      }
    },
    [buffers, setLastFile]
  )

  // 목록이 채워지면 지난번에 보던 파일을 되살린다(없으면 아무것도 열지 않는다).
  useEffect(() => {
    if (openPath || files.length === 0) return
    const target =
      lastFile && files.some((f) => f.path === lastFile) ? lastFile : null
    // 파일을 여는 것은 화면 복원 목적의 의도된 setState 다(다른 뷰들과 같은 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (target) void openFile(target)
    // openFile 은 buffers 가 바뀔 때마다 새로 만들어지므로 의존성에 넣지 않는다 —
    // 넣으면 파일을 열자마자 이 효과가 다시 돌면서 같은 파일을 계속 다시 연다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, lastFile, openPath])

  /* ── 환경 파일 ── */
  useEffect(() => {
    if (!inTauri || !project || !openPath) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEnvs({ envs: [], sources: [] })
      return
    }
    let alive = true
    readEnvFiles(project, openPath)
      .then((e) => {
        if (alive) setEnvs(e)
      })
      .catch(() => {
        if (alive) setEnvs({ envs: [], sources: [] })
      })
    return () => {
      alive = false
    }
  }, [project, openPath])

  const envName = project ? (envByProject[project] ?? null) : null
  const setEnvName = useCallback(
    (name: string | null) => {
      if (!project) return
      setEnvByProject((prev) => {
        const next = { ...prev }
        if (name) next[project] = name
        else delete next[project]
        return next
      })
    },
    [project, setEnvByProject]
  )

  /** 선택한 환경의 변수. 환경을 안 골랐거나 없으면 빈 표. */
  const envVars = useMemo(() => {
    const found = envs.envs.find((e) => e.name === envName)
    return found?.vars ?? {}
  }, [envs, envName])

  // 환경 파일이 바뀌어 고른 환경이 사라졌으면(또는 아직 안 골랐으면) 첫 환경으로.
  useEffect(() => {
    if (envs.envs.length === 0) return
    if (envName && envs.envs.some((e) => e.name === envName)) return
    setEnvName(envs.envs[0].name)
  }, [envs, envName, setEnvName])

  /* ── 전역 변수 ── */
  const globals = useMemo(
    () => (project ? (globalsByProject[project] ?? {}) : {}),
    [globalsByProject, project]
  )

  /**
   * 실행이 읽는 전역 변수는 **ref 가 정답이다.**
   *
   * "전체 실행"은 요청을 순차로 돌리는 한 번의 async 루프인데, 그 안의 `run` 은 자기가
   * 만들어질 때의 `globals` 를 클로저로 물고 있다. 그래서 상태만 갱신하면 1번 요청이
   * 발급한 토큰을 2번 요청이 못 본다 — 로그인 → 토큰 → 다음 요청이라는 이 기능의
   * 핵심 흐름이 조용히 깨진다. 그래서 갱신은 ref 에 **동기로** 반영하고, 화면 표시용
   * 상태(localStorage)는 그와 별개로 따라간다.
   */
  const globalsRef = useRef(globals)
  useEffect(() => {
    globalsRef.current = globals
  }, [globals])

  const applyGlobalUpdates = useCallback(
    (updates: Record<string, string | null>) => {
      if (!project || Object.keys(updates).length === 0) return
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

  const clearGlobals = useCallback(() => {
    if (!project) return
    globalsRef.current = {}
    setGlobalsByProject((prev) => {
      if (!prev[project]) return prev
      const next = { ...prev }
      delete next[project]
      return next
    })
  }, [project, setGlobalsByProject])

  /* ── 편집·저장 ── */
  const buffer = openPath ? (buffers[openPath] ?? null) : null

  const setText = useCallback((path: string, text: string) => {
    setBuffers((prev) => {
      const cur = prev[path]
      if (!cur || cur.text === text) return prev
      return { ...prev, [path]: { ...cur, text } }
    })
  }, [])

  const save = useCallback(
    async (path: string) => {
      const buf = buffers[path]
      if (!buf || buf.text === buf.saved) return
      try {
        await writeHttpFile(path, buf.text)
        setBuffers((prev) => {
          const cur = prev[path]
          if (!cur) return prev
          return { ...prev, [path]: { ...cur, saved: cur.text } }
        })
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    },
    [buffers]
  )

  /** 디스크 내용으로 되돌린다(수정 취소). */
  const revert = useCallback(async (path: string) => {
    try {
      const file = await readHttpFile(path)
      setBuffers((prev) => ({
        ...prev,
        [path]: {
          path: file.path,
          name: file.name,
          text: file.text,
          saved: file.text,
        },
      }))
    } catch (e) {
      setError(String(e))
    }
  }, [])

  /** 새 파일을 만들고 바로 연다. `rel` 은 프로젝트 루트 기준 상대 경로. */
  const createFile = useCallback(
    async (rel: string) => {
      if (!project) return
      const name = rel.trim().replace(/^\/+/, "")
      if (!name) return
      const path = `${project.replace(/\/$/, "")}/${/\.(http|rest)$/i.test(name) ? name : `${name}.http`}`
      try {
        const file = await createHttpFile(path)
        setBuffers((prev) => ({
          ...prev,
          [file.path]: {
            path: file.path,
            name: file.name,
            text: file.text,
            saved: file.text,
          },
        }))
        setOpenPath(file.path)
        setLastFile(file.path)
        await refresh()
        setError(null)
      } catch (e) {
        setError(String(e))
      }
    },
    [project, refresh, setLastFile]
  )

  /* ── 파싱 ── */
  const parsed = useMemo(
    () => parseHttpFile(buffer?.text ?? ""),
    [buffer?.text]
  )

  /* ── 실행 ── */
  const run = useCallback(
    async (req: HttpRequest) => {
      if (!openPath) return
      const key = responseKey(openPath, req.index)
      setRunning((prev) => new Set(prev).add(key))
      try {
        const result = await runRequest({
          req,
          filePath: openPath,
          globals: globalsRef.current,
          env: envVars,
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
    [openPath, envVars, applyGlobalUpdates]
  )

  /**
   * 파일의 모든 요청을 **차례로** 실행한다.
   *
   * 동시에 보내지 않는 이유: 토큰을 받아 다음 요청에서 쓰는 흐름(`client.global.set`)이
   * 흔해서 순서가 곧 의미다. IntelliJ 의 "Run all requests in file" 도 순차 실행이다.
   */
  const runAll = useCallback(async () => {
    for (const req of parsed.requests) {
      await run(req)
    }
  }, [parsed.requests, run])

  return {
    /* 프로젝트 */
    projects,
    project,
    setProject,
    /* 파일 */
    files,
    loading,
    error,
    setError,
    refresh,
    openPath,
    openFile,
    buffer,
    buffers,
    setText,
    save,
    revert,
    createFile,
    /* 파싱 결과 */
    parsed,
    /* 환경·전역 변수 */
    envs,
    envName,
    setEnvName,
    envVars,
    globals,
    clearGlobals,
    /* 실행 */
    run,
    runAll,
    results,
    running,
  }
}
