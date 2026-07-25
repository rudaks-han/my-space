import {
  AtSignIcon,
  CheckCheckIcon,
  HashIcon,
  ListChecksIcon,
  LockIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  ReplyIcon,
  UsersIcon,
} from "lucide-react"
import { useMemo, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"

import { friendlyError } from "./slack-errors"
import {
  useSlack,
  type ChannelInfo,
  type ChannelKind,
  type ChannelUnread,
} from "./use-slack"

function formatTs(ts: string): string {
  const sec = parseFloat(ts)
  if (!sec) return ""
  const d = new Date(sec * 1000)
  const time = d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const sameDay = d.toDateString() === new Date().toDateString()
  if (sameDay) return time
  const date = d.toLocaleDateString("ko-KR", {
    month: "numeric",
    day: "numeric",
  })
  return `${date} ${time}`
}

const KIND_ICON: Record<ChannelKind, typeof HashIcon> = {
  channel: HashIcon,
  private: LockIcon,
  mpim: UsersIcon,
  im: AtSignIcon,
}

function ChannelCard({
  channel,
  onOpen,
  onMarkRead,
}: {
  channel: ChannelUnread
  onOpen: (channel: string, ts: string, threadTs: string | null) => void
  onMarkRead: (channel: string, ts: string) => void
}) {
  const Icon = KIND_ICON[channel.kind]
  // 메시지는 오래된→최신 순이라 마지막이 가장 최신. 이 ts 까지 읽음 처리한다.
  const newestTs = channel.messages.at(-1)?.ts
  // 스레드 답글만 있는 채널은 conversations.mark 로 해제되지 않으므로 버튼을 흐리게 안내한다.
  const onlyThreads = channel.messages.every((m) => m.thread_ts)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-muted-foreground" />
          <span className="truncate">{channel.name}</span>
          <Badge variant="secondary" className="ml-auto">
            {channel.unread}
            {channel.has_more ? "+" : ""}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={!newestTs}
            title={
              onlyThreads
                ? "스레드 답글은 읽음 처리되지 않을 수 있습니다(Slack 앱에서 열어 확인하세요)"
                : "이 채널을 읽음 처리"
            }
            onClick={() => newestTs && onMarkRead(channel.id, newestTs)}
          >
            <CheckCheckIcon />
            읽음
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {channel.messages.map((m, i) => (
          <div
            key={`${m.ts}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              // 텍스트를 드래그로 선택 중이면 열지 않는다(복사 허용). 선택 없이 클릭하면 열기.
              if (window.getSelection()?.toString()) return
              onOpen(channel.id, m.ts, m.thread_ts)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onOpen(channel.id, m.ts, m.thread_ts)
            }}
            title={m.thread_ts ? "Slack 스레드에서 열기" : "Slack 앱에서 열기"}
            className="ui-selectable flex cursor-pointer flex-col gap-0.5 rounded-md border bg-muted/30 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-semibold">{m.user}</span>
              {m.thread_ts && (
                <span className="flex items-center gap-0.5 rounded bg-primary/10 px-1 text-[10px] font-medium text-primary">
                  <ReplyIcon className="size-2.5" />
                  스레드
                </span>
              )}
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTs(m.ts)}
              </span>
            </div>
            <p className="text-sm break-words whitespace-pre-wrap text-foreground/90">
              {m.text || "(첨부 파일 또는 빈 메시지)"}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
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

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return channels
    return channels.filter((c) => c.name.toLowerCase().includes(q))
  }, [channels, filter])

  function toggle(id: string, on: boolean) {
    setDraft((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-sm">표시할 채널 선택</CardTitle>
            <CardDescription>
              체크한 채널의 안 읽은 메시지만 가져옵니다. 선택은 저장됩니다.
              {fetchedAt && (
                <>
                  {" · "}
                  <span className="tabular-nums">
                    목록{" "}
                    {new Date(fetchedAt).toLocaleTimeString("ko-KR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    캐시됨
                  </span>
                </>
              )}
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            title="채널 목록을 다시 가져옵니다"
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
            새로고침
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Input
          placeholder="채널 이름 검색…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="ui-selectable"
        />

        {loading && channels.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            채널 목록을 불러오는 중…
          </p>
        ) : (
          <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {visible.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                일치하는 채널이 없습니다.
              </p>
            ) : (
              visible.map((c) => {
                const Icon = KIND_ICON[c.kind]
                const checked = draft.has(c.id)
                return (
                  <label
                    key={c.id}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => toggle(c.id, v === true)}
                    />
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {KIND_LABEL[c.kind]}
                    </span>
                  </label>
                )
              })
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {draft.size}개 선택됨
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              취소
            </Button>
            <Button size="sm" onClick={() => onSave([...draft])}>
              저장
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
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
    markRead,
    markAllRead,
    openMessage,
  } = useSlack()

  const [pickerOpen, setPickerOpen] = useState(false)

  // 연결 상태 확인 중
  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  // 연결·연결 해제는 설정으로 옮겼다. 미연결이면 설정으로 안내한다.
  if (!status.connected) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-center">
        <MessageSquareIcon className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
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
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MessageSquareIcon className="size-4" />
          <span>
            {status.team ?? "Slack"}
            {status.user ? ` · ${status.user}` : ""}
          </span>
          {updatedAt && (
            <span className="tabular-nums">
              ·{" "}
              {new Date(updatedAt).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              업데이트
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openPicker}>
            <ListChecksIcon />
            채널 선택{selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
          {channels.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void markAllRead()}
              disabled={loading}
              title="보이는 모든 채널을 읽음 처리 (스레드 답글은 제외될 수 있음)"
            >
              <CheckCheckIcon />
              모두 읽음
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
            새로고침
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
            <p className="text-sm text-muted-foreground">
              아직 선택한 채널이 없습니다. 볼 채널을 골라주세요.
            </p>
            <Button size="sm" onClick={openPicker}>
              <ListChecksIcon />
              채널 선택
            </Button>
          </div>
        )
      ) : loading && channels.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          안 읽은 메시지를 불러오는 중…
        </div>
      ) : channels.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 py-16 text-center">
          <p className="text-lg">🎉</p>
          <p className="text-sm text-muted-foreground">
            선택한 채널에 안 읽은 메시지가 없습니다.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {channels.length}개 채널 · 안 읽음 {totalUnread}
            {channels.some((c) => c.has_more) ? "+" : ""}개
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {channels.map((c) => (
              <ChannelCard
                key={c.id}
                channel={c}
                onOpen={(channel, ts, threadTs) =>
                  void openMessage(channel, ts, threadTs)
                }
                onMarkRead={(channel, ts) => void markRead(channel, ts)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
