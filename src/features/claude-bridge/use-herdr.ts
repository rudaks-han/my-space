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
  /**
   * **사용자가 지금 이 워크스페이스를 터미널에서 보고 있다**(Rust `mark_seen`).
   * = 터미널 안에서 focused + 그 터미널 앱이 OS 최전면. 알림을 클릭하지 않고 터미널에서
   * 직접 확인한 경우를 알아내는 신호이므로, 이 값이 true 면 알림을 만들지도 띄우지도 않는다.
   * Orca 는 focused 를 알 수 없어 항상 false 다.
   */
  seen: boolean
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
  /**
   * 도구 입력에는 없고 **터미널 화면에만** 있던 선택지(Claude Code 가 목록 뒤에 스스로 붙이는
   * `Type something.` / `Chat about this`). 라벨이 화면 폭에 맞춰 잘려 있을 수 있어 설명을
   * 곁들이지 않고 그대로 보여준다.
   */
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
  /** 지금 터미널 커서가 가리키는 번호. **0 = 알 수 없음**(화면을 못 읽었거나 마커가 안 보임). */
  cursor: number
  multi_select: boolean
  /**
   * 이 앱 화면에서 바로 답할 수 있는가(Rust 가 판단). 답변은 "방향키로 커서 이동 + Enter"
   * 이므로 특수키를 보낼 수 있는 백엔드이고 화면에서 커서를 읽을 수 있을 때만 참이다.
   * 거짓이면 선택 버튼을 내지 않고 "터미널에서 선택" 만 안내한다.
   */
  can_answer: boolean
}

/**
 * 워크스페이스를 가리키는 키. 여러 herdr 세션이 동시에 떠 있으면 workspace_id 만으로는
 * 충돌하므로 세션명을 함께 묶는다.
 */
export const wsKey = (w: { session: string; workspace_id: string }): string =>
  `${w.session} ${w.workspace_id}`

/** 최근 프롬프트순(내림차순, 없는 건 뒤). */
export function byRecent(a: HerdrWorkspace, b: HerdrWorkspace): number {
  const ta = a.last_prompt_at ?? ""
  const tb = b.last_prompt_at ?? ""
  if (ta === tb) return 0
  if (!ta) return 1
  if (!tb) return -1
  return tb.localeCompare(ta)
}

/**
 * 워크스페이스에서 돌고 있는 agent 를 찾는다.
 * `pane_id` 는 어느 백엔드에서도 `"<workspace>:<pane>"` 형식이므로 접두어로 찾는다
 * (cmux 는 `"<ws uuid>:<surface uuid>"`, Orca 는 `"<tabId>:<leafId>:<handle>"`).
 */
export function agentOf(
  agents: HerdrAgent[],
  w: HerdrWorkspace
): HerdrAgent | undefined {
  return agents.find(
    (a) => a.session === w.session && a.pane_id.startsWith(`${w.workspace_id}:`)
  )
}

/** 워크스페이스 → pane_id 매핑(로그 읽기·프롬프트 전송용). */
export function paneOf(
  agents: HerdrAgent[],
  w: HerdrWorkspace
): string | undefined {
  return agentOf(agents, w)?.pane_id
}

/**
 * agent 목록과 워크스페이스 진행 현황을 관리한다(상태 뷰용).
 * 실제 감시 루프는 Rust 백그라운드 스레드에서 돌고, on/off 와 감시 대상 터미널
 * (herdr / cmux / orca)은 설정으로 제어한다(ClaudeNotifier 가 설정을 Rust 에 반영).
 * 여기서는 `herdr:*` 이벤트 구독만 한다 — 이벤트 이름과 데이터 모양은 백엔드와 무관하게
 * 같으므로, 어느 터미널을 보고 있는지는 이 훅 아래로 내려가지 않는다.
 */
export function useHerdr() {
  const [agents, setAgents] = useState<HerdrAgent[]>([])
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([])
  // 감시 on/off 와 백엔드는 설정이 단일 출처. 헤더·오류 문구는 이 값을 그대로 보여준다(읽기전용).
  const { watchEnabled: watching, backend } = useSettings().settings.claudeCode
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

  /**
   * 해당 pane 에 지금 떠 있는 선택 폼을 읽는다(없으면 null). 화면까지 합쳐 읽으므로 커서와
   * TUI 가 붙인 여분 선택지도 함께 온다. `herdr:questions` 이벤트를 쓰지 않는 이유는 그쪽이
   * **작업 감시가 켜져 있을 때만** 오기 때문이다 — 감시를 꺼 둬도 지금 떠 있는 질문에는
   * 답할 수 있어야 한다.
   */
  const readQuestion = useCallback(async (session: string, paneId: string) => {
    return await trackedInvoke<AskQuestion | null>("herdr_read_question", {
      session,
      paneId,
    })
  }, [])

  /** 선택 폼에 답한다(커서 이동 + Enter). `numbers` 는 고를 선택지 번호(1-base). */
  const answerQuestion = useCallback(
    async (session: string, paneId: string, numbers: number[]) => {
      await trackedInvoke("herdr_answer_question", {
        session,
        paneId,
        numbers,
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
    /** 지금 무엇을 보고 있는지(오류 문구에 이름을 넣기 위해). */
    backend,
    error,
    refresh,
    readPane,
    readQuestion,
    answerQuestion,
    focusWorkspace,
    sendPrompt,
  }
}
