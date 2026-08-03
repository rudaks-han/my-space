import { useCallback, useEffect, useMemo } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { useTodoFolderSync, type TodoBoard } from "./use-todo-folder-sync"

/** 포스트잇 색상 키. 실제 색은 뷰(todo-view)의 팔레트에서 매핑한다. */
export type StickyColor =
  "yellow" | "pink" | "green" | "blue" | "purple" | "gray"

/** 색상 순환 순서(포스트잇을 새로 추가할 때 다음 색을 고르는 데 사용). */
export const STICKY_COLORS: StickyColor[] = [
  "yellow",
  "pink",
  "green",
  "blue",
  "purple",
  "gray",
]

export interface StickyTodo {
  id: string
  text: string
  done: boolean
  createdAt: number
}

export interface StickyNote {
  id: string
  title: string
  color: StickyColor
  todos: StickyTodo[]
  createdAt: number
  /** 이 포스트잇이 속한 카테고리 id. */
  categoryId: string
  /** 휴지통으로 옮겨진 시각(삭제항목 목록에만 존재). */
  deletedAt?: number
}

/** 포스트잇을 묶는 카테고리(왼쪽 레일에 표시). */
export interface StickyCategory {
  id: string
  name: string
}

const STORAGE_KEY = "myspace.stickies"
/** 삭제된 포스트잇(휴지통). 완전 삭제 전까지 여기 보관한다. */
const TRASH_KEY = "myspace.stickies.trash"
/** 카테고리 목록. */
const CATEGORIES_KEY = "myspace.stickyCategories"
/** 현재 선택된 카테고리 id. */
const ACTIVE_CATEGORY_KEY = "myspace.stickyActiveCategory"

/** 카테고리가 하나도 없을 때 처음으로 만들어 주는 기본 카테고리 이름. */
const DEFAULT_CATEGORY_NAME = "할 일"

function newId() {
  return crypto.randomUUID()
}

/**
 * 포스트잇(메모) 보드 상태. 여러 개의 포스트잇을 만들고, 각 포스트잇 안에서 할 일을
 * 관리한다(체크박스로 완료 처리). 색상 변경 가능. 모두 localStorage 에 저장된다.
 * 포스트잇을 삭제하면 완전히 지우지 않고 휴지통(trash)으로 옮겨 나중에 복원/완전삭제할 수 있다.
 *
 * 설정 → 할 일에서 폴더를 지정하면 그 폴더의 마크다운 파일과 **양방향으로** 맞춰진다
 * (`use-todo-folder-sync.ts`). localStorage 는 그대로 남는다 — 파일은 저장 위치가 하나
 * 더 생기는 것이고, 진실의 사본은 계속 여기다. 폴더를 비워 두면 아래 코드는 예전과
 * 완전히 같게 동작한다.
 */
