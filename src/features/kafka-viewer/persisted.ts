/**
 * Kafka 뷰어의 토픽별/전역 조회 조건을 localStorage 에 직접 읽고 쓰는 모듈.
 *
 * ES 뷰어의 `persisted.ts` 와 같은 이유 — 검색어처럼 타이핑마다 바뀌는 값을
 * 상위 state 로 올리면 keep-alive 된 모든 탭이 함께 리렌더된다. 조회 조건은
 * 각 패널의 로컬 state 로 두고, 저장만 여기서 한다.
 *
 * ── 화면(scope) 구분 ──
 * 모든 get/set 의 **마지막 인자**로 붙는 `scope` 는 저장 칸의 화면 접두사다. 안 주면
 * Kafka 뷰어가 예전부터 쓰던 칸을 그대로 읽고 쓴다(뷰어의 기존 호출을 한 글자도 바꾸지
 * 않고 두 번째 화면만 자기 칸을 갖게 하려는 배치 — 데이터베이스·ES 뷰어와 같은 모양이다).
 *
 * ⚠️ 여기서는 접두사가 ES 보다 더 급하다. `purgeTopic` 이 **토픽을 지울 때가 아니라 탭을
 * 닫을 때마다** 돌기 때문이다. 칸을 나눠 쓰면 한쪽에서 토픽 탭 하나를 닫는 것만으로
 * 다른 화면에 열려 있는 같은 토픽의 파티션·시작 위치·오프셋·건수·검색어가 통째로
 * 사라진다(그 패널은 자기 state 를 들고 있으니 그 자리에선 멀쩡해 보이고, 다음에 다시
 * 열 때 기본값으로 돌아가 있다 — 즉 조용히 틀린다).
 */

import type { SeekMode } from "./kafka-client"

const KEY = "myspace.kafkaViewer"

/** 토픽 하나의 메시지 조회 조건. */
export interface TopicQuery {
  /** null = 전체 파티션. */
  partition: number | null
  mode: SeekMode
  /** mode=offset 일 때 시작 오프셋(입력 문자열 그대로). */
  offset: string
  /** mode=timestamp 일 때 `datetime-local` 값. */
  timestamp: string
  limit: number
  search: string
}

export const DEFAULT_QUERY: TopicQuery = {
  partition: null,
  mode: "latest",
  offset: "",
  timestamp: "",
  limit: 100,
  search: "",
}

/** 화면 하나가 들고 있는 토픽 목록 상태(토픽별이 아니라 화면별로 하나씩). */
interface ScopedPrefs {
  topicFilter: string
  showInternal: boolean
  withCounts: boolean
}

interface KafkaPersisted {
  /**
   * 키는 `<화면 접두사:><토픽 이름>` — 접두사를 붙이는 쪽은 이 모듈의 `slot()` 이고,
   * 그 값은 `TopicPane` 의 `scope` prop 에서 온다. 접두사가 없는 키가 Kafka 뷰어의 몫이다.
   */
  queries: Record<string, TopicQuery>
  /** 왼쪽 토픽 목록 검색어(화면 구분 없는 기본 칸 = Kafka 뷰어). */
  topicFilter: string
  /** 내부 토픽(`__`)을 목록에 넣을지(기본 칸). */
  showInternal: boolean
  /** 파티션 워터마크를 읽어 건수를 계산할지(기본 칸). */
  withCounts: boolean
  /**
   * 화면(scope)별 목록 상태. 이 셋은 칸이 토픽마다 있는 게 아니라 하나뿐이고 **패널이
   * mount 될 때 한 번만 읽힌다** — 나눠 쓰면 깜빡이는 대신 한쪽에서 켠 "내부 토픽 표시"나
   * 끈 "건수 계산"을 다른 쪽이 다음에 열 때 조용히 물려받는다.
   */
  scopes: Record<string, Partial<ScopedPrefs>>
}

const DEFAULTS: KafkaPersisted = {
  queries: {},
  topicFilter: "",
  showInternal: false,
  withCounts: true,
  scopes: {},
}

function read(): KafkaPersisted {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<KafkaPersisted>) }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(p: KafkaPersisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // 저장 실패는 무시(용량 초과 등)
  }
}

/**
 * 토픽별 칸의 키. `scope` 가 없으면 토픽 이름 그대로 — 뷰어가 예전에 저장한 칸이다.
 * Kafka 토픽 이름은 `[a-zA-Z0-9._-]` 만 허용하므로 `:` 를 구분자로 써도 섞이지 않는다.
 */
function slot(topic: string, scope?: string): string {
  return scope ? `${scope}:${topic}` : topic
}

export function getTopicQuery(topic: string, scope?: string): TopicQuery {
  return { ...DEFAULT_QUERY, ...(read().queries[slot(topic, scope)] ?? {}) }
}

export function setTopicQuery(topic: string, q: TopicQuery, scope?: string) {
  const p = read()
  p.queries[slot(topic, scope)] = q
  write(p)
}

/**
 * 탭을 닫을 때 조회 조건을 버린다 — 토픽을 지울 때가 아니라 **닫을 때마다** 돈다.
 * 그래서 `scope` 를 반드시 자기 화면 것으로 넘겨야 한다(맨 위 ⚠️ 주석 참고).
 */
export function purgeTopic(topic: string, scope?: string) {
  const p = read()
  delete p.queries[slot(topic, scope)]
  write(p)
}

/**
 * 아래 여섯 함수의 `scope` 도 **뒤에 붙는 선택 인자**다 — Kafka 뷰어의 기존 호출을 그대로
 * 두고(= 저장 위치도 그대로) 두 번째 화면만 자기 칸을 쓰게 한다.
 */
export function getTopicFilter(scope?: string): string {
  const p = read()
  return scope ? (p.scopes[scope]?.topicFilter ?? "") : p.topicFilter
}
export function setTopicFilter(v: string, scope?: string) {
  write(
    patchScope(scope, { topicFilter: v }, (p) => ({ ...p, topicFilter: v }))
  )
}

export function getShowInternal(scope?: string): boolean {
  const p = read()
  return scope ? (p.scopes[scope]?.showInternal ?? false) : p.showInternal
}
export function setShowInternal(v: boolean, scope?: string) {
  write(
    patchScope(scope, { showInternal: v }, (p) => ({ ...p, showInternal: v }))
  )
}

export function getWithCounts(scope?: string): boolean {
  const p = read()
  // 기본값이 true 라 `?? DEFAULTS.withCounts` 로 둔다 — `?? false` 로 쓰면 새 화면이
  // 건수 계산을 끈 상태로 시작해 뷰어와 다르게 보인다.
  return scope
    ? (p.scopes[scope]?.withCounts ?? DEFAULTS.withCounts)
    : p.withCounts
}
export function setWithCounts(v: boolean, scope?: string) {
  write(patchScope(scope, { withCounts: v }, (p) => ({ ...p, withCounts: v })))
}

/** scope 가 있으면 그 칸을, 없으면 기본 칸을 고친 새 스냅샷을 만든다. */
function patchScope(
  scope: string | undefined,
  patch: Partial<ScopedPrefs>,
  plain: (p: KafkaPersisted) => KafkaPersisted
): KafkaPersisted {
  const p = read()
  if (!scope) return plain(p)
  // DEFAULTS.scopes 를 그대로 물고 오는 경우가 있어 새 객체로 갈아 끼운다.
  return {
    ...p,
    scopes: { ...p.scopes, [scope]: { ...p.scopes[scope], ...patch } },
  }
}
