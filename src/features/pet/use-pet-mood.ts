import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"

import { trackedInvoke } from "@/lib/tauri"
import { statusInfo } from "@/features/claude-bridge/agent-status"
import type {
  AskQuestion,
  HerdrNotice,
  HerdrWorkspace,
} from "@/features/claude-bridge/use-herdr"
import type { ReminderPayload } from "@/features/reminder/reminder-payload"

/**
 * 펫의 동작. 표정·움직임·스프라이트 상태가 모두 이 값 하나에서 나온다.
 *
 *  - `idle`    동작 없음 — 자고 있다. 진행 중인 작업도, 확인할 것도 없는 상태.
 *  - `running` 동작 중 — 무언가 실행 중(예: Claude 작업 1건).
 *  - `busy`    바쁨 — Claude 작업이 2건 이상 동시에 실행 중.
 *  - `waiting` 대기 중 — 사람 확인이 필요하다(작업 완료, AskUserQuestion, 리마인더).
 *
 * 우선순위는 waiting > busy > running > idle. 확인이 필요한 게 있으면 몇 개가 돌고 있든
 * `waiting` 이 이긴다 — 사용자가 움직여 줘야 하는 상태가 가장 급하기 때문이다.
 */
export type PetMood = "idle" | "running" | "busy" | "waiting"

/** `busy` 로 넘어가는 동시 실행 작업 수. */
const BUSY_THRESHOLD = 2

/**
 * 알림 한 건의 종류. `waiting` 일 때 머리 위 배지 아이콘을 고르는 데 쓴다
 * (`working` 은 배지가 아니라 상태 패널 목록에만 나오는 진행 중 작업이다).
 */
export type PetAlert = "input" | "done" | "reminder" | "working"

/**
 * 카드 아래에 붙는 버튼 한 개(리마인더의 확인·다시 알림). 카드를 누르는 것만으로는
 * "확인"과 "5분 뒤 다시"를 구분할 수 없어서, 선택이 필요한 알림은 버튼을 따로 갖는다.
 */
export interface PetNoticeAction {
  label: string
  /** 강조 버튼(확인) — 색이 채워진다. */
  primary?: boolean
  run: () => void
}

/**
 * 말풍선에 그릴 알림 한 건. 알림이 여러 종류라 "어디서 온 알림인지"와 "어떤 작업인지"를
 * 분리해 담는다 — 작업목록(claude-tasks-card) 과 같은 구성이다: 굵은 작업 이름 + 옅은 상세 +
 * 상태 칩. 칩 문구·색도 `agent-status.ts` 에서 그대로 가져와 두 화면이 어긋나지 않게 한다.
 */
export interface PetNotice {
  /** 목록 key — 세션·워크스페이스·종류를 합쳐 만든다. */
  id: string
  /**
   * 무엇을 확인해야 하는지. 머리 위 배지 아이콘이 이 값으로 갈린다
   * (칩 문구를 비교하는 방식은 문구를 바꾸면 조용히 깨진다).
   */
  kind: PetAlert
  /** 머리말 아이콘 종류. Claude Code(herdr) 알림이면 Claude 로고를 쓴다. */
  source: "claude" | "reminder"
  /** 머리말에 적을 출처 이름. */
  sourceName: string
  /** 상태 칩(문구 + 클래스). */
  chip: { text: string; className: string }
  /** 어떤 작업/알림인지 — 굵은 첫 줄. */
  title: string
  /** 부가 설명 — 옅은 둘째 줄. 없으면 그리지 않는다. */
  detail: string | null
  /** 이 항목을 눌렀을 때 데려갈 곳. */
  action: (() => void) | null
  /**
   * 카드 아래 버튼들. 대부분의 알림은 "이동"이 유일한 선택지라 비어 있고,
   * 리마인더만 확인·다시 알림을 갖는다. 없으면 버튼 줄을 그리지 않는다.
   */
  actions: PetNoticeAction[]
}

