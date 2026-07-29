import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { ChevronRight } from "lucide-react"
import { getToolIcon } from "../helpers"
import { cn } from "@/lib/utils"
import { CollapsibleSection } from "./MessageParts"
import { SubagentMessages } from "./SubagentMessages"
import { WorkflowMessages } from "./WorkflowMessages"
import type {
  Message,
  ContentBlock,
  SubagentInfo,
  SubagentMap,
  WorkflowMap,
  WorkflowInfo,
  MessageFilters,
} from "../types"
import { useT } from "../i18n-context"

// Resolve the workflow launched by this Workflow tool_use. Prefer an explicit
// toolUseId link from the server; otherwise fall back to scanning the tool
// result text for the run id (wf_...).
function findWorkflow(
  block: ContentBlock,
  workflows: WorkflowMap | undefined,
  toolResults: ContentBlock[]
): WorkflowInfo | undefined {
  if (!workflows || block.name !== "Workflow") return undefined
  const list = Object.values(workflows)
  const byToolUse = list.find((w) => w.toolUseId && w.toolUseId === block.id)
  if (byToolUse) return byToolUse
  const resultText = toolResults.map((r) => r.text || "").join("\n")
  return list.find((w) => resultText.includes(w.id))
}

function findToolResults(
  toolUseId: string | undefined,
  allMessages?: Message[]
): ContentBlock[] {
  if (!toolUseId || !allMessages) return []
  const results: ContentBlock[] = []
  for (const m of allMessages) {
    if (m.type === "tool_result" && m.tool_use_id === toolUseId) {
      const c = m.content
      if (typeof c === "string") {
        results.push({ type: "text", text: c })
      } else if (Array.isArray(c)) {
        results.push(...c)
      }
    }
    if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message!.content as ContentBlock[]) {
        if (b.type === "tool_result" && b.tool_use_id === toolUseId) {
          const inner = b.content
          if (typeof inner === "string") {
            results.push({ type: "text", text: inner })
          } else if (Array.isArray(inner)) {
            results.push(...inner)
          }
        }
      }
    }
  }
  return results
}

export function ToolUseBlock({
  block,
  subagentInfo,
  subagents,
  workflows,
  allMessages,
  autoExpand,
  filters,
}: {
  block: ContentBlock
  subagentInfo?: SubagentInfo
  subagents?: SubagentMap
  workflows?: WorkflowMap
  allMessages?: Message[]
  autoExpand?: boolean
  filters?: MessageFilters
}) {
  const t = useT()
  const [open, setOpen] = useState(!!autoExpand)
  const icon = getToolIcon(block.name || "")
  const inputStr = JSON.stringify(block.input, null, 2)
  const toolResults = findToolResults(block.id, allMessages)
  const workflowInfo = findWorkflow(block, workflows, toolResults)

  return (
    <div
      className="my-1.5 overflow-hidden rounded-lg border border-border"
      style={{ boxShadow: "rgba(0,0,0,0.05) 0px 4px 24px" }}
    >
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 bg-secondary/50 px-3 py-2 text-sm transition-colors hover:bg-secondary"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            open && "rotate-90"
          )}
        />
        <span>{icon}</span>
        <span className="font-semibold">{block.name}</span>
        {block.name === "Skill" && block.input && (
          <span className="text-xs text-muted-foreground">
            {(block.input as Record<string, unknown>).skill as string}
            {(block.input as Record<string, unknown>).args
              ? ` ${(block.input as Record<string, unknown>).args}`
              : ""}
          </span>
        )}
        {(["Read", "Write", "Edit"] as string[]).includes(block.name || "") &&
          block.input && (
            <span className="text-xs break-all text-muted-foreground">
              {((block.input as Record<string, unknown>).file_path as string) ||
                ""}
            </span>
          )}
        {block.name === "Bash" && block.input && (
          <span className="text-xs break-all text-muted-foreground">
            {
              (
                ((block.input as Record<string, unknown>).command as string) ||
                ""
              ).split("\n")[0]
            }
          </span>
        )}
        {block.name === "Glob" && block.input && (
          <span className="text-xs break-all text-muted-foreground">
            {(block.input as Record<string, unknown>).pattern as string}
          </span>
        )}
        {block.name === "Grep" && block.input && (
          <span className="text-xs break-all text-muted-foreground">
            {(block.input as Record<string, unknown>).pattern as string}
          </span>
        )}
        {block.name === "WebFetch" && block.input && (
          <span className="text-xs break-all text-muted-foreground">
            {((block.input as Record<string, unknown>).url as string) || ""}
          </span>
        )}
        {block.name === "ToolSearch" && block.input && (
          <span className="text-xs break-all text-muted-foreground">
            {((block.input as Record<string, unknown>).query as string) || ""}
          </span>
        )}
        {block.name === "AskUserQuestion" &&
          block.input &&
          (() => {
            const inp = block.input as Record<string, unknown>
            const questions = inp.questions as
              Array<{ question: string }> | undefined
            if (!questions || questions.length === 0) return null
            const first = questions[0].question
            return (
              <span className="text-xs break-all text-muted-foreground">
                {first}
                {questions.length > 1
                  ? ` ${t("tool.moreTemplate").replace("{n}", String(questions.length - 1))}`
                  : ""}
              </span>
            )
          })()}
        {subagentInfo && (
          <Badge
            variant="outline"
            className="border-cyan/30 bg-cyan/10 text-[10px] text-cyan"
          >
            🤖 {subagentInfo.agentType}
          </Badge>
        )}
        {workflowInfo && (
          <Badge
            variant="outline"
            className="border-purple/30 bg-purple/10 text-[10px] text-purple"
          >
            ⚙️ {workflowInfo.agentIds.length} {t("workflow.agentsSuffix")}
          </Badge>
        )}
        <Badge
          variant="outline"
          className="ml-auto border-brand/30 bg-brand/10 text-[10px] text-brand"
        >
          {t("badge.done")}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          ID: {block.id}
        </span>
      </button>
      {open && (
        <>
          <CollapsibleSection label={t("tool.input")} autoExpand={autoExpand}>
            <div className="max-h-[400px] overflow-y-auto">
              <pre className="bg-background px-3 py-2.5 font-mono text-xs break-all whitespace-pre-wrap">
                {inputStr}
              </pre>
            </div>
          </CollapsibleSection>
          {toolResults.length > 0 && (
            <CollapsibleSection
              label={t("tool.results")}
              count={toolResults.length}
              autoExpand={autoExpand}
            >
              <div className="max-h-[400px] overflow-y-auto">
                {toolResults.map((b, j) => (
                  <div key={j}>
                    {j > 0 && <Separator />}
                    <pre className="bg-background px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap">
                      {b.text || `[${b.type}]`}
                    </pre>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          )}
        </>
      )}
      {subagentInfo && (
        <SubagentMessages
          info={subagentInfo}
          autoExpand={autoExpand}
          filters={filters}
        />
      )}
      {workflowInfo && subagents && (
        <WorkflowMessages
          info={workflowInfo}
          subagents={subagents}
          autoExpand={autoExpand}
          filters={filters}
        />
      )}
    </div>
  )
}
