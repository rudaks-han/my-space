/**
 * `{{변수}}` 치환 — IntelliJ HTTP Client 의 변수 규칙.
 *
 * 우선순위(강한 것부터): 사전 요청 스크립트가 넣은 요청 변수 → `client.global.set` 으로
 * 저장한 전역 변수 → 파일 안의 `@var` → 선택한 환경(`http-client[.private].env.json`).
 * 로그인 요청이 발급한 토큰(전역)이 파일에 적힌 기본값을 이기고, 파일에 직접 적어 둔
 * `@host` 가 환경 파일의 `host` 를 이기는 순서다.
 *
 * `{{$…}}` 동적 변수는 값이 실행 시점에 만들어진다. **생성은 실행 핸들러에서만** 하고
 * (`react-hooks/purity` 가 렌더 중 `Math.random()`/`Date.now()` 를 금지한다), 편집기의
 * 강조는 값 대신 `isResolvable()` 로 "해결되는 이름인가"만 본다.
 *
 * 지원하지 않는 것: `{{$env.NAME}}`(OS 환경변수). 미해결 변수로 표시된다 — 이 저장소의
 * `.http` 파일에는 쓰인 곳이 없고, 웹뷰에서 프로세스 환경을 읽을 방법이 없다.
 */

/** 변수를 찾을 네 곳. */
export interface VarScope {
  request: Record<string, string>
  globals: Record<string, string>
  file: Record<string, string>
  env: Record<string, string>
}

export function emptyScope(): VarScope {
  return { request: {}, globals: {}, file: {}, env: {} }
}

/** `{{ … }}` 안의 이름 하나를 찾는다(동적 변수는 제외). */
function plainLookup(name: string, scope: VarScope): string | undefined {
  if (name in scope.request) return scope.request[name]
  if (name in scope.globals) return scope.globals[name]
  if (name in scope.file) return scope.file[name]
  if (name in scope.env) return scope.env[name]
  return undefined
}

/** 동적 변수 이름인지(값을 만들지 않고 판정만 — 렌더 중에도 안전하다). */
export function isDynamic(name: string): boolean {
  return name.startsWith("$")
}

/** 알고 있는 동적 변수인지. `$env.X` 는 지원하지 않으므로 false. */
export function isKnownDynamic(name: string): boolean {
  if (!isDynamic(name)) return false
  const n = name.slice(1)
  if (["uuid", "timestamp", "isoTimestamp", "randomInt"].includes(n))
    return true
  return /^random\.(uuid|integer|float|alphabetic|alphanumeric|hexadecimal|email|boolean)(\(.*\))?$/.test(
    n
  )
}

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
const DIGITS = "0123456789"
const HEX = "0123456789abcdef"

function pick(chars: string, len: number): string {
  let out = ""
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID()
  return pick(HEX, 8) + "-" + pick(HEX, 4) + "-4" + pick(HEX, 3)
}

/** 인자 목록(`(1, 10)`)을 숫자 배열로. */
function args(spec: string): number[] {
  const m = spec.match(/\(([^)]*)\)/)
  if (!m) return []
  return m[1]
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
}

/**
 * 동적 변수 값 하나를 만든다. 모르는 이름이면 undefined.
 * **실행 시점에만 호출한다**(렌더 중 호출 금지 — 파일 맨 위 주석 참고).
 */
export function generateDynamic(name: string): string | undefined {
  const n = name.slice(1)
  if (n === "uuid" || n === "random.uuid") return uuid()
  if (n === "timestamp") return String(Math.floor(Date.now() / 1000))
  if (n === "isoTimestamp") return new Date().toISOString()
  if (n === "randomInt") return String(Math.floor(Math.random() * 1001))
  const a = args(n)
  if (n.startsWith("random.integer")) {
    const [from = 0, to = 1000] = a
    return String(from + Math.floor(Math.random() * Math.max(1, to - from + 1)))
  }
  if (n.startsWith("random.float")) {
    const [from = 0, to = 1] = a
    return String(from + Math.random() * (to - from))
  }
  if (n.startsWith("random.alphabetic")) return pick(ALPHA, a[0] ?? 8)
  if (n.startsWith("random.alphanumeric"))
    return pick(ALPHA + DIGITS, a[0] ?? 8)
  if (n.startsWith("random.hexadecimal")) return pick(HEX, a[0] ?? 8)
  if (n === "random.email") return `${pick(ALPHA.toLowerCase(), 8)}@example.com`
  if (n === "random.boolean") return Math.random() < 0.5 ? "false" : "true"
  return undefined
}

/** 이 이름이 (값을 만들지 않고도) 해결될 이름인지 — 편집기 강조용. */
export function isResolvable(name: string, scope: VarScope): boolean {
  const n = name.trim()
  if (!n) return false
  if (isDynamic(n)) return isKnownDynamic(n)
  return plainLookup(n, scope) !== undefined
}

/** 치환 결과. */
export interface Substituted {
  text: string
  /** 값을 못 찾은 변수 이름들(중복 없음, 나온 순서). */
  missing: string[]
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g
/** 변수 값이 또 변수를 담고 있을 때의 재귀 상한(순환 참조 보호). */
const MAX_DEPTH = 10

/**
 * `{{var}}` 를 값으로 바꾼다.
 *
 * @param dynamic 동적 변수를 실제로 만들지 여부. 편집기 미리보기처럼 값을 만들면
 *   안 되는 자리에서는 false 로 두면 원문(`{{$uuid}}`)이 그대로 남는다.
 */
export function substitute(
  text: string,
  scope: VarScope,
  dynamic = true
): Substituted {
  const missing: string[] = []
  const seen = new Set<string>()

  const expand = (input: string, depth: number): string =>
    input.replace(VAR_RE, (whole, rawName: string) => {
      const name = rawName.trim()
      if (isDynamic(name)) {
        if (!dynamic) return whole
        const v = generateDynamic(name)
        if (v === undefined) {
          if (!seen.has(name)) {
            seen.add(name)
            missing.push(name)
          }
          return whole
        }
        return v
      }
      const v = plainLookup(name, scope)
      if (v === undefined) {
        if (!seen.has(name)) {
          seen.add(name)
          missing.push(name)
        }
        return whole
      }
      // 값 안의 변수도 펼친다(`@base = {{host}}/api` 같은 선언).
      return depth < MAX_DEPTH ? expand(v, depth + 1) : v
    })

  return { text: expand(text, 0), missing }
}
