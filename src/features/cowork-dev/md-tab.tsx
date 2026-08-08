import { useEffect, useMemo, useState } from "react"
import { ColumnsIcon, EyeIcon, LockIcon, PencilIcon } from "lucide-react"

import { SplitBar } from "@/components/split-bar"
import { renderMarkdown } from "@/features/cowork-spec/markdown"
import { MarkdownViewer } from "@/features/cowork-spec/markdown-viewer"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { cn } from "@/lib/utils"
import { TextEditor } from "./text-editor"
import { NS } from "./types"

/**
 * IntelliJ Cowork 화면의 **마크다운 탭** — `.md` / `.markdown` 파일이 여기로 열린다.
 *
 * 왜 별도 탭인가: 이 저장소의 `.md` 는 읽는 문서(`_md/`, 스펙, README)가 대부분이라
 * 원문만 보여 주면 표·코드펜스·mermaid 가 전부 기호 덩어리로 남는다. 그렇다고 뷰어로만
 * 두면 이 화면의 존재 이유(IntelliJ 없이 고치기)가 깨지므로, **편집 · 미리보기 · 나란히**
 * 세 모드를 준다.
 *
 * 렌더러는 새로 만들지 않고 `cowork-spec` 의 것을 그대로 쓴다 — Typora 테마 css 를 섀도
 * DOM 에 가둬 앱 스타일과 격리하는 그 구현이 이 앱의 마크다운 표준이고(마크다운 뷰어 메뉴와
 * Cowork Spec 문서 메뉴가 이미 같은 것을 쓴다), 두 벌을 두면 같은 문서가 화면마다 다르게
 * 보인다. mermaid 동적 로드와 `--ui-font` 상속도 그쪽에 이미 들어 있다.
 *
 * 모드는 파일별이 아니라 **화면 단위로 하나**를 기억한다(`myspace.coworkDev.mdMode`).
 * 파일마다 따로 두면 탭을 옮길 때마다 모드가 튀어 "왜 편집기가 사라졌지"가 되고, 문서를
 * 읽는 사람은 계속 읽고 고치는 사람은 계속 고치기 때문에 하나로 충분하다.
 */

type MdMode = "edit" | "preview" | "split"

/**
 * 미리보기를 다시 그릴 때까지 기다리는 시간. `renderMarkdown` 자체는 빠르지만, 나란히
 * 모드에서 한 글자마다 문서 전체의 `innerHTML` 을 갈아 끼우면(그리고 mermaid 블록을 다시
 * 찾으면) 큰 문서에서 타자가 끊긴다. 손을 멈추면 그때 반영한다.
 */
const SETTLE_MS = 180

const MODES: {
  id: MdMode
  label: string
  icon: typeof EyeIcon
  hint: string
}[] = [
  { id: "preview", label: "미리보기", icon: EyeIcon, hint: "문서로 보기" },
  { id: "edit", label: "편집", icon: PencilIcon, hint: "원문 편집" },
  {
    id: "split",
    label: "나란히",
    icon: ColumnsIcon,
    hint: "왼쪽 원문 · 오른쪽 문서",
  },
]

