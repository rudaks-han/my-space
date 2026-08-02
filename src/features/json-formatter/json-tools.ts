/**
 * JSON 포맷터의 순수 로직 — 파싱·오류 위치 계산·가공.
 *
 * **왜 파서를 직접 두는가.** 이 앱은 WKWebView(JavaScriptCore) 위에서 돌고, JSC 의
 * `JSON.parse` 오류 메시지에는 **위치가 없다** — V8 의 `... at position 12` 에 해당하는
 * 정보를 주지 않고 `JSON Parse error: Expected '"'` 로 끝난다. "몇 번째 줄이 틀렸는지"
 * 를 못 알려 주면 포맷터로서 반쪽이라, 재귀 하강 파서를 두고 실패 지점의 오프셋을
 * 줄/칸으로 환산한다. 성공 경로는 네이티브가 훨씬 빠르니 뷰가 `JSON.parse` 를 먼저
 * 쓰고, 이 파서는 **그게 실패했을 때만** 돈다.
 *
 * `lenient` 는 로그나 소스코드에서 긁어 온 "JSON 같은 것"(주석, 마지막 쉼표,
 * 홑따옴표, 따옴표 없는 키)까지 받아 주는 모드다. 기본은 꺼져 있고, 엄격 파싱이
 * 실패했을 때 뷰가 사용자에게 물어보고 켠다 — 조용히 허용하면 "이 앱은 통과했는데
 * 서버는 거절하는" 입력을 유효하다고 알려 주는 셈이 된다.
 */

export interface JsonParseError {
  message: string
  /** 1-based 줄 번호. */
  line: number
  /** 1-based 칸 번호. */
  column: number
  /** 0-based 문자 오프셋(캐럿 이동에 쓴다). */
  index: number
}

export type JsonParseResult =
  { ok: true; value: unknown } | { ok: false; error: JsonParseError }

export interface JsonParseOptions {
  /** 주석 · 마지막 쉼표 · 홑따옴표 · 따옴표 없는 키를 허용한다. */
  lenient?: boolean
}

/**
 * 파싱 실패를 오프셋과 함께 위로 던지는 내부 예외.
 * (필드를 생성자 파라미터로 선언하지 않는다 — `erasableSyntaxOnly` 가 막는다.)
 */
class ParseFailure {
  message: string
  index: number
  constructor(message: string, index: number) {
    this.message = message
    this.index = index
  }
}

// sticky(`y`) 정규식 — lastIndex 위치에서만 매칭하므로 토크나이저에 그대로 쓸 수 있다.
const NUMBER_STRICT = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const NUMBER_LENIENT = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y
const HEX4 = /^[0-9a-fA-F]{4}$/
/** 숫자 바로 뒤에 오면 안 되는 문자(`01`, `1.2.3`, `1abc` 를 잡는다). */
const NUMBER_TAIL = /[A-Za-z0-9_$.]/