export function useStickies() {
  const [notes, setNotes] = useLocalStorage<StickyNote[]>(STORAGE_KEY, [])
  const [trash, setTrash] = useLocalStorage<StickyNote[]>(TRASH_KEY, [])
  const [categories, setCategories] = useLocalStorage<StickyCategory[]>(
    CATEGORIES_KEY,
    []
  )
  const [activeCategoryId, setActiveCategoryId] = useLocalStorage<string>(
    ACTIVE_CATEGORY_KEY,
    ""
  )

  // ── 폴더(마크다운 파일) 동기화 ───────────────────────────────────
  // 설정 → 할 일에서 폴더를 지정했을 때만 동작한다. 파일에 실제로 저장되는 세 가지만
  // 넘긴다(선택된 카테고리는 창마다 다른 화면 상태라 파일에 담을 것이 아니다).
  const board = useMemo<TodoBoard>(
    () => ({ categories, notes, trash }),
    [categories, notes, trash]
  )
  const applyBoard = useCallback(
    (next: TodoBoard) => {
      setCategories(next.categories)
      setNotes(next.notes)
      setTrash(next.trash)
    },
    [setCategories, setNotes, setTrash]
  )
  const folder = useTodoFolderSync(board, applyBoard)

  // 카테고리가 하나도 없으면 기본 카테고리를 만든다(최초 실행/기존 데이터 마이그레이션).
  //
  // 폴더를 쓰는 경우에는 첫 읽기가 끝날 때까지 미룬다. 미루지 않으면 파일에서 읽어 올
  // 카테고리가 있는데도 기본 카테고리가 잠깐 나타났다 사라지는 깜빡임이 생긴다.
  useEffect(() => {
    if (folder.folder && !folder.ready) return
    if (categories.length === 0) {
      setCategories([{ id: newId(), name: DEFAULT_CATEGORY_NAME }])
    }
  }, [categories, setCategories, folder.folder, folder.ready])

  // 선택된 카테고리가 유효하지 않으면(없거나 삭제됨) 첫 카테고리를 선택한다.
  useEffect(() => {
    if (categories.length === 0) return
    if (!categories.some((c) => c.id === activeCategoryId)) {
      setActiveCategoryId(categories[0].id)
    }
  }, [categories, activeCategoryId, setActiveCategoryId])

  // categoryId 가 없거나 사라진 카테고리를 가리키는 포스트잇을 첫 카테고리로 옮긴다
  // (categoryId 도입 이전에 만든 기존 포스트잇을 잃지 않도록).
  useEffect(() => {
    if (categories.length === 0) return
    const valid = new Set(categories.map((c) => c.id))
    if (notes.some((n) => !valid.has(n.categoryId))) {
      const fallback = categories[0].id
      setNotes((prev) =>
        prev.map((n) =>
          valid.has(n.categoryId) ? n : { ...n, categoryId: fallback }
        )
      )
    }
  }, [notes, categories, setNotes])

  const addNote = useCallback(
    (categoryId: string) => {
      if (!categoryId) return
      setNotes((prev) => {
        // 마지막 포스트잇의 다음 색을 골라 색이 자연스럽게 돌아가게 한다.
        const last = prev[0]
        const nextIdx = last
          ? (STICKY_COLORS.indexOf(last.color) + 1) % STICKY_COLORS.length
          : 0
        const note: StickyNote = {
          id: newId(),
          title: "",
          color: STICKY_COLORS[nextIdx],
          todos: [],
          createdAt: Date.now(),
          categoryId,
        }
        return [note, ...prev]
      })
    },
    [setNotes]
  )

  // ── 카테고리 관리 ──────────────────────────────────────────────
  const addCategory = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      const cat: StickyCategory = { id: newId(), name: trimmed }
      setCategories((prev) => [...prev, cat])
      setActiveCategoryId(cat.id) // 만든 카테고리를 곧바로 선택한다.
    },
    [setCategories, setActiveCategoryId]
  )

  const renameCategory = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      setCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, name: trimmed } : c))
      )
    },
    [setCategories]
  )

  // 카테고리를 지우면 그 안의 포스트잇은 휴지통으로 보낸다(바로 완전삭제하지 않는다).
  const removeCategory = useCallback(
    (id: string) => {
      const doomed = notes.filter((n) => n.categoryId === id)
      if (doomed.length > 0) {
        const now = Date.now()
        setTrash((t) => [
          ...doomed.map((n) => ({ ...n, deletedAt: now })),
          ...t,
        ])
      }
      setNotes((prev) => prev.filter((n) => n.categoryId !== id))
      setCategories((prev) => prev.filter((c) => c.id !== id))
    },
    [notes, setNotes, setTrash, setCategories]
  )

  const selectCategory = useCallback(
    (id: string) => setActiveCategoryId(id),
    [setActiveCategoryId]
  )

  // 카테고리 레일 안에서 순서를 바꾼다(포스트잇 순서 변경과 같은 규칙).
  // 이 순서가 파일 쪽 `order:` 로 나가므로 다른 기기에서도 같은 순서로 보인다.
  const moveCategory = useCallback(
    (draggedId: string, targetId: string, before: boolean) => {
      if (draggedId === targetId) return
      setCategories((prev) => {
        const from = prev.findIndex((c) => c.id === draggedId)
        if (from === -1) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        // 제거 후 대상 위치를 다시 찾는다(아래로 끄는 드래그에서 한 칸씩 밀리는 것 방지).
        const to = next.findIndex((c) => c.id === targetId)
        if (to === -1) return prev
        next.splice(before ? to : to + 1, 0, moved)
        return next
      })
    },
    [setCategories]
  )

  // 포스트잇을 다른 카테고리로 옮긴다.
  //
  // 목록의 **맨 앞**으로 보낸다. `categoryId` 만 바꾸면 배열 위치가 그대로라 옮긴 포스트잇이
  // 대상 카테고리 중간 어딘가에 끼어들어 "어디로 갔는지" 알 수 없다. 새로 추가한 포스트잇이
  // 맨 앞에 오는 것과 같은 규칙이다.
  const moveNoteToCategory = useCallback(
    (noteId: string, categoryId: string) => {
      if (!categoryId) return
      setNotes((prev) => {
        const from = prev.findIndex((n) => n.id === noteId)
        if (from === -1) return prev
        if (prev[from].categoryId === categoryId) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        return [{ ...moved, categoryId }, ...next]
      })
    },
    [setNotes]
  )

  // 완전 삭제가 아니라 휴지통으로 옮긴다(삭제항목 목록 맨 앞에 쌓는다).
  // 두 상태를 각각 최상위에서 갱신한다 — setState 업데이터 안에서 다른 setState 를
  // 호출하면(중첩) StrictMode 가 업데이터를 두 번 실행해 항목이 중복 복사된다.
  const removeNote = useCallback(
    (noteId: string) => {
      const target = notes.find((n) => n.id === noteId)
      if (!target) return
      setTrash((t) => [{ ...target, deletedAt: Date.now() }, ...t])
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    },
    [notes, setNotes, setTrash]
  )

  // 휴지통의 포스트잇을 보드로 되돌린다(맨 앞에). 해당 항목 하나만.
  const restoreNote = useCallback(
    (noteId: string) => {
      const target = trash.find((n) => n.id === noteId)
      if (!target) return
      const restored: StickyNote = { ...target }
      delete restored.deletedAt
      // 원래 카테고리가 사라졌으면 현재(또는 첫) 카테고리로 되돌린다.
      if (!categories.some((c) => c.id === restored.categoryId)) {
        restored.categoryId = activeCategoryId || categories[0]?.id || ""
      }
      setNotes((n) => [restored, ...n])
      setTrash((prev) => prev.filter((n) => n.id !== noteId))
    },
    [trash, categories, activeCategoryId, setNotes, setTrash]
  )

  // 휴지통에서 완전 삭제(되돌릴 수 없음).
  const purgeNote = useCallback(
    (noteId: string) => {
      setTrash((prev) => prev.filter((n) => n.id !== noteId))
    },
    [setTrash]
  )

  // 보드 안에서 포스트잇 순서를 바꾼다. draggedId 를 targetId 앞(before)/뒤로 옮긴다.
  const moveNote = useCallback(
    (draggedId: string, targetId: string, before: boolean) => {
      if (draggedId === targetId) return
      setNotes((prev) => {
        const from = prev.findIndex((n) => n.id === draggedId)
        if (from === -1) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        // 제거 후 대상 위치를 다시 찾는다(아래로 끄는 드래그에서 한 칸씩 밀리는 것 방지).
        const to = next.findIndex((n) => n.id === targetId)
        if (to === -1) return prev
        next.splice(before ? to : to + 1, 0, moved)
        return next
      })
    },
    [setNotes]
  )

  const setTitle = useCallback(
    (noteId: string, title: string) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, title } : n))
      )
    },
    [setNotes]
  )

  const setColor = useCallback(
    (noteId: string, color: StickyColor) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, color } : n))
      )
    },
    [setNotes]
  )

  const addTodo = useCallback(
    (noteId: string, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                todos: [
                  ...n.todos,
                  {
                    id: newId(),
                    text: trimmed,
                    done: false,
                    createdAt: Date.now(),
                  },
                ],
              }
            : n
        )
      )
    },
    [setNotes]
  )

  const toggleTodo = useCallback(
    (noteId: string, todoId: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                todos: n.todos.map((t) =>
                  t.id === todoId ? { ...t, done: !t.done } : t
                ),
              }
            : n
        )
      )
    },
    [setNotes]
  )

  const updateTodo = useCallback(
    (noteId: string, todoId: string, text: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                todos: n.todos.map((t) =>
                  t.id === todoId ? { ...t, text: text.trim() } : t
                ),
              }
            : n
        )
      )
    },
    [setNotes]
  )

  const removeTodo = useCallback(
    (noteId: string, todoId: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? { ...n, todos: n.todos.filter((t) => t.id !== todoId) }
            : n
        )
      )
    },
    [setNotes]
  )

  return {
    notes,
    trash,
    categories,
    activeCategoryId,
    /** 마크다운 폴더 동기화 상태(폴더를 지정하지 않았으면 `folder` 가 빈 문자열). */
    folder,
    addNote,
    removeNote,
    restoreNote,
    purgeNote,
    moveNote,
    moveNoteToCategory,
    addCategory,
    renameCategory,
    removeCategory,
    selectCategory,
    moveCategory,
    setTitle,
    setColor,
    addTodo,
    toggleTodo,
    updateTodo,
    removeTodo,
  }
}
