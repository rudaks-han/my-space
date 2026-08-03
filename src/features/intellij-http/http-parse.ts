/**
 * `.http` 파일 파서 — IntelliJ HTTP Client 문법.
 *
 * 파서가 프론트에 있는 이유는 `src-tauri/src/http_file.rs` 헤더에 적어 두었다(편집기가
 * 타이핑과 같은 tick 에 요청 경계·미해결 변수를 알아야 한다).
 *
 * 지원하는 문법 — 실제 사내 저장소(cowork)의 `.http` 파일 400여 개를 훑어 실제로 쓰이는
 * 것만 골랐다:
 *  - `###` 구분선(뒤에 붙은 글자는 요청 이름으로 쓴다) · `# @name` 지시자
 *  - `@var = value` 파일 변수(선언한 지점부터 유효)
 *  - `METHOD URL HTTP/1.1` + 들여쓴 `?a=1` / `&b=2` 이어쓰기
 *  - 헤더와 이어지는 줄(들여쓰기)
 *  - 본문, 그 안의 `< ./file.json` 끼워넣기(바이너리 포함 — multipart 가 이걸로 만들어진다)
 *  - `< {% … %}` 사전 요청 스크립트 · `> {% … %}` 응답 핸들러 · `> ./script.js`
 *  - `>> ./out.json` / `>>! ./out.json` 응답 저장
 *  - `# @no-redirect` · `# @no-cookie-jar` · `# @no-log`
 */

/** 본문의 한 줄 — 파일을 끼워 넣는 줄만 따로 구분한다. */
export type BodyLine =
  | { kind: "text"; text: string }
  | { kind: "include"; ref: string; encoding: string | null }

export interface HttpHeader {
  name: string
  value: string
  /** 0-기준 줄 번호. */
  line: number
}

/** 응답 저장 지시자(`>>` / `>>!`). */
export interface OutputRef {
  ref: string
  /** `>>!` 면 true(덮어쓴다). */
  overwrite: boolean
}

/** 파싱된 요청 하나. */
export interface HttpRequest {
  /** 파일 내 순번(0부터). 응답을 기억하는 키로도 쓴다. */
  index: number
  /** `# @name` 값. 없으면 null. */
  name: string | null
  /** `###` 뒤에 적힌 글자(요청 제목처럼 쓰인다). */
  title: string | null
  /** 요청 앞의 일반 주석들. */
  comments: string[]
  method: string
  /** 변수 치환 전 원문 URL. */
  url: string
  version: string | null
  headers: HttpHeader[]
  body: BodyLine[]
  /** `< {% … %}` 본문(스크립트 원문). */
  preScript: string | null
  /** `< ./pre.js` 참조. */
  preScriptRef: string | null
  /** `> {% … %}` 본문(스크립트 원문). */
  handler: string | null
  /** `> ./handler.js` 참조. */
  handlerRef: string | null
  output: OutputRef | null
  /** 이 요청 시점까지 선언된 파일 변수(`@var`). 값은 치환 전 원문. */
  vars: Record<string, string>
  noRedirect: boolean
  noCookieJar: boolean
  noLog: boolean
  /** 블록 시작 줄(구분선 포함, 0-기준). */
  startLine: number
  /** 메서드/URL 줄 — 거터의 ▶ 를 놓는 자리. */
  requestLine: number
  /** 블록 마지막 줄(포함). */
  endLine: number
}

export interface ParsedFile {
  requests: HttpRequest[]
  /** `###` 구분선 줄 번호들(편집기에서 구분선을 그리는 데 쓴다). */
  separators: number[]
  /** 파일 전체에서 선언된 변수(마지막 값). */
  vars: Record<string, string>
}

/**
 * 요청 줄의 메서드로 인정하는 토큰.
 *
 * 메서드는 생략할 수 있어서(그러면 GET) "첫 토큰이 메서드인가"를 판단해야 하는데,
 * 목록에 없는 대문자 토큰을 메서드로 받아 주면 `http://…` 만 적힌 줄의 스킴을
 * 메서드로 오해할 수 있다. 그래서 화이트리스트로 둔다.
 */
const METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "GRAPHQL",
]

