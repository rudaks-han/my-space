import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react"
import {
  BookOpenTextIcon,
  ClipboardPasteIcon,
  Columns2Icon,
  FolderOpenIcon,
  RotateCwIcon,
  UploadIcon,
  XIcon,
} from "lucide-react"

import { ResizeHandle } from "@/components/resize-handle"
import { Button } from "@/components/ui/button"
import { useTabActive } from "@/lib/use-tab-active"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableWidth } from "@/lib/use-resizable-width"
// 파서와 뷰어는 Cowork Spec 문서와 같은 것을 쓴다 — 요구가 "같은 Typora 스타일"이라
// 복제하면 두 화면이 조금씩 어긋난다. 스타일도 뷰어가 번들 테마를 주입하므로 두 화면이
// 언제나 같은 모양이다.
import { renderMarkdown } from "@/features/cowork-spec/markdown"
import { MarkdownViewer } from "@/features/cowork-spec/markdown-viewer"
import { MARKDOWN_EXTS, useMarkdownDoc } from "./use-markdown-doc"
import { useFileDrop } from "./use-file-drop"

const EXT_HINT = MARKDOWN_EXTS.map((e) => `.${e}`).join(" · ")

/**
 * 원문 패널의 폭(px). 나머지는 미리보기가 쓴다.
 *
 * 비율(%) 이 아니라 px 인 이유는 폭 조절 손잡이가 포인터 이동량을 그대로 더하기
 * 때문이다(`useResizableWidth`). 기본값 420px 은 예전 고정 38% 와 비슷한 자리다.
 */
const SOURCE_WIDTH_KEY = "myspace.markdownViewer.sourceWidth"
const DEFAULT_SOURCE_WIDTH = 420
const MIN_SOURCE_WIDTH = 240
const MAX_SOURCE_WIDTH = 900

/** 문서가 없을 때의 안내 — 그대로 드롭 영역이기도 하다. */
function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-[10px] bg-muted">
        <BookOpenTextIcon className="size-6 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[15px] font-bold">마크다운을 열어 보세요</p>
        <p className="max-w-md text-[13px] text-muted-foreground">
          파일을 이 화면에 끌어다 놓거나, 마크다운 원문을 복사해 붙여넣으세요
          (⌘V). Cowork Spec 문서와 같은 Typora 스타일로 표시됩니다.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onPick}>
        <FolderOpenIcon />
        파일 열기
      </Button>
      <p className="text-[13px] text-muted-foreground">{EXT_HINT}</p>
    </div>
  )
}

/**
 * 마크다운 뷰어 — 파일 열기 · 드래그앤드롭 · 붙여넣기 셋 중 아무 방법으로나 문서 하나를
 * 띄워 Typora 스타일로 읽는다.
 *
 * Cowork Spec 문서 뷰와 나눠 둔 이유는 대상이 다르기 때문이다: 저쪽은 `.cowork/specs`
 * 아래를 목록으로 훑는 전용 화면이고, 여기는 위치를 가리지 않는 파일 한 개짜리 뷰어다.
 * 렌더링·스타일은 같은 모듈을 쓴다.
 */
