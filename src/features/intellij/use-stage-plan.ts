import { useCallback, useMemo } from "react"

import { useLocalStorage } from "@/lib/use-local-storage"
import { sequenceFor } from "./start-sequences"
import type { Service } from "./use-services"

/** 일괄 실행 단계 수(1단계~5단계). */
export const STAGE_COUNT = 5

/** 프로젝트 폴더 이름 → 단계별 설정 이름 배열(길이 5). */
type PlanMap = Record<string, string[][]>

const STAGES_KEY = "myspace.intellij.stages"

/**
 * 순차 실행 단계에 넣을 수 있는 설정 종류.
 * HTTP 요청·JUnit 은 "기동 완료(Started… 로그 / 포트 LISTEN)"라는 개념이 없어
 * 단계 대기를 표현할 수 없으므로 제외한다.
 */
const RUNNABLE = new Set(["spring-boot", "java", "multirun"])

/** ApiGatewayApplication 이 프로필별로 쓰는 기본 포트(agent = 8080). */
const GATEWAY_PORT = 8080

function folderOf(projectPath: string | null): string {
  if (!projectPath) return ""
  return projectPath.replace(/\/+$/, "").split("/").pop() ?? ""
}

/**
 * 포트 8080 으로 뜨는 ApiGateway 설정을 찾는다.
 *
 * 실행 설정 이름은 사용자마다 다르게 지을 수 있어("(agent)" 가 아닐 수 있다) 이름 대신
 * **포트**로 고른다 — `attic-port.yml` 규약상 agent 변종이 8080 이다. 포트를 아직 못
 * 알아낸 경우를 대비해 이름/프로필 휴리스틱을 뒤에 둔다.
 */
function findGateway(services: Service[]): Service | undefined {
  return (
    services.find((s) => s.expected_port === GATEWAY_PORT) ??
    services.find(
      (s) =>
        /apigateway/i.test(s.module ?? s.name) &&
        (s.profiles ?? "")
          .split(",")
          .some((p) => p.trim().toLowerCase() === "agent")
    )
  )
}

/**
 * 저장된 구성이 없을 때 보여줄 기본 5단계.
 *
 * cowork 프리셋(Registry → Uaa → Messaging → Buzzer·Depot·Cstalk·Bff)에
 * 포트 8080 ApiGateway 를 마지막 단계로 덧붙인다(게이트웨이는 뒤 서비스가 다 뜬 뒤 올린다).
 * 그런 다음 항상 5칸이 되도록 빈 단계로 채운다.
 */
function buildDefault(
  projectPath: string | null,
  services: Service[]
): string[][] {
  const preset = sequenceFor(projectPath)
  const stages: string[][] = preset ? preset.stages.map((s) => [...s]) : []

  const gateway = findGateway(services)
  if (gateway && !stages.some((st) => st.includes(gateway.name))) {
    stages.push([gateway.name])
  }

  while (stages.length < STAGE_COUNT) stages.push([])
  return stages.slice(0, STAGE_COUNT)
}

/** name 을 모든 단계에서 뺀 새 배열. */
function withoutName(stages: string[][], name: string): string[][] {
  return stages.map((s) => s.filter((n) => n !== name))
}

/**
 * name 을 stageIndex 단계의 beforeName 앞(없으면 맨 뒤)으로 옮긴다.
 * 먼저 다른 단계에서 빼므로 한 설정이 두 단계에 동시에 들어가지 않는다.
 */
export function placeService(
  stages: string[][],
  name: string,
  stageIndex: number,
  beforeName: string | null
): string[][] {
  const cleaned = withoutName(stages, name)
  const target = [...cleaned[stageIndex]]
  const at = beforeName ? target.indexOf(beforeName) : -1
  if (at >= 0) target.splice(at, 0, name)
  else target.push(name)
  cleaned[stageIndex] = target
  return cleaned
}

/** name 을 모든 단계에서 빼 "미포함" 으로 되돌린다. */
export function removeService(stages: string[][], name: string): string[][] {
  return withoutName(stages, name)
}

/**
 * 일괄 실행 단계 구성을 다루는 훅.
 *
 * 프로젝트 폴더별로 localStorage 에 저장하고, 저장된 게 없으면 프리셋 기반 기본값을
 * 만들어 준다. 목록에서 사라진 설정 이름은 표시·실행에서 자동으로 걸러 낸다.
 */
export function useStagePlan(projectPath: string | null, services: Service[]) {
  const [map, setMap] = useLocalStorage<PlanMap>(STAGES_KEY, {})
  const folder = folderOf(projectPath)

  /** 단계에 넣을 수 있는 설정 이름(현재 목록 기준). */
  const eligible = useMemo(
    () => services.filter((s) => RUNNABLE.has(s.type)).map((s) => s.name),
    [services]
  )
  const eligibleSet = useMemo(() => new Set(eligible), [eligible])

  /** 실제로 보여줄 5단계 — 저장값(없으면 기본값)에서 지금 없는 설정은 뺀 뒤 5칸으로 맞춘다. */
  const stages = useMemo(() => {
    const raw = map[folder] ?? buildDefault(projectPath, services)
    const out: string[][] = []
    for (let i = 0; i < STAGE_COUNT; i++) {
      out.push((raw[i] ?? []).filter((n) => eligibleSet.has(n)))
    }
    return out
  }, [map, folder, projectPath, services, eligibleSet])

  /** 어느 단계에도 없는(=제외된) 설정들. */
  const excluded = useMemo(() => {
    const assigned = new Set(stages.flat())
    return eligible.filter((n) => !assigned.has(n))
  }, [stages, eligible])

  const setStages = useCallback(
    (next: string[][]) => {
      if (!folder) return
      setMap((prev) => ({ ...prev, [folder]: next }))
    },
    [folder, setMap]
  )

  /** 저장값을 지워 기본 프리셋으로 되돌린다. */
  const resetStages = useCallback(() => {
    if (!folder) return
    setMap((prev) => {
      if (!(folder in prev)) return prev
      const next = { ...prev }
      delete next[folder]
      return next
    })
  }, [folder, setMap])

  return {
    stages,
    excluded,
    /** 저장된(사용자가 손댄) 구성이 있는지 — "기본값 복원" 버튼 노출 기준. */
    customized: folder in map,
    setStages,
    resetStages,
  }
}
