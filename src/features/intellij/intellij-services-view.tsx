import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  LayersIcon,
  LeafIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useAutoScroll, useServices, type Service } from "./use-services"

type Api = ReturnType<typeof useServices>

/** 좌측 트리에서 설정을 묶는 그룹. IntelliJ Services 창의 분류와 같은 순서. */
const GROUPS: Array<{ kind: string; label: string }> = [
  { kind: "http", label: "HTTP Request" },
  { kind: "spring-boot", label: "Spring Boot" },
  { kind: "multirun", label: "Multirun" },
  { kind: "junit", label: "JUnit" },
  { kind: "java", label: "Java Application" },
  { kind: "other", label: "기타" },
]

/**
 * 트리 한 행의 크기 — IntelliJ Services 트리와 같게 맞춘다.
 * IntelliJ 는 행 높이 22px, 글자 13px 이라 촘촘하다. Tailwind 기본값(text-sm=14px,
 * py-1)으로 두면 행이 28px 이 되어 눈에 띄게 헐렁해진다.
 */
const ROW = "h-[22px] shrink-0 text-[13px] leading-[22px]"

const TREE_WIDTH_KEY = "myspace.intellij.treeWidth"
const MIN_TREE = 180
const MAX_TREE = 520

function KindIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === "multirun") return <LayersIcon className={className} />
  if (kind === "http") return <GlobeIcon className={className} />
  if (kind === "spring-boot") return <LeafIcon className={className} />
  return <TerminalIcon className={className} />
}

/** 로그 한 줄. 레벨 토큰을 찾아 색을 입힌다(IntelliJ 콘솔과 비슷하게). */
function LogLine({ line }: { line: string }) {
  // 이 앱이 직접 끼워 넣은 안내 줄은 구분해서 보여준다.
  if (line.startsWith("[my-space]")) {
    return (
      <div className="whitespace-pre text-muted-foreground italic">{line}</div>
    )
  }
  const level = /\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/.exec(line)?.[1]
  return (
    <div
      className={cn(
        // IntelliJ 콘솔처럼 줄바꿈하지 않고 가로로 스크롤한다.
        "whitespace-pre",
        level === "ERROR" && "text-red-600 dark:text-red-400",
        level === "WARN" && "text-amber-600 dark:text-amber-400",
        !level && line.startsWith("\tat") && "text-muted-foreground"
      )}
    >
      {line}
    </div>
  )
}

/** 좌측 트리의 그룹 하나(접기/펼치기 + 항목들). */
function TreeGroup({
  label,
  items,
  api,
  selected,
  onSelect,
}: {
  label: string
  items: Service[]
  api: Api
  selected: string | null
  onSelect: (name: string) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-1 px-1.5 text-left hover:bg-accent/50",
          ROW
        )}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {items.length}
        </span>
      </button>

      {open &&
        items.map((s) => {
          const isRunning = api.running.has(s.name)
          const failReason = api.failed.get(s.name)
          const isFailed = failReason != null && !isRunning
          const isSelected = selected === s.name
          const port = api.ports[s.name]
          return (
            <button
              key={s.name}
              onClick={() => onSelect(s.name)}
              title={isFailed ? `${s.name} — ${failReason}` : s.name}
              className={cn(
                "flex w-full items-center gap-1 pr-2 pl-5 text-left",
                ROW,
                isSelected
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50"
              )}
            >
              {/* IntelliJ Services 처럼 실패하면 빨간 경고 아이콘으로 바꾼다. */}
              {isFailed ? (
                <CircleAlertIcon className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
              ) : (
                <KindIcon
                  kind={s.type}
                  className={cn(
                    "size-3.5 shrink-0",
                    isRunning
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                  )}
                />
              )}
              <span
                className={cn(
                  "truncate",
                  isRunning && "font-semibold",
                  isFailed && "font-semibold text-red-600 dark:text-red-400"
                )}
              >
                {s.name}
              </span>
              {/* IntelliJ Services 처럼 실행 중이면 LISTEN 포트를 옆에 보여 준다. */}
              {isRunning && port != null && (
                <span className="shrink-0 text-blue-600 dark:text-blue-400">
                  :{port}/
                </span>
              )}
              {isRunning && (
                <span className="ml-auto size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
              )}
            </button>
          )
        })}
    </div>
  )
}

