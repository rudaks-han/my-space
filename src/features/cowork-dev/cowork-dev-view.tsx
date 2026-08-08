import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  EraserIcon,
  FileCodeIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  LayersIcon,
  Loader2Icon,
  PanelBottomCloseIcon,
  PanelBottomOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PlayIcon,
  PlugIcon,
  PlusIcon,
  RotateCwIcon,
  ServerIcon,
  SquareIcon,
  TableIcon,
  TerminalIcon,
  UndoIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import {
  ElasticsearchBrandIcon,
  KafkaBrandIcon,
} from "@/components/brand-icons"
import { SplitBar } from "@/components/split-bar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { isTauri } from "@/lib/tauri"
import { useLocalStorage } from "@/lib/use-local-storage"
import { useResizableHeight } from "@/lib/use-resizable-height"
import { useResizableWidth } from "@/lib/use-resizable-width"
import { useTabOverflow } from "@/lib/use-tab-overflow"
import { cn } from "@/lib/utils"
import { ConnectionForm } from "@/features/db-viewer/connection-form"
import type { DbConnection } from "@/features/db-viewer/connection"
import { useDbConnections } from "@/features/db-viewer/db-connections-store"
import * as db from "@/features/db-viewer/db-client"
import { engineById, newConnection } from "@/features/db-viewer/engines"
import { QueryConsole } from "@/features/db-viewer/query-console"
import { TablePane } from "@/features/db-viewer/table-pane"
import { useEsConn } from "@/features/es-viewer/es-conn-store"
import { IndexPane } from "@/features/es-viewer/index-pane"
import { purgeIndex } from "@/features/es-viewer/persisted"
import { gitStatus, type GitStatus } from "@/features/git/git-client"
import { parseHttpFile } from "@/features/intellij-http/http-parse"
import { StopAllDialog } from "@/features/intellij/stop-all-dialog"
import { useServices } from "@/features/intellij/use-services"
import { BrokersPane } from "@/features/kafka-viewer/brokers-pane"
import { GroupsPane } from "@/features/kafka-viewer/groups-pane"
import { useKafkaConn } from "@/features/kafka-viewer/kafka-conn-store"
import { TopicPane } from "@/features/kafka-viewer/topic-pane"
import { useSettings } from "@/features/settings/settings-context"
import { DbPanel } from "./db-panel"
import { useDevDark } from "./dev-dark-store"
import { EsPanel } from "./es-panel"
import { FileTree } from "./file-tree"
import { buildGitMarks } from "./git-marks"
import { HttpResponseDock, HttpTab } from "./http-tab"
import { KafkaPanel } from "./kafka-panel"
import { MdTab } from "./md-tab"
import { ServicesDock } from "./services-dock"
import { TextEditor } from "./text-editor"
import {
  esIndexTabId,
  fileTabId,
  isHttpFile,
  isMarkdownFile,
  kafkaTopicTabId,
  sqlTabId,
  tableTabId,
  DB_SCOPE,
  ES_SCOPE,
  KAFKA_BROKERS_TAB_ID,
  KAFKA_GROUPS_TAB_ID,
  KAFKA_SCOPE,
  NS,
  type DevEntry,
  type DevTab,
  type DockTab,
  type InfraTool,
} from "./types"
import { useDbSession } from "./use-db-session"
import { useDevTabs } from "./use-dev-tabs"
import { useEsSession } from "./use-es-session"
import { useFileBuffers } from "./use-file-buffers"
import { useFileOps } from "./use-file-ops"
import { useHttpRun } from "./use-http-run"
import { useKafkaSession } from "./use-kafka-session"
import { useProjectTree } from "./use-project-tree"

/**
 * **IntelliJ Cowork** — IntelliJ 를 켜지 않고 cowork 를 개발하기 위한 한 장짜리 콘솔.
 *
 * 이 파일이 하는 일은 조립뿐이다. 왼쪽 트리(`FileTree`) · 가운데 탭(`useDevTabs`) ·
 * 오른쪽 인프라(`DbPanel`·`EsPanel`·`KafkaPanel` 중 하나) · 아래 독(`ServicesDock`)
 * 네 영역이 서로를 열어 주므로, **탭 모델과 다섯 개의 세션(파일 버퍼 · HTTP 실행 ·
 * JDBC · Elasticsearch · Kafka)을 여기서 한 번씩만 만들어** 아래로 내려 준다. 훅을
 * 영역마다 부르면 실행 중 목록·로그 버퍼·트랜잭션 상태가 두 벌 생겨 서로 다른 말을
 * 한다(각 훅의 머리말이 그 이유를 적어 두었다).
 *
 * 배치의 세 가지 규칙:
 *  1. 뿌리는 **카드 하나**다. `App.tsx` 가 모든 뷰를 `absolute inset-0 … p-5` 로 감싸고
 *     있어 그 여백을 뷰 안에서 없앨 수 없으므로, 브라우징·서비스 화면과 같은 관용구
 *     (`rounded-[10px] border bg-card`)로 그 안을 꽉 채운다.
 *  2. 중첩된 flex 자식마다 `min-h-0` 을 준다. 하나라도 빠지면 아래 독이 레이아웃을 화면
 *     밖으로 밀어내고, 스크롤이 조용히 App 의 바깥 스크롤러로 옮겨 간다.
 *  3. 네 개의 분할선은 **흐름 안에 들어가는 `SplitBar`** 다(`Splitter` 주석 참고).
 *     그래서 이웃 패널에는 그 방향의 테두리를 주지 않고, 부모에도 `gap` 을 주지 않는다 —
 *     바가 곧 그 경계선이다.
 *
 * **이 화면만의 다크 모드**(뷰 헤더의 제목 "IntelliJ Cowork" 옆 달 아이콘 — 토글과 저장은
 * `dev-dark-store.tsx` 가 갖고, 이 파일은 값만 읽는다): 뿌리
 * 카드에 `dark` 클래스를 붙이는 것이 전부다. `.dark` 는 `index.css`·프리셋 `<style>` 둘
 * 다 **클래스 셀렉터**로 토큰을 정의하므로 `<html>` 이 아닌 곳에 붙여도 그 아래가 전부
 * 다크로 바뀌고, `@custom-variant dark (&:is(.dark *))` 덕에 자식들의 `dark:` 유틸리티도
 * 함께 따라온다(그래서 뿌리 div 자신은 `dark:` 를 쓰지 않는다 — 자기 자신은 `.dark *` 에
 * 걸리지 않는다). 편집기·콘솔·격자가 전부 CSS 토큰만 쓰고 `useIsDark()` 를 읽는 곳이
 * 없어서 JS 쪽으로 모드를 내려 줄 필요도 없다.
 *
 * 세 가지가 이 구현의 모양을 정한다:
 *  - **뿌리에 `text-foreground` 를 반드시 같이 준다.** 커스텀 속성은 *쓰는 자리*에서
 *    풀리므로, `index.css` 의 `body { text-foreground }` 가 이미 **라이트 값으로 계산해
 *    놓은 `color`** 를 자손이 그대로 물려받는다. 즉 변수만 바꾸면 색을 직접 지정한 글자
 *    (git 색이 붙은 파일 이름 등)만 보이고 그냥 물려받는 글자 — 트리의 파일명 · 서비스
 *    이름 · 테이블 이름 · 버튼 라벨 — 은 전부 어두운 배경에 어두운 글자로 사라진다.
 *    뿌리에서 한 번 다시 풀어 주면 그 아래 전체가 따라온다.
 *  - **"다크로 강제"만 있고 "라이트로 강제"는 없다.** 라이트 토큰은 `:root` 에만 있어서
 *    (`.light` 셀렉터가 없다) 다크 앱 안의 한 칸만 밝게 만들 수단이 없고, `.light` 블록을
 *    새로 만들면 그 안의 선언이 프리셋 `<style>` 의 `:root` 상속을 **항상** 이겨서
 *    이 화면만 프리셋을 무시하고 Slack 라이트로 돌아간다. 그래서 앱이 이미 다크면 버튼은
 *    비활성이고(이미 다크다) 켜졌음을 그대로 보여 준다.
 *  - **탭 넘침 목록의 `DropdownMenuContent` 에도 같은 클래스를 준다.** 그 팝업만
 *    포털로 `<body>` 에 붙어 뿌리 카드 밖에 그려지므로, 빠뜨리면 어두운 화면에서 흰
 *    메뉴가 뜬다. 반대로 이 화면의 레이어들(`DialogShell`·`DirtyCloseDialog`)은
 *    `fixed inset-0` 이지만 DOM 상 카드의 자손이라 저절로 따라온다.
 */

/** 세 패널의 기본 크기. `Splitter` 의 더블클릭이 되돌릴 목표값이라 상수로 둔다. */
const TREE_WIDTH = 280
/**
 * 오른쪽 인프라 패널의 기본 폭. **레일 36px 을 포함한 값**이다 — `width` 는 aside
 * 전체에 걸리므로, 예전 폭(280)을 그대로 쓰면 패널 본문이 244px 로 좁아진다.
 */
const INFRA_WIDTH = 316
const DOCK_HEIGHT = 280

/* ─────────────────────────── 작은 부품 ─────────────────────────── */

/**
 * 이 화면의 분할선 — `SplitBar` 에 **더블클릭 기본값 복귀**를 얹은 것.
 *
 * 되돌리기가 필요한 이유는 하나다: 패널을 최소 폭까지 끌어 놓으면 그 안의 내용이 전부
 * 잘려서 다시 넓히려고 겨냥할 5px 손잡이 말고는 아무 단서가 남지 않는다.
 *
 * 두 겹으로 감싸는 이유가 각각 다르다:
 *  - `SplitBar` 에는 `onDoubleClick` 이 없다. 그 부품은 IntelliJ HTTP·ES·Kafka 뷰어도
 *    쓰는 공용 부품이라 이 화면 하나 때문에 손대지 않는다. 감싼 div 도 flex 자식
 *    **하나**이므로 "바가 곧 경계선"이라는 계약은 그대로다 — 안쪽 바가 축 방향으로
 *    늘어나도록 `flex`(가로 바는 `flex-col`)만 얹는다.
 *  - `useResizableWidth`/`useResizableHeight` 는 setter 를 내보내지 않고 값을
 *    `useLocalStorage` 안에 둔다. 같은 창에서 같은 키로 훅을 한 번 더 불러도 두 벌이
 *    서로의 쓰기를 보지 못하므로(`storage` 이벤트는 **다른 창**에서만 온다) 값을
 *    되돌릴 길이 없다. 그래서 localStorage 에 직접 쓰고, 그 훅이 이미 듣고 있는
 *    `storage` 이벤트를 손으로 만들어 알린다. 부수효과도 양성이다 — `setItem` 은 다른
 *    창에 진짜 이벤트를 보내므로 팝아웃 창의 같은 패널도 함께 되돌아간다.
 */
