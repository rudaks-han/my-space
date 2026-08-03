import { createContext, useContext } from "react"

/**
 * 좌측 레일(ActivityBar)에 꽂아 둔 메뉴. 사이드바를 접어 둔 채로도 한 번에 열 수 있는
 * 바로가기라, 사이드바의 그룹 구조와는 별개의 목록이다(메뉴는 원래 그룹에도 그대로 남는다).
 */
export interface PinnedMenus {
  /** 꽂아 둔 메뉴 id — 배열 순서가 곧 레일에 그려지는 순서다. */
  ids: string[]
  isPinned: (id: string) => boolean
  pin: (id: string) => void
  unpin: (id: string) => void
  toggle: (id: string) => void
  /** 레일 안에서 draggedId 를 targetId 앞(before) 또는 뒤로 옮긴다. */
  move: (draggedId: string, targetId: string, before?: boolean) => void
  /**
   * 사이드바에서 지금 끌고 있는 메뉴 id. 레일이 "여기 놓으면 꽂힌다" 자리를 띄우는
   * 신호이며, 드래그가 끝나면 null 로 돌아온다.
   *
   * 이 값이 localStorage 가 아니라 컨텍스트에 있는 이유: 사이드바와 레일은 서로 다른
   * 컴포넌트인데 `useLocalStorage` 는 **같은 창 안에서는** 서로의 변경을 통보하지 않는다
   * (`storage` 이벤트는 다른 창에서만 온다). 꽂은 목록도 같은 이유로 이 컨텍스트 하나가
   * 들고 있어야 양쪽이 같은 값을 본다.
   */
  dragMenuId: string | null
  setDragMenuId: (id: string | null) => void
}

/** 프로바이더가 없는 트리(팝아웃 창 등)에서도 훅이 터지지 않도록 하는 빈 구현. */
const EMPTY: PinnedMenus = {
  ids: [],
  isPinned: () => false,
  pin: () => {},
  unpin: () => {},
  toggle: () => {},
  move: () => {},
  dragMenuId: null,
  setDragMenuId: () => {},
}

export const PinnedMenusContext = createContext<PinnedMenus>(EMPTY)

export function usePinnedMenus() {
  return useContext(PinnedMenusContext)
}
