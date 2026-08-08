/**
 * IntelliJ Cowork 화면의 **아래 독** — 서비스 목록 + 콘솔.
 *
 * 같은 재료(`useServices("standalone")`)를 쓰는 화면이 이미 있지만(개발 → Cowork 서비스),
 * 그쪽은 화면 한 장을 통째로 서비스에 쓰는 260px 사이드바 + 36px 알약 + 전체 높이 콘솔이다.
 * 여기는 편집기 아래 300px 남짓한 띠라서 같은 레이아웃을 넣으면 목록 세 줄과 로그 다섯 줄이
 * 보인다 — 그래서 **컨트롤러만 공유하고 배치는 새로 짠다**: 행 24px, 글자 13px, 툴바는
 * 32px 헤더 한 줄, 콘솔은 12px. 로그 본문만은 `ConsoleLog` 로 공유한다(같은 프로세스의 같은
 * 출력을 두 화면이 다른 색으로 그리면 어느 쪽이 맞는지 알 수 없다).
 *
 * `api` 를 밖에서 받는 이유: 상단 툴바의 ▶/■ 도 같은 상태를 봐야 하는데, 훅을 두 번 부르면
 * 실행 중 목록·로그 버퍼·순차 실행 진행이 두 벌 생겨 서로 다른 말을 한다. 루트가 하나 만들어
 * 내려준다.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import {
  CircleAlertIcon,
  ListStartIcon,
  Loader2Icon,
  PlayIcon,
  RotateCcwIcon,
  SearchIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"

import { SplitBar } from "@/components/split-bar"
import { Button } from "@/components/ui/button"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { cn } from "@/lib/utils"
import { ConsoleLog } from "@/features/intellij/console-log"
import { StagePlanDialog } from "@/features/intellij/stage-plan-dialog"
import { StopAllDialog } from "@/features/intellij/stop-all-dialog"
import type { Service, useServices } from "@/features/intellij/use-services"
import { NS, type DockTab } from "./types"

type Api = ReturnType<typeof useServices>

/** 서비스 목록의 기본 폭 — 분할선 더블클릭이 되돌릴 목표값이라 상수로 둔다. */
const LIST_WIDTH = 300
const LIST_WIDTH_KEY = `${NS}.dockServicesWidth`

/** 종료·재시작을 쓸 수 없는 설정에 붙는 사유. 세 버튼이 같은 문장을 써야 한다. */
const NO_CONTROL =
  "이 설정은 종료 제어를 지원하지 않습니다(메인 클래스를 알 수 없음)"

/**
 * 목록 한 행 — 24px, 상태 점 · 이름 · 포트 · 실행 버튼.
 *
 * 행 자체가 버튼일 수 없다(안에 실행 버튼이 또 들어간다). 그래서 div 에 알약 배경을 칠하고
 * 이름 쪽만 버튼으로 둔다 — 큰 화면의 트리 행과 같은 구조다.
 */
