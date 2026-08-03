import {
  HomeIcon,
  CheckSquareIcon,
  BellIcon,
  LayoutDashboardIcon,
  BracesIcon,
  BookOpenTextIcon,
  DatabaseIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  PalmtreeIcon,
  HistoryIcon,
  ScreenShareIcon,
  ServerIcon,
} from "lucide-react"

import {
  ChromeBrandIcon,
  SlackBrandIcon,
  JiraBrandIcon,
  GoogleCalendarBrandIcon,
  GoogleDriveBrandIcon,
  GmailBrandIcon,
  IntellijBrandIcon,
  ClaudeBrandIcon,
  ElasticsearchBrandIcon,
  KafkaBrandIcon,
} from "@/components/brand-icons"

import { PLATFORM, type Platform } from "@/lib/platform"
import { HomeView } from "@/features/home/home-view"
import { TodoView } from "@/features/todo/todo-view"
import { BrowserView } from "@/features/browser/browser-view"
import { SlackView } from "@/features/slack/slack-view"
import { SlackMenuBadge } from "@/features/slack/slack-menu-badge"
import { JiraView } from "@/features/jira/jira-view"
import { GcalView } from "@/features/gcal/gcal-view"
import { GdriveView } from "@/features/gdrive/gdrive-view"
import { GmailView } from "@/features/gmail/gmail-view"
import { GmailMenuBadge } from "@/features/gmail/gmail-menu-badge"
import { FlexView } from "@/features/flex/flex-view"
import { ReminderView } from "@/features/reminder/reminder-view"
import { ScreenShareView } from "@/features/screen-share/screen-share-view"
import { ClaudeBridgeView } from "@/features/claude-bridge/claude-bridge-view"
import { ClaudeMenuBadge } from "@/features/claude-bridge/claude-menu-badge"
import {
  IntellijServicesView,
  StandaloneServicesView,
} from "@/features/intellij/intellij-services-view"
import { ServicesMenuBadge } from "@/features/intellij/services-menu-badge"
import { IntellijHttpView } from "@/features/intellij-http/intellij-http-view"
import { CoworkAiView } from "@/features/cowork-ai/cowork-ai-view"
import { CcHistoryView } from "@/features/cc-history/cc-history-view"
import { JsonFormatterView } from "@/features/json-formatter/json-formatter-view"
import { MarkdownViewerView } from "@/features/markdown-viewer/markdown-viewer-view"
import { CoworkSpecView } from "@/features/cowork-spec/cowork-spec-view"
import { GitView } from "@/features/git/git-view"
import { DbViewerView } from "@/features/db-viewer/db-viewer-view"
import { EsViewerView } from "@/features/es-viewer/es-viewer-view"
import { KafkaViewerView } from "@/features/kafka-viewer/kafka-viewer-view"

/**
 * 메뉴 아이콘 타입. lucide 아이콘과 브랜드 로고 컴포넌트(src/components/brand-icons.tsx)를
 * 모두 담을 수 있도록 className 만 받는 컴포넌트로 넓혀 둔다.
 */
export type MenuIcon = React.ComponentType<{ className?: string }>

export interface MenuItem {
  /** 고유 id (활성 메뉴 저장 키로 사용) */
  id: string
  /** 사이드바 및 헤더에 표시할 이름 */
  title: string
  /** 메뉴 아이콘(lucide 또는 브랜드 로고) */
  icon: MenuIcon
  /** 선택 시 본문에 렌더링할 뷰 */
  element: React.ReactNode
  /** 사이드바 메뉴 버튼에 겹쳐 표시할 배지(예: 안 읽음 개수). 없으면 표시 안 함. */
  badge?: React.ReactNode
  /**
   * 이 OS 에서는 쓸 수 없는 기능. 사이드바 항목이 흐려지며 "사용불가" 칩이 붙고,
   * 열면 `element` 대신 이유를 설명하는 안내 패널이 뜬다.
   *
   * 뷰를 마운트한 채 안내만 덮지 않는 이유: 여기 걸리는 메뉴들은 마운트 즉시 폴링을
   * 시작해서, "사용불가"라고 해 놓고 뒤에서 실패할 요청을 계속 보내는 꼴이 된다.
   */
  unsupported?: {
    /** 못 쓰는 OS 들. */
    on: Platform[]
    /** 왜 안 되는지 — 안내 패널 본문에 그대로 나간다. */
    reason: string
  }
}

