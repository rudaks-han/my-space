import CodeMirror from "codemirror"
// runMode 애드온: 편집기 인스턴스를 만들지 않고 코드를 토큰화만 해서 콜백으로 넘겨 준다.
import "codemirror/addon/runmode/runmode.js"
// 언어 모드들 — **여기 있는 것만** 아래 EXT 표에 적을 수 있다(파일 맨 아래 주석 참고).
// htmlmixed 는 xml·css·javascript 에 의존하므로 그 셋보다 뒤에 와야 한다.
import "codemirror/mode/xml/xml.js"
import "codemirror/mode/css/css.js"
import "codemirror/mode/javascript/javascript.js"
import "codemirror/mode/htmlmixed/htmlmixed.js"
import "codemirror/mode/clike/clike.js"
import "codemirror/mode/groovy/groovy.js"
import "codemirror/mode/sql/sql.js"
import "codemirror/mode/yaml/yaml.js"
import "codemirror/mode/python/python.js"
import "codemirror/mode/shell/shell.js"
import "codemirror/mode/properties/properties.js"
import "codemirror/mode/markdown/markdown.js"
import "codemirror/mode/toml/toml.js"
import "codemirror/mode/dockerfile/dockerfile.js"
import "codemirror/mode/diff/diff.js"
import "codemirror/mode/protobuf/protobuf.js"
import "codemirror/mode/velocity/velocity.js"
import "codemirror/mode/nginx/nginx.js"
import "codemirror/mode/rust/rust.js"
import "codemirror/mode/go/go.js"

/*
 * 편집기 버퍼의 구문 강조 엔진 — 확장자 → CodeMirror 모드 → `.cm-*` span HTML.
 *
 * `features/cowork-spec/highlight.ts` 와 같은 runMode 방식이지만 **일부러 별도 모듈**이다.
 * 그쪽은 "마크다운 코드펜스를 Typora css 로 칠하는 일"이고(그래서 css 선택자가 기대하는
 * `lang` 속성값까지 함께 돌려준다), 여기는 "편집기에 열린 파일 하나를 칠하는 일"이라
 * 입력(확장자)도 출력(색 토큰 css)도 다르다. 한 함수로 합치면 코드펜스 언어 이름과
 * 파일 확장자가 한 표에 섞여, 어느 쪽을 고쳐도 다른 쪽이 조용히 달라진다.
 *
 * 색은 `index.css` 의 `--code-*` 토큰이 `.dev-code .cm-*` 규칙으로 입힌다 — 이 파일은
 * 클래스 이름만 만들고 색은 하나도 정하지 않는다.
 */

/**
 * 강조를 포기하는 크기 상한. 여기 열리는 버퍼는 2MB 까지라(그 위는 애초에 읽기 전용),
 * 전체를 토큰화하면 탭을 켤 때마다 수백 ms 씩 멈춘다. 넘으면 이스케이프한 원문만
 * 돌려주므로 파일은 그대로 열리고 색만 없다.
 *
 * 비교는 바이트가 아니라 `text.length`(UTF-16 코드 유닛)로 한다 — 정확한 바이트 수를
 * 세려면 `TextEncoder` 로 전체를 한 번 더 훑어야 하는데, 512KB 짜리 문턱에서 최대 2배
 * 어긋나는 것은 "이 파일은 크다"는 판단을 바꾸지 않는다.
 */
export const MAX_HIGHLIGHT_BYTES = 512 * 1024

/**
 * 확장자(소문자, 점 없음) → CodeMirror mime.
 *
 * **위 import 목록에 없는 모드를 여기 적으면 안 된다.** runMode 는 모르는 모드를 만나면
 * 예외를 던지지 않고 null 모드로 조용히 넘어가 모든 토큰의 style 이 null 로 돌아온다 —
 * 즉 "강조가 안 되는데 에러도 없는" 상태가 된다. 같은 이유로 `codemirror/mode/meta.js`
 * (150여 개 모드 이름을 아는 표)는 쓰지 않는다: 그 표는 우리가 불러오지도 않은 모드를
 * 가리키므로, 표에 있으니 될 것처럼 보이고 실제로는 흑백으로 나온다.
 */
const EXT: Record<string, string> = {
  // ── JVM 계열(이 저장소의 대부분) — clike 하나가 java·kotlin·scala 를 모두 덮는다 ──
  java: "text/x-java",
  kt: "text/x-kotlin",
  kts: "text/x-kotlin",
  scala: "text/x-scala",
  groovy: "text/x-groovy",
  gradle: "text/x-groovy", // build.gradle 은 Groovy DSL 이다(.kts 는 위의 kotlin).
  c: "text/x-csrc",
  h: "text/x-csrc",
  cpp: "text/x-c++src",
  cs: "text/x-csharp",

  // ── 스크립트/JSON ──
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  json: "application/json",
  // json5 전용 모드는 없다. 주석·후행 콤마는 json 모드가 오류로 칠하지만, 파일 전체가
  // 흑백으로 나오는 것보다는 낫다.
  json5: "application/json",

  // ── 마크업/스타일 ──
  html: "htmlmixed",
  htm: "htmlmixed",
  // `.vue` 전용 모드는 coffeescript·sass·stylus·pug·handlebars 를 전부 끌고 온다.
  // 단일 파일 컴포넌트는 결국 `<template>`·`<script>`·`<style>` 세 조각이고 그 분배가
  // htmlmixed 가 하는 일이라, 모드 다섯 개를 더 싣는 값을 못 한다.
  vue: "htmlmixed",
  css: "text/css",
  scss: "text/x-scss",
  less: "text/x-less",
  xml: "application/xml",
  xsd: "application/xml",
  xsl: "application/xml",
  svg: "application/xml",

  // ── 설정/데이터 ──
  sql: "text/x-sql",
  yml: "text/x-yaml",
  yaml: "text/x-yaml",
  properties: "text/x-properties",
  ini: "text/x-properties",
  conf: "text/x-properties",
  env: "text/x-properties",
  toml: "text/x-toml",

  // ── 그 외 ──
  sh: "text/x-sh",
  bash: "text/x-sh",
  zsh: "text/x-sh",
  py: "text/x-python",
  md: "text/x-markdown",
  markdown: "text/x-markdown",
  dockerfile: "text/x-dockerfile",
  diff: "text/x-diff",
  patch: "text/x-diff",
  proto: "text/x-protobuf",
  vm: "text/velocity", // Velocity 템플릿 — cowork 의 메일/문서 템플릿이 이걸 쓴다.
  rs: "text/x-rustsrc",
  go: "text/x-go",
}

