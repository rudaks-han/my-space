/**
 * IntelliJ Cowork 화면의 **공유 계약**. 이 폴더의 모든 파일이 여기서만 타입을 가져온다.
 *
 * 이 화면은 IntelliJ 를 켜지 않고 cowork 를 개발하기 위한 한 장짜리 콘솔이다:
 * 왼쪽 프로젝트 트리 · 가운데 탭 편집기 · 오른쪽 데이터베이스 · 아래 서비스+콘솔.
 * 네 영역이 서로를 열어 주므로(트리 → 탭, DB → 탭, 실행 → 콘솔) 탭 모델 하나를
 * 가운데 두고 나머지가 그것을 조작하는 모양이다.
 */

import type { TableRef } from "@/features/db-viewer/db-client"

/** localStorage 키는 전부 이 접두사 아래에 둔다 — 다른 뷰와 값이 섞이지 않도록. */
export const NS = "myspace.coworkDev"

/**
 * 데이터베이스 뷰어와 **함께 쓰는 저장 칸**(`db-viewer/persisted.ts`)에 붙일 화면 접두사.
 *
 * 격자의 WHERE·ORDER BY, 콘솔 초안, 테이블 검색어가 그 칸에 있는데, 접두사가 없으면
 * 두 화면이 한 칸을 나눠 쓴다 — 저쪽에서 탭을 닫을 때 도는 `purgeTableQuery` 가 이쪽이
 * 쓰는 조회 조건을 지우고, 두 콘솔이 서로의 초안을 덮어쓴다(탭은 keep-alive 라 둘이
 * 동시에 떠 있는 게 기본이다). 한 글자만 바뀌어도 저장 위치가 갈리므로 상수로 둔다.
 */
export const DB_SCOPE = "coworkDev"

/**
 * Elasticsearch 뷰어와 함께 쓰는 저장 칸(`es-viewer/persisted.ts`)에 붙일 화면 접두사.
 *
 * `DB_SCOPE` 와 **완전히 같은 이유**다 — 저 모듈은 `myspace.esViewer` 한 칸에 검색어·DSL·
 * 컬럼·정렬·페이지 크기를 담고, 접두사가 없으면 두 화면이 그 칸을 나눠 쓴다. 그러면
 * Elasticsearch 뷰어에서 인덱스 탭을 닫을 때 도는 `purgeIndex` 가 여기 열려 있는 같은
 * 인덱스의 조회 조건을 지운다(탭은 keep-alive 라 두 화면이 동시에 떠 있는 게 기본이다).
 * 접속 정보만은 `useEsConn()` 으로 공유한다 — 그건 화면마다 달라서는 안 되는 값이다.
 */
export const ES_SCOPE = "coworkDev"

/**
 * Kafka 뷰어와 함께 쓰는 저장 칸(`kafka-viewer/persisted.ts`)에 붙일 화면 접두사.
 *
 * 위 둘과 같은 이유이고, 저쪽 주석대로 여기서 더 급하다: `purgeTopic` 은 토픽을 지울 때가
 * 아니라 **탭을 닫을 때마다** 돌기 때문에, 칸을 나눠 쓰면 Kafka 뷰어에서 토픽 탭 하나를
 * 닫는 것만으로 이 화면의 파티션·시작 위치·오프셋·검색어가 조용히 기본값으로 돌아간다.
 */
export const KAFKA_SCOPE = "coworkDev"

/**
 * 오른쪽 패널의 레일이 고르는 인프라 도구.
 *
 * 세 도구가 한 자리를 나눠 쓰는 이유는 화면 폭이다 — 접속 목록·트리·격자가 다 넓어야
 * 읽히는데 셋을 나란히 두면 하나도 못 읽는다. 그래서 오른쪽은 항상 하나만 보이고,
 * 무엇이 보이는지는 이 값이 정한다(연 탭은 도구와 무관하게 가운데에 그대로 남는다).
 */
export type InfraTool = "db" | "es" | "kafka"

/**
 * 가운데 편집 영역에 열리는 탭 하나.
 *
 * 일곱 종류를 한 배열에 담는 이유: 사용자에게는 "열려 있는 것" 하나의 줄이고,
 * 종류별로 탭 줄을 나누면 어디에 뭐가 열렸는지 눈으로 못 쫓는다.
 *
 * id 는 **종류마다 다른 접두사**로 시작한다(`file:` · `table:` · `sql:` · `es:` ·
 * `kafka:topic:` · `kafka:groups` · `kafka:brokers`). 한 배열의 정체성이 id 하나이므로
 * 접두사가 겹치면 인덱스 이름과 같은 토픽 이름이 서로를 닫아 버린다.
 */
