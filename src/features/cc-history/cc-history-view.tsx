import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useTabActive } from "@/lib/use-tab-active"
import { Sidebar } from "./components/Sidebar"
import { MessageBlock } from "./components/MessageBlock"
import { MessageIndex } from "./components/MessageIndex"
import { LiveOverlay } from "./components/LiveOverlay"
import { StatBadge } from "./components/StatBadge"
import { LanguageSelector } from "./components/LanguageSelector"
import { fetchMessages, checkConnection, type DeltaOffsets } from "./api"
import { shouldShow, getToolIcon } from "./helpers"
import { I18nProvider } from "./i18n"
import { useT } from "./i18n-context"
import type {
  Project,
  Session,
  Message,
  MessageFilters,
  RoleFilter,
  ContentFilter,
  SubagentMap,
  WorkflowMap,
  VisibleItem,
  ContentBlock,
} from "./types"
import { Separator } from "@/components/ui/separator"
import {
  Search,
  PanelRightClose,
  PanelRightOpen,
  Radio,
  ChevronDown,
} from "lucide-react"

// Anthropic pricing per million tokens (USD)
// Source: https://www.anthropic.com/pricing
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-opus-4": {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
  "claude-sonnet-4": {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4": {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
}

type ModelFamily = "opus" | "sonnet" | "haiku" | "other"
function getModelFamily(model: string | undefined): ModelFamily {
  if (!model) return "other"
  const m = model.toLowerCase()
  if (m.includes("opus")) return "opus"
  if (m.includes("sonnet")) return "sonnet"
  if (m.includes("haiku")) return "haiku"
  return "other"
}

const MODEL_FAMILY_PRICING: Record<
  ModelFamily,
  (typeof MODEL_PRICING)[string]
> = {
  opus: MODEL_PRICING["claude-opus-4"],
  sonnet: MODEL_PRICING["claude-sonnet-4"],
  haiku: MODEL_PRICING["claude-haiku-4"],
  other: MODEL_PRICING["claude-sonnet-4"],
}

