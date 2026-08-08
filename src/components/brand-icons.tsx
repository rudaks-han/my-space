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

/**
 * **단색 로고**용 — 그림을 마스크로 깔고 색은 `currentColor` 로 칠한다.
 *
 * 컬러 로고는 `<img>` 로 두면 그만이지만, 단색 로고는 그 한 가지 색이 배경과 부딪히는
 * 순간 통째로 사라진다. Kafka 로고가 정확히 그렇다(`#231F20`, 거의 검정) — 다크 모드의
 * 어두운 패널에서 안 보이고, 라이트 모드라도 **선택된 사이드바 행**(와인색 알약)에
 * 올라가면 똑같이 묻힌다. `<img>` 는 CSS 로 색을 바꿀 수 없으니 그림 자체를 마스크로
 * 쓴다: 로고는 형태만 남고 색은 글자 색을 따라가므로 두 상황이 한꺼번에 해결되고,
 * 옆의 lucide 아이콘들과도 톤이 맞는다. 원본이 이미 단색이라 브랜드가 잃는 것은 없다.
 *
 * `-webkit-` 접두사를 함께 두는 이유: 이 앱이 도는 WKWebView 가 아직 그쪽을 본다.
 */
function makeMonoBrandIcon(src: string, label: string) {
  // 따옴표는 필수다 — 이 로고는 4KB 미만이라 빌드에서 `data:image/svg+xml,...` 로
  // 인라인되는데, 그 안의 문자가 따옴표 없이는 CSS 값 파싱을 깬다(dev 는 평범한 경로라
  // 멀쩡히 보이고 빌드에서만 아이콘이 사라지는, 알아채기 나쁜 실패다).
  const mask = {
    maskImage: `url("${src}")`,
    WebkitMaskImage: `url("${src}")`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  } as const

  const Icon = ({ className }: { className?: string }) => (
    // inline-block: span 은 기본이 inline 이라 그대로 두면 size-* 가 먹지 않는다.
    <span
      role="img"
      aria-label={label}
      style={mask}
      className={cn("inline-block bg-current", className)}
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
/** Kafka 로고는 검정 단색이라 마스크로 그린다(다크 모드·선택 알약에서 묻히지 않게). */
export const KafkaBrandIcon = makeMonoBrandIcon(kafkaUrl, "Kafka")