/** 펫이 지금 보여 줄 것. */
export interface PetState {
  /** 동작 — 표정·움직임·스프라이트 상태를 정한다. */
  mood: PetMood
  /** 지금 실행 중인 Claude 작업 수. `busy` 배지에 숫자로 보여 준다. */
  running: number
  /** 말풍선에 쌓아 보여 줄 알림 전체(급한 것부터). 비어 있으면 말풍선을 띄우지 않는다. */
  notices: PetNotice[]
  /**
   * 지금 실행 중인 작업들. 알림과 달리 **저절로 뜨지 않는다** — 끝날 때까지 계속 떠 있으면
   * 방해만 되므로, 머리 위 진행 표시를 누를 때만 상태 패널에 펼친다(pet-root.tsx).
   * detail 은 사용자가 입력한 프롬프트다("무슨 작업이지?"의 답이 그것이라서).
   */
  tasks: PetNotice[]
}

/**
 * 완료 알림을 말풍선에 띄워 두는 기본 시간(ms). 설정(`settings.pet.noticeSeconds`)이
 * 있으면 그 값을 쓰고, 0 이면 시간으로 끊지 않는다(항상 표시).
 */
const DEFAULT_DONE_TTL_MS = 12_000

/** 리마인더 칩 — agent_status 가 아니라서 여기서 만든다(가장 급한 알림이라 ui-error). */
const REMINDER_CHIP = {
  text: "알림",
  className:
    "rounded-full bg-ui-error/15 px-2 text-[11px] font-bold text-ui-error",
}

/** 다시 알림(스누즈) 선택지 — 분 단위. 실제 재발생은 메인 창의 스케줄러가 맡는다. */
const SNOOZE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5분" },
  { minutes: 30, label: "30분" },
  { minutes: 60, label: "1시간" },
]

/**
 * 전역 이벤트를 구독해 펫의 기분과 말풍선을 만든다.
 *
 * Rust 는 `herdr:*` / `reminder:*` 를 `app.emit` 으로 **모든 창에** 방출하므로 펫 창도
 * 메인 창과 같은 신호를 받는다 — 펫 전용 백엔드 폴링은 없다(작업 감시가 꺼져 있으면
 * 이벤트 자체가 오지 않아 펫은 계속 idle 이고, 그게 맞는 동작이다).
 *
 * 창이 막 떠서 웹뷰가 콜드 로드된 경우 이벤트를 놓치므로, 마운트 시 현재 상태를 한 번 조회한다
 * (`*_current` 커맨드). 펫은 설정에서 꺼 뒀다가 알림이 생길 때만 뜰 수도 있어(pet.rs 의
 * PetAlert) 이 콜드 로드는 예외가 아니라 흔한 경로다.
 */
