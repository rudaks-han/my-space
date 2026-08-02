import { useMemo, useRef, useState } from "react"
import {
  ArrowDownAZIcon,
  BracesIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClipboardPasteIcon,
  CopyIcon,
  EraserIcon,
  WandSparklesIcon,
} from "lucide-react"
import { toast } from "sonner"

import { JsonText, JsonTree, type CollapseSignal } from "@/components/json-view"
import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { cn } from "@/lib/utils"
import {
  countLines,
  formatBytes,
  parseJson,
  sortKeysDeep,
  type JsonParseError,
} from "./json-tools"
import { useJsonInput } from "./use-json-input"

/**
 * JSON 포맷터 — 왼쪽에 붙여넣으면 오른쪽에 정리해서 보여 준다.
 *
 * 오른쪽은 두 가지 보기를 준다: 접고 펼 수 있는 **트리**(공용 `JsonTree`, ES·Kafka
 * 뷰어와 같은 것)와 들여쓰기를 고른 **텍스트**. 왼쪽 입력은 건드리지 않는 것이 기본이고,
 * `입력 정렬`(⌘↵) 을 눌렀을 때만 결과를 입력창에 반영한다 — 자동으로 덮어쓰면 편집 중인
 * 원본과 캐럿 위치를 잃는다.
 *
 * 오류는 **줄/칸까지** 알려 준다. JSC 의 `JSON.parse` 는 위치를 안 주므로 자체 파서로
 * 다시 읽어 위치를 얻는다(`json-tools.ts` 참고). 엄격 파싱이 실패했는데 주석·마지막
 * 쉼표 같은 걸 허용하면 읽히는 경우엔 "느슨하게 읽기" 를 제안한다 — 조용히 허용하면
 * 서버는 거절할 입력을 유효하다고 알려 주는 셈이 된다.
 */

type Mode = "tree" | "text"
type IndentKey = "2" | "4" | "tab" | "min"

const INDENTS: { key: IndentKey; label: string; value: number | string }[] = [
  { key: "2", label: "2칸", value: 2 },
  { key: "4", label: "4칸", value: 4 },
  { key: "tab", label: "탭", value: "\t" },
  { key: "min", label: "압축", value: 0 },
]

const WIDTH_KEY = "myspace.jsonFormatter.inputWidth"
const DEFAULT_WIDTH = 520
const MIN_WIDTH = 280
const MAX_WIDTH = 1100

/** 줄 번호를 이 이상 그리면 낭비다(그때는 눈금 자체를 감춘다). */
const GUTTER_LIMIT = 20_000
/** 트리 보기는 노드가 곧 DOM 이라 큰 입력에서 멈춘 것처럼 보인다. */
const TREE_LIMIT = 300 * 1024
/** 이보다 큰 텍스트는 구문 강조를 생략한다(정규식 + span 이 수만 개가 된다). */
const HIGHLIGHT_LIMIT = 1024 * 1024
/** 이보다 크면 "느슨하게 읽으면 되는지" 확인용 재파싱을 생략한다(키 입력마다 돈다). */
const PROBE_LIMIT = 512 * 1024
/** textarea 와 줄 번호 눈금이 같이 써야 하는 줄 높이(px). */
const LINE_H = 20

type Analysis =
  | { kind: "empty" }
  | { kind: "ok"; value: unknown; relaxed: boolean }
  | { kind: "error"; error: JsonParseError; canRelax: boolean }

