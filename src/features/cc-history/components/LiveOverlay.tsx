/* eslint-disable react-hooks/refs -- 이전 렌더와 비교해 '새로 추가된' 메시지에만 진입 애니메이션을 주는 라이브 테일 패턴(원본 cc-history-viewer 이식). ref 는 렌더 사이 이전값 보관 용도로만 쓴다. */
import { useRef, useEffect, memo } from "react"
import { Badge } from "@/components/ui/badge"
import { Radio, X } from "lucide-react"
import { MessageBlock } from "./MessageBlock"
import { MetaUserMessage, UsageTooltip } from "./MessageParts"
import { ToolUseBlock } from "./ToolUseBlock"
import { formatTime } from "../helpers"
import type { Message, SubagentMap, SubagentInfo, ContentBlock } from "../types"
import { useT } from "../i18n-context"

function getRecentSubagents(
  subagents: SubagentMap
): { id: string; info: SubagentInfo }[] {
  if (!subagents || Object.keys(subagents).length === 0) return []

  const entries = Object.entries(subagents)
    .filter(([, s]) => s.messages.length > 0)
    .map(([id, info]) => {
      const lastTs = info.messages[info.messages.length - 1]?.timestamp || ""
      return { id, info, lastTs }
    })
    .sort((a, b) => (b.lastTs > a.lastTs ? 1 : -1))

  return entries.slice(0, 5).map(({ id, info }) => ({ id, info }))
}

// Memoized subagent card — only re-renders when its own message count changes
const LiveSubagentCard = memo(
  function LiveSubagentCard({ id, info }: { id: string; info: SubagentInfo }) {
    const t = useT()
    const scrollRef = useRef<HTMLDivElement>(null)
    const prevCountRef = useRef(0)

    const visible = info.messages.filter(
      (m) => m.type !== "permission-mode" && m.type !== "file-history-snapshot"
    )

    const prevCount = prevCountRef.current
    prevCountRef.current = visible.length

    const contentRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const scrollEl = scrollRef.current
      const contentEl = contentRef.current
      if (!scrollEl || !contentEl) return
      const scroll = () => {
        scrollEl.scrollTop = scrollEl.scrollHeight
      }
      scroll()
      const ro = new ResizeObserver(scroll)
      ro.observe(contentEl)
      return () => ro.disconnect()
    }, [])

    if (visible.length === 0) return null

    return (
      <div
        key={id}
        className="overflow-hidden rounded-lg border border-cyan/30"
      >
        <div className="flex items-center gap-2 border-b border-cyan/20 bg-cyan/5 px-3 py-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan" />
          </span>
          <Badge
            variant="outline"
            className="border-cyan/30 bg-cyan/10 text-[10px] text-cyan"
          >
            {info.agentType}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {info.description}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {info.messages.length} {t("live.messagesSuffix")}
          </span>
        </div>
        <div
          ref={scrollRef}
          className="max-h-[500px] overflow-y-auto bg-background/50"
        >
          <div ref={contentRef} className="space-y-2 px-3 py-2">
            {visible.map((m, i) => {
              const isNew = prevCount > 0 && i >= prevCount
              const animClass = isNew
                ? "animate-in fade-in slide-in-from-bottom-2 duration-300"
                : ""
              const animStyle = isNew
                ? {
                    animationDelay: `${(i - prevCount) * 60}ms`,
                    animationFillMode: "both" as const,
                  }
                : undefined

              if (m.type === "user") {
                if (m.isMeta) {
                  return (
                    <div key={i} className={animClass} style={animStyle}>
                      <MetaUserMessage msg={m} />
                    </div>
                  )
                }
                const c = m.message?.content
                const hasToolResult =
                  Array.isArray(c) && c.some((b) => b.type === "tool_result")
                if (hasToolResult && Array.isArray(c)) {
                  const nonToolResultBlocks = c.filter(
                    (b) => b.type !== "tool_result"
                  )
                  if (nonToolResultBlocks.length === 0) return null
                  return (
                    <div
                      key={i}
                      className={`space-y-1 text-xs ${animClass}`}
                      style={animStyle}
                    >
                      <Badge className="bg-blue/15 text-[10px] text-blue">
                        {t("role.user")}
                      </Badge>
                      {nonToolResultBlocks.map((block, j) => {
                        if (block.type === "text" && block.text) {
                          return (
                            <span
                              key={j}
                              className="break-words whitespace-pre-wrap"
                            >
                              {block.text}
                            </span>
                          )
                        }
                        return null
                      })}
                    </div>
                  )
                }
                const text = typeof c === "string" ? c : JSON.stringify(c)
                return (
                  <div
                    key={i}
                    className={`text-xs ${animClass}`}
                    style={animStyle}
                  >
                    <Badge className="mr-1 bg-blue/15 text-[10px] text-blue">
                      User
                    </Badge>
                    <span className="break-words whitespace-pre-wrap">
                      {(text || "").slice(0, 1000)}
                    </span>
                  </div>
                )
              }
              if (m.type === "assistant") {
                const content = m.message?.content
                const texts: string[] = []
                const toolUses: ContentBlock[] = []
                if (Array.isArray(content)) {
                  for (const b of content) {
                    if (b.type === "text" && b.text) texts.push(b.text)
                    if (b.type === "tool_use") toolUses.push(b)
                  }
                } else if (typeof content === "string") {
                  texts.push(content)
                }
                const usage = m.message?.usage
                const subModel = m.message?.model || ""
                return (
                  <div
                    key={i}
                    className={`text-xs ${animClass}`}
                    style={animStyle}
                  >
                    <div className="mb-0.5 flex items-center gap-1">
                      <Badge className="bg-brand/15 text-[10px] text-brand">
                        Claude
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {formatTime(m.timestamp)}
                      </span>
                      <span className="ml-auto flex items-center gap-1">
                        {usage && (
                          <>
                            <Badge
                              variant="outline"
                              className="border-blue/30 bg-blue/10 text-[9px] text-blue"
                            >
                              IN {usage.input_tokens.toLocaleString()}
                            </Badge>
                            <Badge
                              variant="outline"
                              className="border-orange/30 bg-orange/10 text-[9px] text-orange"
                            >
                              OUT {usage.output_tokens.toLocaleString()}
                            </Badge>
                          </>
                        )}
                        {subModel && (
                          <span className="text-[10px] text-muted-foreground">
                            {subModel}
                          </span>
                        )}
                        {usage && (
                          <UsageTooltip
                            usage={usage}
                            model={subModel}
                            timestamp={m.timestamp}
                          />
                        )}
                      </span>
                    </div>
                    {texts.length > 0 && (
                      <span className="break-words whitespace-pre-wrap">
                        {texts.join("\n").slice(0, 1000)}
                      </span>
                    )}
                    {toolUses.map((tu, j) => (
                      <ToolUseBlock
                        key={j}
                        block={tu}
                        allMessages={info.messages}
                        autoExpand
                      />
                    ))}
                  </div>
                )
              }
              return null
            })}
          </div>
        </div>
      </div>
    )
  },
  (prev, next) => {
    // Only re-render when this subagent's message count changes
    return prev.info.messages.length === next.info.messages.length
  }
)

