/**
 * `.http` 편집기의 구문 강조 — 투명한 `<textarea>` 뒤에 깔리는 `<pre>` 의 HTML 을 만든다.
 *
 * 파서(`http-parse.ts`)를 쓰지 않고 줄 단위 정규식으로 판단하는 이유: 강조는 타이핑
 * 도중의 **깨진 문법에도 절대 죽지 않아야** 하고(파싱 실패 = 화면이 하얘짐), 어차피
 * 색을 입히는 단위가 줄이다. 대신 `{{변수}}` 는 실제 스코프로 판정해 해결된 것은
 * 초록, 못 찾은 것은 빨간 물결로 그린다 — 이게 IntelliJ 에서 가장 자주 보는 신호다.
 *
 * 색은 프리셋 토큰(`ui-info`/`ui-warning`…)이 아니라 `--http-*`(index.css)에서 온다.
 * IntelliJ HTTP Client 의 팔레트를 그대로 옮긴 값이라 테마 프리셋을 바꿔도 편집기
 * 안에서는 같은 색이어야 하기 때문이다 — 구분자 올리브, 메서드/리터럴 주황,
 * 헤더 이름·JSON 키 보라, 문자열 초록, 숫자 청록.
 */

const METHOD_RE =
  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|PROPFIND|PROPPATCH|MKCOL|COPY|MOVE|LOCK|UNLOCK|GRAPHQL)(\s+)([\s\S]*)$/

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function span(cls: string, text: string): string {
  return text ? `<span class="${cls}">${esc(text)}</span>` : ""
}

/** `{{변수}}` 를 해결 여부에 따라 색칠하고, 나머지는 그대로 이스케이프한다. */
function withVars(text: string, resolve: (name: string) => boolean): string {
  const re = /\{\{\s*([^{}]*?)\s*\}\}/g
  let out = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index))
    const ok = resolve(m[1].trim())
    out += span(
      ok
        ? "text-ui-success"
        : "text-ui-error underline decoration-wavy underline-offset-2",
      m[0]
    )
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}

/**
 * 본문(그리고 어느 규칙에도 걸리지 않은 줄) — JSON 을 눈으로 읽을 수 있을 만큼만
 * 칠한다. 문자열 뒤에 `:` 가 오면 키(보라), 아니면 값(초록)이고, `true/false/null`
 * 과 숫자에 색을 준다. 파서가 아니라 한 줄 스캐너라 깨진 JSON 에도 죽지 않는다.
 */
const BODY_RE =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\{\{\s*[^{}]*?\s*\}\}|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g

function bodyHtml(text: string, resolve: (name: string) => boolean): string {
  const re = new RegExp(BODY_RE.source, "g")
  let out = ""
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out += esc(text.slice(last, m.index))
    if (m[1]) {
      // 문자열 안의 {{변수}} 도 계속 판정해야 하므로 span 을 겹쳐 쓴다.
      out +=
        `<span class="${m[2] ? "text-http-name" : "text-http-string"}">` +
        withVars(m[1], resolve) +
        `</span>` +
        esc(m[2] ?? "")
    } else if (m[0].startsWith("{{")) {
      out += withVars(m[0], resolve)
    } else if (/^(true|false|null)$/.test(m[0])) {
      out += span("text-http-keyword", m[0])
    } else {
      out += span("text-http-number", m[0])
    }
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}

function lineHtml(line: string, resolve: (name: string) => boolean): string {
  if (!line) return ""
  // ### 구분선
  if (/^###/.test(line)) return span("text-http-separator", line)
  // # @name … 지시자
  const dir = line.match(/^(\s*(?:#+|\/\/)\s*)(@[\w-]+)([\s\S]*)$/)
  if (dir)
    return (
      span("text-http-comment", dir[1]) +
      span("text-http-name", dir[2]) +
      span("text-http-comment", dir[3])
    )
  // 주석
  if (/^\s*(#|\/\/)/.test(line)) return span("text-http-comment", line)
  // @var = value
  const decl = line.match(/^(@[\w.\-$]+)(\s*=\s*)([\s\S]*)$/)
  if (decl)
    return (
      span("text-http-name", decl[1]) +
      esc(decl[2]) +
      bodyHtml(decl[3], resolve)
    )
  // METHOD URL — URL 은 기본색 + 밑줄(IntelliJ 와 같다)
  const req = line.match(METHOD_RE)
  if (req)
    return (
      span("text-http-keyword", req[1]) +
      esc(req[2]) +
      `<span class="underline decoration-muted-foreground underline-offset-2">` +
      withVars(req[3], resolve) +
      `</span>`
    )
  // < 끼워넣기 · > 핸들러 · >> 응답 저장
  const marker = line.match(/^(<@?[\w-]*|>>!?|>)(\s+|$)([\s\S]*)$/)
  if (marker)
    return (
      span("text-http-keyword", marker[1]) +
      esc(marker[2]) +
      withVars(marker[3], resolve)
    )
  // 헤더 — 이름은 보라 기울임, 값은 기본색
  const head = line.match(/^([A-Za-z][A-Za-z0-9-]*)(\s*:\s*)([\s\S]*)$/)
  if (head)
    return (
      span("text-http-name italic", head[1]) +
      esc(head[2]) +
      withVars(head[3], resolve)
    )
  return bodyHtml(line, resolve)
}

/** 텍스트 전체를 강조한 HTML(줄 순서 그대로, `\n` 으로 이어 붙인다). */
export function highlightHttp(
  text: string,
  resolve: (name: string) => boolean
): string {
  return text
    .split("\n")
    .map((l) => lineHtml(l.replace(/\r$/, ""), resolve))
    .join("\n")
}
