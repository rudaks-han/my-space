import { useRef, useState } from "react"
import {
  CheckIcon,
  CircleAlertIcon,
  FolderSyncIcon,
  GripVerticalIcon,
  PlusIcon,
  RotateCcwIcon,
  StickyNoteIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { cn } from "@/lib/utils"
import {
  STICKY_COLORS,
  useStickies,
  type StickyCategory,
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

/** 부모(TodoView)에서 내려주는 드래그 재정렬 관련 소품. */
type DragProps = {
  onHandleDown: (e: React.PointerEvent, id: string) => void
  dragging: boolean
  /** 이 카드 앞/뒤에 삽입 표시선을 그릴지. */
  drop: "before" | "after" | null
}

function StickyCard({
  note,
  api,
  drag,
}: {
  note: StickyNote
  api: Api
  drag: DragProps
}) {
  const [draft, setDraft] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  // 포스트잇 삭제는 되돌리기 쉽지 않으므로 한 번 확인한다(헤더가 확인 바로 바뀐다).
  const [confirming, setConfirming] = useState(false)
  // 카테고리 이동 목록을 펼쳤는지. 레일로 끌어다 놓는 방법도 있지만 드래그는 눈에 보이는
  // 단서가 없어 아무도 찾지 못하므로, 사이드바 고정(우클릭 + 드래그)과 같이 둘 다 둔다.
  const [moving, setMoving] = useState(false)

  const remaining = note.todos.filter((t) => !t.done).length
  // 옮겨 갈 수 있는 카테고리(자기 카테고리는 뺀다).
  const others = api.categories.filter((c) => c.id !== note.categoryId)

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

  const startEdit = (todo: { id: string; text: string }) => {
    setEditingId(todo.id)
    setEditingText(todo.text)
  }

  return (
    <div
      data-note-id={note.id}
      style={{ "--sticky-accent": ACCENT[note.color] } as React.CSSProperties}
      className={cn(
        "relative flex min-w-0 flex-col rounded-[10px] border border-[color-mix(in_oklab,var(--sticky-accent)_28%,var(--border))] bg-[color-mix(in_oklab,var(--sticky-accent)_12%,var(--card))] shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        drag.dragging && "opacity-40",
        // 그리드라 삽입 위치는 카드 좌/우 세로선으로 표시한다.
        drag.drop &&
          "before:absolute before:inset-y-1 before:w-0.5 before:rounded-full before:bg-ui-selection",
        drag.drop === "before" && "before:-left-1.5",
        drag.drop === "after" && "before:-right-1.5"
      )}
    >
      {/* 헤더 — Slack 패널 헤더 톤(굵은 15px 제목 + 배경색 없음). */}
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_oklab,var(--sticky-accent)_22%,var(--border))] px-4 py-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">
            삭제할까요?
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            취소
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false)
              api.removeNote(note.id)
            }}
          >
            삭제
          </Button>
        </div>
      ) : (
        <div
          // 카테고리 이동은 우클릭으로 연다 — 헤더에 아이콘을 하나 더 두면 좁은 카드에서
          // 제목이 밀리고, 사이드바 고정도 같은 방식(우클릭 + 드래그)이라 관례가 맞는다.
          onContextMenu={(e) => {
            if (others.length === 0) return
            e.preventDefault()
            setMoving(true)
          }}
          className="flex shrink-0 items-center gap-1.5 border-b border-[color-mix(in_oklab,var(--sticky-accent)_22%,var(--border))] px-3 py-3"
        >
          {/* 드래그 핸들 — 제목 입력과 충돌하지 않도록 순서 변경은 여기서만 시작한다.
              카테고리 레일에 놓으면 그 카테고리로 이동한다(TodoView 의 pointerup 이 판단). */}
          <button
            type="button"
            aria-label="포스트잇 순서 변경(드래그)"
            title="드래그하여 순서 변경 · 카테고리로 끌어다 놓으면 이동"
            onPointerDown={(e) => drag.onHandleDown(e, note.id)}
            className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--sticky-accent)_20%,transparent)] hover:text-foreground active:cursor-grabbing"
          >
            <GripVerticalIcon className="size-4" />
          </button>
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
            onClick={() => setConfirming(true)}
            aria-label="포스트잇 삭제"
            title="포스트잇 삭제"
            className="text-muted-foreground hover:text-foreground"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      )}

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
              // 편집 중에는 입력칸이 행 전체를 쓰도록 수정/삭제 버튼을 감춘다.
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
              <>
                {/* 항목을 누르면 곧바로 편집이다 — 더블클릭은 단서가 없어 아무도 찾지
                    못하고, 연필 아이콘은 그 단서 역할이었지만 행마다 아이콘이 둘씩
                    붙어 좁은 카드에서 글자가 밀렸다(클릭 편집은 그대로 남는다).
                    span 이 아니라 button 이라 키보드로도 편집에 들어갈 수 있다. */}
                <button
                  type="button"
                  onClick={() => startEdit(t)}
                  title="클릭하여 수정"
                  className={cn(
                    // min-w-0 + wrap-anywhere 가 없으면 공백 없는 긴 문자열이
                    // flex 항목의 min-content 를 밀어 카드 밖으로 삐져나간다.
                    "min-w-0 flex-1 cursor-text py-0.5 text-left text-[15px] wrap-anywhere",
                    t.done && "text-muted-foreground line-through"
                  )}
                >
                  {t.text}
                </button>
                <button
                  type="button"
                  onClick={() => api.removeTodo(note.id, t.id)}
                  aria-label="할 일 삭제"
                  className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all group-hover:opacity-100 hover:bg-[color-mix(in_oklab,var(--sticky-accent)_28%,transparent)] hover:text-foreground"
                >
                  <XIcon className="size-4" />
                </button>
              </>
            )}
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

      {/* 카테고리 이동(헤더 우클릭으로 열린다) — 칩 하나가 카테고리 하나다
          (Slack 의 필터 칩과 같은 rounded-full). 여는 버튼이 없으므로 닫는 X 는 여기 있다. */}
      {moving && others.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[color-mix(in_oklab,var(--sticky-accent)_22%,var(--border))] px-4 py-3">
          <span className="shrink-0 text-[13px] text-muted-foreground">
            이동:
          </span>
          {others.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setMoving(false)
                api.moveNoteToCategory(note.id, c.id)
              }}
              title={`${c.name} 카테고리로 이동`}
              className="max-w-full cursor-pointer truncate rounded-full border border-border bg-background px-2.5 py-0.5 text-[13px] font-bold transition-colors hover:bg-ui-list-hover"
            >
              {c.name}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMoving(false)}
            aria-label="이동 취소"
            title="닫기"
            className="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color-mix(in_oklab,var(--sticky-accent)_28%,transparent)] hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      )}

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

