import rudaksCss from "@/assets/typora/rudaks.css?raw"

/*
 * 뷰어의 **기본** 마크다운 스타일.
 *
 * 원래는 설정에서 사용자의 Typora 테마 css(`~/Library/Application Support/
 * abnerworks.Typora/themes/rudaks.css`)를 읽어 와야 문서가 제대로 보였다 — 그런데 그
 * 경로는 Typora 를 쓰고 그 테마까지 깔아 둔 사람에게만 있다. 앱을 내려받은 사람 대부분은
 * 파일이 없어 "가져오기 실패" 를 보고, 스펙 문서는 최소 스타일로만 표시됐다.
 *
 * 그래서 같은 css 를 `src/assets/typora/rudaks.css` 로 앱에 **번들**해 두고(`?raw` 이므로
 * Vite 의 css 파이프라인을 타지 않고 문자열로만 들어온다), 저장된 스타일이 없으면 이걸
 * 쓴다. 설정의 "스타일 가져오기" 는 그대로 남아 있어, 자기 Typora 테마로 덮어쓸 수 있다.
 *
 * 이 css 는 웹폰트(JetBrains Mono·NanumSquare 등)를 CDN url 로 참조한다. 오프라인이면
 * 폰트만 시스템 기본으로 대체될 뿐 나머지 스타일은 그대로 적용된다.
 */
export const BUNDLED_MARKDOWN_CSS = rudaksCss

/** 저장된 스타일이 있으면 그걸, 없으면 번들 기본 스타일을 쓴다. */
export function effectiveMarkdownCss(saved: string): string {
  return saved.trim() ? saved : BUNDLED_MARKDOWN_CSS
}
