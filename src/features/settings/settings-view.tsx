import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  BotIcon,
  CalendarIcon,
  CatIcon,
  CheckIcon,
  DownloadIcon,
  FileTextIcon,
  HardDriveIcon,
  LogOutIcon,
  MailIcon,
  MessageSquareIcon,
  PalmtreeIcon,
  PaletteIcon,
  RotateCwIcon,
  ServerIcon,
  SlidersHorizontalIcon,
  SquareKanbanIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useIsDark } from "@/components/theme-provider"
import { useThemePreset } from "@/components/theme-preset-provider"
import { useSettings } from "./settings-context"
import { useAuth } from "@/features/auth/auth-context"
import {
  AUTOSTART_SUPPORTED,
  applyAutoStart,
  useAutoStartState,
} from "./use-autostart"
import { SlackConnectionPanel } from "@/features/slack/slack-connection"
import { GcalConnectionPanel } from "@/features/gcal/gcal-connection"
import { GdriveConnectionPanel } from "@/features/gdrive/gdrive-connection"
import { GmailSettingsPanel } from "@/features/gmail/gmail-settings"
import { JiraConnectionPanel } from "@/features/jira/jira-connection"
import { FlexSettingsPanel } from "@/features/flex/flex-settings"
import { BUNDLED_MARKDOWN_CSS } from "@/features/cowork-spec/bundled-css"
import { PetSpeciesRow } from "@/features/pet/pet-species-settings"
import { MENU_GROUPS } from "@/menus"
import type { McpStatus } from "@/features/intellij/use-services"

/** 패널 머리말: 18px 굵은 제목 + 13px 설명. Slack 의 채널 헤더 톤. */
function PanelHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="border-b border-border pb-3">
      <h2 className="text-[18px] font-bold tracking-[-0.01em]">{title}</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}

/**
 * 설정 한 줄: 체크박스 + 제목, 아래에 설명.
 *
 * iOS 스타일 스위치가 아니라 18px 라운드 사각 체크박스를 쓴다.
 * (동작·aria 는 그대로 role="switch" 다 — 표현만 바꿨다.)
 */
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
    <div className="border-b border-border py-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className="flex cursor-pointer items-center gap-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
      >
        <span
          className={cn(
            "flex size-[18px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
            checked
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background"
          )}
        >
          {checked && <CheckIcon className="size-3.5" />}
        </span>
        <span className="text-[15px] font-semibold">{title}</span>
      </button>
      <p className="mt-1 pl-[26px] text-[13px] text-muted-foreground">
        {description}
      </p>
    </div>
  )
}

