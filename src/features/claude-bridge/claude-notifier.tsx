import { useEffect, useRef } from "react"
import { listen } from "@tauri-apps/api/event"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"
import type { HerdrWorkspace } from "./use-herdr"

/**
 * Claude Code(herdr) 작업 상태 전환을 감시해 트레이 팝오버 알림을 띄운다.
 * herdr 감시 루프(Rust)가 매 폴링마다 방출하는 `herdr:workspaces` 를 구독하고,
 * 워크스페이스별 이전 상태와 비교해 "전환된 순간"에만 `herdr_notify` 를 호출한다
 * (Rust 가 트레이 팝오버 창에 알림을 띄우고 잠시 뒤 자동으로 닫는다).
 *   - 입력 대기 진입(→ blocked): 사용자 응답 필요.
 *   - 작업 완료(working → done|idle): 진행 중이던 작업 종료.
 * 각 알림은 설정(myspace.settings)에서 개별로 끌 수 있다.
 *
 * 렌더링 없이 App 최상단에 항상 마운트되어(메인 창을 트레이로 숨겨도 웹뷰는 살아 있음)
 * 어느 화면을 보고 있든 동작한다. 이 컴포넌트는 UI 를 그리지 않는다(알림은 위젯 창이 그림).
 */
export function ClaudeNotifier() {
  const { settings } = useSettings()

  // 최신 설정을 리스너에서 읽기 위한 ref(리스너를 재구독하지 않고 최신 값 참조).
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  // 감시 대상 터미널(herdr / cmux / orca)과 cmux 소켓 비밀번호를 Rust 에 반영한다.
  // Rust 감시 루프는 창이 열리기 전(로그인 자동 시작)부터 도므로 localStorage 를 읽을 수
  // 없다 — 그래서 herdr_set_backend 가 ~/.myspace/backend 에 값을 남기고, 루프는 매 폴링마다
  // 그 값을 본다(백엔드를 바꿔도 감시를 재시작할 필요가 없다).
  //
  // 이 effect 는 아래 watch 토글보다 **먼저 선언돼 있어야** 한다. effect 는 선언 순서로
  // 실행되므로, 이렇게 두면 감시가 시작되는 시점에 백엔드가 이미 확정돼 있다.
  // 배열 그대로 두면 매 렌더가 새 참조라 effect 가 계속 돈다 — 쉼표로 이어 값으로 비교한다
  // (Rust 가 받는 형식도 이 문자열이다).
  const backend = settings.claudeCode.backend.join(",")
  const { cmuxPassword } = settings.claudeCode
  useEffect(() => {
    if (!isTauri()) return
    void trackedInvoke("herdr_set_backend", {
      backend,
      password: cmuxPassword,
    }).catch((e) => console.error("감시 백엔드 설정 실패:", e))
  }, [backend, cmuxPassword])

  // 작업 감시 on/off 설정을 Rust 감시 루프에 반영한다. 이 컴포넌트는 어느 화면에서든
  // 항상 마운트돼 있어(설정 화면에서 토글해도) 토글 즉시·마운트 시 상태를 동기화한다.
  // start/stop 커맨드가 ~/.myspace/watch-disabled 플래그를 갱신하므로 재시작 후에도 유지된다.
  const watchEnabled = settings.claudeCode.watchEnabled
  useEffect(() => {
    if (!isTauri()) return
    void trackedInvoke(
      watchEnabled ? "herdr_start_watch" : "herdr_stop_watch"
    ).catch((e) => console.error("herdr watch 토글 실패:", e))
  }, [watchEnabled])

  // "<session>\0<workspace_id>" → 직전 agent_status. 전환 감지에 사용.
  // pane/workspace id 는 herdr 세션 간 겹칠 수 있어 세션까지 합쳐 식별한다.
  const prevStatus = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    if (!isTauri()) return

    // 트레이 팝오버에 알림을 띄운다(Rust 가 표시·자동 닫기·"이동" 라우팅을 담당).
    const notify = (
      kind: "blocked" | "done",
      label: string,
      session: string,
      workspaceId: string
    ) => {
      void trackedInvoke("herdr_notify", {
        kind,
        label,
        session,
        workspaceId,
      }).catch((e) => console.error("herdr_notify 실패:", e))
    }

    const unlisten = listen<HerdrWorkspace[]>("herdr:workspaces", (e) => {
      const cfg = settingsRef.current.claudeCode
      const prev = prevStatus.current
      const seen = new Set<string>()

      for (const w of e.payload) {
        // workspace_id 는 herdr 세션 간 겹칠 수 있어 세션까지 합쳐 식별한다.
        const wid = `${w.session}\u0000${w.workspace_id}`
        seen.add(wid)
        const before = prev.get(wid)
        const now = w.agent_status
        prev.set(wid, now)

        // 첫 스냅샷이거나 상태 변화 없음 — 알리지 않는다(앱 시작 시 무더기 알림 방지).
        if (before === undefined || before === now) continue

        // 사용자가 지금 그 터미널을 보고 있으면 알림을 만들지 않는다 — 화면에서 이미 보고
        // 있는 것을 펫이 되풀이할 이유가 없다. 만들어 두면 감시 루프가 다음 틱에 철회하므로
        // (withdraw_seen_notices) 카드가 1초쯤 번쩍이고 사라진다.
        if (w.seen) continue

        // 알림 메시지는 사용자가 입력했던 프롬프트를 우선 사용(없으면 label/워크스페이스 id).
        const label = w.last_prompt || w.label || w.workspace_id

        // 입력 대기 진입.
        if (now === "blocked" && cfg.notifyOnBlocked) {
          notify("blocked", label, w.session, w.workspace_id)
          continue
        }
        // 작업 완료: 진행 중 → 완료/대기.
        if (
          before === "working" &&
          (now === "done" || now === "idle") &&
          cfg.notifyOnDone
        ) {
          notify("done", label, w.session, w.workspace_id)
        }
      }

      // 사라진 워크스페이스는 정리(재등장 시 다시 전환으로 인식되도록).
      for (const id of [...prev.keys()]) {
        if (!seen.has(id)) prev.delete(id)
      }
    })

    return () => {
      void unlisten.then((f) => f())
    }
  }, [])

  return null
}