function CcHistoryInner() {
  const t = useT()
  const tabActive = useTabActive()
  const ROLE_FILTERS: { label: string; value: RoleFilter }[] = [
    { label: t("role.user"), value: "user" },
    { label: t("role.assistant"), value: "assistant" },
    { label: t("role.system"), value: "system" },
    { label: t("role.attachment"), value: "attachment" },
  ]
  const CONTENT_FILTERS: { label: string; value: ContentFilter }[] = [
    { label: t("content.toolUse"), value: "tool_use" },
  ]
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null
  )
  const [selected, setSelected] = useState<{
    project: Project
    session: Session
  } | null>(null)
  const currentSession = selected?.session ?? null
  const [messages, setMessages] = useState<Message[]>([])
  const [subagents, setSubagents] = useState<SubagentMap>({})
  const [workflows, setWorkflows] = useState<WorkflowMap>({})
  const [filters, setFilters] = useState<MessageFilters>({
    roles: new Set(),
    contents: new Set(),
    tools: new Set(),
  })
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const toolsMenuRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState("")
  const [connected, setConnected] = useState(false)
  const [showIndex, setShowIndex] = useState(
    () => localStorage.getItem("myspace.ccHistory.showIndex") === "true"
  )
  const [showLive, setShowLive] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(288)
  const [indexWidth, setIndexWidth] = useState(300)
  const scrollRef = useRef<HTMLDivElement>(null)
  const wasAtBottomRef = useRef(true)
  const draggingRef = useRef<"sidebar" | "index" | null>(null)
  const deltaOffsetsRef = useRef<DeltaOffsets>({
    messageOffset: 0,
    subagentOffsets: {},
  })

  const handleMouseDown = useCallback(
    (panel: "sidebar" | "index") => (e: ReactMouseEvent) => {
      e.preventDefault()
      draggingRef.current = panel
      const startX = e.clientX
      const startWidth = panel === "sidebar" ? sidebarWidth : indexWidth

      const onMouseMove = (ev: globalThis.MouseEvent) => {
        const delta =
          panel === "sidebar" ? ev.clientX - startX : startX - ev.clientX
        const newWidth = Math.max(150, Math.min(600, startWidth + delta))
        if (panel === "sidebar") setSidebarWidth(newWidth)
        else setIndexWidth(newWidth)
      }

      const onMouseUp = () => {
        draggingRef.current = null
        document.removeEventListener("mousemove", onMouseMove)
        document.removeEventListener("mouseup", onMouseUp)
        document.body.style.cursor = ""
        document.body.style.userSelect = ""
      }

      document.body.style.cursor = "col-resize"
      document.body.style.userSelect = "none"
      document.addEventListener("mousemove", onMouseMove)
      document.addEventListener("mouseup", onMouseUp)
    },
    [sidebarWidth, indexWidth]
  )

  // 프로젝트 목록 조회(원본의 checkConnection). 최신 순 정렬 후 변경 시에만 갱신.
  const poll = useCallback(() => {
    return checkConnection().then(({ connected: ok, projects: data }) => {
      setConnected(ok)
      if (ok) {
        data.sort((a, b) => {
          const at = a.lastSessionTimestamp
            ? new Date(a.lastSessionTimestamp).getTime()
            : 0
          const bt = b.lastSessionTimestamp
            ? new Date(b.lastSessionTimestamp).getTime()
            : 0
          return bt - at
        })
        setProjects((prev) => {
          const next = JSON.stringify(data)
          return JSON.stringify(prev) === next ? prev : data
        })
      }
    })
  }, [])

  // 최초 1회 로드.
  useEffect(() => {
    poll()
  }, [poll])

  // 주기 새로고침은 탭이 활성일 때만(keep-alive 규칙).
  useEffect(() => {
    if (!tabActive) return
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [tabActive, poll])

  useEffect(() => {
    if (!selectedProjectId || projects.length === 0) return
    if (!projects.find((p) => p.id === selectedProjectId)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 폴링으로 갱신된 목록에서 선택 프로젝트가 사라지면 선택을 해제(외부 상태 동기화).
      setSelectedProjectId(null)
    }
  }, [projects, selectedProjectId])

  const isScrolledToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const loadMessages = useCallback(
    async (project: Project, session: Session, isInitial: boolean) => {
      try {
        const offsets = isInitial ? undefined : deltaOffsetsRef.current
        const {
          messages: data,
          totalMessages,
          subagents: subs,
          workflows: wfs,
        } = await fetchMessages(project.id, session.id, offsets)

        if (isInitial) {
          setMessages(data)
          setSubagents(subs)
          setWorkflows(wfs)
          deltaOffsetsRef.current = {
            messageOffset: totalMessages,
            subagentOffsets: Object.fromEntries(
              Object.entries(subs).map(([id, s]) => [
                id,
                s.totalMessages ?? s.messages.length,
              ])
            ),
          }
        } else {
          if (data.length > 0) {
            setMessages((prev) => [...prev, ...data])
          }
          if (Object.keys(wfs).length > 0) {
            setWorkflows((prev) => {
              const next = JSON.stringify(wfs)
              return JSON.stringify(prev) === next ? prev : wfs
            })
          }
          if (Object.keys(subs).length > 0) {
            setSubagents((prev) => {
              const next = { ...prev }
              for (const [id, sub] of Object.entries(subs)) {
                if (next[id]) {
                  next[id] = {
                    ...next[id],
                    messages: [...next[id].messages, ...sub.messages],
                  }
                } else {
                  next[id] = sub
                }
              }
              return next
            })
          }
          deltaOffsetsRef.current = {
            messageOffset: deltaOffsetsRef.current.messageOffset + data.length,
            subagentOffsets: {
              ...deltaOffsetsRef.current.subagentOffsets,
              ...Object.fromEntries(
                Object.entries(subs).map(([id, s]) => [
                  id,
                  s.totalMessages ??
                    (deltaOffsetsRef.current.subagentOffsets[id] || 0) +
                      s.messages.length,
                ])
              ),
            },
          }
        }

        if (isInitial || wasAtBottomRef.current) {
          setTimeout(scrollToBottom, 50)
        }
      } catch {
        if (isInitial) setMessages([])
      }
    },
    [scrollToBottom]
  )

  const selectSession = useCallback(
    (project: Project, session: Session) => {
      setSelectedProjectId(project.id)
      setSelected({ project, session })
      setMessages([])
      setSubagents({})
      setWorkflows({})
      deltaOffsetsRef.current = { messageOffset: 0, subagentOffsets: {} }
      loadMessages(project, session, true)
    },
    [loadMessages]
  )

  // 선택된 세션의 델타 폴링은 탭 활성일 때만 돈다.
  useEffect(() => {
    if (!selected || !tabActive) return
    const { project, session } = selected
    const id = setInterval(() => {
      wasAtBottomRef.current = isScrolledToBottom()
      loadMessages(project, session, false)
    }, 2000)
    return () => clearInterval(id)
  }, [selected, tabActive, loadMessages, isScrolledToBottom])

  const toggleRole = (value: RoleFilter) => {
    setFilters((prev) => {
      const next = new Set(prev.roles)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return { ...prev, roles: next }
    })
  }

  const toggleContent = (value: ContentFilter) => {
    setFilters((prev) => {
      const next = new Set(prev.contents)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      const tools = next.has("tool_use") ? prev.tools : new Set<string>()
      return { ...prev, contents: next, tools }
    })
  }

  const toggleTool = (name: string) => {
    setFilters((prev) => {
      const next = new Set(prev.tools)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return { ...prev, tools: next }
    })
  }

  useEffect(() => {
    if (!toolsMenuOpen) return
    const onClick = (e: globalThis.MouseEvent) => {
      if (
        toolsMenuRef.current &&
        !toolsMenuRef.current.contains(e.target as Node)
      ) {
        setToolsMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [toolsMenuOpen])

  const availableTools = (() => {
    const names = new Set<string>()
    const collect = (msgs: Message[]) => {
      for (const msg of msgs) {
        if (msg.type !== "assistant" || !Array.isArray(msg.message?.content))
          continue
        for (const b of msg.message!.content as ContentBlock[]) {
          if (b.type === "tool_use" && b.name) names.add(b.name)
        }
      }
    }
    collect(messages)
    for (const sub of Object.values(subagents)) collect(sub.messages)
    return Array.from(names).sort()
  })()

  const visibleMessages: VisibleItem[] = messages
    .map((msg, i) => ({ msg, key: `m-${i}` }))
    .filter(({ msg }) => msg.isSidechain === false && shouldShow(msg, filters))

  const { totalUsage, usageByFamily } = (() => {
    // Subagent messages are written to both the main JSONL and subagents/<id>.jsonl,
    // so dedupe by uuid before summing to avoid inflated totals.
    const seen = new Set<string>()
    const allMessages = [
      ...messages,
      ...Object.values(subagents).flatMap((s) => s.messages),
    ].filter((m) => {
      if (!m.uuid) return true
      if (seen.has(m.uuid)) return false
      seen.add(m.uuid)
      return true
    })
    const empty = () => ({ input: 0, output: 0, cacheCreate: 0, cacheRead: 0 })
    const byFamily: Record<ModelFamily, ReturnType<typeof empty>> = {
      opus: empty(),
      sonnet: empty(),
      haiku: empty(),
      other: empty(),
    }
    const total = empty()
    for (const msg of allMessages) {
      const u = msg.message?.usage
      if (!u) continue
      const fam = getModelFamily(msg.message?.model)
      const bucket = byFamily[fam]
      bucket.input += u.input_tokens
      bucket.output += u.output_tokens
      bucket.cacheCreate += u.cache_creation_input_tokens || 0
      bucket.cacheRead += u.cache_read_input_tokens || 0
      total.input += u.input_tokens
      total.output += u.output_tokens
      total.cacheCreate += u.cache_creation_input_tokens || 0
      total.cacheRead += u.cache_read_input_tokens || 0
    }
    return { totalUsage: total, usageByFamily: byFamily }
  })()

  const costByFamily: {
    family: ModelFamily
    cost: number
    usage: typeof totalUsage
  }[] = (["opus", "sonnet", "haiku", "other"] as ModelFamily[])
    .map((fam) => {
      const usage = usageByFamily[fam]
      const p = MODEL_FAMILY_PRICING[fam]
      const cost =
        (usage.input * p.input +
          usage.output * p.output +
          usage.cacheCreate * p.cacheWrite +
          usage.cacheRead * p.cacheRead) /
        1_000_000
      return { family: fam, cost, usage }
    })
    .filter(
      (r) =>
        r.usage.input +
          r.usage.output +
          r.usage.cacheCreate +
          r.usage.cacheRead >
        0
    )
  const totalCost = costByFamily.reduce((s, r) => s + r.cost, 0)

  const toolStats = (() => {
    const mainToolMap: Record<string, number> = {}
    const mainSkillMap: Record<string, number> = {}
    const subToolMap: Record<string, number> = {}
    const subSkillMap: Record<string, number> = {}
    const agentMap: Record<string, number> = {}
    const countMessages = (msgs: Message[], isSubagent: boolean) => {
      for (const msg of msgs) {
        if (msg.type !== "assistant" || !Array.isArray(msg.message?.content))
          continue
        for (const block of msg.message!.content as {
          type: string
          name?: string
          input?: Record<string, unknown>
        }[]) {
          if (block.type !== "tool_use") continue
          if (block.name === "Skill") {
            const key = (block.input?.skill as string) || "unknown"
            const map = isSubagent ? subSkillMap : mainSkillMap
            map[key] = (map[key] || 0) + 1
          } else if (block.name === "Agent") {
            const key =
              (block.input?.subagent_type as string) || "general-purpose"
            agentMap[key] = (agentMap[key] || 0) + 1
          } else {
            const key = block.name || "unknown"
            const map = isSubagent ? subToolMap : mainToolMap
            map[key] = (map[key] || 0) + 1
          }
        }
      }
    }
    countMessages(messages, false)
    for (const sub of Object.values(subagents)) {
      countMessages(sub.messages, true)
    }
    // Workflow-run agents are launched via the Workflow tool, not the Agent
    // tool, so count them here from the subagent map instead.
    for (const sub of Object.values(subagents)) {
      if (!sub.workflowId) continue
      const key = sub.agentType || "workflow-agent"
      agentMap[key] = (agentMap[key] || 0) + 1
    }
    const sum = (m: Record<string, number>) =>
      Object.values(m).reduce((a, b) => a + b, 0)
    return {
      tools: sum(mainToolMap) + sum(subToolMap),
      skills: sum(mainSkillMap) + sum(subSkillMap),
      agents: sum(agentMap),
      mainToolMap,
      subToolMap,
      mainSkillMap,
      subSkillMap,
      agentMap,
    }
  })()

  const searchedMessages = search
    ? visibleMessages.filter(({ msg }) => {
        const c = msg.message?.content ?? msg.content
        const text = typeof c === "string" ? c : JSON.stringify(c)
        return text?.toLowerCase().includes(search.toLowerCase())
      })
    : visibleMessages

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-background text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {/* Toolbar */}
      <header className="flex min-h-[44px] shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
              connected ? "bg-green/15 text-green" : "bg-red/15 text-red"
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-green" : "bg-red"
              )}
            />
            {connected ? t("status.connected") : t("status.disconnected")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("search.messages")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-60 pl-8 text-xs"
            />
          </div>
          <button
            onClick={() =>
              setShowIndex((v) => {
                localStorage.setItem("myspace.ccHistory.showIndex", String(!v))
                return !v
              })
            }
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border transition-colors hover:bg-accent"
            title={showIndex ? t("index.close") : t("index.open")}
          >
            {showIndex ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
          <LanguageSelector />
        </div>
      </header>

      {/* Main */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar
          projects={projects}
          onSelectSession={selectSession}
          activeSessionId={currentSession?.id}
          style={{ width: sidebarWidth, minWidth: 150, flexShrink: 0 }}
          initialOpenProjectId={selectedProjectId}
          onProjectToggle={setSelectedProjectId}
        />
        <div
          className="w-1 flex-shrink-0 cursor-col-resize transition-colors hover:bg-brand/30 active:bg-brand/50"
          onMouseDown={handleMouseDown("sidebar")}
        />

        {/* Center: Messages */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-1 border-b border-border bg-card px-4 py-2">
            {ROLE_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => toggleRole(f.value)}
                className={cn(
                  "rounded-md border px-3 py-1 text-xs transition-colors",
                  filters.roles.has(f.value)
                    ? "border-brand bg-brand text-white"
                    : "border-border bg-transparent text-muted-foreground hover:bg-accent"
                )}
              >
                {f.label}
              </button>
            ))}
            <Separator orientation="vertical" className="mx-1 h-5" />
            {CONTENT_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => toggleContent(f.value)}
                className={cn(
                  "rounded-md border px-3 py-1 text-xs transition-colors",
                  filters.contents.has(f.value)
                    ? "border-brand bg-brand text-white"
                    : "border-border bg-transparent text-muted-foreground hover:bg-accent"
                )}
              >
                {f.label}
              </button>
            ))}
            {filters.contents.has("tool_use") && availableTools.length > 0 && (
              <div ref={toolsMenuRef} className="relative">
                <button
                  onClick={() => setToolsMenuOpen((v) => !v)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs transition-colors",
                    filters.tools.size > 0
                      ? "border-brand/40 bg-brand/15 text-brand"
                      : "border-border bg-transparent text-muted-foreground hover:bg-accent"
                  )}
                >
                  <span>{t("tool.select")}</span>
                  {filters.tools.size > 0 && (
                    <span className="text-[10px] font-medium">
                      ({filters.tools.size})
                    </span>
                  )}
                  <ChevronDown
                    className={cn(
                      "h-3 w-3 transition-transform",
                      toolsMenuOpen && "rotate-180"
                    )}
                  />
                </button>
                {toolsMenuOpen && (
                  <div className="absolute top-full left-0 z-50 mt-1 max-h-[320px] min-w-[200px] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md">
                    <div className="mb-1 flex items-center justify-between border-b border-border px-2 py-1">
                      <span className="text-[10px] text-muted-foreground">
                        {availableTools.length} {t("tool.countSuffix")}
                      </span>
                      {filters.tools.size > 0 && (
                        <button
                          onClick={() =>
                            setFilters((prev) => ({
                              ...prev,
                              tools: new Set(),
                            }))
                          }
                          className="text-[10px] text-brand hover:underline"
                        >
                          {t("tool.clearAll")}
                        </button>
                      )}
                    </div>
                    {availableTools.map((name) => (
                      <label
                        key={name}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent"
                      >
                        <input
                          type="checkbox"
                          checked={filters.tools.has(name)}
                          onChange={() => toggleTool(name)}
                          className="accent-brand"
                        />
                        <span>{getToolIcon(name)}</span>
                        <span className="break-all">{name}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
            <Badge variant="outline" className="ml-2 text-[10px]">
              {searchedMessages.length}
            </Badge>
            <div className="ml-auto">
              <button
                onClick={() => setShowLive((v) => !v)}
                disabled={!currentSession}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium transition-colors",
                  showLive
                    ? "border-red bg-red text-white"
                    : "border-border bg-transparent text-muted-foreground hover:bg-accent",
                  !currentSession && "cursor-not-allowed opacity-50"
                )}
              >
                <Radio className="h-3 w-3" />
                Live
              </button>
            </div>
          </div>

          {currentSession && totalUsage.input + totalUsage.output > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-card px-4 py-1.5">
              <Badge
                variant="outline"
                className="border-blue/30 bg-blue/10 text-[10px] text-blue"
              >
                IN {totalUsage.input.toLocaleString()}
              </Badge>
              <Badge
                variant="outline"
                className="border-orange/30 bg-orange/10 text-[10px] text-orange"
              >
                OUT {totalUsage.output.toLocaleString()}
              </Badge>
              {totalUsage.cacheRead > 0 && (
                <Badge
                  variant="outline"
                  className="border-green/30 bg-green/10 text-[10px] text-green"
                >
                  {t("usage.cacheRead")} {totalUsage.cacheRead.toLocaleString()}
                </Badge>
              )}
              {totalUsage.cacheCreate > 0 && (
                <Badge
                  variant="outline"
                  className="border-purple/30 bg-purple/10 text-[10px] text-purple"
                >
                  {t("usage.cacheCreate")}{" "}
                  {totalUsage.cacheCreate.toLocaleString()}
                </Badge>
              )}
              <div className="group relative">
                <Badge
                  variant="outline"
                  className="cursor-default border-yellow/30 bg-yellow/10 text-[10px] font-semibold text-yellow"
                >
                  ${totalCost.toFixed(4)}
                </Badge>
                {costByFamily.length > 0 && (
                  <div className="absolute top-full left-0 z-50 mt-1 hidden min-w-[260px] rounded-md border border-border bg-popover p-2.5 text-xs whitespace-nowrap shadow-md group-hover:block">
                    <div className="mb-1.5 border-b border-border pb-1 text-[9px] text-muted-foreground">
                      {t("usage.costByModel")}
                    </div>
                    <div className="space-y-2">
                      {costByFamily.map(({ family, cost, usage }) => (
                        <div key={family} className="space-y-0.5">
                          <div className="flex items-center justify-between gap-4">
                            <span className="font-medium capitalize">
                              {family}
                            </span>
                            <span className="font-semibold tabular-nums">
                              ${cost.toFixed(4)}
                            </span>
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 pl-1 text-[10px] text-muted-foreground tabular-nums">
                            <div className="flex justify-between gap-2">
                              <span>IN</span>
                              <span>{usage.input.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between gap-2">
                              <span>OUT</span>
                              <span>{usage.output.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between gap-2">
                              <span>{t("usage.cacheRead")}</span>
                              <span>{usage.cacheRead.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between gap-2">
                              <span>{t("usage.cacheCreate")}</span>
                              <span>{usage.cacheCreate.toLocaleString()}</span>
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="mt-1 flex items-center justify-between gap-4 border-t border-border pt-1.5">
                        <span className="font-medium">{t("usage.total")}</span>
                        <span className="font-semibold tabular-nums">
                          ${totalCost.toFixed(4)}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              {toolStats.tools > 0 && (
                <StatBadge
                  label={t("stat.tools")}
                  count={toolStats.tools}
                  mainMap={toolStats.mainToolMap}
                  subMap={toolStats.subToolMap}
                  className="border-brand/30 bg-brand/10 text-brand"
                />
              )}
              {toolStats.skills > 0 && (
                <StatBadge
                  label={t("stat.skills")}
                  count={toolStats.skills}
                  mainMap={toolStats.mainSkillMap}
                  subMap={toolStats.subSkillMap}
                  className="border-yellow/30 bg-yellow/10 text-yellow"
                />
              )}
              {toolStats.agents > 0 && (
                <StatBadge
                  label={t("stat.agents")}
                  count={toolStats.agents}
                  mainMap={toolStats.agentMap}
                  className="border-cyan/30 bg-cyan/10 text-cyan"
                />
              )}
            </div>
          )}

          <div
            ref={scrollRef}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
          >
            {!currentSession ? (
              <div className="flex flex-1 items-center justify-center font-heading text-sm text-muted-foreground">
                {t("empty.selectSession")}
              </div>
            ) : searchedMessages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center font-heading text-sm text-muted-foreground">
                {t("empty.noMessages")}
              </div>
            ) : (
              searchedMessages.map(({ msg, key, subagentInfo }) => (
                <MessageBlock
                  key={key}
                  msg={msg}
                  id={`msg-${key}`}
                  subagents={subagents}
                  workflows={workflows}
                  allMessages={subagentInfo ? subagentInfo.messages : messages}
                  subagentInfo={subagentInfo}
                  filters={filters}
                />
              ))
            )}
          </div>

          {/* Live Overlay */}
          {showLive && currentSession && messages.length > 0 && (
            <LiveOverlay
              messages={messages}
              subagents={subagents}
              onClose={() => setShowLive(false)}
            />
          )}
        </main>

        {showIndex && (
          <>
            <div
              className="w-1 flex-shrink-0 cursor-col-resize transition-colors hover:bg-brand/30 active:bg-brand/50"
              onMouseDown={handleMouseDown("index")}
            />
            <MessageIndex
              items={visibleMessages}
              style={{ width: indexWidth, minWidth: 150, flexShrink: 0 }}
            />
          </>
        )}
      </div>
    </div>
  )
}

export function CcHistoryView() {
  return (
    <I18nProvider>
      <CcHistoryInner />
    </I18nProvider>
  )
}
