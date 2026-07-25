import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  BotIcon,
  CalendarIcon,
  CheckIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCwIcon,
  ServerIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useIsDark } from "@/components/theme-provider"
import { useThemePreset } from "@/components/theme-preset-provider"
import { useSettings } from "./settings-store"
import { SlackConnectionPanel } from "@/features/slack/slack-connection"
import { GcalConnectionPanel } from "@/features/gcal/gcal-connection"
import type { McpStatus } from "@/features/intellij/use-services"

/** 설정 한 줄: 왼쪽에 제목·설명, 오른쪽에 on/off 스위치. */
function SettingRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          checked ? "bg-primary" : "bg-input"
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block size-4 rounded-full bg-background shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5"
          )}
        />
      </button>
    </div>
  )
}

/** 설정 한 줄: 왼쪽에 제목·설명, 오른쪽에 프리셋 선택 버튼들. */
function SettingChoiceRow<T extends string | number>({
  title,
  description,
  value,
  options,
  onChange,
}: {
  title: string
  description: string
  value: T
  options: { label: string; value: T }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <div className="inline-flex shrink-0 gap-1 rounded-md bg-input/50 p-0.5">
        {options.map((o) => {
          const isActive = o.value === value
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(o.value)}
              className={cn(
                "cursor-pointer rounded px-2.5 py-1 text-xs transition-colors",
                isActive
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * 테마 프리셋 카드 하나(미니 미리보기 + 이름).
 *
 * 미리보기 색은 고정값이 아니라 **지금 적용 중인 모드**의 CSS 변수에서 읽는다.
 * 다크 스와치를 보여주고 라이트 색을 적용하면 "테마가 안 먹었다"로 보이기 때문이다.
 */
function PresetCard({
  preset,
  selected,
  onSelect,
}: {
  preset: ReturnType<typeof useThemePreset>["presets"][number]
  selected: boolean
  onSelect: () => void
}) {
  const isDark = useIsDark()
  const vars = preset.forcedMode
    ? preset[preset.forcedMode]
    : isDark
      ? preset.dark
      : preset.light
  const preview = {
    bg: vars["--background"],
    sidebar: vars["--sidebar"],
    primary: vars["--primary"],
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-2 rounded-xl border p-2 text-left transition-all",
        selected
          ? "border-primary ring-2 ring-primary/30"
          : "border-border hover:border-foreground/25"
      )}
    >
      {/* 앱 레이아웃을 축소한 미리보기: 왼쪽 사이드바 + 콘텐츠 영역 */}
      <div
        className="flex h-16 overflow-hidden rounded-lg border"
        style={{ background: preview.bg }}
      >
        <div
          className="flex w-1/3 flex-col justify-between p-1.5"
          style={{ background: preview.sidebar }}
        >
          <div className="flex flex-col gap-1">
            <span
              className="h-1.5 w-full rounded-full opacity-70"
              style={{ background: preview.primary }}
            />
            <span className="h-1.5 w-3/4 rounded-full bg-current opacity-20" />
            <span className="h-1.5 w-3/4 rounded-full bg-current opacity-20" />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-1 p-1.5">
          <span className="h-1.5 w-1/2 rounded-full bg-current opacity-15" />
          <span className="h-1.5 w-full rounded-full bg-current opacity-10" />
          <span
            className="mt-auto h-3 w-8 rounded-md"
            style={{ background: preview.primary }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{preset.label}</span>
          <span className="truncate text-xs text-muted-foreground">
            {preset.description}
          </span>
        </div>
        {selected && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <CheckIcon className="size-2.5" />
          </span>
        )}
      </div>
    </button>
  )
}

/** Theme(테마 프리셋) 설정 화면. */
function AppearanceSettingsPanel() {
  const { presets, presetId, setPreset } = useThemePreset()

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Theme</h2>
        <p className="text-sm text-muted-foreground">
          앱 전체의 색감을 유명 앱 스타일로 바꿉니다. 라이트/다크 모드는 상단의
          토글로 따로 전환할 수 있고, 원본이 한쪽 모드만 있는 테마(Darcula 등)를
          고르면 그 모드로 고정됩니다.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {presets.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            selected={p.id === presetId}
            onSelect={() => setPreset(p.id)}
          />
        ))}
      </div>
    </div>
  )
}

/** Slack 카테고리 설정 화면. */
function SlackSettingsPanel() {
  const { settings, setSlack } = useSettings()

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Slack</h2>
        <p className="text-sm text-muted-foreground">
          Slack 연결을 관리하고, 안 읽은 메시지 새로고침 주기를 설정합니다.
        </p>
      </div>

      {/* 연결 관리(연결 · 재연결 · 연결 해제) */}
      <div className="mt-4">
        <SlackConnectionPanel />
      </div>

      {/* 폴링 주기 */}
      <div className="mt-4 divide-y border-t">
        <SettingChoiceRow
          title="새로고침 주기"
          description="선택한 채널의 안 읽은 메시지를 이 주기마다 다시 확인합니다. 짧을수록 빠르게 반영되지만 Slack 요청 한도에 더 가까워집니다."
          value={settings.slack.pollSeconds}
          options={[
            { label: "30초", value: 30 },
            { label: "1분", value: 60 },
            { label: "2분", value: 120 },
            { label: "5분", value: 300 },
            { label: "10분", value: 600 },
          ]}
          onChange={(v) => setSlack({ pollSeconds: v })}
        />
      </div>
    </div>
  )
}

