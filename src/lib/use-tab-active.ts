import { createContext, useContext } from "react"

/**
 * "이 뷰가 지금 보이는 탭인지"를 하위 트리에 공유한다.
 *
 * 탭은 한 번 열리면 닫을 때까지 마운트된 상태로 남고(다시 들어왔을 때 이전 정보를 그대로
 * 보여 주기 위해), 보이지 않는 탭은 CSS 로만 감춘다. 그래서 뷰가 "지금 화면에 있는지"를
 * 알아야 하는 경우가 생긴다 — 주기 새로고침처럼 숨어 있을 때는 멈춰야 하는 작업,
 * 그리고 CSS 로는 감춰지지 않는 네이티브 웹뷰(브라우저 뷰)가 그렇다.
 *
 * Provider 밖(위젯 창 등)에서는 항상 true 다.
 */
export const TabActiveContext = createContext(true)

/** 이 뷰가 지금 보이는 탭이면 true. */
export function useTabActive(): boolean {
  return useContext(TabActiveContext)
}