export function usePetMood(noticeMs = DEFAULT_DONE_TTL_MS): PetState {
  const [reminder, setReminder] = useState<ReminderPayload | null>(null)
  const [questions, setQuestions] = useState<AskQuestion[]>([])
  const [notices, setNotices] = useState<HerdrNotice[]>([])
  /**
   * 워크스페이스 스냅샷. "어떤 작업인지"의 출처다 — 알림(HerdrNotice)의 blocked 는
   * 7초 뒤 만료되지만 입력 대기는 답할 때까지 이어지므로, 작업 이름은 알림이 아니라
   * 여기서 가져와야 말풍선이 도중에 이름을 잃지 않는다.
   */
  const [workspaces, setWorkspaces] = useState<HerdrWorkspace[]>([])
  /**
   * 방금 도착한 완료 알림들(도착 시각과 함께). 완료 알림은 Rust 에서 영구 보관이라
   * 그대로 쓰면 계속 축하하게 되므로 여기서 TTL 을 준다. 동시에 여러 작업이 끝날 수
   * 있으므로 하나만 들고 있으면 안 된다 — 목록으로 쌓아 모두 보여 준다.
   */
  const [dones, setDones] = useState<{ notice: HerdrNotice; at: number }[]>([])
  /** 이미 축하한 완료 알림 id — 같은 알림으로 두 번 들뜨지 않게. */
  const celebrated = useRef<Set<string>>(new Set())

  useEffect(() => {
    void trackedInvoke<ReminderPayload | null>("reminder_current").then((r) => {
      if (r) setReminder(r)
    })
    void trackedInvoke<AskQuestion[]>("herdr_current_questions").then((qs) => {
      if (qs?.length) setQuestions(qs)
    })
    // 마운트 시 이미 있는 완료 알림은 "본 것"으로 처리한다 — 창을 켤 때마다
    // 지난 완료를 다시 축하하지 않도록.
    void trackedInvoke<HerdrNotice[]>("herdr_current_notices").then((ns) => {
      if (!ns?.length) return
      for (const n of ns) if (n.kind === "done") celebrated.current.add(n.id)
      setNotices(ns)
    })

    const unlistens = [
      listen<ReminderPayload>("reminder:fire", (e) => setReminder(e.payload)),
      listen("reminder:dismiss", () => setReminder(null)),
      listen<AskQuestion[]>("herdr:questions", (e) =>
        setQuestions(e.payload || [])
      ),
      listen<HerdrNotice[]>("herdr:notices", (e) => {
        const list = e.payload || []
        setNotices(list)
        // 한 번에 여러 개가 끝날 수 있으므로 새 완료 알림을 모두 집어넣는다.
        const fresh = list.filter(
          (n) => n.kind === "done" && !celebrated.current.has(n.id)
        )
        for (const n of fresh) celebrated.current.add(n.id)
        const at = Date.now()
        /*
         * Rust 목록에서 사라진 완료 알림은 **로컬에서도 버린다.** Rust 는 워크스페이스당
         * 알림을 한 개만 들고 있어(같은 워크스페이스에 새 알림이 오면 기존 것을 교체),
         * 여기서 쌓기만 하면 같은 작업의 이전 프롬프트 카드가 그대로 남아 완료 알림이
         * 두 장씩 보인다("항상 표시"면 TTL 도 안 걷어내므로 계속 누적된다).
         */
        const live = new Set(list.map((n) => n.id))
        setDones((prev) => {
          const kept = prev.filter((d) => live.has(d.notice.id))
          if (!fresh.length && kept.length === prev.length) return prev
          return [...kept, ...fresh.map((notice) => ({ notice, at }))]
        })
      }),
      listen<HerdrWorkspace[]>("herdr:workspaces", (e) =>
        setWorkspaces(e.payload || [])
      ),
    ]
    return () => {
      for (const u of unlistens) void u.then((f) => f())
    }
  }, [])

  /*
   * 완료 축하는 정해진 시간만 — 가장 오래된 것이 만료될 때 깨어나 지난 것들을 걷어낸다.
   * `noticeMs <= 0` 은 "항상 표시"라 타이머를 걸지 않는다(카드를 눌러 치울 때까지 남는다).
   */
  useEffect(() => {
    if (!dones.length || noticeMs <= 0) return
    const oldest = Math.min(...dones.map((d) => d.at))
    const wait = Math.max(0, oldest + noticeMs - Date.now())
    const t = setTimeout(() => {
      const cutoff = Date.now() - noticeMs
      setDones((prev) => prev.filter((d) => d.at > cutoff))
    }, wait + 50)
    return () => clearTimeout(t)
  }, [dones, noticeMs])

  /*
   * 완료 알림을 치운다. **양쪽에서** 지워야 한다:
   *  - 로컬 `dones`: 말풍선 카드를 즉시 없앤다(Rust 이벤트를 기다리면 클릭이 먹은 것처럼 안 보인다).
   *  - Rust `Notices`: 완료 알림은 만료 없이 보관되므로, 안 지우면 "항상 표시"에서 알림이
   *    영원히 남고 펫도 계속 떠 있다(감시 루프가 "알림이 남아 있으면 표시"로 판단한다).
   * `celebrated` 에는 id 가 남아 있어 같은 알림이 다시 올라오지 않는다.
   */
  const clearDone = useCallback((id: string) => {
    setDones((prev) => prev.filter((d) => d.notice.id !== id))
    void trackedInvoke("herdr_dismiss_notice", { id }).catch((e) =>
      console.error("herdr_dismiss_notice 실패:", e)
    )
  }, [])

  return useMemo(
    () =>
      pickState({ reminder, questions, notices, workspaces, dones, clearDone }),
    [reminder, questions, notices, workspaces, dones, clearDone]
  )
}

/** 워크스페이스의 표시 이름 — 작업목록 카드와 같은 규칙(label 우선). */
function taskTitle(w: HerdrWorkspace): string {
  return w.label || w.workspace_id
}

/** 워크스페이스의 부가 설명 — 작업목록 카드와 같은 규칙(recap 우선, 없으면 프롬프트). */
function taskDetail(w: HerdrWorkspace | undefined): string | null {
  return w?.recap ?? w?.last_prompt ?? null
}

