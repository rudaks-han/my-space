/*
 * 앱 본문 폰트 목록.
 *
 * 폰트 실물은 index.css 에서 @import 로 번들한다(오프라인 데스크톱이라 CDN 대신 번들).
 * 대부분 npm 패키지지만 Freesentation 만은 npm 에 없어 woff2 를 저장소에 직접 담았다
 * (src/assets/fonts/). 여기서는 각 폰트의 CSS `font-family` 스택만 정의한다 — 한글이 없는
 * 라틴 폰트(Lato)는 뒤에 'Noto Sans KR' 을 두어 한글이 깨지지 않게 한다.
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
  {
    id: "freesentation",
    label: "Freesentation",
    stack: `'Freesentation', ${SYSTEM_FALLBACK}`,
  },
]

/**
 * 기본 폰트 id — Freesentation.
 *
 * 목록 순서와 무관하다(Freesentation 은 나중에 추가돼 맨 끝에 있다). 이 값을 바꿀 때는
 * **두 곳의 폴백도 같이** 옮겨야 한다 — index.css 의 `html { font-family: var(--ui-font, …) }`
 * 와 markdown-viewer 의 `APP_FONT`. 그 폴백은 `--ui-font` 가 주입되기 전 첫 프레임에 쓰이므로,
 * 어긋나 있으면 앱이 뜨는 순간에만 다른 글꼴이 스쳐 보인다.
 */
export const DEFAULT_FONT_ID = "freesentation"

const DEFAULT_FONT = FONTS.find((f) => f.id === DEFAULT_FONT_ID) ?? FONTS[0]

/** id 로 폰트를 찾는다. 없으면 기본. */
export function getFont(id: string | null | undefined): AppFont {
  return FONTS.find((f) => f.id === id) ?? DEFAULT_FONT
}
