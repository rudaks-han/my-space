import { useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangleIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  Loader2Icon,
  MonitorUpIcon,
  ScreenShareOffIcon,
  UsersIcon,
  WifiIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { useScreenShare, type ShareStatus } from "./use-screen-share"

/** 패널 카드 톤 — Slack 카드: 10px 라운드 + 옅은 1px 테두리 + 아주 얕은 그림자. */
const CARD =
  "rounded-[10px] border border-border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]"

export function ScreenShareView() {
  const { status, busy, error, tunnelAvailable, start, stop, reopenSender } =
    useScreenShare()
  // 기본은 **사외 주소까지 만드는 것**이다 — 사내망 IP 는 받은 사람이 같은 망에
  // 있어야만 열리고, 그 조건을 미리 알기 어렵다. 단 cloudflared 가 없으면 만들 수
  // 없으므로, 확인 결과가 오면 그때 끈다(없는데 켜 두면 시작 후에 실패만 본다).
  const [useTunnel, setUseTunnel] = useState(true)
  const tunnel = useTunnel && tunnelAvailable !== false

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <StatusCard
        status={status}
        busy={busy}
        useTunnel={tunnel}
        tunnelAvailable={tunnelAvailable}
        onUseTunnelChange={setUseTunnel}
        onStart={() => start(tunnel)}
        onStop={stop}
        onReopen={reopenSender}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-[10px] border border-ui-error/30 bg-ui-error/8 p-4 text-[15px]">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-ui-error" />
          <div>
            <div className="font-bold text-ui-error">
              공유를 시작할 수 없습니다
            </div>
            <div className="mt-1 text-[13px] text-muted-foreground">
              {error}
            </div>
          </div>
        </div>
      )}

      {status.active && <LinksCard status={status} />}

      <HowItWorksCard />
    </div>
  )
}