/**
 * 삭제된 포스트잇 카드 — 현재 목록에 회색으로 함께 표시한다(별도 패널 아님).
 * 편집/드래그는 막고, 복원과 완전 삭제만 가능하다. 회색 처리는 grayscale + 낮은 명도로
 * "삭제됨"임을 한눈에 드러낸다.
 */
function DeletedCard({ note, api }: { note: StickyNote; api: Api }) {
  const remaining = note.todos.filter((t) => !t.done).length
  return (
    <div className="flex min-w-0 flex-col rounded-[10px] border border-border bg-muted/40 opacity-70 grayscale">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3">
        <span className="size-2.5 shrink-0 rounded-full bg-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-muted-foreground line-through">
          {note.title || "제목 없음"}
        </span>
        {note.todos.length > 0 && (
          <span className="shrink-0 rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground tabular-nums">
            {remaining}/{note.todos.length}
          </span>
        )}
      </div>

      <ul className="flex flex-col gap-0.5 p-2">
        {note.todos.map((t) => (
          <li
            key={t.id}
            className="flex min-h-9 items-start gap-2.5 rounded-lg px-3 py-1.5"
          >
            <Checkbox checked={t.done} disabled className="mt-[3px] shrink-0" />
            <span
              className={cn(
                "min-w-0 flex-1 py-0.5 text-[15px] wrap-anywhere text-muted-foreground",
                t.done && "line-through"
              )}
            >
              {t.text}
            </span>
          </li>
        ))}
        {note.todos.length === 0 && (
          <li className="flex min-h-9 items-center px-3 text-[15px] text-muted-foreground">
            할 일 없음
          </li>
        )}
      </ul>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => api.restoreNote(note.id)}
          title="복원"
        >
          <RotateCcwIcon className="size-4" />
          복원
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => api.purgeNote(note.id)}
          title="완전 삭제"
          className="ml-auto text-ui-error hover:text-ui-error"
        >
          <Trash2Icon className="size-4" />
          완전 삭제
        </Button>
      </div>
    </div>
  )
}

