import { LogOutIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { friendlyError } from "./jira-errors"
import { useJiraConnection } from "./use-jira"

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

/** 패널 헤더 — 회색 배경 없이 굵은 15px 제목 + 아래 구분선만. */
const PANEL_HEADER =
  "flex shrink-0 items-center border-b border-border px-4 py-3 text-[15px] font-semibold"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

const TOKEN_PAGE = "https://id.atlassian.com/manage-profile/security/api-tokens"

/**
 * 사이트 주소 기본값 — 사내 Jira. 매번 타이핑하지 않도록 미리 채워 둔다.
 * (다른 사이트를 쓰면 지우고 새로 넣으면 되고, 끝 슬래시·경로는 Rust 에서 정규화한다.)
 */
const DEFAULT_SITE_URL = "https://enomix.atlassian.net"

/** 사이트 주소·이메일·API 토큰 입력 폼(최초 연결 / 재연결 공용). */
function SetupView({
  initialUrl,
  initialUser,
  onConnect,
  error,
  onBack,
}: {
  initialUrl: string
  initialUser: string
  onConnect: (url: string, user: string, token: string) => Promise<void>
  error: string | null
  /** 이미 연결된 상태에서 다시 설정하는 경우, 취소하고 돌아가는 콜백. */
  onBack?: () => void
}) {
  const [url, setUrl] = useState(initialUrl)
  const [user, setUser] = useState(initialUser)
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)

  const ready = url.trim() && user.trim() && token.trim()

  async function handleConnect() {
    if (!ready || busy) return
    setBusy(true)
    try {
      await onConnect(url.trim(), user.trim(), token.trim())
    } catch {
      /* 오류는 상위 상태로 표시된다 */
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={PANEL}>
      <div className={PANEL_HEADER}>{onBack ? "Jira 재연결" : "Jira 연결"}</div>
      <div className="flex flex-col gap-3 p-4 text-[15px]">
        <p className="text-[13px] text-muted-foreground">
          내가 담당하는 이슈를 보려면 Jira 사이트 주소와 계정 이메일, API 토큰이
          필요합니다. (비밀번호가 아니라 API 토큰입니다.)
        </p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
          <li>
            <span className="text-foreground">{TOKEN_PAGE}</span> 접속 →{" "}
            <b className="text-foreground">API 토큰 만들기</b>
          </li>
          <li>
            이름(예: <span className="text-foreground">My Space</span>)을 넣고
            만든 뒤, 생성된 토큰을 복사 (창을 닫으면 다시 볼 수 없습니다)
          </li>
          <li>아래에 사이트 주소·이메일·토큰을 넣고 연결</li>
        </ol>

        <div className="flex flex-col gap-2">
          <Label htmlFor="jira-url">사이트 주소</Label>
          <Input
            id="jira-url"
            placeholder={DEFAULT_SITE_URL}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect()
            }}
            className="ui-selectable"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="jira-user">계정 이메일</Label>
          <Input
            id="jira-user"
            placeholder="아이디@spectra.co.kr"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect()
            }}
            className="ui-selectable"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="jira-token">API 토큰</Label>
          <div className="flex gap-2">
            <Input
              id="jira-token"
              type="password"
              placeholder="ATATT..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConnect()
              }}
              className="ui-selectable"
            />
            <Button onClick={handleConnect} disabled={busy || !ready}>
              {busy ? "확인 중…" : "연결"}
            </Button>
            {onBack && (
              <Button variant="ghost" onClick={onBack} disabled={busy}>
                돌아가기
              </Button>
            )}
          </div>
        </div>

        {error && (
          <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
            {friendlyError(error)}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * 설정 화면에 임베드하는 Jira 연결 관리 패널.
 * 연결 상태 표시 + 연결(설정 입력) + 재연결 + 연결 해제를 한곳에서 처리한다.
 */
export function JiraConnectionPanel() {
  const { status, error, connect, disconnect } = useJiraConnection()
  const [reconnect, setReconnect] = useState(false)

  if (status === null) {
    return (
      <div className="text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  // 미연결이거나 재연결 요청 중이면 입력 폼을 보여 준다.
  if (!status.connected || reconnect) {
    return (
      <SetupView
        // 토큰만 만료된 경우가 흔하므로 주소·이메일은 채워 둔다.
        // 처음 연결이면 사내 Jira 주소를 기본값으로 넣어 준다.
        initialUrl={status.url ?? DEFAULT_SITE_URL}
        initialUser={status.user ?? ""}
        onConnect={async (url, user, token) => {
          await connect(url, user, token)
          setReconnect(false)
        }}
        error={error}
        onBack={reconnect ? () => setReconnect(false) : undefined}
      />
    )
  }

  // 연결됨 — 상태 배지 + 재연결/연결 해제.
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[10px] border border-ui-success/40 bg-ui-success/15 px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2 shrink-0 rounded-full bg-ui-success" />
          <span className="text-[15px] font-bold">연결됨</span>
          <span className="text-[13px] text-muted-foreground">
            {status.display_name ?? status.user ?? "Jira"}
            {status.url ? ` · ${status.url.replace(/^https?:\/\//, "")}` : ""}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              className={PILL}
              onClick={() => setReconnect(true)}
              title="다른 사이트·계정이나 새 토큰으로 다시 연결"
            >
              재연결
            </Button>
            <Button
              variant="ghost"
              className={PILL}
              onClick={() => void disconnect()}
            >
              <LogOutIcon className="size-3.5" />
              연결 해제
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
          {friendlyError(error)}
        </p>
      )}
    </div>
  )
}