function analyze(text: string, lenient: boolean): Analysis {
  if (!text.trim()) return { kind: "empty" }
  // 성공 경로는 네이티브가 훨씬 빠르다. 실패했을 때만 자체 파서로 위치를 캔다.
  try {
    return { kind: "ok", value: JSON.parse(text), relaxed: false }
  } catch {
    // 아래에서 위치를 계산한다.
  }
  const strict = parseJson(text)
  if (strict.ok) {
    // JSON.parse 는 거절했는데 우리 엄격 파서는 통과한 경우(중첩이 너무 깊은 입력 등).
    // 기준은 네이티브 쪽이므로 오류로 취급하되, 위치는 알 수 없다.
    return {
      kind: "error",
      error: {
        message: "JSON 으로 읽을 수 없습니다",
        line: 1,
        column: 1,
        index: 0,
      },
      canRelax: false,
    }
  }
  if (lenient) {
    const soft = parseJson(text, { lenient: true })
    if (soft.ok) return { kind: "ok", value: soft.value, relaxed: true }
    // 느슨하게 읽어도 실패했다면 그쪽 오류가 더 정확하다.
    return { kind: "error", error: soft.error, canRelax: false }
  }
  const canRelax =
    text.length <= PROBE_LIMIT && parseJson(text, { lenient: true }).ok
  return { kind: "error", error: strict.error, canRelax }
}