function Splitter({
  orientation,
  resizing,
  onPointerDown,
  storageKey,
  defaultSize,
  label,
}: {
  orientation: "vertical" | "horizontal"
  resizing: boolean
  onPointerDown: (e: ReactPointerEvent) => void
  /** 되돌릴 값이 담긴 localStorage 키 — 크기 훅에 넘긴 것과 **같은 키**여야 한다. */
  storageKey: string
  defaultSize: number
  label: string
}) {
  const reset = () => {
    const raw = JSON.stringify(defaultSize)
    localStorage.setItem(storageKey, raw)
    window.dispatchEvent(
      new StorageEvent("storage", { key: storageKey, newValue: raw })
    )
  }
  return (
    <div
      onDoubleClick={reset}
      title={`${label} — 더블클릭하면 기본값으로`}
      // 클래스 이름을 조립하지 않는다(Tailwind v4 는 소스를 글자로 훑는다).
      className={
        orientation === "vertical" ? "flex shrink-0" : "flex shrink-0 flex-col"
      }
    >
      <SplitBar
        orientation={orientation}
        resizing={resizing}
        onPointerDown={onPointerDown}
        label={label}
      />
    </div>
  )
}

/** 툴바의 아이콘 버튼 — 30×26. 이 화면은 툴바 한 줄이 40px 이라 표준 버튼(32px)이 안 든다. */
function ToolButton({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  /** 눌린 상태로 남는 토글(패널 접기)에만 쓴다. */
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-[26px] w-[30px] shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        active ? "bg-ui-list-hover" : "hover:bg-ui-list-hover",
        disabled && "cursor-default opacity-40 hover:bg-transparent"
      )}
    >
      {children}
    </button>
  )
}

/**
 * 오른쪽 패널의 도구 레일 버튼 하나(36px 레일 안의 28px 정사각).
 *
 * 활성 표시가 셸 레일과 같은 `bg-ui-selection` 인 것은 의도다 — 왼쪽 액티비티바와 같은
 * 관용구라 "이 줄에서 지금 고른 것"이 설명 없이 읽힌다. 브랜드 아이콘은 `<img>` 라서
 * `text-*` 로 색이 바뀌지 않으므로, 활성 신호는 색이 아니라 **배경**이 낸다.
 */
function InfraRailButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid",
        active
          ? "bg-ui-selection text-ui-selection-fg"
          : "text-muted-foreground hover:bg-ui-list-hover hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

/** 탭 아이콘의 타입 — Lucide 아이콘과 브랜드 아이콘(`<img>` 래퍼)을 함께 담는다. */
type TabIcon = ComponentType<{ className?: string }>

/**
 * 탭 종류를 한눈에 — 트리의 확장자 아이콘, 오른쪽 패널의 줄 아이콘과 같은 것을 쓴다
 * (같은 것을 두 곳에서 보므로 아이콘이 다르면 같은 대상으로 읽히지 않는다).
 *
 * 인덱스만 예외로 **브랜드 아이콘**이다: ES 패널의 줄은 아이콘 자리에 health 점을 쓰는데
 * 그 점을 탭에 옮기면 "무슨 탭인지"가 아니라 "초록/노랑"만 보인다.
 */
function tabIcon(tab: DevTab): TabIcon {
  if (tab.kind === "table") return TableIcon
  if (tab.kind === "sql") return TerminalIcon
  if (tab.kind === "esIndex") return ElasticsearchBrandIcon
  if (tab.kind === "kafkaTopic") return LayersIcon
  if (tab.kind === "kafkaGroups") return UsersIcon
  if (tab.kind === "kafkaBrokers") return ServerIcon
  if (isHttpFile(tab.path)) return GlobeIcon
  // 트리에서 `.md` 에 쓰는 것과 같은 아이콘 — 마크다운 탭은 코드가 아니라 문서다.
  if (isMarkdownFile(tab.path)) return FileTextIcon
  return FileCodeIcon
}

/**
 * 툴팁·빵부스러기에 쓸 "이 탭이 무엇인지" 한 줄.
 *
 * 인프라 탭에 `es /`·`kafka /` 접두사를 붙이는 이유: 인덱스 이름과 토픽 이름은 둘 다
 * 평범한 소문자 낱말이라, 빵부스러기에 이름만 있으면 어느 도구의 것인지 알 수 없다.
 * 빵부스러기는 이 문자열을 `/` 로 잘라 그리므로 그 자리에서 한 칸이 더 생긴다.
 */
function tabPath(tab: DevTab): string {
  if (tab.kind === "file") return tab.rel
  if (tab.kind === "table")
    return [tab.table.catalog, tab.table.schema, tab.table.name]
      .filter(Boolean)
      .join(" / ")
  if (tab.kind === "sql") return `${tab.connId} / 쿼리 콘솔`
  if (tab.kind === "esIndex") return `es / ${tab.index}`
  if (tab.kind === "kafkaTopic") return `kafka / ${tab.topic}`
  if (tab.kind === "kafkaGroups") return "kafka / 컨슈머 그룹"
  return "kafka / 브로커"
}

/** 경로의 마지막 조각(프로젝트 칩). 끝의 슬래시는 떼고 본다. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed
}

/**
 * 파일을 못 읽었을 때 편집기 **대신** 그리는 칸.
 *
 * 빈 편집기를 띄우면 안 되는 이유가 이 부품의 존재 이유다: 읽기가 실패한 버퍼는
 * `text`·`saved` 가 빈 문자열이라 "빈 파일"과 구분이 안 되고, 거기에 타자를 치고 ⌘S 를
 * 누르면(파일만 이름이 바뀐 경우엔 저장이 성공해서) 원본이 그 몇 글자로 덮어써진다.
 * 트리가 낡아 있을 때(밖에서 폴더·파일을 옮긴 뒤)와 설정 → Cowork 의 저장소 경로를
 * 바꿨을 때(옛 루트의 탭은 새 루트 밖이라 Rust 가 거절한다) 자연스럽게 벌어지는 일이라,
 * **다시 시도**와 **탭 닫기**를 같이 둔다 — 루트가 바뀌었을 때 탭을 자동으로 닫지 않는
 * 이유가 여기 걸려 있다(경로 칸은 입력 상자라 중간값마다 루트 교체로 들어온다).
 */
function LoadFailed({
  message,
  onRetry,
  onClose,
}: {
  message: string
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertTriangleIcon className="size-8 text-ui-error/60" />
      <div className="text-[15px] font-bold">파일을 열 수 없습니다</div>
      <p className="max-w-md text-[13px] whitespace-pre-wrap text-muted-foreground">
        {message}
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCwIcon />
          다시 시도
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <XIcon />탭 닫기
        </Button>
      </div>
    </div>
  )
}

/**
 * 인프라 탭을 아직 그릴 수 없을 때(연결 없음) 그 자리에 놓는 칸.
 *
 * `IndexPane`·`TopicPane`·`GroupsPane` 의 `client` 는 **필수 prop** 이라 연결 없이는
 * 컴포넌트를 만들 수가 없다. 그렇다고 연결 없이는 탭을 못 열게 하거나 열린 탭을 자동으로
 * 닫으면 안 된다 — 탭 목록은 localStorage 라 자동 연결이 꺼져 있으면 앱을 켠 직후가
 * 항상 이 상태이고, 그때 탭이 사라지면 어제 보던 것이 통째로 없어진다.
 *
 * 겹쳐 놓이는 자리이므로 다른 패널과 같은 계약(`absolute inset-0` + `invisible`)을 지킨다.
 */
function NotConnected({
  active,
  icon: Icon,
  label,
  onConnect,
}: {
  active: boolean
  icon: TabIcon
  label: string
  onConnect: () => void
}) {
  return (
    <div
      aria-hidden={!active}
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-2 p-8 text-center",
        !active && "invisible"
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-[10px] bg-muted">
        <Icon className="size-6" />
      </span>
      <div className="text-[15px] font-bold">
        {label}에 연결되어 있지 않습니다
      </div>
      <p className="max-w-sm text-[13px] text-muted-foreground">
        오른쪽 패널의 플러그 아이콘 또는 아래 버튼으로 연결하면 이 탭이 그대로
        살아납니다. 접속 설정의 <b>자동 연결</b>을 켜 두면 화면을 열 때 바로
        붙습니다.
      </p>
      <Button size="sm" onClick={onConnect}>
        <PlugIcon />
        연결
      </Button>
    </div>
  )
}

/* ─────────────────────── 저장하지 않은 편집 ─────────────────────── */

/**
 * 수정 중인 파일 탭을 닫으려 할 때의 확인 레이어.
 *
 * `useFileBuffers.close` 는 화면을 모르기 때문에 "수정 중이라 못 버렸다"만 알려 준다.
 * 여기서 묻는 이유는 두 가지다: 조용히 버리면 탭의 X 한 번에 편집이 사라지고, 웹뷰의
 * `confirm()` 은 이 앱 어디서도 쓰지 않는 네이티브 모달이라 화면과 따로 논다.
 */
