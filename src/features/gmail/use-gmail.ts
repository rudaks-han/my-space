import { createContext, useContext } from "react"

export interface GmailStatus {
  connected: boolean
  email: string | null
}

/** 목록에 표시할 메일 한 통(메타데이터). 본문은 loadBody 로 따로 가져온다. */
export interface GmailMessage {
  id: string
  thread_id: string
  /** 보낸사람 표시 이름(없으면 이메일). */
  from_name: string
  from_email: string
  /** 받는사람(보낸편지함에서 상대 표시용). */
  to: string
  subject: string
  /** 본문 미리보기 한 줄. */
  snippet: string
  /** 수신/발신 시각(epoch ms). */
  date: number
  /** 안 읽음 여부. */
  unread: boolean
}

/** 메일 한 통의 본문(읽기 화면). */
export interface GmailBody {
  subject: string
  from_name: string
  from_email: string
  to: string
  date: number
  /** HTML 본문(있으면 우선). */
  html: string | null
  /** 순수 텍스트 본문(HTML 이 없을 때). */
  text: string | null
}

export type GmailFolder = "inbox" | "sent"

/** 한 폴더의 메일 한 페이지(페이지네이션). */
export interface GmailPage {
  messages: GmailMessage[]
  /** 다음 페이지 토큰. null 이면 다음 페이지 없음. */
  next_page_token: string | null
  /** 폴더 전체 메일 수(구글 근사치). */
  result_size_estimate: number
}

/**
 * 한 메일이 "관심 대상"인지 판단한다(설정 → Gmail 의 발신자·키워드 기준).
 *
 * - 발신자: 보낸사람 주소에 지정 문자열이 포함되면 관심(전체 주소·도메인 조각 모두 가능).
 * - 키워드: 제목·미리보기에 지정 문자열이 포함되면 관심.
 *
 * 발신자·키워드가 하나도 없으면 어떤 메일도 관심 대상이 아니다(배지 0).
 */
export function matchesInterest(
  m: Pick<GmailMessage, "from_email" | "subject" | "snippet">,
  senders: string[],
  keywords: string[]
): boolean {
  const from = m.from_email.toLowerCase()
  if (senders.some((s) => s && from.includes(s.toLowerCase()))) return true
  const hay = `${m.subject} ${m.snippet}`.toLowerCase()
  return keywords.some((k) => k && hay.includes(k.toLowerCase()))
}

export interface GmailContextValue {
  /** status === null 은 "확인 중"을 뜻한다. */
  status: GmailStatus | null
  /** 받은편지함(전역 폴링 대상 — 사이드바 배지가 항상 참조한다). */
  inbox: GmailMessage[]
  inboxLoading: boolean
  error: string | null
  updatedAt: number | null
  /** 받은편지함에서 안 읽은 "관심" 메일 수(사이드바 배지, 빨강). */
  unreadInterest: number
  /** 받은편지함 전체의 안 읽은 메일 수(정확한 총계, 사이드바 배지 회색). */
  totalUnread: number
  connect: (clientId: string, clientSecret: string) => Promise<void>
  disconnect: () => Promise<void>
  /** 받은편지함(배지용 첫 페이지)을 지금 새로고침한다. */
  refreshInbox: () => Promise<void>
  /** 폴더 메일 한 페이지를 서버에서 가져온다(pageToken 으로 다음 페이지). */
  loadPage: (folder: GmailFolder, pageToken?: string) => Promise<GmailPage>
  /** 메일 본문을 가져온다. */
  loadBody: (id: string) => Promise<GmailBody>
  /** 메일을 읽음 처리한다(UNREAD 제거). 받은편지함·배지도 즉시 갱신된다. */
  markRead: (id: string) => Promise<void>
  /** 현재 필터 기준으로 이 메일이 관심 대상인지. */
  isInterest: (
    m: Pick<GmailMessage, "from_email" | "subject" | "snippet">
  ) => boolean
}

export const GmailContext = createContext<GmailContextValue | null>(null)

/**
 * Gmail 연결 상태·받은편지함·관심 필터를 제공하는 훅.
 * `GmailProvider` 안에서만 쓸 수 있다. 상태가 전역이라 사이드바 배지와 Gmail 화면이
 * 같은 받은편지함·안 읽음 수를 공유한다.
 */
export function useGmail() {
  const ctx = useContext(GmailContext)
  if (!ctx) {
    throw new Error("useGmail 은 GmailProvider 안에서만 사용할 수 있습니다.")
  }
  return ctx
}
