import { marked, type Tokens } from "marked"

import { highlight } from "./highlight"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/*
 * 스펙 문서(md)를 HTML 로 변환한다. 스타일은 Typora 테마 css 를 그대로 쓰므로(뷰어가
 * 섀도 DOM 에 주입), 여기서는 Typora 의 DOM 구조에 최대한 맞춰 HTML 을 만든다.
 *
 * 핵심은 코드펜스다 — Typora(CodeMirror 5 기반)는 펜스를 `.md-fences[lang="..."]` 안에
 * `.cm-*` 토큰 span 으로 그리고, 테마 css 가 그 선택자로 배경·구문색을 입힌다. 그래서
 * highlight() 로 같은 엔진(CodeMirror 5 runMode)의 토큰 span 을 만들어 그대로 재현한다.
 *
 * `<code>` 로 감싸지 않는 이유: 테마 css 의 인라인 코드 규칙(`code { … }`)이 걸려
 * 펜스 안에 밝은 상자가 생기기 때문. span 들을 `.md-fences` 바로 아래 두어야 인접
 * 선택자(`span.cm-keyword + span.cm-variable-3` …)도 Typora 와 똑같이 동작한다.
 */

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }: Tokens.Code): string {
      // mermaid 는 색칠 대상이 아니라 다이어그램으로 그려야 한다. 원문을 컨테이너에 담아
      // 두면 뷰어가 이를 찾아 SVG 로 렌더링한다(markdown-viewer.tsx).
      if ((lang ?? "").trim().toLowerCase() === "mermaid") {
        return `<div class="mermaid-diagram">${escapeHtml(text)}</div>\n`
      }
      const { lang: canonical, html } = highlight(text, lang ?? "")
      const langAttr = canonical ? ` lang="${canonical}"` : ""
      return `<pre class="md-fences"${langAttr}>${html}</pre>\n`
    },
  },
})

/** 마크다운 원문을 HTML 문자열로 변환한다. */
export function renderMarkdown(source: string): string {
  return marked.parse(source, { async: false }) as string
}