function DirtyCloseDialog({
  name,
  onSave,
  onDiscard,
  onCancel,
}: {
  name: string
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-sm flex-col gap-3 rounded-[10px] border border-border bg-card p-4 shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
      >
        <div className="text-[18px] font-bold tracking-[-0.01em]">
          저장하지 않은 변경이 있습니다
        </div>
        <p className="text-[13px] text-muted-foreground">
          <span className="font-bold text-foreground">{name}</span> 을(를) 닫기
          전에 저장할까요?
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            취소
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-ui-error hover:text-ui-error"
            onClick={onDiscard}
          >
            저장하지 않고 닫기
          </Button>
          <Button size="sm" onClick={onSave}>
            저장 후 닫기
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── 접속 관리 레이어 ───────────────────────── */

/**
 * 세 도구가 함께 쓰는 레이어 껍데기 — 어두운 배경 + 카드 + 제목줄.
 *
 * 접속 편집을 오른쪽 패널 안에 상시로 두지 않는 이유(세 도구 공통): 그 패널은 280px
 * 남짓이라 엔진·호스트·포트·계정이 세로로 늘어서면 정작 목록이 안 보인다. 접속 정보를
 * 고치는 일은 드물고 목록을 누르는 일은 잦으니, 드문 쪽을 레이어로 뺀다.
 */
function DialogShell({
  title,
  onClose,
  headerExtra,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  /** 제목줄 오른쪽에 끼울 버튼(DB 의 "새 접속" 처럼). */
  headerExtra?: React.ReactNode
  children: React.ReactNode
  /** DB 는 엔진·jar 목록까지 들어가 한 단계 넓은 카드를 쓴다. */
  wide?: boolean
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex max-h-full w-full flex-col overflow-hidden rounded-[10px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.16)]",
          wide ? "max-w-lg" : "max-w-md"
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1 truncate text-[18px] font-bold tracking-[-0.01em]">
            {title}
          </div>
          {headerExtra}
          <Button size="icon-sm" variant="ghost" onClick={onClose} title="닫기">
            <XIcon className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-sidebar p-4">
          {children}
        </div>
      </div>
    </div>
  )
}

/** 데이터베이스 접속 관리 — 데이터베이스 뷰어의 왼쪽 카드와 같은 폼을 레이어로 띄운다. */
function ConnectionsDialog({
  session,
  connections,
  setConnections,
  connId,
  onSelectConn,
  onClose,
}: {
  session: ReturnType<typeof useDbSession>
  /**
   * 목록은 **루트에게서 받는다.** 여기서 `useDbConnections()` 를 다시 부르면 안 된다 —
   * 프로바이더가 없는 창(팝아웃)에서는 훅이 자기 몫의 `useLocalStorage` 로 물러나는데,
   * 같은 창 안의 두 인스턴스는 서로의 쓰기를 통보받지 못한다(`storage` 이벤트는 다른
   * 창에서만 온다). 그러면 여기서 만든 접속을 루트가 못 보고, 루트는 엉뚱한 접속에
   * 연결한다.
   */
  connections: DbConnection[]
  setConnections: Dispatch<SetStateAction<DbConnection[]>>
  connId: string | null
  onSelectConn: (id: string) => void
  onClose: () => void
}) {
  const conn = connections.find((c) => c.id === connId) ?? null

  const add = () => {
    const c = newConnection()
    setConnections((prev) => [...prev, c])
    onSelectConn(c.id)
  }

  const remove = () => {
    if (!conn) return
    const id = conn.id
    void db.forgetPassword(id).catch(() => {
      // 저장된 비밀번호가 없으면 그냥 넘어간다.
    })
    if (session.info) void session.disconnect()
    setConnections((prev) => prev.filter((c) => c.id !== id))
    onSelectConn(connections.find((c) => c.id !== id)?.id ?? "")
  }

  return (
    <DialogShell
      title="접속 관리"
      onClose={onClose}
      wide
      headerExtra={
        <Button size="icon-sm" variant="ghost" onClick={add} title="새 접속">
          <PlusIcon className="size-4" />
        </Button>
      }
    >
      {connections.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          저장된 접속이 없습니다. 위의 <b>+</b> 로 만드세요.
        </p>
      ) : (
        <>
          <select
            value={conn?.id ?? ""}
            onChange={(e) => onSelectConn(e.target.value)}
            className="h-8 w-full rounded-lg border border-input bg-background px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {engineById(c.engine).label}
              </option>
            ))}
          </select>

          {conn && (
            <ConnectionForm
              key={conn.id}
              conn={conn}
              onChange={(patch) =>
                setConnections((prev) =>
                  prev.map((c) => (c.id === conn.id ? { ...c, ...patch } : c))
                )
              }
              onDelete={remove}
              onConnect={(pw) => void session.connect(pw)}
              onDisconnect={() => void session.disconnect()}
              connecting={session.connecting}
              info={session.info}
              error={session.connError}
            />
          )}
        </>
      )}
    </DialogShell>
  )
}

/**
 * Elasticsearch 접속 설정 — `es-viewer-view.tsx` 의 "연결 정보" 카드를 그대로 옮긴 것.
 *
 * 접속 정보를 `useEsConn()` 으로 직접 읽는다(DB 처럼 prop 으로 받지 않는다). ES 설정은
 * **목록이 아니라 하나**이고 프로바이더가 `App.tsx`·`ViewWindowRoot` 양쪽에 걸려 있어
 * 이 화면·ES 패널·세션 훅이 모두 같은 컨텍스트 값을 본다 — 갈라질 여지가 없다.
 * (`useDbConnections` 는 프로바이더가 없을 때 `useLocalStorage` 로 물러나므로 위쪽
 * `ConnectionsDialog` 만 prop 을 받는다.)
 */
function EsConnDialog({
  session,
  onClose,
}: {
  session: ReturnType<typeof useEsSession>
  onClose: () => void
}) {
  const { conn, setConn } = useEsConn()
  const patch = (p: Partial<typeof conn>) => setConn({ ...conn, ...p })

  return (
    <DialogShell title="Elasticsearch 접속" onClose={onClose}>
      <Input
        value={conn.host}
        placeholder="호스트 (예: 172.16.120.191)"
        onChange={(e) => patch({ host: e.target.value })}
      />
      <div className="flex items-center gap-2">
        <Input
          type="number"
          value={conn.port ?? ""}
          placeholder="포트"
          onChange={(e) =>
            patch({
              port: e.target.value ? parseInt(e.target.value, 10) : null,
            })
          }
          className="w-24"
        />
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={conn.https}
            onChange={(e) => patch({ https: e.target.checked })}
          />
          HTTPS
        </label>
      </div>
      <Input
        value={conn.username}
        placeholder="아이디 (선택)"
        onChange={(e) => patch({ username: e.target.value })}
      />
      <Input
        type="password"
        value={conn.password}
        placeholder="비밀번호 (선택)"
        onChange={(e) => patch({ password: e.target.value })}
      />
      <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <input
          type="checkbox"
          checked={conn.autoConnect}
          onChange={(e) => patch({ autoConnect: e.target.checked })}
        />
        자동 연결 (다음 실행 시 자동 접속)
      </label>
      {/* 이 값은 Elasticsearch 뷰어와 **공유**한다 — 설정이 하나뿐이라 사본을 두면 어느
          클러스터를 보고 있는지 화면마다 달라진다(`es-conn-store.tsx` 주석 참고). */}
      <p className="text-[11px] text-muted-foreground">
        이 접속 정보는 <b>Elasticsearch 뷰어</b>와 같은 것을 씁니다.
      </p>
      <Button
        size="sm"
        disabled={session.connecting}
        onClick={() => void session.connect()}
      >
        <PlugIcon />
        {session.connecting ? "연결 중…" : session.client ? "재연결" : "연결"}
      </Button>
      {session.cluster && (
        <div className="rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[13px] text-ui-success">
          ✓ 연결됨 · {session.cluster}
        </div>
      )}
      {session.connError && (
        <div className="rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
          {session.connError}
        </div>
      )}
    </DialogShell>
  )
}

/** Kafka 접속 설정 — `kafka-viewer-view.tsx` 의 "연결 정보" 카드를 그대로 옮긴 것. */
function KafkaConnDialog({
  session,
  onClose,
}: {
  session: ReturnType<typeof useKafkaSession>
  onClose: () => void
}) {
  const { conn, setConn } = useKafkaConn()
  const patch = (p: Partial<typeof conn>) => setConn({ ...conn, ...p })

  return (
    <DialogShell title="Kafka 접속" onClose={onClose}>
      <Input
        value={conn.brokers}
        placeholder="브로커 (예: 172.16.0.10:9092)"
        onChange={(e) => patch({ brokers: e.target.value })}
        onKeyDown={(e) => e.key === "Enter" && void session.connect()}
      />
      <p className="text-[11px] text-muted-foreground">
        PLAINTEXT 전용. 여러 대는 쉼표로 구분합니다.
      </p>
      <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <input
          type="checkbox"
          checked={conn.autoConnect}
          onChange={(e) => patch({ autoConnect: e.target.checked })}
        />
        자동 연결 (다음 실행 시 자동 접속)
      </label>
      <p className="text-[11px] text-muted-foreground">
        이 접속 정보는 <b>Kafka 뷰어</b>와 같은 것을 씁니다.
      </p>
      <Button
        size="sm"
        disabled={session.connecting}
        onClick={() => void session.connect()}
      >
        <PlugIcon />
        {session.connecting ? "연결 중…" : session.client ? "재연결" : "연결"}
      </Button>
      {session.cluster && (
        <div className="rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[13px] text-ui-success">
          ✓ 브로커 {session.cluster.brokers.length}대 · 토픽{" "}
          {session.cluster.topicCount}개
        </div>
      )}
      {session.connError && (
        <div className="rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
          {session.connError}
        </div>
      )}
    </DialogShell>
  )
}

/* ─────────────────────────── 본체 ─────────────────────────── */

