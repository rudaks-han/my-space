import { Input } from "@/components/ui/input"
import { useState } from "react"
import {
  formatTime,
  truncate,
  getMessageType,
  getMessageText,
} from "../helpers"
import type { ContentBlock, VisibleItem } from "../types"
import { cn } from "@/lib/utils"
import { useT } from "../i18n-context"

interface MessageIndexProps {
  items: VisibleItem[]
  style?: React.CSSProperties
}

const dotColors: Record<string, string> = {
  user: "bg-blue",
  assistant: "bg-brand",
  tool_use: "bg-orange",
  tool_result: "bg-purple",
  system: "bg-yellow",
}

export function MessageIndex({ items, style }: MessageIndexProps) {
  const t = useT()
  const [search, setSearch] = useState("")

  const filtered = search
    ? items.filter(({ msg }) =>
        getMessageText(msg).toLowerCase().includes(search.toLowerCase())
      )
    : items

  const scrollTo = (key: string) => {
    document
      .getElementById(`msg-${key}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  return (
    <aside
      className="flex flex-col border-l border-border bg-card"
      style={style}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="font-heading text-sm font-medium">
          {t("index.title")}
        </span>
        <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-muted-foreground">
          {items.length}
        </span>
      </div>
      <div className="p-2">
        <Input
          placeholder={t("index.filter")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="px-1.5 pb-2">
          {filtered.map(({ msg, key, subagentInfo }, num) => {
            const type = getMessageType(msg)
            const title = truncate(getMessageText(msg), 55)
            let sub = ""
            if (
              msg.type === "assistant" &&
              Array.isArray(msg.message?.content)
            ) {
              const toolBlock = (msg.message.content as ContentBlock[]).find(
                (b) => b.type === "tool_use"
              )
              if (toolBlock) sub = truncate(JSON.stringify(toolBlock.input), 40)
            }

            return (
              <button
                key={key}
                onClick={() => scrollTo(key)}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <span
                  className={cn(
                    "mt-1 h-2 w-2 shrink-0 rounded-full",
                    dotColors[type] || "bg-muted-foreground"
                  )}
                />
                <span className="min-w-[24px] text-muted-foreground">
                  #{num + 1}
                </span>
                <div className="flex-1 overflow-hidden">
                  <div className="truncate">
                    {subagentInfo && (
                      <span className="mr-1 text-cyan">
                        🤖{subagentInfo.agentType}
                      </span>
                    )}
                    {title || "(empty)"}
                  </div>
                  {sub && (
                    <div className="truncate text-muted-foreground">{sub}</div>
                  )}
                </div>
                <span className="whitespace-nowrap text-muted-foreground">
                  {formatTime(msg.timestamp)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </aside>
  )
}
