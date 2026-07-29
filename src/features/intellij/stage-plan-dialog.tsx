import { useEffect, useMemo, useRef, useState } from "react"
import {
  GripVerticalIcon,
  ListStartIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { useServices, Service } from "./use-services"
import { placeService, removeService, useStagePlan } from "./use-stage-plan"

type Api = ReturnType<typeof useServices>

/** 미포함(제외) 영역을 나타내는 특수 드롭 대상 인덱스. */
const EXCLUDED = -1

/** 드래그로 인식하기 시작하는 이동 거리(px). */
const DRAG_THRESHOLD = 4

/** 드래그 중 상태 — 무엇을, 어느 대상 위에서, 어디(커서 좌표)에. */
interface DragState {
  name: string
  over: number | null
  x: number
  y: number
}

/**
 * 일괄 실행 순서 편집 레이어.
 *
 * 현재 설정된 서비스를 1단계~5단계로 나눠 보여 주고, 드래그로 단계를 바꾼다.
 * "실행" 을 누르면 비어 있지 않은 단계만 추려 순차 실행(`api.startSequence`)에 넘긴다 —
 * 각 단계는 앞 단계가 모두 기동을 마친 뒤 시작된다(기존 동작 그대로).
 *
 * WKWebView(Tauri)에서 HTML5 draggable 이 동작하지 않으므로, 사이드바 메뉴 드래그와
 * 같은 방식(pointer 이벤트 + `elementFromPoint`)으로 직접 구현한다.
 */
export function StagePlanDialog({
  api,
  onClose,
}: {
  api: Api
  onClose: () => void
}) {
  const plan = useStagePlan(api.projectPath, api.services)
  const [drag, setDrag] = useState<DragState | null>(null)
  // 콜백(window 리스너)에서 최신 단계 배열을 참조하기 위한 ref.
  const stagesRef = useRef(plan.stages)
  useEffect(() => {
    stagesRef.current = plan.stages
  }, [plan.stages])

  // 이름 → 설정(포트 칩 표시용).
  const byName = useMemo(() => {
    const m = new Map<string, Service>()
    for (const s of api.services) m.set(s.name, s)
    return m
  }, [api.services])

  // Esc 로 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const runnable = useMemo(
    () => plan.stages.filter((s) => s.length > 0),
    [plan.stages]
  )
  const canRun =
    runnable.length > 0 && !!api.mcp?.connected && !api.sequenceActive

  /**
   * 커서 아래의 드롭 대상 계산 — { stage, beforeName }.
   * stage 는 단계 인덱스(또는 EXCLUDED), beforeName 은 그 앞에 끼워 넣을 설정(없으면 맨 뒤).
   */
  const targetAt = (name: string, x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const zone = el?.closest<HTMLElement>("[data-stage-drop]")
    if (!zone) return null
    const stage = Number(zone.dataset.stageDrop)
    let beforeName: string | null = null
    const chip = el?.closest<HTMLElement>("[data-chip]")
    const over = chip?.dataset.chip
    if (over && over !== name) {
      const rect = chip!.getBoundingClientRect()
      // 칩의 왼쪽 절반이면 그 앞, 오른쪽 절반이면 그 다음 칩 앞(마지막이면 맨 뒤).
      if (x < rect.left + rect.width / 2) beforeName = over
      else if (stage !== EXCLUDED) {
        const arr = stagesRef.current[stage]
        beforeName = arr[arr.indexOf(over) + 1] ?? null
      }
    }
    return { stage, beforeName }
  }

  /** 칩에서 pointerdown → threshold 이상 움직이면 드래그. */
  const startDrag = (e: React.PointerEvent, name: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    let started = false

    const onMove = (ev: PointerEvent) => {
      if (
        !started &&
        Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
        Math.abs(ev.clientY - startY) < DRAG_THRESHOLD
      )
        return
      if (!started) {
        started = true
        document.body.style.userSelect = "none"
      }
      const t = targetAt(name, ev.clientX, ev.clientY)
      setDrag({ name, over: t ? t.stage : null, x: ev.clientX, y: ev.clientY })
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      if (started) {
        const t = targetAt(name, ev.clientX, ev.clientY)
        if (t) {
          const next =
            t.stage === EXCLUDED
              ? removeService(stagesRef.current, name)
              : placeService(stagesRef.current, name, t.stage, t.beforeName)
          plan.setStages(next)
        }
      }
      setDrag(null)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const run = () => {
    if (!canRun) return
    void api.startSequence(runnable)
    onClose()
  }

  /** 드래그 가능한 설정 칩(단계·미포함 공용). */
  const Chip = ({ name }: { name: string }) => {
    const svc = byName.get(name)
    const port = svc?.expected_port ?? undefined
    return (
      <div
        data-chip={name}
        onPointerDown={(e) => startDrag(e, name)}
        // 드래그 중인 칩은 elementFromPoint 가 아래 대상을 보도록 클릭 통과시킨다.
        style={drag?.name === name ? { pointerEvents: "none" } : undefined}
        className={cn(
          "flex cursor-grab touch-none items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[13px] font-bold shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-opacity select-none active:cursor-grabbing",
          drag?.name === name && "opacity-40"
        )}
        title={name}
      >
        <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
        {port != null && (
          <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-bold text-muted-foreground tabular-nums">
            :{port}
          </span>
        )}
      </div>
    )
  }

  return (
    // 레이어 — 반투명 배경 위에 가운데 정렬한 흰 패널.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      >
        {/* 헤더 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <ListStartIcon className="size-4 shrink-0 text-ui-selection" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[18px] font-bold tracking-[-0.01em]">
              일괄 실행 순서
            </div>
            <div className="text-[13px] text-muted-foreground">
              단계를 드래그해 바꾸세요. 위 단계가 모두 뜬 뒤 다음 단계가
              실행됩니다.
            </div>
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="닫기">
            <XIcon className="size-4" />
          </Button>
        </div>

        {/* 단계 목록 */}
        <div className="min-h-0 flex-1 overflow-auto bg-sidebar p-4">
          <div className="flex flex-col gap-2.5">
            {plan.stages.map((names, i) => (
              <div
                key={i}
                data-stage-drop={i}
                className={cn(
                  "rounded-[10px] border bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-colors",
                  drag?.over === i
                    ? "border-ui-selection ring-2 ring-ui-selection/30"
                    : "border-border"
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-ui-selection text-[13px] font-bold text-ui-selection-fg tabular-nums">
                    {i + 1}
                  </span>
                  <span className="text-[15px] font-semibold">{i + 1}단계</span>
                  <span className="text-[13px] text-muted-foreground">
                    {names.length === 0
                      ? "동시 실행할 서비스를 여기로 드래그"
                      : `${names.length}개 동시 실행`}
                  </span>
                </div>
                {/* 빈 단계에도 드롭할 수 있게 최소 높이를 준다. */}
                <div className="flex min-h-8 flex-wrap items-center gap-1.5">
                  {names.length === 0 ? (
                    <span className="rounded-lg border border-dashed border-border px-3 py-1.5 text-[13px] text-muted-foreground">
                      비어 있음
                    </span>
                  ) : (
                    names.map((name) => <Chip key={name} name={name} />)
                  )}
                </div>
              </div>
            ))}

            {/* 미포함 — 여기로 드래그하면 일괄 실행에서 빠진다. */}
            <div
              data-stage-drop={EXCLUDED}
              className={cn(
                "rounded-[10px] border border-dashed p-3 transition-colors",
                drag?.over === EXCLUDED
                  ? "border-ui-selection bg-ui-selection/5"
                  : "border-border"
              )}
            >
              <div className="mb-2 text-[15px] font-semibold text-muted-foreground">
                미포함{" "}
                <span className="text-[13px] font-normal">
                  (일괄 실행에서 제외)
                </span>
              </div>
              <div className="flex min-h-8 flex-wrap items-center gap-1.5">
                {plan.excluded.length === 0 ? (
                  <span className="text-[13px] text-muted-foreground">
                    모든 서비스가 단계에 배치되었습니다.
                  </span>
                ) : (
                  plan.excluded.map((name) => <Chip key={name} name={name} />)
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 푸터 */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3">
          {plan.customized && (
            <Button
              size="sm"
              variant="ghost"
              onClick={plan.resetStages}
              className="rounded-full text-muted-foreground"
              title="저장된 구성을 지우고 기본 순서로 되돌립니다."
            >
              <RotateCcwIcon className="size-3.5" />
              기본값 복원
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={onClose}
              className="rounded-full"
            >
              취소
            </Button>
            <Button
              size="sm"
              onClick={run}
              disabled={!canRun}
              className="rounded-full"
              title={
                !api.mcp?.connected
                  ? "IntelliJ MCP 서버에 연결되어 있지 않습니다."
                  : api.sequenceActive
                    ? "이미 순차 실행이 진행 중입니다."
                    : runnable.length === 0
                      ? "실행할 단계가 없습니다."
                      : `${runnable.length}개 단계를 순서대로 실행합니다.`
              }
            >
              {api.sequenceActive ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <ListStartIcon className="size-3.5" />
              )}
              실행
            </Button>
          </div>
        </div>
      </div>

      {/* 드래그 중 커서를 따라다니는 미리보기 — "잡혔다" 는 피드백. */}
      {drag && (
        <div
          className="pointer-events-none fixed z-[60] flex items-center gap-1.5 rounded-full border border-ui-selection bg-card px-2.5 py-1 text-[13px] font-bold shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          <GripVerticalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          {drag.name}
        </div>
      )}
    </div>
  )
}
