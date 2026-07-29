import {
  BellIcon,
  Building2Icon,
  ChevronRightIcon,
  ClockIcon,
  ExternalLinkIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  HardDriveIcon,
  HomeIcon,
  PresentationIcon,
  RefreshCwIcon,
  StarIcon,
  Users2Icon,
  type LucideIcon,
} from "lucide-react"
import { useCallback, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { friendlyError } from "./gdrive-error"
import {
  nodeKey,
  useDriveFiles,
  useDriveTree,
  useGdriveConnection,
  type DriveFile,
  type DriveNode,
} from "./use-gdrive"

/** 좌측 네비 아이콘 공통 스타일. */
const NAV_ICON = "size-4 shrink-0 text-muted-foreground"

/**
 * 좌측 트리의 최상위 항목. `내 드라이브` / `공유 드라이브` 는 펼쳐서 하위 폴더를 타고
 * 들어갈 수 있고, 나머지는 잎 노드다. 항목을 고르면 우측에 그 위치의 목록이 뜬다.
 */
const ROOTS: {
  node: DriveNode
  label: string
  icon: LucideIcon
  expandable?: boolean
}[] = [
  { node: { kind: "home" }, label: "홈", icon: HomeIcon },
  {
    node: { kind: "my-drive" },
    label: "내 드라이브",
    icon: HardDriveIcon,
    expandable: true,
  },
  {
    node: { kind: "shared-drives" },
    label: "공유 드라이브",
    icon: Building2Icon,
    expandable: true,
  },
  { node: { kind: "shared-with-me" }, label: "공유 문서함", icon: Users2Icon },
  { node: { kind: "recent" }, label: "최근 문서함", icon: ClockIcon },
  { node: { kind: "starred" }, label: "중요 문서함", icon: StarIcon },
]

/** 노드 표시 이름 — 폴더는 제 이름, 고정 뷰는 ROOTS 의 라벨. */
function nodeLabel(node: DriveNode): string {
  if (node.kind === "folder") return node.name ?? "폴더"
  return ROOTS.find((r) => r.node.kind === node.kind)?.label ?? "드라이브"
}

/** 노드별 빈 목록 문구. */
function emptyLabel(node: DriveNode): string {
  switch (node.kind) {
    case "home":
    case "recent":
      return "최근에 열어본 파일이 없습니다."
    case "shared-drives":
      return "참여 중인 공유 드라이브가 없습니다."
    case "shared-with-me":
      return "공유받은 파일이 없습니다."
    case "starred":
      return "중요 문서함이 비어 있습니다."
    default:
      return "이 폴더에 항목이 없습니다."
  }
}

/* ------------------------------------------------------------------ 트리 */

interface TreeProps {
  /** 이 노드까지의 경로(자기 자신 포함) — 고르면 그대로 브레드크럼이 된다. */
  path: DriveNode[]
  label: string
  icon: LucideIcon
  depth: number
  expandable: boolean
  tree: ReturnType<typeof useDriveTree>
  selectedKey: string
  onSelect: (path: DriveNode[]) => void
}

function TreeBranch({
  path,
  label,
  icon: Icon,
  depth,
  expandable,
  tree,
  selectedKey,
  onSelect,
}: TreeProps) {
  const node = path[path.length - 1]
  const key = nodeKey(node)
  const open = expandable && tree.expanded.has(key)
  const kids = tree.children[key]
  const selected = selectedKey === key

  return (
    <>
      <div
        className={cn(
          "flex h-(--ui-row-h) items-center rounded-lg pr-2 transition-colors",
          selected
            ? "bg-ui-list-active text-ui-list-active-fg"
            : "hover:bg-ui-list-hover"
        )}
        style={{ paddingLeft: depth * 14 }}
      >
        {expandable ? (
          <button
            type="button"
            aria-label={open ? "접기" : "펼치기"}
            onClick={() => tree.toggle(node)}
            className="flex size-5 shrink-0 items-center justify-center rounded-lg"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                selected ? "" : "text-muted-foreground",
                open && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        {/* 이름 클릭 = 선택. 펼치기는 onSelect → reveal 이 같이 해 주므로(드라이브 웹과
            동일) 여기서 toggle 을 부르면 방금 편 것을 도로 접는다. 접기는 화살표로. */}
        <button
          type="button"
          onClick={() => onSelect(path)}
          className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[15px]"
        >
          <Icon className={cn(NAV_ICON, selected && "text-current")} />
          <span className={cn("truncate", selected && "font-bold")}>
            {label}
          </span>
        </button>
      </div>

      {open &&
        (tree.failed[key] !== undefined ? (
          // 실패를 "하위 폴더 없음"으로 뭉개면 원인을 알 수 없다 — 오류를 그대로 보여 주고
          // 눌러서 다시 시도하게 한다.
          <button
            type="button"
            onClick={() => tree.retry(node)}
            className="py-1 pr-2 text-left text-[13px] text-ui-error hover:underline"
            style={{ paddingLeft: (depth + 1) * 14 + 28 }}
          >
            {friendlyError(tree.failed[key])} · 다시 시도
          </button>
        ) : kids === undefined ? (
          <div
            className="py-1 text-[13px] text-muted-foreground"
            style={{ paddingLeft: (depth + 1) * 14 + 28 }}
          >
            불러오는 중…
          </div>
        ) : (
          // 하위 폴더가 없으면 아무것도 그리지 않는다(빈 배열 → 빈 렌더).
          kids.map((kid) => (
            <TreeBranch
              key={nodeKey(kid)}
              path={[...path, kid]}
              label={nodeLabel(kid)}
              icon={FolderIcon}
              depth={depth + 1}
              expandable
              tree={tree}
              selectedKey={selectedKey}
              onSelect={onSelect}
            />
          ))
        ))}
    </>
  )
}

/** 좌측 네비게이션 — 트리 + Chrome 으로 여는 "활동"(드라이브 활동은 앱에서 못 읽는다). */
function DriveNav({
  tree,
  selectedKey,
  onSelect,
}: {
  tree: ReturnType<typeof useDriveTree>
  selectedKey: string
  onSelect: (path: DriveNode[]) => void
}) {
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto pr-1">
      {ROOTS.map((r) => (
        <TreeBranch
          key={r.node.kind}
          path={[r.node]}
          label={r.label}
          icon={r.icon}
          depth={0}
          expandable={r.expandable ?? false}
          tree={tree}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      ))}
      <a
        href="https://drive.google.com/drive/activity"
        className="flex h-(--ui-row-h) items-center gap-2 rounded-lg pr-2 pl-5 text-[15px] transition-colors hover:bg-ui-list-hover"
      >
        <BellIcon className={NAV_ICON} />
        <span className="truncate">활동</span>
        <ExternalLinkIcon className="ml-auto size-3 shrink-0 text-muted-foreground" />
      </a>
    </nav>
  )
}

/* ------------------------------------------------------------------ 목록 */

/** 필터·액션 버튼 = Slack 우측 상단의 테두리 알약. */
const PILL = "h-7 rounded-full px-3 text-[13px] font-semibold"

/** 홈(추천 파일) 컬럼: 이름 / 추천 이유 / 소유자 / 위치. */
const HOME_GRID =
  "grid grid-cols-[minmax(0,2.4fr)_minmax(0,1.7fr)_minmax(0,1.1fr)_minmax(0,1.1fr)] items-center gap-3"
/** 탐색 컬럼: 이름 / 소유자 / 마지막으로 수정한 날짜 / 파일 크기. */
const BROWSE_GRID =
  "grid grid-cols-[minmax(0,2.6fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,0.7fr)] items-center gap-3"

/** iconLink 가 없을 때 쓰는 MIME 기반 대체 아이콘. */
function FallbackIcon({ mime }: { mime: string }) {
  const cls = "size-4 shrink-0 text-muted-foreground"
  if (mime === "application/vnd.google-apps.folder")
    return <FolderIcon className={cls} />
  if (mime === "application/vnd.google-apps.spreadsheet")
    return <FileSpreadsheetIcon className={cls} />
  if (mime === "application/vnd.google-apps.presentation")
    return <PresentationIcon className={cls} />
  if (mime.startsWith("image/")) return <FileImageIcon className={cls} />
  if (mime.includes("spreadsheet") || mime === "application/vnd.ms-excel")
    return <FileSpreadsheetIcon className={cls} />
  if (mime.includes("presentation") || mime.includes("powerpoint"))
    return <PresentationIcon className={cls} />
  if (
    mime === "application/vnd.google-apps.document" ||
    mime === "application/pdf" ||
    mime.includes("word") ||
    mime.startsWith("text/")
  )
    return <FileTextIcon className={cls} />
  return <FileIcon className={cls} />
}

/** 추천 이유 시각 — 오늘이면 "오전 10:23", 아니면 "7월 23일". */
function reasonTimeLabel(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
}

/** 수정 날짜 — 올해면 "7월 23일", 지난 해면 "2024. 7. 23.". */
function dateLabel(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.getFullYear() === new Date().getFullYear()
    ? d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })
    : d.toLocaleDateString("ko-KR")
}

