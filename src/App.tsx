import type { CSSProperties } from "react"
import { useEffect } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useLocalStorage } from "@/lib/use-local-storage"
import { ReminderProvider } from "@/features/reminder/reminder-store"
import { SlackProvider } from "@/features/slack/slack-store"
import { SettingsProvider } from "@/features/settings/settings-store"
import { SettingsView } from "@/features/settings/settings-view"
import { ClaudeNotifier } from "@/features/claude-bridge/claude-notifier"
import { MENUS } from "@/menus"
import { checkForUpdates } from "@/lib/updater"

/** 설정 화면은 사이드바 메뉴가 아닌 별도 화면(톱니 아이콘)으로 연다. */
const SETTINGS_ID = "settings"

export default function App() {
  const [activeId, setActiveId] = useLocalStorage<string>(
    "myspace.activeMenu",
    "home",
  )
  const isSettings = activeId === SETTINGS_ID
  const active = MENUS.find((m) => m.id === activeId) ?? MENUS[0]
  const title = isSettings ? "설정" : active.title

  // 앱 시작 시 GitHub 릴리스에 새 버전이 있는지 한 번 확인한다.
  useEffect(() => {
    void checkForUpdates()
  }, [])

  return (
    <TooltipProvider>
      <SettingsProvider>
        <ReminderProvider>
          <SlackProvider>
            <ClaudeNotifier />
            <SidebarProvider
              style={
                {
                  "--sidebar-width": "calc(var(--spacing) * 64)",
                  "--header-height": "calc(var(--spacing) * 12)",
                } as CSSProperties
              }
            >
              <AppSidebar
                variant="inset"
                activeId={activeId}
                onSelectMenu={setActiveId}
              />
              <SidebarInset className="min-w-0">
                <SiteHeader title={title} />
                <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden p-4 md:p-6">
                  {isSettings ? <SettingsView /> : active.element}
                </div>
              </SidebarInset>
            </SidebarProvider>
          </SlackProvider>
        </ReminderProvider>
      </SettingsProvider>
    </TooltipProvider>
  )
}