export function JsonFormatterView() {
  const [input, setInput] = useJsonInput()
  const [mode, setMode] = useLocalStorage<Mode>(
    "myspace.jsonFormatter.mode",
    "tree"
  )
  const [indentKey, setIndentKey] = useLocalStorage<IndentKey>(
    "myspace.jsonFormatter.indent",
    "2"
  )
  const [sortKeys, setSortKeys] = useLocalStorage(
    "myspace.jsonFormatter.sortKeys",
    false
  )
  const [lenient, setLenient] = useLocalStorage(
    "myspace.jsonFormatter.lenient",
    false
  )
  const [signal, setSignal] = useState<CollapseSignal>({
    version: 0,
    target: false,
  })

  const taRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)

  const {
    width: inputWidth,
    resizing,
    startResize,
  } = useResizableWidth(WIDTH_KEY, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH)

  const indent = INDENTS.find((o) => o.key === indentKey)?.value ?? 2
  const analysis = useMemo(() => analyze(input, lenient), [input, lenient])
  const value = analysis.kind === "ok" ? analysis.value : null

  const output = useMemo(() => {
    if (analysis.kind !== "ok") return ""
    const v = sortKeys ? sortKeysDeep(analysis.value) : analysis.value
    try {
      return JSON.stringify(v, null, indent) ?? ""
    } catch {
      // 순환 참조는 JSON.parse 결과에 있을 수 없으니 사실상 도달하지 않는다.
      return ""
    }
  }, [analysis, sortKeys, indent])

  const treeValue = useMemo(
    () => (sortKeys && value !== null ? sortKeysDeep(value) : value),
    [sortKeys, value]
  )

  // 결과 크기·줄 수는 MB 짜리에서 매 렌더 계산할 일이 아니다.
  const outStats = useMemo(
    () => ({ size: formatBytes(output), lines: countLines(output) }),
    [output]
  )

  const lineCount = useMemo(() => countLines(input), [input])
  const gutter = useMemo(() => {
    if (lineCount > GUTTER_LIMIT) return ""
    let s = ""
    for (let n = 1; n <= lineCount; n++) s += `${n}\n`
    return s
  }, [lineCount])

  /** textarea 를 스크롤하면 줄 번호 눈금도 같이 움직여야 한다. */
  const syncGutter = (top: number) => {
    if (gutterRef.current) gutterRef.current.scrollTop = top
  }

  const applyFormat = () => {
    if (analysis.kind !== "ok" || !output) return
    setInput(output)
  }

  const jumpToError = (err: JsonParseError) => {
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(err.index, err.index)
    const top = Math.max(0, (err.line - 1) * LINE_H - ta.clientHeight / 2)
    ta.scrollTop = top
    syncGutter(top)
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) {
        toast.error("클립보드가 비어 있습니다")
        return
      }
      setInput(text)
    } catch {
      toast.error(
        "클립보드를 읽을 수 없습니다 — 입력창에 ⌘V 로 붙여넣어 주세요"
      )
    }
  }

  const copy = async () => {
    if (!output) return
    try {
      await navigator.clipboard.writeText(output)
      toast.success("결과를 복사했습니다")
    } catch {
      toast.error("복사할 수 없습니다")
    }
  }

  const collapseAll = (target: boolean) =>
    setSignal((s) => ({ version: s.version + 1, target }))

  return (
    <div className="flex h-full gap-3">
      {/* ── 입력 ──
          `overflow-hidden` 을 쓰지 않는다: 폭 조절 손잡이가 패널 바깥(-right-2)에
          놓이므로 잘려서 잡을 수 없게 된다. */}
      <section
        className="relative flex min-h-0 shrink-0 flex-col rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
        style={{ width: inputWidth }}
      >
        <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <h3 className="text-[15px] font-semibold">입력</h3>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={paste}>
              <ClipboardPasteIcon />
              붙여넣기
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={analysis.kind !== "ok"}
              onClick={applyFormat}
              title="정렬한 결과를 입력창에 반영합니다 (⌘↵)"
            >
              <WandSparklesIcon />
              입력 정렬
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={input === ""}
              onClick={() => setInput("")}
            >
              <EraserIcon />
              지우기
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {gutter !== "" && (
            <pre
              ref={gutterRef}
              aria-hidden
              className="w-11 shrink-0 overflow-hidden border-r border-border/60 bg-muted/30 py-2.5 pr-2 text-right font-mono text-[13px] text-muted-foreground select-none"
              style={{ lineHeight: `${LINE_H}px` }}
            >
              {gutter}
            </pre>
          )}
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onScroll={(e) => syncGutter(e.currentTarget.scrollTop)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault()
                applyFormat()
              }
            }}
            wrap="off"
            spellCheck={false}
            placeholder={
              '여기에 JSON 을 붙여넣으세요 (⌘V)\n예: {"name":"my-space","tags":[1,2,3]}'
            }
            className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 font-mono text-[13px] outline-none placeholder:text-muted-foreground"
            style={{ lineHeight: `${LINE_H}px` }}
          />
        </div>

        <StatusFooter
          analysis={analysis}
          input={input}
          lineCount={lineCount}
          lenient={lenient}
          onRelax={() => setLenient(true)}
          onStrict={() => setLenient(false)}
          onJump={jumpToError}
        />

        <ResizeHandle
          resizing={resizing}
          onPointerDown={startResize}
          label="입력 영역 폭 조절"
        />
      </section>

      {/* ── 결과 ── */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <header className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
          <h3 className="text-[15px] font-semibold">결과</h3>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { key: "tree", label: "트리" },
              { key: "text", label: "텍스트" },
            ]}
          />
          {mode === "text" && (
            <Segmented
              value={indentKey}
              onChange={setIndentKey}
              options={INDENTS.map((o) => ({ key: o.key, label: o.label }))}
            />
          )}
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant={sortKeys ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setSortKeys((s) => !s)}
              title="객체 키를 사전순으로 정렬해서 보여 줍니다"
            >
              <ArrowDownAZIcon />키 정렬
            </Button>
            {mode === "tree" && (
              <>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => collapseAll(false)}
                >
                  전체 확장
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => collapseAll(true)}
                >
                  전체 축소
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="xs"
              disabled={output === ""}
              onClick={copy}
            >
              <CopyIcon />
              복사
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {analysis.kind !== "ok" ? (
            <Placeholder analysis={analysis} />
          ) : mode === "tree" ? (
            // 기준은 들여쓰기 설정에 흔들리지 않는 원본 길이로 잡는다.
            input.length > TREE_LIMIT ? (
              <TooBig onSwitch={() => setMode("text")} />
            ) : (
              <JsonTree value={treeValue} signal={signal} />
            )
          ) : output.length > HIGHLIGHT_LIMIT ? (
            <pre className="font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
              {output}
            </pre>
          ) : (
            <JsonText text={output} />
          )}
        </div>

        {analysis.kind === "ok" && (
          <footer className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5 text-[13px] text-muted-foreground">
            <span>{outStats.size}</span>
            <span>·</span>
            <span>{outStats.lines.toLocaleString()}줄</span>
          </footer>
        )}
      </section>
    </div>
  )
}

