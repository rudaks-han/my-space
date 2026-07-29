/**
 * 프로젝트별 "순차 실행" 프리셋.
 *
 * `stages` 의 한 단계 안에 있는 설정들은 **동시에** 띄우고, 다음 단계는 앞 단계가
 * 모두 기동을 마친 뒤(Spring Boot 의 "Started …" 로그 또는 고정 포트 LISTEN) 시작한다.
 * 실제 진행은 Rust 의 `intellij_start_sequence` 가 담당한다 — 화면을 떠나도 계속된다.
 *
 * IntelliJ 의 Multirun 은 전부 한꺼번에 띄우므로 이 "앞 단계를 기다린다" 를 표현할 수 없다.
 */
export interface StartSequence {
  /** 버튼에 표시할 이름. */
  label: string
  /** 버튼 설명(툴팁). 실행 순서를 그대로 보여 준다. */
  description: string
  stages: string[][]
}

/** 키는 프로젝트 폴더 이름(= 최근 프로젝트 목록에 보이는 이름). */
export const START_SEQUENCES: Record<string, StartSequence> = {
  cowork: {
    label: "일괄 실행",
    description:
      "Registry → Uaa → Messaging 을 차례로 올린 뒤 Buzzer·Depot·Cstalk·Bff 를 함께 실행합니다.",
    stages: [
      ["RegistryApplication"],
      ["UaaApplication"],
      ["MessagingApplication"],
      [
        "BuzzerApplication",
        "DepotApplication",
        "CstalkApplication",
        "BffApplication",
      ],
    ],
  },
}

/** 프로젝트 경로에 해당하는 프리셋(없으면 null). */
export function sequenceFor(projectPath: string | null): StartSequence | null {
  if (!projectPath) return null
  const folder = projectPath.replace(/\/+$/, "").split("/").pop() ?? ""
  return START_SEQUENCES[folder] ?? null
}
