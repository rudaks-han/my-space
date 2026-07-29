import type { Message, ContentBlock, MessageFilters } from "./types"
import { getLang } from "./i18n-context"

function currentLang(): "en" | "ko" {
  return getLang()
}

export function formatTime(ts?: string): string {
  if (!ts) return ""
  const locale = currentLang() === "ko" ? "ko-KR" : "en-US"
  return new Date(ts).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function timeAgo(ts?: string): string {
  if (!ts) return ""
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  const ko = currentLang() === "ko"
  if (mins < 60) return ko ? `${mins}분 전` : `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return ko ? `${hrs}시간 전` : `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return ko ? `${days}일 전` : `${days}d ago`
}

export function truncate(str: string, len = 100): string {
  if (!str) return ""
  return str.length > len ? str.slice(0, len) + "..." : str
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    Read: "📄",
    Edit: "✏️",
    Write: "📝",
    Bash: "💻",
    Grep: "🔍",
    Glob: "📂",
    Agent: "🤖",
    WebSearch: "🌐",
    WebFetch: "🌐",
    Skill: "⚡",
    NotebookEdit: "📓",
  }
  return icons[name] || "🔧"
}

export function getMessageType(msg: Message): string {
  if (msg.type === "user" && !msg.isMeta) return "user"
  if (msg.type === "assistant") {
    const content = msg.message?.content
    if (
      Array.isArray(content) &&
      content.some((c: ContentBlock) => c.type === "tool_use")
    )
      return "tool_use"
    return "assistant"
  }
  if (msg.type === "tool_result") return "tool_result"
  return msg.type
}

export function getContentTypes(msg: Message): Set<string> {
  const types = new Set<string>()
  if (msg.type === "assistant") {
    const content = msg.message?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text) types.add("text")
        if (b.type === "thinking") types.add("thinking")
        if (b.type === "tool_use") types.add("tool_use")
      }
    } else if (typeof content === "string") {
      types.add("text")
    }
  } else if (msg.type === "user") {
    types.add("text")
  } else if (msg.type === "system") {
    types.add("text")
  }
  return types
}

export function getMsgRole(msg: Message): string {
  if (msg.type === "user" && !msg.isMeta) return "user"
  if (msg.type === "assistant") return "assistant"
  if (msg.type === "tool_result") return "assistant"
  if (msg.type === "system") return "system"
  if (msg.type === "attachment") return "attachment"
  return msg.type
}

export function shouldShow(msg: Message, filters: MessageFilters): boolean {
  if (msg.type === "tool_result") return false
  if (msg.type === "user") {
    const c = msg.message?.content
    if (
      Array.isArray(c) &&
      c.length > 0 &&
      c.every((b) => b.type === "tool_result")
    )
      return false
  }

  const allRoles = filters.roles.size === 0
  const allContents = filters.contents.size === 0

  // Role filter
  if (!allRoles) {
    const role = getMsgRole(msg)
    if (!filters.roles.has(role as RoleFilterValue)) return false
  }

  // Content filter
  if (!allContents) {
    if (filters.contents.has("tool_use")) {
      const content = msg.message?.content
      if (!Array.isArray(content)) return false
      const toolUseBlocks = content.filter((b) => b.type === "tool_use")
      if (toolUseBlocks.length === 0) return false
      if (filters.tools.size > 0) {
        const hasAgentBlock = toolUseBlocks.some((b) => b.name === "Agent")
        const match = toolUseBlocks.some((b) => filters.tools.has(b.name || ""))
        if (!match && !hasAgentBlock) return false
      }
    }
  }

  return true
}

type RoleFilterValue = "user" | "assistant" | "system" | "attachment"

export function getMessageText(msg: Message): string {
  if (msg.type === "user") {
    const c = msg.message?.content
    return typeof c === "string" ? c : JSON.stringify(c)
  }
  if (msg.type === "assistant") {
    const content = msg.message?.content
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "text" && b.text) return b.text
        if (b.type === "tool_use") return b.name || ""
      }
    }
    if (typeof content === "string") return content
  }
  if (msg.type === "tool_result")
    return currentLang() === "ko" ? "도구 결과" : "Tool Result"
  if (msg.type === "system")
    return (msg.content as string) || msg.subtype || "system"
  return ""
}
