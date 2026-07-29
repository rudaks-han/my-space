import {
  AtSignIcon,
  HashIcon,
  ListChecksIcon,
  LockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  ReplyIcon,
  UsersIcon,
} from "lucide-react"
import { Fragment, useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { friendlyError } from "./slack-errors"
import {
  useSlack,
  type ChannelInfo,
  type ChannelKind,
  type ChannelUnread,
  type UnreadMessage,
} from "./use-slack"

/** 메시지 시각(오전 9:12). 날짜는 날짜 구분선이 알려주므로 시각만 보여준다. */
function formatTime(ts: string): string {
  const sec = parseFloat(ts)
  if (!sec) return ""
  return new Date(sec * 1000).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** 같은 날 메시지를 한 덩어리로 묶기 위한 키. */
function dayKey(ts: string): string {
  const sec = parseFloat(ts)
  if (!sec) return ""
  return new Date(sec * 1000).toDateString()
}

/** 날짜 구분선 라벨 — 오늘/어제는 말로, 나머지는 "7월 24일 (금)". */
function dayLabel(ts: string): string {
  const sec = parseFloat(ts)
  if (!sec) return ""
  const d = new Date(sec * 1000)
  const diff =
    new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)
  if (diff === 0) return "오늘"
  if (diff === 86_400_000) return "어제"
  return d.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  })
}

const KIND_ICON: Record<ChannelKind, typeof HashIcon> = {
  channel: HashIcon,
  private: LockIcon,
  mpim: UsersIcon,
  im: AtSignIcon,
}

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

/** 패널 헤더 한 줄 — 회색 배경 없이 굵은 15px 제목 + 아래 구분선만. */
const PANEL_HEADER =
  "flex shrink-0 items-center gap-2 border-b border-border px-4 py-3"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** 채널 전체를 부르는 멘션 — Slack 처럼 노란 칩으로 더 눈에 띄게 한다. */
const BROADCAST = new Set(["@here", "@channel", "@everyone"])

/**
 * 본문에서 링크·멘션·채널 참조를 찾아내는 토큰 패턴.
 * 한글 멘션(@제품개발본부)도 잡아야 하므로 `\w` 대신 유니코드 문자 클래스를 쓴다.
 */
const TOKEN_RE =
  /((?:https?:\/\/|mailto:)[^\s<>]+|@[\p{L}\p{N}._'-]+|#[\p{L}\p{N}._-]+)/gu

/**
 * 메시지 본문을 Slack 처럼 색을 입혀 렌더한다.
 * Rust 쪽에서 이미 `<@U123>` → `@이름`, `<url|label>` → 라벨로 풀어 두었으므로
 * 여기서는 평문에서 URL·멘션만 찾아 링크와 칩으로 감싼다.
 */
function renderBody(text: string) {
  return text.split(TOKEN_RE).map((part, i) => {
    if (!part) return null
    if (/^(?:https?:\/\/|mailto:)/.test(part)) {
      return (
        <a
          key={i}
          href={part}
          // 행 전체가 "Slack 에서 열기" 버튼이라 링크 클릭은 여기서 멈춘다.
          onClick={(e) => e.stopPropagation()}
          className="break-all text-ui-link underline underline-offset-2"
        >
          {part}
        </a>
      )
    }
    if (part.startsWith("@") || part.startsWith("#")) {
      return (
        <span
          key={i}
          className={cn(
            "rounded px-1 font-semibold",
            BROADCAST.has(part.toLowerCase())
              ? "bg-ui-highlight text-ui-highlight-fg"
              : "bg-ui-mention text-ui-mention-fg"
          )}
        >
          {part}
        </span>
      )
    }
    return part
  })
}

/** 날짜 구분선 — 가로선 위에 테두리 알약을 얹은 Slack 형태. */
function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-2">
      <span className="h-px flex-1 bg-border" />
      <span className="shrink-0 rounded-full border border-border px-3 py-0.5 text-[13px] font-bold">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** 프로필 사진이 없으므로 Slack 기본 아바타처럼 이름 첫 글자를 둥근 사각에 넣는다. */
function Avatar({
  name,
  compact = false,
}: {
  name: string
  compact?: boolean
}) {
  return (
    <span
      className={cn(
        "mt-0.5 flex shrink-0 items-center justify-center rounded-lg bg-ui-badge font-bold text-ui-badge-fg",
        compact ? "size-6 text-[13px]" : "size-9 text-[15px]"
      )}
    >
      {name.trim().charAt(0) || "?"}
    </span>
  )
}

/** 메시지 한 줄 — 아바타 + 굵은 작성자명 + 시각 + 본문. 클릭하면 Slack 에서 연다. */
function MessageRow({
  channelId,
  m,
  onOpen,
}: {
  channelId: string
  m: UnreadMessage
  onOpen: (channel: string, ts: string, threadTs: string | null) => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        // 텍스트를 드래그로 선택 중이면 열지 않는다(복사 허용). 선택 없이 클릭하면 열기.
        if (window.getSelection()?.toString()) return
        onOpen(channelId, m.ts, m.thread_ts)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(channelId, m.ts, m.thread_ts)
      }}
      title={m.thread_ts ? "Slack 스레드에서 열기" : "Slack 앱에서 열기"}
      className="ui-selectable flex min-h-9 cursor-pointer gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
    >
      <Avatar name={m.user} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] font-bold">{m.user}</span>
          <span className="shrink-0 text-[13px] text-muted-foreground tabular-nums">
            {formatTime(m.ts)}
          </span>
        </div>
        <p className="text-[15px] leading-[1.46] break-words whitespace-pre-wrap">
          {m.text ? renderBody(m.text) : "(첨부 파일 또는 빈 메시지)"}
        </p>
      </div>
    </div>
  )
}

