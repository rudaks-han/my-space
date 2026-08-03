/**
 * 요청 하나를 끝까지 실행한다 — 변수 치환 → 사전 요청 스크립트 → 본문 조립 →
 * 전송(Rust) → 응답 핸들러 → `>>` 저장.
 *
 * 순서가 곧 IntelliJ 의 순서다. 특히 **사전 요청 스크립트가 URL·헤더 치환보다 먼저**여야
 * 한다(그 스크립트가 넣은 `request.variables` 를 URL 에서 쓸 수 있어야 하므로), 그리고
 * **응답 핸들러의 전역 변수 변경은 이 함수가 적용하지 않고 결과로 돌려준다** —
 * 전역 변수는 프로젝트 단위로 localStorage 에 남는 상태라서 소유자가 훅이다.
 */

import {
  readInclude,
  saveResponseFile,
  sendHttpRequest,
  type BodyChunk,
  type SendRes,
} from "./http-client"
import type { HttpRequest } from "./http-parse"
import { substitute, type VarScope } from "./http-vars"
import {
  header,
  runPreRequestScript,
  runResponseHandler,
  type ScriptRequestInfo,
  type TestResult,
} from "./http-script"

/** 화면에 보여 줄 "실제로 보낸 요청". */
export interface SentRequest {
  method: string
  url: string
  headers: [string, string][]
  /** 본문 미리보기(끼워 넣은 바이너리는 `< 경로 (n bytes)` 로 표시). */
  bodyPreview: string
}

export interface RunResult {
  /** 요청 식별(파일 내 순번)과 이름 — 응답 탭 제목에 쓴다. */
  index: number
  label: string
  sent: SentRequest | null
  response: SendRes | null
  /** 전송 자체가 실패한 사유(네트워크·URL 오류 등). */
  error: string | null
  tests: TestResult[]
  logs: string[]
  /** 스크립트가 터진 사유. */
  scriptError: string | null
  /** 값을 못 찾은 변수 이름들. */
  missing: string[]
  /** `>>` 로 저장한 경로. */
  savedTo: string | null
  /** 전역 변수 변경(null = 삭제). 훅이 받아 저장한다. */
  globalUpdates: Record<string, string | null>
  startedAt: number
}