export type DevTab =
  | {
      kind: "file"
      /** `file:<절대경로>` */
      id: string
      /** 절대 경로 */
      path: string
      /** 프로젝트 루트 기준 상대 경로(빵부스러기·탭 툴팁) */
      rel: string
      /** 파일명 */
      name: string
    }
  | {
      kind: "table"
      /** `table:<connId>:<catalog>.<schema>.<name>` */
      id: string
      connId: string
      table: TableRef
      name: string
    }
  | {
      kind: "sql"
      /** `sql:<connId>` — 접속당 콘솔 하나 */
      id: string
      connId: string
      name: string
    }
  | {
      kind: "esIndex"
      id: `es:${string}`
      /** 인덱스 이름 — `IndexPane` 에 그대로 넘긴다. */
      index: string
      name: string
    }
  | {
      kind: "kafkaTopic"
      id: `kafka:topic:${string}`
      /** 토픽 이름 — `TopicPane` 에 그대로 넘긴다. */
      topic: string
      name: string
    }
  // 컨슈머 그룹·브로커는 클러스터에 하나뿐이라 **탭도 하나뿐**이다(id 가 고정 상수인 이유).
  // 여러 개 열리면 같은 목록을 두 번 보여 주면서 어느 쪽이 최신인지 알 수 없다.
  | {
      kind: "kafkaGroups"
      id: typeof KAFKA_GROUPS_TAB_ID
      name: string
    }
  | {
      kind: "kafkaBrokers"
      id: typeof KAFKA_BROKERS_TAB_ID
      name: string
    }

export function fileTabId(path: string): string {
  return `file:${path}`
}

export function tableTabId(connId: string, t: TableRef): string {
  return `table:${connId}:${t.catalog ?? ""}.${t.schema ?? ""}.${t.name}`
}

export function sqlTabId(connId: string): string {
  return `sql:${connId}`
}

export function esIndexTabId(index: string): `es:${string}` {
  return `es:${index}`
}

export function kafkaTopicTabId(topic: string): `kafka:topic:${string}` {
  return `kafka:topic:${topic}`
}

/**
 * 싱글턴 탭의 id.
 *
 * 상수로 두는 이유는 **두 번 적히면 안 되기 때문**이다 — 여는 쪽과 판별하는 쪽이 각자
 * 문자열을 적으면 한쪽만 고쳤을 때 탭이 열리기는 하는데 아무것도 안 그려진다(id 는
 * 있는데 그 id 로 만들어지는 arm 이 없다). 토픽 이름에는 `:` 를 쓸 수 없으므로
 * (`[a-zA-Z0-9._-]` 만 허용) 실제 토픽 탭의 id 와 겹칠 일도 없다.
 */
export const KAFKA_GROUPS_TAB_ID = "kafka:groups"
export const KAFKA_BROKERS_TAB_ID = "kafka:brokers"

/** `.http` / `.rest` 는 IntelliJ HTTP 편집기로 연다(거터 ▶ 실행). */
export function isHttpFile(path: string): boolean {
  return /\.(http|rest)$/i.test(path)
}

/**
 * `.md` / `.markdown` 은 마크다운 탭(`md-tab.tsx`)으로 연다 — 원문 편집기와, Cowork Spec
 * 문서 메뉴가 쓰는 것과 **같은** 뷰어(`cowork-spec/markdown-viewer.tsx`, 번들된
 * `rudaks.css` 를 섀도 DOM 에 주입)를 한 탭에서 모드로 전환한다. 이 저장소의 `.md` 는
 * 읽는 문서가 대부분이라 원문만 보여 주면 표·코드펜스·mermaid 가 기호 덩어리로 남는다.
 */
export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown)$/i.test(path)
}

/**
 * 아래 독의 콘솔 탭.
 *
 * `output` = 선택한 서비스의 로그, `response` = 방금 보낸 HTTP 요청의 응답.
 * 쿼리 결과가 여기 없는 이유: 결과 격자는 SQL 을 쓴 자리 바로 아래 있어야 읽히므로
 * 가운데 `sql` 탭(= db-viewer 의 `QueryConsole`)이 통째로 담당한다.
 */
export type DockTab = "output" | "response"

/** 왼쪽 트리의 항목 하나 — Rust `dev_list_dir` 이 돌려주는 모양 그대로. */
export interface DevEntry {
  /** 파일·폴더 이름 */
  name: string
  /** 절대 경로 */
  path: string
  /** 프로젝트 루트 기준 상대 경로 */
  rel: string
  dir: boolean
}

/** Rust `dev_read_file` 의 결과. */
export interface DevFileText {
  text: string
  /** 텍스트로 읽을 수 없는 파일(NUL 바이트) — 편집기 대신 안내를 띄운다. */
  binary: boolean
  /** 크기 제한(2MB)에 걸려 잘렸다 — 저장을 막아야 한다. */
  truncated: boolean
  size: number
}
