import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FileTextIcon,
  GlobeIcon,
  LayersIcon,
  LeafIcon,
  ListStartIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  TerminalIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import { sequenceFor } from "./start-sequences"
import { StagePlanDialog } from "./stage-plan-dialog"
import {
  useAutoScroll,
  useServices,
  type Service,
  type ServicesBackend,
} from "./use-services"

type Api = ReturnType<typeof useServices>

/**
 * 백엔드별로 다른 문구.
 *
 * 화면 구조는 두 백엔드가 완전히 같다 — 다른 것은 "이 기능이 지금 쓸 수 있는가" 를
 * 무엇으로 판단하는지다(IDE 연결 vs 프로젝트 모델). 그 배지와 안내만 갈아 끼운다.
 */
const BACKEND_TEXT: Record<
  ServicesBackend,
  {
    /** 상단 상태 배지. */
    on: string
    off: string
    /** 준비되지 않았을 때의 경고 패널. */
    warnTitle: string
    warnBody: React.ReactNode
  }
> = {
  ide: {
    on: "IntelliJ 연결됨",
    off: "IntelliJ 연결 안 됨",
    warnTitle: "IntelliJ MCP 서버에 연결할 수 없습니다.",
    warnBody: (
      <>
        IntelliJ 를 실행한 뒤 Settings → Tools → MCP Server 에서 서버를 켜고
        새로고침하세요. 자세한 설정 방법과 연결 상태는 <b>설정 → IntelliJ</b>{" "}
        에서 확인할 수 있습니다.
      </>
    ),
  },
  standalone: {
    on: "프로젝트 모델 읽음",
    off: "프로젝트 모델 없음",
    // 경로 오류와 모델 없음이 같은 배지를 쓰므로 제목도 둘을 다 덮는 문장이어야 한다
    // (구체적인 이유는 아래 `api.mcp.error` 에 그대로 나온다).
    warnTitle: "지금은 서비스를 띄울 수 없습니다.",
    warnBody: (
      <>
        이 기능은 IntelliJ 를 띄우지 않지만, IDE 가 <b>한 번 임포트해 둔</b>{" "}
        클래스패스를 읽어 씁니다. 위 경로가 맞는지 확인하고, 그 프로젝트를
        IntelliJ 에서 한 번 열어 Maven/Gradle 임포트를 끝낸 뒤 새로고침하세요.
        (그 뒤로는 IntelliJ 가 꺼져 있어도 됩니다.)
      </>
    ),
  },
}

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
 * 트리 한 행의 크기 — Slack 콘텐츠 리스트 행(36px)에 맞춘다.
 * 15px 본문에 8px 라운드 알약이고, 행마다 테두리를 두르지 않고 여백으로만 구분한다.
 */
const ROW = "min-h-9 shrink-0 rounded-lg px-3 text-[15px] transition-colors"

const TREE_WIDTH_KEY: Record<ServicesBackend, string> = {
  ide: "myspace.intellij.treeWidth",
  standalone: "myspace.standalone.treeWidth",
}
const DEFAULT_TREE = 260
const MIN_TREE = 180
const MAX_TREE = 520
/** 분할선을 끝까지 밀어도 콘솔이 이만큼은 남는다. */
const MIN_CONSOLE = 320
/** 키보드(←/→)로 조절할 때 한 번에 움직이는 폭. */
const KEY_STEP = 16

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
        level === "ERROR" && "text-ui-error",
        level === "WARN" && "text-ui-warning",
        !level && line.startsWith("\tat") && "text-muted-foreground"
      )}
    >
      {line}
    </div>
  )
}

/**
 * 트리 행 오른쪽에 붙는 실행 버튼 — IntelliJ Services 창의 행 버튼과 같은 자리.
 *
 * 실행 중이면 재시작·중지, 내려가 있으면 시작. 콘솔 툴바에도 같은 버튼이 있지만
 * 그쪽은 먼저 행을 골라야 하고, 개발 중에는 목록에서 곧장 다시 올리는 일이 잦다.
 * 누르면 그 설정을 콘솔에도 띄운다(방금 올린 것의 로그가 바로 보이도록).
 */