export function MarkdownViewerView() {
  const tabActive = useTabActive()
  const {
    doc,
    docId,
    error,
    loading,
    dirty,
    pickFile,
    openDropped,
    pasteFrom,
    setSource,
    reload,
    clear,
    dismissError,
  } = useMarkdownDoc()

  const [showSource, setShowSource] = useLocalStorage(
    "myspace.markdownViewer.showSource",
    false
  )
  const {
    width: sourceWidth,
    resizing,
    startResize,
  } = useResizableWidth(
    SOURCE_WIDTH_KEY,
    DEFAULT_SOURCE_WIDTH,
    MIN_SOURCE_WIDTH,
    MAX_SOURCE_WIDTH
  )
  const zoneRef = useRef<HTMLDivElement>(null)
  // 드롭 핸들러는 고정해 둔다 — 매 렌더 새 함수를 넘기면 네이티브 리스너가 다시 붙는다.
  const onDrop = useCallback(
    (paths: string[]) => void openDropped(paths),
    [openDropped]
  )
  const hovering = useFileDrop({ enabled: tabActive, zoneRef, onDrop })

  // 화면 어디에 포커스가 있든 ⌘V 로 붙여넣을 수 있게 창 단위로 듣는다. 단 입력 요소
  // (원문 패널의 textarea 등) 안에서의 붙여넣기는 그쪽 기본 동작에 맡긴다.
  useEffect(() => {
    if (!tabActive) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return
      }
      if (!e.clipboardData) return
      e.preventDefault()
      void pasteFrom(e.clipboardData)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [tabActive, pasteFrom])

  // 원문 패널에서 타이핑하는 동안 매 글자마다 전체를 다시 파싱하지 않도록 한 박자 미룬다.
  const deferredSource = useDeferredValue(doc?.source ?? "")
  const html = useMemo(
    () => (deferredSource ? renderMarkdown(deferredSource) : ""),
    [deferredSource]
  )

  return (
    <div ref={zoneRef} className="relative flex h-full min-h-0 flex-col gap-3">
      {/* 툴바 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void pickFile()}>
          <FolderOpenIcon />
          파일 열기
        </Button>
        {doc?.path && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void reload()}
            title="디스크에서 다시 읽기"
          >
            <RotateCwIcon />
            다시 읽기
          </Button>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {doc && (
            <>
              <span className="truncate text-[15px] font-bold">{doc.name}</span>
              {dirty && (
                <span className="shrink-0 rounded-full bg-ui-warning/15 px-2 text-[11px] font-bold text-ui-warning">
                  수정됨
                </span>
              )}
              {doc.path && (
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground"
                  title={doc.path}
                >
                  {doc.path}
                </span>
              )}
              {loading && (
                <span className="shrink-0 text-[13px] text-muted-foreground">
                  불러오는 중…
                </span>
              )}
            </>
          )}
        </div>

        {doc && (
          <>
            <Button
              size="sm"
              variant={showSource ? "secondary" : "ghost"}
              onClick={() => setShowSource((v) => !v)}
              title="원문 패널 열기/닫기"
            >
              <Columns2Icon />
              원문
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={clear}
              aria-label="문서 닫기"
              title="문서 닫기"
            >
              <XIcon />
            </Button>
          </>
        )}
      </div>

      {/* 에러 배너 */}
      {error && (
        <div className="flex shrink-0 items-start gap-2 rounded-[10px] border border-ui-error/30 bg-ui-error/5 px-3 py-2 text-[13px] text-ui-error">
          <span className="min-w-0 flex-1 break-all">{error}</span>
          <button
            type="button"
            onClick={dismissError}
            aria-label="오류 닫기"
            className="shrink-0 cursor-pointer rounded-full p-0.5 hover:bg-ui-error/10"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      )}

      {/* 본문 — 원문 패널(선택) + 미리보기 */}
      <div className="flex min-h-0 flex-1 gap-3">
        {doc && showSource && (
          // 손잡이는 카드 **밖**(패널과 미리보기 사이 간격)에 뜨므로, 모서리를 자르는
          // `overflow-hidden` 이 걸린 카드에 직접 붙이면 통째로 잘려 잡히지 않는다.
          // 그래서 폭은 이 래퍼가 갖고 카드는 그 안을 채운다.
          <div
            className="relative flex shrink-0"
            style={{ width: sourceWidth }}
          >
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
              <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-4 py-2 text-[13px] text-muted-foreground">
                <ClipboardPasteIcon className="size-3.5" />
                <span>원문 — 여기에 붙여넣거나 고치면 오른쪽에 바로 반영</span>
              </div>
              <textarea
                value={doc.source}
                onChange={(e) => setSource(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-[13px] leading-relaxed outline-none"
              />
            </div>
            <ResizeHandle
              resizing={resizing}
              onPointerDown={startResize}
              label="원문 패널 폭 조절"
            />
          </div>
        )}

        <div className="flex min-w-0 flex-1 overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          {doc ? (
            <MarkdownViewer
              html={html}
              // 원문을 고치는 동안에는 스크롤을 붙잡아 둔다(문서를 바꿀 때만 맨 위로).
              scrollResetKey={String(docId)}
            />
          ) : (
            <EmptyState onPick={() => void pickFile()} />
          )}
        </div>
      </div>

      {/* 드롭 강조 — 파일이 이 뷰 위에 있을 때만. */}
      {hovering && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[10px] border-2 border-dashed border-ui-link bg-ui-link/10 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-full bg-card px-4 py-2 text-[15px] font-bold shadow-[0_4px_16px_rgba(0,0,0,0.16)]">
            <UploadIcon className="size-4 text-ui-link" />
            여기에 놓으면 마크다운으로 엽니다
          </div>
        </div>
      )}
    </div>
  )
}
