import {
  HomeIcon,
  CheckSquareIcon,
  BellIcon,
  LayoutDashboardIcon,
  BracesIcon,
  FileTextIcon,
  PalmtreeIcon,
  HistoryIcon,
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
import { ClaudeBridgeView } from "@/features/claude-bridge/claude-bridge-view"
import { ClaudeMenuBadge } from "@/features/claude-bridge/claude-menu-badge"
import { IntellijServicesView } from "@/features/intellij/intellij-services-view"
import { CoworkAiView } from "@/features/cowork-ai/cowork-ai-view"
import { CcHistoryView } from "@/features/cc-history/cc-history-view"
import { JsonFormatterView } from "@/features/json-formatter/json-formatter-view"
import { CoworkSpecView } from "@/features/cowork-spec/cowork-spec-view"
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
      },
      {
        id: "cowork-spec",
        title: "Cowork Spec 문서",
        icon: FileTextIcon,
        element: <CoworkSpecView />,
      },
    ],
  },
  {
    id: "dev-tools",
    label: "개발 도구",
    items: [
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
