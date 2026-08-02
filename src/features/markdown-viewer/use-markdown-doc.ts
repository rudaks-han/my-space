import { useCallback, useEffect, useState } from "react"
import { open as openFileDialog } from "@tauri-apps/plugin-dialog"

import { isTauri, trackedInvoke } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"

/** 열 수 있는 확장자 — Rust 의 `markdown.rs` EXTS 와 같아야 한다. */
export const MARKDOWN_EXTS = ["md", "markdown", "mdx", "mdown", "mkd", "txt"]

const EXT_RE = new RegExp(`\\.(${MARKDOWN_EXTS.join("|")})$`, "i")

/** Rust `markdown_read_file` 의 반환값. */
interface MarkdownFile {
  name: string
  path: string
  text: string
}

/** 지금 보고 있는 문서. */
export interface MarkdownDoc {
  /** 화면에 그리는 원문(원문 패널에서 고칠 수 있다). */
  source: string
  /** 파일에서 읽은 그대로의 원문 — "수정됨" 판정과 되돌리기에 쓴다. */
  original: string
  /** 제목에 쓸 이름(파일명, 또는 붙여넣기 문서라는 표시). */
  name: string
  /** 파일에서 열었으면 절대 경로, 붙여넣기·직접 입력이면 null. */
  path: string | null
}

/** 마지막으로 연 파일 경로. 앱을 다시 켰을 때 그 문서로 되돌아가기 위해 저장한다. */
const LAST_PATH_KEY = "myspace.markdownViewer.lastPath"

/** 붙여넣은 텍스트가 "파일 경로 한 줄"로 보이는지(파인더에서 파일을 복사하면 이렇게 온다). */
function pathFromText(text: string): string | null {
  const s = text.trim()
  if (!s || s.includes("\n") || s.length > 1024) return null
  const p = s.startsWith("file://")
    ? decodeURIComponent(s.slice("file://".length))
    : s
  if (!p.startsWith("/") && !p.startsWith("~/")) return null
  return EXT_RE.test(p) ? p : null
}

/**
 * 마크다운 문서 하나를 여는 상태 묶음. 여는 경로가 셋(파일 선택 창 · 드래그앤드롭 ·
 * 붙여넣기)이고 셋 다 결국 "원문 문자열 하나"로 수렴하므로 여기 모아 둔다.
 *
 * 파일 읽기는 Rust(`markdown_read_file`)가 한다 — 웹뷰의 File API 로는 드롭된 **경로**를
 * 읽을 수 없고(Tauri 의 드롭 이벤트는 경로만 준다), 확장자·크기 제한도 한곳에서 걸린다.
 */
