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
 * ES 뷰어가 처음부터 쓰던 그 키다. 프로바이더를 새로 얹는 것이지 저장 위치를 옮기는
 * 것이 아니므로 **바꾸면 안 된다** — 바꾸는 순간 사용자가 저장해 둔 호스트·계정이
 * 사라지고, 자동 연결도 꺼진 것처럼 보인다.
 */
const STORAGE_KEY = "myspace.esConn"

/**
 * 저장하는 ES 연결 정보(+자동 연결 여부).
 *
 * `es-client` 의 `EsConnection` 에 `autoConnect` 하나만 더 붙은 모양이라 `new EsClient(cfg)`
 * 에 그대로 넘길 수 있다(구조적 타이핑 — 남는 필드는 무시된다). 필드를 나눠서 두면
 * 화면마다 두 조각을 다시 합쳐야 하므로 한 덩어리로 둔다.
 */
export interface EsStoredConn {
  host: string
  /** 비우면(null) 포트 없이 접속. */
  port: number | null
  https: boolean
  username: string
  password: string
  /** 다음 실행 때(정확히는 뷰가 처음 마운트될 때) 자동으로 접속할지. */
  autoConnect: boolean
}

export const DEFAULT_ES_CONN: EsStoredConn = {
  host: "172.16.120.191",
  port: 9200,
  https: false,
  username: "",
  password: "",
  autoConnect: false,
}

export interface EsConn {
  conn: EsStoredConn
  setConn: Dispatch<SetStateAction<EsStoredConn>>
}

const EsConnContext = createContext<EsConn | null>(null)

/**
 * ES 접속 정보를 창 전체에 하나로 공급한다.
 *
 * 각 화면이 `useLocalStorage` 로 따로 읽으면 안 된다 — **같은 창 안의** `useLocalStorage`
 * 끼리는 서로의 변경을 통보받지 못하고(`storage` 이벤트는 다른 창에서만 온다), 탭은
 * keep-alive 라 Elasticsearch 뷰어와 IntelliJ Cowork 이 동시에 마운트된 채로 살아 있다.
 * 그러면 한쪽에서 호스트를 고쳐도 다른 쪽은 예전 스냅샷을 들고 있다가 다음 저장 때
 * 그 수정을 통째로 되돌린다(나중에 쓴 쪽이 이긴다). `DbConnectionsProvider` 와 같은 이유다.
 *
 * **DB 와 달리 화면별 사본을 두지 않고 하나를 공유한다.** DB 는 접속이 *목록*이고
 * "화면마다 다른 접속을 붙여 둘 수 있어야 한다"가 명시된 요구였지만, ES 는 설정이
 * 딱 하나이고 id 도 없다. 사본을 주면 (1) 같은 값을 두 군데서 맞춰 줘야 하는 일이
 * 하나 늘고, (2) 방금 뷰어에서 맞춘 클러스터를 Cowork 패널이 왜 안 보고 있는지
 * 사용자가 알 방법이 없다.
 *
 * 공유해도 백엔드가 꼬이지 않는다: `es_request` 는 요청마다 접속 정보를 통째로 받는
 * **무상태** 명령이라 두 화면이 같은 클러스터를 동시에 봐도 서로 간섭하지 않는다
 * (`db_disconnect` 처럼 프로세스 전역 상태를 걷어 내는 짝이 아예 없다).
 */
export function EsConnProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useLocalStorage<EsStoredConn>(
    STORAGE_KEY,
    DEFAULT_ES_CONN
  )

  const value = useMemo<EsConn>(() => ({ conn, setConn }), [conn, setConn])

  return (
    <EsConnContext.Provider value={value}>{children}</EsConnContext.Provider>
  )
}

/**
 * ES 접속 정보. 프로바이더가 없으면 자기 몫의 `useLocalStorage` 로 물러난다.
 *
 * 기본값으로 물러나지 않는 이유: 접속 칸이 비어 보이면 저장해 둔 설정이 날아간 것처럼
 * 읽힌다. 다만 **그 대비책에 기대지 말 것** — 같은 창 안에서 이 훅을 두 번 부르면 두 벌이
 * 서로의 쓰기를 못 보고 갈라진다. 팝아웃 창(`ViewWindowRoot`)에도 프로바이더를 걸어 둔
 * 이유가 그것이다.
 */
export function useEsConn(): EsConn {
  const ctx = useContext(EsConnContext)
  const [conn, setConn] = useLocalStorage<EsStoredConn>(
    STORAGE_KEY,
    DEFAULT_ES_CONN
  )
  const fallback = useMemo<EsConn>(() => ({ conn, setConn }), [conn, setConn])
  return ctx ?? fallback
}
