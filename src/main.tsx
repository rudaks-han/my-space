import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { ThemeProviders } from "@/components/theme-preset-provider.tsx"
import { ExternalLinkGuard } from "./components/external-link-guard.tsx"
import { PetRoot } from "@/features/pet/pet-root.tsx"
import { SettingsProvider } from "@/features/settings/settings-store.tsx"
import { ViewWindowRoot } from "@/features/popout/view-window-root.tsx"
import { Toaster } from "@/components/ui/sonner"
import { isPetWindow, isViewWindow } from "@/lib/window-role"

// 창 라벨로 렌더링할 화면을 분기한다(window-role.ts).
// `pet` 창은 캐릭터 겸 알림 창구, `view-*` 창은 "새 창으로 열기"로 띄운 메뉴 한 개,
// 그 외(`main`)에는 전체 앱(셸 + 탭)을 그린다.
const root = createRoot(document.getElementById("root")!)

if (isPetWindow) {
  // 펫 창도 투명 배경 — 캐릭터와 말풍선만 화면에 떠 보여야 한다.
  document.documentElement.classList.add("pet-window")
  root.render(
    <StrictMode>
      <ThemeProviders>
        {/* 펫 설정(크기·말풍선·클릭 통과)을 이 창에서도 읽어야 한다.
            localStorage 기반이라 메인 창에서 바꾸면 storage 이벤트로 바로 따라온다. */}
        <SettingsProvider>
          <PetRoot />
        </SettingsProvider>
      </ThemeProviders>
    </StrictMode>
  )
} else if (isViewWindow) {
  root.render(
    <StrictMode>
      <ThemeProviders>
        <ExternalLinkGuard />
        <main data-ui-scroll-container>
          <ViewWindowRoot />
        </main>
        <Toaster />
      </ThemeProviders>
    </StrictMode>
  )
} else {
  root.render(
    <StrictMode>
      <ThemeProviders>
        <ExternalLinkGuard />
        <main data-ui-scroll-container>
          <App />
        </main>
        <Toaster />
      </ThemeProviders>
    </StrictMode>
  )
}
