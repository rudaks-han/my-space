import { useEffect, useRef } from "react"

import { effectiveMarkdownCss } from "./bundled-css"
import { renderMermaid } from "./mermaid"

/*
 * 마크다운 뷰어. Typora 테마 css 를 "있는 그대로" 적용해야 Typora 와 같은 화면이 되는데,
 * 그 css 는 `*`·`body`·`html`·`#write` 같은 전역 선택자를 마구 쓴다 — 앱 본문에 그대로
 * 주입하면 앱 전체가 망가진다. 그래서 **섀도 DOM** 에 문서와 css 를 가둬 완전히 격리한다.
 *
 * 섀도 트리 안에는 html/body 요소가 없으므로 css 의 `html`·`body` 선택자는 아무 데도
 * 걸리지 않는다. 이 둘을 `:host` 로 바꿔(adaptTyporaCss) 폰트 크기·본문 색이 살아나게 한다.
 * Typora 는 라이트 테마 문서이므로 앱이 다크 모드라도 문서 자체는 흰 배경으로 그린다.
 *
 * `css` prop 은 설정에 저장된 사용자 테마다 — 비어 있으면 앱에 번들된 기본 테마를 쓴다
 * (`bundled-css.ts`). 즉 Typora 가 없는 사람도 첫 실행부터 같은 화면을 본다.
 */

/** Typora css 를 섀도 DOM 에 맞게 살짝 손본다(html/body → :host). */
function adaptTyporaCss(css: string): string {
  return css
    .replace(/(^|[},])(\s*)html\b/g, "$1$2:host")
    .replace(/(^|[},])(\s*)body\b/g, "$1$2:host")
}

/** 테마 css 위에 항상 깔아 두는 최소 기반 스타일. */
const BASE_CSS = `
:host {
  display: block;
  box-sizing: border-box;
  height: 100%;
  overflow: auto;
  background: #ffffff;
  color: rgb(51, 51, 51);
  font-size: 16px;
  line-height: 1.6;
  font-family: -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo",
    "Helvetica Neue", Arial, sans-serif;
  /* 앱 크롬이 전역으로 user-select:none 을 걸어 두어 본문 드래그 복사가 막힌다.
     문서는 읽고 복사하는 대상이므로 뷰어 안에서는 텍스트 선택을 되살린다. */
  -webkit-user-select: text;
  user-select: text;
  cursor: auto;
}
*, *::before, *::after {
  box-sizing: border-box;
  -webkit-user-select: text;
  user-select: text;
}
#write {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 40px 96px;
}
img { max-width: 100%; }
table { border-collapse: collapse; }

/* mermaid 다이어그램: 그려지기 전 원문이 잠깐 스쳐 보이지 않도록 숨겼다가,
   렌더 성공(.is-rendered) 또는 실패(.is-error) 시 보여 준다. */
.mermaid-diagram { margin: 1em 0; overflow-x: auto; }
.mermaid-diagram:not(.is-rendered):not(.is-error) { visibility: hidden; }
.mermaid-diagram.is-rendered { text-align: center; }
.mermaid-diagram.is-rendered svg { max-width: 100%; height: auto; }
.mermaid-diagram.is-error {
  white-space: pre-wrap;
  font-family: "JetBrains Mono", Menlo, Consolas, monospace;
  font-size: 0.85em;
  color: #b00020;
  background: #fff5f5;
  border: 1px solid #f0c0c0;
  border-radius: 6px;
  padding: 10px 12px;
}
`

export function MarkdownViewer({
  html,
  css,
  scrollResetKey,
}: {
  html: string
  css: string
  /**
   * "다른 문서로 바뀌었다"를 알리는 값 — 이게 바뀔 때만 스크롤을 맨 위로 되돌린다.
   * 생략하면 본문(html)이 바뀔 때마다 되돌린다(스펙 문서 뷰처럼 읽기 전용인 화면의 동작).
   * 마크다운 뷰어처럼 원문을 고쳐 가며 보는 화면은 문서 식별자를 넘겨야 한다 —
   * 그렇지 않으면 한 글자 칠 때마다 미리보기가 맨 위로 튄다.
   */
  scrollResetKey?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<ShadowRoot | null>(null)
  const styleRef = useRef<HTMLStyleElement | null>(null)
  const writeRef = useRef<HTMLDivElement | null>(null)

  // 섀도 루트와 그 안의 style·#write 노드는 최초 1회만 만든다.
  useEffect(() => {
    const hostEl = hostRef.current
    if (!hostEl || shadowRef.current) return
    const shadow = hostEl.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    const write = document.createElement("div")
    write.id = "write"
    shadow.append(style, write)
    shadowRef.current = shadow
    styleRef.current = style
    writeRef.current = write
  }, [])

  // 테마 css 가 바뀌면 스타일을 다시 주입한다. 저장된 css 가 비어 있으면
  // 앱에 번들된 기본 스타일을 쓰므로, 주입할 css 가 아예 없는 경우는 없다.
  useEffect(() => {
    if (styleRef.current) {
      styleRef.current.textContent =
        BASE_CSS + adaptTyporaCss(effectiveMarkdownCss(css))
    }
  }, [css])

  // 본문이 바뀌면 갈아 끼운다.
  useEffect(() => {
    const write = writeRef.current
    if (!write) return
    write.innerHTML = html
    // mermaid 코드펜스가 있으면 다이어그램으로 그린다(mermaid 는 이때만 동적 로드).
    const blocks = write.querySelectorAll<HTMLElement>(".mermaid-diagram")
    if (blocks.length) void renderMermaid(blocks)
  }, [html])

  // 다른 문서로 바뀌었으면 처음부터 보여 준다(본문 교체 이펙트 다음에 와야 한다).
  // :host 가 overflow:auto 이므로 스크롤 컨테이너는 호스트 요소 자신이다.
  const resetKey = scrollResetKey ?? html
  useEffect(() => {
    hostRef.current?.scrollTo(0, 0)
  }, [resetKey])

  return <div ref={hostRef} className="h-full min-h-0 flex-1" />
}
