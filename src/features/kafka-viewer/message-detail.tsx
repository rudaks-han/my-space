import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { CopyIcon, XIcon } from "lucide-react"

import { JsonRaw, JsonTree } from "@/components/json-view"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { KafkaRecord } from "./kafka-client"
import { fmtBytes, fmtTimeFull, tryParseJson } from "./kafka-utils"

/**
 * 메시지 한 건의 상세 — 메타/헤더/키/값.
 * 값이 JSON 객체·배열이면 트리 뷰를, 아니면 원문을 보여 준다.
 */
export function MessageDetail({
  topic,
  record,
  onClose,
}: {
  topic: string
  record: KafkaRecord
  onClose: () => void
}) {
  const parsed = useMemo(() => tryParseJson(record.value), [record.value])
  const [tab, setTab] = useState<"tree" | "raw" | "text">(
    parsed ? "tree" : "text"
  )
  const [signal, setSignal] = useState({ version: 0, target: false })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what}을(를) 복사했습니다.`)
    } catch {
      toast.error("복사에 실패했습니다.")
    }
  }

  const meta: [string, string][] = [
    ["토픽", topic],
    ["파티션", String(record.partition)],
    ["오프셋", String(record.offset)],
    ["시각", fmtTimeFull(record.timestamp)],
    ["크기", fmtBytes(record.size)],
  ]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="truncate text-[15px] font-bold">
            파티션 {record.partition} · 오프셋 {record.offset}
          </h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="닫기"
          >
            <XIcon />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {/* 메타 */}
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            {meta.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="truncate font-mono">{v}</dd>
              </div>
            ))}
          </dl>

          {/* 키 */}
          <section className="mb-4">
            <div className="mb-1.5 flex items-center gap-2">
              <h4 className="text-[15px] font-semibold">키</h4>
              {record.keyBinary && (
                <span className="rounded-full bg-ui-warning/15 px-2 py-0.5 text-[11px] font-bold text-ui-warning">
                  base64
                </span>
              )}
              {record.key !== null && (
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => copy(record.key ?? "", "키")}
                >
                  <CopyIcon />
                  복사
                </Button>
              )}
            </div>
            <pre className="overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[13px] whitespace-pre-wrap">
              {record.key ?? "(null)"}
            </pre>
          </section>

          {/* 헤더 */}
          {record.headers.length > 0 && (
            <section className="mb-4">
              <h4 className="mb-1.5 text-[15px] font-semibold">
                헤더 ({record.headers.length})
              </h4>
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full text-[13px]">
                  <tbody>
                    {record.headers.map(([k, v], i) => (
                      <tr
                        key={`${k}:${i}`}
                        className="border-b border-border last:border-0"
                      >
                        <td className="w-48 px-3 py-1.5 font-mono font-semibold">
                          {k}
                        </td>
                        <td className="px-3 py-1.5 font-mono break-all">
                          {v ?? "(null)"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 값 */}
          <section>
            <div className="mb-1.5 flex items-center gap-2">
              <h4 className="text-[15px] font-semibold">값</h4>
              {record.valueBinary && (
                <span className="rounded-full bg-ui-warning/15 px-2 py-0.5 text-[11px] font-bold text-ui-warning">
                  base64
                </span>
              )}
              <div className="flex gap-1">
                {(
                  [
                    ...(parsed ? (["tree", "raw"] as const) : []),
                    "text",
                  ] as const
                ).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={cn(
                      "rounded-lg px-2.5 py-1 text-[13px] font-bold transition-colors",
                      tab === t
                        ? "bg-ui-selection text-ui-selection-fg"
                        : "text-muted-foreground hover:bg-ui-list-hover"
                    )}
                  >
                    {t === "tree" ? "JSON" : t === "raw" ? "Pretty" : "원문"}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex gap-1">
                {tab === "tree" && (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setSignal((s) => ({
                          version: s.version + 1,
                          target: false,
                        }))
                      }
                    >
                      전체 확장
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        setSignal((s) => ({
                          version: s.version + 1,
                          target: true,
                        }))
                      }
                    >
                      전체 축소
                    </Button>
                  </>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => copy(record.value ?? "", "값")}
                >
                  <CopyIcon />
                  복사
                </Button>
              </div>
            </div>
            {tab === "tree" && parsed ? (
              <JsonTree value={parsed} signal={signal} />
            ) : tab === "raw" && parsed ? (
              <JsonRaw value={parsed} />
            ) : (
              <pre className="overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[13px] whitespace-pre-wrap">
                {record.value ?? "(null)"}
              </pre>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
