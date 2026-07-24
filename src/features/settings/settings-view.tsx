import { useState, type ReactNode } from "react"
import { BotIcon, MessageSquareIcon, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useSettings } from "./settings-store"

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
        <span className="text-muted-foreground text-xs">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={cn(
          "focus-visible:ring-ring/50 relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors outline-none focus-visible:ring-3",
          checked ? "bg-primary" : "bg-input",
        )}
      >
        <span
          className={cn(
            "bg-background pointer-events-none inline-block size-4 rounded-full shadow-sm transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
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
        <span className="text-muted-foreground text-xs">{description}</span>
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
                  ? "bg-background text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
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

/** Slack 카테고리 설정 화면. */
function SlackSettingsPanel() {
  const { settings, setSlack } = useSettings()

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Slack</h2>
        <p className="text-muted-foreground text-sm">
          안 읽은 메시지를 자동으로 다시 불러오는 주기를 설정합니다. 짧을수록 빠르게
          반영되지만 Slack 요청 한도에 더 가까워집니다.
        </p>
      </div>
      <div className="mt-2 divide-y">
        <SettingChoiceRow
          title="새로고침 주기"
          description="선택한 채널의 안 읽은 메시지를 이 주기마다 다시 확인합니다."
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

/** Claude Code 카테고리 설정 화면. */
function ClaudeCodeSettingsPanel() {
  const { settings, setClaudeCode } = useSettings()
  const s = settings.claudeCode

  return (
    <div className="flex flex-col">
      <div>
        <h2 className="text-base font-semibold">Claude Code</h2>
        <p className="text-muted-foreground text-sm">
          Claude Code(herdr) 작업을 감시하고, 상태가 바뀔 때 받을 인앱 알림(토스트)을
          설정합니다.
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
    id: "slack",
    label: "Slack",
    icon: MessageSquareIcon,
    panel: <SlackSettingsPanel />,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    icon: BotIcon,
    panel: <ClaudeCodeSettingsPanel />,
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
                      ? "bg-muted text-foreground font-medium"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
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
