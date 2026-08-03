import { useEffect, useMemo, useState } from "react"
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { useSettings } from "@/features/settings/settings-context"
import {
  useCoworkSpecs,
  type SearchHit,
  type SpecDir,
} from "./use-cowork-specs"
import { renderMarkdown } from "./markdown"
import { MarkdownViewer } from "./markdown-viewer"

/**
 * 검색어로 스펙 폴더/파일을 거른다. 폴더명이 맞으면 폴더 전체를, 아니면 **파일명 또는
 * 본문**(`contentHits` — 별도 Rust 검색 결과)이 맞는 파일만 남긴다.
 */
function filterSpecs(
  specs: SpecDir[],
  query: string,
  contentHits: Map<string, SearchHit>
): SpecDir[] {
  const q = query.trim().toLowerCase()
  if (!q) return specs
  return specs
    .map((dir) => {
      if (dir.name.toLowerCase().includes(q)) return dir
      const files = dir.files.filter(
        (f) => f.rel.toLowerCase().includes(q) || contentHits.has(f.path)
      )
      return files.length ? { ...dir, files } : null
    })
    .filter((d): d is SpecDir => d !== null)
}

/** 왼쪽 목록 패널 폭 — 기존 고정폭(`w-72` = 288px)이 기본값이다. */
const ASIDE_WIDTH_KEY = "myspace.coworkSpecAsideWidth"
const DEFAULT_ASIDE_WIDTH = 288
const MIN_ASIDE_WIDTH = 220
const MAX_ASIDE_WIDTH = 640

/** 탭으로 열린 문서 하나. */
interface OpenDoc {
  /** 절대 경로(고유 키). */
  path: string
  /** 탭에 표시할 짧은 이름(파일명). */
  title: string
  /** 어느 스펙 폴더의 문서인지 + 상대 경로(툴팁/브레드크럼용). */
  subtitle: string
}

/**
 * 문서 하나를 로드해 그리는 컴포넌트. 탭은 keep-alive 라서 이 컴포넌트는 마운트된 채
 * 남는다(탭을 다시 눌러도 재요청·재렌더 없이 이전 스크롤·mermaid 그대로 유지). 그래서
 * 파일 로드는 마운트 시 한 번만 하고, 활성 여부는 CSS(invisible)로만 토글한다.
 */
function SpecDocument({ path, active }: { path: string; active: boolean }) {
  const [html, setHtml] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const text = await trackedInvoke<string>("cowork_read_spec_file", {
          path,
        })
        if (!cancelled) setHtml(renderMarkdown(text))
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      aria-hidden={!active}
    >
      {error ? (
        <div className="p-5 text-[13px]">
          <div className="font-semibold text-ui-error">
            문서를 열 수 없습니다
          </div>
          <div className="mt-1 font-mono break-all text-muted-foreground">
            {error}
          </div>
        </div>
      ) : loading ? (
        <div className="p-5 text-[13px] text-muted-foreground">
          불러오는 중…
        </div>
      ) : (
        <MarkdownViewer html={html} />
      )}
    </div>
  )
}

