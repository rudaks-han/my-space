import { useEffect, useState } from "react"
import { toast } from "sonner"
import { SendIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { KafkaClient } from "./kafka-client"

/**
 * 메시지 전송 다이얼로그.
 * 헤더는 `key: value` 한 줄에 하나로 입력받는다(kafka-ui 의 헤더 입력과 같은 형태).
 */
export function ProduceDialog({
  topic,
  partitions,
  client,
  onClose,
  onSent,
}: {
  topic: string
  partitions: number[]
  client: KafkaClient
  onClose: () => void
  onSent: () => void
}) {
  const [partition, setPartition] = useState<string>("")
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [headerText, setHeaderText] = useState("")
  const [sending, setSending] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose, sending])

  const send = async () => {
    // `key: value` 줄만 헤더로 인정하고, 콜론 없는 줄은 무시한다.
    const headers: [string, string][] = headerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(":")
        return i < 0
          ? null
          : ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as [
              string,
              string,
            ])
      })
      .filter((h): h is [string, string] => h !== null)

    setSending(true)
    try {
      const res = await client.produce({
        topic,
        partition: partition === "" ? null : Number(partition),
        key: key === "" ? null : key,
        value,
        headers,
      })
      toast.success(`전송 완료 — 파티션 ${res.partition}, 오프셋 ${res.offset}`)
      onSent()
      onClose()
    } catch (e) {
      toast.error(`전송 실패: ${(e as Error).message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => !sending && onClose()}
        aria-hidden
      />
      <div className="relative flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="truncate text-[15px] font-bold">
            메시지 전송 · {topic}
          </h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            disabled={sending}
            aria-label="닫기"
          >
            <XIcon />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">파티션</span>
            <select
              value={partition}
              onChange={(e) => setPartition(e.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2.5 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
            >
              <option value="">자동 (키 해시 / 라운드로빈)</option>
              {partitions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">키 (선택)</span>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="비우면 키 없음(null)"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">값</span>
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              rows={8}
              placeholder='{"example": true}'
              className="w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">
              헤더 (선택) — 한 줄에 <code>key: value</code>
            </span>
            <textarea
              value={headerText}
              onChange={(e) => setHeaderText(e.target.value)}
              spellCheck={false}
              rows={3}
              placeholder={"traceId: abc-123\nsource: my-space"}
              className="w-full resize-y rounded-lg border border-input bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
            disabled={sending}
          >
            취소
          </Button>
          <Button size="sm" onClick={() => void send()} disabled={sending}>
            <SendIcon />
            {sending ? "전송 중…" : "전송"}
          </Button>
        </div>
      </div>
    </div>
  )
}