/**
 * Claude Code 알림의 공통 머리말 — 출처(Claude 로고 + 이름)와 상태 칩.
 * 칩 문구·색은 `agent-status.ts` 에서 가져와 작업목록 화면과 어긋나지 않게 한다.
 */
function claudeHead(status: "blocked" | "done" | "working") {
  const s = statusInfo(status)
  const kind: PetAlert =
    status === "done" ? "done" : status === "working" ? "working" : "input"
  return {
    kind,
    source: "claude" as const,
    sourceName: "Claude Code",
    chip: { text: s.text, className: s.chip },
  }
}

/**
 * 지금 알려야 할 것을 **모두** 모아 급한 순서로 담고, 동작(mood)을 정한다.
 *
 * 알림이 둘 이상 겹치면(예: 한 작업은 입력 대기, 다른 작업은 방금 완료) 하나만 남기지 않고
 * 다 보여 준다 — 어느 작업 얘기인지 구분이 안 되면 알림이 쓸모없기 때문이다.
 *
 * 동작은 목록과 별개로 정한다: 확인할 것이 하나라도 있으면 `waiting`,
 * 아니면 실행 중인 작업 수로 `busy`(2건 이상) / `running`(1건) / `idle`(0건).
 */
function pickState(s: {
  reminder: ReminderPayload | null
  questions: AskQuestion[]
  notices: HerdrNotice[]
  workspaces: HerdrWorkspace[]
  dones: { notice: HerdrNotice; at: number }[]
  /** 완료 알림을 치우는 콜백(카드를 누르면 확인한 것으로 본다). */
  clearDone: (id: string) => void
}): PetState {
  const out: PetNotice[] = []

  // 1. 사용자가 직접 걸어 둔 알림이 가장 급하다.
  if (s.reminder) {
    out.push({
      id: `reminder:${s.reminder.id}`,
      kind: "reminder",
      source: "reminder",
      sourceName: "리마인더",
      chip: REMINDER_CHIP,
      title: s.reminder.title,
      detail: s.reminder.body || null,
      // 카드를 누르면 알림 목록으로 데려간다 — 확인·미루기는 아래 버튼이 맡으므로
      // 카드 클릭에 그 둘 중 하나를 몰래 배정하면 어느 쪽인지 알 수 없다.
      action: () => void trackedInvoke("pet_open_menu", { menuId: "reminder" }),
      actions: [
        ...SNOOZE_OPTIONS.map((o) => ({
          label: o.label,
          run: () =>
            void trackedInvoke("reminder_snooze", { minutes: o.minutes }),
        })),
        {
          label: "확인",
          primary: true,
          run: () => void trackedInvoke("reminder_dismiss"),
        },
      ],
    })
  }

  /*
   * 2. Claude 가 사람 응답을 기다리는 중. 같은 작업을 두 번 세지 않도록 pane → 워크스페이스 →
   *    알림 순으로 훑고 이미 담은 워크스페이스는 건너뛴다. 작업 이름은 워크스페이스에서
   *    (알림의 blocked 는 7초 뒤 만료되지만 입력 대기는 답할 때까지 이어지므로),
   *    무엇을 묻는지는 질문에서 가져온다.
   */
  const takenWs = new Set<string>()
  const wsKey = (t: { session: string; workspace_id: string }) =>
    `${t.session} ${t.workspace_id}`

  for (const q of s.questions) {
    // 질문은 pane 단위라 워크스페이스를 특정할 수 없다 — 같은 세션의 입력 대기 작업에 붙인다.
    const ws = s.workspaces.find(
      (w) => w.session === q.session && w.agent_status === "blocked"
    )
    if (ws) takenWs.add(wsKey(ws))
    out.push({
      id: `question:${q.session}:${q.pane_id}`,
      ...claudeHead("blocked"),
      title: ws ? taskTitle(ws) : q.header || "Claude Code",
      detail: q.question || q.header || null,
      action: () =>
        void trackedInvoke("herdr_focus_pane", {
          session: q.session,
          paneId: q.pane_id,
        }),
      actions: [],
    })
  }

  for (const w of s.workspaces) {
    if (w.agent_status !== "blocked" || takenWs.has(wsKey(w))) continue
    takenWs.add(wsKey(w))
    out.push({
      id: `blocked:${wsKey(w)}`,
      ...claudeHead("blocked"),
      title: taskTitle(w),
      detail: taskDetail(w) ?? "사용자 응답을 기다립니다",
      action: () => focusWorkspace(w),
      actions: [],
    })
  }

  // 워크스페이스 스냅샷이 아직 없을 때(창을 막 켠 직후)를 위한 폴백.
  for (const n of s.notices) {
    if (n.kind !== "blocked" || takenWs.has(wsKey(n))) continue
    takenWs.add(wsKey(n))
    out.push({
      id: `notice:${n.id}`,
      ...claudeHead("blocked"),
      title: n.label,
      detail: "사용자 응답을 기다립니다",
      action: () => focusWorkspace(n),
      actions: [],
    })
  }

  // 3. 방금 끝난 작업들. 알림의 label 이 작업 이름이고, 요약(recap)이 있으면 붙인다.
  for (const { notice: done } of s.dones) {
    // 다시 일을 시작했거나 입력 대기로 바뀐 작업은 완료 축하를 접는다(중복·모순 방지).
    if (takenWs.has(wsKey(done))) continue
    const ws = s.workspaces.find(
      (w) => w.session === done.session && w.workspace_id === done.workspace_id
    )
    if (ws?.agent_status === "working") continue
    out.push({
      id: `done:${done.id}`,
      ...claudeHead("done"),
      title: done.label,
      detail: ws?.recap ?? null,
      // 누르면 그 작업으로 가고 알림은 확인한 것으로 치운다. 치우지 않으면
      // "항상 표시"에서 카드가 영원히 남아 클릭이 먹지 않은 것처럼 보인다.
      action: () => {
        focusWorkspace(done)
        s.clearDone(done.id)
      },
      actions: [],
    })
  }

  /*
   * 동작 결정. "실행 중"은 herdr 워크스페이스 하나 = Claude 작업 하나로 센다
   * (herdr 세션 하나에 워크스페이스가 여러 개 있을 수 있어, 세션 수로 세면 같은 세션에서
   * 두 작업이 돌아도 1로 잡힌다 — 사용자가 체감하는 "동시에 몇 개"는 작업 수다).
   *
   * 확인할 것이 있으면 몇 개가 돌고 있든 waiting 이 이긴다. 진행 중일 때는 말풍선을
   * 띄우지 않는다 — 끝날 때까지 계속 떠 있으면 방해만 된다.
   */
  const working = s.workspaces.filter((w) => w.agent_status === "working")
  const running = working.length

  /*
   * 진행 중 작업 목록 — 머리 위 진행 표시를 눌렀을 때 "무슨 작업인지" 펼칠 내용.
   * 여기서는 recap 이 아니라 **사용자가 입력한 프롬프트**를 우선한다: 진행 중인 작업에
   * 대해 알고 싶은 건 "내가 뭘 시켰지"이기 때문이다(끝난 작업은 반대로 요약이 궁금하다).
   */
  const tasks: PetNotice[] = working.map((w) => ({
    id: `working:${wsKey(w)}`,
    ...claudeHead("working"),
    title: taskTitle(w),
    detail: w.last_prompt ?? w.recap ?? null,
    action: () => focusWorkspace(w),
    actions: [],
  }))

  if (out.length) return { mood: "waiting", running, notices: out, tasks }
  if (running >= BUSY_THRESHOLD)
    return { mood: "busy", running, notices: [], tasks }
  if (running === 1) return { mood: "running", running, notices: [], tasks }
  return { mood: "idle", running, notices: [], tasks }
}

/** 해당 워크스페이스의 터미널로 이동한다(알림·워크스페이스 어느 쪽이 와도 같은 필드를 쓴다). */
function focusWorkspace(t: { session: string; workspace_id: string }) {
  // 실패를 조용히 넘기지 않는다 — 오래된 알림은 워크스페이스가 이미 닫혀 있어
  // 이동이 실패할 수 있고, 그때 아무 로그도 없으면 원인을 찾을 수 없다.
  void trackedInvoke("herdr_focus_workspace", {
    session: t.session,
    workspaceId: t.workspace_id,
  }).catch((e) => console.error("herdr_focus_workspace 실패:", e))
}
