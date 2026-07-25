import { LogOutIcon } from "lucide-react"
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

import { friendlyError } from "./gcal-error"
import { useGcalConnection } from "./use-gcal"

/** OAuth 클라이언트 정보 입력·연결 폼. */
function SetupView({
  onConnect,
  error,
}: {
  onConnect: (clientId: string, clientSecret: string) => Promise<void>
  error: string | null
}) {
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [busy, setBusy] = useState(false)

  async function handleConnect() {
    if (!clientId.trim() || !clientSecret.trim() || busy) return
    setBusy(true)
    try {
      await onConnect(clientId.trim(), clientSecret.trim())
    } catch {
      /* 오류는 상위 상태로 표시된다 */
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google 캘린더 연결</CardTitle>
        <CardDescription>
          오늘 일정을 보려면 Google Cloud 데스크톱 앱 OAuth 클라이언트가
          필요합니다.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
          <li>
            <span className="text-foreground">console.cloud.google.com</span>{" "}
            에서 프로젝트 생성(또는 선택)
          </li>
          <li>
            <b className="text-foreground">APIs &amp; Services → 라이브러리</b>{" "}
            에서 <b className="text-foreground">Google Calendar API</b> 사용
            설정
          </li>
          <li>
            <b className="text-foreground">OAuth 동의 화면</b> 구성 →
            External(회사 계정이면 Internal) → 테스트 모드면{" "}
            <b className="text-foreground">테스트 사용자에 본인 계정 추가</b>
          </li>
          <li>
            <b className="text-foreground">
              사용자 인증 정보 → OAuth 클라이언트 ID 만들기
            </b>{" "}
            → 유형: <b className="text-foreground">데스크톱 앱</b>
          </li>
          <li>생성된 클라이언트 ID / 보안 비밀을 아래에 입력하고 "연결"</li>
        </ol>

        <div className="flex flex-col gap-2">
          <Label htmlFor="gcal-id">클라이언트 ID</Label>
          <Input
            id="gcal-id"
            placeholder="....apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="ui-selectable"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="gcal-secret">클라이언트 보안 비밀</Label>
          <Input
            id="gcal-secret"
            type="password"
            placeholder="GOCSPX-..."
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className="ui-selectable"
          />
        </div>

        <Button
          className="self-start"
          onClick={handleConnect}
          disabled={busy || !clientId.trim() || !clientSecret.trim()}
        >
          {busy ? "브라우저에서 로그인하세요…" : "연결"}
        </Button>
        {busy && (
          <p className="text-xs text-muted-foreground">
            브라우저가 열립니다. 구글 로그인·동의를 완료하면 자동으로
            연결됩니다.
          </p>
        )}

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
 * 설정 화면에 임베드하는 Google 캘린더 연결 관리 패널.
 * 연결 상태 표시 + 연결(OAuth 클라이언트 입력) + 연결 해제를 한곳에서 처리한다.
 * Calendar 화면은 연결 상태를 각자 조회하므로, 화면을 다시 열면 반영된다.
 */
export function GcalConnectionPanel() {
  const { status, error, connect, disconnect } = useGcalConnection()

  if (status === null) {
    return (
      <div className="text-sm text-muted-foreground">연결 상태 확인 중…</div>
    )
  }

  if (!status.connected) {
    return <SetupView onConnect={connect} error={error} />
  }

  // 연결됨 — 상태 배지 + 연결 해제.
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
            {status.email ?? "Google 캘린더"}
          </span>
          <div className="ml-auto flex gap-2">
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