function ServiceRow({
  service,
  api,
  selected,
  onSelect,
}: {
  service: Service
  api: Api
  selected: boolean
  /** 실행 버튼을 눌러도 그 서비스를 고른다 — 방금 올린 것의 로그가 바로 보이도록. */
  onSelect: (name: string) => void
}) {
  const name = service.name
  const isRunning = api.running.has(name)
  const failReason = api.failed.get(name)
  const isFailed = failReason != null && !isRunning
  const isPending = api.pending.has(name)
  // 종료를 제어할 수 있어야 중지·재시작이 가능하다(메인 클래스를 알아야 한다).
  const canControl = service.stoppable
  // 실행 중이면 실제 LISTEN 포트, 아니면 설정에서 알아낸 예상 포트. 실제 포트는 바인딩
  // 뒤에 두 번째 상태 이벤트로 오므로 기동 직후에는 잠깐 비어 있는 게 정상이다.
  const port = isRunning
    ? api.ports[name]
    : (service.expected_port ?? undefined)

  return (
    <div
      className={cn(
        "group flex h-6 items-center gap-1.5 rounded-lg px-1.5 text-[13px] transition-colors",
        selected
          ? "bg-ui-list-active font-bold text-ui-list-active-fg"
          : "hover:bg-ui-list-hover"
      )}
    >
      <button
        onClick={() => onSelect(name)}
        title={isFailed ? `${name} — ${failReason}` : name}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch text-left"
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            isRunning
              ? "bg-ui-success"
              : isFailed
                ? "bg-ui-error"
                : "bg-muted-foreground/40"
          )}
        />
        <span className="truncate">{name}</span>
        {port != null && (
          <span
            className={cn(
              "shrink-0 text-[11px] tabular-nums",
              selected ? "opacity-80" : "text-muted-foreground"
            )}
            title={isRunning ? "LISTEN 포트" : "설정상 예상 포트"}
          >
            :{port}
          </span>
        )}
      </button>

      {/* 고른 행에서는 항상, 나머지는 hover·포커스에서만 — 17개 행에 버튼이 상시로 붙으면
          이름이 밀리고 어느 것이 선택인지도 흐려진다. */}
      <Button
        size="icon-xs"
        variant="ghost"
        className={cn(
          "size-5 shrink-0",
          selected
            ? "text-current hover:bg-white/20"
            : isRunning
              ? canControl
                ? "text-ui-error hover:text-ui-error"
                : "text-muted-foreground"
              : "text-ui-success hover:text-ui-success",
          !selected &&
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        )}
        disabled={isPending || (isRunning && !canControl)}
        onClick={() => {
          onSelect(name)
          void (isRunning ? api.stop(name) : api.start(name))
        }}
        title={
          isRunning
            ? canControl
              ? "종료 — IntelliJ 정지 버튼과 같은 SIGINT(graceful shutdown)"
              : NO_CONTROL
            : "시작"
        }
      >
        {isPending ? (
          <Loader2Icon className="animate-spin" />
        ) : isRunning ? (
          <SquareIcon className="fill-current" />
        ) : (
          <PlayIcon className="fill-current" />
        )}
      </Button>
    </div>
  )
}

/**
 * 아래 독 본체.
 *
 * 콘솔 탭(`출력` / `HTTP 응답`)은 루트가 들고 있다 — 요청을 보낸 쪽(가운데 `.http` 탭)이
 * 응답이 도착하면 탭을 옮겨야 하는데, 그 신호가 여기서 시작되지 않기 때문이다.
 */
