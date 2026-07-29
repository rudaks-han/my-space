import { useCallback, useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { trackedInvoke, isTauri } from "@/lib/tauri"
import { useSettings } from "@/features/settings/settings-context"

/** herdr 로 실행 중인 agent 한 개 (Rust HerdrAgent 와 대응). */
export interface HerdrAgent {
  pane_id: string
  agent: string | null
  agent_status: string
  cwd: string | null
  session_id: string | null
  /** 이 agent 가 속한 herdr 세션 이름(명령 라우팅용). default 세션이면 "default". */
  session: string
}

/** herdr 워크스페이스 (Rust HerdrWorkspace 와 대응). label=프롬프트 요약, agent_status=진행상태. */
export interface HerdrWorkspace {
  workspace_id: string
  label: string
  agent_status: string
  focused: boolean
  pane_count: number
  last_prompt: string | null
  /** 마지막 프롬프트 실행 시각(ISO8601). 최근순 정렬에 사용. */
  last_prompt_at: string | null
  /** 세션 recap(away_summary) 요약. 없으면 null. */
  recap: string | null
  /** 가장 최근 assistant 턴의 총 토큰(입력+출력+캐시). 진행 현황 표시용. */
  token_usage: number | null
  /** 이 워크스페이스의 에이전트 종류(예: "claude"). 없으면 null. */
  agent: string | null
  /** 이 워크스페이스가 속한 herdr 세션 이름(명령 라우팅용). default 세션이면 "default". */
  session: string
}

/** 트레이 팝오버 알림 하나 (Rust HerdrNotice 와 대응). */
export interface HerdrNotice {
  /** "blocked"(입력 대기) | "done"(작업 완료). */
  kind: string
  label: string
  session: string
  workspace_id: string
  id: string
}

/** AskUserQuestion 선택지 하나 (Rust AskOption 과 대응). */
export interface AskOption {
  number: number
  label: string
  description: string
  preview: string
  is_builtin: boolean
}

/** 파싱된 AskUserQuestion (Rust AskQuestion 과 대응). */
export interface AskQuestion {
  pane_id: string
  /** 이 질문이 뜬 pane 의 herdr 세션 이름(focus 라우팅용). */
  session: string
  header: string
  question: string
  options: AskOption[]
  cursor: number
  multi_select: boolean
}

/**
 * herdr agent 목록과 워크스페이스 진행 현황을 관리한다(상태 뷰용).
 * 실제 감시 루프는 Rust 백그라운드 스레드에서 돌고, on/off 는 설정(작업 감시)으로 제어한다
 * (ClaudeNotifier 가 설정을 Rust 에 반영). 여기서는 `herdr:*` 이벤트 구독만 한다.
 */
export function useHerdr() {
  const [agents, setAgents] = useState<HerdrAgent[]>([])
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([])
  // 감시 on/off 는 설정이 단일 출처. 헤더 상태 표시는 이 값을 그대로 보여준다(읽기전용).
  const watching = useSettings().settings.claudeCode.watchEnabled
  const [error, setError] = useState<string | null>(null)

  // setState 는 모두 await 뒤에서만 호출한다(effect 에서 바로 불려도 동기 setState 가
  // 되지 않도록 — react-hooks/set-state-in-effect).
  const refresh = useCallback(async () => {
    if (!isTauri()) return
    try {
      const nextAgents = await trackedInvoke<HerdrAgent[]>("herdr_list_agents")
      const nextWorkspaces = await trackedInvoke<HerdrWorkspace[]>(
        "herdr_list_workspaces"
      )
      setAgents(nextAgents)
      setWorkspaces(nextWorkspaces)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  /** 해당 워크스페이스로 이동(터미널 창을 앞으로). session=herdr 세션명. */
  const focusWorkspace = useCallback(
    async (session: string, workspaceId: string) => {
      await trackedInvoke("herdr_focus_workspace", { session, workspaceId })
    },
    []
  )

  /** 해당 pane 의 Claude 세션에 프롬프트를 입력·전송한다(텍스트+Enter). session=herdr 세션명. */
  const sendPrompt = useCallback(
    async (session: string, paneId: string, text: string) => {
      await trackedInvoke("herdr_send_prompt", { session, paneId, text })
    },
    []
  )

  /** 특정 pane(workspace)의 최근 터미널 로그(주고받은 메시지)를 herdr 소켓으로 읽는다. session=herdr 세션명. */
  const readPane = useCallback(
    async (session: string, paneId: string, lines = 300) => {
      return await trackedInvoke<string>("herdr_read_pane", {
        session,
        paneId,
        lines,
      })
    },
    []
  )

  // 이벤트 구독(감시 중이면 800ms 마다 갱신됨) + 최초 로드.
  useEffect(() => {
    if (!isTauri()) return
    const unAgents = listen<HerdrAgent[]>("herdr:agents", (e) => {
      setAgents(e.payload)
    })
    const unWs = listen<HerdrWorkspace[]>("herdr:workspaces", (e) => {
      setWorkspaces(e.payload)
    })
    // 구독이 붙은 뒤에 최초 스냅샷을 읽는다. 순서를 이렇게 두면 (a) 구독 등록과 최초
    // 조회 사이에 이벤트가 떠서 갱신을 놓치는 일이 없고, (b) effect 본문에서 동기로
    // setState 하지 않는다(react-hooks/set-state-in-effect).
    void Promise.all([unAgents, unWs]).then(() => refresh())
    return () => {
      void unAgents.then((f) => f())
      void unWs.then((f) => f())
    }
  }, [refresh])

  return {
    agents,
    workspaces,
    watching,
    error,
    refresh,
    readPane,
    focusWorkspace,
    sendPrompt,
  }
}
