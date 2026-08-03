import { useCallback, useEffect, useRef, useState } from "react"
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  GitBranchIcon,
  RefreshCwIcon,
  RotateCwIcon,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { useLocalStorage } from "@/lib/use-local-storage"
import { cn } from "@/lib/utils"
import { useSettings } from "@/features/settings/settings-context"
import { ChangeList, type ChangeAction } from "./change-list"
import { CommitBox } from "./commit-box"
import { DiffPane } from "./diff-pane"
import { ConfirmDialog, StashDialog, UnstashDialog } from "./dialogs"
import {
  gitCommit,
  gitDiff,
  gitFetch,
  gitPull,
  gitPush,
  gitRollback,
  gitStage,
  gitStashApply,
  gitStashDrop,
  gitStashPush,
  gitUnstage,
  splitPath,
  type GitChange,
} from "./git-client"
import { useGit } from "./use-git"

/** 파일 목록 패널 폭(px) — 저장 키와 허용 범위(사이드바 폭과 같은 방식). */
const PANE_KEY = "myspace.gitPaneWidth"
const PANE_DEFAULT = 380
const PANE_MIN = 260
const PANE_MAX = 900

/** 이 파일의 diff 를 무엇과 비교해 보여 주는지(헤더 부제). */
function diffSubtitle(c: GitChange): string {
  if (c.untracked) return "새 파일"
  if (c.staged && !c.unstaged) return "스테이지 ↔ HEAD"
  if (c.staged) return "작업 트리 ↔ 스테이지 (스테이지된 변경은 따로 있음)"
  return "작업 트리 ↔ HEAD"
}

/**
 * 설정한 cowork 홈의 git 저장소를 IntelliJ 의 Git 툴윈도우처럼 다룬다.
 *
 * 왼쪽이 변경 목록 + 커밋 상자, 오른쪽이 diff. 체크박스는 **커밋에 넣을 목록**이고,
 * 스테이지·롤백·보관 같은 파일 단위 동작은 우클릭 메뉴에서 한다(체크에 파괴적 동작까지
 * 걸면 무엇이 지워질지 예측할 수 없다 — `change-list.tsx` 참고).
 */
