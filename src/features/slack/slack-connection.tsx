import { CheckIcon, CopyIcon, LogOutIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

import { friendlyError } from "./slack-errors"
import { useSlack } from "./use-slack"

const SCOPES =
  "channels:read,groups:read,im:read,mpim:read,channels:history,groups:history,im:history,mpim:history,users:read,usergroups:read"

/** 토큰 입력·연결 폼(최초 연결 / 권한 갱신 재연결 공용). */
function SetupView({
  onConnect,
  error,
  onBack,
}: {
  onConnect: (token: string) => Promise<void>
  error: string | null
  /** 이미 연결된 상태에서 권한 갱신차 다시 연결하는 경우, 취소하고 돌아가는 콜백. */
  onBack?: () => void
}) {
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  async function handleConnect() {
    if (!token.trim() || busy) return
    setBusy(true)
    try {
      await onConnect(token.trim())
    } catch {
      /* 오류는 상위 상태로 표시된다 */
    } finally {
      setBusy(false)
    }
  }

  function copyScopes() {
    void navigator.clipboard.writeText(SCOPES)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {onBack ? "Slack 권한 갱신 / 재연결" : "Slack 연결"}
        </CardTitle>
        <CardDescription>
          {onBack
            ? "그룹 멘션 이름(@제품개발본부 등)을 표시하려면 아래 스코프(특히 usergroups:read)를 추가해 Reinstall 후 새 토큰으로 다시 연결하세요."
            : "안 읽은 메시지를 보려면 Slack 사용자 토큰(xoxp-)이 필요합니다."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
          <li>
            <span className="text-foreground">api.slack.com/apps</span> →{" "}
            <b className="text-foreground">Create New App</b> → From scratch
            (워크스페이스 선택)
          </li>
          <li>
            왼쪽 <b className="text-foreground">OAuth &amp; Permissions</b> →{" "}
            <b className="text-foreground">User Token Scopes</b> 에 아래 스코프
            모두 추가:
            <div className="mt-2 flex items-start gap-2">
              <code className="flex-1 rounded-md bg-muted px-2 py-1.5 text-xs break-all">
                {SCOPES.replaceAll(",", ", ")}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={copyScopes}
                aria-label="스코프 복사"
              >
                {copied ? (
                  <CheckIcon className="text-green-600" />
                ) : (
                  <CopyIcon />
                )}
              </Button>
            </div>
          </li>
          <li>
            같은 화면 상단{" "}
            <b className="text-foreground">Install to Workspace</b> → 승인 (회사
            워크스페이스는 관리자 승인이 필요할 수 있음)
          </li>
          <li>
            생성된 <b className="text-foreground">User OAuth Token</b>{" "}
            (xoxp-…)을 복사해 아래에 붙여넣기
          </li>
        </ol>

        <div className="flex flex-col gap-2">
          <Label htmlFor="slack-token">User OAuth Token</Label>
          <div className="flex gap-2">
            <Input
              id="slack-token"
              type="password"
              placeholder="xoxp-..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleConnect()
              }}
              className="ui-selectable"
            />
            <Button onClick={handleConnect} disabled={busy || !token.trim()}>
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
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {friendlyError(error)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 설정 화면에 임베드하는 Slack 연결 관리 패널.
 * 연결 상태 표시 + 연결(토큰 입력) + 재연결(권한 갱신) + 연결 해제를 한곳에서 처리한다.
 * 상태는 SlackProvider 전역이라 Slack 화면과 즉시 공유된다.
 */
export function SlackConnectionPanel() {
  const { status, error, connect, disconnect } = useSlack()
  const [reconnect, setReconnect] = useState(false)

  if (status === null) {
    return (
      <div className="text-sm text-muted-foreground">연결 상태 확인 중…</div>
    )
  }

  // 미연결이거나 재연결 요청 중이면 토큰 입력 폼을 보여 준다.
  if (!status.connected || reconnect) {
    return (
      <SetupView
        onConnect={async (token) => {
          await connect(token)
          setReconnect(false)
        }}
        error={error}
        onBack={reconnect ? () => setReconnect(false) : undefined}
      />
    )
  }

  // 연결됨 — 상태 배지 + 재연결/연결 해제.
  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "rounded-md border px-3 py-2.5",
          "border-emerald-200 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30"
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2 shrink-0 rounded-full bg-emerald-500" />
          <span className="text-sm font-medium">연결됨</span>
          <span className="text-sm text-muted-foreground">
            {status.team ?? "Slack"}
            {status.user ? ` · ${status.user}` : ""}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReconnect(true)}
              title="권한(스코프)을 추가하거나 새 토큰으로 다시 연결"
            >
              재연결
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
              <LogOutIcon />
              연결 해제
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {friendlyError(error)}
        </p>
      )}
    </div>
  )
}