function RowActions({
  service,
  api,
  /** 행이 선택 상태(진한 알약)인지 — 그 위에서는 아이콘 색을 글자색에 맞춘다. */
  selected,
  onSelect,
}: {
  service: Service
  api: Api
  selected: boolean
  onSelect: (name: string, additive: boolean) => void
}) {
  const isRunning = api.running.has(service.name)
  const isPending = api.pending.has(service.name)
  // 재시작·종료 모두 프로세스를 내릴 수 있어야 한다(메인 클래스를 알아야 가능).
  const canControl = service.stoppable
  const tone = (color: string) =>
    selected ? "text-current hover:bg-white/20" : color

  const run = (fn: (name: string) => unknown) => {
    onSelect(service.name, false)
    void fn(service.name)
  }

  if (!isRunning) {
    return (
      <Button
        size="icon-xs"
        variant="ghost"
        className={tone("text-ui-success hover:text-ui-success")}
        disabled={isPending}
        onClick={() => run(api.start)}
        title="시작"
      >
        {isPending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <PlayIcon className="fill-current" />
        )}
      </Button>
    )
  }

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon-xs"
        variant="ghost"
        className={tone("text-ui-success hover:text-ui-success")}
        disabled={isPending || !canControl}
        onClick={() => run(api.restart)}
        title={
          canControl
            ? "재시작"
            : "이 설정은 재시작을 지원하지 않습니다(메인 클래스를 알 수 없음)"
        }
      >
        {isPending ? (
          <Loader2Icon className="animate-spin" />
        ) : (
          <RotateCcwIcon />
        )}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        className={tone("text-ui-error hover:text-ui-error")}
        disabled={isPending || !canControl}
        onClick={() => run(api.stop)}
        title={
          canControl
            ? "종료 — IntelliJ 정지 버튼과 같은 SIGINT(graceful shutdown). 응답이 없으면 한 번 더 눌러 강제 종료합니다."
            : "이 설정은 종료 제어를 지원하지 않습니다(메인 클래스를 알 수 없음)"
        }
      >
        <SquareIcon className="fill-current" />
      </Button>
    </span>
  )
}

/** 좌측 트리의 그룹 하나(접기/펼치기 + 항목들). */
function TreeGroup({
  label,
  items,
  api,
  selected,
  focused,
  onSelect,
}: {
  label: string
  items: Service[]
  api: Api
  /** 지금 선택된 설정 전부(⌘ 클릭으로 여러 개일 수 있다). */
  selected: Set<string>
  /** 그중 콘솔에 띄워 둔 하나. */
  focused: string | null
  /** `additive` = ⌘(또는 Ctrl) 를 누른 채 클릭 — 선택에 넣거나 뺀다. */
  onSelect: (name: string, additive: boolean) => void
}) {
  const [open, setOpen] = useState(true)

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          ROW,
          // 섹션 헤더 행 — Slack 사이드바 섹션과 같은 톤(15px semibold, 대문자 아님).
          "flex w-full cursor-pointer items-center gap-2 text-left font-semibold text-ui-section-header-fg hover:bg-ui-list-hover"
        )}
      >
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0" />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground tabular-nums">
          {items.length}
        </span>
      </button>

      {open &&
        items.map((s) => {
          const isRunning = api.running.has(s.name)
          const failReason = api.failed.get(s.name)
          const isFailed = failReason != null && !isRunning
          const isSelected = selected.has(s.name)
          const isFocused = focused === s.name
          // 실행 중이면 실제 LISTEN 포트, 아니면 설정에서 알아낸 예상 포트.
          // (ApiGatewayApplication 의 agent/customer/mobile 처럼 같은 앱이 프로필별로
          //  다른 포트를 쓰는 경우, 띄우기 전에도 어느 게 어느 포트인지 보인다.)
          const port = isRunning
            ? api.ports[s.name]
            : (s.expected_port ?? undefined)
          return (
            // 행 = 이름(선택) 버튼 + 실행 버튼들. 버튼을 겹쳐 넣을 수 없으므로
            // 행 자체는 div 이고, 알약 배경·hover 색을 여기서 칠한다.
            <div
              key={s.name}
              className={cn(
                ROW,
                "flex w-full items-center gap-2 pr-1 pl-9",
                // 여러 개를 골랐을 때 콘솔에 떠 있는 하나(focused)만 진한 알약,
                // 나머지 선택은 같은 색을 옅게 — 어느 것이 보이는 중인지 구분된다.
                isFocused
                  ? "bg-ui-list-active font-bold text-ui-list-active-fg"
                  : isSelected
                    ? "bg-ui-list-active/70 font-bold text-ui-list-active-fg"
                    : "hover:bg-ui-list-hover"
              )}
            >
              <button
                onClick={(e) => onSelect(s.name, e.metaKey || e.ctrlKey)}
                title={isFailed ? `${s.name} — ${failReason}` : s.name}
                // self-stretch: 행 전체 높이가 클릭 영역이 되도록.
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left"
              >
                {/* IntelliJ Services 처럼 실패하면 경고 아이콘으로 바꾼다. */}
                {isFailed ? (
                  <CircleAlertIcon className="size-4 shrink-0 text-ui-error" />
                ) : (
                  <KindIcon
                    kind={s.type}
                    className={cn(
                      "size-4 shrink-0",
                      isRunning ? "text-ui-success" : "text-muted-foreground"
                    )}
                  />
                )}
                {/* Slack 사이드바처럼 "살아 있는" 항목(실행 중·실패)만 굵게 + 색으로 강조한다. */}
                <span
                  className={cn(
                    "truncate",
                    isRunning && !isSelected && "font-bold text-ui-success",
                    isFailed && !isSelected && "font-bold text-ui-error"
                  )}
                >
                  {s.name}
                </span>
                {/* 포트 칩 — 실행 중이면 실제 포트(파랑), 중지 상태면 예상 포트(회색). */}
                {port != null && (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 text-[11px] font-bold tabular-nums",
                      isSelected
                        ? "bg-white/20"
                        : isRunning
                          ? "bg-ui-info/15 text-ui-info"
                          : "bg-muted text-muted-foreground"
                    )}
                    title={isRunning ? "LISTEN 포트" : "설정상 예상 포트"}
                  >
                    :{port}
                  </span>
                )}
              </button>

              <RowActions
                service={s}
                api={api}
                selected={isSelected}
                onSelect={onSelect}
              />
            </div>
          )
        })}
    </div>
  )
}

