/*
 * 앱 본문 폰트 목록.
 *
 * 폰트 실물은 index.css 에서 @import 로 번들한다(오프라인 데스크톱이라 CDN 대신 번들).
 * 여기서는 각 폰트의 CSS `font-family` 스택만 정의한다 — 한글이 없는 라틴 폰트(Lato)는
 * 뒤에 'Noto Sans KR' 을 두어 한글이 깨지지 않게 한다.
 *
 * 적용은 theme-preset-provider 가 `--ui-font` 변수를 <head> <style> 로 주입하는 방식이며,
 * index.css 의 `html { font-family: var(--ui-font, …) }` 가 이를 읽는다.
 */
export interface AppFont {
  /** 저장·식별용 id. */
  id: string
  /** 설정 화면에 보이는 이름. */
  label: string
  /** 실제 적용될 font-family 스택. */
  stack: string
}

/** 시스템 폰트 폴백(모든 스택 끝에 공통으로 붙인다). */
const SYSTEM_FALLBACK =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif"

/** 한글이 없는 라틴 폰트를 위한 한글 폴백. */
const KO_FALLBACK = "'Noto Sans KR'"

export const FONTS: AppFont[] = [
  {
    id: "lato",
    label: "Lato",
    stack: `'Lato', ${KO_FALLBACK}, ${SYSTEM_FALLBACK}`,
  },
  {
    id: "noto-sans",
    label: "Noto Sans",
    stack: `'Noto Sans KR', ${SYSTEM_FALLBACK}`,
  },
  {
    id: "arial",
    label: "Arial",
    stack: `Arial, ${KO_FALLBACK}, Helvetica, sans-serif`,
  },
  {
    id: "pretendard",
    label: "Pretendard",
    stack: `'Pretendard Variable', Pretendard, ${SYSTEM_FALLBACK}`,
  },
  {
    id: "nanum-square",
    label: "나눔스퀘어",
    stack: `'나눔스퀘어', 'NanumSquare', ${SYSTEM_FALLBACK}`,
  },
]

/** 기본 폰트 id — Lato. */
export const DEFAULT_FONT_ID = "lato"

/** id 로 폰트를 찾는다. 없으면 기본(Lato). */
export function getFont(id: string | null | undefined): AppFont {
  return FONTS.find((f) => f.id === id) ?? FONTS[0]
}
