import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FilePlus2Icon,
  FolderOpenIcon,
  ListTreeIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SaveIcon,
  SearchIcon,
  VariableIcon,
  XIcon,
} from "lucide-react"

import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { isTauri } from "@/lib/tauri"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { useTabActive } from "@/lib/use-tab-active"
import { cn } from "@/lib/utils"
import { HttpEditor } from "./http-editor"
import { requestAtLine, requestLabel, type HttpRequest } from "./http-parse"
import { isResolvable, type VarScope } from "./http-vars"
import { ResponsePane } from "./response-pane"
import { responseKey, useHttpFiles } from "./use-http-files"

/**
 * IntelliJ HTTP — IntelliJ 프로젝트 안의 `.http` 파일을 그대로 열어 고치고 실행한다.
 *
 * IntelliJ 서비스 화면(`features/intellij/`)과 나눠 둔 이유: 저쪽은 **실행 설정**을
 * IDE 에게 실행시키는 화면이고(그래서 IDE 가 켜져 있어야 한다), 여기는 파일과
 * HTTP 요청만 다뤄 **IntelliJ 가 꺼져 있어도** 동작한다. 프로젝트 목록만 IntelliJ 의
 * 최근 프로젝트에서 빌려 쓴다(직접 폴더를 고를 수도 있다).
 *
 * 화면은 IntelliJ HTTP Client 와 같은 3분할 — 왼쪽 파일 목록, 가운데 편집기(거터의 ▶),
 * 아래 응답 패널.
 */

const ASIDE_KEY = "myspace.intellijHttp.asideWidth"
const DEFAULT_ASIDE = 280
const MIN_ASIDE = 200
const MAX_ASIDE = 560

/** 응답 패널 높이(px). 편집기와의 분할선을 드래그해 조절한다. */
const RESPONSE_KEY = "myspace.intellijHttp.responseHeight"
const DEFAULT_RESPONSE = 260
const MIN_RESPONSE = 120
const MIN_EDITOR = 160

