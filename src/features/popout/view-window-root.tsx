import { TooltipProvider } from "@/components/ui/tooltip"
import { ClaudeActivityProvider } from "@/features/claude-bridge/claude-activity-store"
import { ReminderProvider } from "@/features/reminder/reminder-store"
import { SettingsProvider } from "@/features/settings/settings-store"
import { AuthProvider } from "@/features/auth/auth-store"
import { SlackProvider } from "@/features/slack/slack-store"
import { GmailProvider } from "@/features/gmail/gmail-store"
import { NavigationProvider } from "@/lib/navigation-store"
import { trackedInvoke } from "@/lib/tauri"
import { SETTINGS_ID } from "@/lib/use-open-tabs"
import { viewElement, viewInfo } from "@/lib/view-info"
import { viewWindowMenuId } from "@/lib/window-role"

/**
 * "새 창으로 열기"(뷰 헤더 우측 버튼)로 띄운 창의 루트.
 *
 * 메인 창의 셸(탭·사이드바) 없이 메뉴 한 개만 그린다. 어떤 메뉴인지는 창 라벨/쿼리에서
 * 온다(window-role.ts). 메인 창과 같은 Provider 를 두르므로 각 뷰는 코드 수정 없이
 * 그대로 동작한다 — 다만 전역 스케줄러(알림 발생·작업 이력 기록)는 메인 창에서만 돌도록
 * 각 Provider 안에서 창 라벨로 걸러 중복 알림이 뜨지 않게 했다.
 *
 * 탭이 없으니 useTabActive() 는 항상 true 다 → 폴링이 정상 동작하고, 임베드 웹뷰를 쓰는
 * 화면(브라우저 등)도 숨김 처리 없이 계속 보인다. 웹뷰 라벨은 창별로 달라진다(browserLabel).
 */
export function ViewWindowRoot() {
  const id = viewWindowMenuId()
  const info = id ? viewInfo(id) : null

  if (!id || !info) {
    return (
      <div className="grid h-svh place-items-center bg-background p-8 text-center text-[15px] text-muted-foreground">
        표시할 화면을 찾을 수 없습니다.
      </div>
    )
  }

  const Icon = info.icon

  return (
    <TooltipProvider>
      <AuthProvider>
        <SettingsProvider>
          <ReminderProvider>
            <SlackProvider>
              <GmailProvider>
                <ClaudeActivityProvider>
                  {/* 홈 카드의 "전체 보기 →" 등은 (탭이 없으므로) 그 메뉴를 또 새 창으로 띄운다. */}
                  <NavigationProvider
                    onNavigate={(menuId) => {
                      const target = viewInfo(menuId)
                      if (!target) return
                      void trackedInvoke("open_view_window", {
                        id: target.id,
                        title: target.title,
                      }).catch((e) => console.error("새 창 열기 실패:", e))
                    }}
                  >
                    <div className="flex h-svh flex-col overflow-hidden bg-ui-chrome">
                      {/* 상단 크롬 바 — 메인 창의 타이틀바와 같은 높이·색이고 신호등 자리만 둔다.
                      제목은 아래 뷰 헤더가 맡으므로 여기에는 아무것도 넣지 않고,
                      바 전체를 창 드래그 핸들로 쓴다. */}
                      <header
                        data-tauri-drag-region
                        className="h-(--ui-titlebar-h) shrink-0 bg-ui-chrome"
                      />
                      {/* 흰 패널 — 메인 창의 에디터 영역과 같다(좌상단만 라운드). */}
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-tl-[var(--ui-panel-radius)] bg-background">
                        {/* 뷰 헤더 — 팝업 전(메인 창 탭 바 아래)과 같은 자리·같은 모양. */}
                        <div className="flex h-(--ui-breadcrumb-h) shrink-0 items-center gap-2 border-b border-ui-tab-border px-5 select-none">
                          <Icon className="size-[18px] shrink-0" />
                          <span className="truncate text-[18px] font-bold tracking-[-0.01em]">
                            {info.title}
                          </span>
                          {info.id !== SETTINGS_ID && (
                            <span className="truncate text-[13px] text-muted-foreground">
                              {info.group}
                            </span>
                          )}
                        </div>
                        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-5">
                          {viewElement(id)}
                        </div>
                      </div>
                    </div>
                  </NavigationProvider>
                </ClaudeActivityProvider>
              </GmailProvider>
            </SlackProvider>
          </ReminderProvider>
        </SettingsProvider>
      </AuthProvider>
    </TooltipProvider>
  )
}
