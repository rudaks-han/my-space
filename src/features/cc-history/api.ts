import { trackedInvoke } from "@/lib/tauri"
import type {
  Project,
  Session,
  Message,
  SubagentMap,
  WorkflowMap,
} from "./types"

// 원본(cc-history-viewer)은 로컬 Hono 서버(/api/*)로 붙었지만, My Space 에서는
// 같은 로직을 Rust 커맨드(cc_history_*)로 포팅해 trackedInvoke 로 호출한다.

export async function checkConnection(): Promise<{
  connected: boolean
  projects: Project[]
}> {
  try {
    const projects = await fetchProjects()
    return { connected: true, projects }
  } catch {
    return { connected: false, projects: [] }
  }
}

export async function fetchProjects(): Promise<Project[]> {
  return trackedInvoke<Project[]>("cc_history_projects")
}

export interface SessionsResponse {
  sessions: Session[]
  total: number
  offset: number
  limit: number
}

export async function fetchSessions(
  projectId: string,
  limit?: number,
  offset?: number
): Promise<SessionsResponse> {
  return trackedInvoke<SessionsResponse>("cc_history_sessions", {
    projectId,
    limit,
    offset,
  })
}

export interface DeltaOffsets {
  messageOffset: number
  subagentOffsets: Record<string, number>
}

export interface FetchMessagesResult {
  messages: Message[]
  totalMessages: number
  subagents: SubagentMap
  workflows: WorkflowMap
}

export async function fetchMessages(
  projectId: string,
  sessionId: string,
  offsets?: DeltaOffsets
): Promise<FetchMessagesResult> {
  const data = await trackedInvoke<FetchMessagesResult>("cc_history_messages", {
    projectId,
    sessionId,
    messageOffset:
      offsets && offsets.messageOffset > 0 ? offsets.messageOffset : undefined,
    subagentOffsets:
      offsets && Object.keys(offsets.subagentOffsets).length > 0
        ? offsets.subagentOffsets
        : undefined,
  })
  return {
    messages: data.messages,
    totalMessages: data.totalMessages ?? data.messages.length,
    subagents: data.subagents ?? {},
    workflows: data.workflows ?? {},
  }
}