/** 스레드(댓글) 묶음 — 부모(루트) 메시지를 맥락 헤더로 두고 그 아래 안 읽은 답글을 들여쓴다. */
function ThreadBlock({
  channelId,
  parentTs,
  parentUser,
  parentText,
  replies,
  onOpen,
}: {
  channelId: string
  parentTs: string
  parentUser: string | null
  parentText: string | null
  replies: UnreadMessage[]
  onOpen: (channel: string, ts: string, threadTs: string | null) => void
}) {
  return (
    <div className="rounded-lg border border-border bg-ui-list-hover/40">
      {/* 스레드 루트(부모) — 맥락. 안 읽음이 아닐 수 있어 흐리게 표시하고, 클릭하면 스레드를 연다. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (window.getSelection()?.toString()) return
          onOpen(channelId, parentTs, parentTs)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(channelId, parentTs, parentTs)
        }}
        title="Slack 스레드에서 열기"
        className="ui-selectable flex cursor-pointer gap-2.5 rounded-t-lg px-2 py-1.5 text-left transition-colors hover:bg-ui-list-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
      >
        <Avatar name={parentUser ?? "?"} compact />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <ReplyIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-[13px] font-semibold text-muted-foreground">
              {parentUser ?? "스레드"}
            </span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-bold text-muted-foreground tabular-nums">
              답글 {replies.length}
            </span>
          </div>
          <p className="line-clamp-2 text-[13px] leading-[1.4] break-words whitespace-pre-wrap text-muted-foreground">
            {parentText ? renderBody(parentText) : "스레드 루트 메시지"}
          </p>
        </div>
      </div>
      {/* 안 읽은 답글 — 부모 아래 들여쓰기 + 좌측 선으로 댓글 구조를 드러낸다. */}
      <div className="ml-4 border-l-2 border-ui-tab-border pt-0.5 pb-1 pl-1.5">
        {replies.map((r) => (
          <MessageRow key={r.ts} channelId={channelId} m={r} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}

function ChannelCard({
  channel,
  onOpen,
}: {
  channel: ChannelUnread
  onOpen: (channel: string, ts: string, threadTs: string | null) => void
}) {
  const Icon = KIND_ICON[channel.kind]

  // 평평한 메시지 목록을 "최상위 메시지"와 "스레드 묶음"으로 나눠 댓글 구조를 복원한다.
  // 스레드 답글은 thread_ts(부모 ts)로 묶고, 부모 메시지를 맥락 헤더로 얹는다.
  const feed = useMemo(() => {
    type Single = { kind: "single"; sortTs: string; message: UnreadMessage }
    type Thread = {
      kind: "thread"
      sortTs: string
      parentTs: string
      parentUser: string | null
      parentText: string | null
      replies: UnreadMessage[]
    }
    const threads = new Map<string, Thread>()
    const singles: Single[] = []
    for (const m of channel.messages) {
      if (m.thread_ts) {
        let block = threads.get(m.thread_ts)
        if (!block) {
          block = {
            kind: "thread",
            sortTs: m.ts,
            parentTs: m.thread_ts,
            parentUser: m.parent_user ?? null,
            parentText: m.parent_text ?? null,
            replies: [],
          }
          threads.set(m.thread_ts, block)
        }
        block.replies.push(m)
        // 묶음은 가장 최근 답글 시각을 기준으로 다른 메시지들과 시간순 배치한다.
        if (parseFloat(m.ts) > parseFloat(block.sortTs)) block.sortTs = m.ts
      } else {
        singles.push({ kind: "single", sortTs: m.ts, message: m })
      }
    }
    // 부모 자신이 최상위 안 읽음으로도 잡혔다면 중복 표시하지 않는다(헤더가 대신 보여준다).
    const parentSet = new Set(threads.keys())
    const items: (Single | Thread)[] = [
      ...singles.filter((s) => !parentSet.has(s.message.ts)),
      ...threads.values(),
    ]
    items.sort((a, b) => parseFloat(a.sortTs) - parseFloat(b.sortTs))
    return items
  }, [channel.messages])
  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-[15px] font-bold">{channel.name}</span>
        {/* Slack 의 안 읽음 개수는 빨간 알약이다(사이드바 배지와 같은 색). */}
        <Badge variant="destructive" className="tabular-nums">
          {channel.unread}
          {channel.has_more ? "+" : ""}
        </Badge>
      </div>
      {/* 메시지 목록 — 최상위 메시지는 그대로, 스레드 답글은 부모 아래로 묶어 댓글 구조를 보여준다. */}
      <div className="flex flex-col gap-0.5 p-2">
        {feed.map((item, i) => {
          const prev = feed[i - 1]
          const newDay = !prev || dayKey(prev.sortTs) !== dayKey(item.sortTs)
          return (
            <Fragment
              key={
                item.kind === "thread"
                  ? `t-${item.parentTs}`
                  : `m-${item.message.ts}`
              }
            >
              {newDay && <DayDivider label={dayLabel(item.sortTs)} />}
              {item.kind === "single" ? (
                <MessageRow
                  channelId={channel.id}
                  m={item.message}
                  onOpen={onOpen}
                />
              ) : (
                <ThreadBlock
                  channelId={channel.id}
                  parentTs={item.parentTs}
                  parentUser={item.parentUser}
                  parentText={item.parentText}
                  replies={item.replies}
                  onOpen={onOpen}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

const KIND_LABEL: Record<ChannelKind, string> = {
  channel: "채널",
  private: "비공개",
  mpim: "그룹 DM",
  im: "DM",
}

function ChannelPicker({
  channels,
  loading,
  fetchedAt,
  initialSelected,
  onSave,
  onCancel,
  onRefresh,
}: {
  channels: ChannelInfo[]
  loading: boolean
  fetchedAt: number | null
  initialSelected: string[]
  onSave: (ids: string[]) => void
  onCancel: () => void
  onRefresh: () => void
}) {
  const [draft, setDraft] = useState<Set<string>>(new Set(initialSelected))
  const [filter, setFilter] = useState("")

  // 피커를 연 시점의 선택을 고정으로 삼아 정렬한다. draft(체크 상태)로 정렬하면
  // 체크를 누를 때마다 항목이 위아래로 튀어 어지럽다 — 열 때의 선택만 위로 올린다.
  const pinned = useMemo(() => new Set(initialSelected), [initialSelected])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = q
      ? channels.filter((c) => c.name.toLowerCase().includes(q))
      : channels
    // 선택된 채널을 맨 위로. 그룹 내 원래 순서는 유지(안정 정렬).
    return [...matched].sort(
      (a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    )
  }, [channels, filter, pinned])

  function toggle(id: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>
        <span className="text-[15px] font-semibold">표시할 채널 선택</span>
        {fetchedAt && (
          <span className="truncate text-[13px] text-muted-foreground tabular-nums">
            목록{" "}
            {new Date(fetchedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            캐시됨
          </span>
        )}
        <Button
          variant="outline"
          className={cn(PILL, "ml-auto")}
          onClick={onRefresh}
          disabled={loading}
          title="채널 목록을 다시 가져옵니다"
        >
          <RefreshCwIcon
            className={cn("size-3.5", loading && "animate-spin")}
          />
          새로고침
        </Button>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[13px] text-muted-foreground">
          체크한 채널의 안 읽은 메시지만 가져옵니다. 선택은 저장됩니다.
        </p>
        <Input
          placeholder="채널 이름 검색…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ui-selectable"
        />

        {loading && channels.length === 0 ? (
          <p className="py-8 text-center text-[15px] text-muted-foreground">
            채널 목록을 불러오는 중…
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border p-1">
            {visible.length === 0 ? (
              <p className="py-8 text-center text-[15px] text-muted-foreground">
                일치하는 채널이 없습니다.
              </p>
            ) : (
              visible.map((c, i) => {
                const Icon = KIND_ICON[c.kind]
                const checked = draft.has(c.id)
                // 위로 올린 선택 채널과 나머지 사이에 구분선을 한 번 그어 경계를 드러낸다.
                const boundary =
                  i > 0 && pinned.has(visible[i - 1].id) && !pinned.has(c.id)
                return (
                  <Fragment key={c.id}>
                    {boundary && (
                      <div className="my-1 flex items-center gap-2 px-3">
                        <span className="h-px flex-1 bg-border" />
                        <span className="shrink-0 text-[11px] font-bold text-muted-foreground">
                          그 외 채널
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    )}
                    <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 transition-colors hover:bg-ui-list-hover">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(v) => toggle(c.id, v === true)}
                      />
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-[15px]">
                        {c.name}
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        {KIND_LABEL[c.kind]}
                      </span>
                    </label>
                  </Fragment>
                )
              })
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-[13px] text-muted-foreground">
            {draft.size}개 선택됨
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" className={PILL} onClick={onCancel}>
              취소
            </Button>
            <Button className={PILL} onClick={() => onSave([...draft])}>
              저장
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function SlackView() {
  const {
    status,
    channels,
    loading,
    error,
    updatedAt,
    selected,
    channelsList,
    channelsLoading,
    channelsFetchedAt,
    refresh,
    loadChannels,
    saveSelected,
    openMessage,
  } = useSlack()

  const [pickerOpen, setPickerOpen] = useState(false)

  // 연결 상태 확인 중
  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  // 연결·연결 해제는 설정으로 옮겼다. 미연결이면 설정으로 안내한다.
  if (!status.connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <MessageSquareIcon className="size-9 text-muted-foreground" />
        <p className="text-[15px] text-muted-foreground">
          Slack 에 연결되어 있지 않습니다.
          <br />
          왼쪽 아래 <b className="text-foreground">설정 ⚙ → Slack</b> 에서
          연결하세요.
        </p>
      </div>
    )
  }

  function openPicker() {
    setPickerOpen(true)
    if (channelsList.length === 0) void loadChannels()
  }

  const totalUnread = channels.reduce((sum, c) => sum + c.unread, 0)

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-[15px] font-bold">{status.team ?? "Slack"}</span>
        {status.user && (
          <span className="text-[13px] text-muted-foreground">
            {status.user}
          </span>
        )}
        {updatedAt && (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            ·{" "}
            {new Date(updatedAt).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })}{" "}
            업데이트
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" className={PILL} onClick={openPicker}>
            <ListChecksIcon className="size-3.5" />
            채널 선택{selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
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

      {pickerOpen && (
        <ChannelPicker
          channels={channelsList}
          loading={channelsLoading}
          fetchedAt={channelsFetchedAt}
          initialSelected={selected}
          onSave={(ids) => {
            void saveSelected(ids)
            setPickerOpen(false)
          }}
          onCancel={() => setPickerOpen(false)}
          onRefresh={() => void loadChannels()}
        />
      )}

      {selected.length === 0 ? (
        !pickerOpen && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-[15px] text-muted-foreground">
              아직 선택한 채널이 없습니다. 볼 채널을 골라주세요.
            </p>
            <Button onClick={openPicker}>
              <ListChecksIcon />
              채널 선택
            </Button>
          </div>
        )
      ) : loading && channels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
          안 읽은 메시지를 불러오는 중…
        </div>
      ) : channels.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <p className="text-[24px]">🎉</p>
          <p className="text-[15px] text-muted-foreground">
            선택한 채널에 안 읽은 메시지가 없습니다.
          </p>
        </div>
      ) : (
        <>
          <p className="text-[13px] text-muted-foreground">
            {channels.length}개 채널 · 안 읽음{" "}
            <b className="font-bold text-ui-error">
              {totalUnread}
              {channels.some((c) => c.has_more) ? "+" : ""}
            </b>
            개
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {channels.map((c) => (
              <ChannelCard
                key={c.id}
                channel={c}
                onOpen={(channel, ts, threadTs) =>
                  void openMessage(channel, ts, threadTs)
                }
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