function StatusCard({
  status,
  busy,
  useTunnel,
  tunnelAvailable,
  onUseTunnelChange,
  onStart,
  onStop,
  onReopen,
}: {
  status: ShareStatus
  busy: boolean
  useTunnel: boolean
  /** null 이면 아직 확인 중. false 면 cloudflared 가 없어 사외 주소를 만들 수 없다. */
  tunnelAvailable: boolean | null
  onUseTunnelChange: (v: boolean) => void
  onStart: () => void
  onStop: () => void
  onReopen: () => void
}) {
  // 세션은 살아 있는데 송신 탭이 안 붙은 상태는 따로 구분해야 한다 —
  // "URL 은 나왔는데 상대방에게 검은 화면만 보이는" 상황의 원인이 대부분 이것이다.
  const state = !status.active
    ? "idle"
    : status.senderConnected
      ? "live"
      : "waiting-sender"

  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "size-2.5 shrink-0 rounded-full",
            state === "live" &&
              "bg-ui-success shadow-[0_0_0_4px] shadow-ui-success/20",
            state === "waiting-sender" && "bg-ui-warning",
            state === "idle" && "bg-muted-foreground/40"
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-bold">
            {state === "live" && "화면을 공유하고 있습니다"}
            {state === "waiting-sender" && "브라우저에서 화면을 선택해 주세요"}
            {state === "idle" && "공유하지 않는 중"}
          </div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">
            {state === "live" && "아래 주소를 상대방에게 전달하세요."}
            {state === "waiting-sender" &&
              "열린 크롬 탭에서 “화면 선택하고 공유 시작”을 눌러야 전송이 시작됩니다."}
            {state === "idle" &&
              "공유를 시작하면 크롬이 열립니다. 거기서 공유할 화면을 고르세요."}
          </div>
        </div>

        {status.active && (
          <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-[13px]">
            <UsersIcon className="size-3.5 text-muted-foreground" />
            <span className="font-bold">{status.viewers}</span>
            <span className="text-muted-foreground">명 시청</span>
            {/* 릴레이는 화질이 낮으므로 몇 명이 그렇게 보고 있는지 숨기지 않는다. */}
            {status.relayViewers > 0 && (
              <span className="text-muted-foreground">
                · 릴레이 {status.relayViewers}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-2">
        {status.active ? (
          <>
            <Button variant="destructive" onClick={onStop} disabled={busy}>
              <ScreenShareOffIcon />
              공유 중지
            </Button>
            {!status.senderConnected && (
              <Button variant="outline" onClick={onReopen}>
                <ExternalLinkIcon />
                송신 탭 다시 열기
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={onStart} disabled={busy}>
              {busy ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <MonitorUpIcon />
              )}
              화면 공유 시작
            </Button>
            {/* 기본은 켜짐. 끄는 경우는 "사내망 밖으로 절대 나가면 안 되는 화면"이라
                외부 경로 자체를 만들고 싶지 않을 때다. */}
            <Label
              className={cn(
                "ml-2 flex items-center gap-2 text-[15px] font-normal",
                tunnelAvailable === false
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer"
              )}
            >
              <Checkbox
                checked={useTunnel}
                disabled={tunnelAvailable === false}
                onCheckedChange={(v) => onUseTunnelChange(v === true)}
              />
              사외에서도 볼 수 있는 주소 만들기
            </Label>
          </>
        )}
      </div>

      {/* cloudflared 가 없으면 시작 전에 알려 준다 — 공유를 켠 뒤에 실패를 보여 주면
          이미 상대를 기다리게 한 상태다. */}
      {!status.active && tunnelAvailable === false && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-secondary p-3 text-[13px]">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-ui-warning" />
          <div>
            <div className="font-semibold">
              지금은 사내망(같은 네트워크)에서만 볼 수 있습니다.
            </div>
            <div className="mt-0.5 text-muted-foreground">
              사외에서 열리는 주소를 만들려면 터미널에서{" "}
              <code className="rounded bg-background px-1 py-0.5 font-mono">
                brew install cloudflared
              </code>{" "}
              를 실행한 뒤 이 화면을 다시 열어 주세요.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function LinksCard({ status }: { status: ShareStatus }) {
  return (
    <div className={CARD}>
      <div className="text-[15px] font-semibold">공유 주소</div>

      {/* 외부 주소를 먼저 보여 준다 — 상대방이 어느 망에 있는지 모를 때 그냥 건네도
          되는 주소가 이것뿐이다. 사내망 주소는 같은 망일 때만 열린다. */}
      <div className="mt-3 flex flex-col gap-3">
        {status.tunnelState !== "off" && <TunnelRow status={status} />}

        {status.lanUrls.length > 0 ? (
          status.lanUrls.map((url, i) => (
            <LinkRow
              key={url}
              icon={<WifiIcon className="size-4 text-muted-foreground" />}
              label={
                status.lanUrls.length > 1
                  ? `같은 네트워크에 있을 때 (${i + 1}/${status.lanUrls.length} · 더 좋은 화질)`
                  : "같은 네트워크에 있을 때(더 좋은 화질)"
              }
              url={url}
              // 망이 여럿이면 어느 주소가 상대방에게 맞는지 알 수 없으므로 둘 다 준다.
              note={
                i === 0
                  ? "첫 접속 때 “연결이 비공개로 설정되어 있지 않습니다” 경고가 뜹니다 — 고급 → 계속을 한 번 누르면 됩니다."
                  : "이 PC 가 여러 네트워크에 붙어 있어 주소가 여럿입니다. 상대방 쪽에서 열리는 것을 쓰세요."
              }
            />
          ))
        ) : (
          <div className="text-[13px] text-muted-foreground">
            네트워크에 연결되어 있지 않아 사내망 주소를 만들 수 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}

function TunnelRow({ status }: { status: ShareStatus }) {
  if (status.tunnelState === "ready" && status.tunnelUrl) {
    return (
      <LinkRow
        icon={<GlobeIcon className="size-4 text-ui-success" />}
        label="상대방에게 전달할 주소 (어느 망에서나 열립니다)"
        url={status.tunnelUrl}
        note="정식 인증서라 경고가 없습니다. 직접 연결이 막히면 자동으로 앱을 거쳐 전송되므로, 이 주소가 열리는 곳이면 화면이 보입니다."
        primary
      />
    )
  }

  if (status.tunnelState === "starting") {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Loader2Icon className="size-3.5 animate-spin" />
        상대방에게 전달할 주소를 만들고 있습니다…
      </div>
    )
  }

  return (
    <div className="flex items-start gap-2 text-[13px]">
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-ui-warning" />
      <div>
        <span className="font-semibold">
          외부 접속용 주소를 만들지 못했습니다.
        </span>{" "}
        <span className="text-muted-foreground">
          {status.tunnelError ?? "알 수 없는 이유로 터널이 종료되었습니다."}
        </span>
        <div className="mt-0.5 text-muted-foreground">
          사내망 주소는 그대로 쓸 수 있습니다.
        </div>
      </div>
    </div>
  )
}

function LinkRow({
  icon,
  label,
  url,
  note,
  primary,
}: {
  icon: React.ReactNode
  label: string
  url: string
  note: string
  /** 주로 전달할 주소 — 라벨을 진하게, 주소를 한 단 크게 보여 준다. */
  primary?: boolean
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      toast.success("주소를 복사했습니다")
    } catch {
      toast.error("복사할 수 없습니다 — 주소를 직접 선택해 복사해 주세요")
    }
  }

  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1.5 text-[13px]",
          primary
            ? "font-bold text-foreground"
            : "font-semibold text-muted-foreground"
        )}
      >
        {icon}
        {label}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        {/* 주소는 눈으로 확인하고 손으로 고를 수 있어야 한다 — 잘리지 않게 줄바꿈을 허용. */}
        <code
          className={cn(
            "min-w-0 flex-1 rounded-lg px-2.5 py-1.5 font-mono break-all select-all",
            primary
              ? "bg-secondary text-[15px] font-bold"
              : "bg-secondary text-[13px]"
          )}
        >
          {url}
        </code>
        <Button
          variant={primary ? "default" : "outline"}
          size={primary ? "default" : "sm"}
          onClick={copy}
          className="shrink-0"
        >
          <CopyIcon />
          복사
        </Button>
      </div>
      <div className="mt-1 text-[13px] text-muted-foreground">{note}</div>
    </div>
  )
}

function HowItWorksCard() {
  return (
    <div className={CARD}>
      <div className="text-[15px] font-semibold">동작 방식과 한계</div>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-[13px] text-muted-foreground">
        <li>
          화면 캡처는 <b className="font-semibold text-foreground">크롬</b>이
          합니다. 앱 내부 웹뷰(WKWebView)는 화면 캡처 API 를 지원하지 않아, 앱은
          주소를 발급하고 연결을 중계하는 역할만 합니다.
        </li>
        <li>
          영상은 먼저{" "}
          <b className="font-semibold text-foreground">
            내 PC 와 상대방이 직접
          </b>{" "}
          주고받습니다(WebRTC). 같은 네트워크에서는 이 경로로 붙어 화질·지연이
          가장 좋습니다.
        </li>
        <li>
          다른 망이라 직접 연결이 막히면{" "}
          <b className="font-semibold text-foreground">
            앱을 거치는 릴레이로 자동 전환
          </b>
          됩니다(초당 5장 · 저화질). 느리지만 주소가 열리는 곳이면 화면은
          보입니다.
        </li>
        <li>
          공인 IP 주소(<code>https://내공인IP:포트</code>)는 쓸 수 없습니다 —
          사내 NAT 뒤라 방화벽에서 포트를 열어 줘야 하고 그건 사내 IT
          권한입니다. 그래서 외부 주소는 터널로 만듭니다.
        </li>
        <li>
          macOS 크롬은 시스템 소리를 캡처할 수 없습니다. 크롬 탭을 공유할 때만
          그 탭의 소리가 함께 전달됩니다.
        </li>
        <li>
          주소에는 임시 토큰이 들어 있고, 공유를 중지하면 바로 무효가 됩니다.
        </li>
      </ul>
    </div>
  )
}