/** Cowork spec 문서 뷰 — 왼쪽 목록(폴더 → 문서), 오른쪽 상단 탭으로 여러 문서 동시 열람. */
export function CoworkSpecView() {
  const { settings } = useSettings()
  const { home } = settings.cowork
  const { specs, loading, error, reload } = useCoworkSpecs(home)

  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openDocs, setOpenDocs] = useState<OpenDoc[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  // 본문 검색 결과(경로 → 히트). 파일명 검색과 달리 파일을 읽어야 하므로 Rust 에서
  // 처리하고 여기서는 디바운스해 호출한다.
  const [contentHits, setContentHits] = useState<Map<string, SearchHit>>(
    new Map()
  )
  const [contentBusy, setContentBusy] = useState(false)

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

  // 검색어가 바뀌면(2자 이상) 잠시 뒤 본문을 검색한다. 타이핑 중 매번 파일을 읽지 않도록
  // 220ms 디바운스한다.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || !isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setContentHits((prev) => (prev.size ? new Map() : prev))
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setContentBusy(true)
      void (async () => {
        try {
          const hits = await trackedInvoke<SearchHit[]>("cowork_search_specs", {
            home,
            query: q,
          })
          if (!cancelled) setContentHits(new Map(hits.map((h) => [h.path, h])))
        } catch {
          if (!cancelled) setContentHits(new Map())
        } finally {
          if (!cancelled) setContentBusy(false)
        }
      })()
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, home])

  const filtered = useMemo(
    () => filterSpecs(specs, query, contentHits),
    [specs, query, contentHits]
  )
  const searching = query.trim().length > 0

  const openDoc = (doc: OpenDoc) => {
    setOpenDocs((prev) =>
      prev.some((d) => d.path === doc.path) ? prev : [...prev, doc]
    )
    setActivePath(doc.path)
  }

  const closeDoc = (path: string) => {
    setOpenDocs((prev) => {
      const idx = prev.findIndex((d) => d.path === path)
      if (idx === -1) return prev
      const next = prev.filter((d) => d.path !== path)
      // 활성 탭을 닫으면 오른쪽 이웃(없으면 왼쪽)을 활성화한다.
      setActivePath((cur) => {
        if (cur !== path) return cur
        const neighbor = next[idx] ?? next[idx - 1] ?? null
        return neighbor ? neighbor.path : null
      })
      return next
    })
  }

  const toggleDir = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4">
      {/* 좌측: 스펙 목록 (폭 조절 가능) */}
      <div
        className="relative flex shrink-0 flex-col"
        style={{ width: asideWidth }}
      >
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="파일명·본문 검색"
              spellCheck={false}
              className="h-9 pl-8 text-[13px]"
            />
            {contentBusy && (
              <RotateCwIcon className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
          <Button
            size="icon"
            variant="outline"
            className="size-9 shrink-0 rounded-lg"
            onClick={() => void reload()}
            disabled={loading}
            aria-label="목록 새로고침"
          >
            <RotateCwIcon className={cn("size-4", loading && "animate-spin")} />
          </Button>
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <div className="rounded-[10px] border border-ui-warning bg-ui-warning/15 px-3 py-2.5 text-[13px]">
              <div className="font-semibold text-foreground">
                목록을 불러올 수 없습니다
              </div>
              <div className="mt-1 font-mono break-all text-muted-foreground">
                {error}
              </div>
              <div className="mt-1.5 text-muted-foreground">
                설정 → Cowork Spec 문서 에서 홈 경로를 확인하세요.
              </div>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-[13px] text-muted-foreground">
              {loading
                ? "불러오는 중…"
                : searching
                  ? contentBusy
                    ? "본문 검색 중…"
                    : "파일명·본문에서 검색 결과가 없습니다."
                  : "스펙 문서가 없습니다."}
            </div>
          ) : (
            <ul className="flex flex-col gap-px">
              {filtered.map((dir) => {
                const open = searching || expanded.has(dir.name)
                return (
                  <li key={dir.name}>
                    <button
                      type="button"
                      onClick={() => toggleDir(dir.name)}
                      className="flex h-9 w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-ui-list-hover"
                    >
                      {open ? (
                        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                        {dir.name}
                      </span>
                      <span className="shrink-0 text-[13px] text-muted-foreground">
                        {dir.files.length}
                      </span>
                    </button>
                    {open && (
                      <ul className="mb-0.5 flex flex-col gap-px">
                        {dir.files.map((f) => {
                          const isActive = activePath === f.path
                          const isOpen = openDocs.some((d) => d.path === f.path)
                          const hit = contentHits.get(f.path)
                          return (
                            <li key={f.path}>
                              <button
                                type="button"
                                onClick={() =>
                                  openDoc({
                                    path: f.path,
                                    title: f.name,
                                    subtitle: `${dir.name} / ${f.rel}`,
                                  })
                                }
                                title={f.rel}
                                className={cn(
                                  "flex min-h-9 w-full cursor-pointer items-start gap-1.5 rounded-lg py-1.5 pr-2 pl-7 text-left text-[13px] transition-colors",
                                  isActive
                                    ? "bg-ui-list-active font-semibold text-ui-list-active-fg"
                                    : "hover:bg-ui-list-hover"
                                )}
                              >
                                <FileTextIcon
                                  className={cn(
                                    "mt-0.5 size-3.5 shrink-0",
                                    isActive
                                      ? "opacity-90"
                                      : isOpen
                                        ? "text-ui-link opacity-90"
                                        : "opacity-70"
                                  )}
                                />
                                <span className="flex min-w-0 flex-1 flex-col">
                                  <span className="flex items-center gap-1.5">
                                    <span className="min-w-0 flex-1 truncate">
                                      {f.rel}
                                    </span>
                                    {hit && (
                                      <span
                                        className={cn(
                                          "shrink-0 rounded-full px-1.5 text-[11px] font-semibold",
                                          isActive
                                            ? "bg-ui-list-active-fg/20 text-ui-list-active-fg"
                                            : "bg-ui-list-hover text-muted-foreground"
                                        )}
                                        title={`본문 ${hit.count}회 일치`}
                                      >
                                        {hit.count}
                                      </span>
                                    )}
                                    {isOpen && !isActive && (
                                      <span className="size-1.5 shrink-0 rounded-full bg-ui-link" />
                                    )}
                                  </span>
                                  {hit && hit.snippet && (
                                    <span
                                      className={cn(
                                        "mt-0.5 truncate text-[12px] font-normal",
                                        isActive
                                          ? "text-ui-list-active-fg/75"
                                          : "text-muted-foreground"
                                      )}
                                    >
                                      {hit.snippet}
                                    </span>
                                  )}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <ResizeHandle
          resizing={resizing}
          onPointerDown={startResize}
          label="스펙 목록 폭 조절"
        />
      </div>

      {/* 우측: 탭 + 문서 뷰어 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        {openDocs.length > 0 ? (
          <>
            {/* 문서 탭 줄 — 넘치면 가로 스크롤. 활성 탭만 굵게 + 밑줄(Slack 방식). */}
            <div className="flex h-9 shrink-0 [scrollbar-width:none] items-stretch gap-1 overflow-x-auto border-b border-ui-tab-border px-2 [&::-webkit-scrollbar]:hidden">
              {openDocs.map((doc) => {
                const isActive = doc.path === activePath
                return (
                  <div
                    key={doc.path}
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActivePath(doc.path)}
                    onAuxClick={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        closeDoc(doc.path)
                      }
                    }}
                    title={doc.subtitle}
                    className={cn(
                      "group relative flex h-full max-w-[220px] min-w-[96px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-ui-list-hover",
                      isActive
                        ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                        : "text-ui-tab-inactive-fg hover:text-foreground"
                    )}
                  >
                    <FileTextIcon className="size-3.5 shrink-0" />
                    <span className="truncate">{doc.title}</span>
                    <button
                      type="button"
                      aria-label={`${doc.title} 탭 닫기`}
                      data-active={isActive}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeDoc(doc.path)
                      }}
                      className="ml-auto flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 transition-colors group-hover:opacity-100 hover:bg-ui-tab-border data-[active=true]:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                )
              })}
            </div>

            {/* 활성 문서 경로(브레드크럼) */}
            {activePath && (
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-1.5 text-[13px] text-muted-foreground">
                <FileTextIcon className="size-3.5 shrink-0" />
                <span className="truncate" title={activePath}>
                  {openDocs.find((d) => d.path === activePath)?.subtitle}
                </span>
              </div>
            )}

            {/* 문서들은 모두 마운트해 두고(keep-alive) 활성만 보여 준다. */}
            <div className="relative min-h-0 flex-1">
              {openDocs.map((doc) => (
                <SpecDocument
                  key={doc.path}
                  path={doc.path}
                  active={doc.path === activePath}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <FileTextIcon className="size-8 text-muted-foreground/50" />
            <div className="text-[15px] font-semibold">문서를 선택하세요</div>
            <p className="max-w-xs text-[13px] text-muted-foreground">
              왼쪽 목록에서 스펙 문서를 고르면 상단에 탭으로 열립니다. 여러
              문서를 동시에 열어 두고 오갈 수 있습니다.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