export function IntellijHttpView() {
  const api = useHttpFiles()
  const tabActive = useTabActive()
  const {
    width: asideWidth,
    resizing,
    startResize,
  } = useResizableWidth(ASIDE_KEY, DEFAULT_ASIDE, MIN_ASIDE, MAX_ASIDE)
  const { height: responseHeight, dragging, startDrag } = useResponseHeight()

  const [filter, setFilter] = useState("")
  const [newName, setNewName] = useState<string | null>(null)
  const [caretLine, setCaretLine] = useState(0)
  const [jump, setJump] = useState<{ line: number; seq: number } | null>(null)
  const [lastKey, setLastKey] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 파일을 열면 그 파일이 든 폴더는 펼쳐 둔다(트리에서 지금 보는 파일이 보여야 한다).
  const openedDirRef = useRef<string | null>(null)

  const { openPath, buffer, parsed, files } = api

  /* ── 변수 스코프(강조와 실행이 같은 표를 본다) ── */
  const scope: VarScope = useMemo(
    () => ({
      request: {},
      globals: api.globals,
      file: parsed.vars,
      env: api.envVars,
    }),
    [api.globals, parsed.vars, api.envVars]
  )
  const resolveVar = useCallback(
    (name: string) => isResolvable(name, scope),
    [scope]
  )

  /* ── 파일 트리 ── */
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q
      ? files.filter((f) => f.rel.toLowerCase().includes(q))
      : files
    const map = new Map<string, typeof matched>()
    matched.forEach((f) => {
      const list = map.get(f.dir) ?? []
      list.push(f)
      map.set(f.dir, list)
    })
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [files, filter])

  useEffect(() => {
    if (!openPath) return
    const dir = files.find((f) => f.path === openPath)?.dir
    if (dir === undefined || openedDirRef.current === dir) return
    openedDirRef.current = dir
    setExpanded((prev) => (prev.has(dir) ? prev : new Set(prev).add(dir)))
  }, [openPath, files])

  const toggleDir = (dir: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })

  /* ── 실행 ── */
  const run = useCallback(
    (req: HttpRequest) => {
      if (!openPath) return
      setLastKey(responseKey(openPath, req.index))
      void api.run(req)
    },
    [api, openPath]
  )

  const runAll = useCallback(() => {
    if (!openPath || parsed.requests.length === 0) return
    setLastKey(responseKey(openPath, parsed.requests[0].index))
    void api.runAll()
  }, [api, openPath, parsed.requests])

  const dirty = buffer ? buffer.text !== buffer.saved : false
  const save = useCallback(() => {
    if (openPath) void api.save(openPath)
  }, [api, openPath])

  // ⌘S — 편집기에 포커스가 없을 때도 저장되도록 창 단위로 듣는다.
  // **탭이 활성일 때만** 등록한다: 뷰가 keep-alive 라 다른 탭에서 누른 ⌘S 까지
  // 여기서 받아 버리면, 보이지도 않는 파일이 저장된다.
  useEffect(() => {
    if (!tabActive) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [tabActive, save])

  /* ── 지금 보여 줄 응답 ── */
  const activeReq = requestAtLine(parsed.requests, caretLine)
  const activeKey =
    activeReq && openPath ? responseKey(openPath, activeReq.index) : null
  const shownKey =
    activeKey && (api.results[activeKey] || api.running.has(activeKey))
      ? activeKey
      : lastKey
  const shown = shownKey ? (api.results[shownKey] ?? null) : null
  const shownRunning = shownKey ? api.running.has(shownKey) : false
  const runningIndexes = useMemo(() => {
    const s = new Set<number>()
    if (!openPath) return s
    api.running.forEach((k) => {
      if (k.startsWith(`${openPath}#`))
        s.add(Number(k.slice(openPath.length + 1)))
    })
    return s
  }, [api.running, openPath])

  const pickFolder = async () => {
    const picked = await openFolderDialog({ directory: true, multiple: false })
    if (typeof picked === "string") api.setProject(picked)
  }

  if (!isTauri()) {
    return (
      <p className="text-[15px] text-muted-foreground">
        이 기능은 데스크톱 앱에서만 동작합니다.
      </p>
    )
  }

  const projectName = api.project?.split("/").filter(Boolean).pop() ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 상단 툴바 */}
      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="font-bold" />
            }
          >
            <FolderOpenIcon className="size-4" />
            {projectName ?? "프로젝트 선택"}
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </DropdownMenuTrigger>
          {/* 팝업 기본 너비는 트리거 폭(--anchor-width)이라 프로젝트 이름·경로가 잘린다 → 내용에 맞춰 늘린다 */}
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-auto max-w-[min(560px,calc(100vw-2rem))] min-w-(--anchor-width) overflow-auto"
          >
            {api.projects.map((p) => (
              <DropdownMenuItem
                key={p.path}
                onClick={() => api.setProject(p.path)}
                title={p.path}
                className={cn(api.project === p.path && "font-bold")}
              >
                <span className="shrink-0 whitespace-nowrap">{p.name}</span>
                <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground">
                  {p.path}
                </span>
              </DropdownMenuItem>
            ))}
            {api.projects.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => void pickFolder()}
              className="whitespace-nowrap"
            >
              폴더 직접 선택…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 환경 선택 */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <VariableIcon className="size-4" />
            {api.envName ?? "환경 없음"}
            <ChevronDownIcon className="size-3.5 opacity-60" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-auto max-w-[min(420px,calc(100vw-2rem))] min-w-(--anchor-width) overflow-auto"
          >
            {api.envs.envs.length === 0 ? (
              <DropdownMenuItem disabled className="whitespace-nowrap">
                http-client.env.json 이 없습니다
              </DropdownMenuItem>
            ) : (
              api.envs.envs.map((e) => (
                <DropdownMenuItem
                  key={e.name}
                  onClick={() => api.setEnvName(e.name)}
                  className={cn(
                    "whitespace-nowrap",
                    api.envName === e.name && "font-bold"
                  )}
                >
                  <span className="truncate">{e.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                    변수 {Object.keys(e.vars).length}개
                  </span>
                </DropdownMenuItem>
              ))
            )}
            {api.envName && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => api.setEnvName(null)}
                  className="whitespace-nowrap"
                >
                  선택 해제
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* 전역 변수(client.global.set) */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            전역 변수
            <span className="rounded-full bg-muted px-1.5 text-[11px] font-bold">
              {Object.keys(api.globals).length}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-80 w-80 overflow-auto"
          >
            {Object.keys(api.globals).length === 0 ? (
              <DropdownMenuItem disabled>
                응답 핸들러가 저장한 값이 없습니다
              </DropdownMenuItem>
            ) : (
              <>
                {Object.entries(api.globals).map(([k, v]) => (
                  <div
                    key={k}
                    className="px-2 py-1 text-[13px] break-all"
                    title={v}
                  >
                    <span className="font-bold text-ui-warning">{k}</span>{" "}
                    <span className="text-muted-foreground">
                      = {v.length > 60 ? `${v.slice(0, 60)}…` : v}
                    </span>
                  </div>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={api.clearGlobals}>
                  모두 지우기
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void api.refresh()}
            className="gap-1.5"
          >
            {api.loading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RotateCwIcon className="size-4" />
            )}
            새로고침
          </Button>
        </div>
      </div>

      {api.error && (
        <div className="flex items-start gap-2 rounded-lg bg-ui-error/10 px-3 py-2 text-[13px] text-ui-error">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-all">{api.error}</span>
          <button
            type="button"
            onClick={() => api.setError(null)}
            className="ml-auto shrink-0"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 왼쪽 — 파일 목록 */}
        <aside
          className="relative flex min-h-0 shrink-0 flex-col gap-2"
          style={{ width: asideWidth }}
        >
          <div className="flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder=".http 파일 검색"
                className="h-8 pl-8 text-[13px]"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              title="새 .http 파일"
              onClick={() => setNewName((v) => (v === null ? "" : null))}
              className="size-8 shrink-0"
            >
              <FilePlus2Icon className="size-4" />
            </Button>
          </div>

          {newName !== null && (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void api.createFile(newName)
                setNewName(null)
              }}
              className="flex items-center gap-1.5"
            >
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="예: _http/새요청.http"
                className="h-8 text-[13px]"
              />
              <Button type="submit" size="sm" className="shrink-0">
                만들기
              </Button>
            </form>
          )}

          <div className="min-h-0 flex-1 overflow-auto rounded-[10px] border border-border bg-background p-1.5">
            {groups.length === 0 ? (
              <p className="p-2 text-[13px] text-muted-foreground">
                {api.project
                  ? ".http · .rest 파일이 없습니다."
                  : "프로젝트를 선택하세요."}
              </p>
            ) : (
              groups.map(([dir, list]) => {
                const open = expanded.has(dir) || filter.trim().length > 0
                return (
                  <div key={dir || "."} className="mb-0.5">
                    <button
                      type="button"
                      onClick={() => toggleDir(dir)}
                      className="flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-left text-[13px] text-muted-foreground hover:bg-ui-list-hover"
                    >
                      {open ? (
                        <ChevronDownIcon className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronRightIcon className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate" title={dir || "/"}>
                        {dir || "(루트)"}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px]">
                        {list.length}
                      </span>
                    </button>
                    {open &&
                      list.map((f) => {
                        const buf = api.buffers[f.path]
                        const isDirty = buf ? buf.text !== buf.saved : false
                        return (
                          <button
                            key={f.path}
                            type="button"
                            onClick={() => void api.openFile(f.path)}
                            title={f.rel}
                            className={cn(
                              "flex w-full items-center gap-1.5 rounded-lg py-1 pr-2 pl-6 text-left text-[13px] transition-colors",
                              f.path === openPath
                                ? "bg-ui-list-active font-bold text-ui-list-active-fg"
                                : "hover:bg-ui-list-hover"
                            )}
                          >
                            <span className="truncate">{f.name}</span>
                            {isDirty && (
                              <span
                                className="ml-auto size-1.5 shrink-0 rounded-full bg-ui-warning"
                                title="저장하지 않은 변경"
                              />
                            )}
                          </button>
                        )
                      })}
                  </div>
                )
              })
            )}
          </div>
          <ResizeHandle
            resizing={resizing}
            onPointerDown={startResize}
            label="파일 목록 폭 조절"
          />
        </aside>

        {/* 가운데 — 편집기 + 응답 */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {!buffer ? (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              왼쪽에서 `.http` 파일을 선택하세요.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-bold">{buffer.name}</span>
                {dirty && (
                  <span className="rounded-full bg-ui-warning/15 px-2 py-0.5 text-[11px] font-bold text-ui-warning">
                    수정됨
                  </span>
                )}
                <span className="truncate text-[13px] text-muted-foreground">
                  {api.envs.sources.length > 0
                    ? `환경 파일 ${api.envs.sources.length}개`
                    : "환경 파일 없음"}
                </span>

                <div className="ml-auto flex items-center gap-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="ghost" size="sm" />}
                    >
                      <ListTreeIcon className="size-4" />
                      요청 {parsed.requests.length}개
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="max-h-96 w-96 overflow-auto"
                    >
                      {parsed.requests.length === 0 ? (
                        <DropdownMenuItem disabled>
                          요청이 없습니다
                        </DropdownMenuItem>
                      ) : (
                        parsed.requests.map((r) => (
                          <DropdownMenuItem
                            key={r.index}
                            onClick={() =>
                              setJump({
                                line: r.requestLine,
                                seq: Date.now() + r.index,
                              })
                            }
                          >
                            <span className="mr-1.5 shrink-0 text-[11px] font-bold text-ui-info">
                              {r.method}
                            </span>
                            <span className="truncate">{requestLabel(r)}</span>
                          </DropdownMenuItem>
                        ))
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void api.revert(buffer.path)}
                    disabled={!dirty}
                    className="gap-1.5"
                  >
                    <RotateCcwIcon className="size-4" />
                    되돌리기
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={save}
                    disabled={!dirty}
                    className="gap-1.5"
                  >
                    <SaveIcon className="size-4" />
                    저장
                  </Button>
                  <Button
                    size="sm"
                    onClick={runAll}
                    disabled={parsed.requests.length === 0}
                    className="gap-1.5 font-bold"
                  >
                    <PlayIcon className="size-4" />
                    전체 실행
                  </Button>
                </div>
              </div>

              <HttpEditor
                text={buffer.text}
                onChange={(v) => api.setText(buffer.path, v)}
                requests={parsed.requests}
                resolveVar={resolveVar}
                runningIndexes={runningIndexes}
                activeIndex={activeReq?.index ?? null}
                onRun={run}
                onSave={save}
                caretLine={caretLine}
                onCaretLine={setCaretLine}
                scrollToLine={jump}
              />

              {/* 편집기 ↔ 응답 분할선 */}
              <div
                onPointerDown={startDrag}
                role="separator"
                aria-orientation="horizontal"
                aria-label="응답 패널 높이 조절"
                className={cn(
                  "h-[4px] shrink-0 cursor-row-resize rounded-full transition-colors hover:bg-ui-selection/60",
                  dragging && "bg-ui-selection/60"
                )}
              />

              <div
                className="min-h-0 shrink-0 overflow-hidden rounded-[10px] border border-border bg-background p-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                style={{ height: responseHeight }}
              >
                <ResponsePane result={shown} running={shownRunning} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

/**
 * 응답 패널 높이 조절. `useResizableWidth` 와 같은 방식이지만 축이 세로이고
 * **아래로 끌면 작아진다**(패널이 아래쪽에 붙어 있다). 편집기가 최소 높이를 유지하도록
 * 창 높이에서 상한을 잡는다.
 */
function useResponseHeight() {
  const [height, setHeight] = useState(() => {
    const raw = Number(localStorage.getItem(RESPONSE_KEY))
    return Number.isFinite(raw) && raw >= MIN_RESPONSE ? raw : DEFAULT_RESPONSE
  })
  const [dragging, setDragging] = useState(false)
  const origin = useRef({ y: 0, height: DEFAULT_RESPONSE })

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: PointerEvent) => {
      const max = Math.max(MIN_RESPONSE, window.innerHeight - MIN_EDITOR - 220)
      const next = origin.current.height - (e.clientY - origin.current.y)
      setHeight(Math.round(Math.min(max, Math.max(MIN_RESPONSE, next))))
    }
    const onUp = () => setDragging(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    const prev = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = prev
    }
  }, [dragging])

  useEffect(() => {
    localStorage.setItem(RESPONSE_KEY, String(height))
  }, [height])

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    origin.current = { y: e.clientY, height }
    setDragging(true)
  }

  return { height, dragging, startDrag }
}
