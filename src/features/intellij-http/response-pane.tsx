import { useMemo, useState } from "react"
import {
  CheckIcon,
  CircleAlertIcon,
  CopyIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import { JsonText } from "@/components/json-view"
import { cn } from "@/lib/utils"
import { header, parseResponseBody } from "./http-script"
import type { RunResult } from "./run-request"

/**
 * 응답 패널 — IntelliJ 의 실행 결과 창과 같은 정보를 같은 순서로 보여 준다:
 * 상태줄(코드·시간·크기) → 본문 · 헤더 · 테스트 · 실제로 보낸 요청.
 *
 * "요청" 탭이 있는 이유: 이 기능에서 가장 흔한 사고가 **변수가 엉뚱하게 치환된 것**이라,
 * 최종 URL·헤더·본문을 눈으로 확인할 자리가 없으면 원인을 찾을 수 없다.
 */

type Tab = "body" | "headers" | "tests" | "request"

/** 상태코드 → 칩 색. `--ui-*` 토큰만 쓴다(팔레트 클래스 금지 — CLAUDE.md). */
function statusClass(status: number): string {
  if (status >= 500) return "bg-ui-error/15 text-ui-error"
  if (status >= 400) return "bg-ui-warning/20 text-ui-warning"
  if (status >= 300) return "bg-ui-info/15 text-ui-info"
  return "bg-ui-success/15 text-ui-success"
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ResponsePane({
  result,
  running,
}: {
  result: RunResult | null
  running: boolean
}) {
  const [tab, setTab] = useState<Tab>("body")
  const [raw, setRaw] = useState(false)
  const [copied, setCopied] = useState(false)

  const res = result?.response ?? null
  const body = useMemo(() => (res ? parseResponseBody(res) : null), [res])
  const isJson = typeof body === "object" && body !== null

  const failed = result?.tests.filter((t) => !t.passed).length ?? 0

  const copyBody = () => {
    if (!res) return
    void navigator.clipboard.writeText(res.body).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  if (running && !result) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> 요청을 보내는 중…
      </div>
    )
  }

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-[13px] text-muted-foreground">
        요청 왼쪽의 ▶ 또는 ⌘Enter 로 실행하면 응답이 여기 나옵니다.
      </div>
    )
  }

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: "body", label: "본문" },
    { id: "headers", label: "헤더", badge: res?.headers.length },
    { id: "tests", label: "테스트", badge: result.tests.length || undefined },
    { id: "request", label: "요청" },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 상태줄 */}
      <div className="flex flex-wrap items-center gap-2 px-1 pb-2">
        <span className="text-[13px] font-bold">{result.label}</span>
        {res ? (
          <>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-bold",
                statusClass(res.status)
              )}
            >
              {res.status} {res.statusText}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {res.elapsedMs.toLocaleString()} ms · {fmtSize(res.size)} ·{" "}
              {res.httpVersion}
            </span>
          </>
        ) : (
          <span className="rounded-full bg-ui-error/15 px-2 py-0.5 text-[11px] font-bold text-ui-error">
            실패
          </span>
        )}
        {running && (
          <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <div className="ml-auto flex items-center gap-1">
          {isJson && tab === "body" && (
            <button
              type="button"
              onClick={() => setRaw((v) => !v)}
              className="rounded-full px-2 py-0.5 text-[11px] font-bold text-muted-foreground hover:bg-ui-list-hover"
            >
              {raw ? "정렬" : "원문"}
            </button>
          )}
          {res && (
            <button
              type="button"
              onClick={copyBody}
              title="본문 복사"
              className="flex size-6 items-center justify-center rounded-lg text-muted-foreground hover:bg-ui-list-hover"
            >
              {copied ? (
                <CheckIcon className="size-3.5 text-ui-success" />
              ) : (
                <CopyIcon className="size-3.5" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* 경고들 — 미해결 변수·스크립트 오류·전송 실패 */}
      {result.error && (
        <Notice tone="error" icon={<CircleAlertIcon className="size-4" />}>
          {result.error}
        </Notice>
      )}
      {result.missing.length > 0 && (
        <Notice tone="warning" icon={<TriangleAlertIcon className="size-4" />}>
          해결되지 않은 변수: {result.missing.map((m) => `{{${m}}}`).join(", ")}
        </Notice>
      )}
      {result.scriptError && (
        <Notice tone="error" icon={<CircleAlertIcon className="size-4" />}>
          스크립트 오류: {result.scriptError}
        </Notice>
      )}
      {result.savedTo && (
        <Notice tone="info" icon={<CheckIcon className="size-4" />}>
          응답을 저장했습니다: {result.savedTo}
        </Notice>
      )}

      {/* 탭 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "relative -mb-px px-2.5 py-1.5 text-[13px] transition-colors",
              tab === t.id
                ? "font-bold text-foreground after:absolute after:inset-x-1 after:-bottom-px after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
            {t.id === "tests" && failed > 0 ? (
              <span className="ml-1 rounded-full bg-ui-error/15 px-1.5 text-[11px] font-bold text-ui-error">
                {failed} 실패
              </span>
            ) : t.badge ? (
              <span className="ml-1 text-[11px] text-muted-foreground">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
        {tab === "body" && (
          <BodyView res={res} body={body} isJson={isJson} raw={raw} />
        )}
        {tab === "headers" && res && (
          <table className="w-full text-[13px]">
            <tbody>
              {res.headers.map(([k, v], i) => (
                <tr key={`${k}-${i}`} className="align-top">
                  <td className="w-56 py-1 pr-3 font-mono text-ui-link">{k}</td>
                  <td className="py-1 font-mono break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "tests" && <TestsView result={result} />}
        {tab === "request" && <SentView result={result} />}
      </div>
    </div>
  )
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "error" | "warning" | "info"
  icon: React.ReactNode
  children: React.ReactNode
}) {
  const cls =
    tone === "error"
      ? "bg-ui-error/10 text-ui-error"
      : tone === "warning"
        ? "bg-ui-warning/12 text-ui-warning"
        : "bg-ui-info/10 text-ui-info"
  return (
    <div
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap",
        cls
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  )
}

function BodyView({
  res,
  body,
  isJson,
  raw,
}: {
  res: RunResult["response"]
  body: unknown
  isJson: boolean
  raw: boolean
}) {
  if (!res) return null
  if (res.body.length === 0)
    return <p className="text-[13px] text-muted-foreground">본문이 없습니다.</p>
  if (res.binary)
    return (
      <p className="text-[13px] text-muted-foreground">
        텍스트가 아닌 응답입니다({fmtSize(res.size)}
        {header(res.headers, "content-type")
          ? ` · ${header(res.headers, "content-type")}`
          : ""}
        ). 아래는 읽을 수 있는 부분만 표시한 것입니다.
        <pre className="mt-2 font-mono text-[13px] break-all whitespace-pre-wrap">
          {res.body.slice(0, 4000)}
        </pre>
      </p>
    )
  if (isJson && !raw) return <JsonText text={JSON.stringify(body, null, 2)} />
  return (
    <pre className="font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap">
      {res.body}
    </pre>
  )
}

function TestsView({ result }: { result: RunResult }) {
  if (result.tests.length === 0 && result.logs.length === 0)
    return (
      <p className="text-[13px] text-muted-foreground">
        이 요청에는 응답 핸들러(<code>{"> {% … %}"}</code>)가 없습니다.
      </p>
    )
  return (
    <div className="space-y-1">
      {result.tests.map((t, i) => (
        <div
          key={`${t.name}-${i}`}
          className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-ui-list-hover"
        >
          {t.passed ? (
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-ui-success" />
          ) : (
            <XIcon className="mt-0.5 size-4 shrink-0 text-ui-error" />
          )}
          <div className="min-w-0">
            <div className={cn("font-bold", !t.passed && "text-ui-error")}>
              {t.name}
            </div>
            {t.message && (
              <div className="text-muted-foreground">{t.message}</div>
            )}
          </div>
        </div>
      ))}
      {result.logs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 px-2 text-[13px] font-semibold text-muted-foreground">
            client.log
          </div>
          <pre className="rounded-lg bg-muted/40 px-3 py-2 font-mono text-[13px] whitespace-pre-wrap">
            {result.logs.join("\n")}
          </pre>
        </div>
      )}
    </div>
  )
}

function SentView({ result }: { result: RunResult }) {
  const sent = result.sent
  if (!sent)
    return (
      <p className="text-[13px] text-muted-foreground">
        요청을 만들지 못했습니다.
      </p>
    )
  const lines = [
    `${sent.method} ${sent.url}`,
    ...sent.headers.map(([k, v]) => `${k}: ${v}`),
    ...(sent.bodyPreview ? ["", sent.bodyPreview] : []),
  ]
  return (
    <pre className="font-mono text-[13px] leading-relaxed break-all whitespace-pre-wrap">
      {lines.join("\n")}
    </pre>
  )
}
