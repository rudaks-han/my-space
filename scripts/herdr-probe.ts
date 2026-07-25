#!/usr/bin/env bun
/**
 * herdr-probe — AskUserQuestion 연동 실험용 프로브 (throwaway 실험 스크립트)
 *
 * 목적: My Space ↔ herdr 연동에 앞서 손으로 확인해야 하는 3가지를 잡아낸다.
 *   ① Claude가 AskUserQuestion을 띄우면 herdr pane 이 정말 "blocked" 로 바뀌는지
 *   ② 그때 pane 에 질문/선택지가 "어떤 텍스트/ANSI 구조"로 렌더링되는지
 *   ③ 어떤 키(send-keys)를 보내면 특정 선택지가 골라지고 세션이 계속 진행되는지
 *
 * herdr CLI 는 소켓 API 의 thin wrapper 이므로(각 subcommand → API method),
 * 실험 단계에서는 CLI 를 그대로 호출해 신뢰성을 확보한다.
 * (최종 My Space 통합에서는 Rust 가 ~/.config/herdr/herdr.sock 소켓에 직접 붙는다.)
 *
 * 실행: bun scripts/herdr-probe.ts <command>
 *   list                     실행 중인 agent/pane 과 상태를 나열
 *   watch                    모든 pane 을 폴링, blocked 로 바뀌면 자동으로 질문을 덤프
 *   read <target>            해당 pane 을 즉시 덤프 (text / ansi / escaped / explain)
 *   explain <target>         agent explain --json 만 출력
 *   keys <target> <key...>   send-keys 로 키 주입 (예: keys w3:p1 down down enter)
 *   text <target> <text>     send-text 로 문자열 주입
 *
 * target: pane_id(예: w3:p1) 또는 agent 이름 등 herdr 가 받는 모든 target.
 * 환경변수: HERDR_BIN(기본 "herdr"), HERDR_SESSION(있으면 그대로 상속됨).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const HERDR_BIN = process.env.HERDR_BIN ?? "herdr"
const POLL_MS = 600 // watch 폴링 주기
const READ_LINES = 160 // 덤프 시 읽을 줄 수

/** herdr CLI 를 호출하고 stdout(가능하면 JSON 파싱)을 돌려준다. */
async function herdr(
  args: string[]
): Promise<{ raw: string; json: any | null }> {
  try {
    const { stdout } = await execFileAsync(HERDR_BIN, args, {
      maxBuffer: 16 * 1024 * 1024,
    })
    const raw = stdout.toString()
    let json: any = null
    try {
      json = JSON.parse(raw)
    } catch {
      /* JSON 이 아니면 raw 만 사용 */
    }
    return { raw, json }
  } catch (err: any) {
    const raw =
      (err?.stdout?.toString() ?? "") + (err?.stderr?.toString() ?? "")
    return { raw: raw || String(err), json: null }
  }
}

/** result 안에서 agents/panes 배열을 최대한 관대하게 꺼낸다. */
function extractItems(json: any): any[] {
  const r = json?.result ?? json
  return r?.agents ?? r?.panes ?? (Array.isArray(r) ? r : [])
}

/** read 응답에서 실제 터미널 텍스트를 꺼낸다 (result.read.text 위치). */
function readText(out: { raw: string; json: any | null }): string {
  const r = out.json?.result
  const t = r?.read?.text ?? r?.text ?? (typeof r === "string" ? r : null)
  return typeof t === "string" ? t : out.raw
}

function ts(): string {
  // Date.now() 는 이 스크립트가 사용자 머신에서 도는 것이므로 정상 사용 가능
  return new Date().toISOString().slice(11, 23)
}

const line = (c = "─") => c.repeat(72)

async function cmdList() {
  const { json, raw } = await herdr(["agent", "list"])
  const items = extractItems(json)
  if (!items.length) {
    console.log("(agent 없음) — 원본 응답:\n" + raw)
    return
  }
  console.log(`실행 중 agent ${items.length}개:\n`)
  for (const a of items) {
    console.log(
      `  ${String(a.pane_id).padEnd(8)} status=${String(a.agent_status).padEnd(8)} agent=${a.agent ?? "-"}  cwd=${a.cwd ?? ""}`
    )
  }
  console.log(
    `\n예) 감시 시작:  bun scripts/herdr-probe.ts watch\n예) 즉시 덤프:  bun scripts/herdr-probe.ts read ${items[0].pane_id}`
  )
}

