/**
 * `src-tauri/src/http_file.rs` 커맨드 래퍼 + 그 타입들.
 *
 * 필드 이름은 Rust 쪽 `#[serde(rename_all = "camelCase")]` 과 짝이다 — 한쪽만 고치면
 * 값이 조용히 undefined 가 된다.
 */

import { trackedInvoke } from "@/lib/tauri"

/** 목록의 한 줄. */
export interface HttpFileEntry {
  path: string
  /** 프로젝트 루트 기준 상대 경로. */
  rel: string
  name: string
  /** 상대 디렉터리("" 면 루트). */
  dir: string
  size: number
  modified: number | null
}

export interface HttpFileText {
  path: string
  name: string
  text: string
  modified: number | null
}

export interface HttpEnv {
  name: string
  vars: Record<string, string>
  /** private 환경 파일에서 온 키들(화면에서 값을 가린다). */
  privateKeys: string[]
}

export interface HttpEnvs {
  envs: HttpEnv[]
  sources: string[]
}

export interface IncludeFile {
  path: string
  /** UTF-8 로 읽혔으면 본문, 바이너리면 null. */
  text: string | null
  size: number
}

/** 최종 본문의 한 조각(파일 헤더 주석 참고). */
export type BodyChunk =
  { kind: "text"; text: string } | { kind: "file"; path: string }

export interface SendReq {
  method: string
  url: string
  headers: [string, string][]
  body: BodyChunk[]
  timeoutMs?: number | null
  noRedirect?: boolean
}

export interface SendRes {
  status: number
  statusText: string
  httpVersion: string
  headers: [string, string][]
  body: string
  binary: boolean
  size: number
  elapsedMs: number
  finalUrl: string
}

export function listHttpFiles(project: string) {
  return trackedInvoke<HttpFileEntry[]>("http_list_files", { project })
}

export function readHttpFile(path: string) {
  return trackedInvoke<HttpFileText>("http_read_file", { path })
}

export function writeHttpFile(path: string, text: string) {
  return trackedInvoke<number | null>("http_write_file", { path, text })
}

export function createHttpFile(path: string, text?: string) {
  return trackedInvoke<HttpFileText>("http_create_file", { path, text })
}

export function readEnvFiles(project: string, file: string) {
  return trackedInvoke<HttpEnvs>("http_env_files", { project, file })
}

export function readInclude(base: string, rel: string) {
  return trackedInvoke<IncludeFile>("http_read_include", { base, rel })
}

export function saveResponseFile(
  base: string,
  rel: string,
  text: string,
  overwrite: boolean
) {
  return trackedInvoke<string>("http_save_response", {
    base,
    rel,
    text,
    overwrite,
  })
}

export function sendHttpRequest(req: SendReq) {
  return trackedInvoke<SendRes>("http_send", { req })
}