/** 설정 한 줄: 제목·설명 아래에 값 선택 알약들(Slack 의 테두리 알약 버튼 군). */
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
    <div className="border-b border-border py-3">
      <div className="text-[15px] font-semibold">{title}</div>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
      {/* 세그먼트 컨트롤이 아니라 낱개 알약 — 선택된 것만 와인색으로 채운다. */}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const isActive = o.value === value
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(o.value)}
              className={cn(
                "h-7 cursor-pointer rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
                isActive
                  ? "border-transparent bg-ui-selection text-ui-selection-fg"
                  : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
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
 * 테마 프리셋 카드 하나(미니 미리보기 + 이름 + 3색 스와치).
 *
 * 미리보기 색은 고정값이 아니라 **지금 적용 중인 모드**의 CSS 변수에서 읽는다.
 * 다크 스와치를 보여주고 라이트 색을 적용하면 "테마가 안 먹었다"로 보이기 때문이다.
 *
 * 프리셋은 본문 색뿐 아니라 크롬(상단바·레일)과 선택 알약 색도 공급하므로, 미리보기도
 * 실제 셸 구조 그대로 그린다 — 크롬 위에 흰 패널이 얹히고, 사이드바에 선택 알약이,
 * 콘텐츠 우하단에 primary 버튼이 놓인다. 고르기 전에 상단바 색을 짐작할 수 있어야 한다.
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
    chrome: vars["--ui-chrome"],
    chromeFg: vars["--ui-chrome-fg"],
    bg: vars["--background"],
    fg: vars["--foreground"],
    sidebar: vars["--sidebar"],
    primary: vars["--primary"],
    selection: vars["--ui-selection"],
  }

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-2 rounded-[10px] border p-2 text-left shadow-[0_1px_3px_rgba(0,0,0,0.06)] transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        selected
          ? "border-ui-selection bg-accent"
          : "border-border hover:bg-ui-list-hover"
      )}
    >
      {/* 셸을 축소한 미리보기: 크롬(상단바 + 레일) 위에 흰 패널(사이드바 + 콘텐츠) */}
      <div
        className="flex h-[68px] flex-col overflow-hidden rounded-lg border border-border"
        style={{ background: preview.chrome }}
      >
        {/* 상단바: 신호등 + 검색 알약 */}
        <div className="flex h-4 shrink-0 items-center gap-[3px] px-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="size-1 shrink-0 rounded-full opacity-40"
              style={{ background: preview.chromeFg }}
            />
          ))}
          <span
            className="ml-1 h-2 flex-1 rounded-full opacity-20"
            style={{ background: preview.chromeFg }}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 좌측 레일: 활성 타일 + 비활성 타일 */}
          <div className="flex w-4 shrink-0 flex-col items-center gap-1 pt-1">
            <span
              className="size-2.5 rounded-[3px] opacity-30"
              style={{ background: preview.chromeFg }}
            />
            <span
              className="size-2.5 rounded-[3px] opacity-15"
              style={{ background: preview.chromeFg }}
            />
          </div>
          {/* 크롬 위에 얹힌 패널 — 좌상단만 라운드 */}
          <div
            className="flex min-w-0 flex-1 overflow-hidden rounded-tl-lg"
            style={{ background: preview.bg }}
          >
            <div
              className="flex w-2/5 shrink-0 flex-col gap-1 p-1"
              style={{ background: preview.sidebar }}
            >
              {/* 활성 내비 알약 = selection 색 */}
              <span
                className="h-2.5 w-full rounded-[3px]"
                style={{ background: preview.selection }}
              />
              <span
                className="h-1.5 w-3/4 rounded-full opacity-20"
                style={{ background: preview.fg }}
              />
              <span
                className="h-1.5 w-2/3 rounded-full opacity-20"
                style={{ background: preview.fg }}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1 p-1">
              <span
                className="h-1.5 w-1/2 rounded-full opacity-25"
                style={{ background: preview.fg }}
              />
              <span
                className="h-1.5 w-full rounded-full opacity-10"
                style={{ background: preview.fg }}
              />
              {/* primary 버튼 */}
              <span
                className="mt-auto h-3 w-7 rounded-full"
                style={{ background: preview.primary }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-0.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[15px] font-semibold">{preset.label}</span>
          <span className="truncate text-[13px] text-muted-foreground">
            {preset.description}
          </span>
        </div>
        {/* chrome · primary · selection 3색 띠 — 미리보기를 요약한 알약 */}
        <span
          className="flex h-4 w-10 shrink-0 overflow-hidden rounded-full border border-border"
          aria-hidden
        >
          <span className="flex-1" style={{ background: preview.chrome }} />
          <span className="flex-1" style={{ background: preview.primary }} />
          <span className="flex-1" style={{ background: preview.selection }} />
        </span>
        {selected && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-ui-selection text-ui-selection-fg">
            <CheckIcon className="size-2.5" />
          </span>
        )}
      </div>
    </button>
  )
}

/**
 * Slack 사이드바 테마 한 칸. Slack 설정 목록처럼 구(球) 스와치 + 이름을 보여 준다.
 *
 * 스와치는 그라디언트 위에 흰 하이라이트를 얹어 구슬처럼 보이게 한다(Slack 과 동일).
 */
function SlackThemeCard({
  swatch,
  name,
  selected,
  onSelect,
}: {
  /** [시작색, 끝색]. 회색조 하나만 쓰는 "프리셋 색 사용" 도 같은 모양으로 그린다. */
  swatch: [string, string]
  name: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-lg border p-2 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        selected
          ? "border-ui-selection bg-accent"
          : "border-border hover:bg-ui-list-hover"
      )}
    >
      <span
        aria-hidden
        className="size-9 shrink-0 rounded-full"
        style={{
          backgroundImage: `radial-gradient(circle at 34% 26%, rgba(255,255,255,0.55), rgba(255,255,255,0) 58%), linear-gradient(160deg, ${swatch[0]}, ${swatch[1]})`,
          boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.10)",
        }}
      />
      <span className="min-w-0 flex-1 text-[15px] font-semibold">{name}</span>
      {selected && (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-ui-selection text-ui-selection-fg">
          <CheckIcon className="size-2.5" />
        </span>
      )}
    </button>
  )
}

