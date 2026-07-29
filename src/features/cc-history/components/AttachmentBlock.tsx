import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Attachment } from "../types"
import { useT } from "../i18n-context"

function getAttachmentStyle(
  t: string,
  att: Attachment
): { borderClass: string; badgeClass: string } {
  switch (t) {
    case "hook_non_blocking_error":
      return {
        borderClass: "border-l-red border-red/30",
        badgeClass: "bg-red/15 text-red hover:bg-red/20",
      }
    case "hook_success":
      return {
        borderClass: "border-l-green border-green/30",
        badgeClass: "bg-green/15 text-green hover:bg-green/20",
      }
    case "hook_additional_context":
      return {
        borderClass: "border-l-cyan border-cyan/30",
        badgeClass: "bg-cyan/15 text-cyan hover:bg-cyan/20",
      }
    case "file":
      return {
        borderClass: "border-l-blue border-blue/30",
        badgeClass: "bg-blue/15 text-blue hover:bg-blue/20",
      }
    case "diagnostics": {
      const hasErrors = att.files?.some((f) =>
        f.diagnostics.some((d) => d.severity === "Error")
      )
      return hasErrors
        ? {
            borderClass: "border-l-red border-red/30",
            badgeClass: "bg-red/15 text-red hover:bg-red/20",
          }
        : {
            borderClass: "border-l-yellow border-yellow/30",
            badgeClass: "bg-yellow/15 text-yellow hover:bg-yellow/20",
          }
    }
    case "deferred_tools_delta":
    case "mcp_instructions_delta":
      return {
        borderClass: "border-l-purple border-purple/30",
        badgeClass: "bg-purple/15 text-purple hover:bg-purple/20",
      }
    case "nested_memory":
      return {
        borderClass: "border-l-orange border-orange/30",
        badgeClass: "bg-orange/15 text-orange hover:bg-orange/20",
      }
    case "skill_listing":
      return {
        borderClass: "border-l-cyan border-cyan/30",
        badgeClass: "bg-cyan/15 text-cyan hover:bg-cyan/20",
      }
    case "command_permissions":
      return {
        borderClass: "border-l-yellow border-yellow/30",
        badgeClass: "bg-yellow/15 text-yellow hover:bg-yellow/20",
      }
    default:
      return {
        borderClass: "border-l-gray border-border",
        badgeClass: "bg-secondary text-muted-foreground",
      }
  }
}