/** 주석 줄인지(`#` 또는 `//`). `###` 는 구분선이라 호출부에서 먼저 걸러진다. */
function isComment(line: string): boolean {
  return /^\s*(#|\/\/)/.test(line)
}

/** `# @name value` 형태의 지시자. */
function directive(line: string): { key: string; value: string } | null {
  const m = line.match(/^\s*(?:#+|\/\/)\s*@([\w-]+)\s*=?\s*(.*)$/)
  if (!m) return null
  return { key: m[1].toLowerCase(), value: m[2].trim() }
}

/** `@var = value` 파일 변수 선언. */
function varDecl(line: string): { key: string; value: string } | null {
  const m = line.match(/^@([\w.\-$]+)\s*=\s*(.*)$/)
  if (!m) return null
  return { key: m[1], value: m[2].trim() }
}

/** `< ./file` · `<@utf-8 ./file` 형태의 끼워넣기. */
function includeRef(
  line: string
): { ref: string; encoding: string | null } | null {
  const m = line.match(/^<(@[\w-]*)?\s+(\S.*)$/)
  if (!m) return null
  return { ref: m[2].trim(), encoding: m[1] ? m[1].slice(1) || null : null }
}

/** 파일을 파싱한다. */
export function parseHttpFile(text: string): ParsedFile {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const separators: number[] = []
  lines.forEach((l, i) => {
    if (/^###/.test(l)) separators.push(i)
  })

  // 블록 경계: 파일 시작 + 각 구분선. 첫 구분선 앞에도 요청이나 변수 선언이 올 수 있다.
  const starts = separators[0] === 0 ? [...separators] : [0, ...separators]
  const requests: HttpRequest[] = []
  // 파일 변수는 블록을 넘어 누적된다(선언 지점 이후부터 유효 — IntelliJ 와 같다).
  const vars: Record<string, string> = {}

  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : lines.length
    const req = parseBlock(lines, start, end, vars, requests.length)
    if (req) requests.push(req)
  })

  return { requests, separators, vars }
}

/**
 * 블록 하나를 파싱한다. 요청 줄이 없으면(변수 선언·주석만 있는 블록) null.
 *
 * `vars` 는 **호출자가 계속 채워 나가는 같은 객체**다 — 이 블록에서 선언한 변수가
 * 다음 블록에도 보여야 하므로 여기서 직접 갱신하고, 요청에는 그 시점의 사본을 담는다.
 */
function parseBlock(
  all: string[],
  from: number,
  to: number,
  vars: Record<string, string>,
  index: number
): HttpRequest | null {
  let title: string | null = null
  let name: string | null = null
  const comments: string[] = []
  let noRedirect = false
  let noCookieJar = false
  let noLog = false
  let preScript: string | null = null
  let preScriptRef: string | null = null
  let method = "GET"
  let url = ""
  let version: string | null = null
  const headers: HttpHeader[] = []
  const body: BodyLine[] = []
  let handler: string | null = null
  let handlerRef: string | null = null
  let output: OutputRef | null = null
  let requestLine = -1
  let phase: "pre" | "headers" | "body" | "after" = "pre"

  let i = from
  if (/^###/.test(all[from])) {
    title = all[from].replace(/^#+/, "").trim() || null
    i = from + 1
  }

  /** `{% … %}` 스크립트 블록을 읽어 원문을 돌려주고 `i` 를 끝 줄로 옮긴다. */
  const readScript = (first: string): string => {
    const open = first.indexOf("{%")
    let out = first.slice(open + 2)
    // 한 줄에 열고 닫는 경우.
    const closeSame = out.indexOf("%}")
    if (closeSame >= 0) return out.slice(0, closeSame)
    const parts: string[] = [out]
    while (++i < to) {
      const l = all[i].replace(/\r$/, "")
      const close = l.indexOf("%}")
      if (close >= 0) {
        parts.push(l.slice(0, close))
        break
      }
      parts.push(l)
    }
    out = parts.join("\n")
    return out
  }

  for (; i < to; i++) {
    const line = all[i].replace(/\r$/, "")

    if (phase === "pre") {
      if (!line.trim()) continue
      const d = directive(line)
      if (d) {
        if (d.key === "name") name = d.value || null
        else if (d.key === "no-redirect") noRedirect = true
        else if (d.key === "no-cookie-jar") noCookieJar = true
        else if (d.key === "no-log") noLog = true
        else comments.push(line.replace(/^\s*(#+|\/\/)\s?/, ""))
        continue
      }
      if (isComment(line)) {
        comments.push(line.replace(/^\s*(#+|\/\/)\s?/, ""))
        continue
      }
      const v = varDecl(line)
      if (v) {
        vars[v.key] = v.value
        continue
      }
      if (/^<\s*\{%/.test(line)) {
        preScript = readScript(line)
        continue
      }
      const inc = includeRef(line)
      if (inc) {
        preScriptRef = inc.ref
        continue
      }
      // 남은 것은 요청 줄.
      let rest = line.trim()
      const m = rest.match(/^([A-Za-z]+)\s+(\S.*)$/)
      if (m && METHODS.includes(m[1].toUpperCase())) {
        method = m[1].toUpperCase()
        rest = m[2].trim()
      }
      const vm = rest.match(/\s+(HTTP\/[\d.]+)\s*$/)
      if (vm) {
        version = vm[1]
        rest = rest.slice(0, vm.index).trimEnd()
      }
      url = rest
      requestLine = i
      phase = "headers"
      continue
    }

    if (phase === "headers") {
      // URL 이어쓰기 — 헤더를 아직 하나도 읽지 않았을 때만 URL 로 붙인다.
      if (headers.length === 0 && /^\s*[?&]/.test(line)) {
        url += line.trim()
        continue
      }
      if (!line.trim()) {
        phase = "body"
        continue
      }
      if (
        /^>>!?\s/.test(line) ||
        /^>\s*\{%/.test(line) ||
        /^>\s+\S/.test(line)
      ) {
        phase = "body"
        i-- // 아래 body 처리에서 다시 보게 한다.
        continue
      }
      if (isComment(line)) continue
      const hm = line.match(/^([^\s:]+)\s*:\s*(.*)$/)
      if (hm) {
        headers.push({ name: hm[1], value: hm[2].trim(), line: i })
        continue
      }
      // 들여쓴 줄은 앞 헤더 값의 계속.
      if (/^\s+\S/.test(line) && headers.length > 0) {
        headers[headers.length - 1].value += " " + line.trim()
        continue
      }
      // 그 밖의 줄은 본문 시작으로 본다(빈 줄을 빼먹은 파일 구제).
      phase = "body"
      i--
      continue
    }

    if (phase === "body") {
      if (/^>\s*\{%/.test(line)) {
        handler = readScript(line)
        phase = "after"
        continue
      }
      const om = line.match(/^>>(!?)\s+(\S.*)$/)
      if (om) {
        output = { ref: om[2].trim(), overwrite: om[1] === "!" }
        phase = "after"
        continue
      }
      const hm = line.match(/^>\s+(\S.*)$/)
      if (hm) {
        handlerRef = hm[1].trim()
        phase = "after"
        continue
      }
      const inc = includeRef(line)
      if (inc) {
        body.push({ kind: "include", ref: inc.ref, encoding: inc.encoding })
        continue
      }
      body.push({ kind: "text", text: line })
      continue
    }

    // phase === "after": 핸들러 뒤에 붙는 응답 저장/추가 핸들러만 더 받는다.
    if (/^>\s*\{%/.test(line)) {
      handler = (handler ? handler + "\n" : "") + readScript(line)
      continue
    }
    const om = line.match(/^>>(!?)\s+(\S.*)$/)
    if (om) output = { ref: om[2].trim(), overwrite: om[1] === "!" }
  }

  if (requestLine < 0) return null

  // 본문 앞뒤의 빈 줄은 버린다(구분선 앞의 여백이 본문에 섞이는 것을 막는다).
  while (body.length && body[0].kind === "text" && !body[0].text.trim())
    body.shift()
  while (
    body.length &&
    body[body.length - 1].kind === "text" &&
    !(body[body.length - 1] as { text: string }).text.trim()
  )
    body.pop()

  return {
    index,
    name,
    title,
    comments,
    method,
    url,
    version,
    headers,
    body,
    preScript,
    preScriptRef,
    handler,
    handlerRef,
    output,
    vars: { ...vars },
    noRedirect,
    noCookieJar,
    noLog,
    startLine: from,
    requestLine,
    endLine: to - 1,
  }
}

/** 목록·응답 탭에 쓸 요청 표시 이름. */
export function requestLabel(req: HttpRequest): string {
  return req.name || req.title || `${req.method} ${req.url}` || "요청"
}

/** 커서(줄 번호)가 속한 요청을 찾는다. 없으면 null. */
export function requestAtLine(
  requests: HttpRequest[],
  line: number
): HttpRequest | null {
  for (const r of requests) {
    if (line >= r.startLine && line <= r.endLine) return r
  }
  return null
}
