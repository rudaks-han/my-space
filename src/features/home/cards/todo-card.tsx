import { CheckSquareIcon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import type { StickyNote } from "@/features/todo/use-todos"
import { HomeCard, HomeEmpty } from "../home-card"

/** 홈에 보여줄 최대 할 일 수. */
const MAX_ROWS = 6

/**
 * 완료율 도넛 링. 반지름 15.9155 → 둘레가 딱 100 이라 strokeDasharray 에 퍼센트를
 * 그대로 넣을 수 있다. 가운데 퍼센트 텍스트는 회전 영향을 받지 않게 SVG 밖 오버레이로 얹는다.
 */
function ProgressRing({ percent }: { percent: number }) {
  return (
    <div className="relative size-11 shrink-0">
      <svg viewBox="0 0 36 36" className="size-11 -rotate-90">
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.5"
          className="stroke-muted"
        />
        <circle
          cx="18"
          cy="18"
          r="15.9155"
          fill="none"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={`${percent} 100`}
          className="stroke-primary transition-[stroke-dasharray]"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold tabular-nums">
        {percent}%
      </span>
    </div>
  )
}

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
          {/* 완료율 링 — 남은 건수를 굵게, 완료 비율을 도넛으로 한눈에. */}
          <div className="mb-2 flex items-center gap-3 px-3 pt-1">
            <ProgressRing percent={percent} />
            <div className="flex min-w-0 flex-col">
              <span className="text-[15px] font-bold">
                {undone.length}건 남음
              </span>
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {doneCount}/{all.length} 완료
              </span>
            </div>
          </div>
          {rows.length === 0 ? (
            <HomeEmpty>할 일을 모두 끝냈습니다 🎉</HomeEmpty>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {rows.map(({ note, todo }) => (
                <li
                  key={todo.id}
                  className="flex min-h-9 items-center gap-3 rounded-lg px-3 py-1.5 transition-colors hover:bg-ui-list-hover"
                >
                  <Checkbox
                    checked={todo.done}
                    onCheckedChange={() => onToggle(note.id, todo.id)}
                    className="shrink-0"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15px]">{todo.text}</span>
                    {note.title && (
                      <span className="truncate text-[13px] text-muted-foreground">
                        {note.title}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {undone.length > rows.length && (
            <p className="mt-1.5 text-center text-[13px] text-muted-foreground">
              외 {undone.length - rows.length}건
            </p>
          )}
        </>
      )}
    </HomeCard>
  )
}
