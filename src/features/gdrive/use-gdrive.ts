import { useCallback, useEffect, useRef, useState } from "react"

import { trackedInvoke } from "@/lib/tauri"
import { useTabActive } from "@/lib/use-tab-active"

export interface GdriveStatus {
  connected: boolean
  email: string | null
  /** 저장된 OAuth 클라이언트 ID(재연결 폼 자동 채움). 없으면 null. */
  client_id: string | null
  /** 보안 비밀이 저장돼 있는지. 값 자체는 Rust 밖으로 나오지 않는다. */
  has_secret: boolean
}

/** 연결이 전혀 없는 상태(상태 조회 실패 시의 안전한 기본값). */
const DISCONNECTED: GdriveStatus = {
  connected: false,
  email: null,
  client_id: null,
  has_secret: false,
}

/**
 * 좌측 트리에서 고를 수 있는 위치. `folder` 만 id 를 갖고, 나머지는 고정 뷰다.
 * Rust 의 `gdrive_list(kind, id, driveId)` 인자와 그대로 1:1 로 대응한다.
 */
export type DriveNodeKind =
  | "home"
  | "my-drive"
  | "shared-drives"
  | "shared-with-me"
  | "recent"
  | "starred"
  | "folder"

export interface DriveNode {
  kind: DriveNodeKind
  /** folder 일 때의 폴더 id(공유 드라이브 루트는 드라이브 id 와 같다). */
  id?: string
  /** folder 일 때 트리·브레드크럼에 쓰는 이름. */
  name?: string
}

/** 노드 하나를 가리키는 안정적인 키(선택 표시·펼침 상태·자식 캐시의 키). */
export function nodeKey(node: DriveNode): string {
  return node.id ? `${node.kind}:${node.id}` : node.kind
}

/** 하위 폴더를 가질 수 있는 노드 — 나머지는 트리에서 잎이다. */
const EXPANDABLE = new Set<DriveNodeKind>([
  "my-drive",
  "shared-drives",
  "folder",
])

export interface DriveFile {
  id: string
  name: string
  mime_type: string
  /** 웹(Chrome)에서 파일을 여는 링크. */
  web_view_link: string | null
  /** 구글이 제공하는 파일 유형 아이콘 URL. */
  icon_link: string | null
  /** 다른 사람이 최근 수정했으면 그 사람 이름. null 이면 "내가 열어본 항목". */
  reason_modified_by: string | null
  /** 추천 이유에 표시할 시각(RFC3339). */
  reason_time: string | null
  /** 소유자 이름(owner_me 면 "나"). null 이면 "—". */
  owner_name: string | null
  owner_me: boolean
  owner_photo: string | null
  /** 위치(부모 폴더명 / "내 드라이브" / "공유 문서함"). */
  location: string | null
  /** 마지막 수정 시각(RFC3339) — 폴더 탐색 목록의 날짜 컬럼. */
  modified_time: string | null
  /** 바이트 크기. 폴더/구글 문서는 null. */
  size: number | null
  /** 폴더면 열지 않고 그 안으로 들어간다. */
  is_folder: boolean
  /** 속한 공유 드라이브 id(내 드라이브 항목이면 null). */
  drive_id: string | null
}

interface DriveFilePage {
  files: DriveFile[]
  next_page_token: string | null
}

interface DriveFolderDto {
  id: string
  name: string
}

/** 최근 파일 자동 새로고침 주기(5분). */
const POLL_MS = 300_000

/**
 * Google 드라이브 연결 상태만 관리한다(연결/해제는 설정 화면에서 한다).
 * client_id/secret·토큰은 Rust(파일)에 저장되므로 여기서는 명령만 호출한다.
 */
