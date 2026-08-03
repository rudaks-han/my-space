/**
 * 응답 핸들러(`> {% … %}`)와 사전 요청 스크립트(`< {% … %}`) 실행기.
 *
 * 이 저장소의 `.http` 파일에는 응답 핸들러가 1900번 넘게 나오고, 거의 전부
 * `client.test(...)` + `client.assert(...)` 아니면 `client.global.set("access_token", …)`
 * 이다. 즉 **핸들러를 못 돌리면 토큰을 받아 다음 요청에 쓰는 흐름이 끊긴다** — 실행
 * 기능의 절반이 사라지는 셈이라 실제로 스크립트를 돌린다.
 *
 * 어떻게 돌리는가: `new Function` 으로 감싸 `client` · `response` · `request` 만 인자로
 * 넘긴다. 격리된 인터프리터는 아니다(웹뷰 전역에 손댈 수 있다) — 그래도 괜찮은 이유는
 * 스크립트의 출처가 **사용자가 방금 자기 저장소에서 연 파일** 이라서다. `tauri.conf.json`
 * 의 CSP 가 null 이라 `new Function` 자체는 막히지 않는다.
 *
 * IntelliJ API 중 구현한 것: `client.global.{set,get,isEmpty,clear,clearAll}`,
 * `client.test`, `client.assert`, `client.log`, `client.exit`,
 * `response.{status,body,headers,contentType}`,
 * `request.{method,url,body,headers,variables,environment}`.
 * 구현하지 않은 것: `client.responseHandler`(비동기 대기), `crypto.*` 헬퍼.
 */

import type { SendRes } from "./http-client"

export interface TestResult {
  name: string
  passed: boolean
  message: string | null
}

/** 스크립트 한 번 실행의 결과. */
export interface ScriptRun {
  tests: TestResult[]
  logs: string[]
  /** 스크립트 자체가 터진 경우의 사유(테스트 실패와 구분한다). */
  error: string | null
  /** `client.global.set/clear` 로 바뀐 전역 변수. 값이 null 이면 삭제. */
  globals: Record<string, string | null>
  /** `request.variables.set` 으로 넣은 요청 변수(사전 요청 스크립트에서 쓴다). */
  requestVars: Record<string, string>
}

/** 스크립트에 넘길 요청 정보. */
export interface ScriptRequestInfo {
  method: string
  url: string
  headers: [string, string][]
  /** 변수 치환이 끝난 본문(텍스트 부분만). */
  body: string
  /** 선택한 환경의 변수. */
  env: Record<string, string>
}

/** `client.exit()` 을 구분하기 위한 신호. */
const EXIT = Symbol("http-script-exit")

/** 응답 본문을 IntelliJ 처럼 해석한다 — JSON 이면 객체, 아니면 문자열. */
export function parseResponseBody(res: SendRes): unknown {
  const type = header(res.headers, "content-type") ?? ""
  const text = res.body
  const looksJson =
    /json/i.test(type) ||
    (!type && /^\s*[[{]/.test(text)) ||
    (/^\s*[[{]/.test(text) && !/html|xml|text\/plain/i.test(type))
  if (looksJson) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

/** 헤더 값 하나(대소문자 무시, 첫 번째). */
export function header(
  headers: [string, string][],
  name: string
): string | null {
  const lower = name.toLowerCase()
  for (const [k, v] of headers) if (k.toLowerCase() === lower) return v
  return null
}

function headerApi(headers: [string, string][]) {
  return {
    valueOf: (name: string) => header(headers, name),
    valuesOf: (name: string) =>
      headers
        .filter(([k]) => k.toLowerCase() === name.toLowerCase())
        .map(([, v]) => v),
  }
}

/** `client` 객체와 그 실행 결과 수집기. */
function makeClient(globals: Record<string, string>) {
  const run: ScriptRun = {
    tests: [],
    logs: [],
    error: null,
    globals: {},
    requestVars: {},
  }
  /** 현재 값 조회는 "이번 실행에서 바뀐 값 → 원래 값" 순서로 본다. */
  const current = (k: string): string | undefined => {
    if (k in run.globals) return run.globals[k] ?? undefined
    return globals[k]
  }
  const client = {
    global: {
      set(k: string, v: unknown) {
        run.globals[String(k)] = v == null ? "" : String(v)
      },
      get(k: string) {
        return current(String(k)) ?? null
      },
      isEmpty() {
        return Object.keys(globals).length === 0
      },
      clear(k: string) {
        run.globals[String(k)] = null
      },
      clearAll() {
        Object.keys(globals).forEach((k) => (run.globals[k] = null))
      },
    },
    test(name: string, fn: () => void) {
      try {
        fn()
        run.tests.push({ name: String(name), passed: true, message: null })
      } catch (e) {
        run.tests.push({
          name: String(name),
          passed: false,
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
    assert(cond: unknown, message?: string) {
      if (!cond) throw new Error(message || "assert 실패")
    },
    log(...parts: unknown[]) {
      run.logs.push(
        parts
          .map((p) => (typeof p === "string" ? p : safeStringify(p)))
          .join(" ")
      )
    },
    exit() {
      throw EXIT
    },
  }
  return { client, run }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function requestApi(info: ScriptRequestInfo, run: ScriptRun) {
  return {
    method: info.method,
    url: info.url,
    body: {
      getRaw: () => info.body,
      tryGetSubstituted: () => info.body,
      toString: () => info.body,
    },
    headers: headerApi(info.headers),
    variables: {
      set: (k: string, v: unknown) => {
        run.requestVars[String(k)] = v == null ? "" : String(v)
      },
      get: (k: string) => run.requestVars[String(k)] ?? null,
    },
    environment: {
      get: (k: string) => info.env[String(k)] ?? null,
    },
  }
}

/**
 * 스크립트를 돌린다. 응답이 없으면(사전 요청 스크립트) `response` 는 null 로 넘어간다.
 */
function execute(
  script: string,
  globals: Record<string, string>,
  info: ScriptRequestInfo,
  res: SendRes | null
): ScriptRun {
  const { client, run } = makeClient(globals)
  const response = res
    ? {
        status: res.status,
        body: parseResponseBody(res),
        headers: headerApi(res.headers),
        contentType: contentTypeApi(header(res.headers, "content-type")),
      }
    : null
  try {
    const fn = new Function(
      "client",
      "response",
      "request",
      `"use strict";\n${script}`
    )
    fn(client, response, requestApi(info, run))
  } catch (e) {
    // client.exit() 은 정상 종료다.
    if (e !== EXIT) {
      run.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
  }
  return run
}

function contentTypeApi(raw: string | null) {
  const value = raw ?? ""
  const [mime, ...rest] = value.split(";")
  const charset =
    rest
      .map((p) => p.trim())
      .find((p) => p.toLowerCase().startsWith("charset="))
      ?.slice("charset=".length) ?? null
  return { mimeType: mime.trim(), charset, toString: () => value }
}

/** 응답 핸들러(`> {% … %}`). */
export function runResponseHandler(
  script: string,
  globals: Record<string, string>,
  info: ScriptRequestInfo,
  res: SendRes
): ScriptRun {
  return execute(script, globals, info, res)
}

/** 사전 요청 스크립트(`< {% … %}`). */
export function runPreRequestScript(
  script: string,
  globals: Record<string, string>,
  info: ScriptRequestInfo
): ScriptRun {
  return execute(script, globals, info, null)
}
