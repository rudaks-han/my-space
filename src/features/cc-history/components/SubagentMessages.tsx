import { useState, useRef, useEffect, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronRight } from "lucide-react"
import { formatTime, shouldShow } from "../helpers"
import { cn } from "@/lib/utils"
import { MetaUserMessage, UsageTooltip } from "./MessageParts"
import { ToolUseBlock } from "./ToolUseBlock"
import type { SubagentInfo, ContentBlock, MessageFilters } from "../types"
import { useT } from "../i18n-context"

export function SubagentMessages({
  info,
  autoExpand,
  filters,
}: {
  info: SubagentInfo
  autoExpand?: boolean
  filters?: MessageFilters
}) {
  const t = useT()
  const [open, setOpen] = useState(!!autoExpand)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const prevLenRef = useRef(0)
  const visibleMessages = info.messages.filter((m) => {
    if (
      m.type === "permission-mode" ||
      m.type === "file-history-snapshot" ||
      m.type === "tool_result"
    )
      return false
    if (m.type === "user") {
      const c = m.message?.content
      if (Array.isArray(c) && c.every((b) => b.type === "tool_result"))
        return false
    }
    if (
      filters &&
      (filters.roles.size > 0 ||
        filters.contents.size > 0 ||
        filters.tools.size > 0)
    ) {
      if (!shouldShow(m, filters)) return false
    }
    return true
  })

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    wasAtBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }, [])

  useEffect(() => {
    if (!open) return
    if (
      visibleMessages.length !== prevLenRef.current ||
      wasAtBottomRef.current
    ) {
      const el = scrollRef.current
      if (el && wasAtBottomRef.current) {
        setTimeout(() => {
          el.scrollTop = el.scrollHeight
        }, 30)
      }
    }
    prevLenRef.current = visibleMessages.length
  }, [open, visibleMessages.length])

  return (
    <div className="border-t border-border">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 bg-cyan/5 px-3 py-1.5 text-xs transition-colors hover:bg-cyan/10"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <Badge
          variant="outline"
          className="border-cyan/30 bg-cyan/10 text-[10px] text-cyan"
        >
          {info.agentType}
        </Badge>
        <span className="text-muted-foreground">{info.description}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {visibleMessages.length} {t("live.messagesSuffix")}
        </span>
      </button>
      {open && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="max-h-[500px] overflow-y-auto"
        >
          <div className="space-y-2 bg-background/50 px-3 py-2">
            {visibleMessages.map((m, i) => {
              if (m.type === "user") {
                if (m.isMeta) {
                  return <MetaUserMessage key={i} msg={m} />
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
                    <div key={i} className="space-y-1 text-xs">
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
                  <div key={i} className="text-xs">
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
                  <div key={i} className="text-xs">
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
                      />
                    ))}
                  </div>
                )
              }
              if (m.type === "tool_result") return null
              return null
            })}
          </div>
        </div>
      )}
    </div>
  )
}
