import { useCallback, useMemo, useState, type ReactNode } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { PinnedMenusContext, type PinnedMenus } from "@/lib/use-pinned-menus"

const STORAGE_KEY = "myspace.pinnedMenus"

/**
 * 좌측 레일에 꽂아 둔 메뉴 목록을 셸(레일 + 사이드바) 전체에 공급한다.
 *
 * 저장 순서가 곧 표시 순서다 — 그룹 순서(`use-menu-order`)와 달리 선언 위치로 되돌릴
 * 기준이 없고, 사용자가 꽂은 순서만이 유일한 진실이다.
 */
export function PinnedMenusProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useLocalStorage<string[]>(STORAGE_KEY, [])
  const [dragMenuId, setDragMenuId] = useState<string | null>(null)

  const pin = useCallback(
    (id: string) => {
      setIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    },
    [setIds]
  )

  const unpin = useCallback(
    (id: string) => setIds((prev) => prev.filter((x) => x !== id)),
    [setIds]
  )

  const toggle = useCallback(
    (id: string) => {
      setIds((prev) =>
        prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      )
    },
    [setIds]
  )

  // 먼저 빼고 대상 위치를 다시 찾는 순서는 `use-menu-order` 의 moveItem 과 같다 —
  // 제거 전 인덱스로 넣으면 아래로 끄는 드래그가 한 칸씩 밀린다.
  const move = useCallback(
    (draggedId: string, targetId: string, before = true) => {
      if (draggedId === targetId) return
      setIds((prev) => {
        const next = [...prev]
        const from = next.indexOf(draggedId)
        if (from === -1) return prev
        next.splice(from, 1)
        const to = next.indexOf(targetId)
        if (to === -1) return prev
        next.splice(before ? to : to + 1, 0, draggedId)
        return next
      })
    },
    [setIds]
  )

  const value = useMemo<PinnedMenus>(
    () => ({
      ids,
      isPinned: (id) => ids.includes(id),
      pin,
      unpin,
      toggle,
      move,
      dragMenuId,
      setDragMenuId,
    }),
    [ids, pin, unpin, toggle, move, dragMenuId]
  )

  return (
    <PinnedMenusContext.Provider value={value}>
      {children}
    </PinnedMenusContext.Provider>
  )
}
