import { trackedInvoke } from "@/lib/tauri"

/**
 * Kafka 뷰어의 프론트엔드 클라이언트.
 *
 * Kafka 는 HTTP 가 아니라 TCP 바이너리 프로토콜이라 웹뷰에서 직접 붙을 수 없다.
 * 실제 통신은 전부 Rust(`src-tauri/src/kafka.rs`)의 librdkafka 클라이언트가 하고,
 * 여기서는 명령 호출과 타입만 담당한다. 연결 정보는 매 호출에 그대로 넘긴다
 * (ES 뷰어의 `EsClient` 와 같은 구조).
 */

/** 연결 정보. localStorage 에 저장했다가 요청마다 Rust 로 넘긴다. */
export interface KafkaConnection {
  /** `host:port[,host:port…]` — bootstrap.servers 그대로. */
  brokers: string
  /** 브로커 응답 대기 한도(ms). null 이면 Rust 기본값(8초). */
  timeoutMs: number | null
}

export interface BrokerInfo {
  id: number
  host: string
  port: number
}

export interface ClusterInfo {
  brokers: BrokerInfo[]
  topicCount: number
  /** 메타데이터를 응답한 브로커. */
  origin: string
}

export interface TopicInfo {
  name: string
  partitions: number
  replication: number
  /** `__` 로 시작하는 Kafka 내부 토픽. */
  internal: boolean
  /** 워터마크 합계. 건수 조회를 끄면 null. */
  messages: number | null
}

export interface PartitionInfo {
  id: number
  leader: number
  replicas: number[]
  isr: number[]
  low: number
  high: number
}

export interface ConfigEntry {
  name: string
  value: string | null
  source: string
  isDefault: boolean
  isReadOnly: boolean
  isSensitive: boolean
}

/** 메시지 조회 시작 위치. */
export type SeekMode = "latest" | "earliest" | "offset" | "timestamp"

export interface FetchRequest {
  topic: string
  /** null 이면 전체 파티션. */
  partition: number | null
  mode: SeekMode
  offset: number | null
  /** epoch millis. */
  timestamp: number | null
  limit: number
  /** 키/값/헤더 부분일치 필터(Rust 에서 거른다). */
  search: string | null
  pollMs: number | null
}

export interface KafkaRecord {
  partition: number
  offset: number
  timestamp: number | null
  key: string | null
  /** UTF-8 이 아니라 base64 로 담겨 온 값. */
  keyBinary: boolean
  value: string | null
  valueBinary: boolean
  size: number
  headers: [string, string | null][]
}

export interface FetchResult {
  records: KafkaRecord[]
  /** 필터 적용 전 실제로 읽은 건수. */
  scanned: number
  /** [파티션, low, high] */
  watermarks: [number, number, number][]
  truncated: boolean
  timedOut: boolean
}

export interface GroupMember {
  id: string
  clientId: string
  clientHost: string
}

export interface GroupInfo {
  name: string
  state: string
  protocol: string
  protocolType: string
  members: GroupMember[]
}

export interface GroupOffset {
  topic: string
  partition: number
  committed: number
  high: number
  lag: number
}

export interface ProduceRequest {
  topic: string
  partition: number | null
  key: string | null
  value: string
  headers: [string, string][]
}

export interface ProduceResult {
  partition: number
  offset: number
}

/** Rust 가 문자열로 던진 오류를 감싼다. */
export class KafkaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KafkaError"
  }
}

export class KafkaClient {
  private conn: KafkaConnection

  constructor(conn: KafkaConnection) {
    this.conn = conn
  }

  private get config() {
    return {
      brokers: this.conn.brokers.trim(),
      timeoutMs: this.conn.timeoutMs,
    }
  }

  private async call<T>(cmd: string, args: Record<string, unknown> = {}) {
    try {
      return await trackedInvoke<T>(cmd, { config: this.config, ...args })
    } catch (e) {
      throw new KafkaError(String(e))
    }
  }

  /** 연결 확인 + 클러스터 개요. */
  connect() {
    return this.call<ClusterInfo>("kafka_connect")
  }

  /** 캐시된 연결 폐기(주소 변경·재연결 시). */
  disconnect() {
    return this.call<void>("kafka_disconnect")
  }

  /** 토픽 목록. `withCounts` 면 파티션 워터마크까지 읽어 건수를 채운다(느려진다). */
  topics(withCounts: boolean) {
    return this.call<TopicInfo[]>("kafka_topics", { withCounts })
  }

  partitions(topic: string) {
    return this.call<PartitionInfo[]>("kafka_partitions", { topic })
  }

  topicConfigs(topic: string) {
    return this.call<ConfigEntry[]>("kafka_topic_configs", { topic })
  }

  fetch(req: FetchRequest) {
    return this.call<FetchResult>("kafka_fetch", { req })
  }

  groups() {
    return this.call<GroupInfo[]>("kafka_groups")
  }

  /** 그룹의 커밋 오프셋/lag. `topics` 가 비면 내부 토픽을 뺀 전체가 대상. */
  groupOffsets(group: string, topics: string[] = []) {
    return this.call<GroupOffset[]>("kafka_group_offsets", { group, topics })
  }

  produce(req: ProduceRequest) {
    return this.call<ProduceResult>("kafka_produce", { req })
  }
}
