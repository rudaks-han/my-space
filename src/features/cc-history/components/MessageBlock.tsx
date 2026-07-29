import { Badge } from "@/components/ui/badge"
import { formatTime } from "../helpers"
import { cn } from "@/lib/utils"
import {
  TextContent,
  ThinkingBlock,
  UsageTooltip,
  MetaUserMessage,
} from "./MessageParts"
import { ToolUseBlock } from "./ToolUseBlock"
import { AttachmentBlock } from "./AttachmentBlock"
import type {
  Message,
  ContentBlock,
  SubagentMap,
  SubagentInfo,
  WorkflowMap,
  MessageFilters,
} from "../types"
import { useT } from "../i18n-context"

interface MessageBlockProps {
  msg: Message
  id: string
  subagents?: SubagentMap
  workflows?: WorkflowMap
  allMessages?: Message[]
  autoExpand?: boolean
  subagentInfo?: SubagentInfo
  filters?: MessageFilters
}

function SubagentOriginBadge({ info }: { info: SubagentInfo }) {
  return (
    <Badge
      variant="outline"
      className="border-cyan/30 bg-cyan/10 text-[10px] text-cyan"
    >
      🤖 {info.agentType}
    </Badge>
  )
}

const borderColors: Record<string, string> = {
  user: "border-l-blue",
  assistant: "border-l-brand",
  system: "border-l-yellow",
  tool_result: "border-l-purple",
}

function findSubagent(
  subagents: SubagentMap | undefined,
  block: ContentBlock
): SubagentInfo | undefined {
  if (!subagents || block.name !== "Agent") return undefined
  const desc = (block.input as Record<string, unknown>)?.description as
    string | undefined
  if (!desc) return undefined
  return Object.values(subagents).find((s) => s.description === desc)
}