export function LiveOverlay({
  messages,
  subagents,
  onClose,
}: {
  messages: Message[]
  subagents: SubagentMap
  onClose: () => void
}) {
  const t = useT()
  const liveScrollRef = useRef<HTMLDivElement>(null)

  const filteredMessages = messages.filter((m) => {
    if (m.type === "tool_result") return false
    if (m.type === "user" && !m.isMeta) {
      const c = m.message?.content
      if (Array.isArray(c) && c.every((b) => b.type === "tool_result"))
        return false
    }
    return true
  })

  const allSubagents = getRecentSubagents(subagents)

  // Build unified timeline: main messages + subagent cards, sorted by time, take 3
  type TimelineItem =
    | { kind: "message"; msg: Message; ts: string }
    | { kind: "subagent"; id: string; info: SubagentInfo; ts: string }

  const timeline: TimelineItem[] = []
  for (const m of filteredMessages) {
    timeline.push({ kind: "message", msg: m, ts: m.timestamp || "" })
  }
  for (const { id, info } of allSubagents) {
    const lastTs = info.messages[info.messages.length - 1]?.timestamp || ""
    timeline.push({ kind: "subagent", id, info, ts: lastTs })
  }
  timeline.sort((a, b) => (b.ts > a.ts ? 1 : a.ts > b.ts ? -1 : 0))
  const recentTimeline = timeline.slice(0, 3).reverse()

  const activeSubagents = recentTimeline
    .filter(
      (t): t is TimelineItem & { kind: "subagent" } => t.kind === "subagent"
    )
    .map((t) => ({ id: t.id, info: t.info }))

  // Track which items are new to only animate those
  const prevKeysRef = useRef<Set<string>>(new Set())
  const itemKeys = recentTimeline.map((t) =>
    t.kind === "message" ? `msg:${t.ts}` : `sub:${t.id}`
  )
  const prevKeys = prevKeysRef.current
  const newKeySet = new Set(itemKeys)
  const newItems = new Set(itemKeys.filter((k) => !prevKeys.has(k)))

  useEffect(() => {
    prevKeysRef.current = newKeySet
  })

  const outerContentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const scrollEl = liveScrollRef.current
    const contentEl = outerContentRef.current
    if (!scrollEl || !contentEl) return
    const scroll = () => {
      scrollEl.scrollTop = scrollEl.scrollHeight
    }
    scroll()
    const ro = new ResizeObserver(scroll)
    ro.observe(contentEl)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      className="absolute inset-0 z-50 animate-in bg-background/80 backdrop-blur-sm duration-200 fade-in"
      onClick={onClose}
    >
      <div
        className="absolute inset-4 flex animate-in flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl duration-300 fade-in slide-in-from-top-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-red-500" />
            <span className="font-heading text-sm font-medium">
              {t("live.recent")}
            </span>
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            {activeSubagents.length > 0 && (
              <Badge
                variant="outline"
                className="border-cyan/30 bg-cyan/10 text-[10px] text-cyan"
              >
                {activeSubagents.length} {t("live.subagentsSuffix")}
              </Badge>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div ref={liveScrollRef} className="flex-1 overflow-y-auto">
          <div
            ref={outerContentRef}
            className="flex min-h-full flex-col justify-end space-y-3 p-4"
          >
            {recentTimeline.map((item, i) => {
              const key =
                item.kind === "message" ? `msg:${item.ts}` : `sub:${item.id}`
              const isNew = newItems.has(key)
              return item.kind === "message" ? (
                <div
                  key={item.msg.timestamp || i}
                  className={
                    isNew
                      ? "animate-in duration-500 fade-in slide-in-from-bottom-3"
                      : ""
                  }
                  style={
                    isNew
                      ? {
                          animationDelay: `${i * 100}ms`,
                          animationFillMode: "both",
                        }
                      : undefined
                  }
                >
                  <MessageBlock
                    msg={item.msg}
                    id={`live-${i}`}
                    allMessages={messages}
                    autoExpand
                  />
                </div>
              ) : (
                <LiveSubagentCard key={item.id} id={item.id} info={item.info} />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
