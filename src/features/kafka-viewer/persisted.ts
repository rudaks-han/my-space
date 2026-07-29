/**
 * Kafka 뷰어의 토픽별/전역 조회 조건을 localStorage 에 직접 읽고 쓰는 모듈.
 *
 * ES 뷰어의 `persisted.ts` 와 같은 이유 — 검색어처럼 타이핑마다 바뀌는 값을
 * 상위 state 로 올리면 keep-alive 된 모든 탭이 함께 리렌더된다. 조회 조건은
 * 각 패널의 로컬 state 로 두고, 저장만 여기서 한다.
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

interface KafkaPersisted {
  queries: Record<string, TopicQuery>
  topicFilter: string
  showInternal: boolean
  withCounts: boolean
}

const DEFAULTS: KafkaPersisted = {
  queries: {},
  topicFilter: "",
  showInternal: false,
  withCounts: true,
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

export function getTopicQuery(topic: string): TopicQuery {
  return { ...DEFAULT_QUERY, ...(read().queries[topic] ?? {}) }
}

export function setTopicQuery(topic: string, q: TopicQuery) {
  const p = read()
  p.queries[topic] = q
  write(p)
}

export function purgeTopic(topic: string) {
  const p = read()
  delete p.queries[topic]
  write(p)
}

export function getTopicFilter(): string {
  return read().topicFilter
}
export function setTopicFilter(v: string) {
  write({ ...read(), topicFilter: v })
}

export function getShowInternal(): boolean {
  return read().showInternal
}
export function setShowInternal(v: boolean) {
  write({ ...read(), showInternal: v })
}

export function getWithCounts(): boolean {
  return read().withCounts
}
export function setWithCounts(v: boolean) {
  write({ ...read(), withCounts: v })
}