export function MdTab({
  path,
  rel,
  text,
  onChange,
  onSave,
  dirty,
  readOnly = false,
  readOnlyReason,
  active = true,
}: {
  /** 절대 경로 — 뷰어의 스크롤 초기화 키이자 "다른 파일로 갈아끼워졌다"는 신호다. */
  path: string
  /** 프로젝트 루트 기준 상대 경로 — 헤더에 표시한다. */
  rel: string
  text: string
  onChange: (v: string) => void
  onSave: () => void
  dirty: boolean
  /** 바이너리·2MB 초과처럼 되쓰면 안 되는 파일. 편집 모드를 막는다. */
  readOnly?: boolean
  readOnlyReason?: string | null
  /** 이 탭이 지금 보이는가. */
  active?: boolean
}) {
  const [stored, setMode] = useLocalStorage<MdMode>(`${NS}.mdMode`, "preview")
  /*
   * 되쓸 수 없는 파일은 편집 모드가 의미 없으므로 미리보기로 접는다. 저장값 자체를
   * 바꾸지는 않는다 — 다음에 보통 파일을 열면 원래 고르던 모드로 돌아와야 한다.
   */
  const mode: MdMode = readOnly && stored === "edit" ? "preview" : stored

  /*
   * 미리보기 본문. 디바운스한 원문으로 만든다 — 이유는 위 `SETTLE_MS` 주석에 적어 두었다.
   *
   * 경로를 함께 들고 있는 이유: 파일이 갈아끼워졌을 때 **기다리지 않고** 바로 새 문서를
   * 그려야 한다(잠깐이라도 이전 문서가 보이면 다른 파일을 연 줄 알게 된다). 그 처리를
   * effect 에서 setState 로 하지 않고 아래 `source` 파생으로 해결한다 — 렌더 중에 답이
   * 나오는 일을 effect 로 미루면 한 프레임 늦고, `set-state-in-effect` 규칙에도 걸린다.
   * 타이머는 그 뒤 같은 값으로 한 번 따라오는데, 문자열이 같으므로 `html` memo 는 다시
   * 계산되지 않는다.
   */
  const [settled, setSettled] = useState<{ path: string; text: string }>({
    path,
    text,
  })
  useEffect(() => {
    if (settled.path === path && settled.text === text) return
    const t = setTimeout(() => setSettled({ path, text }), SETTLE_MS)
    return () => clearTimeout(t)
    // 상태를 바꾸는 것은 effect 본문이 아니라 **타이머**라서 규칙에 걸리지 않는다.
  }, [path, text, settled])

  const source = settled.path === path ? settled.text : text
  const html = useMemo(() => renderMarkdown(source), [source])

  /*
   * 나란히 모드의 좌우 폭. 편집기가 왼쪽이라 기본 `"ltr"` 이고, 분할선은 흐름 안에 들어가는
   * `SplitBar` 다 — 이 화면의 다른 분할선과 같은 이유로(잡히는 곳 = 보이는 곳) 절대 배치
   * 손잡이를 쓰지 않는다.
   */
  const split = useResizableWidth(`${NS}.mdSplitWidth`, 480, 240, 1200)

  const editor = (
    <TextEditor
      path={path}
      text={text}
      onChange={onChange}
      onSave={onSave}
      readOnly={readOnly}
      readOnlyReason={readOnlyReason}
      // 나란히 모드에서도 편집기가 보이므로 포커스는 편집기가 화면에 있을 때만 가져간다.
      active={active && mode !== "preview"}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 모드 줄. 한 줄(h-8)로 묶는다 — 위에 이미 툴바와 탭 줄과 빵부스러기가 있다. */}
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <div className="flex items-center gap-0.5">
          {MODES.map((m) => {
            const on = m.id === mode
            const off = readOnly && m.id === "edit"
            return (
              <button
                key={m.id}
                type="button"
                disabled={off}
                title={
                  off
                    ? (readOnlyReason ?? "이 파일은 고칠 수 없습니다.")
                    : m.hint
                }
                onClick={() => setMode(m.id)}
                className={cn(
                  "flex h-6 cursor-pointer items-center gap-1 rounded-lg px-2 text-[12px] transition-colors",
                  on
                    ? "bg-ui-selection font-bold text-ui-selection-fg"
                    : "text-muted-foreground hover:bg-ui-list-hover hover:text-foreground",
                  off && "cursor-not-allowed opacity-40 hover:bg-transparent",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
                )}
              >
                <m.icon className="size-3" />
                {m.label}
              </button>
            )
          })}
        </div>
        {/* 읽기 전용 사유는 여기서도 알린다. `TextEditor` 가 자기 띠로 그리지만
            미리보기 모드에서는 편집기가 아예 없어서, 그 모드에서만 사유가 사라진다. */}
        {readOnly ? (
          <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-ui-warning">
            <LockIcon className="size-3 shrink-0" />
            {readOnlyReason ?? "읽기 전용"}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {rel}
          </span>
        )}
        {dirty && (
          <span className="ml-auto shrink-0 rounded-full bg-ui-warning/15 px-2 text-[11px] font-bold text-ui-warning">
            수정됨
          </span>
        )}
      </div>

      {/* 본문. 모드를 바꾸면 편집기·뷰어가 트리에서 자리를 옮기므로 다시 마운트되고,
          편집기 스크롤과 커서는 초기화된다 — 그건 사용자가 직접 누른 전환이라 그대로 둔다
          (탭 전환은 다르다: 그쪽은 keep-alive 로 보존한다). 본문 자체는 버퍼가 들고 있어
          잃지 않는다. 세 모드를 억지로 한 배치에 담으면(폭 0 으로 접기 등) 안쪽
          스크롤러가 0px 로 눌려 스크롤 위치가 어차피 망가진다. */}
      {mode === "preview" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* `scrollResetKey` 에 경로를 준다 — 본문(html)을 키로 쓰면 원문을 고치는 동안
              미리보기가 매번 맨 위로 튄다. */}
          <MarkdownViewer html={html} scrollResetKey={path} />
        </div>
      ) : mode === "edit" ? (
        <div className="flex min-h-0 flex-1 flex-col p-2">{editor}</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-h-0 shrink-0 flex-col p-2"
            style={{ width: split.width }}
          >
            {editor}
          </div>
          <SplitBar
            orientation="vertical"
            resizing={split.resizing}
            onPointerDown={split.startResize}
            label="원문·문서 폭 조절"
          />
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <MarkdownViewer html={html} scrollResetKey={path} />
          </div>
        </div>
      )}
    </div>
  )
}