/** Appearance(폰트 + 테마 프리셋 + Slack 사이드바 테마) 설정 화면. */
/** 일반 카테고리 설정 화면 — 지금은 로그인 시 자동 실행 하나. */
function GeneralSettingsPanel() {
  const { settings, setGeneral } = useSettings()
  const { registered, refresh } = useAutoStartState()
  const autoStart = settings.general.autoStart

  // 설정값을 바꾼 뒤 OS 등록까지 끝나고 나서 실제 상태를 다시 읽는다.
  // (App.tsx 의 useAutoStartSync 도 같은 일을 하지만 언제 끝나는지 여기선 알 수 없다.
  //  applyAutoStart 는 여러 번 불러도 같은 결과라 겹쳐 돌아도 문제없다.)
  const toggle = (next: boolean) => {
    setGeneral({ autoStart: next })
    void applyAutoStart(next).then(refresh)
  }

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="일반"
        description="앱을 언제 시작할지 등 앱 전반의 동작을 설정합니다."
      />
      <div className="mt-2">
        <SettingRow
          title="로그인 시 자동 실행"
          description="macOS 에 로그인하면 My Space 를 자동으로 실행합니다. 이때는 창을 띄우지 않고 메뉴바 트레이 아이콘으로만 올라오므로, 작업 감시·알림·펫은 돌면서 화면을 가리지는 않습니다(트레이 메뉴의 'My Space 열기' 로 창을 꺼냅니다)."
          checked={autoStart}
          onChange={toggle}
        />
        {/* 등록은 조용히 실패할 수 있어서 OS 쪽 실제 상태를 보여 준다. */}
        <p className="mt-2 text-[13px] text-muted-foreground">
          {!AUTOSTART_SUPPORTED
            ? "개발 모드에서는 실제 등록을 하지 않습니다(빌드된 앱에서만 적용)."
            : registered === null
              ? "시스템 등록 상태를 확인하지 못했습니다."
              : registered
                ? "시스템 로그인 항목에 등록되어 있습니다."
                : "시스템 로그인 항목에 등록되어 있지 않습니다."}
        </p>
      </div>
    </div>
  )
}

