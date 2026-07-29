import { createContext, useContext } from "react"

export type Lang = "en" | "ko"

type Dict = Record<string, string>

const EN: Dict = {
  // Connection status
  "status.connected": "Connected",
  "status.disconnected": "Disconnected",

  // Search / index
  "search.messages": "Search messages...",
  "index.open": "Open message index",
  "index.close": "Close message index",
  "index.title": "Messages",
  "index.filter": "Filter messages...",

  // Nav
  "nav.expand": "Expand menu",
  "nav.collapse": "Collapse menu",
  "nav.collapseLabel": "Collapse",

  // Role filters
  "role.user": "User",
  "role.assistant": "Assistant",
  "role.system": "System",
  "role.attachment": "Attachment",
  "content.toolUse": "Tool Use",

  // Tool selector
  "tool.select": "Select Tools",
  "tool.countSuffix": "tools",
  "tool.clearAll": "Clear all",

  // Usage / cost
  "usage.cacheRead": "Cache Read",
  "usage.cacheCreate": "Cache Create",
  "usage.costByModel": "Cost by Model",
  "usage.total": "Total",

  // Stat badges
  "stat.tools": "🔧 Tools",
  "stat.skills": "⚡ Skills",
  "stat.agents": "🤖 Agents",
  "stat.mainSub": "Main (Subagent)",

  // Empty states
  "empty.selectSession": "Please select a session",
  "empty.noMessages": "No messages to display",
  "empty.noData": "No data available",

  // Sidebar
  "sidebar.explorer": "Explorer",
  "sidebar.loading": "Loading...",

  // Live overlay / subagents
  "live.recent": "Recent Messages",
  "live.messagesSuffix": "messages",
  "live.subagentsSuffix": "subagents",

  // Workflow
  "workflow.badge": "Workflow",
  "workflow.agentsSuffix": "agents",
  "workflow.noAgents": "No agent runs recorded yet.",

  // Badges
  "badge.toolResult": "Tool Result",
  "badge.skill": "Skill",
  "badge.new": "New",
  "badge.done": "Done",

  // Attachment
  "attachment.imageAlt": "Attached image",

  // Tool use
  "tool.input": "Input",
  "tool.results": "Tool Results",
  "tool.moreTemplate": "+{n} more",

  // Usage tooltip
  "tooltip.model": "Model",
  "tooltip.time": "Time",
  "tooltip.input": "Input",
  "tooltip.output": "Output",
  "tooltip.cacheCreate": "Cache Create",
  "tooltip.cacheRead": "Cache Read",

  // Time ago
  "time.minAgo": "m ago",
  "time.hourAgo": "h ago",
  "time.dayAgo": "d ago",

  // Language
  "lang.label": "Language",
}

const KO: Dict = {
  "status.connected": "연결됨",
  "status.disconnected": "연결 안됨",

  "search.messages": "메시지 검색...",
  "index.open": "메시지 인덱스 열기",
  "index.close": "메시지 인덱스 닫기",
  "index.title": "메시지",
  "index.filter": "메시지 필터...",

  "nav.expand": "메뉴 펼치기",
  "nav.collapse": "메뉴 접기",
  "nav.collapseLabel": "접기",

  "role.user": "사용자",
  "role.assistant": "어시스턴트",
  "role.system": "시스템",
  "role.attachment": "첨부",
  "content.toolUse": "도구호출",

  "tool.select": "도구 선택",
  "tool.countSuffix": "개 도구",
  "tool.clearAll": "모두 해제",

  "usage.cacheRead": "캐시읽기",
  "usage.cacheCreate": "캐시쓰기",
  "usage.costByModel": "모델별 비용",
  "usage.total": "합계",

  "stat.tools": "🔧 도구",
  "stat.skills": "⚡ 스킬",
  "stat.agents": "🤖 에이전트",
  "stat.mainSub": "메인 (서브에이전트)",

  "empty.selectSession": "세션을 선택해주세요",
  "empty.noMessages": "표시할 메시지가 없습니다",
  "empty.noData": "데이터가 없습니다",

  "sidebar.explorer": "탐색기",
  "sidebar.loading": "로딩중...",

  "live.recent": "최근 메시지",
  "live.messagesSuffix": "개 메시지",
  "live.subagentsSuffix": "개 서브에이전트",

  // Workflow
  "workflow.badge": "워크플로우",
  "workflow.agentsSuffix": "개 에이전트",
  "workflow.noAgents": "아직 기록된 에이전트 실행이 없습니다.",

  "badge.toolResult": "도구 결과",
  "badge.skill": "스킬",
  "badge.new": "신규",
  "badge.done": "완료",

  "attachment.imageAlt": "첨부 이미지",

  "tool.input": "입력",
  "tool.results": "도구 실행 결과",
  "tool.moreTemplate": "외 {n}건",

  "tooltip.model": "모델",
  "tooltip.time": "시간",
  "tooltip.input": "입력",
  "tooltip.output": "출력",
  "tooltip.cacheCreate": "캐시 생성",
  "tooltip.cacheRead": "캐시 읽기",

  "time.minAgo": "분 전",
  "time.hourAgo": "시간 전",
  "time.dayAgo": "일 전",

  "lang.label": "언어",
}

export const DICTS: Record<Lang, Dict> = { en: EN, ko: KO }
export { EN }

export interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: keyof typeof EN) => string
}

export const I18nContext = createContext<I18nContextValue | null>(null)

export const STORAGE_KEY = "myspace.ccHistory.lang"

/** localStorage 에서 현재 언어를 읽는다(기본 한국어). helpers 등 컴포넌트 밖에서도 사용. */
export function getLang(): Lang {
  if (typeof window === "undefined") return "ko"
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === "en" ? "en" : "ko"
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error("useI18n must be used within I18nProvider")
  return ctx
}

export function useT() {
  return useI18n().t
}

export function getLocale(lang: Lang): string {
  return lang === "ko" ? "ko-KR" : "en-US"
}
