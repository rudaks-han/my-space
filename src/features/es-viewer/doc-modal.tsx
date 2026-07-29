import { useEffect, useState } from "react"
import { toast } from "sonner"
import { CopyIcon, PencilIcon, XIcon } from "lucide-react"

import { JsonRaw, JsonTree } from "@/components/json-view"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** 편집 가능한 문서 컨텍스트. */
export interface EditableDoc {
  source: Record<string, unknown>
  onSave: (source: Record<string, unknown>) => Promise<void>
}

/**
 * 문서 상세(또는 _settings/_mapping) 모달.
 *  - JSON Viewer / Raw 탭 전환, 전체 확장·축소, Raw 복사.
 *  - `editable` 가 주어지면 ✏️ 편집(=_source 를 JSON 으로 수정) 버튼 노출.
 */
export function DocModal({
  title,
  value,
  editable,
  onClose,
}: {
  title: string
  value: unknown
  editable?: EditableDoc | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<"viewer" | "raw">("viewer")
  const [signal, setSignal] = useState({ version: 0, target: false })
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)

  // Esc 로 닫기. 부모가 열릴 때만 마운트하므로 내부 상태는 매번 새로 시작한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const enterEdit = () => {
    if (!editable) return
    setDraft(JSON.stringify(editable.source ?? {}, null, 2))
    setEditing(true)
  }

  const copyRaw = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      toast.success("복사되었습니다.")
    } catch {
      toast.error("복사에 실패했습니다.")
    }
  }

  const save = async () => {
    if (!editable) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(draft)
    } catch (e) {
      toast.error("JSON 파싱 오류: " + (e as Error).message)
      return
    }
    setSaving(true)
    try {
      await editable.onSave(parsed)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
        {/* 헤더 */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 className="truncate text-[15px] font-bold">{title}</h3>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="닫기"
          >
            <XIcon />
          </Button>
        </div>

        {/* 툴바 */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          {editing ? (
            <span className="text-[13px] font-semibold text-muted-foreground">
              _source 편집 (JSON)
            </span>
          ) : (
            <div className="flex gap-1">
              {(["viewer", "raw"] as const).map((t) => (
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
                  {t === "viewer" ? "JSON Viewer" : "Raw"}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            {editing ? (
              <>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                >
                  취소
                </Button>
                <Button size="xs" onClick={save} disabled={saving}>
                  {saving ? "저장 중…" : "저장"}
                </Button>
              </>
            ) : (
              <>
                {tab === "viewer" && (
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
                {tab === "raw" && (
                  <Button variant="ghost" size="xs" onClick={copyRaw}>
                    <CopyIcon />
                    복사
                  </Button>
                )}
                {editable && (
                  <Button variant="outline" size="xs" onClick={enterEdit}>
                    <PencilIcon />
                    편집
                  </Button>
                )}
              </>
            )}
          </div>
        </div>

        {/* 본문 */}
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="h-[50vh] w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid"
            />
          ) : tab === "viewer" ? (
            <JsonTree value={value} signal={signal} />
          ) : (
            <JsonRaw value={value} />
          )}
        </div>
      </div>
    </div>
  )
}
