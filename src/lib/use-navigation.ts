import { createContext, useContext } from "react"

/**
 * 화면(사이드바 메뉴) 전환 함수를 하위 트리에 공유한다.
 * 활성 메뉴 상태는 App 이 들고 있고, MENU_GROUPS 는 뷰 element 를 정적으로 만들기 때문에
 * props 로 내려보낼 수 없다. 홈 화면의 카드가 "전체 보기 →" 로 다른 메뉴로 이동할 때 쓴다.
 */
export const NavigationContext = createContext<
  ((menuId: string) => void) | null
>(null)

/** 메뉴 id 로 화면을 전환한다. Provider 밖에서는 아무 일도 하지 않는다. */
export function useNavigate(): (menuId: string) => void {
  return useContext(NavigationContext) ?? (() => {})
}