/**
 * 확장자가 없거나 확장자로는 알 수 없는 파일 — **파일명 전체**(소문자)로 판단한다.
 * `Dockerfile`·`Jenkinsfile` 처럼 확장자가 아예 없는 것들이 실제로 흔하다.
 */
const NAMES: Record<string, string> = {
  dockerfile: "text/x-dockerfile",
  jenkinsfile: "text/x-groovy", // Jenkins 파이프라인은 Groovy DSL 이다.
  // Makefile 모드는 CodeMirror 5 에 없다. 레시피가 곧 셸이고 주석도 `#` 라 shell 이
  // 가장 가깝다 — 탭 들여쓰기와 `$(VAR)` 는 색이 안 붙지만 나머지는 맞는다.
  makefile: "text/x-sh",
  // ignore 계열은 "주석과 나머지"뿐이라 `#` 만 구분되면 충분하다. properties 모드는
  // `=` 가 없는 줄 전체를 키로 칠해 온통 파랗게 되므로 shell 을 쓴다.
  ".gitignore": "text/x-sh",
  ".dockerignore": "text/x-sh",
  ".gitattributes": "text/x-sh",
  ".editorconfig": "text/x-properties",
  ".env": "text/x-properties",
  "nginx.conf": "text/x-nginx-conf",
}

/**
 * 파일 경로 → CodeMirror mime. 모르는 종류면 `null`(= 강조 없이 원문).
 *
 * 판단 순서가 중요하다: 파일명 전체를 먼저 본다. `.env` 나 `.gitignore` 는 "확장자만
 * 있는 이름"이라 확장자로 자르면 `env`·`gitignore` 가 되고, 앞의 `.env.local` 같은
 * 변형도 파일명 쪽에서 접두사로 잡아야 한다.
 */
export function modeForPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  if (!base) return null

  const byName = NAMES[base]
  if (byName) return byName
  /*
   * `Dockerfile.dev`·`.env.local`·`docker-compose.override.yml` 처럼 뒤에 뭐가 더 붙는
   * 관용이 흔하다. 확장자 표를 먼저 보면 `.dev`·`.local` 같은 무의미한 확장자에 걸려
   * null 이 나오므로, 파일명 접두사 판정을 확장자보다 앞에 둔다.
   */
  for (const name of ["dockerfile", ".env"])
    if (base.startsWith(name + ".")) return NAMES[name]

  const dot = base.lastIndexOf(".")
  if (dot <= 0) return null // 확장자가 없거나 `.foo`(위에서 이미 봤다)
  return EXT[base.slice(dot + 1)] ?? null
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * 버퍼 하나를 `.cm-*` span 이 든 HTML 문자열로 만든다.
 *
 * `mode` 가 null 이거나 파일이 상한을 넘으면 **이스케이프한 원문**을 돌려준다 — 호출
 * 쪽에 분기가 생기지 않도록(경로가 하나여야 `<pre>` 가 언제나 innerHTML 한 번으로 끝난다).
 * 어느 분기로 나가도 이스케이프는 반드시 거친다: 결과는 `dangerouslySetInnerHTML` 로
 * 들어가므로, `<script>` 가 든 `.java` 파일을 열었다는 이유로 스크립트가 실행되면 안 된다.
 *
 * 줄 수는 절대 바뀌지 않는다(runMode 는 줄바꿈을 그대로 통과시키고 우리도 손대지 않는다).
 * 거터의 줄 번호와 컨테이너 높이가 `text` 의 줄 수로 계산되므로 이건 계약이다.
 */
export function highlightCode(text: string, mode: string | null): string {
  if (!mode || text.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(text)

  let html = ""
  try {
    CodeMirror.runMode(text, mode, (token, style) => {
      const escaped = escapeHtml(token)
      if (style) {
        // CodeMirror 의 스타일 문자열("string property")을 클래스로("cm-string cm-property").
        html += `<span class="cm-${style.replace(/ +/g, " cm-")}">${escaped}</span>`
      } else {
        html += escaped
      }
    })
  } catch {
    // 토큰화가 깨져도 파일은 보여 준다. 색만 없는 편집기가, 열리지 않는 편집기보다 낫다.
    return escapeHtml(text)
  }
  return html
}
