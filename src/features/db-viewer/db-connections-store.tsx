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
import type { DbConnection } from "./connection"

const STORAGE_KEY = "myspace.dbConnections"

export interface DbConnections {
  connections: DbConnection[]
  setConnections: Dispatch<SetStateAction<DbConnection[]>>
}

const DbConnectionsContext = createContext<DbConnections | null>(null)

/**
 * 저장된 DB 접속 목록을 창 전체에 하나로 공급한다.
 *
 * 목록을 각 화면에서 `useLocalStorage` 로 따로 읽으면 안 된다 — **같은 창 안의**
 * `useLocalStorage` 끼리는 서로의 변경을 통보받지 못하고(`storage` 이벤트는 다른 창에서만
 * 온다), 탭은 keep-alive 라 데이터베이스 뷰어와 IntelliJ Cowork 이 동시에 마운트된 채로
 * 살아 있다. 그러면 한쪽에서 접속을 추가해도 다른 쪽은 예전 배열을 들고 있다가 다음
 * 저장 때 그 추가를 통째로 덮어쓴다(나중에 쓴 쪽이 이긴다). 레일 고정 목록
 * (`pinned-menus-store`)이 컨텍스트인 것과 같은 이유다.
 *
 * **선택된 접속(`myspace.dbActiveConn`)은 여기 없다.** 그건 화면마다 다른 값이어야
 * 한다 — 뷰어에서 운영 DB 를 보는 동안 IntelliJ Cowork 에서는 로컬 DB 를 붙여 둘 수 있어야
 * 하고, 그 둘을 묶으면 한쪽에서 접속을 고르는 순간 다른 쪽 연결이 끊긴다.
 */
export function DbConnectionsProvider({ children }: { children: ReactNode }) {
  const [connections, setConnections] = useLocalStorage<DbConnection[]>(
    STORAGE_KEY,
    []
  )

  const value = useMemo<DbConnections>(
    () => ({ connections, setConnections }),
    [connections, setConnections]
  )

  return (
    <DbConnectionsContext.Provider value={value}>
      {children}
    </DbConnectionsContext.Provider>
  )
}

/**
 * 접속 목록. 프로바이더가 없으면 자기 몫의 `useLocalStorage` 로 물러난다.
 *
 * 빈 배열로 물러나지 않는 이유: 목록이 비어 보이면 저장해 둔 접속이 사라진 것처럼
 * 읽히기 때문이다. 다만 **그 대비책에 기대지 말 것** — 같은 창 안에서 이 훅을 두 번
 * 부르면(예: IntelliJ Cowork 의 루트 + 접속 관리 레이어) 두 벌이 서로의 쓰기를 못 보고
 * 갈라진다. 팝아웃 창(`ViewWindowRoot`)도 "화면이 하나뿐"이라는 이유로 프로바이더를
 * 생략했다가 정확히 그 문제를 겪었고, 지금은 거기에도 프로바이더가 걸려 있다.
 */
export function useDbConnections(): DbConnections {
  const ctx = useContext(DbConnectionsContext)
  const [connections, setConnections] = useLocalStorage<DbConnection[]>(
    STORAGE_KEY,
    []
  )
  const fallback = useMemo<DbConnections>(
    () => ({ connections, setConnections }),
    [connections, setConnections]
  )
  return ctx ?? fallback
}
