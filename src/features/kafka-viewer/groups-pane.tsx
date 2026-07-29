import { useCallback, useEffect, useRef, useState } from "react"
import { RotateCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { GroupInfo, GroupOffset, KafkaClient } from "./kafka-client"
import { fmtNum } from "./kafka-utils"

/** 그룹 상태별 색. Empty(=붙은 컨슈머 없음)는 경고로 본다. */
const STATE_COLOR: Record<string, string> = {
  Stable: "text-ui-success",
  Empty: "text-ui-warning",
  Dead: "text-ui-error",
  PreparingRebalance: "text-ui-warning",
  CompletingRebalance: "text-ui-warning",
}

/**
 * 컨슈머 그룹 패널 — 왼쪽 그룹 목록, 오른쪽 선택 그룹의 파티션별 lag.
 *
 * lag 은 그룹을 고를 때만 조회한다(전체 토픽의 커밋 오프셋을 읽어야 해서 무겁다).
 * 조회는 OffsetFetch 만 보내므로 운영 중인 컨슈머의 리밸런싱을 유발하지 않는다.
 */
export function GroupsPane({
  client,
  topics,
  active,
}: {
  client: KafkaClient
  topics: string[]
  active: boolean
}) {
  const [groups, setGroups] = useState<GroupInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [offsets, setOffsets] = useState<GroupOffset[] | null>(null)
  const [offsetsLoading, setOffsetsLoading] = useState(false)
  const [offsetsError, setOffsetsError] = useState<string | null>(null)

  const loadGroups = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setGroups(await client.groups())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [client])

  const loadOffsets = useCallback(
    async (group: string) => {
      setSelected(group)
      setOffsets(null)
      setOffsetsError(null)
      setOffsetsLoading(true)
      try {
        setOffsets(await client.groupOffsets(group, topics))
      } catch (e) {
        setOffsetsError((e as Error).message)
      } finally {
        setOffsetsLoading(false)
      }
    },
    [client, topics]
  )

  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void loadGroups()
  }, [loadGroups])

  const totalLag = offsets?.reduce((s, o) => s + o.lag, 0) ?? 0
  const current = groups.find((g) => g.name === selected)

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      aria-hidden={!active}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-[15px] font-bold">컨슈머 그룹</h2>
        <span className="text-[13px] text-muted-foreground">
          {fmtNum(groups.length)}개
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto"
          disabled={loading}
          onClick={() => void loadGroups()}
        >
          <RotateCwIcon className={cn(loading && "animate-spin")} />
          새로고침
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 그룹 목록 */}
        <div className="w-72 shrink-0 overflow-auto border-r border-border">
          {error ? (
            <p className="px-4 py-6 text-[13px] whitespace-pre-wrap text-ui-error">
              {error}
            </p>
          ) : groups.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              {loading ? "불러오는 중…" : "컨슈머 그룹이 없습니다."}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5 p-1.5">
              {groups.map((g) => (
                <li key={g.name}>
                  <button
                    onClick={() => void loadOffsets(g.name)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                      g.name === selected
                        ? "bg-ui-selection text-ui-selection-fg"
                        : "hover:bg-ui-list-hover"
                    )}
                  >
                    <span
                      className="truncate text-[13px] font-bold"
                      title={g.name}
                    >
                      {g.name}
                    </span>
                    <span
                      className={cn(
                        "text-[11px]",
                        g.name === selected
                          ? "text-ui-selection-fg/80"
                          : (STATE_COLOR[g.state] ?? "text-muted-foreground")
                      )}
                    >
                      {g.state} · 멤버 {g.members.length}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 선택 그룹 상세 */}
        <div className="min-w-0 flex-1 overflow-auto">
          {!current ? (
            <p className="px-4 py-6 text-[13px] text-muted-foreground">
              그룹을 선택하면 파티션별 lag 이 표시됩니다.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <h3 className="text-[15px] font-bold">{current.name}</h3>
                <span className="text-[13px] text-muted-foreground">
                  {current.state} · {current.protocolType || "-"}/
                  {current.protocol || "-"}
                </span>
                <span className="ml-auto text-[13px]">
                  총 lag{" "}
                  <span
                    className={cn(
                      "font-bold",
                      totalLag > 0 ? "text-ui-warning" : "text-ui-success"
                    )}
                  >
                    {fmtNum(totalLag)}
                  </span>
                </span>
              </div>

              {current.members.length > 0 && (
                <div className="px-4 pb-2">
                  <h4 className="mb-1 text-[13px] font-semibold text-muted-foreground">
                    멤버
                  </h4>
                  <ul className="flex flex-col gap-0.5 text-[13px]">
                    {current.members.map((m) => (
                      <li key={m.id} className="font-mono">
                        {m.clientId}
                        <span className="text-muted-foreground">
                          {" "}
                          @ {m.clientHost}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {offsetsError ? (
                <p className="px-4 py-4 text-[13px] whitespace-pre-wrap text-ui-error">
                  {offsetsError}
                </p>
              ) : offsetsLoading ? (
                <p className="px-4 py-4 text-[13px] text-muted-foreground">
                  커밋 오프셋을 읽는 중…
                </p>
              ) : offsets && offsets.length === 0 ? (
                <p className="px-4 py-4 text-[13px] text-muted-foreground">
                  커밋된 오프셋이 없습니다.
                </p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-3 py-2 font-semibold">토픽</th>
                      <th className="w-20 px-3 py-2 font-semibold">파티션</th>
                      <th className="px-3 py-2 text-right font-semibold">
                        커밋
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        끝(high)
                      </th>
                      <th className="px-3 py-2 text-right font-semibold">
                        lag
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {offsets?.map((o) => (
                      <tr
                        key={`${o.topic}:${o.partition}`}
                        className="border-b border-border/60"
                      >
                        <td className="px-3 py-1.5 font-mono">{o.topic}</td>
                        <td className="px-3 py-1.5 font-mono">{o.partition}</td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {fmtNum(o.committed)}
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {fmtNum(o.high)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-1.5 text-right font-mono font-bold",
                            o.lag > 0 ? "text-ui-warning" : "text-ui-success"
                          )}
                        >
                          {fmtNum(o.lag)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
