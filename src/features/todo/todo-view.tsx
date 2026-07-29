import { useState } from "react"
import { PlusIcon, StickyNoteIcon, Trash2Icon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import {
  STICKY_COLORS,
  useStickies,
  type StickyColor,
  type StickyNote,
} from "./use-todos"

/**
 * 포스트잇 색상 → 강조색(CSS 변수).
 * 팔레트 하드코딩(#FDE68A 등) 대신 테마 차트 토큰을 써서 프리셋/다크 모드를 따라가게 한다.
 * 카드는 이 색을 `--sticky-accent` 로 내려 주고, 배경/테두리/hover 는 모두
 * color-mix 로 옅게 섞어 쓴다(원색을 그대로 깔면 본문 대비가 무너진다).
 */
const ACCENT: Record<StickyColor, string> = {
  yellow: "var(--chart-3)",
  pink: "var(--chart-4)",
  green: "var(--chart-2)",
  blue: "var(--chart-1)",
  purple: "var(--chart-5)",
  gray: "var(--muted-foreground)",
}

const COLOR_LABEL: Record<StickyColor, string> = {
  yellow: "노랑",
  pink: "분홍",
  green: "초록",
  blue: "파랑",
  purple: "보라",
  gray: "회색",
}

type Api = ReturnType<typeof useStickies>

function StickyCard({ note, api }: { note: StickyNote; api: Api }) {
  const [draft, setDraft] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")

  const remaining = note.todos.filter((t) => !t.done).length

  const submitTodo = (e: React.FormEvent) => {
    e.preventDefault()
    api.addTodo(note.id, draft)
    setDraft("")
  }

  const commitEdit = () => {
    if (editingId) {
      if (editingText.trim()) api.updateTodo(note.id, editingId, editingText)
      else api.removeTodo(note.id, editingId)
    }
    setEditingId(null)
    setEditingText("")
  }

  return (
    <div
      style={{ "--sticky-accent": ACCENT[note.color] } as React.CSSProperties}
      className="flex min-w-0 flex-col rounded-[10px] border border-[color-mix(in_oklab,var(--sticky-accent)_28%,var(--border))] bg-[color-mix(in_oklab,var(--sticky-accent)_12%,var(--card))] shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
    >
      {/* 헤더 — Slack 패널 헤더 톤(굵은 15px 제목 + 배경색 없음). */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_oklab,var(--sticky-accent)_22%,var(--border))] px-4 py-3">
        <span className="size-2.5 shrink-0 rounded-full bg-(--sticky-accent)" />
        <input
          value={note.title}
          onChange={(e) => api.setTitle(note.id, e.target.value)}
          placeholder="제목 없음"
          className="min-w-0 flex-1 bg-transparent text-[15px] font-bold placeholder:font-normal placeholder:text-muted-foreground focus:outline-none"
        />
        {note.todos.length > 0 && (
          <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--sticky-accent)_20%,transparent)] px-2 text-[11px] font-bold text-muted-foreground tabular-nums">
            {remaining}/{note.todos.length}
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => api.removeNote(note.id)}
          aria-label="포스트잇 삭제"
          title="포스트잇 삭제"
          className="text-muted-foreground hover:text-foreground"
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>

      {/* 할 일 목록 — Slack 리스트 행(36px, 8px 라운드, 행 테두리 없음). */}
      <ul className="flex flex-col gap-0.5 p-2">
        {note.todos.map((t) => (
          <li
            key={t.id}
            className="group flex min-h-9 items-start gap-2.5 rounded-lg px-3 py-1.5 transition-colors hover:bg-[color-mix(in_oklab,var(--sticky-accent)_16%,transparent)]"
          >
            <Checkbox
              checked={t.done}
              onCheckedChange={() => api.toggleTodo(note.id, t.id)}
              className="mt-[3px] shrink-0"
            />
            {editingId === t.id ? (
              <input
                value={editingText}
                autoFocus
                onChange={(e) => setEditingText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit()
                  if (e.key === "Escape") {
                    setEditingId(null)
                    setEditingText("")
                  }
                }}
                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-2 py-0.5 text-[15px] focus:border-ring focus:outline-none"
              />
            ) : (
              <span
                className={cn(
                  // min-w-0 + wrap-anywhere 가 없으면 공백 없는 긴 문자열이
                  // flex 항목의 min-content 를 밀어 카드 밖으로 삐져나간다.
                  "min-w-0 flex-1 cursor-text py-0.5 text-[15px] wrap-anywhere",
                  t.done && "text-muted-foreground line-through"
                )}
                onDoubleClick={() => {
                  setEditingId(t.id)
                  setEditingText(t.text)
                }}
                title="더블클릭하여 수정"
              >
                {t.text}
              </span>
            )}
            <button
              type="button"
              onClick={() => api.removeTodo(note.id, t.id)}
              aria-label="할 일 삭제"
              className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-[color-mix(in_oklab,var(--sticky-accent)_28%,transparent)] hover:text-foreground"
            >
              <XIcon className="size-4" />
            </button>
          </li>
        ))}
        {note.todos.length === 0 && (
          <li className="flex min-h-9 items-center px-3 text-[15px] text-muted-foreground">
            아래에 할 일을 추가하세요.
          </li>
        )}

        <li>
          <form
            onSubmit={submitTodo}
            className="flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 transition-colors focus-within:bg-[color-mix(in_oklab,var(--sticky-accent)_16%,transparent)]"
          >
            <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="할 일 추가 후 Enter"
              className="min-w-0 flex-1 bg-transparent text-[15px] placeholder:text-muted-foreground focus:outline-none"
            />
          </form>
        </li>
      </ul>

      {/* 색 선택 — Slack 은 원형 점을 쓴다. 고른 색만 파란 포커스 링으로 표시한다. */}
      <div className="flex items-center gap-2.5 border-t border-[color-mix(in_oklab,var(--sticky-accent)_22%,var(--border))] px-4 py-3">
        {STICKY_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => api.setColor(note.id, c)}
            aria-label={`${COLOR_LABEL[c]}으로 변경`}
            title={COLOR_LABEL[c]}
            style={{ backgroundColor: ACCENT[c] }}
            className={cn(
              "size-4 cursor-pointer rounded-full transition-transform hover:scale-110",
              note.color === c &&
                "outline-2 outline-offset-2 outline-ring outline-solid"
            )}
          />
        ))}
      </div>
    </div>
  )
}

export function TodoView() {
  const api = useStickies()
  const { notes, addNote } = api

  return (
    <div className="flex w-full flex-col gap-3">
      {/* 뷰 툴바 — 제목은 위쪽 뷰 헤더가 이미 보여 주므로 개수 메타와 액션만 둔다. */}
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[13px] text-muted-foreground tabular-nums">
          포스트잇 {notes.length}개
        </span>
        <Button size="sm" className="ml-auto" onClick={addNote}>
          <PlusIcon />
          포스트잇 추가
        </Button>
      </div>

      {notes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center text-[15px] text-muted-foreground">
          <StickyNoteIcon className="size-6" />
          아직 포스트잇이 없습니다. “포스트잇 추가”로 시작하세요.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((note) => (
            <StickyCard key={note.id} note={note} api={api} />
          ))}
        </div>
      )}
    </div>
  )
}
