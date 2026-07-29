import CodeMirror from "codemirror"
// runMode 애드온: 편집기를 만들지 않고 코드를 토큰화만 해서 콜백으로 넘겨 준다.
import "codemirror/addon/runmode/runmode.js"
// 언어 모드들. htmlmixed 는 xml·css·javascript 에 의존하므로 그보다 먼저 불러온다.
import "codemirror/mode/xml/xml.js"
import "codemirror/mode/css/css.js"
import "codemirror/mode/javascript/javascript.js"
import "codemirror/mode/htmlmixed/htmlmixed.js"
import "codemirror/mode/clike/clike.js"
import "codemirror/mode/sql/sql.js"
import "codemirror/mode/yaml/yaml.js"
import "codemirror/mode/python/python.js"
import "codemirror/mode/shell/shell.js"
import "codemirror/mode/properties/properties.js"
import "codemirror/mode/http/http.js"
import "codemirror/mode/markdown/markdown.js"

/*
 * Typora 와 "같은" 구문 색을 내려면 같은 엔진으로 토큰화해야 한다.
 * Typora 는 CodeMirror 5 기반이고, 가져온 테마 css 는 전부 CodeMirror 토큰 클래스
 * (`.md-fences[lang="java"] .cm-keyword` …)를 겨냥한다. 그래서 여기서도 CodeMirror 5 의
 * runMode 로 토큰화해 동일한 `.cm-*` span 을 만든다 — 그러면 그 css 가 그대로 색을 입힌다.
 *
 * lang 은 css 선택자와 정확히 맞아야 하므로(예: css 는 `[lang="typescript"]` 만 있고
 * `[lang="ts"]` 는 없다), 코드펜스에 적힌 언어를 css 가 아는 표준 이름으로 정규화한다.
 */

/** 코드펜스 언어 → { CodeMirror mime, css 가 기대하는 lang 속성값 }. */
const LANGS: Record<string, { mode: string; lang: string }> = {
  java: { mode: "text/x-java", lang: "java" },
  kt: { mode: "text/x-kotlin", lang: "kotlin" },
  kotlin: { mode: "text/x-kotlin", lang: "kotlin" },
  scala: { mode: "text/x-scala", lang: "scala" },
  c: { mode: "text/x-csrc", lang: "c" },
  cpp: { mode: "text/x-c++src", lang: "cpp" },
  "c++": { mode: "text/x-c++src", lang: "cpp" },
  cs: { mode: "text/x-csharp", lang: "csharp" },
  csharp: { mode: "text/x-csharp", lang: "csharp" },
  js: { mode: "text/javascript", lang: "javascript" },
  jsx: { mode: "text/javascript", lang: "javascript" },
  javascript: { mode: "text/javascript", lang: "javascript" },
  ts: { mode: "text/typescript", lang: "typescript" },
  tsx: { mode: "text/typescript", lang: "typescript" },
  typescript: { mode: "text/typescript", lang: "typescript" },
  json: { mode: "application/json", lang: "json" },
  xml: { mode: "application/xml", lang: "xml" },
  html: { mode: "htmlmixed", lang: "html" },
  htm: { mode: "htmlmixed", lang: "html" },
  css: { mode: "text/css", lang: "css" },
  sql: { mode: "text/x-sql", lang: "sql" },
  yaml: { mode: "text/x-yaml", lang: "yaml" },
  yml: { mode: "text/x-yaml", lang: "yaml" },
  python: { mode: "text/x-python", lang: "python" },
  py: { mode: "text/x-python", lang: "python" },
  sh: { mode: "text/x-sh", lang: "bash" },
  bash: { mode: "text/x-sh", lang: "bash" },
  shell: { mode: "text/x-sh", lang: "bash" },
  zsh: { mode: "text/x-sh", lang: "bash" },
  properties: { mode: "text/x-properties", lang: "properties" },
  ini: { mode: "text/x-properties", lang: "properties" },
  http: { mode: "message/http", lang: "http" },
  markdown: { mode: "text/x-markdown", lang: "markdown" },
  md: { mode: "text/x-markdown", lang: "markdown" },
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * 코드펜스 하나를 하이라이트한다.
 *
 * @returns css 가 기대하는 `lang` 속성값과, `.cm-*` span 이 들어간 HTML. 지원하지 않는
 *   언어(또는 언어 표기가 없을 때)는 토큰 span 없이 이스케이프한 원문만 담아 돌려준다
 *   (이 경우 테마의 코드펜스 기본색만 입혀진다 — Typora 도 정의 안 된 언어는 그렇게 둔다).
 */
export function highlight(
  code: string,
  rawLang: string
): { lang: string; html: string } {
  const key = rawLang.trim().toLowerCase()
  const entry = LANGS[key]
  if (!entry) {
    return { lang: key, html: escapeHtml(code) }
  }

  let html = ""
  try {
    CodeMirror.runMode(code, entry.mode, (token, style) => {
      const escaped = escapeHtml(token)
      if (style) {
        // CodeMirror 스타일("string property")을 클래스("cm-string cm-property")로.
        const cls = "cm-" + style.replace(/ +/g, " cm-")
        html += `<span class="${cls}">${escaped}</span>`
      } else {
        html += escaped
      }
    })
  } catch {
    // 토큰화 중 문제가 생겨도 문서는 보여 준다(원문 그대로).
    return { lang: entry.lang, html: escapeHtml(code) }
  }
  return { lang: entry.lang, html }
}