/** 한 pane 의 현재 화면/질문을 여러 형태로 덤프한다. */
async function dumpPane(target: string) {
  console.log("\n" + line("━"))
  console.log(`▼ [${ts()}] pane ${target} 덤프`)
  console.log(line("━"))

  // 1) 사람이 읽는 텍스트 (ANSI 제거)
  const textOut = await herdr([
    "agent",
    "read",
    target,
    "--source",
    "recent",
    "--lines",
    String(READ_LINES),
  ])
  const text = readText(textOut)
  console.log("\n── (1) TEXT (ansi 제거) ──")
  console.log(text)

  // 2) 이스케이프해서 숨은 제어문자/박스문자 확인 (파서 설계용)
  console.log("\n── (2) TEXT 를 JSON.stringify (숨은 문자 확인) ──")
  console.log(JSON.stringify(text).slice(0, 4000))

  // 3) ANSI 원본 (선택 하이라이트 등 구조 파악용)
  const ansiOut = await herdr([
    "agent",
    "read",
    target,
    "--source",
    "recent",
    "--lines",
    String(READ_LINES),
    "--ansi",
  ])
  const ansi = readText(ansiOut)
  console.log("\n── (3) ANSI 원본을 JSON.stringify ──")
  console.log(JSON.stringify(ansi).slice(0, 4000))

  // 4) herdr 가 구조적으로 아는 정보(있다면 여기에 질문/상태가 담길 수 있음)
  const explain = await herdr(["agent", "explain", target, "--json"])
  console.log("\n── (4) agent explain --json ──")
  console.log(explain.raw.slice(0, 4000))

  console.log("\n" + line())
  console.log("이 pane 에 선택지를 넣어보려면 (다른 터미널에서):")
  console.log(`  bun scripts/herdr-probe.ts keys ${target} down enter`)
  console.log(`  bun scripts/herdr-probe.ts keys ${target} enter`)
  console.log(`  bun scripts/herdr-probe.ts text ${target} "1"`)
  console.log(line() + "\n")
}

async function cmdRead(target: string) {
  await dumpPane(target)
}

async function cmdExplain(target: string) {
  const explain = await herdr(["agent", "explain", target, "--json"])
  console.log(explain.raw)
}

async function cmdKeys(target: string, keys: string[]) {
  const { raw } = await herdr(["pane", "send-keys", target, ...keys])
  console.log(`send-keys ${target} [${keys.join(" ")}] →`, raw.trim() || "(ok)")
}

async function cmdText(target: string, text: string) {
  const { raw } = await herdr(["pane", "send-text", target, text])
  console.log(
    `send-text ${target} ${JSON.stringify(text)} →`,
    raw.trim() || "(ok)"
  )
}

/** 모든 pane 을 폴링하며 blocked 로 "전환"되는 순간을 잡아 덤프한다. */
async function cmdWatch() {
  console.log(
    `[${ts()}] watch 시작 — ${POLL_MS}ms 마다 폴링. Claude 에서 AskUserQuestion 을 유발해보세요. (Ctrl+C 종료)\n`
  )
  const lastStatus = new Map<string, string>()
  let first = true

  const tick = async () => {
    const { json } = await herdr(["agent", "list"])
    const items = extractItems(json)
    for (const a of items) {
      const id = a.pane_id
      const status = a.agent_status ?? "unknown"
      const prev = lastStatus.get(id)
      lastStatus.set(id, status)
      if (prev && prev !== status) {
        console.log(`[${ts()}] ${id}: ${prev} → ${status}`)
      }
      // idle/working/unknown → blocked 로 바뀐 첫 순간에만 덤프
      if (status === "blocked" && prev !== "blocked" && !first) {
        console.log(`\n[${ts()}] ★ ${id} 가 blocked 로 전환 — 질문 덤프!`)
        await dumpPane(id)
      }
    }
    first = false
  }

  await tick() // 최초 스냅샷(덤프는 안 함)
  setInterval(() => {
    tick().catch((e) => console.error("tick 오류:", e))
  }, POLL_MS)
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case "list":
      await cmdList()
      break
    case "watch":
      await cmdWatch()
      break
    case "read":
      if (!rest[0]) return usage("read 는 target 이 필요합니다")
      await cmdRead(rest[0])
      break
    case "explain":
      if (!rest[0]) return usage("explain 는 target 이 필요합니다")
      await cmdExplain(rest[0])
      break
    case "keys":
      if (rest.length < 2) return usage("keys 는 target 과 키가 필요합니다")
      await cmdKeys(rest[0], rest.slice(1))
      break
    case "text":
      if (rest.length < 2) return usage("text 는 target 과 문자열이 필요합니다")
      await cmdText(rest[0], rest.slice(1).join(" "))
      break
    default:
      usage()
  }
}

function usage(msg?: string) {
  if (msg) console.error("오류: " + msg + "\n")
  console.log(
    [
      "herdr-probe — AskUserQuestion 연동 실험",
      "",
      "  bun scripts/herdr-probe.ts list",
      "  bun scripts/herdr-probe.ts watch",
      "  bun scripts/herdr-probe.ts read <target>",
      "  bun scripts/herdr-probe.ts explain <target>",
      "  bun scripts/herdr-probe.ts keys <target> <key...>   # 예: keys w3:p1 down enter",
      "  bun scripts/herdr-probe.ts text <target> <text>",
    ].join("\n")
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