/** Google Calendar 카테고리 설정 화면 — Google 계정 연결/해제. */
function GoogleCalendarSettingsPanel() {
  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Google Calendar</h2>
        <p className="text-sm text-muted-foreground">
          Calendar 메뉴에서 오늘 일정을 보려면 Google 계정을 연결해야 합니다.
          연결을 해제하면 저장된 토큰과 클라이언트 정보가 삭제됩니다.
        </p>
      </div>

      {/* 연결 관리(연결 · 연결 해제) */}
      <div className="mt-4">
        <GcalConnectionPanel />
      </div>
    </div>
  )
}

/** Claude Code 카테고리 설정 화면. */
function ClaudeCodeSettingsPanel() {
  const { settings, setClaudeCode } = useSettings()
  const s = settings.claudeCode

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Claude Code</h2>
        <p className="text-sm text-muted-foreground">
          Claude Code(herdr) 작업을 감시하고, 상태가 바뀔 때 받을 인앱
          알림(토스트)을 설정합니다.
        </p>
      </div>
      <div className="mt-2 divide-y">
        <SettingRow
          title="작업 감시"
          description="herdr 작업 상태를 주기적으로 확인해 작업목록 갱신·트레이 알림을 구동합니다. 끄면 아래 알림도 동작하지 않습니다."
          checked={s.watchEnabled}
          onChange={(v) => setClaudeCode({ watchEnabled: v })}
        />
        <SettingRow
          title="입력 대기 알림"
          description="Claude 가 질문·권한 등 사용자 응답을 기다릴 때 알립니다."
          checked={s.notifyOnBlocked}
          onChange={(v) => setClaudeCode({ notifyOnBlocked: v })}
        />
        <SettingRow
          title="작업 완료 알림"
          description="진행 중이던 작업이 끝났을 때 알립니다."
          checked={s.notifyOnDone}
          onChange={(v) => setClaudeCode({ notifyOnDone: v })}
        />
      </div>
    </div>
  )
}

/** 설명 한 줄: 제목 + 본문. 토글이 없는 안내용 행. */
function InfoRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

/**
 * IntelliJ 연동 설정 화면 — MCP 서버 연결 상태와 설정 방법.
 *
 * IntelliJ Services 메뉴는 IDE 내장 MCP 서버를 통해 동작하므로, 연결이 안 되면
 * 아무것도 할 수 없다. 그래서 상태를 여기서 바로 확인하고 고칠 수 있게 한다.
 */
