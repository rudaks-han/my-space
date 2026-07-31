import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { trackedInvoke } from "@/lib/tauri"

/** cloudflared 터널의 진행 상태. */
export type TunnelState = "off" | "starting" | "ready" | "failed"

/** Rust `screenshare::ShareStatus` 와 같은 모양(camelCase 로 직렬화된다). */
export interface ShareStatus {
  /** 공유 세션(리스너)이 살아 있는지. */
  active: boolean
  /** 송신 탭이 실제로 화면을 잡고 붙어 있는지 — active 라도 아직 false 일 수 있다. */
  senderConnected: boolean
  viewers: number
  /**
   * 그중 P2P 가 막혀 릴레이(앱 경유 JPEG)로 보고 있는 사람 수.
   * 화질이 낮으므로 UI 에 드러낸다.
   */
  relayViewers: number
  /**
   * 송신 탭 주소(localhost). **상대방에게 주는 주소가 아니다** — "다시 열기"에만 쓴다.
   * 화면에 표시하면 받은 사람이 자기 PC 를 열게 되므로 UI 에 내보내지 않는다.
   */
  senderUrl: string | null
  /**
   * 같은 네트워크에서 볼 수 있는 주소(자체 서명 https). 유선과 Wi-Fi 에 동시에
   * 붙어 있으면 **망마다 하나씩** 나온다 — 상대방이 어느 망에 있는지 모르기 때문이다.
   */
  lanUrls: string[]
  /** 터널 주소(정식 https). 준비 전이면 null. */
  tunnelUrl: string | null
  tunnelState: TunnelState
  tunnelError: string | null
}

const IDLE: ShareStatus = {
  active: false,
  senderConnected: false,
  viewers: 0,
  relayViewers: 0,
  senderUrl: null,
  lanUrls: [],
  tunnelUrl: null,
  tunnelState: "off",
  tunnelError: null,
}

/**
 * 화면 공유 상태. 폴링이 없다 — 시청자 접속·터널 준비 같은 변화는 Rust 가
 * `screenshare:state` 로 밀어 주므로 탭 활성 여부에 따라 굳이 멈출 게 없다.
 * (탭 keep-alive 규칙상 인터벌이 있으면 tabActive 로 게이팅해야 하지만 여기는 해당 없음.)
 */
export function useScreenShare() {
  const [status, setStatus] = useState<ShareStatus>(IDLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 사외 주소를 만들 수 있는지(cloudflared 설치 여부). null 이면 아직 확인 중.
   * 공유를 시작한 뒤에 실패를 알리면 늦으므로 미리 물어본다.
   */
  const [tunnelAvailable, setTunnelAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let alive = true
    trackedInvoke<boolean>("screenshare_tunnel_available")
      .then((ok) => {
        if (alive) setTunnelAvailable(ok)
      })
      .catch(() => {
        if (alive) setTunnelAvailable(false)
      })
    // 탭을 닫았다 다시 열어도 진행 중인 공유가 그대로 보이도록 현재 상태를 조회한다.
    trackedInvoke<ShareStatus>("screenshare_status")
      .then((s) => {
        if (alive) setStatus(s)
      })
      .catch(() => {})

    const unlisten = listen<ShareStatus>("screenshare:state", (e) => {
      setStatus(e.payload)
    })
    return () => {
      alive = false
      unlisten.then((f) => f())
    }
  }, [])

  const start = useCallback(async (tunnel: boolean) => {
    setBusy(true)
    setError(null)
    try {
      setStatus(
        await trackedInvoke<ShareStatus>("screenshare_start", { tunnel })
      )
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await trackedInvoke<ShareStatus>("screenshare_stop"))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const reopenSender = useCallback(async () => {
    try {
      await trackedInvoke("screenshare_reopen_sender")
    } catch (e) {
      setError(String(e))
    }
  }, [])

  return { status, busy, error, tunnelAvailable, start, stop, reopenSender }
}
