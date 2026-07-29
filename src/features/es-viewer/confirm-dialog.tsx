import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * 되돌릴 수 없는 작업(인덱스/문서 삭제) 확인 다이얼로그.
 * `requireText` 가 주어지면 그 문자열을 그대로 입력해야 확인 버튼이 활성화된다.
 * 부모가 열릴 때만 마운트하므로(조건부 렌더) 내부 상태는 매번 새로 시작한다.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  requireText,
  children,
  onCancel,
  onConfirm,
}: {
  title: string
  confirmLabel: string
  requireText?: string
  children: React.ReactNode
  onCancel: () => void
  onConfirm: () => void
}) {
  const [text, setText] = useState("")

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onCancel])

  const ready = !requireText || text.trim() === requireText

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        aria-hidden
      />
      <div className="relative w-full max-w-md rounded-[10px] border border-border bg-card p-5 shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
        <h3 className="text-[15px] font-bold">{title}</h3>
        <div className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {children}
        </div>
        {requireText && (
          <label className="mt-3 block">
            <span className="mb-1 block text-[13px] font-semibold">
              확인을 위해 이름을 그대로 입력하세요
            </span>
            <Input
              autoFocus
              value={text}
              placeholder={requireText}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) onConfirm()
              }}
            />
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            취소
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={onConfirm}
            className="bg-ui-error text-white hover:bg-ui-error/90"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