/** 우측 콘솔 패널 — 툴바(시작/종료/지우기) + 실시간 로그. */
function ConsolePanel({ service, api }: { service: Service | null; api: Api }) {
  const lines = service ? (api.logs[service.name] ?? []) : []
  const ref = useAutoScroll(lines.length)

  // 선택한 서비스의 보관 로그를 Rust 에서 복원한다(메뉴를 다시 열었을 때 콘솔이 비지 않게).
  const name = service?.name
  const { loadLogs } = api
  useEffect(() => {
    if (name) void loadLogs(name)
  }, [name, loadLogs])

  if (!service) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        왼쪽에서 실행 설정을 선택하세요.
      </div>
    )
  }

  const isRunning = api.running.has(service.name)
  const failReason = api.failed.get(service.name)
  const isFailed = failReason != null && !isRunning
  const isPending = api.pending.has(service.name)
  const pid = api.pids[service.name]
  const port = api.ports[service.name]
  // 실행 중이면 같은 자리의 버튼이 재시작으로 동작한다(IntelliJ 의 Rerun 과 같은 자리).
  // 재시작은 먼저 내려야 하므로 종료가 불가능한 설정에서는 쓸 수 없다.
  const canRestart = service.stoppable

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 툴바 */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        {isRunning ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-400"
            disabled={isPending || !canRestart}
            onClick={() => void api.restart(service.name)}
            title={
              canRestart
                ? "재시작"
                : "이 설정은 재시작을 지원하지 않습니다(메인 클래스를 알 수 없음)"
            }
          >
            <RotateCcwIcon
              className={cn("size-4", isPending && "animate-spin")}
            />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-400"
            disabled={isPending}
            onClick={() => void api.start(service.name)}
            title="시작"
          >
            <PlayIcon className="size-4 fill-current" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-600 hover:text-red-600 dark:text-red-400"
          disabled={!isRunning || !service.stoppable || isPending}
          onClick={() => void api.stop(service.name)}
          title={
            service.stoppable
              ? "종료"
              : "이 설정은 종료 제어를 지원하지 않습니다(메인 클래스를 알 수 없음)"
          }
        >
          <SquareIcon className="size-4 fill-current" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => api.clearLogs(service.name)}
          title="콘솔 지우기"
        >
          <Trash2Icon className="size-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-border" />

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-medium">{service.name}</span>
          {isRunning ? (
            <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
              {isPending
                ? "재시작 중…"
                : `실행 중${port != null ? ` · :${port}` : ""}${pid ? ` · pid ${pid}` : ""}`}
            </span>
          ) : isFailed ? (
            <span
              className="flex min-w-0 items-center gap-1 text-xs text-red-600 dark:text-red-400"
              title={failReason}
            >
              <CircleAlertIcon className="size-3.5 shrink-0" />
              <span className="truncate">실패 · {failReason}</span>
            </span>
          ) : (
            <span className="shrink-0 text-xs text-muted-foreground">
              중지됨
            </span>
          )}
        </div>

        <span className="shrink-0 text-xs text-muted-foreground">
          {lines.length}줄
        </span>
      </div>

      {/* 설정 요약 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs text-muted-foreground">
        {service.description && <span>{service.description}</span>}
        {service.module && <span>모듈 {service.module}</span>}
        {service.profiles && (
          <span className="text-amber-600 dark:text-amber-400">
            profile: {service.profiles}
          </span>
        )}
        {service.vm_parameters && (
          <span className="font-mono">{service.vm_parameters}</span>
        )}
        {service.children.length > 0 && (
          <span>
            하위 {service.children.length}개: {service.children.join(", ")}
          </span>
        )}
      </div>

      {/* 콘솔 */}
      {/* ui-selectable: body 에 select-none 이 걸려 있어서 콘솔은 명시적으로 되돌린다
          (로그를 드래그해 복사할 수 있어야 한다). */}
      <div
        ref={ref}
        className="ui-selectable min-h-0 flex-1 cursor-text overflow-auto bg-muted/30 p-2 font-mono text-[11px] leading-relaxed"
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground">
            아직 출력이 없습니다. ▶ 를 눌러 실행하세요.
          </div>
        ) : (
          // min-w-max: 가장 긴 줄만큼 넓어져 가로 스크롤이 생긴다.
          <div className="min-w-max">
            {lines.map((l, i) => (
              <LogLine key={i} line={l} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function IntellijServicesView() {
  const api = useServices()
  const [selected, setSelected] = useState<string | null>(null)
  const [treeWidth, setTreeWidth] = useLocalStorage<number>(TREE_WIDTH_KEY, 260)
  const containerRef = useRef<HTMLDivElement>(null)

  // 좌우 분할선 드래그(IntelliJ 처럼 목록 폭을 조절한다).
  const onSplitterDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      const move = (ev: PointerEvent) => {
        const w = Math.min(MAX_TREE, Math.max(MIN_TREE, ev.clientX - box.left))
        setTreeWidth(w)
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
    },
    [setTreeWidth]
  )

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: api.services.filter((s) => s.type === g.kind),
      })).filter((g) => g.items.length > 0),
    [api.services]
  )

  const current = useMemo(
    () => api.services.find((s) => s.name === selected) ?? null,
    [api.services, selected]
  )

  if (!isTauri()) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        이 기능은 데스크톱 앱에서만 동작합니다.
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 상단: 프로젝트 선택 + 새로고침 + MCP 연결 상태 */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <select
          value={api.projectPath ?? ""}
          onChange={(e) => api.setProjectPath(e.target.value || null)}
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
        >
          {api.projects.length === 0 && (
            <option value="">최근 프로젝트 없음</option>
          )}
          {api.projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>

        {api.mcp && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-xs",
              api.mcp.connected
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            )}
            title={api.mcp.error ?? api.mcp.url ?? ""}
          >
            <span
              className={cn(
                "size-1.5 rounded-full",
                api.mcp.connected ? "bg-emerald-500" : "bg-red-500"
              )}
            />
            IntelliJ {api.mcp.connected ? "연결됨" : "연결 안 됨"}
          </span>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={() => api.refresh()}
          disabled={api.loading}
          className="shrink-0"
        >
          <RotateCwIcon
            className={cn("size-4", api.loading && "animate-spin")}
          />
          새로고침
        </Button>
      </div>

      {/* MCP 미연결 안내 — 이 기능의 전제 조건이라 눈에 띄게 알린다. */}
      {api.mcp && !api.mcp.connected && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">
              IntelliJ MCP 서버에 연결할 수 없습니다.
            </div>
            <div className="mt-0.5">
              IntelliJ 를 실행한 뒤 Settings → Tools → MCP Server 에서 서버를
              켜고 새로고침하세요. 자세한 설정 방법과 연결 상태는{" "}
              <b>설정 → IntelliJ</b> 에서 확인할 수 있습니다.
            </div>
            {api.mcp.error && (
              <div className="mt-1 font-mono opacity-80">{api.mcp.error}</div>
            )}
          </div>
        </div>
      )}

      {api.error && (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-all">{api.error}</span>
        </div>
      )}

      {/* 본문: 좌측 목록 | 분할선 | 우측 콘솔 */}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <aside
          style={{ width: treeWidth }}
          className="min-h-0 shrink-0 overflow-auto py-1"
        >
          {grouped.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {api.loading ? "불러오는 중…" : "실행 설정이 없습니다."}
            </div>
          ) : (
            grouped.map((g) => (
              <TreeGroup
                key={g.kind}
                label={g.label}
                items={g.items}
                api={api}
                selected={selected}
                onSelect={setSelected}
              />
            ))
          )}
        </aside>

        <div
          onPointerDown={onSplitterDown}
          className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-primary/40"
          role="separator"
          aria-orientation="vertical"
        />

        <ConsolePanel service={current} api={api} />
      </div>
    </div>
  )
}
