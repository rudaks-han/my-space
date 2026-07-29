import { LogOutIcon } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { friendlyError } from "./gdrive-error"
import { useGdriveConnection } from "./use-gdrive"

/** Slack 흰 패널 — 10px 라운드 + 아주 옅은 그림자. */
const PANEL =
  "flex flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

/** 패널 헤더 — 회색 배경 없이 굵은 15px 제목 + 아래 구분선만. */
const PANEL_HEADER =
  "flex shrink-0 items-center border-b border-border px-4 py-3 text-[15px] font-semibold"

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

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
    <div className={PANEL}>
      <div className={PANEL_HEADER}>Google 드라이브 연결</div>
      <div className="flex flex-col gap-3 p-4 text-[15px]">
        <p className="text-[13px] text-muted-foreground">
          최근에 열어본 파일을 보려면 Google Cloud 데스크톱 앱 OAuth
          클라이언트가 필요합니다.
        </p>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
          <li>
            <span className="text-foreground">console.cloud.google.com</span>{" "}
            에서 프로젝트 생성(또는 선택)
          </li>
          <li>
            <b className="text-foreground">APIs &amp; Services → 라이브러리</b>{" "}
            에서 <b className="text-foreground">Google Drive API</b> 사용 설정
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
          <Label htmlFor="gdrive-id">클라이언트 ID</Label>
          <Input
            id="gdrive-id"
            placeholder="....apps.googleusercontent.com"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="ui-selectable"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="gdrive-secret">클라이언트 보안 비밀</Label>
          <Input
            id="gdrive-secret"
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
          <p className="text-[13px] text-muted-foreground">
            브라우저가 열립니다. 구글 로그인·동의를 완료하면 자동으로
            연결됩니다.
          </p>
        )}

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
 * 설정 화면에 임베드하는 Google 드라이브 연결 관리 패널.
 * 연결 상태 표시 + 연결(OAuth 클라이언트 입력) + 연결 해제를 한곳에서 처리한다.
 * Drive 화면은 연결 상태를 각자 조회하므로, 화면을 다시 열면 반영된다.
 */
export function GdriveConnectionPanel() {
  const { status, error, connect, disconnect } = useGdriveConnection()

  if (status === null) {
    return (
      <div className="text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  if (!status.connected) {
    return <SetupView onConnect={connect} error={error} />
  }

  // 연결됨 — 상태 배지 + 연결 해제.
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-[10px] border border-ui-success/40 bg-ui-success/15 px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="size-2 shrink-0 rounded-full bg-ui-success" />
          <span className="text-[15px] font-bold">연결됨</span>
          <span className="text-[13px] text-muted-foreground">
            {status.email ?? "Google 드라이브"}
          </span>
          <div className="ml-auto flex gap-2">
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