export function useGdriveConnection() {
  const [status, setStatus] = useState<GdriveStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(
    async (clientId: string, clientSecret: string) => {
      setError(null)
      try {
        // 브라우저 로그인 완료까지 대기(최대 3분) — 완료되면 상태가 채워진다.
        // 빈 문자열을 넘기면 Rust 가 저장된 클라이언트 정보를 쓴다.
        setStatus(
          await trackedInvoke<GdriveStatus>("gdrive_start_auth", {
            clientId,
            clientSecret,
          })
        )
      } catch (e) {
        setError(String(e))
      }
    },
    []
  )

  const disconnect = useCallback(async (forgetClient = false) => {
    // 해제 후 상태는 Rust 가 돌려준다 — 클라이언트 정보가 남았는지 여기서 추측하지 않는다.
    setStatus(
      await trackedInvoke<GdriveStatus>("gdrive_disconnect", { forgetClient })
    )
    setError(null)
  }, [])

  // 최초 1회 연동 상태 확인.
  useEffect(() => {
    let cancelled = false
    trackedInvoke<GdriveStatus>("gdrive_status")
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus(DISCONNECTED)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { status, error, connect, disconnect }
}

/**
 * 선택한 노드의 파일 목록. `home` 은 추천 파일(gdrive_recent), 나머지는 gdrive_list 로
 * 간다 — 호출만 다르고 결과 모양이 같아 화면에서는 한 갈래로 다룬다.
 * "더보기"(loadMore)로 다음 페이지를 이어 붙인다.
 */
export function useDriveFiles(node: DriveNode, connected: boolean) {
  const tabActive = useTabActive()
  const [files, setFiles] = useState<DriveFile[]>([])
  const [nextToken, setNextToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)

  const { kind, id } = node
  const fetchPage = useCallback(
    (pageToken: string | null) =>
      kind === "home"
        ? trackedInvoke<DriveFilePage>("gdrive_recent", { pageToken })
        : trackedInvoke<DriveFilePage>("gdrive_list", {
            kind,
            id: id ?? null,
            pageToken,
          }),
    [kind, id]
  )

  // 첫 페이지 로드(또는 새로고침) — 목록을 처음부터 다시 채운다.
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await fetchPage(null)
      setFiles(page.files)
      setNextToken(page.next_page_token)
      setUpdatedAt(Date.now())
    } catch (e) {
      setFiles([])
      setNextToken(null)
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [fetchPage])

  // 다음 페이지를 이어 붙인다("더보기").
  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const page = await fetchPage(nextToken)
      setFiles((prev) => [...prev, ...page.files])
      setNextToken(page.next_page_token)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, nextToken, loadingMore])

  // 연결이 확인되면, 그리고 고른 노드가 바뀔 때마다 목록을 다시 불러온다
  // (refresh 는 fetchPage → 노드 식별자에 묶여 있다).
  // 이 effect 는 노드가 바뀔 때만 돈다(refresh 가 노드 식별자에만 묶여 있으므로) — 그래서
  // 여기서 목록을 비워도 5분 주기 새로고침은 화면을 깜빡이지 않는다. 비우지 않으면 새 위치의
  // 브레드크럼 아래에 직전 위치의 파일이 잠깐 남는다.
  useEffect(() => {
    if (!connected) return
    // 노드 진입 직후 첫 로드(데이터 페칭 목적의 의도된 패턴).
    /* eslint-disable react-hooks/set-state-in-effect */
    setFiles([])
    setNextToken(null)
    void refresh()
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [connected, refresh])

  // 주기 새로고침은 이 탭이 보일 때, 그리고 홈(추천 파일)에서만 돈다. 숨은 탭은 마지막으로
  // 받은 목록을 그대로 들고 있고, 다시 들어와도 재조회하지 않는다(첫 로드 effect 와
  // 분리해 둔 이유). 폴더 목록은 사용자가 새로고침을 누를 때만 갱신한다.
  useEffect(() => {
    if (!connected || !tabActive || kind !== "home") return
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(timer)
  }, [connected, tabActive, kind, refresh])

  return {
    files,
    loading,
    loadingMore,
    hasMore: nextToken !== null,
    error,
    updatedAt,
    refresh,
    loadMore,
  }
}

/**
 * 좌측 트리의 펼침 상태 + 하위 폴더 캐시. 펼칠 때 한 번만 조회하고(`loadedRef`),
 * 이후에는 캐시를 쓴다 — 목록에서 폴더로 들어갈 때도 같은 캐시를 채운다.
 */
export function useDriveTree(connected: boolean) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, DriveNode[]>>({})
  // 조회에 실패한 노드 → 오류 메시지. 빈 폴더("하위 폴더 없음")와 반드시 구분해야 한다.
  // 실패를 빈 배열로 뭉개면 API 오류가 "폴더가 비었다"로 보여 원인을 못 찾는다.
  const [failed, setFailed] = useState<Record<string, string>>({})
  // 이미 조회한(또는 조회 중인) 키 — 같은 노드를 두 번 열어도 요청은 한 번이다.
  const loadedRef = useRef<Set<string>>(new Set())

  const load = useCallback(
    async (node: DriveNode) => {
      // 잎 노드(홈·최근 문서함 등)에는 하위 폴더 개념이 없다.
      if (!EXPANDABLE.has(node.kind)) return
      const key = nodeKey(node)
      // 연결 전이면 조회할 수 없다 — loadedRef 에 넣지 않으므로 연결 후 다시 펼치면 시도한다.
      if (!connected || loadedRef.current.has(key)) return
      loadedRef.current.add(key)
      setFailed((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
      try {
        // 공유 드라이브 노드는 폴더가 아니라 드라이브 목록을 자식으로 갖는다.
        const parentId =
          node.kind === "shared-drives"
            ? "shared-drives"
            : node.kind === "my-drive"
              ? "root"
              : (node.id ?? "root")
        const folders = await trackedInvoke<DriveFolderDto[]>(
          "gdrive_folders",
          { parentId }
        )
        setChildren((prev) => ({
          ...prev,
          [key]: folders.map((f) => ({
            kind: "folder" as const,
            id: f.id,
            name: f.name,
          })),
        }))
      } catch (e) {
        // 다시 펼치면 재시도할 수 있게 캐시 표시를 지우고, 오류를 그대로 보여 준다.
        loadedRef.current.delete(key)
        setFailed((prev) => ({ ...prev, [key]: String(e) }))
      }
    },
    [connected]
  )

  const toggle = useCallback(
    (node: DriveNode) => {
      const key = nodeKey(node)
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
      void load(node)
    },
    [load]
  )

  /** 목록에서 폴더로 들어갈 때 — 지나온 조상들을 모두 펼쳐 트리와 위치를 맞춘다. */
  const reveal = useCallback(
    (path: DriveNode[]) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        for (const n of path) next.add(nodeKey(n))
        return next
      })
      for (const n of path) void load(n)
    },
    [load]
  )

  /** 실패한 노드 다시 시도(오류 줄 클릭). */
  const retry = useCallback((node: DriveNode) => void load(node), [load])

  return { expanded, children, failed, toggle, reveal, retry }
}