function AppearanceSettingsPanel() {
  const {
    presets,
    presetId,
    setPreset,
    slackThemeId,
    slackThemeGroups,
    setSlackTheme,
    fonts,
    fontId,
    setFont,
  } = useThemePreset()

  return (
    <div className="flex flex-col">
      {/* Font — 본문 전체에 적용되는 글꼴. Theme 위에 온다. */}
      <PanelHeader
        title="Font"
        description="앱 본문 전체에 쓰이는 글꼴입니다. 글꼴은 앱에 내장돼 있어 인터넷 없이도 표시됩니다."
      />
      <div className="mt-3 mb-8 flex flex-wrap gap-1.5">
        {fonts.map((f) => {
          const isActive = f.id === fontId
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={isActive}
              onClick={() => setFont(f.id)}
              style={{ fontFamily: f.stack }}
              className={cn(
                "h-8 cursor-pointer rounded-full border px-3.5 text-[14px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
                isActive
                  ? "border-transparent bg-ui-selection text-ui-selection-fg"
                  : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
              )}
            >
              {f.label}
              {f.id === "lato" && (
                <span className="ml-1 opacity-70">(기본)</span>
              )}
            </button>
          )
        })}
      </div>

      <PanelHeader
        title="Theme"
        description="앱 전체의 색감을 유명 앱 스타일로 바꿉니다. 상단바·좌측 레일·활성 메뉴 알약 색도 함께 바뀝니다. 라이트/다크 모드는 레일 하단의 토글로 따로 전환할 수 있습니다."
      />
      {/* PRESETS 순서를 그대로 따르므로 slack 프리셋이 맨 앞에 온다. */}
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

      <div className="mt-8">
        <PanelHeader
          title="Slack Theme"
          description="Slack 의 사이드바 테마 목록입니다. 고르면 상단바·좌측 레일·상태바 색만 그 색으로 바뀌고, 본문·카드·버튼 색은 위에서 고른 테마를 그대로 씁니다."
        />
        <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <SlackThemeCard
            swatch={["#F6F6F6", "#D9D9DA"]}
            name="사용 안 함"
            selected={slackThemeId === null}
            onSelect={() => setSlackTheme(null)}
          />
        </div>
        {slackThemeGroups.map((group) => (
          <div key={group.label} className="mt-5">
            <h3 className="text-[15px] font-semibold">{group.label}</h3>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.themes.map((t) => (
                <SlackThemeCard
                  key={t.id}
                  swatch={[t.from, t.to]}
                  name={t.name}
                  selected={t.id === slackThemeId}
                  onSelect={() => setSlackTheme(t.id)}
                />
              ))}
            </div>
          </div>
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
      <PanelHeader
        title="Slack"
        description="Slack 연결을 관리하고, 안 읽은 메시지 새로고침 주기를 설정합니다."
      />

      {/* 연결 관리(연결 · 재연결 · 연결 해제) */}
      <div className="mt-4">
        <SlackConnectionPanel />
      </div>

      {/* 폴링 주기 */}
      <div className="mt-4 border-t border-border">
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
      <PanelHeader
        title="Google Calendar"
        description="Calendar 메뉴에서 오늘 일정을 보려면 Google 계정을 연결해야 합니다. 연결을 해제하면 저장된 토큰과 클라이언트 정보가 삭제됩니다."
      />

      {/* 연결 관리(연결 · 연결 해제) */}
      <div className="mt-4">
        <GcalConnectionPanel />
      </div>
    </div>
  )
}

/** Google Drive 카테고리 설정 화면 — Google 계정 연결/해제. */
function GoogleDriveSettingsPanel() {
  return (
    <div className="flex flex-col">
      <PanelHeader
        title="Google Drive"
        description="Drive 메뉴에서 최근에 열어본 파일을 보려면 Google 계정을 연결해야 합니다. 연결을 해제하면 저장된 토큰과 클라이언트 정보가 삭제됩니다."
      />

      {/* 연결 관리(연결 · 연결 해제) */}
      <div className="mt-4">
        <GdriveConnectionPanel />
      </div>
    </div>
  )
}

/** Jira 카테고리 설정 화면 — 사이트 주소·계정 이메일·API 토큰 연결/해제. */
function JiraSettingsPanel() {
  return (
    <div className="flex flex-col">
      <PanelHeader
        title="Jira"
        description="Jira 메뉴에서 내가 담당하는 이슈를 보려면 사이트 주소·계정 이메일·API 토큰이 필요합니다. 연결을 해제하면 저장된 토큰이 삭제됩니다."
      />

      {/* 연결 관리(연결 · 재연결 · 연결 해제) */}
      <div className="mt-4">
        <JiraConnectionPanel />
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
      <PanelHeader
        title="Claude Code"
        description="Claude Code(herdr) 작업을 감시하고, 상태가 바뀔 때 받을 인앱 알림(토스트)을 설정합니다."
      />
      <div className="mt-2">
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

/**
 * 펫이 어떤 상황에서 어떤 동작을 하는지 한 번에 보여 주는 표.
 * 동작 정의는 `use-pet-mood.ts` 의 PetMood 가 원본이고, 여기 문구는 그것과 맞춰 둔다.
 */
function PetBehaviorTable() {
  const rows: { name: string; when: string; how: string }[] = [
    {
      name: "동작 없음",
      when: "실행 중인 작업도, 확인할 것도 없음",
      how: "쉬고 있습니다 (머리 위 Zzz)",
    },
    {
      name: "동작 중",
      when: "Claude 작업 1건 실행 중",
      how: "일하는 동작으로 움직입니다 (…)",
    },
    {
      name: "바쁨",
      when: "Claude 작업 2건 이상 동시 실행 중",
      how: "더 분주한 동작으로 움직이고 건수를 표시합니다",
    },
    {
      name: "대기 중",
      when: "작업 완료·AskUserQuestion·리마인더 — 확인이 필요함",
      how: "대기 동작으로 바뀌고 확인 표시가 붙습니다 (!)",
    },
  ]

  return (
    <div className="mt-4 overflow-hidden rounded-[10px] border border-border">
      {rows.map((r, i) => (
        <div
          key={r.name}
          className={cn(
            "flex flex-col gap-0.5 px-3 py-2",
            i > 0 && "border-t border-border"
          )}
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-bold">{r.name}</span>
            <span className="text-[13px] text-muted-foreground">{r.when}</span>
          </div>
          <span className="text-[13px] text-muted-foreground">{r.how}</span>
        </div>
      ))}
    </div>
  )
}

/** 알림 표시 시간 프리셋(초). 0 은 "항상 표시"로 따로 다룬다. */
const NOTICE_PRESETS = [7, 12, 30]

/**
 * Claude Code 알림을 얼마나 띄워 둘지 고르는 행.
 *
 * 값은 초 하나로만 저장한다(`noticeSeconds`, 0 = 항상 표시) — "프리셋/직접입력" 모드를
 * 따로 저장하면 둘이 어긋날 수 있으므로, 프리셋에 없는 값이면 직접 입력으로 본다.
 */
function PetNoticeDurationRow() {
  const { settings, setPet } = useSettings()
  const seconds = settings.pet.noticeSeconds ?? 12
  const isAlways = seconds === 0
  const isPreset = NOTICE_PRESETS.includes(seconds)
  const isCustom = !isAlways && !isPreset

  const pill = (active: boolean) =>
    cn(
      "h-7 cursor-pointer rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
      active
        ? "border-transparent bg-ui-selection text-ui-selection-fg"
        : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
    )

  return (
    <div className="border-b border-border py-3">
      <div className="text-[15px] font-semibold">알림 표시 시간</div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        작업 완료 알림을 말풍선에 띄워 둘 시간입니다. 상시 표시를 꺼 뒀을 때
        펫이 떠 있는 시간도 같이 따라갑니다. 입력 대기·리마인더는 이 설정과
        무관하게 답하거나 확인할 때까지 남습니다.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {NOTICE_PRESETS.map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={seconds === v}
            onClick={() => setPet({ noticeSeconds: v })}
            className={pill(seconds === v)}
          >
            {v}초
          </button>
        ))}
        <button
          type="button"
          aria-pressed={isCustom}
          // 직접 입력으로 넘어갈 때는 프리셋과 겹치지 않는 값에서 시작한다.
          onClick={() => setPet({ noticeSeconds: isCustom ? seconds : 20 })}
          className={pill(isCustom)}
        >
          입력
        </button>
        <button
          type="button"
          aria-pressed={isAlways}
          onClick={() => setPet({ noticeSeconds: 0 })}
          className={pill(isAlways)}
        >
          항상 표시
        </button>
        {isCustom && (
          <span className="flex items-center gap-1.5">
            <Input
              type="number"
              min={1}
              max={3600}
              value={seconds}
              onChange={(e) => {
                const n = Number(e.target.value)
                // 1초 미만은 "항상 표시"(0)와 뜻이 겹치므로 최소 1초로 묶는다.
                if (Number.isFinite(n)) {
                  setPet({ noticeSeconds: Math.min(3600, Math.max(1, n)) })
                }
              }}
              className="h-7 w-20 text-[13px]"
            />
            <span className="text-[13px] text-muted-foreground">초</span>
          </span>
        )}
      </div>
      {isAlways && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          알림이 저절로 사라지지 않습니다 — 말풍선을 눌러 해당 작업으로 이동하면
          치워집니다.
        </p>
      )}
    </div>
  )
}