export function MessageBlock({
  msg,
  id,
  subagents,
  workflows,
  allMessages,
  autoExpand,
  subagentInfo,
  filters,
}: MessageBlockProps) {
  const t = useT()
  const time = formatTime(msg.timestamp)

  if (msg.type === "user" && msg.isMeta) {
    return (
      <div id={id} className="rounded-lg border border-border bg-card p-3">
        <div className="mb-1.5 flex items-center gap-2">
          {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {time}
          </span>
        </div>
        <MetaUserMessage msg={msg} />
      </div>
    )
  }

  if (msg.type === "user" && !msg.isMeta) {
    const content = msg.message?.content
    const hasToolResult =
      Array.isArray(content) && content.some((b) => b.type === "tool_result")

    if (hasToolResult && Array.isArray(content)) {
      const nonToolResultBlocks = content.filter(
        (b) => b.type !== "tool_result"
      )
      if (nonToolResultBlocks.length === 0) {
        return (
          <div
            id={id}
            className={cn(
              "rounded-lg border border-l-[3px] border-border bg-card px-3 py-1.5 opacity-70",
              borderColors.tool_result
            )}
          >
            <div className="flex items-center gap-2 text-xs">
              <Badge
                variant="outline"
                className="border-purple/30 bg-purple/10 text-[10px] text-purple"
              >
                {t("badge.toolResult")}
              </Badge>
              {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
              <span className="ml-auto text-muted-foreground">{time}</span>
            </div>
          </div>
        )
      }

      return (
        <div
          id={id}
          className={cn(
            "rounded-xl border border-l-[3px] border-border bg-card p-4",
            borderColors.user
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge className="bg-blue/15 text-[11px] text-blue hover:bg-blue/20">
                {t("role.user")}
              </Badge>
              {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
            </div>
            <span className="text-[11px] text-muted-foreground">{time}</span>
          </div>
          {nonToolResultBlocks.map((block, i) => {
            if (block.type === "text" && block.text) {
              return <TextContent key={i} text={block.text} />
            }
            return null
          })}
        </div>
      )
    }

    if (Array.isArray(content)) {
      return (
        <div
          id={id}
          className={cn(
            "rounded-xl border border-l-[3px] border-border bg-card p-4",
            borderColors.user
          )}
        >
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge className="bg-blue/15 text-[11px] text-blue hover:bg-blue/20">
                {t("role.user")}
              </Badge>
              {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
            </div>
            <span className="text-[11px] text-muted-foreground">{time}</span>
          </div>
          {content.map((block, i) => {
            if (block.type === "text" && block.text) {
              return <TextContent key={i} text={block.text} />
            }
            if (block.type === "image" && block.source?.data) {
              return (
                <img
                  key={i}
                  src={`data:${block.source.media_type || "image/png"};base64,${block.source.data}`}
                  className="my-1.5 max-h-[400px] max-w-full rounded-md border border-border object-contain"
                  alt={t("attachment.imageAlt")}
                />
              )
            }
            return null
          })}
        </div>
      )
    }

    const text = typeof content === "string" ? content : ""
    return (
      <div
        id={id}
        className={cn(
          "rounded-xl border border-l-[3px] border-border bg-card p-4",
          borderColors.user
        )}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge className="bg-blue/15 text-[11px] text-blue hover:bg-blue/20">
              {t("role.user")}
            </Badge>
            {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
          </div>
          <span className="text-[11px] text-muted-foreground">{time}</span>
        </div>
        <div className="text-sm break-words whitespace-pre-wrap">{text}</div>
      </div>
    )
  }

  if (msg.type === "assistant") {
    const content = msg.message?.content
    const model = msg.message?.model || ""
    return (
      <div
        id={id}
        className={cn(
          "rounded-xl border border-l-[3px] border-border bg-card p-4",
          borderColors.assistant
        )}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge className="bg-brand/15 text-[11px] text-brand hover:bg-brand/20">
              Claude
            </Badge>
            {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
            <span className="text-[11px] text-muted-foreground">{time}</span>
          </div>
          <div className="flex items-center gap-2">
            {msg.message?.usage && (
              <>
                <Badge
                  variant="outline"
                  className="border-blue/30 bg-blue/10 text-[10px] text-blue"
                >
                  IN {msg.message.usage.input_tokens.toLocaleString()}
                </Badge>
                <Badge
                  variant="outline"
                  className="border-orange/30 bg-orange/10 text-[10px] text-orange"
                >
                  OUT {msg.message.usage.output_tokens.toLocaleString()}
                </Badge>
              </>
            )}
            <span className="text-[11px] text-muted-foreground">{model}</span>
            {msg.message?.usage && (
              <UsageTooltip
                usage={msg.message.usage}
                model={model}
                timestamp={msg.timestamp}
              />
            )}
          </div>
        </div>
        {Array.isArray(content) ? (
          content.map((block, i) => {
            if (block.type === "thinking")
              return (
                <ThinkingBlock
                  key={i}
                  text={block.thinking || ""}
                  autoExpand={autoExpand}
                />
              )
            if (block.type === "text" && block.text)
              return <TextContent key={i} text={block.text} />
            if (block.type === "tool_use")
              return (
                <ToolUseBlock
                  key={i}
                  block={block}
                  subagentInfo={findSubagent(subagents, block)}
                  subagents={subagents}
                  workflows={workflows}
                  allMessages={allMessages}
                  autoExpand={autoExpand}
                  filters={filters}
                />
              )
            return null
          })
        ) : typeof content === "string" ? (
          <TextContent text={content} />
        ) : null}
      </div>
    )
  }

  if (msg.type === "tool_result") {
    return (
      <div
        id={id}
        className={cn(
          "rounded-lg border border-l-[3px] border-border bg-card px-3 py-1.5 opacity-70",
          borderColors.tool_result
        )}
      >
        <div className="flex items-center gap-2 text-xs">
          <Badge
            variant="outline"
            className="border-purple/30 bg-purple/10 text-[10px] text-purple"
          >
            {t("badge.toolResult")}
          </Badge>
          {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
          <span className="ml-auto text-muted-foreground">{time}</span>
        </div>
      </div>
    )
  }

  if (msg.type === "attachment" && msg.attachment) {
    return <AttachmentBlock id={id} attachment={msg.attachment} time={time} />
  }

  if (msg.type === "system") {
    return (
      <div
        id={id}
        className={cn(
          "rounded-lg border border-l-[3px] border-border bg-card p-3 opacity-70",
          borderColors.system
        )}
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge className="bg-yellow/15 text-[11px] text-yellow hover:bg-yellow/20">
              {t("role.system")}
            </Badge>
            {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
            <span className="text-[11px] text-muted-foreground">
              {msg.subtype}
            </span>
          </div>
          <span className="text-[11px] text-muted-foreground">{time}</span>
        </div>
        {msg.content && (
          <div className="text-sm whitespace-pre-wrap">
            {msg.content as string}
          </div>
        )}
        {msg.hookInfos && msg.hookInfos.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {msg.hookInfos.map((hook, i) => (
              <div
                key={i}
                className="flex items-center gap-2 font-mono text-xs text-muted-foreground"
              >
                <Badge
                  variant="outline"
                  className="shrink-0 border-yellow/30 bg-yellow/10 text-[10px] text-yellow"
                >
                  {hook.durationMs}ms
                </Badge>
                <span className="break-all">{hook.command}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      id={id}
      className="rounded-md border border-border/60 bg-card/50 px-3 py-1.5 opacity-60"
    >
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="outline" className="border-border text-[10px]">
          {msg.type}
        </Badge>
        {msg.subtype && (
          <span className="text-muted-foreground">{msg.subtype}</span>
        )}
        {subagentInfo && <SubagentOriginBadge info={subagentInfo} />}
        <span className="ml-auto text-muted-foreground">{time}</span>
      </div>
    </div>
  )
}
