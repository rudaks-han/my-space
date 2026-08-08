import { useCallback } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/**
 * 포스트잇별 "완료된 항목 감추기" 상태.
 *
 * **마크다운 파일(포스트잇 frontmatter)이 아니라 localStorage 에 둔다.** 이것은 데이터가
 * 아니라 이 기기에서의 보기 설정이라, 파일에 적으면 `use-todo-folder-sync` 의 지문·필드
 * 규칙을 건드리고(모델에 없는 필드가 늘어난다) Obsidian 에서 사람이 읽는 본문에도
 * 의미 없는 값이 섞인다. `myspace.todoRunSessions` 와 같은 계열이다.
 *
 * 카드의 `useState` 가 아닌 이유는 그 상태가 **앱을 다시 켜면 사라지기** 때문이다 —
 * 완료된 항목을 계속 감춰 두는 포스트잇은 매번 다시 눌러 감춰야 했다.
 *
 * ⚠️ **호출은 뷰에서 한 번만.** 같은 창에서 같은 키로 `useLocalStorage` 를 두 번 부르면
 * 서로의 쓰기를 보지 못해(`storage` 이벤트는 다른 창에만 간다) 카드 A 의 설정이 카드 B 의
 * 낡은 스냅샷에 덮여 사라진다. 그래서 `TodoView` 가 한 번 부르고 카드에 내려 준다.
 */
export function useHideDone() {
  const [map, setMap] = useLocalStorage<Record<string, boolean>>(
    "myspace.todoHideDone",
    {}
  )

  const hidden = useCallback(
    (noteId: string): boolean => map[noteId] === true,
    [map]
  )

  // 기본값(표시)은 키를 지워서 남긴다 — `false` 를 쌓아 두면 포스트잇을 지울 때마다
  // 아무 의미 없는 항목이 영구히 남는다.
  const toggle = useCallback(
    (noteId: string) => {
      setMap((prev) => {
        if (prev[noteId]) {
          const next = { ...prev }
          delete next[noteId]
          return next
        }
        return { ...prev, [noteId]: true }
      })
    },
    [setMap]
  )

  return { hidden, toggle }
}

export type HideDone = ReturnType<typeof useHideDone>
