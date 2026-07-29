import { createContext, useContext, useEffect, useRef, useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { highlightJson } from "@/lib/highlight-json"
import { cn } from "@/lib/utils"

/**
 * JSON 값을 보여 주는 공용 뷰어 (ES 문서·Kafka 메시지 등).
 *  - `JsonTree`: `+`/`−` 로 접고 펴는 트리 뷰(전체 확장/축소 신호를 받는다).
 *  - `JsonRaw`: 구문 강조된 원본 JSON(`<pre>`).
 *
 * 토큰 색은 `--ui-*` 토큰 기반 유틸리티라 라이트/다크 모두에서 자연스럽게 읽힌다.
 */

/** 전체 확장/축소 신호. version 이 바뀌면 모든 노드가 target 으로 접힘/펴짐. */
export interface CollapseSignal {
  version: number
  target: boolean
}

const CollapseContext = createContext<CollapseSignal>({
  version: 0,
  target: false,
})

function primitive(v: unknown) {
  if (v === null) return <span className="text-muted-foreground">null</span>
  if (typeof v === "string")
    return <span className="text-ui-success">{JSON.stringify(v)}</span>
  if (typeof v === "boolean")
    return <span className="text-ui-info">{String(v)}</span>
  if (typeof v === "number") return <span className="text-ui-warning">{v}</span>
  return <span>{String(v)}</span>
}

function JsonNode({
  k,
  value,
  isLast,
}: {
  k: string | null
  value: unknown
  isLast: boolean
}) {
  const isArr = Array.isArray(value)
  const isObj = value !== null && typeof value === "object"
  const signal = useContext(CollapseContext)
  const [collapsed, setCollapsed] = useState(false)
  const mounted = useRef(false)

  // 전체 확장/축소 신호에만 반응(최초 마운트 시엔 무시).
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setCollapsed(signal.target)
  }, [signal.version, signal.target])

  const keyLabel =
    k === null ? null : (
      <>
        <span className="text-ui-link">{JSON.stringify(k)}</span>
        <span className="text-muted-foreground">: </span>
      </>
    )
  const comma = isLast ? null : <span className="text-muted-foreground">,</span>

  if (!isObj) {
    return (
      <div className="whitespace-pre">
        {keyLabel}
        {primitive(value)}
        {comma}
      </div>
    )
  }

  const entries: [string | null, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const open = isArr ? "[" : "{"
  const close = isArr ? "]" : "}"

  if (entries.length === 0) {
    return (
      <div className="whitespace-pre">
        {keyLabel}
        <span className="text-muted-foreground">
          {open}
          {close}
        </span>
        {comma}
      </div>
    )
  }

  const label = isArr ? "개" : "개 필드"

  return (
    <div>
      <div
        className="flex cursor-pointer items-center rounded-sm whitespace-pre hover:bg-ui-list-hover"
        onClick={() => setCollapsed((c) => !c)}
      >
        <ChevronRightIcon
          className={cn(
            "-ml-1 size-3.5 shrink-0 text-muted-foreground transition-transform",
            !collapsed && "rotate-90"
          )}
        />
        {keyLabel}
        {collapsed ? (
          <span className="text-muted-foreground">
            {open}
            <span className="mx-1 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">
              {entries.length}
              {label}
            </span>
            {close}
          </span>
        ) : (
          <span className="text-muted-foreground">{open}</span>
        )}
        {collapsed && comma}
      </div>
      {!collapsed && (
        <>
          <div className="border-l border-border/60 pl-4">
            {entries.map(([ek, ev], i) => (
              <JsonNode
                key={ek ?? i}
                k={isArr ? null : ek}
                value={ev}
                isLast={i === entries.length - 1}
              />
            ))}
          </div>
          <div className="whitespace-pre">
            <span className="text-muted-foreground">{close}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  )
}

/** 접고 펴는 트리 뷰. `signal` 로 전체 확장/축소를 제어한다. */
export function JsonTree({
  value,
  signal,
}: {
  value: unknown
  signal: CollapseSignal
}) {
  return (
    <CollapseContext.Provider value={signal}>
      <div className="font-mono text-[13px] leading-relaxed">
        <JsonNode k={null} value={value} isLast />
      </div>
    </CollapseContext.Provider>
  )
}

/** 구문 강조된 원본 JSON. */
export function JsonRaw({ value }: { value: unknown }) {
  return (
    <pre
      className="overflow-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap [&_.jbool]:text-ui-info [&_.jkey]:text-ui-link [&_.jnull]:text-muted-foreground [&_.jnum]:text-ui-warning [&_.jstr]:text-ui-success"
      dangerouslySetInnerHTML={{ __html: highlightJson(value) }}
    />
  )
}
