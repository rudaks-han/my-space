import { Badge } from "@/components/ui/badge"
import { Workflow as WorkflowIcon } from "lucide-react"
import { SubagentMessages } from "./SubagentMessages"
import type { WorkflowInfo, SubagentMap, MessageFilters } from "../types"
import { useT } from "../i18n-context"

export function WorkflowMessages({
  info,
  subagents,
  autoExpand,
  filters,
}: {
  info: WorkflowInfo
  subagents: SubagentMap
  autoExpand?: boolean
  filters?: MessageFilters
}) {
  const t = useT()
  const agents = info.agentIds
    .map((id) => ({ id, sub: subagents[id] }))
    .filter((a) => a.sub)

  return (
    <div className="border-t border-border bg-purple/5">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <WorkflowIcon className="h-3.5 w-3.5 text-purple" />
        <Badge
          variant="outline"
          className="border-purple/30 bg-purple/10 text-[10px] text-purple"
        >
          {t("workflow.badge")}
        </Badge>
        <span className="text-xs font-semibold">{info.name}</span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {agents.length} {t("workflow.agentsSuffix")}
        </span>
      </div>
      {info.description && (
        <p className="px-3 pt-2 text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
          {info.description}
        </p>
      )}
      {info.phases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2">
          {info.phases.map((p, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && (
                <span className="text-[10px] text-muted-foreground">→</span>
              )}
              <Badge
                variant="outline"
                className="border-border bg-secondary/50 text-[10px]"
                title={p.detail}
              >
                {p.title}
              </Badge>
            </span>
          ))}
        </div>
      )}
      <div>
        {agents.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("workflow.noAgents")}
          </p>
        ) : (
          agents.map(({ id, sub }) => (
            <SubagentMessages
              key={id}
              info={sub!}
              autoExpand={autoExpand}
              filters={filters}
            />
          ))
        )}
      </div>
    </div>
  )
}
