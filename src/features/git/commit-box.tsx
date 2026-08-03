import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

/**
 * 커밋 메시지 입력 + 커밋 버튼. 체크한 파일만 커밋되므로 개수를 버튼에 함께 쓴다.
 * ⌘Enter 는 커밋(IntelliJ 커밋 창과 같은 단축키).
 */
export function CommitBox({
  message,
  count,
  amend,
  disabled,
  onMessage,
  onAmend,
  onCommit,
  onCommitPush,
}: {
  message: string
  /** 커밋에 들어갈 파일 수. */
  count: number
  amend: boolean
  /** 다른 git 작업이 도는 중이면 잠근다. */
  disabled: boolean
  onMessage: (v: string) => void
  onAmend: (v: boolean) => void
  onCommit: () => void
  onCommitPush: () => void
}) {
  const ready = count > 0 && message.trim().length > 0 && !disabled

  return (
    <div className="shrink-0 border-t border-border p-3">
      <textarea
        value={message}
        onChange={(e) => onMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && ready) {
            e.preventDefault()
            onCommit()
          }
        }}
        rows={3}
        placeholder="커밋 메시지"
        className="w-full resize-y rounded-lg border border-input bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
      />
      <label className="mt-2 flex items-center gap-2 text-[13px]">
        <Checkbox
          checked={amend}
          onCheckedChange={(v) => onAmend(v === true)}
          disabled={disabled}
        />
        <span>마지막 커밋 수정(amend)</span>
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" disabled={!ready} onClick={onCommit}>
          커밋 {count > 0 && `(${count})`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!ready}
          onClick={onCommitPush}
        >
          커밋 후 푸시
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">⌘↵</span>
      </div>
    </div>
  )
}
