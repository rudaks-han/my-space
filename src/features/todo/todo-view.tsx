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

/** 포스트잇 색상 → 실제 Tailwind 클래스(라이트/다크 모두 대응). */
const PALETTE: Record<StickyColor, { card: string; swatch: string }> = {
  yellow: {
    card: "bg-yellow-100 border-yellow-300 dark:bg-yellow-400/10 dark:border-yellow-400/30",
    swatch: "bg-yellow-300 dark:bg-yellow-400",
  },
  pink: {
    card: "bg-pink-100 border-pink-300 dark:bg-pink-400/10 dark:border-pink-400/30",
    swatch: "bg-pink-300 dark:bg-pink-400",
  },
  green: {
    card: "bg-green-100 border-green-300 dark:bg-green-400/10 dark:border-green-400/30",
    swatch: "bg-green-300 dark:bg-green-400",
  },
  blue: {
    card: "bg-blue-100 border-blue-300 dark:bg-blue-400/10 dark:border-blue-400/30",
    swatch: "bg-blue-300 dark:bg-blue-400",
  },
  purple: {
    card: "bg-purple-100 border-purple-300 dark:bg-purple-400/10 dark:border-purple-400/30",
    swatch: "bg-purple-300 dark:bg-purple-400",
  },
  gray: {
    card: "bg-gray-100 border-gray-300 dark:bg-gray-400/10 dark:border-gray-400/30",
    swatch: "bg-gray-300 dark:bg-gray-400",
  },
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

function StickyCard({
  note,
  api,
}: {
  note: StickyNote
  api: Api
}) {
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
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-3 shadow-sm",
        PALETTE[note.color].card,
      )}
    >
      <div className="flex items-center gap-2">
        <input
          value={note.title}
          onChange={(e) => api.setTitle(note.id, e.target.value)}
          placeholder="제목 없음"
          className="min-w-0 flex-1 bg-transparent text-sm font-semibold placeholder:text-muted-foreground/70 focus:outline-none"
        />
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {note.todos.length > 0 && `${remaining}/${note.todos.length}`}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => api.removeNote(note.id)}
          aria-label="포스트잇 삭제"
          title="포스트잇 삭제"
        >
          <Trash2Icon />
        </Button>
      </div>

      <ul className="flex flex-col gap-1">
        {note.todos.map((t) => (
          <li key={t.id} className="group flex items-start gap-2">
            <Checkbox
              checked={t.done}
              onCheckedChange={() => api.toggleTodo(note.id, t.id)}
              className="mt-0.5 bg-background/60"
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
                className="min-w-0 flex-1 border-b border-foreground/20 bg-transparent text-sm focus:outline-none"
              />
            ) : (
              <span
                className={cn(
                  "flex-1 cursor-text text-sm break-words",
                  t.done && "text-muted-foreground line-through",
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
              className="text-muted-foreground shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
        {note.todos.length === 0 && (
          <li className="text-muted-foreground py-1 text-xs">
            아래에 할 일을 추가하세요.
          </li>
        )}
      </ul>

      <form onSubmit={submitTodo} className="flex items-center gap-1.5">
        <PlusIcon className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="할 일 추가 후 Enter"
          className="min-w-0 flex-1 bg-transparent text-sm placeholder:text-muted-foreground/70 focus:outline-none"
        />
      </form>

      <div className="flex items-center gap-1.5 border-t border-foreground/10 pt-2">
        {STICKY_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => api.setColor(note.id, c)}
            aria-label={`${COLOR_LABEL[c]}으로 변경`}
            title={COLOR_LABEL[c]}
            className={cn(
              "size-4 rounded-full ring-offset-1 transition",
              PALETTE[c].swatch,
              note.color === c
                ? "ring-2 ring-foreground/50 ring-offset-transparent"
                : "hover:scale-110",
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
    <div className="flex w-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold">할 일</h2>
          <p className="text-muted-foreground text-sm">
            포스트잇 {notes.length}개
          </p>
        </div>
        <Button onClick={addNote}>
          <PlusIcon />
          포스트잇 추가
        </Button>
      </div>

      {notes.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
          <StickyNoteIcon className="size-8 opacity-60" />
          <p className="text-sm">
            아직 포스트잇이 없습니다. “포스트잇 추가”로 시작하세요.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {notes.map((note) => (
            <StickyCard key={note.id} note={note} api={api} />
          ))}
        </div>
      )}
    </div>
  )
}
