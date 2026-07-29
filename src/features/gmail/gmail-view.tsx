import {
  ChevronLeftIcon,
  ChevronRightIcon,
  InboxIcon,
  MailIcon,
  RefreshCwIcon,
  SendIcon,
  StarIcon,
  XIcon,
} from "lucide-react"
import { useCallback, useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gmail-error"
import {
  useGmail,
  type GmailBody,
  type GmailFolder,
  type GmailMessage,
  type GmailPage,
} from "./use-gmail"

/** 한 페이지 메일 수 — Rust LIST_SIZE 와 같아야 페이지 범위 표시가 맞다. */
const PAGE_SIZE = 50

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** 목록 시각 라벨 — 오늘이면 "오후 3:21", 올해면 "7월 23일", 그 외 "2024. 7. 23." */
function timeLabel(ms: number): string {
  if (!ms) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  if (sameDay)
    return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
  return d.toLocaleDateString("ko-KR")
}

/** 본문 헤더용 전체 일시. */
function fullTimeLabel(ms: number): string {
  if (!ms) return ""
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 좌측 폴더 네비게이션 항목. */
const FOLDERS: { id: GmailFolder; label: string; icon: ReactNode }[] = [
  {
    id: "inbox",
    label: "받은편지함",
    icon: <InboxIcon className="size-4 shrink-0" />,
  },
  {
    id: "sent",
    label: "보낸편지함",
    icon: <SendIcon className="size-4 shrink-0" />,
  },
]

/**
 * 메일 한 줄. 본문을 옆에 펼친 상태(compact)면 세로 2줄(Gmail 분할 뷰처럼),
 * 아니면 한 줄로 넓게 표시한다.
 */
function MessageRow({
  message,
  folder,
  interest,
  active,
  compact,
  onOpen,
}: {
  message: GmailMessage
  folder: GmailFolder
  interest: boolean
  active: boolean
  compact: boolean
  onOpen: () => void
}) {
  // 받은편지함은 보낸사람, 보낸편지함은 받는사람을 강조한다.
  const who =
    folder === "sent"
      ? message.to || "(받는사람 없음)"
      : message.from_name || message.from_email || "(보낸사람 없음)"
  const unread = folder === "inbox" && message.unread

  const star = (
    <StarIcon
      className={cn(
        "size-4 shrink-0",
        active
          ? "text-ui-list-active-fg"
          : interest
            ? "text-ui-warning"
            : "text-muted-foreground/35"
      )}
      fill={interest ? "currentColor" : "none"}
    />
  )
  const date = (
    <span
      className={cn(
        "shrink-0 text-[13px] tabular-nums",
        active
          ? "text-ui-list-active-fg/80"
          : unread
            ? "font-bold text-foreground"
            : "text-muted-foreground"
      )}
    >
      {timeLabel(message.date)}
    </span>
  )
  const senderCls = cn(
    "truncate text-[15px]",
    active
      ? "text-ui-list-active-fg"
      : unread
        ? "font-bold text-foreground"
        : "text-foreground/80"
  )
  const subjectCls = cn(unread && !active && "font-bold")
  const snippetCls = active
    ? "text-ui-list-active-fg/70"
    : "text-muted-foreground"

  const rowCls = cn(
    "flex w-full items-center gap-3 px-3 text-left transition-colors",
    active
      ? "bg-ui-list-active text-ui-list-active-fg"
      : cn("hover:bg-ui-list-hover", unread ? "bg-card" : "bg-ui-list-hover/30")
  )

  if (compact) {
    // 세로 2줄: [별 · 보낸사람 · 시각] / [제목 — 미리보기]
    return (
      <button
        type="button"
        onClick={onOpen}
        className={cn(rowCls, "flex-col items-stretch gap-0.5 py-2")}
      >
        <div className="flex items-center gap-2">
          {star}
          <span className={cn(senderCls, "min-w-0 flex-1")}>{who}</span>
          {date}
        </div>
        <div className="min-w-0 truncate pl-6 text-[15px]">
          <span className={subjectCls}>{message.subject || "(제목 없음)"}</span>
          {message.snippet && (
            <span className={snippetCls}> — {message.snippet}</span>
          )}
        </div>
      </button>
    )
  }

  // 한 줄: [별] 보낸사람(고정폭) · 제목 — 미리보기 · 시각
  return (
    <button type="button" onClick={onOpen} className={cn(rowCls, "h-9")}>
      {star}
      <span className={cn(senderCls, "w-44 shrink-0")}>{who}</span>
      <span className="min-w-0 flex-1 truncate text-[15px]">
        <span className={subjectCls}>{message.subject || "(제목 없음)"}</span>
        {message.snippet && (
          <span className={snippetCls}> — {message.snippet}</span>
        )}
      </span>
      {date}
    </button>
  )
}

/** 메일 본문 읽기 — HTML 은 sandbox iframe 으로, 없으면 텍스트로 렌더한다. */
function ReadingPane({
  body,
  loading,
  error,
  onClose,
}: {
  body: GmailBody | null
  loading: boolean
  error: string | null
  onClose: () => void
}) {
  // HTML 본문은 스크립트 실행을 막은 sandbox iframe 에 넣는다(추적·XSS 차단).
  const srcDoc =
    body?.html != null
      ? `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:16px;color:#1d1c1d;font-size:14px;line-height:1.5;word-break:break-word}img{max-width:100%;height:auto}a{color:#1264a3}</style></head><body>${body.html}</body></html>`
      : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
      {loading && !body ? (
        <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
          메일을 불러오는 중…
        </div>
      ) : error ? (
        <div className="p-4">
          <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
            {friendlyError(error)}
          </p>
        </div>
      ) : body ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 본문 헤더 */}
          <div className="flex items-start gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[18px] font-bold tracking-[-0.01em]">
                {body.subject || "(제목 없음)"}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px] text-muted-foreground">
                <span className="font-semibold text-foreground">
                  {body.from_name || body.from_email}
                </span>
                {body.from_email && body.from_name !== body.from_email && (
                  <span>&lt;{body.from_email}&gt;</span>
                )}
                {body.date > 0 && <span>· {fullTimeLabel(body.date)}</span>}
                {body.to && <span className="w-full">받는사람: {body.to}</span>}
              </div>
            </div>
            <Button
              variant="ghost"
              className="size-7 shrink-0 rounded-full p-0"
              onClick={onClose}
              aria-label="닫기"
            >
              <XIcon className="size-4" />
            </Button>
          </div>

          {/* 본문 */}
          {srcDoc != null ? (
            <iframe
              // 스크립트·폼·동일 출처를 모두 차단한 sandbox(이미지·스타일만 허용).
              sandbox=""
              srcDoc={srcDoc}
              title={body.subject || "메일 본문"}
              className="min-h-0 w-full flex-1 bg-white"
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[15px] leading-6 break-words whitespace-pre-wrap">
              {body.text ?? "(본문이 없습니다)"}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 아직 계정이 연결되지 않았을 때 — 연결은 설정 화면에서 한다. */
function NotConnectedView() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <MailIcon className="size-9 text-muted-foreground" />
      <p className="text-[15px] font-bold">Gmail 이 연결되지 않았습니다.</p>
      <p className="text-[13px] text-muted-foreground">
        사이드바 아래 톱니 아이콘 → 설정 → Gmail 에서 계정을 연결해 주세요.
      </p>
    </div>
  )
}

export function GmailView() {
  const {
    status,
    error: connError,
    updatedAt,
    unreadInterest,
    totalUnread,
    refreshInbox,
    loadPage,
    loadBody,
    markRead,
    isInterest,
  } = useGmail()

  const [folder, setFolder] = useState<GmailFolder>("inbox")
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // 현재 페이지 + 페이지 이동용 토큰 스택(tokens[i] = 페이지 i 조회 토큰, [0] = 빈 문자열).
  const [page, setPage] = useState<GmailPage | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [tokens, setTokens] = useState<string[]>([""])
  const [pageLoading, setPageLoading] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  // 본문(선택한 메일).
  const [body, setBody] = useState<GmailBody | null>(null)
  const [bodyLoading, setBodyLoading] = useState(false)
  const [bodyError, setBodyError] = useState<string | null>(null)

  // 한 페이지를 조회해 상태에 반영한다. 다음 페이지 토큰은 스택에 기록한다.
  const loadAt = useCallback(
    async (f: GmailFolder, idx: number, token: string) => {
      setPageLoading(true)
      setPageError(null)
      try {
        const p = await loadPage(f, token || undefined)
        setPage(p)
        if (p.next_page_token) {
          const nextTok = p.next_page_token
          setTokens((prev) => {
            const next = [...prev]
            next[idx + 1] = nextTok
            return next
          })
        }
      } catch (e) {
        setPageError(String(e))
      } finally {
        setPageLoading(false)
      }
    },
    [loadPage]
  )

  // 최초 1회(그리고 keep-alive 로 마운트 유지) 첫 페이지를 불러온다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAt("inbox", 0, "")
    // 마운트 시 1회만.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 선택한 메일의 본문을 불러온다.
  useEffect(() => {
    if (!selectedId) return
    let cancelled = false
    // 선택이 바뀌면 새 본문을 불러온다(데이터 페칭 목적의 의도된 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBody(null)
    setBodyError(null)
    setBodyLoading(true)
    loadBody(selectedId)
      .then((b) => {
        if (!cancelled) setBody(b)
      })
      .catch((e) => {
        if (!cancelled) setBodyError(String(e))
      })
      .finally(() => {
        if (!cancelled) setBodyLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedId, loadBody])

  // 메일을 연다. 받은편지함의 안 읽은 메일이면 즉시 읽음 처리(목록·배지 낙관적 갱신).
  function openMessage(m: GmailMessage) {
    setSelectedId(m.id)
    if (folder === "inbox" && m.unread) {
      setPage((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.map((x) =>
                x.id === m.id ? { ...x, unread: false } : x
              ),
            }
          : prev
      )
      void markRead(m.id)
    }
  }

  function selectFolder(f: GmailFolder) {
    if (f === folder) return
    setFolder(f)
    setSelectedId(null)
    setPageIndex(0)
    setTokens([""])
    void loadAt(f, 0, "")
  }

  function goNext() {
    if (!page?.next_page_token || pageLoading) return
    const idx = pageIndex + 1
    setPageIndex(idx)
    void loadAt(folder, idx, page.next_page_token)
  }

  function goPrev() {
    if (pageIndex === 0 || pageLoading) return
    const idx = pageIndex - 1
    setPageIndex(idx)
    void loadAt(folder, idx, tokens[idx] ?? "")
  }

  function reload() {
    void loadAt(folder, pageIndex, tokens[pageIndex] ?? "")
    if (folder === "inbox") void refreshInbox() // 사이드바 배지도 갱신
  }

  const messages = page?.messages ?? []
  const listError = pageError ?? connError
  const total = page?.result_size_estimate ?? 0
  const rangeStart = messages.length === 0 ? 0 : pageIndex * PAGE_SIZE + 1
  const rangeEnd = pageIndex * PAGE_SIZE + messages.length

  // 좌측 폴더 네비게이션 — 연결 여부와 무관하게 항상 보인다.
  const nav = (
    <nav className="flex w-44 shrink-0 flex-col gap-0.5">
      {FOLDERS.map((f) => {
        const active = f.id === folder
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => selectFolder(f.id)}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[15px] transition-colors",
              active
                ? "bg-ui-list-active font-bold text-ui-list-active-fg"
                : "hover:bg-ui-list-hover"
            )}
          >
            {f.icon}
            <span className="truncate">{f.label}</span>
            {f.id === "inbox" && (unreadInterest > 0 || totalUnread > 0) && (
              <span className="ml-auto flex items-center gap-1">
                {unreadInterest > 0 && (
                  <span
                    className={cn(
                      "min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-bold tabular-nums",
                      active
                        ? "bg-white/25 text-ui-list-active-fg"
                        : "bg-ui-error text-white"
                    )}
                  >
                    {unreadInterest > 99 ? "99+" : unreadInterest}
                  </span>
                )}
                {totalUnread > 0 && (
                  <span className="min-w-5 rounded-full border border-current/30 px-1.5 text-center text-[11px] leading-5 font-bold tabular-nums opacity-70">
                    {totalUnread > 99 ? "99+" : totalUnread}
                  </span>
                )}
              </span>
            )}
          </button>
        )
      })}
    </nav>
  )

  let content: ReactNode
  if (status === null) {
    content = (
      <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  } else if (!status.connected) {
    content = <NotConnectedView />
  } else {
    content = (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {/* 상단 바 — 폴더 제목·계정(왼쪽) + 페이지 이동(오른쪽) */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-bold">
            {folder === "inbox" ? "받은편지함" : "보낸편지함"}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {status.email ?? "Gmail"}
            {updatedAt &&
              ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })} 업데이트`}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              className={PILL}
              onClick={reload}
              disabled={pageLoading}
            >
              <RefreshCwIcon
                className={cn("size-3.5", pageLoading && "animate-spin")}
              />
              새로고침
            </Button>
            {messages.length > 0 && (
              <>
                <span className="ml-1 text-[13px] text-muted-foreground tabular-nums">
                  {rangeStart}–{rangeEnd}
                  {total > 0 && ` / 약 ${total.toLocaleString("ko-KR")}개`}
                </span>
                <Button
                  variant="ghost"
                  className="size-7 rounded-full p-0"
                  onClick={goPrev}
                  disabled={pageIndex === 0 || pageLoading}
                  aria-label="이전 페이지"
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  className="size-7 rounded-full p-0"
                  onClick={goNext}
                  disabled={!page?.next_page_token || pageLoading}
                  aria-label="다음 페이지"
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </>
            )}
          </div>
        </div>

        {listError && (
          <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
            {friendlyError(listError)}
          </p>
        )}

        {/* 목록(왼쪽) + 본문(오른쪽) 분할 — 본문 영역은 항상 보인다. */}
        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-h-0 w-[360px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            {pageLoading && messages.length === 0 ? (
              <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
                메일을 불러오는 중…
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
                <MailIcon className="size-9 text-muted-foreground" />
                <p className="text-[15px] text-muted-foreground">
                  메일이 없습니다.
                </p>
              </div>
            ) : (
              <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
                {messages.map((m) => (
                  <MessageRow
                    key={m.id}
                    message={m}
                    folder={folder}
                    interest={isInterest(m)}
                    active={m.id === selectedId}
                    compact
                    onOpen={() => openMessage(m)}
                  />
                ))}
              </div>
            )}
          </div>

          {selectedId ? (
            <ReadingPane
              body={body}
              loading={bodyLoading}
              error={bodyError}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-[10px] border border-border bg-card text-center shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <MailIcon className="size-9 text-muted-foreground" />
              <p className="text-[15px] text-muted-foreground">
                선택된 메일이 없습니다.
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 w-full flex-1 gap-5">
      {nav}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
    </div>
  )
}