function IntellijSettingsPanel() {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    if (!isTauri()) return
    setChecking(true)
    try {
      setStatus(await trackedInvoke<McpStatus>("intellij_mcp_status"))
    } catch (e) {
      setStatus({ connected: false, url: null, error: String(e) })
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    // 화면에 들어오면 바로 현재 상태를 확인한다(데이터 페칭 목적의 의도된 패턴).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check()
  }, [check])

  const connected = status?.connected === true

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">IntelliJ</h2>
        <p className="text-sm text-muted-foreground">
          IntelliJ Services 메뉴는 IDE 내장 MCP 서버를 통해 실행 설정을 읽고
          실행합니다. 연결되어 있지 않으면 목록이 비어 있고 시작·종료도 할 수
          없습니다.
        </p>
      </div>

      {/* 현재 연결 상태 */}
      <div
        className={cn(
          "mt-3 rounded-md border px-3 py-2.5",
          connected
            ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30"
            : "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30"
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connected ? "bg-emerald-500" : "bg-amber-500"
            )}
          />
          <span className="text-sm font-medium">
            {status === null ? "확인 중…" : connected ? "연결됨" : "연결 안 됨"}
          </span>
          {connected && status?.url && (
            <span className="font-mono text-xs text-muted-foreground">
              {status.url}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0"
            onClick={() => void check()}
            disabled={checking}
          >
            <RotateCwIcon
              className={cn("size-4", checking && "animate-spin")}
            />
            다시 확인
          </Button>
        </div>
        {!connected && status?.error && (
          <div className="mt-2 font-mono text-xs break-all text-muted-foreground">
            {status.error}
          </div>
        )}
      </div>

      {/* 연결이 안 됐을 때만 설정 절차를 펼쳐 보여 준다. */}
      {status !== null && !connected && (
        <div className="mt-3 rounded-md border px-3 py-2.5">
          <div className="text-sm font-medium">설정 방법</div>
          <ol className="mt-1.5 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>IntelliJ IDEA(2025.2 이상)를 실행합니다.</li>
            <li>
              <span className="text-foreground">
                Settings → Tools → MCP Server
              </span>{" "}
              에서
              <span className="text-foreground"> Enable MCP Server</span> 를
              켭니다.
            </li>
            <li>
              사용할 프로젝트를 IntelliJ 에서 열어 둡니다(열린 프로젝트만 대상이
              됩니다).
            </li>
            <li>위 “다시 확인” 을 누릅니다.</li>
          </ol>
        </div>
      )}

      <div className="mt-3 divide-y border-t">
        <InfoRow title="접속 주소">
          IDE 내장 웹서버 포트 + 1000 을 씁니다(기본 63342 → 64342). 포트가 밀릴
          수 있어 64342~64345 를 차례로 확인합니다. 다른 주소를 쓰려면 환경변수{" "}
          <span className="font-mono">MYSPACE_INTELLIJ_MCP_URL</span> 로
          지정하세요.
        </InfoRow>
        <InfoRow title="종료·재시작 제어">
          MCP 에는 실행을 멈추는 기능이 없어, IDE 가 띄운 프로세스를 찾아 직접
          종료합니다. 이때 메인 클래스를 알아야 하므로 실행 설정이{" "}
          <span className="font-mono">.idea/runConfigurations</span> 에 저장돼
          있어야 합니다 (실행 설정 편집 창의{" "}
          <span className="text-foreground">Store as project file</span>).
          저장돼 있지 않으면 시작만 가능합니다.
        </InfoRow>
        <InfoRow title="콘솔 로그">
          my-space 로 시작한 실행은 로그가 바로 보입니다. IDE 의 Run 버튼으로
          띄운 실행은 콘솔이 IntelliJ 안에만 남아 읽을 수 없으므로, 실행 설정의{" "}
          <span className="text-foreground">Logs</span> 탭에서{" "}
          <span className="text-foreground">Save console output to file</span>{" "}
          을 켜 두면 어느 쪽으로 띄워도 로그가 동기화됩니다.
        </InfoRow>
      </div>
    </div>
  )
}

interface SettingsCategory {
  id: string
  label: string
  icon: LucideIcon
  panel: ReactNode
}

/**
 * ★ 설정 카테고리 추가 지점 ★
 * 새 설정 그룹이 생기면 여기에 { id, label, icon, panel } 을 추가하면
 * 왼쪽 카테고리 목록과 오른쪽 화면에 자동 반영된다.
 */
const CATEGORIES: SettingsCategory[] = [
  {
    id: "appearance",
    label: "Theme",
    icon: PaletteIcon,
    panel: <AppearanceSettingsPanel />,
  },
  {
    id: "slack",
    label: "Slack",
    icon: MessageSquareIcon,
    panel: <SlackSettingsPanel />,
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    icon: CalendarIcon,
    panel: <GoogleCalendarSettingsPanel />,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    icon: BotIcon,
    panel: <ClaudeCodeSettingsPanel />,
  },
  {
    id: "intellij",
    label: "IntelliJ",
    icon: ServerIcon,
    panel: <IntellijSettingsPanel />,
  },
]

/** 카테고리별 설정 화면(왼쪽 카테고리 목록 → 오른쪽 상세). */
export function SettingsView() {
  const [activeId, setActiveId] = useState(CATEGORIES[0].id)
  const active = CATEGORIES.find((c) => c.id === activeId) ?? CATEGORIES[0]

  return (
    <div className="flex min-h-0 flex-1 gap-6">
      <nav className="w-48 shrink-0">
        <ul className="flex flex-col gap-1">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            const isActive = c.id === active.id
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <Icon className="size-4" />
                  <span>{c.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{active.panel}</div>
    </div>
  )
}
