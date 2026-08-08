import { useCallback, useEffect, useRef, useState } from "react"
import { PlugIcon, RotateCwIcon, SearchIcon, XIcon } from "lucide-react"

import { ElasticsearchBrandIcon } from "@/components/brand-icons"
import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { cn } from "@/lib/utils"
import { EsClient, EsError, type IndexRow } from "./es-client"
import { useEsConn, type EsStoredConn } from "./es-conn-store"
import { fmtNum, HEALTH_COLOR, sortIndices } from "./es-utils"
import { getIndexFilter, purgeIndex, setIndexFilter } from "./persisted"
import { IndexPane } from "./index-pane"

/** 왼쪽 패널 폭(px) — 인덱스 이름이 길면 넓혀 볼 수 있게 드래그로 조절한다. */
const ASIDE_WIDTH_KEY = "myspace.esAsideWidth"
const DEFAULT_ASIDE_WIDTH = 288
const MIN_ASIDE_WIDTH = 220
const MAX_ASIDE_WIDTH = 640

/**
 * Elasticsearch 뷰어 — 크롬 확장(cowork-es-viewer)의 기능을 My Space 스타일로 옮긴 것.
 * 왼쪽: 연결 정보 + 인덱스 목록. 오른쪽: 인덱스 탭(keep-alive)과 조회/검색 화면.
 * 실제 HTTP 는 Rust(`es_request`)가 대신 보내 CORS 를 우회한다.
 *
 * ⚠️ 이 화면은 `scope` 없이 `persisted.ts` 를 부른다 = 접두사 없는 기본 칸이 이 화면의
 * 몫이다. 두 번째 화면(IntelliJ Cowork)은 자기 접두사를 넘겨 자기 칸을 쓴다. 접속 정보만은
 * `useEsConn()` 으로 **공유**한다 — 설정이 하나뿐이라 사본을 두면 어느 클러스터를 보고
 * 있는지 화면마다 달라진다(`es-conn-store.tsx` 주석 참고).
 */
