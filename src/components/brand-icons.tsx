import { cn } from "@/lib/utils"

// 실제 서비스 브랜드 로고(컬러 SVG)를 메뉴 아이콘으로 쓰기 위한 래퍼.
// gilbarbara/logos 의 공식 컬러 로고를 src/assets/brand/ 에 두고 url 로 import 한다.
// menus.tsx 의 icon 타입(= lucide 아이콘)과 호환되도록 { className } 만 받는
// 컴포넌트로 감싼다. size-4 / size-[18px] 등 정사각형 클래스가 와도 로고 비율이
// 깨지지 않게 object-contain 을 항상 적용한다(정사각이 아닌 로고 대비).
import chromeUrl from "@/assets/brand/chrome.svg"
import slackUrl from "@/assets/brand/slack.svg"
import jiraUrl from "@/assets/brand/jira.svg"
import gcalUrl from "@/assets/brand/gcal.svg"
import gdriveUrl from "@/assets/brand/gdrive.svg"
import gmailUrl from "@/assets/brand/gmail.svg"
import intellijUrl from "@/assets/brand/intellij.svg"
import claudeUrl from "@/assets/brand/claude.svg"
import elasticsearchUrl from "@/assets/brand/elasticsearch.svg"
import kafkaUrl from "@/assets/brand/kafka.svg"

function makeBrandIcon(src: string, label: string) {
  const Icon = ({ className }: { className?: string }) => (
    <img
      src={src}
      alt={label}
      draggable={false}
      className={cn("object-contain", className)}
    />
  )
  Icon.displayName = `${label}Icon`
  return Icon
}

export const ChromeBrandIcon = makeBrandIcon(chromeUrl, "Chrome")
export const SlackBrandIcon = makeBrandIcon(slackUrl, "Slack")
export const JiraBrandIcon = makeBrandIcon(jiraUrl, "Jira")
export const GoogleCalendarBrandIcon = makeBrandIcon(gcalUrl, "Google Calendar")
export const GoogleDriveBrandIcon = makeBrandIcon(gdriveUrl, "Google Drive")
export const GmailBrandIcon = makeBrandIcon(gmailUrl, "Gmail")
export const IntellijBrandIcon = makeBrandIcon(intellijUrl, "IntelliJ")
export const ClaudeBrandIcon = makeBrandIcon(claudeUrl, "Claude")
export const ElasticsearchBrandIcon = makeBrandIcon(
  elasticsearchUrl,
  "Elasticsearch"
)
export const KafkaBrandIcon = makeBrandIcon(kafkaUrl, "Kafka")
