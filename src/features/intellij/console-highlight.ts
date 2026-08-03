/**
 * 서비스 콘솔(IntelliJ 서비스 · Cowork 서비스)의 구문 강조.
 *
 * 목표는 IntelliJ 콘솔과 **같은 화면**이고, 거기에 이르는 길이 두 개다. 순서대로 시도한다:
 *
 * 1. **ANSI** — Spring Boot 의 `ColorConverter`(logback 패턴의 `%clr(...)`)가 실제로 찍은
 *    색 그대로. IntelliJ 콘솔이 칠하는 것도 이 바이트열을 해석한 결과라, 그대로 옮기면
 *    정의상 동일하다. 우리가 띄운 서비스에는 `standalone.rs` 가
 *    `-Dspring.output.ansi.enabled=always` 를 붙여 주므로(IDE 가 하는 것과 같다) 늘 들어 있다.
 * 2. **패턴** — ANSI 가 한 글자도 없는 줄은 로그 패턴을 직접 뜯어 같은 색을 입힌다.
 *    IDE 로그 동기화(IntelliJ 가 파일로 남긴 콘솔)와, 이미 떠 있던 프로세스를 흡수한 경우가
 *    여기로 온다 — 그 둘은 우리가 색을 켤 기회가 없었던 로그다.
 *
 * 패턴 경로가 아는 모양은 둘. cowork 공용 logback 설정
 * (`share-logging/.../logback-spring.xml`)의
 * `%d{HH:mm:ss.SSS} %5p [traceId,spanId] [%10.10t] %-40.40logger{39}:%3L %-15.15M %m`
 * 과, Spring Boot 기본 콘솔 패턴
 * (`%d ... %5p ${PID} --- [app] [thread] %-40.40logger{39} : %m`). 어느 쪽도 아니면
 * 색을 입히지 않고 원문 그대로 돌려준다 — 잘못 칠하느니 안 칠하는 편이 낫다.
 */

/** 한 줄을 쪼갠 조각. `className` 이 없으면 콘솔 기본색으로 그린다. */
export type LogSegment = {
  text: string
  className?: string
}

const ESC = "\u001b"

/** faint(SGR 2) — IntelliJ 도 흐린 회색으로 그린다. 색 클래스와 겹쳐 쓸 수 있게 투명도로. */
const FAINT = "opacity-55"

/**
 * ANSI 기본 8색(30-37) → 유틸리티 클래스.
 *
 * **클래스 이름은 통째로 적어야 한다.** Tailwind v4 는 소스를 글자로 훑어 실제로 쓰인
 * 클래스만 CSS 로 뽑으므로, `text-${color}` 처럼 조립하면 어느 파일에도
 * `text-console-red` 라는 글자가 없어 규칙이 생성되지 않는다 — 색이 조용히 사라진다.
 */
const BASE_COLORS = [
  "text-console-black",
  "text-console-red",
  "text-console-green",
  "text-console-yellow",
  "text-console-blue",
  "text-console-magenta",
  "text-console-cyan",
  "text-console-white",
] as const

/** ANSI 밝은 8색(90-97). 위와 같은 이유로 완전한 클래스 이름. */
const BRIGHT_COLORS = [
  "text-console-br-black",
  "text-console-br-red",
  "text-console-br-green",
  "text-console-br-yellow",
  "text-console-br-blue",
  "text-console-br-magenta",
  "text-console-br-cyan",
  "text-console-br-white",
] as const

// ────────────────────────────── ANSI ──────────────────────────────

type Style = {
  color?: string
  bold: boolean
  faint: boolean
  italic: boolean
  underline: boolean
}

const NO_STYLE: Style = {
  bold: false,
  faint: false,
  italic: false,
  underline: false,
}

/** 이 줄에 SGR 이스케이프가 하나라도 있는지. */
function hasAnsi(line: string): boolean {
  return line.includes(`${ESC}[`)
}

/**
 * SGR 파라미터 하나를 현재 스타일에 적용한다.
 *
 * 배경색(40-47 · 100-107)은 **일부러 버린다** — 콘솔 배경을 줄마다 바꾸면 로그가
 * 읽히지 않고, Spring Boot 가 쓰는 것도 전경색뿐이다. 모르는 코드도 조용히 무시한다
 * (텍스트는 그대로 나오므로 정보가 사라지지 않는다).
 */
function applySgr(style: Style, code: number): Style {
  if (code === 0) return { ...NO_STYLE }
  if (code === 1) return { ...style, bold: true }
  if (code === 2) return { ...style, faint: true }
  if (code === 3) return { ...style, italic: true }
  if (code === 4) return { ...style, underline: true }
  if (code === 22) return { ...style, bold: false, faint: false }
  if (code === 23) return { ...style, italic: false }
  if (code === 24) return { ...style, underline: false }
  if (code === 39) return { ...style, color: undefined }
  if (code >= 30 && code <= 37)
    return { ...style, color: BASE_COLORS[code - 30] }
  if (code >= 90 && code <= 97)
    return { ...style, color: BRIGHT_COLORS[code - 90] }
  return style
}

function classOf(style: Style): string | undefined {
  const parts: string[] = []
  if (style.color) parts.push(style.color)
  if (style.bold) parts.push("font-bold")
  if (style.faint) parts.push(FAINT)
  if (style.italic) parts.push("italic")
  if (style.underline) parts.push("underline")
  return parts.length > 0 ? parts.join(" ") : undefined
}