export function GitView() {
  const { settings } = useSettings()
  const home = settings.cowork.home
  const { status, loading, error, busy, updatedAt, refresh, run } = useGit(home)

  /** 커밋에 넣을 경로들. */
  const [checked, setChecked] = useState<Set<string>>(new Set())
  /** 이미 화면에 한 번 나온 경로 — 새로 생긴 변경만 자동 체크하기 위해 기억한다. */
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<GitChange | null>(null)
  const [diff, setDiff] = useState("")
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [amend, setAmend] = useState(false)
  /** 열려 있는 확인 대화상자. */
  const [confirm, setConfirm] = useState<{
    title: string
    body: string
    label: string
    onOk: () => void
  } | null>(null)
  /** 보관 대화상자에 넘길 대상 경로(빈 배열이면 전체). null 이면 닫힘. */
  const [stashTarget, setStashTarget] = useState<string[] | null>(null)
  const [showStashes, setShowStashes] = useState(false)

  // 목록/diff 폭 조절. 사이드바와 같은 방식 — pointerdown 으로 시작하고 이동·종료는
  // window 에서 듣는다(포인터가 얇은 핸들 밖으로 나가도 드래그가 끊기지 않게).
  const [paneWidth, setPaneWidth] = useLocalStorage<number>(
    PANE_KEY,
    PANE_DEFAULT
  )
  const [resizing, setResizing] = useState(false)
  const dragOrigin = useRef({ x: 0, width: PANE_DEFAULT })

  useEffect(() => {
    if (!resizing) return
    const onMove = (e: PointerEvent) => {
      const next = dragOrigin.current.width + (e.clientX - dragOrigin.current.x)
      setPaneWidth(Math.round(Math.min(PANE_MAX, Math.max(PANE_MIN, next))))
    }
    const onUp = () => setResizing(false)
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    // 드래그 중 텍스트가 선택되는 것을 막는다.
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.userSelect = prevSelect
    }
  }, [resizing, setPaneWidth])

  /**
   * git 작업 하나 실행 + 결과 알림. 성공/실패 모두 명령 출력을 그대로 보여 준다 —
   * push 거절이나 충돌은 git 이 하는 말이 가장 정확하다.
   */
  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>) => {
      const r = await run(label, fn)
      if (r.ok) {
        toast.success(`${label} 완료`, {
          description: r.text ? r.text.slice(0, 400) : undefined,
        })
      } else {
        toast.error(`${label} 실패`, { description: r.text.slice(0, 600) })
      }
      return r.ok
    },
    [run]
  )

  // 새로 나타난 변경 파일은 자동으로 체크한다(IntelliJ 와 같게). 추적되지 않는 파일은
  // 기본으로 빼 둔다 — 빌드 산출물·로그가 섞여 있는 경우가 많아 통째로 커밋되면 곤란하다.
  // 사라진 경로는 체크 목록에서도 지운다.
  useEffect(() => {
    if (!status) return
    const tracked = status.changes.map((c) => c.path)
    const all = [...tracked, ...status.untracked.map((c) => c.path)]
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecked((prev) => {
      const next = new Set<string>()
      for (const p of all) {
        if (prev.has(p) || (!seen.has(p) && tracked.includes(p))) next.add(p)
      }
      return next
    })
    setSeen(new Set(all))
    // seen 은 이 effect 안에서만 갱신되므로 의존성에 넣으면 매번 다시 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // 선택한 파일의 diff. 상태를 다시 읽을 때마다(파일이 편집됐을 수 있으므로) 같이 갱신한다.
  useEffect(() => {
    if (!active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiff("")
      return
    }
    let cancelled = false
    // 이미 뭔가 보여 주고 있으면 로딩 표시 없이 조용히 바꾼다(폴링마다 깜빡이지 않게).
    void (async () => {
      try {
        const text = await gitDiff(
          home,
          active,
          active.staged && !active.unstaged
        )
        if (!cancelled) {
          setDiff(text)
          setDiffError(null)
        }
      } catch (e) {
        if (!cancelled) setDiffError(String(e))
      } finally {
        if (!cancelled) setDiffLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [home, active, updatedAt])

  /** 목록에서 파일을 고르면 diff 를 새로 읽는다(첫 로드만 스피너). */
  const activate = (c: GitChange) => {
    if (active?.path !== c.path) {
      setDiff("")
      setDiffError(null)
      setDiffLoading(true)
    }
    setActive(c)
  }

  const onCheck = (path: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(path)
      else next.delete(path)
      return next
    })

  const onCheckMany = (paths: string[], on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev)
      for (const p of paths) {
        if (on) next.add(p)
        else next.delete(p)
      }
      return next
    })

  const doCommit = async (thenPush: boolean) => {
    const paths = [...checked]
    const ok = await act("커밋", () => gitCommit(home, message, paths, amend))
    if (!ok) return
    setMessage("")
    setAmend(false)
    setActive(null)
    if (thenPush) await act("푸시", () => gitPush(home))
  }

  const onAction = async (action: ChangeAction, c: GitChange) => {
    const name = splitPath(c.path).name
    switch (action) {
      case "diff":
        activate(c)
        break
      case "stage":
        await act(c.untracked ? "VCS 에 추가" : "스테이지", () =>
          gitStage(home, [c.path])
        )
        break
      case "unstage":
        await act("스테이지 해제", () => gitUnstage(home, [c.path]))
        break
      case "stash":
        setStashTarget([c.path])
        break
      case "rollback":
        setConfirm({
          title: c.untracked ? "파일 삭제" : "변경 롤백",
          body: c.untracked
            ? `${name} 을(를) 디스크에서 지웁니다. 되돌릴 수 없습니다.`
            : `${name} 의 로컬 변경을 버리고 마지막 커밋 상태로 되돌립니다. 되돌릴 수 없습니다.`,
          label: c.untracked ? "삭제" : "롤백",
          onOk: () => {
            setConfirm(null)
            void act("롤백", () => gitRollback(home, [c.path]))
            if (active?.path === c.path) setActive(null)
          },
        })
        break
      case "reveal": {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener")
        const root = status?.root ?? ""
        await revealItemInDir(`${root}/${c.path}`)
        break
      }
    }
  }

  const changedCount =
    (status?.changes.length ?? 0) + (status?.untracked.length ?? 0)

  if (error && !status) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="rounded-[10px] border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <div className="text-[15px] font-bold text-ui-error">
            저장소를 읽을 수 없습니다
          </div>
          <div className="mt-2 font-mono text-[13px] break-all text-muted-foreground">
            {error}
          </div>
          <p className="mt-3 text-[13px] text-muted-foreground">
            설정 → Cowork 의{" "}
            <span className="font-mono">cowork 홈 디렉터리</span> 가 git
            저장소를 가리키는지 확인하세요.
          </p>
          <Button className="mt-4" size="sm" onClick={() => void refresh()}>
            다시 시도
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 툴바 — 브랜치 상태와 저장소 단위 동작 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-[15px] font-bold">
            {status?.branch || "…"}
          </span>
          {status?.upstream ? (
            <span className="truncate text-[13px] text-muted-foreground">
              → {status.upstream}
            </span>
          ) : (
            status && (
              <span className="shrink-0 rounded-full bg-ui-warning/15 px-2 text-[11px] font-bold text-ui-warning">
                업스트림 없음
              </span>
            )
          )}
          {!!status?.ahead && (
            <span className="shrink-0 text-[13px] font-semibold text-ui-success">
              ↑{status.ahead}
            </span>
          )}
          {!!status?.behind && (
            <span className="shrink-0 text-[13px] font-semibold text-ui-warning">
              ↓{status.behind}
            </span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy || loading}
            onClick={() => void refresh()}
            title="상태 새로고침"
          >
            <RefreshCwIcon className={cn(loading && "animate-spin")} />
            새로고침
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void act("가져오기", () => gitFetch(home))}
            title="원격 상태만 갱신(fetch)"
          >
            <RotateCwIcon />
            Fetch
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void act("풀", () => gitPull(home))}
          >
            <ArrowDownToLineIcon />
            Pull
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void act("푸시", () => gitPush(home))}
          >
            <ArrowUpFromLineIcon />
            Push
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || changedCount === 0}
            onClick={() => setStashTarget([])}
          >
            <ArchiveIcon />
            Stash
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => setShowStashes(true)}
          >
            <ArchiveRestoreIcon />
            Unstash
            {!!status?.stashes.length && (
              <span className="ml-1 rounded-full bg-ui-badge px-1.5 text-[11px] font-bold text-ui-list-active-fg">
                {status.stashes.length}
              </span>
            )}
          </Button>
        </div>
      </div>

      {/* 본문 — 왼쪽 변경 목록 + 커밋, 가운데 폭 조절 핸들, 오른쪽 diff */}
      <div className="flex min-h-0 flex-1">
        <div
          className="flex shrink-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
          style={{ width: paneWidth }}
        >
          {status ? (
            <ChangeList
              status={status}
              checked={checked}
              activePath={active?.path ?? null}
              onCheck={onCheck}
              onCheckMany={onCheckMany}
              onActivate={activate}
              onAction={(a, c) => void onAction(a, c)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              불러오는 중…
            </div>
          )}
          <CommitBox
            message={message}
            count={checked.size}
            amend={amend}
            disabled={!!busy}
            onMessage={setMessage}
            onAmend={setAmend}
            onCommit={() => void doCommit(false)}
            onCommitPush={() => void doCommit(true)}
          />
        </div>

        {/* 폭 조절 핸들 — 두 패널 사이 12px 여백이 곧 잡는 영역이다(가운데 3px 선으로 표시). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="파일 목록 너비 조절"
          onPointerDown={(e) => {
            e.preventDefault()
            dragOrigin.current = { x: e.clientX, width: paneWidth }
            setResizing(true)
          }}
          onDoubleClick={() => setPaneWidth(PANE_DEFAULT)}
          title="드래그해서 폭 조절 · 더블클릭하면 기본값"
          className="group/resize relative w-3 shrink-0 cursor-col-resize"
        >
          <div
            className={cn(
              "absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-colors group-hover/resize:bg-ui-selection/60",
              resizing && "bg-ui-selection/60"
            )}
          />
        </div>

        <div className="flex min-w-0 flex-1 overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
          <DiffPane
            title={active ? splitPath(active.path).name : null}
            subtitle={active ? diffSubtitle(active) : undefined}
            text={diff}
            loading={diffLoading}
            error={diffError}
          />
        </div>
      </div>

      {/* 상태줄 — 진행 중인 작업과 저장소 경로 */}
      <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
        {busy ? (
          <span className="font-semibold text-foreground">{busy} 중…</span>
        ) : (
          <span>
            변경 {changedCount}개 · 선택 {checked.size}개
          </span>
        )}
        <span className="ml-auto truncate font-mono" title={status?.root}>
          {status?.root}
        </span>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.onOk}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      {stashTarget && (
        <StashDialog
          paths={stashTarget}
          onCancel={() => setStashTarget(null)}
          onConfirm={(msg, untracked) => {
            const paths = stashTarget
            setStashTarget(null)
            void act("보관", () => gitStashPush(home, msg, untracked, paths))
          }}
        />
      )}
      {showStashes && (
        <UnstashDialog
          stashes={status?.stashes ?? []}
          busy={!!busy}
          onClose={() => setShowStashes(false)}
          onApply={(index, pop) => {
            void act(pop ? "되살리기" : "적용", () =>
              gitStashApply(home, index, pop)
            )
          }}
          onDrop={(index) => {
            setConfirm({
              title: "보관 버리기",
              body: "보관해 둔 변경을 지웁니다. 되돌릴 수 없습니다.",
              label: "버리기",
              onOk: () => {
                setConfirm(null)
                void act("보관 삭제", () => gitStashDrop(home, index))
              },
            })
          }}
        />
      )}
    </div>
  )
}
