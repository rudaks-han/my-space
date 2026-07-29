import { useMemo, useState } from "react"
import {
  ExternalLinkIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareKanbanIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { fmtAgo } from "@/features/home/home-utils"
import { useNow } from "@/lib/use-now"

import { friendlyError } from "./jira-errors"
import {
  openIssueInBrowser,
  useJira,
  useJiraIssueDetail,
  type JiraIssue,
  type JiraStatusCategory,
} from "./use-jira"

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

/** 패널 헤더 — 굵은 15px 제목 + 아래 구분선. */
const PANEL_HEADER =
  "flex shrink-0 items-center gap-2 border-b border-border px-4 py-3 text-[15px] font-semibold"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** 상태 분류별 색 — Slack 브랜드 4색만 쓴다(할 일=파랑, 진행 중=노랑, 완료=초록). */
const CATEGORY_STYLE: Record<
  JiraStatusCategory,
  { dot: string; chip: string; label: string }
> = {
  new: {
    dot: "bg-ui-info",
    chip: "bg-ui-info/15 text-ui-info",
    label: "할 일",
  },
  indeterminate: {
    dot: "bg-ui-warning",
    chip: "bg-ui-warning/15 text-ui-warning",
    label: "진행 중",
  },
  done: {
    dot: "bg-ui-success",
    chip: "bg-ui-success/15 text-ui-success",
    label: "완료",
  },
  undefined: {
    dot: "bg-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    label: "기타",
  },
}

function categoryStyle(c: JiraStatusCategory) {
  return CATEGORY_STYLE[c] ?? CATEGORY_STYLE.undefined
}

/** "2026-07-26" → "7월 26일". 파싱 실패하면 원문 그대로. */
function fmtDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
}

/** 기한이 오늘이거나 지났는지(빨간 표시용). */
function isDueSoon(due: string, now: number): boolean {
  const d = new Date(`${due}T23:59:59`)
  return !Number.isNaN(d.getTime()) && d.getTime() <= now + 86_400_000
}

/** 목록의 이슈 한 줄. */
function IssueRow({
  issue,
  active,
  now,
  onSelect,
}: {
  issue: JiraIssue
  active: boolean
  now: number
  onSelect: () => void
}) {
  const style = categoryStyle(issue.status_category)
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer flex-col gap-1 rounded-lg px-3 py-2 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        active
          ? "bg-ui-list-active text-ui-list-active-fg"
          : "hover:bg-ui-list-hover"
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", style.dot)} />
        <span
          className={cn(
            "shrink-0 font-mono text-[13px]",
            active ? "opacity-80" : "text-muted-foreground"
          )}
        >
          {issue.key}
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold">
          {issue.summary}
        </span>
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-4 text-[13px]",
          active ? "opacity-80" : "text-muted-foreground"
        )}
      >
        <span
          className={cn(
            "rounded-full px-2 text-[11px] font-bold",
            active ? "bg-white/20" : style.chip
          )}
        >
          {issue.status}
        </span>
        {issue.issue_type && <span>{issue.issue_type}</span>}
        {issue.priority && <span>· {issue.priority}</span>}
        {issue.due_date && (
          <span
            className={cn(
              !active &&
                isDueSoon(issue.due_date, now) &&
                "font-semibold text-ui-error"
            )}
          >
            · 기한 {fmtDate(issue.due_date)}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {issue.updated ? fmtAgo(new Date(issue.updated).getTime(), now) : ""}
        </span>
      </div>
    </button>
  )
}

/** 상세 화면의 메타 한 줄(라벨 + 값). */
function MetaRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex gap-3 py-1 text-[15px]">
      <span className="w-20 shrink-0 text-[13px] text-muted-foreground">
        {label}
      </span>
      <span className="ui-selectable min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** 선택한 이슈의 상세(본문 + 댓글). */
