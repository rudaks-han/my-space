import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { DiffPane } from "@/features/git/diff-pane"
import {
  gitCommitFileDiff,
  gitFileHistory,
  type GitCommit,
} from "@/features/git/git-client"
import { cn } from "@/lib/utils"

/**
 * 파일 하나의 커밋 이력 — IntelliJ 의 Git → Show History 를 대화창 하나로 옮긴 것.
 *
 * 왼쪽이 커밋 목록, 오른쪽이 **그 커밋에서 이 파일이 어떻게 바뀌었는지**(전체 커밋의
 * diff 가 아니다 — 이력을 여는 이유는 이 파일이 언제 어떻게 바뀌었는지이고, 같은 커밋에
 * 딸린 남의 파일까지 나오면 그걸 찾아야 한다). diff 는 Git 뷰의 `DiffPane` 을 그대로 쓴다.
 *
 * 세 가지가 이 모양을 정한다:
 * - **대화창이지 탭이 아니다.** 이력은 "지금 이 파일이 왜 이렇게 됐지"를 확인하고 닫는
 *   조회라, 탭으로 만들면 편집기 탭 줄에 되돌아오지 않을 항목이 쌓인다(변경 목록을
 *   상시로 보는 화면은 개발 → Git 이 이미 있다).
 * - **첫 커밋을 자동으로 고른다.** 가장 잦은 질문이 "마지막에 뭐가 바뀌었나" 라서
 *   목록만 띄우면 거의 항상 한 번 더 클릭하게 된다.
 * - **`limit` 을 준다.** 오래된 파일은 커밋이 수백 개인데 그걸 다 그려도 읽지 않는다.
 *   더 필요하면 개발 → Git 이나 터미널이 할 일이다.
 */

/** 한 번에 읽어 올 커밋 수. */
const LIMIT = 100

export function GitHistoryDialog({
  home,
  /** 대상의 절대 경로. */
  path,
  /** 헤더에 쓸 이름(저장소 루트 상대 경로면 더 좋다). */
  label,
  onClose,
}: {
  home: string
  path: string
  label: string
  onClose: () => void
}) {
  const [list, setList] = useState<GitCommit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState<GitCommit | null>(null)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])

  const loadDiff = useCallback(
    (c: GitCommit) => {
      setActive(c)
      setDiffLoading(true)
      setDiffError(null)
      void gitCommitFileDiff(home, c.hash, path)
        .then((text) => setDiff(text))
        .catch((e) => {
          setDiff("")
          setDiffError(String(e))
        })
        .finally(() => setDiffLoading(false))
    },
    [home, path]
  )

  /*
   * 이력 읽기. **첫 커밋의 diff 까지 같은 `then` 안에서 이어 읽는다** — 목록이 도착한 뒤
   * 별도 effect 로 고르면 그 자리에서 setState 가 일어나 렌더가 한 겹 더 돌고
   * (`react-hooks/set-state-in-effect`), `active` 를 의존성에 넣는 순간 목록에서 커밋을
   * 고를 때마다 같은 요청이 두 번 나간다.
   *
   * 대상이 바뀌면 이 대화창은 **통째로 다시 마운트된다**(부르는 쪽이 `key` 를 경로로
   * 준다), 그래서 상태를 되돌리는 코드가 없다 — 초기값이 이미 빈 값이다.
   */
  useEffect(() => {
    let cancelled = false
    void gitFileHistory(home, path, LIMIT)
      .then((rows) => {
        if (cancelled) return
        setList(rows)
        if (rows[0]) loadDiff(rows[0])
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [home, path, loadDiff])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // 트리 뿌리의 `select-none` 이 여기까지 상속된다 — diff 와 해시는 복사해야 쓸모가
        // 있으므로 되돌린다(`NamePrompt`·`DeleteConfirm` 과 같은 판단).
        className="flex h-[80vh] min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)] select-text"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="shrink-0 text-[15px] font-semibold">이력</span>
          <span
            className="truncate font-mono text-[13px] text-muted-foreground"
            title={path}
          >
            {label}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={onClose}
          >
            닫기
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 커밋 목록 */}
          <div className="w-72 shrink-0 overflow-auto border-r border-border">
            {error ? (
              <div className="p-4 text-[13px]">
                <div className="font-semibold text-ui-error">
                  이력을 읽지 못했습니다
                </div>
                <div className="mt-1 font-mono break-all text-muted-foreground">
                  {error}
                </div>
              </div>
            ) : !list ? (
              <p className="p-4 text-[13px] text-muted-foreground">
                불러오는 중…
              </p>
            ) : list.length === 0 ? (
              // 빈 목록은 오류가 아니다 — 아직 커밋되지 않은 파일이 가장 흔한 경우라
              // 그 사실을 말해 준다(그러면 "Git 에 추가" 가 다음 할 일이 된다).
              <p className="p-4 text-[13px] text-muted-foreground">
                커밋 이력이 없습니다. 아직 버전 관리에 들어오지 않은 파일일 수
                있습니다.
              </p>
            ) : (
              <div className="py-1">
                {list.map((c) => (
                  <button
                    key={c.hash}
                    type="button"
                    onClick={() => loadDiff(c)}
                    title={`${c.hash}\n${c.date}`}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors",
                      c.hash === active?.hash
                        ? "bg-ui-selection text-ui-selection-fg"
                        : "hover:bg-ui-list-hover"
                    )}
                  >
                    <span className="truncate text-[13px] font-bold">
                      {c.subject || "(제목 없음)"}
                    </span>
                    <span
                      className={cn(
                        "truncate text-[11px]",
                        c.hash === active?.hash
                          ? "opacity-80"
                          : "text-muted-foreground"
                      )}
                    >
                      {c.author} · {c.relative} ·{" "}
                      <span className="font-mono">{c.short}</span>
                    </span>
                  </button>
                ))}
                {list.length === LIMIT && (
                  <p className="px-3 py-2 text-[11px] text-muted-foreground">
                    최근 {LIMIT}건만 보여 줍니다.
                  </p>
                )}
              </div>
            )}
          </div>

          {/* 고른 커밋에서의 이 파일 diff */}
          <DiffPane
            title={active ? `${active.short} · ${active.subject}` : null}
            subtitle={active?.date}
            text={diff}
            loading={diffLoading}
            error={diffError}
          />
        </div>
      </div>
    </div>
  )
}
