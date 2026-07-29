import type { ReactNode } from "react"

import { TabActiveContext } from "./use-tab-active"

/** 탭 하나를 감싸 그 탭이 활성인지 하위 뷰에 알린다(App 이 활성 탭 상태를 들고 있다). */
export function TabActiveProvider({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  return (
    <TabActiveContext.Provider value={active}>
      {children}
    </TabActiveContext.Provider>
  )
}
