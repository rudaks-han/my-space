import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Message } from "../types"
import { useT, useI18n, getLocale } from "../i18n-context"

export function MetaUserMessage({ msg }: { msg: Message }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const c = msg.message?.content
  const blocks = Array.isArray(c) ? c : []
  const textBlocks = blocks.filter((b) => b.type === "text" && b.text)
  const firstText = textBlocks[0]?.text || (typeof c === "string" ? c : "")
  const cmdMatch = firstText.match(/<command-name>([^<]+)<\/command-name>/)
  const skillName = cmdMatch?.[1]

  const contentBlocks = skillName ? textBlocks.slice(1) : textBlocks
  const contentText = contentBlocks
    .map((b) => b.text || "")
    .join("\n")
    .trim()

  if (skillName) {
    return (
      <div className="text-xs opacity-70">
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full cursor-pointer items-center gap-1.5 transition-opacity hover:opacity-100"
        >
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
          <Badge
            variant="outline"
            className="border-purple/30 bg-purple/10 text-[10px] text-purple"
          >
            {t("badge.skill")}
          </Badge>
          <span className="font-mono text-muted-foreground">{skillName}</span>
        </button>
        {open && contentText && (
          <pre className="mt-1 ml-4.5 max-h-[300px] overflow-y-auto rounded-md bg-purple/5 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
            {contentText}
          </pre>
        )}
      </div>
    )
  }

  const fullText =
    contentBlocks.map((b) => b.text || "").join("\n") || firstText
  const isLong = fullText.length > 100

  return (
    <div className="text-xs opacity-70">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left transition-opacity hover:opacity-100"
        disabled={!isLong}
      >
        {isLong && (
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
        )}
        <Badge variant="outline" className="shrink-0 border-border text-[10px]">
          meta
        </Badge>
        <span className="truncate text-muted-foreground">
          {isLong && !open ? fullText.slice(0, 100) : fullText}
        </span>
      </button>
      {open && isLong && (
        <pre className="mt-1 ml-4.5 max-h-[300px] overflow-y-auto rounded-md bg-secondary/30 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">
          {fullText}
        </pre>
      )}
    </div>
  )
}

export function TextContent({ text }: { text: string }) {
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /```(\w*)\n([\s\S]*?)```/g,
      '<pre class="bg-background rounded-md p-3 my-2 text-xs font-mono overflow-x-auto"><code>$2</code></pre>'
    )
    .replace(
      /`([^`]+)`/g,
      '<code class="bg-secondary px-1.5 py-0.5 rounded text-xs font-mono">$1</code>'
    )

  return (
    <div
      className="text-sm leading-relaxed break-words whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function ThinkingBlock({
  text,
  autoExpand,
}: {
  text: string
  autoExpand?: boolean
}) {
  const [open, setOpen] = useState(!!autoExpand)

  return (
    <div className="my-1.5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full cursor-pointer rounded-lg border border-purple/20 bg-purple/5 px-3 py-2 text-left text-xs text-purple"
      >
        <span className="font-medium">💭 thinking</span>
      </button>
      {open && text && (
        <div className="max-h-52 overflow-y-auto">
          <pre className="rounded-b-md border border-t-0 border-purple/20 bg-purple/5 px-3 py-2 text-xs whitespace-pre-wrap text-purple">
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}

export function UsageTooltip({
  usage,
  model,
  timestamp,
}: {
  usage: NonNullable<NonNullable<Message["message"]>["usage"]>
  model: string
  timestamp?: string
}) {
  const t = useT()
  const { lang } = useI18n()
  const fullTime = timestamp
    ? new Date(timestamp).toLocaleString(getLocale(lang))
    : ""
  return (
    <div className="group relative inline-flex">
      <span className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:bg-accent">
        ?
      </span>
      <div className="absolute right-0 bottom-6 z-50 hidden min-w-[200px] rounded-md border border-border bg-popover p-3 text-xs whitespace-nowrap shadow-md group-hover:block">
        <div className="space-y-1">
          <div>
            <span className="text-muted-foreground">{t("tooltip.model")}:</span>{" "}
            {model}
          </div>
          {fullTime && (
            <div>
              <span className="text-muted-foreground">
                {t("tooltip.time")}:
              </span>{" "}
              {fullTime}
            </div>
          )}
          <Separator className="my-1.5" />
          <div>
            <span className="text-muted-foreground">{t("tooltip.input")}:</span>{" "}
            {usage.input_tokens.toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">
              {t("tooltip.output")}:
            </span>{" "}
            {usage.output_tokens.toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">
              {t("tooltip.cacheCreate")}:
            </span>{" "}
            {(usage.cache_creation_input_tokens || 0).toLocaleString()}
          </div>
          <div>
            <span className="text-muted-foreground">
              {t("tooltip.cacheRead")}:
            </span>{" "}
            {(usage.cache_read_input_tokens || 0).toLocaleString()}
          </div>
        </div>
      </div>
    </div>
  )
}

export function CollapsibleSection({
  label,
  children,
  count,
  autoExpand,
}: {
  label: string
  children: React.ReactNode
  count?: number
  autoExpand?: boolean
}) {
  const [open, setOpen] = useState(!!autoExpand)
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-1 border-t border-b border-border bg-secondary/30 px-3 py-1.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-secondary/50"
      >
        <ChevronRight
          className={cn("h-3 w-3 transition-transform", open && "rotate-90")}
        />
        <span>{label}</span>
        {count && count > 1 && <span>#{count}</span>}
      </button>
      {open && children}
    </div>
  )
}
