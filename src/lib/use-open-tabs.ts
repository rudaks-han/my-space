import { useCallback, useMemo } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { MENUS } from "@/menus"

/** 설정 화면은 사이드바 메뉴가 아니지만 탭으로는 열린다(좌측 레일 하단 톱니 아이콘). */
export const SETTINGS_ID = "settings"

/** 열린 탭 목록 저장 키. 활성 탭 id 는 기존 키(myspace.activeMenu)를 그대로 재사용한다. */
const TABS_KEY = "myspace.openTabs"
const ACTIVE_KEY = "myspace.activeMenu"

export interface OpenTabsState {
  /** 열린 탭 id 순서 */
  openIds: string[]
  /** 활성 탭 id */
  activeId: string
  /** 없으면 추가하고 활성화, 있으면 활성화만 */
  open: (id: string) => void
  close: (id: string) => void
  setActive: (id: string) => void
  /** draggedId 탭을 targetId 탭의 앞(before) 또는 뒤로 옮긴다(드래그 재정렬). */
  move: (draggedId: string, targetId: string, before: boolean) => void
}

/** 실제로 존재하는 탭 id 집합(메뉴 + 설정). */
function validIds(): Set<string> {
  return new Set<string>([...MENUS.map((m) => m.id), SETTINGS_ID])
}

/** 존재하지 않는 id·중복을 걸러낸다. 남는 게 없으면 홈만 남긴다. */
function sanitize(ids: string[]): string[] {
  const valid = validIds()
  const out: string[] = []
  for (const id of ids) {
    if (valid.has(id) && !out.includes(id)) out.push(id)
  }
  return out.length > 0 ? out : ["home"]
}

/**
 * 열린 뷰 탭 상태(Slack 의 밑줄 탭 행이 이 목록을 그린다).
 *
 * 열린 탭 목록과 활성 탭을 localStorage 에 유지한다. 렌더는 **활성 탭의 뷰만** 마운트한다
 * (각 뷰가 폴링을 하므로 열린 탭 전부를 마운트하면 폴링이 탭 수만큼 늘어난다).
 * 그래서 탭을 전환하면 뷰 상태가 초기화되는데, 이는 의도된 트레이드오프다.
 */
export function useOpenTabs(): OpenTabsState {
  const [storedIds, setStoredIds] = useLocalStorage<string[]>(TABS_KEY, [
    "home",
  ])
  const [storedActive, setStoredActive] = useLocalStorage<string>(
    ACTIVE_KEY,
    "home"
  )

  // 저장된 값이 손상됐거나 메뉴가 사라진 경우를 렌더 시점에 보정한다(상태를 되쓰지 않는다).
  // openIds 는 아래 useCallback 들의 의존성이므로 매 렌더마다 새 배열이 되지 않도록 memo 한다.
  const sanitized = useMemo(() => sanitize(storedIds), [storedIds])
  const activeId = useMemo(
    () => (validIds().has(storedActive) ? storedActive : sanitized[0]),
    [storedActive, sanitized]
  )
  // 기존 myspace.activeMenu 에만 있던 메뉴(탭 도입 전 상태)는 탭 목록에 합쳐 준다.
  const openIds = useMemo(
    () => (sanitized.includes(activeId) ? sanitized : [...sanitized, activeId]),
    [sanitized, activeId]
  )

  const open = useCallback(
    (id: string) => {
      if (!validIds().has(id)) return
      setStoredIds((prev) => {
        const cur = sanitize(prev)
        return cur.includes(id) ? cur : [...cur, id]
      })
      setStoredActive(id)
    },
    [setStoredIds, setStoredActive]
  )

  const close = useCallback(
    (id: string) => {
      // 마지막 한 개는 닫을 수 없다(탭이 전부 사라지면 보여 줄 뷰가 없다).
      if (openIds.length <= 1) return
      const idx = openIds.indexOf(id)
      if (idx === -1) return
      setStoredIds(openIds.filter((t) => t !== id))
      // 활성 탭을 닫으면 오른쪽 탭 → 없으면 왼쪽 탭을 활성화한다.
      if (activeId === id) {
        setStoredActive(openIds[idx + 1] ?? openIds[idx - 1])
      }
    },
    [openIds, activeId, setStoredIds, setStoredActive]
  )

  const setActive = useCallback(
    (id: string) => {
      setStoredActive(id)
    },
    [setStoredActive]
  )

  const move = useCallback(
    (draggedId: string, targetId: string, before: boolean) => {
      if (draggedId === targetId) return
      // storedIds 가 아니라 보정된 openIds 를 기준으로 옮긴다(활성 탭만 저장돼 있던 경우 포함).
      const ids = [...openIds]
      const from = ids.indexOf(draggedId)
      if (from === -1) return
      // 먼저 빼낸 뒤 대상 위치를 다시 찾는다(제거 전 인덱스로 넣으면 한 칸씩 밀린다).
      ids.splice(from, 1)
      const to = ids.indexOf(targetId)
      if (to === -1) return
      ids.splice(before ? to : to + 1, 0, draggedId)
      setStoredIds(ids)
    },
    [openIds, setStoredIds]
  )

  return { openIds, activeId, open, close, setActive, move }
}
