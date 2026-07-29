import { useState, useEffect, useRef, useCallback } from "react"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, FolderOpen, MessageSquare, Loader2 } from "lucide-react"
import { fetchSessions } from "../api"
import { truncate, timeAgo } from "../helpers"
import type { Project, Session } from "../types"
import { cn } from "@/lib/utils"
import { useT } from "../i18n-context"

const PAGE_SIZE = 10

interface SidebarProps {
  projects: Project[]
  onSelectSession: (project: Project, session: Session) => void
  activeSessionId?: string
  style?: React.CSSProperties
  initialOpenProjectId?: string | null
  onProjectToggle?: (projectId: string | null) => void
}

export function Sidebar({
  projects,
  onSelectSession,
  activeSessionId,
  style,
  initialOpenProjectId,
  onProjectToggle,
}: SidebarProps) {
  const t = useT()
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)

  const loadSessions = async (
    projectId: string,
    offset = 0,
    append = false,
    poll = false
  ) => {
    try {
      const data = await fetchSessions(projectId, PAGE_SIZE, offset)
      if (append) {
        setSessions((prev) => {
          const existingIds = new Set(prev.map((s) => s.id))
          const newSessions = data.sessions.filter(
            (s) => !existingIds.has(s.id)
          )
          return newSessions.length > 0 ? [...prev, ...newSessions] : prev
        })
      } else if (poll) {
        // Polling: merge first page into existing list, keep the rest
        setSessions((prev) => {
          const freshById = new Map(data.sessions.map((s) => [s.id, s]))
          const updated = prev.map((s) => freshById.get(s.id) || s)
          // Add any new sessions not already in the list
          const existingIds = new Set(prev.map((s) => s.id))
          const brandNew = data.sessions.filter((s) => !existingIds.has(s.id))
          const merged = [...brandNew, ...updated]
          const next = JSON.stringify(merged)
          return JSON.stringify(prev) === next ? prev : merged
        })
      } else {
        setSessions((prev) => {
          const next = JSON.stringify(data.sessions)
          return JSON.stringify(prev) === next ? prev : data.sessions
        })
      }
      setTotal((prev) => (prev === data.total ? prev : data.total))
    } catch {
      if (!append) setSessions([])
    }
  }

  const toggleProject = useCallback(
    async (project: Project) => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
      if (openProjectId === project.id) {
        setOpenProjectId(null)
        setSessions([])
        setTotal(0)
        onProjectToggle?.(null)
        return
      }
      setOpenProjectId(project.id)
      onProjectToggle?.(project.id)
      setLoading(true)
      await loadSessions(project.id, 0, false)
      setLoading(false)
      // Poll only refreshes the first page (latest sessions)
      pollingRef.current = setInterval(
        () => loadSessions(project.id, 0, false, true),
        5000
      )
    },
    [openProjectId, onProjectToggle]
  )

  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (!initialOpenProjectId) return
    const project = projects.find((p) => p.id === initialOpenProjectId)
    if (!project) return
    autoOpenedRef.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initialOpenProjectId 가 주어지면 최초 1회 해당 프로젝트를 자동으로 펼치는 의도된 동작.
    toggleProject(project)
  }, [initialOpenProjectId, projects, toggleProject])

  const loadMore = useCallback(async () => {
    if (loadingMore || !openProjectId || sessions.length >= total) return
    setLoadingMore(true)
    await loadSessions(openProjectId, sessions.length, true)
    setLoadingMore(false)
  }, [loadingMore, openProjectId, sessions.length, total])

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    if (observerRef.current) observerRef.current.disconnect()
    if (!openProjectId || sessions.length >= total) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { threshold: 0.1 }
    )
    if (sentinelRef.current) observerRef.current.observe(sentinelRef.current)

    return () => {
      observerRef.current?.disconnect()
    }
  }, [openProjectId, sessions.length, total, loadMore])

  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current)
    }
  }, [])

  const hasMore = sessions.length < total

  return (
    <aside
      className="flex flex-col border-r border-border bg-card"
      style={style}
    >
      <div className="px-3 py-2">
        <h3 className="px-1 py-2 font-heading text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {t("sidebar.explorer")}
        </h3>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="px-2 pb-2">
          {projects.map((p) => (
            <div key={p.id}>
              <button
                onClick={() => toggleProject(p)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                  openProjectId === p.id && "bg-accent"
                )}
              >
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                    openProjectId === p.id && "rotate-90"
                  )}
                />
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span
                  className="flex-1 truncate text-left font-medium"
                  title={p.path}
                >
                  {p.name}
                </span>
                {p.lastSessionTimestamp && (
                  <span className="shrink-0 text-[10px] whitespace-nowrap text-muted-foreground">
                    {timeAgo(p.lastSessionTimestamp)}
                  </span>
                )}
                <Badge
                  variant="secondary"
                  className="h-5 px-1.5 py-0 text-[10px]"
                >
                  {p.sessionCount}
                </Badge>
              </button>

              {openProjectId === p.id && (
                <div className="mt-0.5 ml-4">
                  {loading ? (
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {t("sidebar.loading")}
                    </p>
                  ) : (
                    <>
                      {sessions.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => onSelectSession(p, s)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent",
                            activeSessionId === s.id &&
                              "bg-accent ring-1 ring-ring"
                          )}
                        >
                          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <div className="flex-1 overflow-hidden text-left">
                            <div className="truncate text-foreground">
                              {truncate(s.title, 55)}
                            </div>
                            <div className="mt-0.5 text-muted-foreground">
                              {timeAgo(s.modifiedAt || s.lastTimestamp)} · #
                              {s.messageCount}
                            </div>
                          </div>
                        </button>
                      ))}
                      {hasMore && (
                        <div
                          ref={sentinelRef}
                          className="flex items-center justify-center py-2"
                        >
                          {loadingMore ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <span className="text-[10px] text-muted-foreground">
                              {sessions.length} / {total}
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}