/** 입력창 아래의 검증 상태 줄. */
function StatusFooter({
  analysis,
  input,
  lineCount,
  lenient,
  onRelax,
  onStrict,
  onJump,
}: {
  analysis: Analysis
  input: string
  lineCount: number
  lenient: boolean
  onRelax: () => void
  onStrict: () => void
  onJump: (err: JsonParseError) => void
}) {
  if (analysis.kind === "empty") {
    return (
      <footer className="shrink-0 border-t border-border px-3 py-1.5 text-[13px] text-muted-foreground">
        붙여넣은 내용이 없습니다.
      </footer>
    )
  }

  if (analysis.kind === "error") {
    return (
      <footer className="shrink-0 border-t border-border bg-ui-error/8 px-3 py-1.5">
        <div className="flex items-start gap-1.5 text-[13px] text-ui-error">
          <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-bold">{analysis.error.message}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => onJump(analysis.error)}
                className="underline underline-offset-2"
                title="입력창의 해당 위치로 이동합니다"
              >
                {analysis.error.line.toLocaleString()}번째 줄{" "}
                {analysis.error.column.toLocaleString()}칸
              </button>
              {analysis.canRelax && (
                <Button variant="outline" size="xs" onClick={onRelax}>
                  느슨하게 읽기
                </Button>
              )}
            </div>
            {analysis.canRelax && (
              <p className="mt-0.5 text-muted-foreground">
                주석 · 마지막 쉼표 · 홑따옴표 · 따옴표 없는 키를 허용하면 읽을
                수 있는 입력입니다. (정식 JSON 은 아닙니다)
              </p>
            )}
          </div>
        </div>
      </footer>
    )
  }

  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-1.5 text-[13px] text-muted-foreground">
      <span
        className={cn(
          "flex items-center gap-1 font-bold",
          analysis.relaxed ? "text-ui-warning" : "text-ui-success"
        )}
      >
        <CircleCheckIcon className="size-3.5" />
        {analysis.relaxed ? "느슨한 문법으로 읽었습니다" : "유효한 JSON"}
      </span>
      <span>·</span>
      <span>{lineCount.toLocaleString()}줄</span>
      <span>·</span>
      <span>{formatBytes(input)}</span>
      {lenient && (
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          onClick={onStrict}
          title="정식 JSON 문법만 허용하도록 되돌립니다"
        >
          엄격하게
        </Button>
      )}
    </footer>
  )
}

/** 결과가 없을 때(빈 입력 · 오류)의 안내. */
function Placeholder({
  analysis,
}: {
  analysis: Extract<Analysis, { kind: "empty" } | { kind: "error" }>
}) {
  const error = analysis.kind === "error"
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-[10px]",
          error ? "bg-ui-error/10" : "bg-muted"
        )}
      >
        {error ? (
          <CircleAlertIcon className="size-6 text-ui-error" />
        ) : (
          <BracesIcon className="size-6 text-muted-foreground" />
        )}
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-bold">
          {error ? "JSON 을 읽을 수 없습니다" : "결과가 여기에 나옵니다"}
        </p>
        <p className="text-[13px] text-muted-foreground">
          {error
            ? "왼쪽 아래에 오류 위치가 표시됩니다."
            : "왼쪽에 JSON 을 붙여넣으면 정리해서 보여 줍니다."}
        </p>
      </div>
    </div>
  )
}

/** 트리로 그리기엔 너무 큰 결과. */
function TooBig({ onSwitch }: { onSwitch: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-bold">
          결과가 커서 트리를 그리지 않았습니다
        </p>
        <p className="text-[13px] text-muted-foreground">
          노드가 수만 개가 되면 화면이 멈춘 것처럼 느려집니다.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onSwitch}>
        텍스트로 보기
      </Button>
    </div>
  )
}

/** Kafka 뷰어와 같은 톤의 작은 분절 컨트롤. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { key: T; label: string }[]
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-[13px] font-bold transition-colors",
            value === o.key
              ? "bg-ui-selection text-ui-selection-fg"
              : "text-muted-foreground hover:bg-ui-list-hover"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