function IssueDetail({ issueKey }: { issueKey: string }) {
  const { detail, loading, error } = useJiraIssueDetail(issueKey)

  if (loading && !detail) {
    return (
      <div className="flex flex-1 items-center justify-center text-[15px] text-muted-foreground">
        이슈를 불러오는 중…
      </div>
    )
  }
  if (error) {
    return (
      <div className="p-4">
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      </div>
    )
  }
  if (!detail) return null

  const style = categoryStyle(detail.status_category)

  return (
    <>
      <div className={PANEL_HEADER}>
        <span className="font-mono text-[13px] text-muted-foreground">
          {detail.key}
        </span>
        <span
          className={cn("rounded-full px-2 text-[11px] font-bold", style.chip)}
        >
          {detail.status}
        </span>
        <Button
          variant="outline"
          className={cn(PILL, "ml-auto")}
          onClick={() => void openIssueInBrowser(detail.key)}
        >
          <ExternalLinkIcon className="size-3.5" />
          Jira 에서 열기
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <h2 className="ui-selectable text-[18px] font-bold tracking-[-0.01em]">
          {detail.summary}
        </h2>

        <div className="mt-3 border-t border-border pt-2">
          <MetaRow label="유형">{detail.issue_type || "—"}</MetaRow>
          <MetaRow label="프로젝트">
            {detail.project_name
              ? `${detail.project_name} (${detail.project_key})`
              : detail.project_key || "—"}
          </MetaRow>
          {detail.parent && <MetaRow label="상위">{detail.parent}</MetaRow>}
          <MetaRow label="담당자">{detail.assignee ?? "없음"}</MetaRow>
          <MetaRow label="보고자">{detail.reporter ?? "없음"}</MetaRow>
          <MetaRow label="우선순위">{detail.priority ?? "—"}</MetaRow>
          {detail.due_date && (
            <MetaRow label="기한">{fmtDate(detail.due_date)}</MetaRow>
          )}
          {detail.resolution && (
            <MetaRow label="해결">{detail.resolution}</MetaRow>
          )}
          {detail.labels.length > 0 && (
            <MetaRow label="라벨">
              <span className="flex flex-wrap gap-1">
                {detail.labels.map((l) => (
                  <span
                    key={l}
                    className="rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground"
                  >
                    {l}
                  </span>
                ))}
              </span>
            </MetaRow>
          )}
          {detail.updated && (
            <MetaRow label="수정">
              {new Date(detail.updated).toLocaleString("ko-KR")}
            </MetaRow>
          )}
        </div>

        <div className="mt-4">
          <div className="text-[15px] font-semibold">설명</div>
          {detail.description ? (
            <p className="ui-selectable mt-1.5 text-[15px] leading-relaxed whitespace-pre-wrap">
              {detail.description}
            </p>
          ) : (
            <p className="mt-1.5 text-[15px] text-muted-foreground">
              설명이 없습니다.
            </p>
          )}
        </div>

        {detail.comments.length > 0 && (
          <div className="mt-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold">
              <MessageSquareTextIcon className="size-4 text-muted-foreground" />
              댓글 {detail.comments.length}
              {detail.comments_truncated && "+"}
            </div>
            <div className="mt-2 flex flex-col gap-3">
              {detail.comments.map((c) => (
                <div key={c.id} className="border-t border-border pt-2">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-bold">{c.author}</span>
                    <span className="text-[13px] text-muted-foreground">
                      {c.created
                        ? new Date(c.created).toLocaleString("ko-KR")
                        : ""}
                    </span>
                  </div>
                  <p className="ui-selectable mt-1 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {c.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}

/** 아직 Jira 가 연결되지 않았을 때 — 연결은 설정 화면에서 한다. */
function NotConnectedView() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <SquareKanbanIcon className="size-9 text-muted-foreground" />
      <p className="text-[15px] font-bold">Jira 가 연결되지 않았습니다.</p>
      <p className="text-[13px] text-muted-foreground">
        사이드바 아래 톱니 아이콘 → 설정 → Jira 에서 사이트 주소·이메일·API
        토큰을 입력해 주세요.
      </p>
    </div>
  )
}

export function JiraView() {
  const {
    status,
    issues,
    loading,
    error,
    updatedAt,
    includeDone,
    setIncludeDone,
    refresh,
  } = useJira()
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const now = useNow()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return issues
    return issues.filter(
      (i) =>
        i.key.toLowerCase().includes(q) ||
        i.summary.toLowerCase().includes(q) ||
        i.status.toLowerCase().includes(q)
    )
  }, [issues, query])

  // 실제로 보여 줄 선택은 렌더 중에 정한다 — 아직 아무것도 안 골랐거나(첫 로드),
  // 고른 이슈가 검색·필터로 목록에서 빠졌으면 맨 위 이슈로 대체한다.
  const activeKey =
    selected && filtered.some((i) => i.key === selected)
      ? selected
      : (filtered[0]?.key ?? null)

  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  if (!status.connected) {
    return <NotConnectedView />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SquareKanbanIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">내 이슈 {issues.length}</span>
        <span className="text-[13px] text-muted-foreground">
          {status.display_name ?? status.user ?? "Jira"}
          {updatedAt &&
            ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })} 업데이트`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {/* 낱개 알약 — 선택된 것만 와인색으로 채운다(설정 화면과 같은 규칙). */}
          {[
            { label: "진행 중", value: false },
            { label: "전체", value: true },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={includeDone === o.value}
              onClick={() => setIncludeDone(o.value)}
              className={cn(
                "h-7 cursor-pointer rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
                includeDone === o.value
                  ? "border-transparent bg-ui-selection text-ui-selection-fg"
                  : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
              )}
            >
              {o.label}
            </button>
          ))}
          <Button
            variant="outline"
            className={PILL}
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon
              className={cn("size-3.5", loading && "animate-spin")}
            />
            새로고침
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* 좌: 이슈 목록 */}
        <div className={cn(PANEL, "w-[380px] shrink-0")}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="이슈 검색"
              aria-label="이슈 검색"
              className="ui-selectable min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {loading && issues.length === 0 ? (
              <div className="py-16 text-center text-[15px] text-muted-foreground">
                이슈를 불러오는 중…
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-16 text-center text-[15px] text-muted-foreground">
                {issues.length === 0
                  ? "담당 중인 이슈가 없습니다."
                  : "검색 결과가 없습니다."}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filtered.map((issue) => (
                  <IssueRow
                    key={issue.key}
                    issue={issue}
                    active={issue.key === activeKey}
                    now={now}
                    onSelect={() => setSelected(issue.key)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 우: 선택한 이슈 상세 */}
        <div className={cn(PANEL, "min-w-0 flex-1")}>
          {activeKey ? (
            <IssueDetail issueKey={activeKey} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[15px] text-muted-foreground">
              왼쪽에서 이슈를 선택하세요.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