/**
 * 왼쪽 카테고리 레일 — 카테고리 선택/추가/이름변경/삭제.
 * Slack 사이드바 톤(28px 알약 행, 선택 시 selection 색). 카테고리를 지우면 그 안의
 * 포스트잇은 휴지통으로 간다. 마지막 하나는 지울 수 없다(항상 하나는 있어야 추가 가능).
 */
function CategoryRail({
  api,
  noteDragging,
}: {
  api: Api
  /** 포스트잇을 끌고 있는 중인지 — 레일이 드롭 대상으로 자신을 표시한다. */
  noteDragging: boolean
}) {
  const { categories, activeCategoryId, notes } = api
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState("")
  const [confirmId, setConfirmId] = useState<string | null>(null)

  // 카테고리 순서 변경(드래그). 포스트잇과 같은 이유로 pointer 이벤트로 직접 구현한다
  // (WKWebView 에서 HTML5 draggable 이 제대로 동작하지 않는다).
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(
    null
  )
  // 포스트잇을 끌어 왔을 때 지금 어느 행 위에 있는지. pointer capture 를 아무도 잡지
  // 않으므로 드래그 중에도 onPointerEnter 가 정상적으로 발생한다.
  const [hoverId, setHoverId] = useState<string | null>(null)

  // 행을 눌러 끌면 순서 변경, 그냥 누르면 선택이다. 둘을 가르는 것은 이동 거리다 —
  // 별도 그립 핸들을 두기에는 행이 32px 로 좁고, 사이드바도 같은 방식이다.
  // 드래그였는지는 ref 로 남겨 onClick 에서 확인한다(클릭은 pointerup 뒤에 온다).
  const draggedRef = useRef(false)

  const startCategoryDrag = (e: React.PointerEvent, catId: string) => {
    if (e.button !== 0) return
    draggedRef.current = false
    const originY = e.clientY
    let started = false

    const targetAt = (x: number, y: number) => {
      const row = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-category-drop]")
      const targetId = row?.dataset.categoryDrop
      if (!targetId || targetId === catId) return null
      const rect = row!.getBoundingClientRect()
      // 레일은 세로 목록이라 위/아래 절반으로 삽입 위치를 정한다.
      return { id: targetId, before: y < rect.top + rect.height / 2 }
    }

    const onMove = (ev: PointerEvent) => {
      // 4px 임계값 — 클릭할 때의 미세한 흔들림을 드래그로 오해하지 않는다.
      if (!started && Math.abs(ev.clientY - originY) < 4) return
      if (!started) {
        started = true
        draggedRef.current = true
        setDragId(catId)
        document.body.style.userSelect = "none"
      }
      setDropAt(targetAt(ev.clientX, ev.clientY))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      if (started) {
        const target = targetAt(ev.clientX, ev.clientY)
        if (target) api.moveCategory(catId, target.id, target.before)
      }
      setDragId(null)
      setDropAt(null)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const countOf = (id: string) =>
    notes.filter((n) => n.categoryId === id).length

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault()
    api.addCategory(draft)
    setDraft("")
    setAdding(false)
  }

  const commitRename = (cat: StickyCategory) => {
    if (editingText.trim() && editingText.trim() !== cat.name)
      api.renameCategory(cat.id, editingText)
    setEditingId(null)
    setEditingText("")
  }

  return (
    <aside className="flex w-48 shrink-0 flex-col gap-1">
      <div className="flex items-center px-2 py-1">
        <span className="text-[13px] font-semibold text-muted-foreground">
          카테고리
        </span>
        <button
          type="button"
          onClick={() => {
            setAdding(true)
            setDraft("")
          }}
          aria-label="카테고리 추가"
          title="카테고리 추가"
          className="ml-auto flex size-6 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-ui-list-hover hover:text-foreground"
        >
          <PlusIcon className="size-4" />
        </button>
      </div>

      <ul className="flex flex-col gap-0.5">
        {categories.map((cat) => {
          const active = cat.id === activeCategoryId
          const confirming = confirmId === cat.id
          if (editingId === cat.id) {
            return (
              <li key={cat.id} className="px-1">
                <input
                  value={editingText}
                  autoFocus
                  onChange={(e) => setEditingText(e.target.value)}
                  onBlur={() => commitRename(cat)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(cat)
                    if (e.key === "Escape") {
                      setEditingId(null)
                      setEditingText("")
                    }
                  }}
                  className="w-full rounded-lg border border-ring bg-background px-2.5 py-1 text-[15px] focus:outline-none"
                />
              </li>
            )
          }
          // 포스트잇을 끌어 와 이 행 위에 올린 상태(놓으면 그 카테고리로 이동).
          const noteDrop = noteDragging && hoverId === cat.id
          return (
            <li
              key={cat.id}
              data-category-drop={cat.id}
              onPointerEnter={() => setHoverId(cat.id)}
              onPointerLeave={() =>
                setHoverId((h) => (h === cat.id ? null : h))
              }
              className={cn(
                "group/cat relative px-1",
                dragId === cat.id && "opacity-40",
                // 세로 목록이라 삽입 위치는 행 위/아래 가로선으로 표시한다.
                dropAt?.id === cat.id &&
                  dragId !== cat.id &&
                  "before:absolute before:inset-x-1 before:h-0.5 before:rounded-full before:bg-ui-selection",
                dropAt?.id === cat.id && dropAt.before
                  ? "before:-top-0.5"
                  : dropAt?.id === cat.id && "before:-bottom-0.5"
              )}
            >
              <button
                type="button"
                onPointerDown={(e) => startCategoryDrag(e, cat.id)}
                onClick={() => {
                  // 드래그로 끝난 pointerup 뒤에도 클릭이 오므로 걸러 낸다.
                  if (draggedRef.current) return
                  api.selectCategory(cat.id)
                }}
                onDoubleClick={() => {
                  setEditingId(cat.id)
                  setEditingText(cat.name)
                }}
                title={`${cat.name} — 드래그하여 순서 변경`}
                className={cn(
                  "flex h-8 w-full touch-none items-center gap-2 rounded-lg px-2.5 text-left text-[15px] transition-colors",
                  active
                    ? "bg-ui-selection font-bold text-ui-selection-fg"
                    : "hover:bg-ui-list-hover",
                  // 포스트잇 드롭 대상임을 링으로 알린다(배경색은 선택 상태와 겹친다).
                  noteDrop &&
                    "outline-2 outline-offset-1 outline-ring outline-solid"
                )}
              >
                <span className="min-w-0 flex-1 truncate">{cat.name}</span>
                <span
                  className={cn(
                    "shrink-0 text-[11px] font-bold tabular-nums",
                    active ? "text-ui-selection-fg/80" : "text-muted-foreground"
                  )}
                >
                  {countOf(cat.id)}
                </span>
              </button>

              {/* 삭제 — 마지막 한 개는 남겨 둔다. 확인 후 안의 포스트잇은 휴지통으로. */}
              {categories.length > 1 && !confirming && (
                <button
                  type="button"
                  onClick={() => setConfirmId(cat.id)}
                  aria-label={`${cat.name} 카테고리 삭제`}
                  title="카테고리 삭제"
                  className={cn(
                    "absolute top-1/2 right-2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full opacity-0 transition-all group-hover/cat:opacity-100",
                    active
                      ? "text-ui-selection-fg hover:bg-white/20"
                      : "text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
                  )}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              )}

              {/* 삭제 확인 — 행 위에 겹쳐 표시한다. */}
              {confirming && (
                <div className="absolute inset-y-0 right-1 flex items-center gap-1 rounded-lg bg-background/95 pr-1 pl-2 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
                  <span className="text-[13px] text-muted-foreground">
                    삭제?
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    aria-label="취소"
                    className="flex size-6 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
                  >
                    <XIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmId(null)
                      api.removeCategory(cat.id)
                    }}
                    aria-label="삭제"
                    className="flex size-6 cursor-pointer items-center justify-center rounded-full text-ui-error hover:bg-ui-error/10"
                  >
                    <CheckIcon className="size-4" />
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {adding && (
        <form onSubmit={submitAdd} className="px-1">
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) api.addCategory(draft)
              setDraft("")
              setAdding(false)
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft("")
                setAdding(false)
              }
            }}
            placeholder="카테고리 이름"
            className="w-full rounded-lg border border-ring bg-background px-2.5 py-1 text-[15px] placeholder:text-muted-foreground focus:outline-none"
          />
        </form>
      )}
    </aside>
  )
}