export interface MenuGroup {
  /** 그룹 고유 id (메뉴 순서 저장 키로 사용) */
  id: string
  /** 그룹 제목. null 이면 라벨 없이(구분선처럼) 항목만 표시. */
  label: string | null
  /** 그룹에 속한 메뉴 항목들 */
  items: MenuItem[]
}

/**
 * ★ 메뉴 추가 지점 ★
 * 새 기능을 만들면 아래 그룹 중 하나에 항목을 추가하면 사이드바에 자동 반영된다.
 *   1) src/features/<기능명>/ 아래에 뷰 컴포넌트를 만들고
 *   2) 여기서 import 한 뒤
 *   3) 알맞은 그룹의 items 에 { id, title, icon, element } 추가
 *
 * 사이드바는 이 그룹 구조로 2차(그룹 → 항목) 메뉴를 그리며, 사용자가 항목 순서를
 * 드래그로 바꿀 수 있다(순서는 localStorage 에 그룹별로 저장 — src/lib/use-menu-order.ts).
 */
export const MENU_GROUPS: MenuGroup[] = [
  {
    id: "general",
    label: null,
    items: [
      { id: "home", title: "홈", icon: HomeIcon, element: <HomeView /> },
      {
        id: "browser",
        title: "브라우징",
        icon: ChromeBrandIcon,
        element: <BrowserView />,
      },
    ],
  },
  {
    id: "work",
    label: "업무",
    items: [
      {
        id: "gmail",
        title: "Gmail",
        icon: GmailBrandIcon,
        element: <GmailView />,
        badge: <GmailMenuBadge />,
      },
      {
        id: "slack",
        title: "Slack",
        icon: SlackBrandIcon,
        element: <SlackView />,
        badge: <SlackMenuBadge />,
      },
      {
        id: "jira",
        title: "Jira",
        icon: JiraBrandIcon,
        element: <JiraView />,
      },
      {
        id: "gcal",
        title: "구글 캘린더",
        icon: GoogleCalendarBrandIcon,
        element: <GcalView />,
      },
      {
        id: "gdrive",
        title: "구글 드라이브",
        icon: GoogleDriveBrandIcon,
        element: <GdriveView />,
      },
      {
        id: "flex",
        title: "Flex 휴가",
        icon: PalmtreeIcon,
        element: <FlexView />,
      },
    ],
  },
  {
    id: "productivity",
    label: "생산성",
    items: [
      {
        id: "todo",
        title: "할 일",
        icon: CheckSquareIcon,
        element: <TodoView />,
      },
      {
        id: "reminder",
        title: "알림",
        icon: BellIcon,
        element: <ReminderView />,
      },
      {
        id: "screen-share",
        title: "화면 공유",
        icon: ScreenShareIcon,
        element: <ScreenShareView />,
      },
    ],
  },
  {
    id: "dev",
    label: "개발",
    items: [
      {
        id: "intellij-services",
        title: "IntelliJ 서비스",
        icon: IntellijBrandIcon,
        element: <IntellijServicesView />,
        badge: <ServicesMenuBadge backend="ide" />,
        unsupported: {
          on: ["windows", "linux"],
          reason:
            "실행 중인 서비스를 찾는 방식(ps · lsof)과 내리는 방식(프로세스 시그널)이 모두 Unix 전용이고, IntelliJ 의 MCP 포트도 lsof 로 찾습니다. Windows 에서는 실행 설정 목록만 읽을 수 있을 뿐 시작·중지·상태 확인이 모두 되지 않습니다.",
        },
      },
      {
        // IntelliJ 서비스 바로 아래 — 같은 IntelliJ 프로젝트를 대상으로 하지만,
        // 이쪽은 IDE 없이 `.http` 파일만 읽어 실행한다(사이드바는 그룹 → 항목 2단이라
        // "IntelliJ 서비스 하위"는 이 위치로 표현된다).
        id: "intellij-http",
        title: "IntelliJ HTTP",
        icon: GlobeIcon,
        element: <IntellijHttpView />,
      },
      {
        id: "cowork-services",
        title: "Cowork 서비스",
        icon: ServerIcon,
        element: <StandaloneServicesView />,
        badge: <ServicesMenuBadge backend="standalone" />,
        unsupported: {
          on: ["windows", "linux"],
          reason:
            "IntelliJ 가 임포트해 둔 프로젝트 모델을 읽어 클래스패스를 만드는데, 그 위치(~/Library/Caches/JetBrains)가 macOS 전용입니다. 서비스 포트를 찾는 lsof 와 중지에 쓰는 프로세스 시그널(SIGINT)도 Unix 전용입니다.",
        },
      },
      {
        id: "cowork-spec",
        title: "Cowork Spec 문서",
        icon: FileTextIcon,
        element: <CoworkSpecView />,
      },
      {
        // 대상 저장소는 설정 → Cowork 의 홈 디렉터리 하나(스펙 문서·서비스와 같은 값).
        id: "git",
        title: "Git",
        icon: GitBranchIcon,
        element: <GitView />,
      },
    ],
  },
  {
    id: "dev-tools",
    label: "개발 도구",
    items: [
      {
        id: "db-viewer",
        title: "데이터베이스 뷰어",
        icon: DatabaseIcon,
        element: <DbViewerView />,
        unsupported: {
          on: ["windows", "linux"],
          reason:
            "JDBC 드라이버로 붙기 때문에 Java 를 실행해야 하는데, java 실행 파일을 찾는 경로(JAVA_HOME → which → /usr/libexec/java_home)와 드라이버 jar 를 찾는 위치(~/.m2 · ~/.gradle)가 모두 Unix 기준으로 돼 있습니다.",
        },
      },
      {
        id: "es-viewer",
        title: "Elasticsearch 뷰어",
        icon: ElasticsearchBrandIcon,
        element: <EsViewerView />,
      },
      {
        id: "kafka-viewer",
        title: "Kafka 뷰어",
        icon: KafkaBrandIcon,
        element: <KafkaViewerView />,
      },
      {
        id: "markdown-viewer",
        title: "마크다운 뷰어",
        icon: BookOpenTextIcon,
        element: <MarkdownViewerView />,
      },
      {
        id: "json-formatter",
        title: "JSON 포맷터",
        icon: BracesIcon,
        element: <JsonFormatterView />,
      },
    ],
  },
  {
    id: "claude-code",
    label: "Claude Code",
    items: [
      {
        id: "claude-bridge",
        title: "세션 목록",
        icon: ClaudeBrandIcon,
        element: <ClaudeBridgeView />,
        badge: <ClaudeMenuBadge />,
        unsupported: {
          on: ["windows", "linux"],
          reason:
            "터미널의 어느 창이 어느 Claude 세션인지 알아야 목록을 채울 수 있는데, 그 매핑을 주는 백엔드가 herdr·cmux·Orca 셋뿐이고 모두 macOS 전용입니다. 대화 기록 자체는 이 PC 에도 있으므로 'CC History Viewer' 로는 지난 세션을 볼 수 있습니다.",
        },
      },
      {
        id: "cowork-ai-dashboard",
        title: "AI 대시보드",
        icon: LayoutDashboardIcon,
        element: <CoworkAiView />,
      },
      {
        id: "cc-history",
        title: "CC History Viewer",
        icon: HistoryIcon,
        element: <CcHistoryView />,
      },
    ],
  },
]