export function AttachmentBlock({
  id,
  attachment: att,
  time,
}: {
  id: string
  attachment: Attachment
  time: string
}) {
  const tr = useT()
  const [open, setOpen] = useState(false)
  const t = att.type
  const { borderClass, badgeClass } = getAttachmentStyle(t, att)

  const hasDetail =
    t === "hook_non_blocking_error" ||
    t === "hook_success" ||
    t === "hook_additional_context" ||
    t === "diagnostics" ||
    t === "deferred_tools_delta" ||
    t === "mcp_instructions_delta" ||
    t === "nested_memory" ||
    t === "skill_listing" ||
    t === "command_permissions"

  const renderSummary = () => {
    switch (t) {
      case "hook_non_blocking_error":
      case "hook_success":
      case "hook_additional_context":
        return (
          <>
            {att.hookName && (
              <span className="font-mono text-[11px] text-muted-foreground">
                {att.hookName}
              </span>
            )}
            {att.exitCode !== undefined && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  att.exitCode !== 0
                    ? "border-red/30 bg-red/10 text-red"
                    : "border-green/30 bg-green/10 text-green"
                )}
              >
                exit: {att.exitCode}
              </Badge>
            )}
            {att.durationMs !== undefined && (
              <Badge
                variant="outline"
                className="border-yellow/30 bg-yellow/10 text-[10px] text-yellow"
              >
                {att.durationMs}ms
              </Badge>
            )}
          </>
        )
      case "file":
        return (
          <span className="font-mono text-[11px] break-all text-muted-foreground">
            {att.displayPath || att.filename || ""}
          </span>
        )
      case "diagnostics": {
        const totalDiags =
          att.files?.reduce((sum, f) => sum + f.diagnostics.length, 0) || 0
        return (
          <>
            <Badge variant="outline" className="border-border text-[10px]">
              {totalDiags}
            </Badge>
            {att.isNew && (
              <Badge
                variant="outline"
                className="border-orange/30 bg-orange/10 text-[10px] text-orange"
              >
                {tr("badge.new")}
              </Badge>
            )}
          </>
        )
      }
      case "deferred_tools_delta":
        return (
          <>
            {att.addedNames && att.addedNames.length > 0 && (
              <Badge
                variant="outline"
                className="border-green/30 bg-green/10 text-[10px] text-green"
              >
                +{att.addedNames.length}
              </Badge>
            )}
            {att.removedNames && att.removedNames.length > 0 && (
              <Badge
                variant="outline"
                className="border-red/30 bg-red/10 text-[10px] text-red"
              >
                -{att.removedNames.length}
              </Badge>
            )}
          </>
        )
      case "mcp_instructions_delta":
        return att.addedNames ? (
          <span className="text-[11px] text-muted-foreground">
            {att.addedNames.join(", ")}
          </span>
        ) : null
      case "nested_memory":
        return (
          <span className="font-mono text-[11px] break-all text-muted-foreground">
            {att.displayPath || att.path?.split("/").slice(-2).join("/") || ""}
          </span>
        )
      case "skill_listing":
        return att.skillCount ? (
          <Badge variant="outline" className="border-border text-[10px]">
            {att.skillCount}
          </Badge>
        ) : null
      case "command_permissions":
        return (
          <>
            {att.model && (
              <Badge
                variant="outline"
                className="border-border font-mono text-[10px]"
              >
                {att.model}
              </Badge>
            )}
            {att.allowedTools && att.allowedTools.length > 0 && (
              <Badge
                variant="outline"
                className="border-yellow/30 bg-yellow/10 text-[10px] text-yellow"
              >
                {att.allowedTools.length} tools
              </Badge>
            )}
          </>
        )
      default:
        return null
    }
  }

  const renderDetail = () => {
    switch (t) {
      case "hook_non_blocking_error":
      case "hook_success": {
        const output = att.stderr || att.stdout || ""
        return (
          <>
            {att.command && (
              <div className="mb-1.5 font-mono text-xs text-muted-foreground">
                $ {att.command}
              </div>
            )}
            {output && (
              <pre className="max-h-[300px] overflow-y-auto rounded-md bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap">
                {output}
              </pre>
            )}
          </>
        )
      }
      case "hook_additional_context": {
        const contextContent = Array.isArray(att.content)
          ? att.content.join("\n")
          : typeof att.content === "string"
            ? att.content
            : ""
        return (
          <>
            {att.command && (
              <div className="mb-1.5 font-mono text-xs text-muted-foreground">
                $ {att.command}
              </div>
            )}
            {contextContent && (
              <div className="text-xs whitespace-pre-wrap text-muted-foreground">
                {contextContent}
              </div>
            )}
          </>
        )
      }
      case "diagnostics":
        return att.files?.map((file, fi) => (
          <div key={fi} className="mb-2">
            <div className="mb-1 font-mono text-[11px] text-muted-foreground">
              {file.uri.split("/").slice(-2).join("/")}
            </div>
            <div className="space-y-1">
              {file.diagnostics.map((d, di) => (
                <div
                  key={di}
                  className={cn(
                    "rounded px-2 py-1 font-mono text-xs",
                    d.severity === "Error"
                      ? "bg-red/10 text-red"
                      : "bg-yellow/10 text-yellow"
                  )}
                >
                  <span className="text-[10px] opacity-70">
                    L{d.range.start.line + 1}:{d.range.start.character}
                  </span>{" "}
                  {d.message}
                  {d.source && (
                    <span className="ml-1 text-[10px] opacity-50">
                      [{d.source}
                      {d.code ? `: ${d.code}` : ""}]
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))
      case "deferred_tools_delta":
        return (
          <div className="max-h-[200px] space-y-0.5 overflow-y-auto font-mono text-xs text-muted-foreground">
            {att.addedNames?.map((name, i) => (
              <div key={i} className="text-green">
                + {name}
              </div>
            ))}
            {att.removedNames?.map((name, i) => (
              <div key={i} className="text-red">
                - {name}
              </div>
            ))}
          </div>
        )
      case "mcp_instructions_delta":
        return att.addedBlocks ? (
          <pre className="max-h-[300px] overflow-y-auto rounded-md bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {att.addedBlocks.join("\n\n")}
          </pre>
        ) : null
      case "nested_memory":
        return att.rawContent ? (
          <pre className="max-h-[300px] overflow-y-auto rounded-md bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {att.rawContent}
          </pre>
        ) : null
      case "skill_listing": {
        const skillContent = Array.isArray(att.content)
          ? att.content.join("\n")
          : typeof att.content === "string"
            ? att.content
            : ""
        return skillContent ? (
          <pre className="max-h-[300px] overflow-y-auto rounded-md bg-background p-2 font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
            {skillContent}
          </pre>
        ) : null
      }
      case "command_permissions":
        return (
          <div className="space-y-2">
            {att.model && (
              <div className="text-xs">
                <span className="text-muted-foreground">model: </span>
                <span className="font-mono">{att.model}</span>
              </div>
            )}
            {att.allowedTools && att.allowedTools.length > 0 && (
              <div>
                <div className="mb-1 text-[10px] text-muted-foreground">
                  allowedTools
                </div>
                <div className="flex flex-wrap gap-1">
                  {att.allowedTools.map((name, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-yellow/30 bg-yellow/10 font-mono text-[10px] text-yellow"
                    >
                      {name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div
      id={id}
      className={cn(
        "rounded-xl border border-l-[3px] bg-card p-4",
        borderClass
      )}
    >
      <div className="mb-0 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Badge className={cn("shrink-0 text-[11px]", badgeClass)}>
            Attachment
          </Badge>
          {renderSummary()}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{time}</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            {t}
          </span>
          {hasDetail && (
            <button
              onClick={() => setOpen(!open)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  open && "rotate-90"
                )}
              />
            </button>
          )}
        </div>
      </div>
      {open && hasDetail && <div className="mt-2">{renderDetail()}</div>}
    </div>
  )
}
