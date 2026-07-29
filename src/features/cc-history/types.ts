export interface Project {
  id: string
  name: string
  path: string
  sessionCount: number
  lastSessionTimestamp?: string
}

export interface Session {
  id: string
  title: string
  messageCount: number
  model: string
  cwd: string
  firstTimestamp: string
  lastTimestamp: string
  modifiedAt: string
}

export interface Attachment {
  type: string
  // hook fields
  hookName?: string
  hookEvent?: string
  toolUseID?: string
  stderr?: string
  stdout?: string
  exitCode?: number
  command?: string
  durationMs?: number
  content?: string | string[]
  // file attachment
  filename?: string
  displayPath?: string
  // deferred_tools_delta
  addedNames?: string[]
  removedNames?: string[]
  // mcp_instructions_delta
  addedBlocks?: string[]
  // nested_memory (rules/CLAUDE.md)
  path?: string
  rawContent?: string
  // skill_listing
  skillCount?: number
  // diagnostics
  files?: DiagnosticFile[]
  isNew?: boolean
  // command_permissions
  allowedTools?: string[]
  model?: string
}

export interface DiagnosticFile {
  uri: string
  diagnostics: DiagnosticItem[]
}

export interface DiagnosticItem {
  message: string
  severity: string
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  source?: string
  code?: string
}

export interface Message {
  type: string
  subtype?: string
  isMeta?: boolean
  isSidechain?: boolean
  uuid?: string
  parentUuid?: string
  timestamp?: string
  content?: string | ContentBlock[]
  attachment?: Attachment
  message?: {
    role: string
    model?: string
    content: string | ContentBlock[]
    usage?: {
      input_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
      output_tokens: number
    }
  }
  tool_use_id?: string
  sessionId?: string
  hookCount?: number
  hookInfos?: HookInfo[]
}

export interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ContentBlock[]
  source?: {
    type: string
    media_type?: string
    data?: string
  }
}

export type RoleFilter = "user" | "assistant" | "system" | "attachment"
export type ContentFilter = "tool_use"

export interface MessageFilters {
  roles: Set<RoleFilter>
  contents: Set<ContentFilter>
  tools: Set<string>
}

export interface HookInfo {
  command: string
  durationMs: number
}

export interface SubagentInfo {
  agentType: string
  description: string
  messages: Message[]
  totalMessages?: number
  workflowId?: string
  result?: unknown
}

export type SubagentMap = Record<string, SubagentInfo>

export interface WorkflowPhase {
  title: string
  detail?: string
}

export interface WorkflowInfo {
  id: string
  name: string
  description: string
  phases: WorkflowPhase[]
  agentIds: string[]
  toolUseId?: string
}

export type WorkflowMap = Record<string, WorkflowInfo>

export interface VisibleItem {
  msg: Message
  key: string
  subagentInfo?: SubagentInfo
}