/** 파일 크기 — 폴더·구글 문서는 크기가 없어 "—". */
function sizeLabel(size: number | null): string {
  if (size === null || size === undefined) return "—"
  if (size < 1024) return `${size} B`
  const units = ["KB", "MB", "GB", "TB"]
  let v = size / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** 이름에서 유도한 파스텔 색 — 사진이 없는 소유자 아바타 배경. */
function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return `hsl(${h} 42% 55%)`
}

/** 이니셜 색상 아바타(사진이 없거나 로드 실패했을 때). */
function InitialsAvatar({ name }: { name: string }) {
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-lg text-[9px] font-bold text-white"
      style={{ backgroundColor: avatarColor(name) }}
    >
      {name.slice(-2)}
    </span>
  )
}

/** 소유자 셀 — 사진 아바타(없거나 로드 실패 시 이니셜) + 이름("나" / "—"). */
function OwnerCell({ file }: { file: DriveFile }) {
  // 구글 아바타는 웹뷰에서 로드 실패하는 경우가 있어 실패하면 이니셜로 폴백한다.
  const [photoFailed, setPhotoFailed] = useState(false)

  if (!file.owner_me && !file.owner_name) {
    return <span className="text-[13px] text-muted-foreground">—</span>
  }
  const label = file.owner_me ? "나" : (file.owner_name ?? "—")
  const fallbackName = file.owner_name ?? label
  return (
    <div className="flex min-w-0 items-center gap-2">
      {file.owner_photo && !photoFailed ? (
        <img
          src={file.owner_photo}
          alt=""
          // 리퍼러가 붙으면 구글이 403 을 주므로 no-referrer 로 요청한다.
          referrerPolicy="no-referrer"
          onError={() => setPhotoFailed(true)}
          className="size-5 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <InitialsAvatar name={fallbackName} />
      )}
      <span className="truncate text-[13px]">{label}</span>
    </div>
  )
}