/** 활성 메뉴 조회용 평탄화 목록(App.tsx 에서 id 로 뷰를 찾는다). */
export const MENUS: MenuItem[] = MENU_GROUPS.flatMap((g) => g.items)

/**
 * 설정 → 메뉴 설정에서 끈 메뉴 id 전부(그룹째 끈 경우 그 그룹의 항목까지).
 * 사이드바 밖에서 메뉴를 나열하는 곳(좌측 레일에 꽂아 둔 바로가기)이 같은 판단을 쓰도록 둔다.
 */
export function hiddenMenuIds(
  hiddenGroups: string[],
  hiddenItems: string[]
): Set<string> {
  const hidden = new Set(hiddenItems)
  for (const g of MENU_GROUPS) {
    if (!hiddenGroups.includes(g.id)) continue
    for (const m of g.items) hidden.add(m.id)
  }
  return hidden
}

/**
 * 지금 OS 에서 이 메뉴를 못 쓰면 그 사유를, 쓸 수 있으면 null 을 준다.
 * 사이드바(칩)와 뷰(안내 패널)가 같은 판단을 쓰도록 여기 하나만 둔다.
 */
export function unsupportedReason(menu: MenuItem | undefined): string | null {
  const u = menu?.unsupported
  return u && u.on.includes(PLATFORM) ? u.reason : null
}