/**
 * 여러 개를 골랐을 때의 툴바 — 시작/종료가 **선택한 설정 전부**에 걸린다.
 * (하나만 골랐을 때의 재시작 토글은 대상이 섞이면 뜻이 모호해져서 여기서는 쓰지 않는다.)
 */
function MultiToolbar({ selection, api }: { selection: Service[]; api: Api }) {
  // 이미 떠 있는 것은 시작 대상에서 뺀다(다시 띄우면 그것에 의존하는 서비스가 끊긴다).
  const startable = selection.filter((s) => !api.running.has(s.name))
  const stoppable = selection.filter(
    (s) => api.running.has(s.name) && s.stoppable
  )
  const busy = selection.some((s) => api.pending.has(s.name))

  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className={
          startable.length > 0
            ? "text-ui-success hover:text-ui-success"
            : "text-muted-foreground"
        }
        disabled={busy || startable.length === 0}
        onClick={() => void api.startMany(startable.map((s) => s.name))}
        title={
          startable.length > 0
            ? `선택한 ${startable.length}개를 차례로 시작합니다(이미 실행 중인 것은 건너뜁니다).`
            : "선택한 설정이 모두 실행 중입니다."
        }
      >
        <PlayIcon className="size-4 fill-current" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className={
          stoppable.length > 0
            ? "text-ui-error hover:text-ui-error"
            : "text-muted-foreground"
        }
        disabled={busy || stoppable.length === 0}
        onClick={() => void api.stopMany(stoppable.map((s) => s.name))}
        title={
          stoppable.length > 0
            ? `선택한 ${stoppable.length}개를 종료합니다.`
            : "종료할 수 있는 실행 중인 설정이 없습니다."
        }
      >
        <SquareIcon className="size-4 fill-current" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => selection.forEach((s) => api.clearLogs(s.name))}
        title="선택한 설정의 콘솔을 모두 지웁니다."
      >
        <Trash2Icon className="size-4" />
      </Button>

      <div className="mx-1.5 h-5 w-px bg-border" />

      <span className="shrink-0 text-[15px] font-bold">
        {selection.length}개 선택됨
      </span>
      <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
        실행 중 {selection.length - startable.length}
      </span>
    </>
  )
}

