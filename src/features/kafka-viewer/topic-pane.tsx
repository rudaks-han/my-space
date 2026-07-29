import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangleIcon,
  RotateCwIcon,
  SearchIcon,
  SendIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTabActive } from "@/lib/use-tab-active"
import { cn } from "@/lib/utils"
import type {
  ConfigEntry,
  FetchResult,
  KafkaClient,
  KafkaRecord,
  PartitionInfo,
  SeekMode,
  TopicInfo,
} from "./kafka-client"
import {
  fmtBytes,
  fmtNum,
  fmtTime,
  localInputToMillis,
  preview,
} from "./kafka-utils"
import { MessageDetail } from "./message-detail"
import { ProduceDialog } from "./produce-dialog"
import { getTopicQuery, setTopicQuery, type TopicQuery } from "./persisted"

/** 자동 새로고침 주기. */
const LIVE_INTERVAL_MS = 5_000

const SUB_TABS = [
  { id: "messages", label: "메시지" },
  { id: "partitions", label: "파티션" },
  { id: "configs", label: "설정" },
] as const
type SubTab = (typeof SUB_TABS)[number]["id"]

const MODES: { id: SeekMode; label: string }[] = [
  { id: "latest", label: "최신부터" },
  { id: "earliest", label: "처음부터" },
  { id: "offset", label: "오프셋 지정" },
  { id: "timestamp", label: "시각 지정" },
]

const LIMITS = [50, 100, 200, 500, 1000]

const selectClass =
  "h-8 rounded-lg border border-input bg-background px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

/**
 * 토픽 하나의 패널 — 메시지 조회 / 파티션 / 설정.
 *
 * 상위 뷰가 열린 토픽마다 하나씩 mount 해 두고 `active` 로만 감춘다(keep-alive).
 * 그래서 탭을 오갈 때 데이터를 다시 읽지 않는다. 자동 새로고침만 예외적으로
 * "이 패널이 보이는 동안"에만 돌도록 `active` + `useTabActive()` 로 막는다.
 */