export function EsViewerView() {
  const { conn, setConn } = useEsConn()
  const [openTabs, setOpenTabs] = useLocalStorage<string[]>(
    "myspace.esTabs",
    []
  )
  const [activeTab, setActiveTab] = useLocalStorage<string | null>(
    "myspace.esActive",
    null
  )

  const [client, setClient] = useState<EsClient | null>(null)
  const [connSeq, setConnSeq] = useState(0)
  const [cluster, setCluster] = useState<string | null>(null)
  const [indices, setIndices] = useState<IndexRow[]>([])
  const [filter, setFilter] = useState(() => getIndexFilter())
  const [connecting, setConnecting] = useState(false)
  const [connError, setConnError] = useState<string | null>(null)
  const autoTried = useRef(false)

  const {
    width: asideWidth,
    resizing,
    startResize,
  } = useResizableWidth(
    ASIDE_WIDTH_KEY,
    DEFAULT_ASIDE_WIDTH,
    MIN_ASIDE_WIDTH,
    MAX_ASIDE_WIDTH
  )

  const reloadIndices = useCallback(async (c: EsClient) => {
    try {
      const list = await c.indices()
      setIndices(sortIndices(list))
    } catch {
      // 목록 갱신 실패는 조용히 무시(연결 자체는 유지)
    }
  }, [])

  const connect = useCallback(
    async (cfg: EsStoredConn) => {
      if (!cfg.host.trim()) {
        setConnError("호스트를 입력하세요.")
        return
      }
      setConnecting(true)
      setConnError(null)
      const c = new EsClient(cfg)
      try {
        const info = await c.info()
        const list = sortIndices(await c.indices())
        setClient(c)
        setConnSeq((s) => s + 1)
        setCluster(
          `${info.cluster_name ?? "unknown"} · v${info.version?.number ?? "?"}`
        )
        setIndices(list)

        // 저장된 탭 중 존재하는 인덱스만 복원. localStorage 를 직접 읽어
        // 재연결 시 stale closure 를 피한다(useLocalStorage 와 같은 키).
        //
        // ⚠️ 이 블록은 `myspace.esTabs` 를 직접 **읽고 그대로 다시 쓴다**(`setOpenTabs`).
        // 그래서 다른 화면이 자기 탭 모델을 이 키에 얹으면 여기서 [연결]을 누를 때마다
        // 이 화면 기준으로 걸러진 목록으로 덮인다 — 그쪽 탭이 이유 없이 닫힌 것처럼
        // 보인다. 두 번째 화면은 반드시 자기 키를 쓸 것(연결 정보와 달리 탭 목록은
        // 화면마다 다른 값이라 공유할 대상도 아니다).
        const existing = new Set(list.map((i) => i.index))
        let savedTabs: string[] = []
        try {
          savedTabs = JSON.parse(localStorage.getItem("myspace.esTabs") ?? "[]")
        } catch {
          savedTabs = []
        }
        const restored = savedTabs.filter((t) => existing.has(t))
        setOpenTabs(restored)
        if (restored.length) {
          setActiveTab((prev) =>
            prev && restored.includes(prev) ? prev : restored[0]
          )
        } else {
          setActiveTab(null)
        }
      } catch (e) {
        setClient(null)
        setCluster(null)
        setIndices([])
        setConnError(
          e instanceof EsError ? `${e.message}\n${e.detail}` : String(e)
        )
      } finally {
        setConnecting(false)
      }
    },
    // openTabs 는 연결 시점 스냅샷만 필요하므로 의존성에서 제외.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // 자동 연결(한 번만).
  useEffect(() => {
    if (autoTried.current) return
    autoTried.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (conn.autoConnect && conn.host.trim()) void connect(conn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openIndex = (index: string) => {
    setOpenTabs((prev) => (prev.includes(index) ? prev : [...prev, index]))
    setActiveTab(index)
  }

  const closeTab = (index: string) => {
    setOpenTabs((prev) => {
      const pos = prev.indexOf(index)
      const next = prev.filter((t) => t !== index)
      setActiveTab((cur) =>
        cur === index ? (next[Math.min(pos, next.length - 1)] ?? null) : cur
      )
      return next
    })
  }

  const onDeleted = (index: string) => {
    purgeIndex(index)
    closeTab(index)
    if (client) void reloadIndices(client)
  }

  const patchConn = (patch: Partial<EsStoredConn>) =>
    setConn({ ...conn, ...patch })

  const filtered = indices.filter(
    (i) =>
      !filter.trim() ||
      i.index.toLowerCase().includes(filter.trim().toLowerCase())
  )

  return (
    <div className="flex h-full gap-3">
      {/* ── 왼쪽: 연결 + 인덱스 목록 (폭 조절 가능) ── */}
      <aside
        className="relative flex shrink-0 flex-col gap-3"
        style={{ width: asideWidth }}
      >
        {/* 연결 정보 */}
        <div className="rounded-[10px] border border-border bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="mb-2 flex items-center gap-2">
            <ElasticsearchBrandIcon className="size-4" />
            <span className="text-[15px] font-bold">연결 정보</span>
          </div>
          <div className="flex flex-col gap-2">
            <Input
              value={conn.host}
              placeholder="호스트 (예: 172.16.120.191)"
              onChange={(e) => patchConn({ host: e.target.value })}
            />
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={conn.port ?? ""}
                placeholder="포트"
                onChange={(e) =>
                  patchConn({
                    port: e.target.value ? parseInt(e.target.value, 10) : null,
                  })
                }
                className="w-24"
              />
              <label className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={conn.https}
                  onChange={(e) => patchConn({ https: e.target.checked })}
                />
                HTTPS
              </label>
            </div>
            <Input
              value={conn.username}
              placeholder="아이디 (선택)"
              onChange={(e) => patchConn({ username: e.target.value })}
            />
            <Input
              type="password"
              value={conn.password}
              placeholder="비밀번호 (선택)"
              onChange={(e) => patchConn({ password: e.target.value })}
            />
            <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <input
                type="checkbox"
                checked={conn.autoConnect}
                onChange={(e) => patchConn({ autoConnect: e.target.checked })}
              />
              자동 연결 (다음 실행 시 자동 접속)
            </label>
            <Button
              size="sm"
              disabled={connecting}
              onClick={() => void connect(conn)}
            >
              <PlugIcon />
              {connecting ? "연결 중…" : client ? "재연결" : "연결"}
            </Button>
            {cluster && (
              <div className="rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[13px] text-ui-success">
                ✓ 연결됨 · {cluster}
              </div>
            )}
            {connError && (
              <div className="rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
                {connError}
              </div>
            )}
          </div>
        </div>

        {/* 인덱스 목록 */}
        <div className="flex min-h-0 flex-1 flex-col rounded-[10px] border border-border bg-card p-3 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[15px] font-bold">인덱스</span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!client}
              onClick={() => client && void reloadIndices(client)}
              title="새로고침"
            >
              <RotateCwIcon />
            </Button>
          </div>
          <div className="relative mb-2">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filter}
              placeholder="인덱스 검색…"
              disabled={!client}
              onChange={(e) => {
                setFilter(e.target.value)
                setIndexFilter(e.target.value)
              }}
              className="pl-8"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!client ? (
              <p className="px-1 py-2 text-[13px] text-muted-foreground">
                연결 후 인덱스가 표시됩니다.
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-1 py-2 text-[13px] text-muted-foreground">
                표시할 인덱스가 없습니다.
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((idx) => (
                  <li key={idx.index}>
                    <button
                      onClick={() => openIndex(idx.index)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors",
                        idx.index === activeTab
                          ? "bg-ui-selection font-bold text-ui-selection-fg"
                          : "hover:bg-ui-list-hover"
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          HEALTH_COLOR[idx.health ?? "green"] ??
                            "bg-muted-foreground"
                        )}
                      />
                      <span className="flex-1 truncate" title={idx.index}>
                        {idx.index}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[11px]",
                          idx.index === activeTab
                            ? "text-ui-selection-fg/80"
                            : "text-muted-foreground"
                        )}
                      >
                        {fmtNum(idx["docs.count"])}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <ResizeHandle
          resizing={resizing}
          onPointerDown={startResize}
          label="인덱스 목록 폭 조절"
        />
      </aside>

      {/* ── 오른쪽: 탭 + 조회 화면 ── */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {openTabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <span className="flex size-12 items-center justify-center rounded-[10px] bg-muted">
              <ElasticsearchBrandIcon className="size-6" />
            </span>
            <p className="text-[15px] font-bold">
              {client ? "인덱스를 선택하세요" : "Elasticsearch에 연결하세요"}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {client
                ? "왼쪽 목록에서 인덱스를 선택하면 탭으로 열립니다."
                : "왼쪽에서 연결 정보를 입력하고 연결하세요."}
            </p>
          </div>
        ) : (
          <>
            {/* 인덱스 탭 스트립 */}
            <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border">
              {openTabs.map((idx) => (
                <div
                  key={idx}
                  onClick={() => setActiveTab(idx)}
                  title={idx}
                  className={cn(
                    "group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 text-[13px]",
                    idx === activeTab
                      ? "bg-card font-bold"
                      : "bg-muted/30 text-muted-foreground hover:bg-ui-list-hover"
                  )}
                >
                  <span className="max-w-40 truncate">{idx}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(idx)
                    }}
                    className="flex size-4 items-center justify-center rounded opacity-50 hover:bg-ui-list-hover hover:opacity-100"
                    title="탭 닫기"
                  >
                    <XIcon className="size-3" />
                  </button>
                </div>
              ))}
            </div>

            {/* keep-alive 패널: 활성 탭만 보이고 나머지는 invisible 로 남는다. */}
            <div className="relative min-h-0 flex-1">
              {client &&
                openTabs.map((idx) => (
                  <IndexPane
                    key={`${connSeq}:${idx}`}
                    index={idx}
                    client={client}
                    meta={indices.find((i) => i.index === idx)}
                    active={idx === activeTab}
                    onDeleted={onDeleted}
                    onDocsChanged={() => client && void reloadIndices(client)}
                  />
                ))}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
