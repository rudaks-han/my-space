import { useCallback } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/** 포스트잇 색상 키. 실제 색은 뷰(todo-view)의 팔레트에서 매핑한다. */
export type StickyColor =
  | "yellow"
  | "pink"
  | "green"
  | "blue"
  | "purple"
  | "gray"

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
}

const STORAGE_KEY = "myspace.stickies"

function newId() {
  return crypto.randomUUID()
}

/**
 * 포스트잇(메모) 보드 상태. 여러 개의 포스트잇을 만들고, 각 포스트잇 안에서 할 일을
 * 관리한다(체크박스로 완료 처리). 색상 변경 가능. 모두 localStorage 에 저장된다.
 */
export function useStickies() {
  const [notes, setNotes] = useLocalStorage<StickyNote[]>(STORAGE_KEY, [])

  const addNote = useCallback(() => {
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
      }
      return [note, ...prev]
    })
  }, [setNotes])

  const removeNote = useCallback(
    (noteId: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== noteId))
    },
    [setNotes],
  )

  const setTitle = useCallback(
    (noteId: string, title: string) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, title } : n)),
      )
    },
    [setNotes],
  )

  const setColor = useCallback(
    (noteId: string, color: StickyColor) => {
      setNotes((prev) =>
        prev.map((n) => (n.id === noteId ? { ...n, color } : n)),
      )
    },
    [setNotes],
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
            : n,
        ),
      )
    },
    [setNotes],
  )

  const toggleTodo = useCallback(
    (noteId: string, todoId: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                todos: n.todos.map((t) =>
                  t.id === todoId ? { ...t, done: !t.done } : t,
                ),
              }
            : n,
        ),
      )
    },
    [setNotes],
  )

  const updateTodo = useCallback(
    (noteId: string, todoId: string, text: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? {
                ...n,
                todos: n.todos.map((t) =>
                  t.id === todoId ? { ...t, text: text.trim() } : t,
                ),
              }
            : n,
        ),
      )
    },
    [setNotes],
  )

  const removeTodo = useCallback(
    (noteId: string, todoId: string) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === noteId
            ? { ...n, todos: n.todos.filter((t) => t.id !== todoId) }
            : n,
        ),
      )
    },
    [setNotes],
  )

  return {
    notes,
    addNote,
    removeNote,
    setTitle,
    setColor,
    addTodo,
    toggleTodo,
    updateTodo,
    removeTodo,
  }
}