export function useMarkdownDoc() {
  const [doc, setDoc] = useState<MarkdownDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // "몇 번째로 연 문서인가". 원문을 고칠 때가 아니라 **다른 문서를 열었을 때만** 늘어난다 —
  // 미리보기가 스크롤을 처음으로 되돌릴 시점이 바로 이때뿐이기 때문이다.
  const [docId, setDocId] = useState(0)
  const [lastPath, setLastPath] = useLocalStorage<string>(LAST_PATH_KEY, "")

  // 복원은 마운트 때 한 번뿐이므로 **첫 렌더의 경로**만 붙잡아 둔다. 이후 문서를 열 때마다
  // lastPath 가 갱신되는데, 그걸 그대로 의존성에 쓰면 열 때마다 복원이 다시 돈다.
  const [initialPath] = useState(lastPath)

  /** 새 문서를 띄운다 — 문서를 여는 모든 경로가 여기로 모인다(docId 도 여기서만 는다). */
  const showDoc = useCallback((next: MarkdownDoc) => {
    setDoc(next)
    setDocId((n) => n + 1)
    setError(null)
  }, [])

  /** 경로로 파일을 읽어 연다. */
  const openPath = useCallback(
    async (path: string) => {
      if (!isTauri()) {
        setError("파일 열기는 데스크톱 앱에서만 됩니다.")
        return
      }
      setLoading(true)
      try {
        const f = await trackedInvoke<MarkdownFile>("markdown_read_file", {
          path,
        })
        showDoc({
          source: f.text,
          original: f.text,
          name: f.name,
          path: f.path,
        })
        setLastPath(f.path)
      } catch (e) {
        setError(String(e))
      } finally {
        setLoading(false)
      }
    },
    [setLastPath, showDoc]
  )

  /** 파일 선택 창을 띄워 연다. */
  const pickFile = useCallback(async () => {
    if (!isTauri()) {
      setError("파일 열기는 데스크톱 앱에서만 됩니다.")
      return
    }
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "마크다운", extensions: MARKDOWN_EXTS }],
    })
    const path = Array.isArray(picked) ? picked[0] : picked
    if (typeof path === "string" && path) await openPath(path)
  }, [openPath])

  /** 드롭된 경로들 중 첫 마크다운 파일을 연다(여러 개를 놓아도 문서는 하나만 본다). */
  const openDropped = useCallback(
    async (paths: string[]) => {
      const md = paths.find((p) => EXT_RE.test(p))
      if (!md) {
        setError(
          `마크다운 파일만 열 수 있습니다(${MARKDOWN_EXTS.map((e) => `.${e}`).join(" · ")}).`
        )
        return
      }
      await openPath(md)
    },
    [openPath]
  )

  /** 원문 텍스트를 그대로 문서로 삼는다(붙여넣기·원문 패널 편집). */
  const setSource = useCallback((text: string) => {
    setDoc((prev) =>
      prev
        ? { ...prev, source: text }
        : { source: text, original: text, name: "붙여넣은 문서", path: null }
    )
  }, [])

  /**
   * 클립보드 내용을 문서로 삼는다. 파인더에서 **파일**을 복사한 경우도 있어 세 갈래다:
   * 파일 객체 → 내용을 읽고, 경로 한 줄 → 그 파일을 열고, 그 밖에는 텍스트 자체를 문서로 본다.
   */
  const pasteFrom = useCallback(
    async (data: DataTransfer) => {
      const file = data.files?.[0]
      if (file) {
        if (!EXT_RE.test(file.name)) {
          setError(`마크다운 파일만 열 수 있습니다 — ${file.name}`)
          return
        }
        const text = await file.text()
        showDoc({ source: text, original: text, name: file.name, path: null })
        return
      }
      const text = data.getData("text/plain")
      if (!text.trim()) return
      const path = pathFromText(text)
      if (path) {
        await openPath(path)
        return
      }
      showDoc({
        source: text,
        original: text,
        name: "붙여넣은 문서",
        path: null,
      })
    },
    [openPath, showDoc]
  )

  /** 파일에서 연 문서를 디스크 내용으로 다시 읽는다(편집한 내용은 버린다). */
  const reload = useCallback(async () => {
    if (doc?.path) await openPath(doc.path)
  }, [doc, openPath])

  /** 문서를 닫고 빈 화면으로 되돌린다. */
  const clear = useCallback(() => {
    setDoc(null)
    setError(null)
    setLastPath("")
  }, [setLastPath])

  // 앱을 다시 켰을 때 마지막 문서를 되살린다. 파일이 사라졌으면 조용히 넘어간다 —
  // 시작하자마자 빨간 에러를 띄울 일은 아니다.
  useEffect(() => {
    if (!initialPath || !isTauri()) return
    void (async () => {
      try {
        const f = await trackedInvoke<MarkdownFile>("markdown_read_file", {
          path: initialPath,
        })
        showDoc({
          source: f.text,
          original: f.text,
          name: f.name,
          path: f.path,
        })
      } catch {
        setLastPath("")
      }
    })()
  }, [initialPath, setLastPath, showDoc])

  return {
    doc,
    /** 문서를 새로 열 때마다 바뀌는 값 — 미리보기의 스크롤 초기화 기준. */
    docId,
    error,
    loading,
    /** 파일에서 열어 놓고 원문 패널에서 고친 상태인지. */
    dirty: doc !== null && doc.source !== doc.original,
    openPath,
    pickFile,
    openDropped,
    pasteFrom,
    setSource,
    reload,
    clear,
    dismissError: useCallback(() => setError(null), []),
  }
}