export function CoworkDevView() {
  const { settings } = useSettings()
  // 저장소 경로는 설정 하나(설정 → Cowork)로 통일돼 있다 — 스펙 문서 뷰·Git·Cowork
  // 서비스가 전부 같은 값을 본다. 여기서 또 고를 수 있게 하면 어느 것이 진짜인지 흐려진다.
  const home = settings.cowork.home.trim()

  /* ── 네 영역이 함께 쓰는 상태 ── */
  const tabs = useDevTabs()
  const tree = useProjectTree(home)
  const buffers = useFileBuffers(home)
  const http = useHttpRun(home)
  const services = useServices("standalone")

  const { connections, setConnections } = useDbConnections()
  // 어느 접속을 골랐는지는 **화면마다 다른 값**이다(데이터베이스 뷰어에서 운영 DB 를
  // 보는 동안 여기서는 로컬 DB 를 붙여 둘 수 있어야 한다 — 접속 목록 컨텍스트의 머리말 참고).
  const [pickedConnId, setPickedConnId] = useLocalStorage<string | null>(
    `${NS}.dbConn`,
    null
  )
  const conn = useMemo(
    () =>
      connections.find((c) => c.id === pickedConnId) ?? connections[0] ?? null,
    [connections, pickedConnId]
  )
  const session = useDbSession(conn)
  // ES·Kafka 세션도 **여기서 하나씩만** 만든다. 인덱스·토픽 목록의 주인이 오른쪽 패널이
  // 아니라 이 루트인 것이 요점이다 — 가운데 탭(`IndexPane`·`TopicPane`)이 `meta` 를
  // 받는데 그 탭을 마운트하는 쪽이 루트라, 패널이 목록을 들면 탭 머리 요약이 빈다.
  const es = useEsSession()
  const kafka = useKafkaSession()

  /** 오른쪽 칸이 지금 어느 도구를 보여 주는지. 연 탭은 도구와 무관하게 가운데에 남는다. */
  const [tool, setTool] = useLocalStorage<InfraTool>(`${NS}.infraTool`, "db")
  const [manageOpen, setManageOpen] = useState(false)
  const [esManageOpen, setEsManageOpen] = useState(false)
  const [kafkaManageOpen, setKafkaManageOpen] = useState(false)

  const [dockTab, setDockTab] = useState<DockTab>("output")
  /** 커서가 놓인 `.http` 요청의 결과 키 — 아래 독의 응답 칸과 툴바 ▶ 가 함께 본다. */
  const [httpKey, setHttpKey] = useState<string | null>(null)
  /** 수정 중인 채로 닫으려던 파일 탭. */
  const [dirtyClose, setDirtyClose] = useState<DevTab | null>(null)
  /** 툴바 ■ 의 확인 레이어 — 아이콘 하나라 옆 버튼을 노리다 잘못 누르기 쉽다. */
  const [stopAllOpen, setStopAllOpen] = useState(false)
  /** ⌄ 탭 목록 드롭다운. */
  const [listOpen, setListOpen] = useState(false)

  /* ── 패널 크기·접힘 ── */
  const treeSize = useResizableWidth(`${NS}.treeWidth`, TREE_WIDTH, 180, 520)
  // 폭이 레일(36px)까지 포함하므로 최소값도 그만큼 올려 잡는다 — 200 이면 본문이 164px 로
  // 남아 스키마 `<select>` 두 개가 겹친다. 키를 `dbWidth` 에서 바꾼 것도 같은 이유다:
  // 예전에 저장된 폭은 "본문만"의 값이라 그대로 쓰면 레일만큼 좁아진 채로 시작한다.
  const infraSize = useResizableWidth(
    `${NS}.infraWidth`,
    INFRA_WIDTH,
    236,
    596,
    "rtl"
  )
  /**
   * 독 높이의 상한 — 창 높이에서 편집기 몫을 뺀 값.
   *
   * 마운트 때 한 번만 읽던 값이었는데, 그러면 세로가 700px 인 창에서 상한이 기본값(280)과
   * 같아져 위로 끌어도 아무 일이 없고, 560px 아래에서는 상한이 기본값보다 **작아서**
   * 손잡이를 건드리는 순간 독이 140 으로 튄다. 그래서 (1) 천장을 `innerHeight - 260` 으로
   * 올리고 (2) 창 크기 변경을 듣는다. 렌더 본문에서 읽으면 `react-hooks/purity` 에 걸리므로
   * 계산은 effect 안에서만 한다. 바닥(320)은 기본값보다 커야 한다 — 위 (2)번 증상이 그
   * 조건이 깨졌을 때 나오는 것이다.
   */
  const [dockMax, setDockMax] = useState(() =>
    Math.max(320, window.innerHeight - 260)
  )
  useEffect(() => {
    const onResize = () => setDockMax(Math.max(320, window.innerHeight - 260))
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const dockSize = useResizableHeight(
    `${NS}.dockHeight`,
    DOCK_HEIGHT,
    140,
    dockMax
  )
  // 키는 예전 이름을 그대로 둔다 — 접기 상태를 옮기려고 마이그레이션을 붙일 값이 아니다.
  const [dbCollapsed, setDbCollapsed] = useLocalStorage<boolean>(
    `${NS}.dbCollapsed`,
    false
  )
  const [dockCollapsed, setDockCollapsed] = useLocalStorage<boolean>(
    `${NS}.dockCollapsed`,
    false
  )

  // 이 화면만의 다크 모드. 토글은 뷰 헤더(제목 "IntelliJ Cowork" 옆)에 있고 우리는 값만
  // 읽는다 — 그래서 컨텍스트다(`dev-dark-store.tsx` 머리말 참고).
  const { dark } = useDevDark()

  /* ── git 상태 ──
     `useGit` 을 쓰지 않는다. 그쪽은 탭이 열려 있는 내내 5초마다 `git status
     --untracked-files=all` 을 도는데, cowork 저장소에서 그건 브랜치 이름과 트리 색을 위해
     너무 비싸다(이 화면은 켜 두는 화면이다). 그래서 한 번만 읽고, 툴바의 새로고침이
     다시 읽는다.

     **`GitStatus` 를 통째로 들고 있는다**(예전에는 브랜치 문자열만 남기고 버렸다).
     트리의 파일 색(`buildGitMarks`)이 같은 응답에서 나오므로 **추가 IPC 가 하나도 없다** —
     그래서 색을 위해 폴링을 붙일 이유도 없다(붙이면 위 판단이 그대로 깨진다). */
  const [git, setGit] = useState<GitStatus | null>(null)
  const loadGit = useCallback(async () => {
    if (!isTauri() || home === "") {
      setGit(null)
      return
    }
    try {
      setGit(await gitStatus(home))
    } catch {
      // git 저장소가 아니어도 이 화면의 나머지는 멀쩡히 동작한다 — 칩과 색만 빠진다.
      setGit(null)
    }
  }, [home])

  useEffect(() => {
    // 진입/저장소 변경 시 한 번 읽는다(데이터 페칭 목적의 의도된 setState).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGit()
  }, [loadGit])

  const branch = git
    ? git.detached
      ? `${git.branch} (detached)`
      : git.branch
    : null
  /** `절대 경로` → 색. 새로고침마다 새 `Map` 이라 트리가 통째로 리렌더되는데, 계기가
   *  수동(툴바 버튼)뿐이라 감당할 수 있는 비용이다(`git-marks.ts` 머리말 참고). */
  const marks = useMemo(() => buildGitMarks(git), [git])

  /* ── 탭 ↔ 버퍼 ── */
  const activeTab = tabs.activeTab
  const activePath = activeTab?.kind === "file" ? activeTab.path : null
  const { load: loadBuffer } = buffers

  useEffect(() => {
    // 앱을 다시 켜면 탭은 localStorage 에서 복원되지만 버퍼는 비어 있다. `load` 는
    // 멱등이라(이미 있으면 아무것도 하지 않는다) 활성화 때마다 불러도 안전하다.
    if (activePath) void loadBuffer(activePath)
  }, [activePath, loadBuffer])

  /* ── 탭 줄의 넘침 ──
     탭은 좁아지지 않는 대신 줄이 넘치면 가로로 스크롤되므로, 화면 밖으로 밀려난 탭을
     ⌄ 목록으로 꺼내 준다(셸 탭 줄과 같은 훅·같은 계약). 활성 탭을 보이는 자리로
     끌어오는 일은 훅이 이미 한다 — 없으면 목록에서 고른 탭이 계속 가려진 채 남는다. */
  const tabIds = useMemo(() => tabs.tabs.map((t) => t.id), [tabs.tabs])
  const { scrollRef, tabRef, overflowing, hiddenIds, measure } = useTabOverflow(
    tabIds,
    tabs.activeId
  )

  /* ── 저장소 루트가 바뀌면 옛 탭은 어떻게 되는가 ──
     **탭을 자동으로 닫지 않는다.** 설정 → Cowork 의 경로 칸은 입력 상자라 타자 한 글자마다
     이 값이 바뀌고, 그 중간값(`/Users/x/git` 처럼 실재하는 상위 폴더까지) 하나하나가 루트
     교체로 들어온다 — 거기서 탭을 닫으면 경로를 고쳐 쓰는 동작이 열어 둔 것을 통째로
     지우는 일이 된다(탭 목록은 localStorage 라 되돌릴 수도 없다).

     대신 두 가지로 해결한다: 저장하지 않은 편집은 `useFileBuffers` 가 루트 교체에서도
     **남기고**(그쪽 머리말 참고), 새 루트 밖이라 읽을 수 없는 탭은 아래 `LoadFailed` 가
     사유와 함께 **다시 시도 · 탭 닫기**를 내보낸다. 지우는 판단은 사용자가 한다. */

  /* ── 실행 → 아래 독 ──
     두 전환 모두 "밖에서 일어난 일"을 따라가는 것이라 effect 가 맞다. 요청은 가운데 탭의
     거터 ▶ 로도, 툴바 ▶ 로도, 전체 실행으로도 시작되고 서비스는 독의 행에서도 시작되는데,
     그 호출부를 전부 감싸는 대신 결과 신호 하나씩만 본다. */
  /* 신호는 **키가 아니라 실행 순번이 붙은 객체**여야 한다(`useHttpRun` 의 머리말 참고).
     키만 보면 같은 요청을 다시 보낼 때 값이 그대로라 이펙트가 돌지 않고, 출력 탭을 보던
     중이면 ▶ 를 눌러도 화면이 아무 반응을 하지 않는다. */
  const lastRun = http.lastRun
  useEffect(() => {
    if (!lastRun) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDockTab("response")
  }, [lastRun])

  const pendingCount = services.pending.size
  const prevPending = useRef(pendingCount)
  useEffect(() => {
    const grew = pendingCount > prevPending.current
    prevPending.current = pendingCount
    if (!grew) return
    // 서비스를 하나 띄우기 시작했다 — 부팅 로그를 보려고 이 화면을 열어 둔 것이므로
    // 콘솔을 출력으로 되돌린다.
    setDockTab("output")
  }, [pendingCount])

  /* ── 열기 ── */
  const openFile = useCallback(
    (entry: DevEntry) => {
      tabs.open({
        kind: "file",
        id: fileTabId(entry.path),
        path: entry.path,
        rel: entry.rel,
        name: entry.name,
      })
      void buffers.load(entry.path)
    },
    [tabs, buffers]
  )

  const openTable = useCallback(
    (t: db.TableRef) => {
      if (!conn) return
      tabs.open({
        kind: "table",
        id: tableTabId(conn.id, t),
        connId: conn.id,
        table: t,
        name: t.name,
      })
    },
    [tabs, conn]
  )

  const openSql = useCallback(() => {
    if (!conn) return
    tabs.open({
      kind: "sql",
      id: sqlTabId(conn.id),
      connId: conn.id,
      name: `${conn.name} 콘솔`,
    })
  }, [tabs, conn])

  const openEsIndex = useCallback(
    (index: string) => {
      tabs.open({
        kind: "esIndex",
        id: esIndexTabId(index),
        index,
        name: index,
      })
    },
    [tabs]
  )

  const openKafkaTopic = useCallback(
    (topic: string) => {
      tabs.open({
        kind: "kafkaTopic",
        id: kafkaTopicTabId(topic),
        topic,
        name: topic,
      })
    },
    [tabs]
  )

  const openKafkaGroups = useCallback(() => {
    tabs.open({
      kind: "kafkaGroups",
      id: KAFKA_GROUPS_TAB_ID,
      name: "컨슈머 그룹",
    })
  }, [tabs])

  const openKafkaBrokers = useCallback(() => {
    tabs.open({
      kind: "kafkaBrokers",
      id: KAFKA_BROKERS_TAB_ID,
      name: "브로커",
    })
  }, [tabs])

  /* ── 닫기 ── */
  const closeTab = useCallback(
    (id: string) => {
      const tab = tabs.tabs.find((t) => t.id === id)
      // 파일 탭은 버퍼가 먼저 판단한다 — 수정 중이면 버리지 않고 false 를 돌려준다.
      if (tab?.kind === "file" && !buffers.close(tab.path)) {
        setDirtyClose(tab)
        return
      }
      tabs.close(id)
    },
    [tabs, buffers]
  )

  /**
   * 여러 탭을 한 번에 닫는다 — ⌄ 목록의 **다른 탭 닫기 · 모두 닫기**가 쓰는 유일한 길.
   *
   * `tabs.closeAll`/`tabs.closeOthers` 를 그대로 걸면 안 된다: 그 둘은 `closeTab` 을
   * 지나가지 않으므로 `buffers.close()` 에 물어보지 않고, 저장하지 않은 편집이 확인 한
   * 번 없이 클릭 하나로 사라진다.
   *
   * 그래서 **깨끗한 탭은 지금 닫고, 수정 중인 것은 첫 하나만 확인 레이어로 세운다.**
   * 한 번에 여러 개를 물으면 레이어가 큐가 되어야 하는데(취소하면 어디까지 취소인지,
   * 저장 후 닫기를 누르면 나머지도 저장인지 정할 것이 늘어난다), 여기서 필요한 것은
   * "실수로 날리지 않는다" 하나다 — 남은 수정 중 탭은 그대로 남으므로 같은 항목을 다시
   * 누르면 다음 것을 묻는다.
   *
   * `closeMany` 로 한 번에 지우는 것도 규칙이다 — `close` 를 반복해 부르면 각 호출이 같은
   * 렌더의 배열에서 자기 하나만 뺀 새 배열을 써서 마지막 호출이 앞의 것들을 되살린다.
   */
  const closeGroup = useCallback(
    (ids: string[]) => {
      const drop = new Set(ids)
      const clean: string[] = []
      let firstDirty: DevTab | null = null
      for (const tab of tabs.tabs) {
        if (!drop.has(tab.id)) continue
        if (tab.kind === "file" && buffers.dirty(tab.path)) {
          firstDirty ??= tab
          continue
        }
        // 파일 탭은 버퍼도 함께 놓아 준다 — 탭만 지우면 읽어 둔 본문이 남는다.
        if (tab.kind === "file") buffers.close(tab.path)
        clean.push(tab.id)
      }
      tabs.closeMany(clean)
      if (firstDirty) setDirtyClose(firstDirty)
    },
    [tabs, buffers]
  )

  /* ── 트리의 파일 조작(우클릭 메뉴) ──
     `useFileOps` 는 디스크만 알고 탭·버퍼는 모른다. 그 둘을 아는 것은 여기뿐이라,
     "이 경로의 탭을 놓아 줘도 되는가" 라는 판단 하나를 훅에 내려 준다. */

  /**
   * 지울/옮길 경로 아래의 파일 탭을 정리한다(폴더면 그 안까지).
   *
   * **저장하지 않은 편집이 하나라도 있으면 아무것도 닫지 않는다.** 여기서 `DirtyCloseDialog`
   * 를 띄우지 않는 이유는 그 레이어의 "저장 후 닫기" 가 방금 지우려는 파일을 되살리기
   * 때문이다 — 그래서 조작 자체를 중단하고 훅이 사유를 알린다.
   */
  const releaseTabs = useCallback(
    (abs: string) => {
      const hit = tabs.tabs.filter(
        (t): t is Extract<DevTab, { kind: "file" }> =>
          t.kind === "file" && (t.path === abs || t.path.startsWith(`${abs}/`))
      )
      const dirty = hit.filter((t) => buffers.dirty(t.path)).map((t) => t.name)
      if (dirty.length > 0) return { dirty, closed: 0 }
      // 탭만 지우면 읽어 둔 본문이 남는다(`closeGroup` 과 같은 규칙).
      hit.forEach((t) => buffers.close(t.path))
      tabs.closeMany(hit.map((t) => t.id))
      return { dirty, closed: hit.length }
    },
    [tabs, buffers]
  )

  const fileOps = useFileOps({
    root: home,
    refreshDir: tree.refresh,
    openEntry: openFile,
    releaseTabs,
  })

  /* ── 트랜잭션 대상 ──
     커밋·롤백·자동 커밋은 **접속**의 동작이라, 어느 접속인지는 지금 보고 있는 탭이
     정한다: 격자·콘솔 탭이면 그 탭의 접속, 아니면 오른쪽 패널에서 고른 접속. 툴바가
     늘 "고른 접속"만 보면 다른 접속의 격자를 보면서 엉뚱한 접속을 커밋하게 된다.

     자동 커밋 스위치는 **세션이 있을 때만** 내보인다 — 세션이 없으면 그 값은 우리가 모르는
     추측(기본값 `true`)이라, 그걸로 스위치를 그리면 화면이 거짓말을 한다. 반면 커밋·롤백은
     "커밋되지 않은 변경이 있다"는 사실만으로도 내보내야 한다: 다른 화면이 연 접속의 격자를
     여기서 편집한 경우가 그렇고, 그때 버튼이 없으면 그 변경은 앱을 닫는 순간 롤백된다. */
  const txConnId =
    activeTab && (activeTab.kind === "table" || activeTab.kind === "sql")
      ? activeTab.connId
      : (conn?.id ?? null)
  const txLive = txConnId !== null && session.hasSession(txConnId)
  const txAutoCommit = txConnId ? session.autoCommitFor(txConnId) : true
  const txDirty = txConnId ? session.txDirtyFor(txConnId) : false
  const txName = txConnId
    ? (connections.find((c) => c.id === txConnId)?.name ?? txConnId)
    : ""

  /* ── 툴바 동작 ── */

  /**
   * ▶ 실행 — 지금 탭이 `.http` 면 **커서가 놓인 요청**을 보낸다.
   *
   * 서비스 실행은 여기 붙이지 않았다. 어느 서비스를 띄울지는 아래 독의 목록이 들고 있는
   * 선택인데, 그걸 여기로 끌어올리면 같은 값이 두 군데에 생겨 목록의 하이라이트와 툴바가
   * 어긋난다. 서비스는 독의 ▶(행 · 헤더)로 띄운다.
   */
  const runActive = useCallback(() => {
    const tab = tabs.activeTab
    if (!tab || tab.kind !== "file" || !isHttpFile(tab.path)) return
    const text = buffers.buffers[tab.path]?.text ?? ""
    const reqs = parseHttpFile(text).requests
    if (reqs.length === 0) return
    const prefix = `${tab.path}#`
    const idx = httpKey?.startsWith(prefix)
      ? Number(httpKey.slice(prefix.length))
      : null
    // 커서 위치를 모르면 첫 요청 — 아무것도 안 보내는 것보다 낫다.
    void http.run(reqs.find((r) => r.index === idx) ?? reqs[0], tab.path)
  }, [tabs, buffers, http, httpKey])

  const canRun =
    activeTab?.kind === "file" &&
    isHttpFile(activeTab.path) &&
    (buffers.buffers[activeTab.path]?.text ?? "") !== ""

  /** ⌫ — HTTP 응답과 쌓아 둔 서비스 로그를 함께 비운다(콘솔 두 탭이 한 버튼이다). */
  const clearConsoles = useCallback(() => {
    http.clear()
    // 로그가 있는 것만 부른다 — 설정이 17개쯤 되는데 전부 부르면 빈 IPC 가 그만큼 나간다.
    Object.keys(services.logs).forEach((name) => services.clearLogs(name))
  }, [http, services])

  /** 새로고침 — 트리와 지금 보고 있는 파일, 그리고 git 상태(브랜치 + 트리 색). */
  const refreshAll = useCallback(() => {
    void tree.reload()
    void loadGit()
    // 수정 중인 파일은 건드리지 않는다 — 되읽으면 편집이 예고 없이 사라진다.
    if (activePath && !buffers.dirty(activePath))
      void buffers.load(activePath, true)
  }, [tree, loadGit, activePath, buffers])

  /** 컨슈머 그룹 패널이 받는 토픽 이름 목록 — 새 배열이 매 렌더 가면 그쪽 조회가 다시 돈다. */
  const kafkaTopicNames = useMemo(
    () => kafka.topics.filter((t) => !t.internal).map((t) => t.name),
    [kafka.topics]
  )

  /* ─────────────── 쓸 수 없는 상태 ─────────────── */

  if (!isTauri()) {
    return (
      <div className="py-8 text-center text-[15px] text-muted-foreground">
        데스크톱 앱에서만 사용할 수 있습니다.
      </div>
    )
  }

  if (home === "") {
    return (
      <div className="rounded-[10px] border border-border bg-card p-5 shadow-[0_1px_3px_rgba(0,0,0,0.06)]">
        <div className="text-[15px] font-bold">저장소 경로가 없습니다</div>
        <p className="mt-2 text-[13px] text-muted-foreground">
          설정 → Cowork 의 <span className="font-mono">cowork 홈 디렉터리</span>{" "}
          를 지정하세요. 이 화면의 파일 트리 · 서비스 ·{" "}
          <span className="font-mono">.http</span> 실행이 모두 그 한 경로를
          기준으로 동작합니다.
        </p>
      </div>
    )
  }

  /* ─────────────── 화면 ─────────────── */

  return (
    <div
      className={cn(
        // `text-foreground` 는 장식이 아니다 — 이것이 없으면 색을 직접 지정하지 않은
        // 글자가 전부 보이지 않는다(머리말의 두 번째 규칙).
        "flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-card text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.06)]",
        // 이 한 줄이 "이 화면만 다크" 의 전부다 — 토큰도, 자식들의 `dark:` 유틸리티도
        // 여기서 갈린다(머리말 참고).
        dark && "dark"
      )}
    >
      {/* ── (a) 툴바 ── */}
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <span
          className="flex h-6 min-w-0 shrink items-center gap-1.5 rounded-lg bg-muted px-2 text-[13px] font-bold"
          title={home}
        >
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{basename(home)}</span>
        </span>

        {branch && (
          <span
            className="flex min-w-0 shrink items-center gap-1 text-[12px] text-muted-foreground"
            title="현재 브랜치(새로고침할 때 다시 읽습니다)"
          >
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <ToolButton
            title={
              canRun
                ? "실행 — 커서가 놓인 요청을 보냅니다"
                : "실행할 수 있는 .http 탭이 아닙니다(서비스는 아래 독의 ▶ 로 띄웁니다)"
            }
            disabled={!canRun}
            onClick={runActive}
          >
            <PlayIcon
              className={cn(
                "size-3.5 fill-current",
                canRun ? "text-ui-success" : "text-muted-foreground"
              )}
            />
          </ToolButton>
          <ToolButton
            title={
              services.stoppableRunning.length > 0
                ? `실행 중인 서비스 ${services.stoppableRunning.length}개를 모두 내립니다(확인 후)`
                : "종료할 수 있는 실행 중인 서비스가 없습니다"
            }
            disabled={services.stoppableRunning.length === 0}
            onClick={() => setStopAllOpen(true)}
          >
            <SquareIcon
              className={cn(
                "size-3.5 fill-current",
                services.stoppableRunning.length > 0
                  ? "text-ui-error"
                  : "text-muted-foreground"
              )}
            />
          </ToolButton>
          <ToolButton
            title="콘솔 지우기 — HTTP 응답과 서비스 로그"
            onClick={clearConsoles}
          >
            <EraserIcon className="size-3.5" />
          </ToolButton>

          {/* 트랜잭션 — 이 화면에서 수동 커밋에 들어갈 수 있으므로 커밋·롤백도 여기 있어야
              한다. 없으면 격자가 "툴바의 커밋을 누르세요"라고 안내하는데 누를 것이 없다. */}
          {txConnId && (txLive || txDirty) && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              {txLive && (
                <label
                  title={`${txName} 접속의 자동 커밋 — 끄면 변경이 커밋을 누를 때까지 트랜잭션에 남습니다`}
                  className="flex h-[26px] shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 text-[12px] transition-colors hover:bg-ui-list-hover"
                >
                  <input
                    type="checkbox"
                    checked={txAutoCommit}
                    onChange={(e) =>
                      void session.setAutoCommit(txConnId, e.target.checked)
                    }
                  />
                  자동 커밋
                </label>
              )}
              {(!txAutoCommit || txDirty) && (
                <>
                  <ToolButton
                    title={`${txName} 접속의 변경을 커밋합니다`}
                    onClick={() => void session.commit(txConnId)}
                  >
                    <CheckIcon
                      className={cn(
                        "size-3.5",
                        txDirty ? "text-ui-warning" : "text-muted-foreground"
                      )}
                    />
                  </ToolButton>
                  <ToolButton
                    title={`${txName} 접속의 변경을 롤백합니다`}
                    onClick={() => void session.rollback(txConnId)}
                  >
                    <UndoIcon
                      className={cn(
                        "size-3.5",
                        txDirty ? "text-ui-warning" : "text-muted-foreground"
                      )}
                    />
                  </ToolButton>
                  {txDirty && (
                    <span
                      title="커밋되지 않은 변경이 있습니다 — 앱을 닫으면 롤백됩니다"
                      className="flex shrink-0 items-center gap-1 text-[11px] font-bold text-ui-warning"
                    >
                      <AlertTriangleIcon className="size-3.5" />
                      미커밋
                    </span>
                  )}
                </>
              )}
            </>
          )}

          <span className="mx-1 h-4 w-px bg-border" />

          <ToolButton
            title="새로고침 — 파일 트리와 현재 파일, git 상태(브랜치·파일 색)를 다시 읽습니다(수정 중인 파일은 그대로 둡니다)"
            onClick={refreshAll}
          >
            <RotateCwIcon className="size-3.5" />
          </ToolButton>
          <ToolButton
            title={
              dbCollapsed
                ? "인프라 패널 펴기(데이터베이스 · Elasticsearch · Kafka)"
                : "인프라 패널 접기"
            }
            active={dbCollapsed}
            onClick={() => setDbCollapsed((v) => !v)}
          >
            {dbCollapsed ? (
              <PanelRightOpenIcon className="size-3.5" />
            ) : (
              <PanelRightCloseIcon className="size-3.5" />
            )}
          </ToolButton>
          <ToolButton
            title={dockCollapsed ? "서비스·콘솔 펴기" : "서비스·콘솔 접기"}
            active={dockCollapsed}
            onClick={() => setDockCollapsed((v) => !v)}
          >
            {dockCollapsed ? (
              <PanelBottomOpenIcon className="size-3.5" />
            ) : (
              <PanelBottomCloseIcon className="size-3.5" />
            )}
          </ToolButton>
        </span>
      </div>

      {/* ── (b)+(c) 가운데 줄과 아래 독 ── */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* `gap` 을 주지 않는다 — 세 칸 사이의 `Splitter` 가 곧 그 간격이자 경계선이다. */}
        <div className="flex min-h-0 flex-1">
          {/* 왼쪽: 프로젝트 트리.
              `overflow-hidden` 을 걸지 않는다 — 트리 줄의 툴팁·잘림은 안쪽이 처리하고,
              여기에 걸면 나중에 겹치는 것이 생길 때 이유 없이 잘린다.
              `border-r` 도 없다: 오른쪽의 `Splitter` 가 그 선이다(두 개면 두 줄로 보인다). */}
          <aside
            style={{ width: treeSize.width }}
            className="relative flex min-h-0 shrink-0 flex-col bg-sidebar"
          >
            <div className="flex h-[30px] shrink-0 items-center gap-1.5 border-b border-border px-2">
              <span className="text-[11px] font-semibold text-muted-foreground">
                프로젝트
              </span>
              {tree.loading.has("") && (
                <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
              )}
            </div>
            <FileTree
              root={home}
              tree={tree}
              activePath={activePath}
              // 파일 이름 색 = git 상태. 표는 `gitStatus` 응답 하나에서 나오므로 이 색을
              // 위해 추가로 무엇을 읽지 않는다(`git-marks.ts` 머리말 참고).
              marks={marks}
              onOpen={openFile}
              // 우클릭 메뉴(새로 만들기·이름 바꾸기·삭제·복사/붙여넣기).
              ops={fileOps}
              // 우클릭 메뉴의 Git 묶음(추가·이력). `git` 이 null 이면 저장소가 아니거나
              // 아직 못 읽은 것이라 항목을 달지 않는다 — 누를 때마다 오류만 낼 자리다.
              gitHome={git ? home : null}
              // 추가한 뒤 트리의 파일 색이 즉시 따라오게 한다(브랜치 칩도 같은 응답에서
              // 나온다). 트리 자체는 다시 읽지 않는다 — 파일이 생기거나 사라진 게 아니다.
              onGitChanged={loadGit}
              className="flex-1"
            />
          </aside>

          <Splitter
            orientation="vertical"
            resizing={treeSize.resizing}
            onPointerDown={treeSize.startResize}
            storageKey={`${NS}.treeWidth`}
            defaultSize={TREE_WIDTH}
            label="프로젝트 트리 폭 조절"
          />

          {/* 가운데: 탭 줄 · 빵부스러기 · 탭 본문 */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {tabs.tabs.length > 0 ? (
              <>
                {/*
                  탭 줄 — 스크롤되는 안쪽 칸과 ⌄ 버튼이 형제다.
                  아래 테두리가 **바깥 줄**에 있는 것이 요점이다: 안쪽에 두면 선이 버튼
                  아래에서 끊긴다. 그리고 버튼은 반드시 스크롤러 **밖**이어야 한다 —
                  안에 넣으면 버튼의 존재가 `clientWidth` 를 바꾸고 그 값이 다시
                  `overflowing` 을 정해 켜짐↔꺼짐이 진동한다(`use-tab-overflow` 계약).
                */}
                <div className="flex h-9 shrink-0 items-stretch border-b border-ui-tab-border">
                  <div
                    ref={scrollRef}
                    // ResizeObserver 는 크기 변화만 알려 주므로 가로 스크롤은 따로 붙인다.
                    onScroll={measure}
                    // `relative` 는 장식이 아니다 — 훅이 `offsetLeft` 를 `scrollLeft` 와
                    // 비교하므로 이 칸이 offsetParent 여야 한다(빠뜨리면 엉뚱한 탭이
                    // 가려진 것으로 잡히고, 오류는 나지 않는다).
                    className="relative flex min-w-0 flex-1 [scrollbar-width:none] items-stretch gap-1 overflow-x-auto px-2 [&::-webkit-scrollbar]:hidden"
                  >
                    {tabs.tabs.map((tab) => {
                      const isActive = tab.id === tabs.activeId
                      const Icon = tabIcon(tab)
                      const isDirty =
                        tab.kind === "file" && buffers.dirty(tab.path)
                      return (
                        <div
                          key={tab.id}
                          ref={tabRef(tab.id)}
                          role="tab"
                          aria-selected={isActive}
                          onClick={() => tabs.activate(tab.id)}
                          onAuxClick={(e) => {
                            if (e.button === 1) {
                              e.preventDefault()
                              closeTab(tab.id)
                            }
                          }}
                          title={tabPath(tab)}
                          className={cn(
                            // 폭 상한이 260px 인 이유: 이 저장소에서 가장 흔한 탭이
                            // 자바 클래스이고 `CstalkAssigneeMapperTest.java` 처럼
                            // 이름이 길다. 220px 에서는 끝이 잘려 확장자와 접미사
                            // (…Test / …Controller)가 사라져 무엇인지 알 수 없었다.
                            // 줄이 붐비면 ⌄ 목록이 받아 주므로 상한을 올려도 안전하다.
                            "group relative flex h-full max-w-[260px] min-w-[96px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg px-2.5 text-[13px] whitespace-nowrap transition-colors hover:bg-ui-list-hover",
                            isActive
                              ? "font-bold text-ui-tab-active-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ui-tab-underline"
                              : "text-ui-tab-inactive-fg hover:text-foreground"
                          )}
                        >
                          <Icon className="size-3.5 shrink-0" />
                          <span className="truncate">{tab.name}</span>
                          {/* 수정 표시는 닫기 버튼 자리에 겹치지 않게 앞에 둔다 —
                              X 는 hover 에서만 나타나므로 둘이 자리를 다투지 않는다. */}
                          {isDirty && (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-ui-warning"
                              title="저장하지 않은 변경"
                            />
                          )}
                          <button
                            type="button"
                            aria-label={`${tab.name} 탭 닫기`}
                            data-active={isActive}
                            onClick={(e) => {
                              e.stopPropagation()
                              closeTab(tab.id)
                            }}
                            className="ml-auto flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full opacity-0 transition-colors group-hover:opacity-100 hover:bg-ui-tab-border data-[active=true]:opacity-100"
                          >
                            <XIcon className="size-3" />
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  {/* 넘칠 때만 보이는 탭 목록(IntelliJ 의 탭 리스트 화살표).
                      셸과 달리 **모든 탭**을 싣는다 — 가려진 것만 실으면 목록의 길이가
                      스크롤 위치에 따라 출렁이고, "지금 무엇이 열려 있나"를 이 목록으로
                      확인할 수 없다. */}
                  {overflowing && (
                    <div className="flex shrink-0 items-center border-l border-ui-tab-border px-1">
                      <DropdownMenu open={listOpen} onOpenChange={setListOpen}>
                        <DropdownMenuTrigger
                          aria-label="열린 탭 목록"
                          title="열린 탭 목록"
                          className="flex h-6 cursor-pointer items-center gap-0.5 rounded-lg px-1 text-ui-tab-inactive-fg transition-colors hover:bg-ui-list-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
                        >
                          <ChevronDownIcon className="size-3.5" />
                          {/* 배지는 "가려진 개수"다 — 0 이어도 버튼은 남는다(스크롤할
                              곳이 있다는 사실은 변하지 않는다). */}
                          {hiddenIds.length > 0 && (
                            <span className="text-[11px] font-bold">
                              {hiddenIds.length}
                            </span>
                          )}
                        </DropdownMenuTrigger>
                        {/* `w-auto` 가 빠지면 안 된다 — `DropdownMenuContent` 의 기본
                            클래스에 `w-(--anchor-width)` 가 있어서 6px 짜리 버튼 폭에
                            맞춰 접힌다. */}
                        {/* `dark` 를 여기에도 붙인다 — 이 팝업만 포털로 `<body>` 에
                            붙어 뿌리 카드 밖에 그려진다(머리말 참고). */}
                        <DropdownMenuContent
                          align="end"
                          className={cn(
                            "w-auto max-w-[420px] min-w-[240px] text-[13px]",
                            dark && "dark"
                          )}
                        >
                          {tabs.tabs.map((tab) => {
                            const Icon = tabIcon(tab)
                            const isActive = tab.id === tabs.activeId
                            return (
                              <DropdownMenuItem
                                key={tab.id}
                                onClick={() => tabs.activate(tab.id)}
                                className={cn(
                                  "text-[13px]",
                                  isActive && "font-bold"
                                )}
                              >
                                <Icon className="size-3.5 shrink-0" />
                                <span className="truncate">{tab.name}</span>
                                <span className="ml-auto shrink-0 pl-3 text-[11px] font-normal text-muted-foreground group-focus/dropdown-menu-item:text-ui-list-active-fg group-data-highlighted/dropdown-menu-item:text-ui-list-active-fg">
                                  {tabPath(tab)}
                                </span>
                              </DropdownMenuItem>
                            )
                          })}
                          <DropdownMenuSeparator />
                          {/* 두 항목 모두 `closeGroup` 을 지난다 — 저장하지 않은 편집을
                              확인 없이 버리지 않기 위한 유일한 길이다(그 주석 참고). */}
                          <DropdownMenuItem
                            className="text-[13px]"
                            disabled={tabs.tabs.length < 2 || !tabs.activeId}
                            onClick={() => {
                              const keep = tabs.activeId
                              if (!keep) return
                              closeGroup(
                                tabs.tabs
                                  .filter((t) => t.id !== keep)
                                  .map((t) => t.id)
                              )
                            }}
                          >
                            <XIcon className="size-3.5 shrink-0" />
                            <span>다른 탭 닫기</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-[13px]"
                            onClick={() => closeGroup(tabIds)}
                          >
                            <XIcon className="size-3.5 shrink-0" />
                            <span>모두 닫기</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>

                {/*
                  빵부스러기 — 탭 이름만으로는 같은 이름의 파일을 구분할 수 없다.

                  **파일명이 맨 앞에 오고 `shrink-0` 이다.** 원래는 경로 순서대로 그리고
                  파일명이 마지막이었는데, 자바 파일은 `biz/dworks-bff/src/main/java/com/
                  dworks/bff/license/LicenseService.java` 처럼 패키지가 깊어서 앞쪽 조각들이
                  이 26px 한 줄을 다 먹고(조각마다 `shrink-0` 인데 줄이 `overflow-hidden`
                  이다) 정작 필요한 파일명이 오른쪽으로 밀려 통째로 잘렸다 — 화면에는
                  패키지 경로만 남는다. 이름이 먼저, 폴더는 남는 만큼.

                  폴더 쪽은 한 덩어리로 `truncate` 하므로 좁아지면 **뒤쪽(가장 안쪽
                  폴더)**이 먼저 잘린다. 잃는 정보가 없도록 줄 전체 `title` 에 전체 경로를
                  넣어 둔다(탭의 tooltip 과 같은 값).
                */}
                {activeTab &&
                  (() => {
                    const parts = tabPath(activeTab)
                      .split("/")
                      .map((p) => p.trim())
                      .filter(Boolean)
                    const name = parts.at(-1) ?? ""
                    const dirs = parts.slice(0, -1)
                    return (
                      <div
                        title={tabPath(activeTab)}
                        className="flex h-[26px] shrink-0 items-center overflow-hidden border-b border-border px-3 text-[11px] text-muted-foreground"
                      >
                        <span className="shrink-0 font-bold text-foreground">
                          {name}
                        </span>
                        {dirs.length > 0 && (
                          <span className="ml-2 flex min-w-0 items-center gap-0.5 truncate">
                            {dirs.map((part, i) => (
                              <span
                                key={`${part}-${i}`}
                                className="flex shrink-0 items-center gap-0.5"
                              >
                                {i > 0 && (
                                  <ChevronRightIcon className="size-3 shrink-0 opacity-60" />
                                )}
                                <span>{part}</span>
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    )
                  })()}

                {/*
                  탭 본문 — **전부 마운트한 채 겹쳐 두고** 활성만 보인다. 셸 탭과 같은
                  규칙이고 이유도 같다: `hidden` 으로 감추면 돌아왔을 때 스크롤이 맨 위로
                  되감기고, 언마운트하면 격자가 조회를 다시 한다.
                */}
                <div className="relative min-h-0 flex-1">
                  {tabs.tabs.map((tab) => {
                    const isActive = tab.id === tabs.activeId

                    if (tab.kind === "table") {
                      // TablePane 은 기본 배치가 `absolute inset-0` 이고 `active` 로
                      // 스스로 invisible 처리를 한다(데이터베이스 뷰어와 같은 약속).
                      return (
                        <TablePane
                          key={tab.id}
                          connId={tab.connId}
                          table={tab.table}
                          active={isActive}
                          // **탭 자신의 접속** 상태다. 오른쪽 패널에서 고른 접속을 넘기면
                          // 수동 커밋인 접속의 격자가 커밋 경고 없이 편집된다(그 반대도).
                          autoCommit={session.autoCommitFor(tab.connId)}
                          onTxDirty={() => session.markTxDirty(tab.connId)}
                          // 조회 조건을 데이터베이스 뷰어와 나눠 쓰면 저쪽에서 탭을 닫을 때
                          // 도는 `purgeTableQuery` 가 여기서 쓰는 WHERE 절을 지운다.
                          scope={DB_SCOPE}
                        />
                      )
                    }

                    if (tab.kind === "sql") {
                      return (
                        <QueryConsole
                          key={tab.id}
                          connId={tab.connId}
                          active={isActive}
                          autoCommit={session.autoCommitFor(tab.connId)}
                          onTxDirty={() => session.markTxDirty(tab.connId)}
                          // 콘솔 초안도 화면마다 따로 담는다 — 두 화면이 같은 칸을 쓰면
                          // 동시에 떠 있는 동안(탭은 keep-alive) 서로의 초안을 덮어쓴다.
                          scope={DB_SCOPE}
                        />
                      )
                    }

                    /*
                      인프라 탭 네 종류 — 전부 `absolute inset-0` + `invisible` 계약을
                      스스로 지키므로 감싸는 칸이 필요 없다(격자·콘솔과 같다).

                      **키에 `connSeq` 를 섞는 것이 규칙이다.** 주소를 고쳐 다시 붙이면
                      `client` 가 새 객체가 되는데, 키가 그대로면 이미 마운트된 패널이
                      처음 받은 클라이언트를 계속 들고 있어 **옛 클러스터/브로커로**
                      조회한다(오류가 아니라 조용히 남의 데이터가 나온다).
                    */
                    if (tab.kind === "esIndex") {
                      return es.client ? (
                        <IndexPane
                          key={`${es.connSeq}:${tab.id}`}
                          index={tab.index}
                          client={es.client}
                          // 목록의 주인이 루트라 여기서 요약을 붙일 수 있다.
                          meta={es.indices.find((i) => i.index === tab.index)}
                          active={isActive}
                          scope={ES_SCOPE}
                          onDeleted={(i) => {
                            // 지운 인덱스의 조회 조건도 함께 버린다 — 같은 이름이 다시
                            // 만들어졌을 때 남의 WHERE 절을 물려받지 않도록.
                            purgeIndex(i, ES_SCOPE)
                            tabs.close(esIndexTabId(i))
                            void es.reloadIndices()
                          }}
                          // 문서를 고치면 목록의 문서 수가 낡는다.
                          onDocsChanged={() => void es.reloadIndices()}
                        />
                      ) : (
                        <NotConnected
                          key={tab.id}
                          active={isActive}
                          icon={ElasticsearchBrandIcon}
                          label="Elasticsearch"
                          onConnect={() => void es.connect()}
                        />
                      )
                    }

                    if (tab.kind === "kafkaTopic") {
                      return kafka.client ? (
                        <TopicPane
                          key={`${kafka.connSeq}:${tab.id}`}
                          topic={tab.topic}
                          meta={kafka.topics.find((t) => t.name === tab.topic)}
                          client={kafka.client}
                          active={isActive}
                          scope={KAFKA_SCOPE}
                        />
                      ) : (
                        <NotConnected
                          key={tab.id}
                          active={isActive}
                          icon={KafkaBrandIcon}
                          label="Kafka"
                          onConnect={() => void kafka.connect()}
                        />
                      )
                    }

                    if (tab.kind === "kafkaGroups") {
                      return kafka.client ? (
                        <GroupsPane
                          key={`${kafka.connSeq}:${tab.id}`}
                          client={kafka.client}
                          topics={kafkaTopicNames}
                          active={isActive}
                        />
                      ) : (
                        <NotConnected
                          key={tab.id}
                          active={isActive}
                          icon={KafkaBrandIcon}
                          label="Kafka"
                          onConnect={() => void kafka.connect()}
                        />
                      )
                    }

                    if (tab.kind === "kafkaBrokers") {
                      // 브로커 표만은 `client` 가 아니라 `ClusterInfo` 를 받으므로 연결이
                      // 없어도 그릴 수 있다(빈 표 + "0대"). 그래도 같은 안내를 내보내는
                      // 편이 낫다 — 빈 표는 "브로커가 없다"로 읽힌다.
                      return kafka.cluster ? (
                        <BrokersPane
                          key={`${kafka.connSeq}:${tab.id}`}
                          cluster={kafka.cluster}
                          active={isActive}
                        />
                      ) : (
                        <NotConnected
                          key={tab.id}
                          active={isActive}
                          icon={KafkaBrandIcon}
                          label="Kafka"
                          onConnect={() => void kafka.connect()}
                        />
                      )
                    }

                    const buf = buffers.buffers[tab.path]
                    const isHttp = isHttpFile(tab.path)
                    const isMd = isMarkdownFile(tab.path)
                    const readOnly = !!buf && (buf.binary || buf.truncated)
                    /* 오류 띠는 여기서 그린다. `TextEditor` 는 **읽기 전용 사유만** 자기
                       띠로 그리고 `HttpTab` 은 오류 자리가 아예 없으므로, 그 한 경우만
                       빼고 전부 이쪽이 맡는다 — 안 그러면 저장 실패가 화면에 한 글자도
                       나오지 않고, 수정 표시만 지워지지 않은 채 남는다. */
                    const banner =
                      buf?.error && !(readOnly && !isHttp) ? buf.error : null
                    return (
                      <div
                        key={tab.id}
                        aria-hidden={!isActive}
                        className={cn(
                          "absolute inset-0 flex min-h-0 flex-col",
                          !isActive && "invisible"
                        )}
                      >
                        {!buf || (buf.loading && !buf.loaded) ? (
                          <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
                            <Loader2Icon className="size-3.5 animate-spin" />
                            불러오는 중…
                          </div>
                        ) : !buf.loaded ? (
                          /* 한 번도 못 읽은 파일에는 편집기를 띄우지 않는다. 빈 편집기는
                             "빈 파일"과 구분이 안 되고, 거기에 타자를 치고 ⌘S 를 누르면
                             (파일만 이름이 바뀐 경우엔 저장이 성공해서) 원본이 그 몇
                             글자로 덮어써진다. */
                          <LoadFailed
                            message={buf.error ?? "파일을 읽지 못했습니다."}
                            onRetry={() => void buffers.load(tab.path, true)}
                            onClose={() => closeTab(tab.id)}
                          />
                        ) : (
                          <div className="flex min-h-0 flex-1 flex-col">
                            {banner && (
                              <div className="mx-2 mt-2 flex shrink-0 items-start gap-2 rounded-[10px] border border-border bg-ui-error/10 px-3 py-2 text-[13px] whitespace-pre-wrap text-ui-error">
                                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                                <span className="min-w-0 flex-1">{banner}</span>
                              </div>
                            )}
                            {isHttp ? (
                              // `HttpTab` 은 `h-full` 로 자기 높이를 부모에게서 받으므로
                              // 띠와 형제로 두면 넘친다 — 남은 높이를 주는 칸을 한 겹 둔다.
                              <div className="min-h-0 flex-1">
                                <HttpTab
                                  path={tab.path}
                                  rel={tab.rel}
                                  text={buf.text}
                                  onChange={(v) => buffers.setText(tab.path, v)}
                                  onSave={() => void buffers.save(tab.path)}
                                  dirty={buffers.dirty(tab.path)}
                                  active={isActive}
                                  api={http}
                                  onActiveKeyChange={setHttpKey}
                                />
                              </div>
                            ) : isMd ? (
                              // `MdTab` 은 자기 안에서 모드 줄 + (편집기 | 뷰어) 를 세로로
                              // 쌓으므로 남은 높이만 주면 된다(안쪽 여백도 자기가 준다).
                              <MdTab
                                path={tab.path}
                                rel={tab.rel}
                                text={buf.text}
                                onChange={(v) => buffers.setText(tab.path, v)}
                                onSave={() => void buffers.save(tab.path)}
                                dirty={buffers.dirty(tab.path)}
                                readOnly={readOnly}
                                readOnlyReason={buf.error}
                                active={isActive}
                              />
                            ) : (
                              <div className="flex min-h-0 flex-1 flex-col p-2">
                                <TextEditor
                                  path={tab.path}
                                  text={buf.text}
                                  onChange={(v) => buffers.setText(tab.path, v)}
                                  onSave={() => void buffers.save(tab.path)}
                                  readOnly={readOnly}
                                  readOnlyReason={buf.error}
                                  active={isActive}
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                <FileCodeIcon className="size-8 text-muted-foreground/50" />
                <div className="text-[15px] font-semibold">
                  열어 둔 것이 없습니다
                </div>
                <p className="max-w-sm text-[13px] text-muted-foreground">
                  왼쪽 트리에서 파일을, 오른쪽에서 테이블 · 인덱스 · 토픽을
                  누르면 여기에 탭으로 열립니다.{" "}
                  <span className="font-mono">.http</span> 파일은 거터의 ▶ 로
                  바로 실행할 수 있고 응답은 아래 콘솔에 뜹니다.
                </p>
              </div>
            )}
          </div>

          {/* 오른쪽: 인프라(데이터베이스 · Elasticsearch · Kafka) */}
          {!dbCollapsed && (
            <>
              <Splitter
                orientation="vertical"
                resizing={infraSize.resizing}
                onPointerDown={infraSize.startResize}
                storageKey={`${NS}.infraWidth`}
                defaultSize={INFRA_WIDTH}
                label="인프라 패널 폭 조절"
              />
              {/* `border-l` 은 없다 — 왼쪽의 `Splitter` 가 그 선이다.
                  `flex-row` 인 것이 요점이다: 패널 본문과 36px 도구 레일이 나란히 서고,
                  `width` 는 그 둘을 합친 값이다. */}
              <aside
                style={{ width: infraSize.width }}
                className="relative flex min-h-0 shrink-0 flex-row"
              >
                {/*
                  세 장을 **전부 마운트한 채 겹쳐 두고** 활성만 보인다. 조건부 렌더로
                  갈아 끼우면 레일을 누를 때마다 각 패널의 1회성 마운트 효과가 다시 도는데,
                  Kafka 의 `kafka_topics(withCounts)` 는 파티션마다 워터마크를 왕복해서
                  실제 클러스터에서 몇 초가 걸린다(ES 는 `_cat/indices` 한 번).

                  `invisible` 은 자리를 그대로 차지하므로 나란히 두면 셋이 폭을 1/3 씩
                  나눠 갖는다 — 그래서 `relative` 칸 안에 `absolute inset-0` 로 쌓는다
                  (가운데 탭 본문과 같은 관용구).
                */}
                <div className="relative min-w-0 flex-1">
                  {/* `activeId` — 지금 가운데에 떠 있는 탭. 세 패널이 "누른 줄" 을
                      그것으로 판단한다(패널이 자기 선택을 따로 들면 탭을 옮겼을 때
                      두 표시가 서로 다른 말을 한다). */}
                  <DbPanel
                    session={session}
                    connections={connections}
                    connId={conn?.id ?? null}
                    activeId={activeTab?.id ?? null}
                    onSelectConn={setPickedConnId}
                    onOpenTable={openTable}
                    onOpenSql={openSql}
                    onManage={() => setManageOpen(true)}
                    className={cn(
                      "absolute inset-0",
                      tool !== "db" && "invisible"
                    )}
                  />
                  <EsPanel
                    session={es}
                    activeId={activeTab?.id ?? null}
                    onOpenIndex={openEsIndex}
                    onManage={() => setEsManageOpen(true)}
                    className={cn(
                      "absolute inset-0",
                      tool !== "es" && "invisible"
                    )}
                  />
                  <KafkaPanel
                    session={kafka}
                    activeId={activeTab?.id ?? null}
                    onOpenTopic={openKafkaTopic}
                    onOpenGroups={openKafkaGroups}
                    onOpenBrokers={openKafkaBrokers}
                    onManage={() => setKafkaManageOpen(true)}
                    className={cn(
                      "absolute inset-0",
                      tool !== "kafka" && "invisible"
                    )}
                  />
                </div>

                {/* 도구 레일 — aside 의 **오른쪽** 모서리다(왼쪽은 분할선 자리다). */}
                <div className="flex w-9 shrink-0 flex-col items-center gap-0.5 border-l border-border py-1">
                  <InfraRailButton
                    title="데이터베이스"
                    active={tool === "db"}
                    onClick={() => setTool("db")}
                  >
                    <DatabaseIcon className="size-4" />
                  </InfraRailButton>
                  <InfraRailButton
                    title="Elasticsearch"
                    active={tool === "es"}
                    onClick={() => setTool("es")}
                  >
                    <ElasticsearchBrandIcon className="size-4" />
                  </InfraRailButton>
                  <InfraRailButton
                    title="Kafka"
                    active={tool === "kafka"}
                    onClick={() => setTool("kafka")}
                  >
                    <KafkaBrandIcon className="size-4" />
                  </InfraRailButton>
                </div>
              </aside>
            </>
          )}
        </div>

        {/* ── (c) 아래 독 ── */}
        {dockCollapsed ? (
          // 접어도 32px 띠는 남긴다 — 완전히 사라지면 다시 여는 자리가 툴바뿐이라
          // "서비스가 아직 여기 있다"는 사실 자체가 화면에서 지워진다.
          // (접힌 동안에는 분할선을 두지 않는다 — 끌 높이가 없고, 이 띠의 윗선이 경계다.)
          <button
            type="button"
            onClick={() => setDockCollapsed(false)}
            title="서비스·콘솔 펴기"
            className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 border-t border-border px-2 text-left transition-colors hover:bg-ui-list-hover"
          >
            <PanelBottomOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-[13px] font-semibold">서비스</span>
            <span className="rounded-full bg-muted px-2 text-[11px] font-bold text-muted-foreground tabular-nums">
              {
                services.services.filter((s) => services.running.has(s.name))
                  .length
              }
              개 실행 중
            </span>
          </button>
        ) : (
          <>
            <Splitter
              orientation="horizontal"
              resizing={dockSize.resizing}
              onPointerDown={dockSize.startResize}
              storageKey={`${NS}.dockHeight`}
              defaultSize={DOCK_HEIGHT}
              label="서비스·콘솔 높이 조절"
            />
            <div
              style={{ height: dockSize.height }}
              className="relative shrink-0"
            >
              <ServicesDock
                api={services}
                dockTab={dockTab}
                onDockTab={setDockTab}
                responseNode={
                  <HttpResponseDock
                    api={http}
                    // 다른 탭으로 옮겼으면 그 탭의 커서 위치를 넘기지 않는다 —
                    // 넘기면 지금 보고 있지도 않은 파일의 응답이 뜬다(그때는 훅이
                    // 마지막으로 실행한 응답으로 떨어진다).
                    activeKey={
                      httpKey &&
                      activeTab?.kind === "file" &&
                      httpKey.startsWith(`${activeTab.path}#`)
                        ? httpKey
                        : null
                    }
                  />
                }
                // 카드 안의 카드가 되지 않도록 테두리·그림자를 걷어 낸다. 윗선도 없다 —
                // 위의 `Splitter` 가 그 경계선이다.
                className="h-full rounded-none border-0 shadow-none"
              />
            </div>
          </>
        )}
      </div>

      {manageOpen && (
        <ConnectionsDialog
          session={session}
          // 목록은 루트가 넘긴다 — 여기서 훅을 또 부르면 두 벌로 갈라진다(위 머리말 참고).
          connections={connections}
          setConnections={setConnections}
          connId={conn?.id ?? null}
          onSelectConn={setPickedConnId}
          onClose={() => setManageOpen(false)}
        />
      )}

      {esManageOpen && (
        <EsConnDialog session={es} onClose={() => setEsManageOpen(false)} />
      )}

      {kafkaManageOpen && (
        <KafkaConnDialog
          session={kafka}
          onClose={() => setKafkaManageOpen(false)}
        />
      )}

      {dirtyClose && (
        <DirtyCloseDialog
          name={dirtyClose.name}
          onCancel={() => setDirtyClose(null)}
          onSave={() => {
            const tab = dirtyClose
            setDirtyClose(null)
            if (tab.kind !== "file") return
            void (async () => {
              await buffers.save(tab.path)
              // 저장이 거절되면(바이너리·2MB 초과) 탭을 닫지 않는다 — 사유는 편집기
              // 위의 띠에 남아 있으므로 사용자가 보고 다시 판단한다.
              if (buffers.close(tab.path)) tabs.close(tab.id)
            })()
          }}
          onDiscard={() => {
            const tab = dirtyClose
            setDirtyClose(null)
            if (tab.kind !== "file") return
            buffers.close(tab.path, true)
            tabs.close(tab.id)
          }}
        />
      )}

      {/* 마지막 하나가 스스로 내려가 대상이 비면 물을 것도 없어진다 — 그대로 닫는다. */}
      {stopAllOpen && services.stoppableRunning.length > 0 && (
        <StopAllDialog
          targets={services.stoppableRunning}
          onCancel={() => setStopAllOpen(false)}
          onConfirm={() => {
            setStopAllOpen(false)
            void services.stopAll()
          }}
        />
      )}
    </div>
  )
}