/** `ESC[…m` 을 잘라내며 조각을 만든다. 그 밖의 이스케이프(커서 이동 등)는 그대로 남긴다. */
function parseAnsi(line: string): LogSegment[] {
  // 전역 정규식을 모듈 상수로 두면 lastIndex 가 호출 사이에 남는다 — 매번 새로 만든다.
  const re = new RegExp(`${ESC}\\[([0-9;]*)m`, "g")
  const out: LogSegment[] = []
  let style: Style = { ...NO_STYLE }
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      out.push({ text: line.slice(last, m.index), className: classOf(style) })
    }
    // `ESC[m` 은 `ESC[0m` 과 같다(파라미터 생략 = 0).
    const codes = m[1] === "" ? [0] : m[1].split(";").map((s) => Number(s) || 0)
    for (const c of codes) style = applySgr(style, c)
    last = m.index + m[0].length
  }
  if (last < line.length) {
    out.push({ text: line.slice(last), className: classOf(style) })
  }
  return out
}

// ───────────────────────────── 패턴 ─────────────────────────────

/** `2026-08-03T15:33:12.345+09:00` · `2026-08-03 15:33:12,345` · `15:33:12.345` 를 모두 받는다. */
const TIME_RE =
  /^(?:\d{4}-\d{2}-\d{2}[T ])?\d{2}:\d{2}:\d{2}[.,]\d{3}(?:[+-]\d{2}:?\d{2}|Z)?/

/** `%5p` 는 오른쪽 정렬 5자라 앞에 공백이 붙는다. */
const LEVEL_RE = /^(\s+)(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\b/

/** Spring Boot 기본 패턴의 `${PID} ---` 부분. cowork 패턴에는 없다. */
const PID_RE = /^(\s+)(\d+)(\s+)(---)/

/** `[traceId,spanId]` · `[app]` · `[      main]` — 몇 개가 오든 받는다. */
const BRACKET_RE = /^(\s*)(\[[^\]]*\])/

/** `%-40.40logger{39}` + (패딩) + `:`. 로거 이름에 나올 수 있는 글자만 받는다. */
const LOGGER_RE = /^(\s+)([\w.$-]+)(\s*):/

/**
 * `%3L %-15.15M ` — 라인번호와 메서드명.
 *
 * 메시지 첫 낱말이 숫자면(`: 42 rows updated`) 라인번호로 오인할 수 있어서, **메서드
 * 필드의 폭까지 맞을 때만** 인정한다. `%-15.15M` 은 15자로 패딩되고 뒤에 구분 공백이
 * 하나 더 붙으므로 "메서드 + 뒤 공백 ≥ 16" 이 성립한다. 평범한 문장은 여기서 걸러진다.
 */
const LINE_METHOD_RE = /^(\s*)(\d{1,5})(\s+)([\w$]+)(\s+)/
const METHOD_FIELD_W = 16

/** Spring Boot `ColorConverter` 의 레벨 색 그대로 — ERROR 빨강, WARN 노랑, 나머지 초록. */
function levelClass(level: string): string {
  if (level === "ERROR" || level === "FATAL") return "text-console-red"
  if (level === "WARN") return "text-console-yellow"
  return "text-console-green"
}

/**
 * 로그 패턴을 뜯어 조각을 만든다. 시간·레벨로 시작하지 않으면 `null`
 * (스택트레이스 줄, 서드파티 배너, 개행 안 된 출력 등 — 손대지 않는다).
 */
function parsePattern(line: string): LogSegment[] | null {
  const time = TIME_RE.exec(line)
  if (!time) return null

  const level = LEVEL_RE.exec(line.slice(time[0].length))
  if (!level) return null

  const out: LogSegment[] = [
    { text: time[0], className: FAINT },
    { text: level[1] },
    { text: level[2], className: levelClass(level[2]) },
  ]
  let i = time[0].length + level[0].length

  const pid = PID_RE.exec(line.slice(i))
  if (pid) {
    out.push(
      { text: pid[1] },
      { text: pid[2], className: "text-console-magenta" },
      { text: pid[3] },
      { text: pid[4], className: FAINT }
    )
    i += pid[0].length
  }

  // `[traceId,spanId]` · `[app]` · `[thread]` — 개수는 패턴마다 다르다.
  for (;;) {
    const br = BRACKET_RE.exec(line.slice(i))
    if (!br) break
    out.push({ text: br[1] }, { text: br[2], className: FAINT })
    i += br[0].length
  }

  const logger = LOGGER_RE.exec(line.slice(i))
  if (logger) {
    out.push(
      { text: logger[1] },
      { text: logger[2], className: "text-console-cyan" },
      { text: logger[3] },
      { text: ":", className: FAINT }
    )
    i += logger[0].length

    const lm = LINE_METHOD_RE.exec(line.slice(i))
    if (lm && lm[4].length + lm[5].length >= METHOD_FIELD_W) {
      out.push(
        { text: lm[1] },
        { text: lm[2], className: "text-console-cyan" },
        { text: lm[3] },
        { text: lm[4], className: "text-console-magenta" },
        { text: lm[5] }
      )
      i += lm[0].length
    }
  }

  // 남은 것이 메시지 — 색을 입히지 않는다(Spring Boot 도 `%m` 은 그대로 둔다).
  if (i < line.length) out.push({ text: line.slice(i) })
  return out
}

// ───────────────────────────── 진입점 ─────────────────────────────

/**
 * 콘솔 한 줄을 그릴 조각으로 나눈다.
 *
 * 아무 규칙에도 걸리지 않으면 조각 하나(원문 그대로)를 돌려주므로, 호출하는 쪽은
 * 언제나 조각 배열만 그리면 된다.
 */
export function highlightLogLine(line: string): LogSegment[] {
  if (hasAnsi(line)) return parseAnsi(line)
  return parsePattern(line) ?? [{ text: line }]
}
