import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { getCurrentWindow } from "@tauri-apps/api/window"

import "./index.css"
import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"
import { ExternalLinkGuard } from "./components/external-link-guard.tsx"
import { WidgetRoot } from "@/features/widget/widget-root.tsx"
import { Toaster } from "@/components/ui/sonner"
import { isTauri } from "@/lib/tauri"

// 창 라벨로 렌더링할 화면을 분기한다.
// `widget` 창은 트레이 팝오버(질문 표시) 전용, 그 외(`main`)에는 전체 앱을 그린다.
const windowLabel = isTauri() ? getCurrentWindow().label : "main"

const root = createRoot(document.getElementById("root")!)

if (windowLabel === "widget") {
  // 투명 배경의 작은 창 — 전역 배경색을 투명으로 덮어쓴다.
  document.documentElement.classList.add("widget-window")
  root.render(
    <StrictMode>
      <ThemeProvider>
        <WidgetRoot />
      </ThemeProvider>
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <ExternalLinkGuard />
        <main data-ui-scroll-container>
          <App />
        </main>
        <Toaster />
      </ThemeProvider>
    </StrictMode>,
  )
}
