import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import {
  ActivityBar,
  type ActivityContainerId,
} from "@/components/shell/activity-bar"
import { SideBar } from "@/components/shell/side-bar"
import { StatusBar } from "@/components/shell/status-bar"
import { TabBar } from "@/components/shell/tab-bar"
import { TitleBar } from "@/components/shell/title-bar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SETTINGS_ID, useOpenTabs } from "@/lib/use-open-tabs"
import { NavigationProvider } from "@/lib/navigation-store"
import { ReminderProvider } from "@/features/reminder/reminder-store"
import { SlackProvider } from "@/features/slack/slack-store"
import { GmailProvider } from "@/features/gmail/gmail-store"
import { SettingsProvider } from "@/features/settings/settings-store"
import { ClaudeNotifier } from "@/features/claude-bridge/claude-notifier"
import { ClaudeActivityProvider } from "@/features/claude-bridge/claude-activity-store"
import { PetController } from "@/features/pet/pet-controller"
import { PetFeedPublisher } from "@/features/pet/pet-feed-publisher"
import { useAutoStartSync } from "@/features/settings/use-autostart"
import { TabActiveProvider } from "@/lib/tab-active-store"
import { checkForUpdates } from "@/lib/updater"
import { cn } from "@/lib/utils"
import { viewElement } from "@/lib/view-info"

/**
 * 설정의 "로그인 시 자동 실행"을 OS 등록 상태에 맞추기만 하는 껍데기.
 * 설정을 읽어야 해서 SettingsProvider 안에 있어야 하고(App 자신은 그 밖이다),
 * App 은 메인 창에서만 렌더되므로 창 구분은 따로 하지 않는다.
 */
function AutoStartSync() {
  useAutoStartSync()
  return null
}

export default function App() {
  // 열린 탭·활성 탭(활성 탭 id 는 기존 myspace.activeMenu 키를 그대로 쓴다).
  const { openIds, activeId, open, close, setActive, move } = useOpenTabs()
  // 사이드바에 어떤 컨테이너를 띄울지와 접힘 여부(셸 레이아웃 상태).
  const [container, setContainer] = useState<ActivityContainerId>("explorer")
  const [collapsed, setCollapsed] = useState(false)

  const isSettings = activeId === SETTINGS_ID

  // 한 번 본 탭은 닫을 때까지 마운트해 둔다 — 다시 들어왔을 때 조회를 새로 하지 않고
  // 이전 정보(불러온 데이터·입력값·스크롤)를 그대로 보여 주기 위해서다. 보이지 않는 탭은
  // CSS 로만 감추고, 숨은 동안 폴링은 useTabActive 로 각 훅이 멈춘다.
  // 처음부터 전부 마운트하지는 않는다(앱 시작 때 열린 탭 수만큼 조회가 몰리지 않게).
  const [mountedIds, setMountedIds] = useState<string[]>(() => [activeId])
  // 닫힌 탭은 목록에서 빼 언마운트한다(닫으면 상태를 버린다 = 다시 열면 새로 조회).
  const nextMounted = mountedIds.filter((id) => openIds.includes(id))
  if (!nextMounted.includes(activeId)) nextMounted.push(activeId)
  if (
    nextMounted.length !== mountedIds.length ||
    nextMounted.some((id, i) => id !== mountedIds[i])
  ) {
    setMountedIds(nextMounted)
  }

  // 활성 컨테이너 아이콘을 다시 누르면 사이드바가 접힌다.
  const selectContainer = (id: ActivityContainerId) => {
    if (!collapsed && container === id) {
      setCollapsed(true)
      return
    }
    setContainer(id)
    setCollapsed(false)
  }

  // 상단바 검색 알약 → 사이드바를 펼치고 메뉴 검색 컨테이너로 전환.
  const openSearch = () => {
    setContainer("search")
    setCollapsed(false)
  }

  // 앱 시작 시 GitHub 릴리스에 새 버전이 있는지 한 번 확인한다.
  useEffect(() => {
    void checkForUpdates()
  }, [])

  // 데스크톱 펫을 누르면 Rust(`pet_open_menu`)가 이 창을 앞으로 가져오고 이 이벤트를 보낸다.
  // 메뉴 탭을 여는 상태는 이 창에만 있으므로 실제로 여는 일은 여기서 한다.
  useEffect(() => {
    const unlisten = listen<string>("pet:open-menu", (e) => {
      if (e.payload) open(e.payload)
    })
    return () => void unlisten.then((f) => f())
  }, [open])

  return (
    <TooltipProvider>
      <SettingsProvider>
        <ReminderProvider>
          <SlackProvider>
            <GmailProvider>
              <ClaudeActivityProvider>
                <ClaudeNotifier />
                {/* 설정의 "로그인 시 자동 실행" 을 OS 로그인 항목에 반영한다. */}
                <AutoStartSync />
                {/* 설정의 "상시 표시" 에 맞춰 데스크톱 펫 창을 띄운다/숨긴다. */}
                <PetController />
                {/* 이미 폴링해 둔 Slack·Gmail 안읽음 건수를 펫이 볼 수 있게 적어 둔다. */}
                <PetFeedPublisher />
                {/* 홈 화면 카드의 "전체 보기 →" 가 해당 메뉴 탭을 열게 한다. */}
                <NavigationProvider onNavigate={open}>
                  {/* 라벤더 크롬 위에 흰 패널(사이드바·에디터)이 얹힌 Slack 레이아웃 */}
                  <div className="flex h-svh flex-col overflow-hidden bg-ui-chrome">
                    <TitleBar
                      onOpenSearch={openSearch}
                      onToggleSidebar={() => setCollapsed((v) => !v)}
                    />
                    <div className="flex min-h-0 min-w-0 flex-1">
                      <ActivityBar
                        container={container}
                        collapsed={collapsed}
                        onSelectContainer={selectContainer}
                        onOpenSettings={() => open(SETTINGS_ID)}
                        settingsActive={isSettings}
                      />
                      {!collapsed && (
                        <SideBar
                          container={container}
                          activeId={activeId}
                          onSelectMenu={open}
                        />
                      )}
                      {/* 에디터 영역 — 탭 바 + 뷰 헤더 + 활성 뷰.
                        사이드바가 접혀 있으면 이쪽이 좌상단 라운드를 대신 맡는다. */}
                      <div
                        className={cn(
                          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background",
                          collapsed && "rounded-tl-[var(--ui-panel-radius)]"
                        )}
                      >
                        <TabBar
                          openIds={openIds}
                          activeId={activeId}
                          onSelect={setActive}
                          onClose={close}
                          onMove={move}
                        />
                        {/* 열린 탭들을 겹쳐 두고 활성 탭만 보인다. display:none 대신
                          visibility 로 감춰야 숨은 탭의 스크롤 위치가 유지된다. */}
                        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                          {nextMounted.map((id) => (
                            <TabActiveProvider
                              key={id}
                              active={id === activeId}
                            >
                              <div
                                className={cn(
                                  "absolute inset-0 flex flex-col overflow-x-hidden overflow-y-auto p-5",
                                  id !== activeId && "invisible"
                                )}
                              >
                                {viewElement(id)}
                              </div>
                            </TabActiveProvider>
                          ))}
                        </div>
                      </div>
                    </div>
                    <StatusBar onOpen={open} />
                  </div>
                </NavigationProvider>
              </ClaudeActivityProvider>
            </GmailProvider>
          </SlackProvider>
        </ReminderProvider>
      </SettingsProvider>
    </TooltipProvider>
  )
}