/** 이름 셀(아이콘 + 파일명) — 두 컬럼 구성이 공유한다. */
function NameCell({ file }: { file: DriveFile }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {file.icon_link && !file.is_folder ? (
        <img src={file.icon_link} alt="" className="size-4 shrink-0" />
      ) : (
        <FallbackIcon mime={file.mime_type} />
      )}
      <span className="truncate font-bold">{file.name}</span>
    </div>
  )
}

const ROW_CLASS =
  "ui-selectable min-h-9 w-full rounded-lg px-3 py-1.5 text-left text-[15px] transition-colors hover:bg-ui-list-hover"

/**
 * 파일 한 줄. 폴더면 그 안으로 들어가고(같은 화면에서 목록이 바뀐다), 파일이면
 * Chrome(시스템 브라우저)으로 연다.
 */
function FileRow({
  file,
  home,
  onOpenFolder,
}: {
  file: DriveFile
  home: boolean
  onOpenFolder: (file: DriveFile) => void
}) {
  const inner = home ? (
    <>
      <NameCell file={file} />
      {/* 추천 이유 */}
      <span className="truncate text-[13px] text-muted-foreground">
        {file.reason_modified_by
          ? `${file.reason_modified_by}님이 수정함`
          : "내가 열어본 항목"}
        {reasonTimeLabel(file.reason_time) &&
          ` · ${reasonTimeLabel(file.reason_time)}`}
      </span>
      <OwnerCell file={file} />
      {/* 위치 */}
      {file.location ? (
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          {file.location === "공유 문서함" ? (
            <Users2Icon className="size-3.5 shrink-0" />
          ) : (
            <FolderIcon className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{file.location}</span>
        </div>
      ) : (
        <span className="text-[13px] text-muted-foreground">—</span>
      )}
    </>
  ) : (
    <>
      <NameCell file={file} />
      <OwnerCell file={file} />
      <span className="truncate text-[13px] text-muted-foreground">
        {dateLabel(file.modified_time)}
      </span>
      <span className="truncate text-[13px] text-muted-foreground">
        {sizeLabel(file.size)}
      </span>
    </>
  )

  const className = cn(home ? HOME_GRID : BROWSE_GRID, ROW_CLASS)

  if (file.is_folder) {
    return (
      <button
        type="button"
        onClick={() => onOpenFolder(file)}
        className={className}
      >
        {inner}
      </button>
    )
  }
  return file.web_view_link ? (
    <a href={file.web_view_link} className={className}>
      {inner}
    </a>
  ) : (
    <div className={className}>{inner}</div>
  )
}

/** 위치 경로 — 각 조각을 누르면 그 위치로 돌아간다. */
function Breadcrumb({
  path,
  onSelect,
}: {
  path: DriveNode[]
  onSelect: (path: DriveNode[]) => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      {path.map((node, i) => {
        const last = i === path.length - 1
        return (
          <div key={nodeKey(node)} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {last ? (
              <span className="truncate text-[18px] font-bold tracking-[-0.01em]">
                {nodeLabel(node)}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(path.slice(0, i + 1))}
                className="truncate rounded-lg px-1 text-[15px] text-muted-foreground transition-colors hover:bg-ui-list-hover"
              >
                {nodeLabel(node)}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 아직 계정이 연결되지 않았을 때 — 연결은 설정 화면에서 한다. */
function NotConnectedView() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <HardDriveIcon className="size-9 text-muted-foreground" />
      <p className="text-[15px] font-bold">
        Google 드라이브가 연결되지 않았습니다.
      </p>
      <p className="text-[13px] text-muted-foreground">
        사이드바 아래 톱니 아이콘 → 설정 → Google Drive 에서 계정을 연결해
        주세요.
      </p>
    </div>
  )
}

export function GdriveView() {
  const { status, error: connError } = useGdriveConnection()
  const connected = status?.connected ?? false
  // 트리에서 고른 위치. path[0] 은 항상 최상위 항목, 마지막이 현재 위치다.
  const [path, setPath] = useState<DriveNode[]>([{ kind: "home" }])
  const node = path[path.length - 1]
  const tree = useDriveTree(connected)
  const {
    files,
    loading,
    loadingMore,
    hasMore,
    error,
    updatedAt,
    refresh,
    loadMore,
  } = useDriveFiles(node, connected)

  const { reveal } = tree
  const select = useCallback(
    (next: DriveNode[]) => {
      setPath(next)
      reveal(next)
    },
    [reveal]
  )

  // 목록에서 폴더를 눌렀을 때 — 현재 경로 뒤에 붙여 들어간다.
  const openFolder = useCallback(
    (file: DriveFile) => {
      select([...path, { kind: "folder", id: file.id, name: file.name }])
    },
    [path, select]
  )

  const home = node.kind === "home"

  let content: ReactNode
  if (status === null) {
    content = (
      <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
        연결 상태 확인 중…
      </div>
    )
  } else if (!connected) {
    content = <NotConnectedView />
  } else {
    content = (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Breadcrumb path={path} onSelect={select} />
          <span className="text-[13px] text-muted-foreground">
            {status.email ?? "Google 드라이브"}
            {home &&
              updatedAt &&
              ` · ${new Date(updatedAt).toLocaleTimeString("ko-KR", {
                hour: "2-digit",
                minute: "2-digit",
              })} 업데이트`}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              className={PILL}
              onClick={() => void refresh()}
              disabled={loading}
            >
              <RefreshCwIcon
                className={cn("size-3.5", loading && "animate-spin")}
              />
              새로고침
            </Button>
          </div>
        </div>

        {(error ?? connError) && (
          <p className="rounded-lg bg-ui-error/15 px-3 py-2 text-[15px] text-ui-error">
            {friendlyError(error ?? connError ?? "")}
          </p>
        )}

        {loading && files.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-16 text-[15px] text-muted-foreground">
            파일을 불러오는 중…
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
            <FileIcon className="size-9 text-muted-foreground" />
            <p className="text-[15px] text-muted-foreground">
              {emptyLabel(node)}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
            {/* 컬럼 헤더 */}
            <div
              className={cn(
                home ? HOME_GRID : BROWSE_GRID,
                "shrink-0 border-b border-border px-3 py-2 text-[13px] text-muted-foreground"
              )}
            >
              {home ? (
                <>
                  <span>이름</span>
                  <span>추천 이유</span>
                  <span>소유자</span>
                  <span>위치</span>
                </>
              ) : (
                <>
                  <span>이름</span>
                  <span>소유자</span>
                  <span>마지막으로 수정한 날짜</span>
                  <span>파일 크기</span>
                </>
              )}
            </div>
            {/* 행 */}
            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
              {files.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  home={home}
                  onOpenFolder={openFolder}
                />
              ))}
              {hasMore && (
                <div className="flex justify-center py-2">
                  <Button
                    variant="outline"
                    className="h-8 rounded-full px-4 text-[13px] font-semibold"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <RefreshCwIcon className="size-3.5 animate-spin" />
                    ) : null}
                    더보기
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  // 좌측 트리 + 우측 목록. 트리는 연결 여부와 무관하게 항상 보인다.
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-5">
      <DriveNav tree={tree} selectedKey={nodeKey(node)} onSelect={select} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
    </div>
  )
}
