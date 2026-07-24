import {
  CalendarIcon,
  ClockIcon,
  LogOutIcon,
  MapPinIcon,
  RefreshCwIcon,
  VideoIcon,
} from "lucide-react"
import { useState } from "react"

import { Badge } from "@/components/ui/badge"
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

import { useGcal, type CalendarEvent } from "./use-gcal"

function friendlyError(code: string): string {
  if (code.includes("invalid_grant"))
    return "연결이 만료되었거나 취소되었습니다. 연결을 해제하고 다시 로그인해 주세요."
  if (code.includes("refresh_token"))
    return "권한 승인이 완료되지 않았습니다. 구글 동의 화면에서 캘린더 접근을 허용해 주세요."
  if (code.includes("timeout"))
    return "로그인 대기 시간이 초과되었습니다. '연결'을 다시 눌러 진행해 주세요."
  if (code.includes("access_denied"))
    return "접근이 거부되었습니다. 동의 화면에서 허용해야 합니다."
  if (code.includes("not_connected")) return "아직 연결되지 않았습니다."
  return `오류: ${code}`
}

/** 지금 진행 중인 일정인지(현재 시각이 start~end 사이). */
function isNow(ev: CalendarEvent): boolean {
  if (ev.all_day) return false
  const now = Date.now()
  return new Date(ev.start).getTime() <= now && now < new Date(ev.end).getTime()
}

function EventRow({ ev }: { ev: CalendarEvent }) {
  const now = isNow(ev)
  return (
    <div
      className={`ui-selectable flex gap-3 rounded-lg border p-3 ${
        now ? "border-primary/50 bg-primary/5" : ""
      }`}
    >
      <div className="flex w-24 shrink-0 flex-col">
        <span className="text-sm font-medium tabular-nums">
          {ev.all_day ? "종일" : new Date(ev.start).toLocaleTimeString("ko-KR", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        {!ev.all_day && (
          <span className="text-xs text-muted-foreground tabular-nums">
            ~{" "}
            {new Date(ev.end).toLocaleTimeString("ko-KR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{ev.summary}</span>
          {now && <Badge className="shrink-0">진행 중</Badge>}
        </div>
        {ev.location && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPinIcon className="size-3 shrink-0" />
            <span className="truncate">{ev.location}</span>
          </span>
        )}
        {ev.meet_link && (
          <a
            href={ev.meet_link}
            className="flex w-fit items-center gap-1 text-xs text-primary hover:underline"
          >
            <VideoIcon className="size-3" />
            화상 회의 참여
          </a>
        )}
      </div>
    </div>
  )
}

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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Google 캘린더 연결</CardTitle>
          <CardDescription>
            오늘 일정을 보려면 Google Cloud 데스크톱 앱 OAuth 클라이언트가 필요합니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-sm">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-muted-foreground">
            <li>
              <span className="text-foreground">console.cloud.google.com</span>{" "}
              에서 프로젝트 생성(또는 선택)
            </li>
            <li>
              <b className="text-foreground">APIs &amp; Services → 라이브러리</b> 에서{" "}
              <b className="text-foreground">Google Calendar API</b> 사용 설정
            </li>
            <li>
              <b className="text-foreground">OAuth 동의 화면</b> 구성 → External(회사
              계정이면 Internal) → 테스트 모드면{" "}
              <b className="text-foreground">테스트 사용자에 본인 계정 추가</b>
            </li>
            <li>
              <b className="text-foreground">사용자 인증 정보 → OAuth 클라이언트 ID 만들기</b>{" "}
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
            onClick={handleConnect}
            disabled={busy || !clientId.trim() || !clientSecret.trim()}
          >
            {busy ? "브라우저에서 로그인하세요…" : "연결"}
          </Button>
          {busy && (
            <p className="text-xs text-muted-foreground">
              브라우저가 열립니다. 구글 로그인·동의를 완료하면 자동으로 연결됩니다.
            </p>
          )}

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {friendlyError(error)}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function GcalView() {
  const { status, events, loading, error, updatedAt, connect, disconnect, refresh } =
    useGcal()

  if (status === null) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  }

  if (!status.connected) {
    return <SetupView onConnect={connect} error={error} />
  }

  const todayLabel = new Date().toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  })

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <CalendarIcon className="size-5" />
          <div className="flex flex-col">
            <span className="text-sm font-medium">{todayLabel}</span>
            <span className="text-xs text-muted-foreground">
              {status.email ?? "Google 캘린더"}
              {updatedAt &&
                ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })} 업데이트`}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
            새로고침
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
            <LogOutIcon />
            연결 해제
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {friendlyError(error)}
        </p>
      )}

      {loading && events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center py-16 text-sm text-muted-foreground">
          일정을 불러오는 중…
        </div>
      ) : events.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
          <ClockIcon className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">오늘 예정된 일정이 없습니다.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((ev, i) => (
            <EventRow key={`${ev.start}-${i}`} ev={ev} />
          ))}
        </div>
      )}
    </div>
  )
}
