import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { type GitStash } from "./git-client"

/** 모달 껍데기 — 어두운 배경 + 가운데 카드. Esc 와 배경 클릭으로 닫힌다. */
function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  footer: React.ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={
          "relative w-full rounded-[10px] border border-border bg-card p-5 shadow-[0_4px_16px_rgba(0,0,0,0.16)] " +
          (wide ? "max-w-xl" : "max-w-md")
        }
      >
        <h3 className="text-[15px] font-bold">{title}</h3>
        <div className="mt-3">{children}</div>
        <div className="mt-4 flex justify-end gap-2">{footer}</div>
      </div>
    </div>
  )
}

/** 되돌릴 수 없는 작업(롤백·삭제·보관 버리기) 확인. */
export function ConfirmDialog({
  title,
  confirmLabel,
  children,
  onCancel,
  onConfirm,
}: {
  title: string
  confirmLabel: string
  children: React.ReactNode
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            취소
          </Button>
          <Button size="sm" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </Modal>
  )
}

/**
 * 변경사항 보관(Stash Changes).
 *
 * `paths` 가 비어 있으면 저장소 전체를 보관한다. 추적되지 않는 파일은 기본으로 포함한다 —
 * 빼 두면 "보관했는데 새로 만든 파일이 그대로 남아" 있어 작업 트리가 깨끗해지지 않는다.
 */
export function StashDialog({
  paths,
  onCancel,
  onConfirm,
}: {
  /** 보관할 파일 경로. 비어 있으면 전체. */
  paths: string[]
  onCancel: () => void
  onConfirm: (message: string, includeUntracked: boolean) => void
}) {
  const [message, setMessage] = useState("")
  const [untracked, setUntracked] = useState(true)

  return (
    <Modal
      title="변경사항 보관"
      onClose={onCancel}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            취소
          </Button>
          <Button size="sm" onClick={() => onConfirm(message, untracked)}>
            보관
          </Button>
        </>
      }
    >
      <p className="text-[13px] text-muted-foreground">
        {paths.length
          ? `선택한 ${paths.length}개 파일의 변경을 따로 보관하고 작업 트리에서 되돌립니다.`
          : "작업 트리의 변경을 모두 보관하고 되돌립니다. 나중에 Unstash 로 되살릴 수 있습니다."}
      </p>
      <label className="mt-3 block">
        <span className="mb-1 block text-[13px] font-semibold">
          메시지(선택)
        </span>
        <Input
          autoFocus
          value={message}
          placeholder="예: 리뷰 대기 중인 작업"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(message, untracked)
          }}
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={untracked}
          onCheckedChange={(v) => setUntracked(v === true)}
        />
        <span>버전 관리 안 되는 파일도 포함</span>
      </label>
    </Modal>
  )
}

/** 보관 목록에서 되살리기(Unstash Changes) 또는 버리기. */
export function UnstashDialog({
  stashes,
  busy,
  onClose,
  onApply,
  onDrop,
}: {
  stashes: GitStash[]
  /** git 작업이 도는 중이면 버튼을 잠근다. */
  busy: boolean
  onClose: () => void
  /** `pop` 이면 되살린 뒤 목록에서 지운다. */
  onApply: (index: number, pop: boolean) => void
  onDrop: (index: number) => void
}) {
  return (
    <Modal
      title="보관한 변경"
      wide
      onClose={onClose}
      footer={
        <Button variant="outline" size="sm" onClick={onClose}>
          닫기
        </Button>
      }
    >
      {stashes.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          보관해 둔 변경이 없습니다.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto">
          {stashes.map((s) => (
            <div
              key={s.name}
              className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-ui-list-hover"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">
                  {s.message}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {s.name} · {s.date}
                </div>
              </div>
              <Button
                size="xs"
                disabled={busy}
                onClick={() => onApply(s.index, true)}
              >
                되살리기
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                title="보관은 남겨 두고 내용만 적용합니다"
                onClick={() => onApply(s.index, false)}
              >
                적용만
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy}
                className="text-ui-error"
                onClick={() => onDrop(s.index)}
              >
                버리기
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