/** 선택 목록 칩 줄 — 클릭하면 그 설정의 콘솔로, X 로 선택에서 뺀다. */
function SelectionChips({
  selection,
  focused,
  api,
  onFocus,
  onRemove,
}: {
  selection: Service[]
  focused: string | null
  api: Api
  onFocus: (name: string) => void
  onRemove: (name: string) => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
      {selection.map((s) => {
        const isRunning = api.running.has(s.name)
        return (
          <span
            key={s.name}
            className={cn(
              "flex max-w-56 items-center gap-1 rounded-full py-0.5 pr-1 pl-2.5 text-[13px] font-bold",
              focused === s.name
                ? "bg-ui-list-active text-ui-list-active-fg"
                : "bg-muted text-muted-foreground"
            )}
          >
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                isRunning ? "bg-ui-success" : "bg-current opacity-40"
              )}
            />
            <button
              onClick={() => onFocus(s.name)}
              className="cursor-pointer truncate"
              title={`${s.name} 콘솔 보기`}
            >
              {s.name}
            </button>
            <button
              onClick={() => onRemove(s.name)}
              className="shrink-0 cursor-pointer rounded-full p-0.5 hover:bg-black/10"
              title="선택에서 빼기"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/** 우측 콘솔 패널 — 툴바(시작/종료/지우기) + 실시간 로그. */
function ConsolePanel({
  service,
  selection,
  api,
  onFocus,
  onRemove,
}: {
  /** 콘솔에 로그를 띄울 설정(선택 중 마지막으로 누른 것). */
  service: Service | null
  /** 선택한 설정 전부 — 2개 이상이면 툴바가 일괄 시작/종료로 바뀐다. */
  selection: Service[]
  api: Api
  onFocus: (name: string) => void
  onRemove: (name: string) => void
}) {
  const lines = service ? (api.logs[service.name] ?? []) : []
  const ref = useAutoScroll(lines.length)

  // 선택한 서비스의 보관 로그를 Rust 에서 복원한다(메뉴를 다시 열었을 때 콘솔이 비지 않게).
  const name = service?.name
  const { loadLogs } = api
  useEffect(() => {
    if (name) void loadLogs(name)
  }, [name, loadLogs])

  const multi = selection.length > 1

  if (!service) {
    return (
      <div className="flex flex-1 items-center justify-center py-8 text-center text-[15px] text-muted-foreground">
        왼쪽에서 실행 설정을 선택하세요. ⌘ 를 누른 채 클릭하면 여러 개를 골라 한
        번에 시작·종료할 수 있습니다.
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
  // 중지 버튼은 실행 중이고 종료를 제어할 수 있을 때만 쓸 수 있다.
  const canStop = isRunning && service.stoppable

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* 툴바 — Slack 패널 헤더 톤(넉넉한 px-3 py-2, 32px 아이콘 버튼). */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
        {multi ? (
          <MultiToolbar selection={selection} api={api} />
        ) : (
          <>
            {isRunning ? (
              <Button
                size="icon-sm"
                variant="ghost"
                // 중지 버튼과 같은 규칙 — 재시작할 수 없는 설정이면 색을 빼고 회색으로.
                className={
                  canRestart
                    ? "text-ui-success hover:text-ui-success"
                    : "text-muted-foreground"
                }
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
                size="icon-sm"
                variant="ghost"
                className="text-ui-success hover:text-ui-success"
                disabled={isPending}
                onClick={() => void api.start(service.name)}
                title="시작"
              >
                <PlayIcon className="size-4 fill-current" />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              // 쓸 수 없을 때(중지 상태·종료 제어 불가)는 빨간색을 빼고 회색으로 둔다 —
              // 옅어진 빨강은 "누르면 되는 버튼" 처럼 보인다.
              className={
                canStop
                  ? "text-ui-error hover:text-ui-error"
                  : "text-muted-foreground"
              }
              disabled={!canStop || isPending}
              onClick={() => void api.stop(service.name)}
              title={
                !service.stoppable
                  ? "이 설정은 종료 제어를 지원하지 않습니다(메인 클래스를 알 수 없음)"
                  : isRunning
                    ? "종료 — IntelliJ 정지 버튼과 같은 SIGINT(graceful shutdown). 응답이 없으면 한 번 더 눌러 강제 종료합니다."
                    : "실행 중이 아닙니다"
              }
            >
              <SquareIcon className="size-4 fill-current" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => api.clearLogs(service.name)}
              title="콘솔 지우기"
            >
              <Trash2Icon className="size-4" />
            </Button>

            <div className="mx-1.5 h-5 w-px bg-border" />

            <div className="flex min-w-0 flex-1 items-center gap-2">
              {/* 실행 설정 이름은 이 패널의 제목이다 — Slack 처럼 굵게. */}
              <span className="truncate text-[15px] font-bold">
                {service.name}
              </span>
              {/* 상태는 알약 칩으로. */}
              {isRunning ? (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-ui-success/15 px-2 text-[11px] font-bold text-ui-success">
                  <span className="size-1.5 animate-pulse rounded-full bg-ui-success" />
                  {isPending
                    ? "재시작 중…"
                    : `실행 중${port != null ? ` · :${port}` : ""}${pid ? ` · pid ${pid}` : ""}`}
                </span>
              ) : isFailed ? (
                <span
                  className="flex min-w-0 items-center gap-1.5 rounded-full bg-ui-error/15 px-2 text-[11px] font-bold text-ui-error"
                  title={failReason}
                >
                  <CircleAlertIcon className="size-3.5 shrink-0" />
                  <span className="truncate">실패 · {failReason}</span>
                </span>
              ) : (
                <span
                  className="shrink-0 rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground"
                  title={
                    service.expected_port != null
                      ? "설정상 예상 포트(실행하면 이 포트로 뜬다)"
                      : undefined
                  }
                >
                  중지됨
                  {service.expected_port != null &&
                    ` · :${service.expected_port}`}
                </span>
              )}
            </div>
          </>
        )}

        <span className="ml-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
          {lines.length}줄
        </span>
      </div>

      {multi && (
        <SelectionChips
          selection={selection}
          focused={service.name}
          api={api}
          onFocus={onFocus}
          onRemove={onRemove}
        />
      )}

      {/* 설정 요약 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 text-[13px] text-muted-foreground">
        {service.description && <span>{service.description}</span>}
        {service.module && <span>모듈 {service.module}</span>}
        {service.profiles && (
          <span className="font-semibold text-ui-warning">
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
        <LogSyncControl service={service} api={api} />
      </div>

      {/* 콘솔 */}
      {/* ui-selectable: body 에 select-none 이 걸려 있어서 콘솔은 명시적으로 되돌린다
          (로그를 드래그해 복사할 수 있어야 한다). */}
      <div
        ref={ref}
        className="ui-selectable min-h-0 flex-1 cursor-text overflow-auto bg-muted/30 p-4 font-mono text-[13px] leading-relaxed"
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

/**
 * IDE 로그 동기화 스위치 — 설정 요약 줄의 오른쪽 끝.
 *
 * IntelliJ 의 Run 버튼으로 띄운 프로세스의 콘솔은 IDE 안에만 있어 밖에서 읽을 수 없다.
 * 유일한 우회로가 실행 설정의 "Save console output to file"(Logs 탭)을 켜서 IDE 가
 * 콘솔을 파일로도 남기게 하는 것이고, 이 버튼이 그 설정을 대신 켜 준다.
 */
function LogSyncControl({ service, api }: { service: Service; api: Api }) {
  // null = 실행 설정이 프로젝트 파일로 저장돼 있지 않아 켤 방법이 없다. 조용히 숨긴다.
  if (service.log_sync == null) return null

  const isPending = api.pending.has(service.name)
  // Multirun 은 자기 콘솔이 없어서 하위 설정에 각각 걸어야 한다 — 안내 문구를 바꾼다.
  const isMultirun = service.type === "multirun"

  if (service.log_sync) {
    return (
      <span
        className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-ui-success/15 px-2 text-[11px] font-bold text-ui-success"
        title={`IntelliJ 에서 띄운 실행도 콘솔이 파일로 남아 여기에 표시됩니다${
          isMultirun ? " (하위 설정 전부 켜져 있음)" : ""
        }.`}
      >
        <CheckIcon className="size-3" />
        IDE 로그 동기화
      </span>
    )
  }

  return (
    <Button
      size="xs"
      variant="outline"
      className="ml-auto shrink-0 rounded-full"
      disabled={isPending}
      onClick={() => void api.enableLogSync(service.name)}
      title={
        `실행 설정의 Logs 탭 → 'Save console output to file' 을 켭니다` +
        `${isMultirun ? "(하위 설정 전부)" : ""}. ` +
        `IntelliJ 의 Run 버튼으로 띄운 실행도 콘솔이 파일로 남아 여기에 표시됩니다. ` +
        `이미 떠 있는 프로세스에는 적용되지 않습니다 — 다음 실행부터입니다.`
      }
    >
      {isPending ? <Loader2Icon className="animate-spin" /> : <FileTextIcon />}
      IDE 로그 동기화 켜기
    </Button>
  )
}

/**
 * 최근 실행 스트립 — 상단 툴바 바로 아래 한 줄.
 *
 * 개발 중에는 같은 두어 개를 계속 고쳐 올리게 되는데, 그때마다 트리에서 찾아 고르는 건
 * 번거롭다. 칩마다 트리 행과 **같은 실행 버튼**(시작 / 재시작·중지)이 붙어 있어 여기서
 * 바로 올리고 내린다. 이름을 누르면 실행하지 않고 그 설정의 콘솔만 띄운다.
 *
 * 목록에 없는 이름(프로젝트 전환 · 설정 이름 변경)은 그냥 걸러낸다.
 */
function RecentStrip({
  api,
  onSelect,
}: {
  api: Api
  /** 트리와 같은 선택 콜백 — 실행 버튼도 누른 설정을 콘솔에 띄운다. */
  onSelect: (name: string, additive: boolean) => void
}) {
  const items = useMemo(
    () =>
      api.recent
        .map((n) => api.services.find((s) => s.name === n))
        .filter((s): s is Service => s != null),
    [api.recent, api.services]
  )

  if (items.length === 0) return null

  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
      <span className="shrink-0 text-[13px] font-semibold text-muted-foreground">
        최근 실행
      </span>
      {items.map((s) => {
        const isRunning = api.running.has(s.name)
        const failReason = api.failed.get(s.name)
        const isFailed = failReason != null && !isRunning
        return (
          <span
            key={s.name}
            className={cn(
              "group flex shrink-0 items-center gap-0.5 rounded-full border pr-0.5 pl-1 text-[13px] font-bold transition-colors",
              isRunning
                ? "border-ui-success/40 bg-ui-success/10 text-ui-success"
                : isFailed
                  ? "border-ui-error/40 bg-ui-error/10 text-ui-error"
                  : "border-border bg-background text-foreground"
            )}
          >
            {/* 이름 = 콘솔 보기. 실행은 오른쪽 버튼으로만 — 눌렀더니 재기동되는 일이 없게. */}
            <button
              onClick={() => onSelect(s.name, false)}
              className="max-w-56 cursor-pointer truncate rounded-full px-1.5 py-1"
              title={
                isFailed
                  ? `${s.name} 콘솔 보기 (지난 실행 실패 — ${failReason})`
                  : `${s.name} 콘솔 보기`
              }
            >
              {s.name}
            </button>

            <RowActions
              service={s}
              api={api}
              selected={false}
              onSelect={onSelect}
            />

            <button
              onClick={() => api.removeRecent(s.name)}
              className="shrink-0 cursor-pointer rounded-full p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/10 focus-visible:opacity-100"
              title="최근 목록에서 빼기"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        )
      })}
    </div>
  )
}

/**
 * 순차 실행 진행 표시 — 툴바 바로 아래 한 줄.
 * 단계가 바뀔 때마다 Rust 가 보내는 `intellij:sequence` 이벤트를 그대로 보여 준다.
 */
function SequenceStrip({ api }: { api: Api }) {
  const p = api.sequence
  if (!p) return null

  const active = api.sequenceActive
  const names = p.names.join(", ")
  const label =
    p.phase === "done"
      ? "순차 실행 완료"
      : p.phase === "failed"
        ? `순차 실행 중단 — ${p.message ?? "알 수 없는 오류"}`
        : p.phase === "canceled"
          ? `순차 실행을 중단했습니다 (${p.stage}/${p.total} 단계)`
          : p.phase === "waiting"
            ? `${p.stage}/${p.total} 단계 기동 대기 중 — ${names}`
            : `${p.stage}/${p.total} 단계 실행 요청 — ${names}`

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-3 py-2 text-[13px] font-bold",
        p.phase === "failed" &&
          "border-ui-error/40 bg-ui-error/10 text-ui-error",
        p.phase === "done" &&
          "border-ui-success/40 bg-ui-success/10 text-ui-success",
        active && "border-ui-info/40 bg-ui-info/10 text-ui-info",
        p.phase === "canceled" &&
          "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      {active ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
      ) : p.phase === "done" ? (
        <CheckIcon className="size-3.5 shrink-0" />
      ) : (
        <CircleAlertIcon className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {active ? (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0 rounded-full"
          onClick={api.cancelSequence}
          title="다음 단계로 넘어가기 전에 멈춥니다(이미 뜬 서비스는 그대로 둡니다)"
        >
          중단
        </Button>
      ) : (
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0"
          onClick={api.dismissSequence}
          title="닫기"
        >
          <XIcon />
        </Button>
      )}
    </div>
  )
}

/**
 * cowork 프로젝트 경로 입력 — standalone 백엔드의 상단 툴바.
 *
 * 타이핑마다 설정을 쓰면 글자 하나에 목록·모델 조회가 한 번씩 돌아간다. 그래서 편집 중에는
 * 로컬 상태만 들고 있다가 **blur 나 Enter 에서 한 번** 반영한다.
 */
function ProjectPathInput({ api }: { api: Api }) {
  const saved = api.projectPath ?? ""
  const [draft, setDraft] = useState(saved)
  // 다른 창(설정 화면)에서 값이 바뀌면 따라간다 — 편집 중이 아닐 때만.
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : saved

  const commit = (value: string) => {
    setEditing(false)
    const next = value.trim()
    if (next !== saved) api.setProjectPath(next || null)
  }

  return (
    <input
      value={shown}
      spellCheck={false}
      placeholder="cowork 를 클론한 폴더 경로 (예: ~/git/cowork)"
      onFocus={() => {
        setDraft(saved)
        setEditing(true)
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur()
        // Esc 는 편집을 버린다(저장된 값으로 되돌아간다).
        if (e.key === "Escape") {
          setEditing(false)
          setDraft(saved)
        }
      }}
      title="cowork 프로젝트 루트. 설정 → Cowork 서비스 와 같은 값입니다."
      className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 font-mono text-[13px] focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid"
    />
  )
}

/**
 * 목록 선택 상태. `names` 는 고른 순서 그대로이고, `focused` 는 그중 콘솔에 띄운 하나
 * (= 마지막으로 누른 것). ⌘ 클릭으로 여러 개를 담아 한 번에 시작/종료한다.
 */
interface Selection {
  names: string[]
  focused: string | null
}

const EMPTY_SELECTION: Selection = { names: [], focused: null }

/**
 * 실행 설정 목록 + 콘솔. `backend` 로 IDE 경유(기존)와 독립 실행(IntelliJ 없이)을
 * 모두 그린다 — 두 메뉴가 같은 화면을 공유한다.
 */
function ServicesView({ backend }: { backend: ServicesBackend }) {
  const api = useServices(backend)
  const text = BACKEND_TEXT[backend]
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION)
  const [treeWidth, setTreeWidth] = useLocalStorage<number>(
    TREE_WIDTH_KEY[backend],
    DEFAULT_TREE
  )
  const [dragging, setDragging] = useState(false)
  // 일괄 실행 순서 편집 레이어 열림 상태.
  const [planOpen, setPlanOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  /** 콘솔이 사라지지 않도록 현재 컨테이너 폭까지 고려해 목록 폭을 자른다. */
  const clampWidth = useCallback((w: number) => {
    const box = containerRef.current?.getBoundingClientRect()
    const max = box
      ? Math.max(MIN_TREE, Math.min(MAX_TREE, box.width - MIN_CONSOLE))
      : MAX_TREE
    return Math.min(max, Math.max(MIN_TREE, w))
  }, [])

  // 좌우 분할선 드래그(IntelliJ 처럼 목록 폭을 조절한다).
  const onSplitterDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const box = containerRef.current?.getBoundingClientRect()
      if (!box) return
      // 포인터를 잡아 두어야 커서가 콘솔(로그 텍스트) 위로 들어가도 드래그가 끊기지 않는다.
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      setDragging(true)

      const move = (ev: PointerEvent) => {
        setTreeWidth(clampWidth(ev.clientX - box.left))
      }
      const up = () => {
        setDragging(false)
        el.releasePointerCapture(e.pointerId)
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        window.removeEventListener("pointercancel", up)
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", up)
    },
    [clampWidth, setTreeWidth]
  )

  // 접근성 — 분할선에 포커스가 있으면 ←/→ 로도 폭을 조절할 수 있다.
  const onSplitterKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const delta =
        e.key === "ArrowLeft"
          ? -KEY_STEP
          : e.key === "ArrowRight"
            ? KEY_STEP
            : 0
      if (delta === 0) return
      e.preventDefault()
      setTreeWidth((w) => clampWidth(w + delta))
    },
    [clampWidth, setTreeWidth]
  )

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        items: api.services.filter((s) => s.type === g.kind),
      })).filter((g) => g.items.length > 0),
    [api.services]
  )

  /**
   * 목록 클릭. ⌘(macOS)/Ctrl 을 누른 채면 선택에 넣거나 빼고, 그냥 클릭이면 하나만 남긴다.
   * 담아 둔 것을 빼면서 그게 콘솔에 떠 있던 것이면 남은 것 중 마지막으로 초점을 옮긴다.
   */
  const select = useCallback((name: string, additive: boolean) => {
    setSel((prev) => {
      if (!additive) return { names: [name], focused: name }
      if (!prev.names.includes(name)) {
        return { names: [...prev.names, name], focused: name }
      }
      const names = prev.names.filter((n) => n !== name)
      return {
        names,
        focused: prev.focused === name ? (names.at(-1) ?? null) : prev.focused,
      }
    })
  }, [])

  const focus = useCallback(
    (name: string) => setSel((prev) => ({ ...prev, focused: name })),
    []
  )

  const deselect = useCallback((name: string) => select(name, true), [select])

  // 목록에서 사라진 이름(프로젝트 전환·새로고침)은 화면에서만 걸러낸다 —
  // 상태를 effect 로 되돌리면 로딩 중 한 프레임 동안 선택이 통째로 날아간다.
  const present = useMemo(
    () => new Set(api.services.map((s) => s.name)),
    [api.services]
  )
  const selection = useMemo(
    () =>
      sel.names
        .filter((n) => present.has(n))
        .map((n) => api.services.find((s) => s.name === n) as Service),
    [sel.names, present, api.services]
  )
  const selectedNames = useMemo(
    () => new Set(selection.map((s) => s.name)),
    [selection]
  )

  // 콘솔에 띄울 설정. 초점이 목록에서 사라졌으면(새로고침으로 이름이 바뀐 경우 등)
  // 남아 있는 선택 중 마지막 것으로 대신한다 — 선택이 있는데 빈 화면이 뜨지 않게.
  const current = useMemo(
    () =>
      api.services.find((s) => s.name === sel.focused) ??
      selection.at(-1) ??
      null,
    [api.services, sel.focused, selection]
  )

  // 이 프로젝트에 순차 실행 프리셋이 있으면 툴바에 버튼을 띄운다(cowork = 일괄 실행).
  const preset = useMemo(() => sequenceFor(api.projectPath), [api.projectPath])

  // 종료를 제어할 수 있으면서 지금 실행 중인 서비스들 — 종료 드롭다운의 항목.
  const stoppable = useMemo(
    () => api.services.filter((s) => api.running.has(s.name) && s.stoppable),
    [api.services, api.running]
  )

  if (!isTauri()) {
    return (
      <div className="py-8 text-center text-[15px] text-muted-foreground">
        이 기능은 데스크톱 앱에서만 동작합니다.
      </div>
    )
  }

  return (
    // 크롬 위에 얹힌 흰 패널 — Slack 처럼 10px 라운드 + 부드러운 그림자.
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* 상단: 프로젝트 선택 + 새로고침 + MCP 연결 상태 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {backend === "standalone" ? (
          // IDE 를 켜지 않고 쓰는 기능이라 "최근 프로젝트" 목록에 기댈 수 없다.
          // 경로를 여기서 바로 고친다 — 설정 화면까지 가지 않아도 되고, 값은
          // 설정(`coworkService.projectPath`)에 저장되어 설정 화면과 같은 것을 가리킨다.
          <ProjectPathInput api={api} />
        ) : (
          <select
            value={api.projectPath ?? ""}
            onChange={(e) => api.setProjectPath(e.target.value || null)}
            className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-[15px] focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid"
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
        )}

        {api.mcp && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold",
              api.mcp.connected
                ? "bg-ui-success/15 text-ui-success"
                : "bg-ui-error/15 text-ui-error"
            )}
            title={api.mcp.error ?? api.mcp.url ?? ""}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {api.mcp.connected ? text.on : text.off}
          </span>
        )}

        {preset && (
          <Button
            size="sm"
            variant="outline"
            // 바로 실행하지 않고 단계 편집 레이어를 연다(순서 확인·변경 후 실행).
            onClick={() => setPlanOpen(true)}
            // 순차 실행 중에는 중복 실행을 막는다(중단은 아래 진행 표시에서).
            disabled={api.sequenceActive || !api.mcp?.connected}
            className="shrink-0 rounded-full"
            title="1단계~5단계 실행 순서를 확인·변경한 뒤 실행합니다."
          >
            {api.sequenceActive ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <ListStartIcon className="size-3.5" />
            )}
            {preset.label}
          </Button>
        )}

        {/* 종료 드롭다운 — IntelliJ Services 의 Stop 버튼처럼 서비스별 종료 + 전체 종료. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={stoppable.length === 0}
            render={
              <Button
                size="sm"
                variant="outline"
                className={cn(
                  "shrink-0 rounded-full",
                  stoppable.length > 0 && "text-ui-error hover:text-ui-error"
                )}
                title={
                  stoppable.length > 0
                    ? "실행 중인 서비스를 종료합니다."
                    : "종료할 수 있는 실행 중인 서비스가 없습니다."
                }
              />
            }
          >
            <SquareIcon className="size-3.5 fill-current" />
            종료
            {stoppable.length > 0 && (
              <span className="tabular-nums">{stoppable.length}</span>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-56">
            {stoppable.map((s) => (
              <DropdownMenuItem
                key={s.name}
                variant="destructive"
                disabled={api.pending.has(s.name)}
                onClick={() => void api.stop(s.name)}
              >
                <SquareIcon className="size-3.5 fill-current" />
                <span className="truncate">{s.name} 종료</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => void api.stopAll()}
            >
              <SquareIcon className="size-3.5 fill-current" />
              전체 종료
              <DropdownMenuShortcut className="tabular-nums">
                {stoppable.length}
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          size="sm"
          variant="outline"
          onClick={() => api.refresh()}
          disabled={api.loading}
          className="shrink-0 rounded-full"
        >
          <RotateCwIcon
            className={cn("size-3.5", api.loading && "animate-spin")}
          />
          새로고침
        </Button>
      </div>

      <RecentStrip api={api} onSelect={select} />

      <SequenceStrip api={api} />

      {/* 경로가 아예 없을 때. 모델 상태를 물어볼 대상조차 없으니 배지 대신 이걸 띄운다. */}
      {backend === "standalone" && !api.projectPath && (
        <div className="flex shrink-0 items-start gap-2 border-b border-ui-warning/40 bg-ui-warning/10 px-4 py-3 text-[13px]">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-ui-warning" />
          <div>
            <div className="font-bold text-ui-warning">
              cowork 프로젝트 경로를 지정하세요.
            </div>
            <div className="mt-0.5 text-muted-foreground">
              위 입력란에 cowork 를 클론한 폴더(= IntelliJ 로 여는 프로젝트
              루트)를 적으면 됩니다. <span className="font-mono">~</span> 로
              시작하는 경로도 됩니다. 같은 값이 <b>설정 → Cowork 서비스</b> 에도
              있습니다.
            </div>
          </div>
        </div>
      )}

      {/* MCP 미연결 안내 — 이 기능의 전제 조건이라 눈에 띄게 알린다. */}
      {api.mcp && !api.mcp.connected && (
        <div className="flex shrink-0 items-start gap-2 border-b border-ui-warning/40 bg-ui-warning/10 px-4 py-3 text-[13px]">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-ui-warning" />
          <div>
            <div className="font-bold text-ui-warning">{text.warnTitle}</div>
            <div className="mt-0.5 text-muted-foreground">{text.warnBody}</div>
            {api.mcp.error && (
              <div className="mt-1 font-mono text-[13px] opacity-80">
                {api.mcp.error}
              </div>
            )}
          </div>
        </div>
      )}

      {api.error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-ui-error/40 bg-ui-error/10 px-4 py-3 text-[13px] text-ui-error">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span className="break-all">{api.error}</span>
        </div>
      )}

      {/* 본문: 좌측 목록 | 분할선 | 우측 콘솔 */}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <aside
          style={{ width: treeWidth }}
          className="min-h-0 shrink-0 overflow-auto bg-sidebar p-2"
        >
          {grouped.length === 0 ? (
            <div className="px-3 py-8 text-center text-[15px] text-muted-foreground">
              {api.loading ? "불러오는 중…" : "실행 설정이 없습니다."}
            </div>
          ) : (
            grouped.map((g) => (
              <TreeGroup
                key={g.kind}
                label={g.label}
                items={g.items}
                api={api}
                selected={selectedNames}
                focused={sel.focused}
                onSelect={select}
              />
            ))
          )}
        </aside>

        {/* 분할선 — 보이는 건 1px 선이지만 잡을 수 있게 6px 폭을 준다. */}
        <div
          onPointerDown={onSplitterDown}
          onKeyDown={onSplitterKeyDown}
          onDoubleClick={() => setTreeWidth(DEFAULT_TREE)}
          role="separator"
          aria-orientation="vertical"
          aria-label="서비스 목록 너비 조절"
          aria-valuenow={treeWidth}
          aria-valuemin={MIN_TREE}
          aria-valuemax={MAX_TREE}
          tabIndex={0}
          title="드래그해서 목록 너비를 조절합니다 (더블클릭: 기본값)"
          className="group relative flex w-1.5 shrink-0 cursor-col-resize touch-none items-stretch justify-center focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring focus-visible:outline-solid"
        >
          <div
            className={cn(
              "w-px transition-colors",
              dragging
                ? "bg-ui-selection"
                : "bg-border group-hover:bg-ui-selection/60"
            )}
          />
        </div>

        <ConsolePanel
          service={current}
          selection={selection}
          api={api}
          onFocus={focus}
          onRemove={deselect}
        />
      </div>

      {planOpen && (
        <StagePlanDialog api={api} onClose={() => setPlanOpen(false)} />
      )}
    </div>
  )
}

/** 개발 → IntelliJ 서비스 — IDE(MCP)에 실행을 시킨다. */
export function IntellijServicesView() {
  return <ServicesView backend="ide" />
}

/** 개발 → Cowork 서비스 — IntelliJ 없이 직접 java 로 띄운다. */
export function StandaloneServicesView() {
  return <ServicesView backend="standalone" />
}