export function ServicesDock({
  api,
  dockTab,
  onDockTab,
  responseNode,
  className,
}: {
  /** 루트가 만든 `useServices("standalone")` — 상단 툴바와 같은 인스턴스여야 한다. */
  api: Api
  dockTab: DockTab
  onDockTab: (tab: DockTab) => void
  /** HTTP 응답 창(루트가 그린다). 탭이 `response` 일 때만 보인다. */
  responseNode: React.ReactNode
  className?: string
}) {
  // 선택은 **하나만**. 큰 화면의 ⌘ 다중 선택은 칩 줄·일괄 툴바까지 90줄쯤 되는데,
  // 독은 콘솔 한 칸이라 여러 개를 골라 봐야 결국 하나의 로그만 보인다.
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [planOpen, setPlanOpen] = useState(false)
  const [stopAllOpen, setStopAllOpen] = useState(false)
  const {
    width: listWidth,
    resizing,
    startResize,
  } = useResizableWidth(LIST_WIDTH_KEY, LIST_WIDTH, 200, 520)

  /**
   * 분할선 더블클릭 → 기본 폭 복귀.
   *
   * `useResizableWidth` 는 setter 를 내보내지 않고 값을 `useLocalStorage` 안에 둔다.
   * 같은 창에서 같은 키로 훅을 한 번 더 불러도 두 벌이 서로의 쓰기를 보지 못하므로
   * (`storage` 이벤트는 **다른 창**에서만 온다) 되돌릴 길이 없다 — 그래서 localStorage
   * 에 직접 쓰고 그 훅이 이미 듣고 있는 `storage` 이벤트를 손으로 만들어 알린다.
   * 같은 장치를 이 화면의 세 분할선도 쓴다(`cowork-dev-view.tsx` 의 `Splitter` 주석에
   * 전체 배경을 적어 두었다).
   */
  const resetListWidth = () => {
    const raw = JSON.stringify(LIST_WIDTH)
    localStorage.setItem(LIST_WIDTH_KEY, raw)
    window.dispatchEvent(
      new StorageEvent("storage", { key: LIST_WIDTH_KEY, newValue: raw })
    )
  }

  const services = api.services
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return services
    return services.filter((s) => s.name.toLowerCase().includes(q))
  }, [services, filter])

  const runningCount = useMemo(
    () => services.filter((s) => api.running.has(s.name)).length,
    [services, api.running]
  )
  // "모두 중지" 의 대상. 확인 대화창이 이 목록을 그대로 이름으로 보여 주므로 훅이 만든
  // 것을 쓴다 — 여기서 따로 걸러 내면 문장과 실제 대상이 어긋날 수 있다.
  const stoppable = api.stoppableRunning
  const hasStoppable = stoppable.length > 0

  // 선택한 이름이 목록에서 사라졌으면(경로 변경·새로고침) 화면에서만 걸러낸다 —
  // effect 로 상태를 되돌리면 불러오는 동안 한 프레임 선택이 통째로 날아간다.
  const current = useMemo(
    () => services.find((s) => s.name === selected) ?? null,
    [services, selected]
  )

  /**
   * 일괄 실행이 다음 단계로 넘어갈 때마다 그 단계의 첫 서비스로 콘솔을 옮긴다 —
   * 방금 올라가는 서비스의 부팅 로그를 보는 것이 이 독을 열어 두는 이유인데, 일괄 실행은
   * 목록에서 고르지 않은 설정을 띄우므로 그대로 두면 엉뚱한(또는 빈) 콘솔이 떠 있게 된다.
   *
   * 단계 식별자로 비교하는 이유: 한 단계가 `starting` → `waiting` 으로 두 번 오는데,
   * 그 사이에 사용자가 형제 서비스를 눌러 두었으면 되돌려 버린다. 진행이 끝나면(비활성)
   * 식별자를 비워, 같은 프리셋을 다시 실행했을 때 1단계가 다시 잡히게 한다.
   */
  const seq = api.sequence
  const seqActive = api.sequenceActive
  const lastStageRef = useRef<string | null>(null)
  useEffect(() => {
    if (!seqActive || !seq) {
      lastStageRef.current = null
      return
    }
    const key = `${seq.stage}:${seq.names.join(",")}`
    if (key === lastStageRef.current || seq.names.length === 0) return
    lastStageRef.current = key
    // Rust 가 보내는 단계 진행(= 외부 상태)에 화면 선택을 맞추는 것이라 effect 가 맞다.
    setSelected(seq.names[0])
  }, [seq, seqActive])

  // Rust 에 보관된 로그를 콘솔로 끌어온다. **이 앱에서 그 버퍼를 읽는 유일한 자리**라,
  // 빼면 서비스를 고른 순간에는 콘솔이 비어 있다가 다음 실시간 줄이 올 때부터 채워진다.
  // (`api` 째로 의존하면 훅이 새 객체를 돌려줄 때마다 다시 불리므로 함수만 꺼내 쓴다.)
  const name = current?.name
  const { loadLogs } = api
  useEffect(() => {
    if (name) void loadLogs(name)
  }, [name, loadLogs])

  const isRunning = current != null && api.running.has(current.name)
  const isPending = current != null && api.pending.has(current.name)
  const canControl = current?.stoppable === true
  const lines = name ? (api.logs[name] ?? []) : []

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        className
      )}
    >
      {/* ── 헤더 32px: 제목 · 실행 중 개수 · 실행 툴바 ── */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span className="shrink-0 text-[13px] font-semibold">서비스</span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 text-[11px] font-bold tabular-nums",
            runningCount > 0
              ? "bg-ui-badge text-ui-badge-fg"
              : "bg-muted text-muted-foreground"
          )}
          title="실행 중인 서비스 수"
        >
          {runningCount}개 실행 중
        </span>

        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            className={
              current && !isRunning
                ? "text-ui-success hover:text-ui-success"
                : "text-muted-foreground"
            }
            disabled={!current || isRunning || isPending}
            onClick={() => current && void api.start(current.name)}
            title={
              !current
                ? "왼쪽에서 서비스를 고르세요"
                : isRunning
                  ? "이미 실행 중입니다"
                  : `${current.name} 시작`
            }
          >
            {isPending && !isRunning ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <PlayIcon className="fill-current" />
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            // 쓸 수 없을 때는 빨강을 빼고 회색으로 둔다 — 옅어진 빨강은 "누르면 되는 버튼"
            // 처럼 보인다.
            className={
              isRunning && canControl
                ? "text-ui-error hover:text-ui-error"
                : "text-muted-foreground"
            }
            disabled={!isRunning || !canControl || isPending}
            onClick={() => current && void api.stop(current.name)}
            title={
              !current
                ? "왼쪽에서 서비스를 고르세요"
                : !current.stoppable
                  ? NO_CONTROL
                  : isRunning
                    ? "종료 — IntelliJ 정지 버튼과 같은 SIGINT(graceful shutdown)"
                    : "실행 중이 아닙니다"
            }
          >
            <SquareIcon className="fill-current" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className={
              isRunning && canControl ? undefined : "text-muted-foreground"
            }
            disabled={!isRunning || !canControl || isPending}
            onClick={() => current && void api.restart(current.name)}
            title={
              current && !current.stoppable
                ? NO_CONTROL
                : "재시작 — 완전히 내려간 것을 확인한 뒤 다시 띄웁니다(포트 충돌 방지)"
            }
          >
            <RotateCcwIcon className={cn(isPending && "animate-spin")} />
          </Button>
        </span>

        <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />

        <Button
          size="xs"
          variant="outline"
          className="shrink-0 rounded-full"
          // 바로 실행하지 않고 단계 편집 레이어를 연다(순서 확인·변경 후 실행).
          disabled={api.sequenceActive || !api.mcp?.connected}
          onClick={() => setPlanOpen(true)}
          title="단계별 실행 순서를 확인·변경한 뒤 차례로 띄웁니다."
        >
          {api.sequenceActive ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <ListStartIcon />
          )}
          일괄 실행
        </Button>
        <Button
          size="xs"
          variant="outline"
          className={cn(
            "shrink-0 rounded-full",
            hasStoppable && "text-ui-error hover:text-ui-error"
          )}
          disabled={!hasStoppable}
          // 되돌릴 수 없는 조작이라 바로 내리지 않고 대상을 보여 주며 한 번 묻는다.
          onClick={() => setStopAllOpen(true)}
          title={
            hasStoppable
              ? "실행 중이면서 종료를 제어할 수 있는 서비스를 모두 내립니다(확인 후)."
              : "종료할 수 있는 실행 중인 서비스가 없습니다."
          }
        >
          <SquareIcon className="fill-current" />
          모두 중지
        </Button>
      </div>

      {/* ── 본문: 목록 │ 콘솔 ──
          `gap` 을 주지 않는다. 두 칸 사이의 `SplitBar` 가 곧 그 간격이자 경계선이라,
          간격을 함께 두면 바 양옆에 죽은 여백이 생겨 다시 겨냥이 어려워진다(예전의
          `gap-2` + 절대 배치 손잡이가 정확히 그 상태였다 — 보이는 선과 잡히는 4px 이
          어긋나 있었다). */}
      <div className="flex min-h-0 flex-1">
        {/* `overflow-hidden` 은 걸지 않는다 — 넘침은 안쪽 목록이 스스로 처리하고,
            여기에 걸면 나중에 겹치는 것이 생길 때 이유 없이 잘린다. */}
        <aside
          style={{ width: listWidth }}
          className="relative flex min-h-0 shrink-0 flex-col bg-sidebar"
        >
          {/* 이 프로젝트의 실행 설정은 17개쯤 된다 — 24px 행으로도 독 높이에 다 안 들어가서
              찾기가 스크롤보다 빠르다. */}
          <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
              placeholder="서비스 찾기"
              className="h-full min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/*
            모델을 못 읽으면 목록이 빈다. 독을 통째로 비우는 대신 사유를 한 줄로 얹는다 —
            standalone 백엔드에서 이건 "IntelliJ 가 임포트해 둔 프로젝트 모델을 읽지 못했다"
            는 뜻이고, 무엇을 해야 하는지는 그 메시지에 이미 적혀 있다.
          */}
          {api.mcp && !api.mcp.connected && (
            <div
              className="shrink-0 truncate border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
              title={api.mcp.error ?? undefined}
            >
              {api.mcp.error ?? "프로젝트 모델을 읽을 수 없습니다."}
            </div>
          )}

          {/* 동작 실패를 조용히 삼키면 사용자는 눌렀는데 아무 일도 안 난 것으로 본다. */}
          {api.error && (
            <div
              className="flex shrink-0 items-center gap-1 border-b border-ui-error/40 bg-ui-error/10 px-2 py-1 text-[11px] text-ui-error"
              title={api.error}
            >
              <CircleAlertIcon className="size-3 shrink-0" />
              <span className="truncate">{api.error}</span>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {shown.length === 0 ? (
              <div className="px-2 py-4 text-center text-[12px] text-muted-foreground">
                {api.loading
                  ? "불러오는 중…"
                  : services.length === 0
                    ? "실행 설정이 없습니다."
                    : "찾는 서비스가 없습니다."}
              </div>
            ) : (
              shown.map((s) => (
                <ServiceRow
                  key={s.name}
                  service={s}
                  api={api}
                  selected={s.name === selected}
                  onSelect={setSelected}
                />
              ))
            )}
          </div>
        </aside>

        {/* 목록과 콘솔 사이의 분할선. `SplitBar` 에 `onDoubleClick` 이 없어서(공용
            부품이라 이 화면 하나 때문에 손대지 않는다) 한 겹 감싼다 — 감싼 div 도 flex
            자식 하나이므로 "바가 곧 경계선"이라는 계약은 그대로다. */}
        <div
          onDoubleClick={resetListWidth}
          title="서비스 목록 폭 조절 — 더블클릭하면 기본값으로"
          className="flex shrink-0"
        >
          <SplitBar
            orientation="vertical"
            resizing={resizing}
            onPointerDown={startResize}
            label="서비스 목록 폭 조절"
          />
        </div>

        {/* ── 콘솔: 탭 줄(출력 / HTTP 응답) + 본문 ── */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border px-2">
            {(
              [
                ["output", "출력"],
                ["response", "HTTP 응답"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => onDockTab(id)}
                className={cn(
                  // 가운데 탭 줄과 같은 밑줄 탭이되, 독이라 12px 로 줄인다.
                  "relative flex h-full cursor-pointer items-center px-0.5 text-[12px] whitespace-nowrap transition-colors",
                  dockTab === id
                    ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                    : "text-ui-tab-inactive-fg hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}

            {/* 지금 어느 서비스의 로그를 보고 있는지 — 목록에서 선택이 스크롤 밖으로
                밀려나도 여기서 알 수 있어야 한다. */}
            <span
              className="ml-auto min-w-0 truncate text-[12px] font-bold"
              title={name}
            >
              {name ?? ""}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="size-5 shrink-0"
              disabled={!name}
              onClick={() => name && api.clearLogs(name)}
              title="콘솔 지우기"
            >
              <Trash2Icon />
            </Button>
          </div>

          {/*
            둘 다 마운트해 두고 `invisible` 로 감춘다 — 셸 탭과 같은 이유로, `hidden` 이면
            돌아왔을 때 로그와 응답의 스크롤 위치가 맨 위로 되감긴다.
          */}
          <div className="relative min-h-0 flex-1">
            <div
              className={cn(
                "absolute inset-0 flex flex-col",
                dockTab !== "output" && "invisible"
              )}
            >
              <ConsoleLog
                lines={lines}
                className="p-2 text-[12px]"
                title={name}
                onClear={name ? () => api.clearLogs(name) : undefined}
              />
            </div>
            <div
              className={cn(
                "absolute inset-0 flex min-h-0 flex-col",
                dockTab !== "response" && "invisible"
              )}
            >
              {responseNode}
            </div>
          </div>
        </div>
      </div>

      {planOpen && (
        <StagePlanDialog api={api} onClose={() => setPlanOpen(false)} />
      )}

      {/* 마지막 하나가 스스로 내려가 대상이 비면 물을 것도 없어진다 — 그대로 닫는다. */}
      {stopAllOpen && hasStoppable && (
        <StopAllDialog
          targets={stoppable}
          onCancel={() => setStopAllOpen(false)}
          onConfirm={() => {
            setStopAllOpen(false)
            void api.stopAll()
          }}
        />
      )}
    </div>
  )
}
