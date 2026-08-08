/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useMemo,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"

import { useLocalStorage } from "@/lib/use-local-storage"

/**
 * Kafka 뷰어가 처음부터 쓰던 그 키다. 프로바이더를 얹는 것이지 저장 위치를 옮기는 것이
 * 아니므로 **바꾸면 안 된다** — 바꾸면 사용자가 저장해 둔 브로커 주소가 사라진다.
 */
const STORAGE_KEY = "myspace.kafkaConn"

/**
 * 저장하는 Kafka 연결 정보(+자동 연결 여부).
 *
 * `kafka-client` 의 `KafkaConnection` 에 `autoConnect` 하나만 더 붙은 모양이라
 * `new KafkaClient(cfg)` 에 그대로 넘길 수 있다(구조적 타이핑 — 남는 필드는 무시된다).
 */
export interface KafkaStoredConn {
  /** `host:port[,host:port…]` — bootstrap.servers 그대로. */
  brokers: string
  /** 브로커 응답 대기 한도(ms). null 이면 Rust 기본값(8초). */
  timeoutMs: number | null
  /** 다음 실행 때(정확히는 뷰가 처음 마운트될 때) 자동으로 접속할지. */
  autoConnect: boolean
}

export const DEFAULT_KAFKA_CONN: KafkaStoredConn = {
  brokers: "localhost:9092",
  timeoutMs: null,
  autoConnect: false,
}

export interface KafkaConn {
  conn: KafkaStoredConn
  setConn: Dispatch<SetStateAction<KafkaStoredConn>>
}

const KafkaConnContext = createContext<KafkaConn | null>(null)

/**
 * Kafka 접속 정보를 창 전체에 하나로 공급한다.
 *
 * 각 화면이 `useLocalStorage` 로 따로 읽으면 안 된다 — **같은 창 안의** `useLocalStorage`
 * 끼리는 서로의 변경을 통보받지 못하고(`storage` 이벤트는 다른 창에서만 온다), 탭은
 * keep-alive 라 Kafka 뷰어와 IntelliJ Cowork 이 동시에 마운트된 채로 살아 있다. 그러면
 * 한쪽에서 브로커 주소를 고쳐도 다른 쪽이 예전 스냅샷으로 되돌린다(나중에 쓴 쪽이 이긴다).
 *
 * **DB 와 달리 화면별 사본을 두지 않고 하나를 공유한다.** DB 는 접속이 *목록*이고
 * "화면마다 다른 접속"이 명시된 요구였지만 Kafka 는 설정이 딱 하나이고 id 도 없다.
 * 사본을 주면 같은 값을 두 군데서 맞춰 줘야 하고, 방금 뷰어에서 맞춘 클러스터를
 * Cowork 패널이 왜 안 보는지 사용자가 알 수 없다.
 *
 * ⚠️ 공유가 백엔드에 남기는 부작용은 하나 있는데, **고장이 아니라 느려짐이다.**
 * `kafka.rs` 는 `brokers` 문자열별로 메타데이터 컨슈머를 `Mutex<HashMap<…>>` 에 캐시해
 * 두고, `kafka_disconnect` 는 그 항목을 프로세스 전역에서 걷어 낸다. 그리고
 * `KafkaClient.connect()` 는 주소를 바꿔 재연결하는 경우를 위해 항상 `disconnect()` 를
 * 먼저 부른다. 즉 **한 화면에서 [연결]을 누르면 다른 화면의 다음 호출이 캐시를 다시 만드는
 * 만큼 느려진다** — 상태를 잃거나 오류가 나지는 않는다(캐시는 필요할 때 다시 채워진다).
 * DB 의 `db_disconnect` 위험(다른 화면의 세션이 통째로 끊긴다)과 같은 모양이지만
 * 결과가 양성이라, 고치려 들지 말고 이 성질을 알고 쓰면 된다.
 */
export function KafkaConnProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useLocalStorage<KafkaStoredConn>(
    STORAGE_KEY,
    DEFAULT_KAFKA_CONN
  )

  const value = useMemo<KafkaConn>(() => ({ conn, setConn }), [conn, setConn])

  return (
    <KafkaConnContext.Provider value={value}>
      {children}
    </KafkaConnContext.Provider>
  )
}

/**
 * Kafka 접속 정보. 프로바이더가 없으면 자기 몫의 `useLocalStorage` 로 물러난다.
 *
 * 기본값으로 물러나지 않는 이유는 ES 쪽과 같다 — 빈 칸은 설정이 날아간 것처럼 읽힌다.
 * 다만 **그 대비책에 기대지 말 것**: 같은 창에서 이 훅을 두 번 부르면 두 벌이 갈라진다.
 * 팝아웃 창(`ViewWindowRoot`)에도 프로바이더를 걸어 둔 이유가 그것이다.
 */
export function useKafkaConn(): KafkaConn {
  const ctx = useContext(KafkaConnContext)
  const [conn, setConn] = useLocalStorage<KafkaStoredConn>(
    STORAGE_KEY,
    DEFAULT_KAFKA_CONN
  )
  const fallback = useMemo<KafkaConn>(
    () => ({ conn, setConn }),
    [conn, setConn]
  )
  return ctx ?? fallback
}