/** 요청 하나를 실행한다. 예외를 던지지 않고 결과에 담아 돌려준다. */
export async function runRequest(opts: {
  req: HttpRequest
  /** `.http` 파일의 절대 경로 — `< ./file` 상대 경로의 기준. */
  filePath: string
  globals: Record<string, string>
  env: Record<string, string>
  label: string
}): Promise<RunResult> {
  const { req, filePath, globals, env, label } = opts
  const startedAt = Date.now()
  const result: RunResult = {
    index: req.index,
    label,
    sent: null,
    response: null,
    error: null,
    tests: [],
    logs: [],
    scriptError: null,
    missing: [],
    savedTo: null,
    globalUpdates: {},
    startedAt,
  }

  const scope: VarScope = {
    request: {},
    globals: { ...globals },
    file: req.vars,
    env,
  }
  const missing = new Set<string>()
  const sub = (text: string) => {
    const r = substitute(text, scope, true)
    r.missing.forEach((m) => missing.add(m))
    return r.text
  }

  // ── 1. 사전 요청 스크립트 ──
  const preSource =
    req.preScript ?? (await readScriptFile(req.preScriptRef, filePath))
  if (preSource) {
    const info: ScriptRequestInfo = {
      method: req.method,
      url: req.url,
      headers: req.headers.map((h) => [h.name, h.value] as [string, string]),
      body: "",
      env,
    }
    const run = runPreRequestScript(preSource, scope.globals, info)
    Object.assign(scope.request, run.requestVars)
    applyGlobals(run.globals, scope, result)
    result.logs.push(...run.logs)
    if (run.error) result.scriptError = run.error
  }

  // ── 2. URL·헤더 치환 ──
  const url = sub(req.url)
  const headers: [string, string][] = req.headers.map((h) => [
    sub(h.name),
    sub(h.value),
  ])
  const contentType = header(headers, "content-type") ?? ""
  // multipart 는 파서가 경계선을 CRLF 로 기대한다 — `.http` 파일은 보통 LF 라 바꿔 준다
  // (IntelliJ 도 같은 변환을 한다).
  const nl = /^multipart\//i.test(contentType.trim()) ? "\r\n" : "\n"

  // ── 3. 본문 조립 ──
  const chunks: BodyChunk[] = []
  const preview: string[] = []
  const pushText = (t: string) => {
    if (!t) return
    const last = chunks[chunks.length - 1]
    if (last && last.kind === "text") last.text += t
    else chunks.push({ kind: "text", text: t })
  }
  try {
    for (let i = 0; i < req.body.length; i++) {
      if (i > 0) pushText(nl)
      const ln = req.body[i]
      if (ln.kind === "text") {
        const text = sub(ln.text)
        pushText(nl === "\r\n" ? text.replace(/\n/g, "\r\n") : text)
        preview.push(text)
        continue
      }
      const file = await readInclude(filePath, sub(ln.ref))
      if (file.text !== null) {
        const text = sub(file.text)
        pushText(nl === "\r\n" ? text.replace(/\n/g, "\r\n") : text)
        preview.push(
          `< ${ln.ref}  (텍스트 ${file.size.toLocaleString()} bytes)`
        )
      } else {
        chunks.push({ kind: "file", path: file.path })
        preview.push(
          `< ${ln.ref}  (바이너리 ${file.size.toLocaleString()} bytes)`
        )
      }
    }
  } catch (e) {
    result.error = String(e)
    result.missing = [...missing]
    return result
  }

  result.sent = {
    method: req.method,
    url,
    headers,
    bodyPreview: preview.join("\n"),
  }
  result.missing = [...missing]

  // ── 4. 전송 ──
  let res: SendRes
  try {
    res = await sendHttpRequest({
      method: req.method,
      url,
      headers,
      body: chunks,
      noRedirect: req.noRedirect,
    })
  } catch (e) {
    result.error = String(e)
    return result
  }
  result.response = res

  // ── 5. 응답 핸들러 ──
  const handlerSource =
    req.handler ?? (await readScriptFile(req.handlerRef, filePath))
  if (handlerSource) {
    const info: ScriptRequestInfo = {
      method: req.method,
      url,
      headers,
      body: preview.join("\n"),
      env,
    }
    const run = runResponseHandler(handlerSource, scope.globals, info, res)
    applyGlobals(run.globals, scope, result)
    result.tests.push(...run.tests)
    result.logs.push(...run.logs)
    if (run.error) result.scriptError = run.error
  }

  // ── 6. `>>` 응답 저장 ──
  if (req.output) {
    try {
      result.savedTo = await saveResponseFile(
        filePath,
        sub(req.output.ref),
        res.body,
        req.output.overwrite
      )
    } catch (e) {
      result.scriptError = `응답 저장 실패: ${String(e)}`
    }
  }

  return result
}

/** `> ./handler.js` 처럼 파일로 분리된 스크립트를 읽어 온다. */
async function readScriptFile(
  ref: string | null,
  filePath: string
): Promise<string | null> {
  if (!ref) return null
  try {
    const file = await readInclude(filePath, ref)
    return file.text
  } catch {
    // 스크립트 파일을 못 읽어도 요청 자체는 보낸다.
    return null
  }
}

/** 스크립트가 바꾼 전역 변수를 이후 스크립트와 결과에 반영한다. */
function applyGlobals(
  updates: Record<string, string | null>,
  scope: VarScope,
  result: RunResult
) {
  Object.entries(updates).forEach(([k, v]) => {
    result.globalUpdates[k] = v
    if (v === null) delete scope.globals[k]
    else scope.globals[k] = v
  })
}