/**
 * 캐릭터를 눌렀을 때 위로 펼쳐질 빠른 이동 아이콘들을 고르는 행(여러 개 선택).
 *
 * 목록·아이콘은 `menus.tsx` 를 그대로 쓰므로 메뉴를 추가하면 여기에도 자동으로 나타난다.
 * 다이얼에 놓이는 순서는 사이드바 순서를 따른다 — 고른 순서대로 두면 설정을 만질 때마다
 * 아이콘 자리가 바뀌어 손이 기억한 위치가 깨진다.
 */
function PetDialMenusRow() {
  const { settings, setPet } = useSettings()
  const picked = settings.pet.dialMenus ?? []

  const toggle = (id: string) => {
    setPet({
      dialMenus: picked.includes(id)
        ? picked.filter((x) => x !== id)
        : [...picked, id],
    })
  }

  return (
    <div className="border-b border-border py-3">
      <div className="text-[15px] font-semibold">빠른 이동 아이콘</div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        캐릭터를 누르면 이 아이콘들이 위로 펼쳐집니다. 안 읽은 건수가 있으면
        아이콘에 뱃지가 붙고, 누르면 My Space 창이 앞으로 나오며 그 메뉴가
        열립니다.
      </p>
      {MENU_GROUPS.map((g) => (
        <div key={g.id} className="mt-2">
          {g.label && (
            <div className="text-[13px] font-semibold text-muted-foreground">
              {g.label}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-1.5">
            {g.items.map((m) => {
              const isActive = picked.includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => toggle(m.id)}
                  className={cn(
                    "flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
                    isActive
                      ? "border-transparent bg-ui-selection text-ui-selection-fg"
                      : "border-border text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
                  )}
                >
                  <m.icon className="size-3.5 shrink-0" />
                  {m.title}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      {picked.length === 0 && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          하나도 고르지 않으면 캐릭터를 눌러도 아무것도 열리지 않습니다.
        </p>
      )}
    </div>
  )
}

/** 데스크톱 펫 카테고리 설정 화면. */
function PetSettingsPanel() {
  const { settings, setPet } = useSettings()
  const s = settings.pet

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="데스크톱 펫"
        description="화면 위에 캐릭터를 상시 띄워 두고, Claude Code 작업 상태와 알림을 동작·말풍선으로 알립니다."
      />
      <PetBehaviorTable />
      <div className="mt-2">
        <SettingRow
          title="상시 표시"
          description="모든 데스크톱에서 항상 위에 캐릭터를 띄웁니다. 끌어서 옮긴 자리는 기억합니다. 꺼도 알림(리마인더·Claude Code)이 생기면 그동안만 잠깐 나타납니다 — 펫이 앱의 유일한 알림 창구입니다."
          checked={s.enabled}
          onChange={(v) => setPet({ enabled: v })}
        />
        <SettingRow
          title="말풍선"
          description="입력 대기·작업 완료·알림을 캐릭터 위에 쌓아 보여 줍니다. 각 줄에 출처 아이콘과 어떤 작업인지가 함께 나오고, 누르면 그 작업으로 이동합니다. 끄면 표정과 움직임만 바뀝니다."
          checked={s.bubble}
          onChange={(v) => setPet({ bubble: v })}
        />
        <SettingRow
          title="클릭 통과"
          description="캐릭터가 뒤 창의 클릭을 막지 않습니다. 대신 캐릭터를 클릭·드래그할 수 없어 장식 전용이 됩니다."
          checked={s.clickThrough}
          onChange={(v) => setPet({ clickThrough: v })}
        />
        <SettingChoiceRow
          title="크기"
          description="캐릭터 크기입니다. 창은 그림에 딱 맞게 줄어들어 남는 여백이 클릭을 가로채지 않습니다."
          value={s.scale}
          options={[
            { label: "작게", value: 0.8 },
            { label: "보통", value: 1 },
            { label: "크게", value: 1.3 },
          ]}
          onChange={(v) => setPet({ scale: v })}
        />
        <PetNoticeDurationRow />
        <PetDialMenusRow />
        <PetSpeciesRow />
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">
        캐릭터를 누르면 위에서 고른 화면이 열리고, 끌어서 옮길 수 있습니다.{" "}
        <span className="font-semibold">머리 위 표시</span>를 누르면 진행 중인
        작업(어떤 프롬프트였는지)과 안 읽은 Slack·Gmail 건수를 펼쳐 볼 수 있고,
        각 줄을 누르면 그 자리로 이동합니다. 숨기려면 위의{" "}
        <span className="font-semibold">상시 표시</span> 를 끄세요(메뉴바 트레이
        아이콘의 <span className="font-semibold">펫 표시/숨기기</span> 로도
        됩니다). 동작 변화는 Claude Code 설정의{" "}
        <span className="font-semibold">작업 감시</span> 가 켜져 있어야
        동작합니다.
      </p>
    </div>
  )
}

/** 설명 한 줄: 제목 + 본문. 토글이 없는 안내용 행. */
function InfoRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-border py-3">
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="mt-1 text-[13px] text-muted-foreground">{children}</div>
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
      <PanelHeader
        title="IntelliJ"
        description="IntelliJ Services 메뉴는 IDE 내장 MCP 서버를 통해 실행 설정을 읽고 실행합니다. 연결되어 있지 않으면 목록이 비어 있고 시작·종료도 할 수 없습니다."
      />

      {/* 현재 연결 상태 */}
      <div
        className={cn(
          "mt-4 rounded-[10px] border px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
          connected
            ? "border-ui-success bg-ui-success/15"
            : "border-ui-warning bg-ui-warning/15"
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              connected ? "bg-ui-success" : "bg-ui-warning"
            )}
          />
          <span className="text-[15px] font-bold">
            {status === null ? "확인 중…" : connected ? "연결됨" : "연결 안 됨"}
          </span>
          {connected && status?.url && (
            <span className="truncate font-mono text-[13px] text-muted-foreground">
              {status.url}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto shrink-0 rounded-full"
            onClick={() => void check()}
            disabled={checking}
          >
            <RotateCwIcon
              className={cn("size-3.5", checking && "animate-spin")}
            />
            다시 확인
          </Button>
        </div>
        {!connected && status?.error && (
          <div className="mt-1.5 font-mono text-[13px] break-all text-muted-foreground">
            {status.error}
          </div>
        )}
      </div>

      {/* 연결이 안 됐을 때만 설정 절차를 펼쳐 보여 준다. */}
      {status !== null && !connected && (
        <div className="mt-3 rounded-[10px] border border-border bg-card px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="text-[15px] font-semibold">설정 방법</div>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-[13px] text-muted-foreground">
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

      <div className="mt-4 border-t border-border">
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

/**
 * Cowork spec 문서 설정 화면 — 스펙 문서를 찾을 cowork 홈 경로와, 마크다운 뷰어에
 * 입힐 스타일(css)을 관리한다.
 *
 * 스타일은 앱에 번들된 기본 테마(`cowork-spec/bundled-css.ts`)로 시작한다 — Typora 가
 * 깔려 있지 않아도 첫 실행부터 제대로 보인다. 여기서 하는 일은 그 위에 사용자의 Typora
 * 테마 css 를 덮어쓰는 것뿐이고, 뷰어는 그 원문을 섀도 DOM 에 주입한다.
 */
function CoworkSettingsPanel() {
  const { settings, setCowork } = useSettings()
  const s = settings.cowork
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<
    { ok: true; chars: number } | { ok: false; error: string } | null
  >(null)

  const importCss = useCallback(async () => {
    if (!isTauri()) return
    setImporting(true)
    setResult(null)
    try {
      const css = await trackedInvoke<string>("cowork_read_css", {
        path: s.cssPath,
      })
      setCowork({ markdownCss: css })
      setResult({ ok: true, chars: css.length })
    } catch (e) {
      setResult({ ok: false, error: String(e) })
    } finally {
      setImporting(false)
    }
  }, [s.cssPath, setCowork])

  const hasCss = s.markdownCss.trim().length > 0

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="Cowork Spec 문서"
        description="cowork 홈 아래 .cowork/specs 의 스펙 문서(md)를 마크다운으로 봅니다. 기본 스타일이 앱에 내장되어 있어 그대로 Typora 와 같은 가독성으로 표시됩니다."
      />

      <div className="mt-4 flex flex-col gap-1.5 border-b border-border pb-4">
        <label className="text-[15px] font-semibold" htmlFor="cowork-home">
          cowork 홈 디렉터리
        </label>
        <p className="text-[13px] text-muted-foreground">
          이 경로 아래 <span className="font-mono">.cowork/specs</span> 에서
          스펙 문서를 찾습니다.
        </p>
        <Input
          id="cowork-home"
          value={s.home}
          onChange={(e) => setCowork({ home: e.target.value })}
          spellCheck={false}
          className="mt-1 font-mono text-[13px]"
        />
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="text-[15px] font-semibold">
          마크다운 스타일 (Typora)
        </div>
        <p className="text-[13px] text-muted-foreground">
          기본 스타일은 앱에 내장되어 있어 따로 설정하지 않아도 됩니다. 자기
          Typora 테마로 바꾸고 싶을 때만 아래 경로의 css 를 “스타일 가져오기” 로
          읽어 오면, 그 원문이 저장되어 내장 스타일 대신 적용됩니다.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Input
            value={s.cssPath}
            onChange={(e) => setCowork({ cssPath: e.target.value })}
            spellCheck={false}
            className="font-mono text-[13px]"
          />
          <Button
            variant="outline"
            className="shrink-0 rounded-full"
            onClick={() => void importCss()}
            disabled={importing}
          >
            <DownloadIcon
              className={cn("size-3.5", importing && "animate-pulse")}
            />
            스타일 가져오기
          </Button>
        </div>

        {/* 지금 적용 중인 스타일(내장 / 가져온 것) + 방금 가져온 결과 */}
        <div className="mt-2 flex items-center gap-2 text-[13px]">
          <span className="size-2 shrink-0 rounded-full bg-ui-success" />
          <span className="text-muted-foreground">
            {hasCss
              ? `가져온 스타일 적용 중 (${s.markdownCss.length.toLocaleString()}자)`
              : `내장 기본 스타일 적용 중 (${BUNDLED_MARKDOWN_CSS.length.toLocaleString()}자)`}
          </span>
          {hasCss && (
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 rounded-full text-[13px] text-ui-error hover:text-ui-error"
              onClick={() => {
                setCowork({ markdownCss: "" })
                setResult(null)
              }}
            >
              내장 스타일로 되돌리기
            </Button>
          )}
        </div>

        {result?.ok === false && (
          <div className="mt-1 font-mono text-[13px] break-all text-ui-error">
            가져오기 실패: {result.error}
          </div>
        )}
        {result?.ok === true && (
          <div className="mt-1 text-[13px] text-ui-success">
            {result.chars.toLocaleString()}자를 가져왔습니다.
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 계정 설정 화면 — 로그인한 사내 계정 정보와 로그아웃 버튼.
 *
 * 로그인 상태는 AuthProvider(localStorage)가 관리한다. 로그아웃하면 저장된 자동 로그인
 * 정보가 지워지고 셸이 로그인 폼으로 돌아간다.
 */
function AccountSettingsPanel() {
  const { user, logout } = useAuth()

  const rows: { label: string; value: string }[] = user
    ? [
        { label: "이름", value: user.displayName },
        { label: "아이디", value: user.username },
        { label: "이메일", value: user.email || "—" },
        { label: "DN", value: user.dn },
      ]
    : []

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="계정"
        description="현재 로그인한 사내 계정 정보입니다. 로그아웃하면 자동 로그인이 해제되어 다음 실행에서 다시 로그인해야 합니다."
      />

      {user ? (
        <>
          {/* 사용자 요약 카드 */}
          <div className="mt-4 flex items-center gap-3 rounded-[10px] border border-border bg-card px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-ui-chrome text-ui-chrome-fg">
              <UserIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-bold">
                {user.displayName}
              </div>
              <div className="truncate text-[13px] text-muted-foreground">
                {user.email || user.username}
              </div>
            </div>
          </div>

          {/* 상세 정보 */}
          <div className="mt-4">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex gap-3 border-b border-border py-2.5"
              >
                <span className="w-20 shrink-0 text-[13px] text-muted-foreground">
                  {r.label}
                </span>
                <span className="min-w-0 flex-1 font-mono text-[13px] break-all">
                  {r.value}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-5">
            <Button
              variant="outline"
              className="rounded-full text-ui-error hover:text-ui-error"
              onClick={() => logout()}
            >
              <LogOutIcon className="size-3.5" />
              로그아웃
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-4 text-[13px] text-muted-foreground">
          로그인되어 있지 않습니다.
        </p>
      )}
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
    id: "account",
    label: "계정",
    icon: UserIcon,
    panel: <AccountSettingsPanel />,
  },
  {
    id: "general",
    label: "일반",
    icon: SlidersHorizontalIcon,
    panel: <GeneralSettingsPanel />,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: PaletteIcon,
    panel: <AppearanceSettingsPanel />,
  },
  {
    id: "pet",
    label: "데스크톱 펫",
    icon: CatIcon,
    panel: <PetSettingsPanel />,
  },
  {
    id: "gmail",
    label: "Gmail",
    icon: MailIcon,
    panel: <GmailSettingsPanel />,
  },
  {
    id: "slack",
    label: "Slack",
    icon: MessageSquareIcon,
    panel: <SlackSettingsPanel />,
  },
  {
    id: "jira",
    label: "Jira",
    icon: SquareKanbanIcon,
    panel: <JiraSettingsPanel />,
  },
  {
    id: "google-calendar",
    label: "Google Calendar",
    icon: CalendarIcon,
    panel: <GoogleCalendarSettingsPanel />,
  },
  {
    id: "google-drive",
    label: "Google Drive",
    icon: HardDriveIcon,
    panel: <GoogleDriveSettingsPanel />,
  },
  {
    id: "flex",
    label: "Flex 휴가",
    icon: PalmtreeIcon,
    panel: <FlexSettingsPanel />,
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
  {
    id: "cowork-spec",
    label: "Cowork Spec 문서",
    icon: FileTextIcon,
    panel: <CoworkSettingsPanel />,
  },
]

/** 카테고리별 설정 화면(왼쪽 카테고리 목록 → 오른쪽 상세). */
export function SettingsView() {
  const [activeId, setActiveId] = useState(CATEGORIES[0].id)
  const active = CATEGORIES.find((c) => c.id === activeId) ?? CATEGORIES[0]

  return (
    <div className="flex min-h-0 flex-1 gap-5">
      {/* 좌측 카테고리 목차 — 사이드바와 같은 28px 와인 알약 행 */}
      <nav className="w-48 shrink-0 border-r border-border pr-3">
        <ul className="flex flex-col gap-px">
          {CATEGORIES.map((c) => {
            const Icon = c.icon
            const isActive = c.id === active.id
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveId(c.id)}
                  className={cn(
                    "flex h-(--ui-row-h) w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-[15px] transition-colors",
                    isActive
                      ? "bg-ui-list-active font-bold text-ui-list-active-fg"
                      : "hover:bg-ui-list-hover"
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{c.label}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto pr-1 pb-2">
        {active.panel}
      </div>
    </div>
  )
}