export function TodoView() {
  const api = useStickies()
  const { notes, trash, categories, activeCategoryId, addNote, moveNote } = api

  // 현재 카테고리의 포스트잇만 보여 준다.
  const activeNotes = notes.filter((n) => n.categoryId === activeCategoryId)
  // 삭제항목은 현재 카테고리 것 + 사라진 카테고리에 속한 고아 항목(어디에도 안 보이면
  // 복원할 수 없으므로)을 보여 준다.
  const validCatIds = new Set(categories.map((c) => c.id))
  const visibleTrash = trash.filter(
    (n) => n.categoryId === activeCategoryId || !validCatIds.has(n.categoryId)
  )
  const canAdd = activeCategoryId !== "" && validCatIds.has(activeCategoryId)

  // 삭제된 포스트잇을 현재 목록에 회색으로 함께 보여줄지 토글한다.
  const [showTrash, setShowTrash] = useState(false)

  // 포스트잇 순서 변경(드래그). WKWebView 에서 HTML5 draggable 이 잘 동작하지 않아
  // 사이드바와 동일하게 pointer 이벤트로 직접 구현한다.
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; before: boolean } | null>(
    null
  )

  const startNoteDrag = (e: React.PointerEvent, noteId: string) => {
    if (e.button !== 0) return
    e.preventDefault()
    let started = false

    // 포인터 아래에 있는 다른 카드를 찾아 좌/우 절반으로 before 를 정한다(그리드라 가로 기준).
    const targetAt = (x: number, y: number) => {
      const card = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-note-id]")
      if (!card) return null
      const targetId = card.dataset.noteId
      if (!targetId || targetId === noteId) return null
      const rect = card.getBoundingClientRect()
      return { id: targetId, before: x < rect.left + rect.width / 2 }
    }

    const onMove = (ev: PointerEvent) => {
      if (!started) {
        started = true
        setDragId(noteId)
        document.body.style.userSelect = "none"
      }
      setDropAt(targetAt(ev.clientX, ev.clientY))
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = ""
      if (started) {
        // 카테고리 레일 위에 놓았으면 순서 변경이 아니라 **카테고리 이동**이다.
        // 레일이 먼저다 — 레일 행에는 다른 포스트잇 카드가 없으니 둘이 겹치지 않는다.
        const catId = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>("[data-category-drop]")?.dataset.categoryDrop
        if (catId) {
          api.moveNoteToCategory(noteId, catId)
        } else {
          const target = targetAt(ev.clientX, ev.clientY)
          if (target) moveNote(noteId, target.id, target.before)
        }
      }
      setDragId(null)
      setDropAt(null)
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <div className="flex w-full gap-5">
      {/* 왼쪽: 카테고리 레일 — 포스트잇을 끌어와 놓으면 그 카테고리로 이동한다. */}
      <CategoryRail api={api} noteDragging={dragId !== null} />

      {/* 오른쪽: 선택된 카테고리의 포스트잇 */}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {/* 뷰 툴바 — 제목은 위쪽 뷰 헤더가 이미 보여 주므로 개수 메타와 액션만 둔다. */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[13px] text-muted-foreground tabular-nums">
            포스트잇 {activeNotes.length}개
          </span>
          {/*
            마크다운 폴더에 저장 중임을 알린다. 실패는 반드시 보여야 한다 — 조용히
            실패하면 사용자는 파일이 최신인 줄 알고 Obsidian 쪽을 신뢰하게 된다
            (앱 안의 데이터는 localStorage 에 그대로 있어 잃지 않는다).
          */}
          {api.folder.folder &&
            (api.folder.error ? (
              <span
                className="flex min-w-0 items-center gap-1 text-[13px] text-ui-error"
                title={api.folder.error}
              >
                <CircleAlertIcon className="size-3.5 shrink-0" />
                <span className="truncate">파일 저장 실패</span>
              </span>
            ) : (
              <span
                className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
                title={`${api.folder.folder} 의 마크다운 파일과 동기화됩니다.`}
              >
                <FolderSyncIcon className="size-3.5 shrink-0" />
                <span className="truncate">파일 동기화</span>
              </span>
            ))}
          <Button
            size="sm"
            variant={showTrash ? "secondary" : "outline"}
            className="ml-auto"
            onClick={() => setShowTrash((v) => !v)}
            disabled={visibleTrash.length === 0}
          >
            <Trash2Icon />
            {showTrash ? "삭제항목 숨기기" : "삭제항목 보기"}
            {visibleTrash.length > 0 && (
              <span className="rounded-full bg-ui-selection px-1.5 text-[11px] font-bold text-ui-selection-fg tabular-nums">
                {visibleTrash.length}
              </span>
            )}
          </Button>
          <Button
            size="sm"
            onClick={() => addNote(activeCategoryId)}
            disabled={!canAdd}
          >
            <PlusIcon />
            포스트잇 추가
          </Button>
        </div>

        {activeNotes.length === 0 && !(showTrash && visibleTrash.length > 0) ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center text-[15px] text-muted-foreground">
            <StickyNoteIcon className="size-6" />이 카테고리에는 포스트잇이
            없습니다. “포스트잇 추가”로 시작하세요.
          </div>
        ) : (
          /*
            열 수를 브레이크포인트로 못 박지 않고 **카드 최소 폭**으로 정한다.
            `lg:grid-cols-3` 은 화면 폭만 보므로 사이드바와 카테고리 레일이 먹는 폭이
            빠지면서 카드가 좁아져 할 일 한 줄이 두 줄로 접혔다. `auto-fill` 은 남는
            공간을 카드 폭으로 돌려주므로 넓은 창에서 카드가 같이 넓어진다.
            (`auto-fit` 이 아닌 이유: 포스트잇이 하나뿐일 때 카드가 창 전체로 늘어난다.)
          */
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(360px,100%),1fr))] gap-3">
            {activeNotes.map((note) => (
              <StickyCard
                key={note.id}
                note={note}
                api={api}
                drag={{
                  onHandleDown: startNoteDrag,
                  dragging: dragId === note.id,
                  drop:
                    dropAt?.id === note.id && dragId !== note.id
                      ? dropAt.before
                        ? "before"
                        : "after"
                      : null,
                }}
              />
            ))}
            {/* 삭제항목은 현재 목록 끝에 회색 카드로 이어 붙인다(별도 패널이 아님). */}
            {showTrash &&
              visibleTrash.map((note) => (
                <DeletedCard key={note.id} note={note} api={api} />
              ))}
          </div>
        )}
      </div>
    </div>
  )
}