export function TopicPane({
  topic,
  meta,
  client,
  active,
}: {
  topic: string
  meta?: TopicInfo
  client: KafkaClient
  active: boolean
}) {
  const tabActive = useTabActive()
  const [sub, setSub] = useState<SubTab>("messages")
  const [query, setQuery] = useState<TopicQuery>(() => getTopicQuery(topic))

  const [result, setResult] = useState<FetchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [partitions, setPartitions] = useState<PartitionInfo[]>([])
  const [configs, setConfigs] = useState<ConfigEntry[] | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  const [detail, setDetail] = useState<KafkaRecord | null>(null)
  const [producing, setProducing] = useState(false)
  const [live, setLive] = useState(false)

  const patch = (p: Partial<TopicQuery>) => {
    const next = { ...query, ...p }
    setQuery(next)
    setTopicQuery(topic, next)
  }

  const runFetch = useCallback(
    async (q: TopicQuery) => {
      setLoading(true)
      setError(null)
      try {
        const res = await client.fetch({
          topic,
          partition: q.partition,
          mode: q.mode,
          offset: q.mode === "offset" ? Number(q.offset || "0") : null,
          timestamp:
            q.mode === "timestamp" ? localInputToMillis(q.timestamp) : null,
          limit: q.limit,
          search: q.search.trim() || null,
          pollMs: null,
        })
        setResult(res)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [client, topic]
  )

  const loadPartitions = useCallback(async () => {
    try {
      setPartitions(await client.partitions(topic))
    } catch {
      // 파티션 목록 실패는 조용히 무시(메시지 조회는 전체 파티션으로 가능).
    }
  }, [client, topic])

  // 최초 진입: 파티션 목록 + 첫 조회. 이후 탭을 오가도 다시 돌지 않는다.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void loadPartitions()
    void runFetch(getTopicQuery(topic))
  }, [loadPartitions, runFetch, topic])

  // 설정 탭은 처음 열 때만 읽는다.
  useEffect(() => {
    if (sub !== "configs" || configs !== null) return
    let cancelled = false
    void client
      .topicConfigs(topic)
      .then((c) => !cancelled && setConfigs(c))
      .catch((e) => !cancelled && setConfigError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [sub, configs, client, topic])

  // 자동 새로고침. 초기 로드와 분리된 별도 effect 로 두고, 이 패널이 실제로
  // 보이는 동안에만 돌린다(숨은 탭이 전부 폴링하는 것을 막는다).
  useEffect(() => {
    if (!live || !active || !tabActive) return
    const id = setInterval(() => {
      void runFetch(getTopicQuery(topic))
    }, LIVE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [live, active, tabActive, runFetch, topic])

  const totalMessages =
    result?.watermarks.reduce((sum, [, low, high]) => sum + (high - low), 0) ??
    meta?.messages ??
    null

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      aria-hidden={!active}
    >
      {/* 헤더 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="text-[15px] font-bold">{topic}</h2>
        <span className="text-[13px] text-muted-foreground">
          파티션 {meta?.partitions ?? partitions.length} · 복제{" "}
          {meta?.replication ?? "-"} · 메시지 {fmtNum(totalMessages)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setProducing(true)}
          >
            <SendIcon />
            전송
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => {
              void loadPartitions()
              void runFetch(query)
            }}
          >
            <RotateCwIcon className={cn(loading && "animate-spin")} />
            새로고침
          </Button>
        </div>
      </div>

      {/* 하위 탭 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-4 py-1.5">
        {SUB_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[13px] font-bold transition-colors",
              sub === t.id
                ? "bg-ui-selection text-ui-selection-fg"
                : "text-muted-foreground hover:bg-ui-list-hover"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {sub === "messages" && (
        <>
          {/* 조회 조건 */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <select
              value={query.partition === null ? "" : String(query.partition)}
              onChange={(e) =>
                patch({
                  partition: e.target.value === "" ? null : +e.target.value,
                })
              }
              className={selectClass}
              title="파티션"
            >
              <option value="">전체 파티션</option>
              {partitions.map((p) => (
                <option key={p.id} value={p.id}>
                  파티션 {p.id}
                </option>
              ))}
            </select>

            <select
              value={query.mode}
              onChange={(e) => patch({ mode: e.target.value as SeekMode })}
              className={selectClass}
              title="시작 위치"
            >
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            {query.mode === "offset" && (
              <Input
                type="number"
                value={query.offset}
                placeholder="시작 오프셋"
                onChange={(e) => patch({ offset: e.target.value })}
                className="h-8 w-32"
              />
            )}
            {query.mode === "timestamp" && (
              <Input
                type="datetime-local"
                value={query.timestamp}
                onChange={(e) => patch({ timestamp: e.target.value })}
                className="h-8 w-52"
              />
            )}

            <select
              value={query.limit}
              onChange={(e) => patch({ limit: +e.target.value })}
              className={selectClass}
              title="최대 건수"
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}건
                </option>
              ))}
            </select>

            <div className="relative min-w-40 flex-1">
              <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query.search}
                placeholder="키·값·헤더 포함 문자열…"
                onChange={(e) => patch({ search: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && void runFetch(query)}
                className="h-8 pl-8"
              />
            </div>

            <Button
              size="xs"
              disabled={loading}
              onClick={() => void runFetch(query)}
            >
              {loading ? "조회 중…" : "조회"}
            </Button>

            <label
              className="flex items-center gap-1.5 text-[13px] text-muted-foreground"
              title={`${LIVE_INTERVAL_MS / 1000}초마다 다시 조회`}
            >
              <input
                type="checkbox"
                checked={live}
                onChange={(e) => setLive(e.target.checked)}
              />
              자동
            </label>
          </div>

          {/* 결과 요약 */}
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 text-[13px] text-muted-foreground">
            {error ? (
              <span className="whitespace-pre-wrap text-ui-error">{error}</span>
            ) : result ? (
              <>
                <span>
                  <span className="font-bold text-foreground">
                    {fmtNum(result.records.length)}
                  </span>
                  건 표시 · {fmtNum(result.scanned)}건 스캔
                </span>
                {query.search.trim() && (
                  <span>필터: “{query.search.trim()}”</span>
                )}
                {result.truncated && (
                  <span className="flex items-center gap-1 text-ui-warning">
                    <AlertTriangleIcon className="size-3.5" />
                    최대 건수에서 잘렸습니다
                  </span>
                )}
                {result.timedOut && (
                  <span className="flex items-center gap-1 text-ui-warning">
                    <AlertTriangleIcon className="size-3.5" />
                    폴링 시간 초과 — 조건을 좁혀 보세요
                  </span>
                )}
              </>
            ) : (
              <span>조회 전</span>
            )}
          </div>

          {/* 메시지 목록 */}
          <div className="min-h-0 flex-1 overflow-auto">
            {result && result.records.length === 0 && !loading ? (
              <p className="px-4 py-6 text-[13px] text-muted-foreground">
                조건에 맞는 메시지가 없습니다.
              </p>
            ) : (
              <table className="w-full table-fixed text-[13px]">
                <thead className="sticky top-0 z-10 bg-card">
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="w-14 px-3 py-2 font-semibold">파티션</th>
                    <th className="w-28 px-3 py-2 font-semibold">오프셋</th>
                    <th className="w-40 px-3 py-2 font-semibold">시각</th>
                    <th className="w-48 px-3 py-2 font-semibold">키</th>
                    <th className="px-3 py-2 font-semibold">값</th>
                    <th className="w-20 px-3 py-2 text-right font-semibold">
                      크기
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result?.records.map((r) => (
                    <tr
                      key={`${r.partition}:${r.offset}`}
                      onClick={() => setDetail(r)}
                      className="cursor-pointer border-b border-border/60 hover:bg-ui-list-hover"
                    >
                      <td className="px-3 py-1.5 font-mono">{r.partition}</td>
                      <td className="px-3 py-1.5 font-mono">{r.offset}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">
                        {fmtTime(r.timestamp)}
                      </td>
                      <td
                        className="truncate px-3 py-1.5 font-mono"
                        title={r.key ?? "(null)"}
                      >
                        {r.key === null ? (
                          <span className="text-muted-foreground">(null)</span>
                        ) : (
                          preview(r.key, 80)
                        )}
                      </td>
                      <td className="truncate px-3 py-1.5 font-mono">
                        {preview(r.value)}
                      </td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">
                        {fmtBytes(r.size)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {sub === "partitions" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="sticky top-0 z-10 bg-card">
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="w-20 px-3 py-2 font-semibold">파티션</th>
                <th className="w-20 px-3 py-2 font-semibold">리더</th>
                <th className="px-3 py-2 font-semibold">복제본</th>
                <th className="px-3 py-2 font-semibold">ISR</th>
                <th className="px-3 py-2 text-right font-semibold">시작</th>
                <th className="px-3 py-2 text-right font-semibold">끝</th>
                <th className="px-3 py-2 text-right font-semibold">건수</th>
              </tr>
            </thead>
            <tbody>
              {partitions.map((p) => (
                <tr key={p.id} className="border-b border-border/60">
                  <td className="px-3 py-1.5 font-mono">{p.id}</td>
                  <td className="px-3 py-1.5 font-mono">{p.leader}</td>
                  <td className="px-3 py-1.5 font-mono">
                    {p.replicas.join(", ")}
                  </td>
                  <td className="px-3 py-1.5 font-mono">
                    <span
                      className={cn(
                        p.isr.length < p.replicas.length && "text-ui-error"
                      )}
                    >
                      {p.isr.join(", ")}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {fmtNum(p.low)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono">
                    {fmtNum(p.high)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono font-bold">
                    {fmtNum(p.high - p.low)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sub === "configs" && (
        <div className="min-h-0 flex-1 overflow-auto">
          {configError ? (
            <p className="px-4 py-6 text-[13px] whitespace-pre-wrap text-ui-error">
              {configError}
            </p>
          ) : configs === null ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              불러오는 중…
            </p>
          ) : (
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-card">
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="w-80 px-3 py-2 font-semibold">이름</th>
                  <th className="px-3 py-2 font-semibold">값</th>
                  <th className="w-40 px-3 py-2 font-semibold">출처</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((c) => (
                  <tr
                    key={c.name}
                    className={cn(
                      "border-b border-border/60",
                      c.isDefault && "text-muted-foreground"
                    )}
                  >
                    <td className="px-3 py-1.5 font-mono">
                      {c.name}
                      {!c.isDefault && (
                        <span className="ml-2 rounded-full bg-ui-info/15 px-1.5 text-[11px] font-bold text-ui-info">
                          지정됨
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 font-mono break-all">
                      {c.isSensitive ? "••••••" : (c.value ?? "-")}
                    </td>
                    <td className="px-3 py-1.5 text-[11px]">{c.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {detail && (
        <MessageDetail
          topic={topic}
          record={detail}
          onClose={() => setDetail(null)}
        />
      )}
      {producing && (
        <ProduceDialog
          topic={topic}
          partitions={partitions.map((p) => p.id)}
          client={client}
          onClose={() => setProducing(false)}
          onSent={() => void runFetch(query)}
        />
      )}
    </div>
  )
}