/** JSON 텍스트를 파싱한다. 실패하면 사람이 읽을 메시지와 줄/칸을 돌려준다. */
export function parseJson(
  text: string,
  opts: JsonParseOptions = {}
): JsonParseResult {
  const lenient = opts.lenient === true
  const len = text.length
  let i = 0

  function fail(message: string, at: number = i): never {
    throw new ParseFailure(message, Math.min(at, len))
  }

  /** 오류 메시지에 문자를 끼워 넣을 때. 입력 끝이면 그렇다고 말한다. */
  function shown(at: number = i) {
    return at >= len
      ? "입력이 끝났습니다"
      : `${JSON.stringify(text[at])} 가 있습니다`
  }

  /** 공백(+관대 모드의 주석)을 건너뛴다. */
  function skipBlank() {
    for (;;) {
      while (i < len) {
        const c = text.charCodeAt(i)
        // space · tab · LF · CR · NBSP · BOM
        if (
          c === 32 ||
          c === 9 ||
          c === 10 ||
          c === 13 ||
          c === 0xa0 ||
          c === 0xfeff
        ) {
          i++
        } else break
      }
      if (!lenient || text[i] !== "/") return
      if (text[i + 1] === "/") {
        i += 2
        while (i < len && text[i] !== "\n") i++
        continue
      }
      if (text[i + 1] === "*") {
        const start = i
        const end = text.indexOf("*/", i + 2)
        if (end < 0) fail("주석이 */ 로 닫히지 않았습니다", start)
        i = end + 2
        continue
      }
      return
    }
  }

  function expectWord(word: string) {
    if (text.startsWith(word, i)) {
      i += word.length
      return
    }
    fail(`알 수 없는 값입니다 (${word} 를 쓰려던 것인가요?)`)
  }

  function readString(quote: string): string {
    const open = i
    i++ // 여는 따옴표
    let out = ""
    for (;;) {
      if (i >= len) fail("문자열이 닫히지 않았습니다", open)
      const c = text[i]
      if (c === quote) {
        i++
        return out
      }
      if (c === "\\") {
        const esc = i
        i++
        const e = text[i]
        i++
        switch (e) {
          case '"':
            out += '"'
            break
          case "\\":
            out += "\\"
            break
          case "/":
            out += "/"
            break
          case "b":
            out += "\b"
            break
          case "f":
            out += "\f"
            break
          case "n":
            out += "\n"
            break
          case "r":
            out += "\r"
            break
          case "t":
            out += "\t"
            break
          case "u": {
            const hex = text.slice(i, i + 4)
            if (!HEX4.test(hex))
              fail("\\u 뒤에는 16진수 4자리가 와야 합니다", esc)
            out += String.fromCharCode(parseInt(hex, 16))
            i += 4
            break
          }
          default:
            if (e === undefined) fail("문자열이 닫히지 않았습니다", open)
            // 관대 모드에서는 \' 처럼 정의되지 않은 이스케이프를 글자 그대로 받는다.
            if (lenient) out += e
            else fail(`알 수 없는 이스케이프 \\${e} 입니다`, esc)
        }
        continue
      }
      if (text.charCodeAt(i) < 0x20 && !lenient) {
        fail(
          "문자열 안에는 줄바꿈·제어문자를 그대로 둘 수 없습니다 (\\n 처럼 escape 하세요)"
        )
      }
      out += c
      i++
    }
  }

  function readNumber(): number {
    const start = i
    const re = lenient ? NUMBER_LENIENT : NUMBER_STRICT
    re.lastIndex = i
    const m = re.exec(text)
    if (!m || m[0] === "") fail("숫자 형식이 잘못되었습니다")
    const end = start + m[0].length
    const next = text[end]
    if (next !== undefined && NUMBER_TAIL.test(next))
      fail("숫자 형식이 잘못되었습니다", end)
    const n = Number(m[0])
    if (!Number.isFinite(n)) fail("숫자로 읽을 수 없습니다", start)
    i = end
    return n
  }

  function readKey(): string {
    const c = text[i]
    if (c === '"') return readString('"')
    if (lenient) {
      if (c === "'") return readString("'")
      IDENT.lastIndex = i
      const m = IDENT.exec(text)
      if (m) {
        i += m[0].length
        return m[0]
      }
    }
    fail(`키는 "..." 로 감싼 문자열이어야 하는데 ${shown()}`)
  }

  function readObject(): Record<string, unknown> {
    const open = i
    i++ // '{'
    // prototype 없는 객체로 만든다 — `{"__proto__": {...}}` 를 `out[key] = v` 로
    // 넣으면 일반 객체에서는 프로퍼티가 아니라 프로토타입이 바뀌어 값이 사라진다.
    const out = Object.create(null) as Record<string, unknown>
    skipBlank()
    if (text[i] === "}") {
      i++
      return out
    }
    for (;;) {
      skipBlank()
      if (i >= len) fail("'}' 로 닫히지 않았습니다", open)
      const key = readKey()
      skipBlank()
      if (text[i] !== ":") fail(`키 다음에는 ':' 가 와야 하는데 ${shown()}`)
      i++
      out[key] = readValue()
      skipBlank()
      if (text[i] === ",") {
        const comma = i
        i++
        skipBlank()
        if (text[i] === "}") {
          if (!lenient) fail("마지막 항목 뒤에는 쉼표를 둘 수 없습니다", comma)
          i++
          return out
        }
        continue
      }
      if (text[i] === "}") {
        i++
        return out
      }
      if (i >= len) fail("'}' 로 닫히지 않았습니다", open)
      fail(`',' 또는 '}' 가 와야 하는데 ${shown()}`)
    }
  }

  function readArray(): unknown[] {
    const open = i
    i++ // '['
    const out: unknown[] = []
    skipBlank()
    if (text[i] === "]") {
      i++
      return out
    }
    for (;;) {
      out.push(readValue())
      skipBlank()
      if (text[i] === ",") {
        const comma = i
        i++
        skipBlank()
        if (text[i] === "]") {
          if (!lenient) fail("마지막 항목 뒤에는 쉼표를 둘 수 없습니다", comma)
          i++
          return out
        }
        continue
      }
      if (text[i] === "]") {
        i++
        return out
      }
      if (i >= len) fail("']' 로 닫히지 않았습니다", open)
      fail(`',' 또는 ']' 가 와야 하는데 ${shown()}`)
    }
  }

  function readValue(): unknown {
    skipBlank()
    if (i >= len) fail("값이 와야 하는데 입력이 끝났습니다", len)
    const c = text[i]
    switch (c) {
      case "{":
        return readObject()
      case "[":
        return readArray()
      case '"':
        return readString('"')
      case "t":
        expectWord("true")
        return true
      case "f":
        expectWord("false")
        return false
      case "n":
        expectWord("null")
        return null
    }
    if (c === "'") {
      if (!lenient)
        fail("문자열은 홑따옴표(')가 아니라 겹따옴표(\")로 감싸야 합니다")
      return readString("'")
    }
    if (c === "-" || c === "+" || c === "." || (c >= "0" && c <= "9"))
      return readNumber()
    fail(`예상하지 못한 문자 ${JSON.stringify(c)} 입니다`)
  }

  try {
    const value = readValue()
    skipBlank()
    if (i < len)
      fail(`값이 끝난 뒤에 ${JSON.stringify(text[i])} 가 더 있습니다`)
    return { ok: true, value }
  } catch (e) {
    if (e instanceof ParseFailure) {
      return {
        ok: false,
        error: { message: e.message, index: e.index, ...locate(text, e.index) },
      }
    }
    // 재귀 하강이라 아주 깊게 중첩된 입력은 스택을 넘긴다. 그것도 "읽을 수 없는
    // 입력" 이므로 오류로 돌려준다 — 던지면 화면 전체가 죽는다.
    if (e instanceof RangeError) {
      return {
        ok: false,
        error: {
          message: "중첩이 너무 깊어 읽을 수 없습니다",
          index: i,
          ...locate(text, i),
        },
      }
    }
    throw e
  }
}

/** 0-based 오프셋을 1-based 줄/칸으로 환산한다. */
export function locate(text: string, index: number) {
  const end = Math.min(index, text.length)
  let line = 1
  let lastBreak = -1
  for (let p = 0; p < end; p++) {
    if (text[p] === "\n") {
      line++
      lastBreak = p
    }
  }
  return { line, column: end - lastBreak }
}

/** 객체 키를 재귀적으로 사전순 정렬한 새 값(배열 순서는 건드리지 않는다). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = sortKeysDeep(src[k])
    return out
  }
  return value
}

/** `\n` 개수 + 1. 5MB 짜리를 split 하지 않으려고 세는 방식으로. */
export function countLines(text: string) {
  let n = 1
  for (let p = text.indexOf("\n"); p >= 0; p = text.indexOf("\n", p + 1)) n++
  return n
}

/** UTF-8 바이트 수를 사람이 읽는 크기로. */
export function formatBytes(text: string) {
  const bytes = new TextEncoder().encode(text).length
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
