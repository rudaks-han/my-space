import { useCallback } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { MENU_GROUPS, type MenuGroup, type MenuItem } from "@/menus"

/** 그룹 id → 항목 id 순서 배열. */
type OrderMap = Record<string, string[]>

const STORAGE_KEY = "myspace.menuOrder"

/**
 * 저장된 순서(order)를 실제 항목 배열에 적용한다.
 * - order 에 있는 id 부터 그 순서대로 넣고
 * - order 에 없는(새로 추가된) 항목은 menus.tsx 의 "선언 위치"에 끼워 넣는다
 *   (맨 뒤에 붙이지 않는다 — 그러면 새 메뉴가 항상 그룹 맨 아래로 가버린다)
 * - order 에만 있고 실제로 없는 id 는 무시한다
 */
function applyOrder(
  items: MenuItem[],
  order: string[] | undefined
): MenuItem[] {
  if (!order || order.length === 0) return items
  const declaredIndex = new Map(items.map((it, i) => [it.id, i]))
  const byId = new Map(items.map((i) => [i.id, i]))

  // 1) 저장된 순서대로 먼저 배치(실제로 존재하는 것만).
  const result: MenuItem[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      result.push(item)
      byId.delete(id)
    }
  }

  // 2) 남은(새로 추가된) 항목을 선언 순서 위치에 끼워 넣는다.
  //    각 새 항목은, 자신보다 선언 인덱스가 큰 첫 항목 바로 앞에 넣는다.
  for (const item of items) {
    if (!byId.has(item.id)) continue
    const di = declaredIndex.get(item.id) ?? 0
    let insertAt = result.findIndex((r) => (declaredIndex.get(r.id) ?? -1) > di)
    if (insertAt === -1) insertAt = result.length
    result.splice(insertAt, 0, item)
  }
  return result
}

/**
 * 사이드바 메뉴 순서를 사용자가 그룹 내에서 드래그로 바꿀 수 있게 하고, 그 순서를
 * localStorage 에 그룹별로 저장한다. 그룹 자체의 순서는 고정(의미 단위)이며 항목만
 * 재정렬한다.
 */
export function useMenuOrder() {
  const [orderMap, setOrderMap] = useLocalStorage<OrderMap>(STORAGE_KEY, {})

  const groups: MenuGroup[] = MENU_GROUPS.map((g) => ({
    ...g,
    items: applyOrder(g.items, orderMap[g.id]),
  }))

  /**
   * 같은 그룹 안에서 draggedId 항목을 targetId 항목의 앞(before) 또는 뒤로 옮긴다.
   * before 가 없으면 항상 앞에만 넣게 되어 마지막 자리로는 옮길 수 없다.
   */
  const moveItem = useCallback(
    (groupId: string, draggedId: string, targetId: string, before = true) => {
      if (draggedId === targetId) return
      setOrderMap((prev) => {
        const base = MENU_GROUPS.find((g) => g.id === groupId)
        if (!base) return prev
        const ids = applyOrder(base.items, prev[groupId]).map((i) => i.id)
        const from = ids.indexOf(draggedId)
        if (from === -1) return prev
        // 먼저 제거한 뒤 대상 위치를 다시 찾아 넣는다.
        // (제거 전 인덱스로 넣으면 아래로 끄는 드래그에서 한 칸씩 밀린다.)
        ids.splice(from, 1)
        const to = ids.indexOf(targetId)
        if (to === -1) return prev
        ids.splice(before ? to : to + 1, 0, draggedId)
        return { ...prev, [groupId]: ids }
      })
    },
    [setOrderMap]
  )

  return { groups, moveItem }
}
