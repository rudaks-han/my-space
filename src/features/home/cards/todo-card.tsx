import { CheckSquareIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import type { StickyNote } from "@/features/todo/use-todos"
import { HomeCard, HomeEmpty } from "../home-card"

/** 홈에 보여줄 최대 할 일 수. */
const MAX_ROWS = 6

/**
 * 남은 할 일 — 모든 포스트잇의 미완료 항목을 모아 보여준다.
 * 체크하면 바로 완료 처리된다(포스트잇 화면과 같은 저장소).
 */
export function TodoCard({
  notes,
  onToggle,
}: {
  notes: StickyNote[]
  onToggle: (noteId: string, todoId: string) => void
}) {
  const all = notes.flatMap((n) => n.todos.map((t) => ({ note: n, todo: t })))
  const undone = all.filter(({ todo }) => !todo.done)
  const doneCount = all.length - undone.length
  const rows = undone.slice(0, MAX_ROWS)
  const percent =
    all.length > 0 ? Math.round((doneCount / all.length) * 100) : 0

  return (
    <HomeCard
      icon={CheckSquareIcon}
      title="남은 할 일"
      count={undone.length}
      menuId="todo"
    >
      {all.length === 0 ? (
        <HomeEmpty>등록된 할 일이 없습니다.</HomeEmpty>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {doneCount}/{all.length}
            </span>
          </div>
          {rows.length === 0 ? (
            <HomeEmpty>할 일을 모두 끝냈습니다 🎉</HomeEmpty>
          ) : (
            <ul className="flex flex-col gap-1">
              {rows.map(({ note, todo }) => (
                <li key={todo.id} className="flex items-start gap-2 px-2 py-1">
                  <Checkbox
                    checked={todo.done}
                    onCheckedChange={() => onToggle(note.id, todo.id)}
                    className="mt-0.5"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{todo.text}</span>
                    {note.title && (
                      <span className="truncate text-xs text-muted-foreground">
                        {note.title}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {undone.length > rows.length && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              외 {undone.length - rows.length}건
            </p>
          )}
        </>
      )}
    </HomeCard>
  )
}
