//! Orca 연동 — Orca(에이전트용 데스크톱 IDE) 터미널에서 도는 Claude Code 세션을 herdr·cmux 와
//! **같은 데이터 모양**(`HerdrAgent` / `HerdrWorkspace`)으로 읽어 온다. 세션 목록 뷰·펫·홈
//! 카드는 어느 백엔드로 읽었는지 알 필요가 없다.
//!
//! ## 두 소스를 pane 키로 조인한다
//! 세션 목록에 필요한 건 (a) 어떤 pane 이 어떤 Claude `session_id` 인지, (b) 그 세션이
//! 진행 중인지 대기인지 두 가지다. Orca 는 그 둘을 서로 다른 곳에 둔다:
//!
//! 1. **상태 파일** `~/Library/Application Support/orca/agent-hooks/last-status.json` —
//!    Orca 가 자기 훅 서버로 받은 마지막 이벤트를 pane 별로 남긴다(tmp+rename 이라 부분 쓰기가
//!    보이지 않는다). 여기서 `providerSession.id`(= **Claude 트랜스크립트 파일명**),
//!    `payload.state`, `payload.agentType` 이 나온다. 훅은 Orca 가 `~/.claude/settings.json`
//!    에 심어 두므로 사용자가 따로 설치할 것이 없고, 스크립트는 `ORCA_PANE_KEY` 가 없으면 바로
//!    빠지므로 **Orca 밖에서 띄운 Claude 는 섞이지 않는다**.
//! 2. **`orca terminal list --json`** — 지금 살아 있는 터미널의 `handle`(동작 대상),
//!    `title`(에이전트가 붙인 작업 이름), `worktreePath`.
//!
//! 조인 키는 **`"<tabId>:<leafId>"`** 다. 상태 파일의 엔트리 키(`paneKey`)가 정확히 그 형식이고,
//! `terminal list` 가 `tabId` 와 `leafId` 를 따로 준다.
//!
//! ## 왜 목록에도 CLI 가 필요한가 (cmux 와 다른 점)
//! 상태 파일 엔트리는 pane 이 닫혀도 **7일간 남는다**(Orca 의 `HYDRATE_MAX_AGE_MS`). 그래서
//! 파일만 읽으면 지난주에 끝난 작업이 목록에 남는다. cmux 가 `_ppid` 로 생존을 확인하듯,
//! 여기서는 `terminal list` 에 **아직 있는 pane 만** 남긴다 — 덤으로 동작에 쓸 handle 도 같은
//! 호출에서 온다. 대신 그 호출은 Electron 을 node 로 띄우는 셸 래퍼라 한 번에 ~140 ms 든다.
//! 감시 루프는 800 ms 마다 목록을 두 번(agent·workspace) 읽으므로 **캐시가 없으면 상시 부하가
//! 된다**. 그래서 (1) 결과를 `TERMS_TTL_MS` 동안 캐시하고, (2) 데몬 pid 파일로 Orca 가 떠
//! 있는지 먼저 확인해 꺼져 있으면 프로세스를 아예 띄우지 않는다.

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use crate::herdr::{read_session_info, HerdrAgent, HerdrWorkspace};

/// herdr 의 "세션 이름" 자리에 들어갈 값. Orca 는 앱 하나가 전부라 멀티플렉서 세션 개념이
/// 없으므로 고정 문자열을 쓴다. `Both`(혼합) 모드에서 **동작을 어느 백엔드로 보낼지 가르는
/// 키**이기도 하다(`herdr::route_of`).
pub const SESSION: &str = "orca";

/// Orca 앱 번들 경로(OS 앱 활성화용).
const ORCA_APP: &str = "/Applications/Orca.app";

/// 터미널 목록 캐시 수명. 목록이 바뀌는 속도(탭을 열고 닫는 속도)에 비하면 넉넉하고,
/// 감시 루프 한 틱 안의 두 호출이 한 번의 실행을 나눠 쓰기에 충분하다.
/// **상태는 이 캐시를 타지 않는다** — 상태 파일은 매번 새로 읽으므로 진행/대기 전환은 즉시 보인다.
const TERMS_TTL_MS: u64 = 2000;

/// Orca CLI 경로. 앱 번들 안에 있고 PATH 에는 보통 없다(사용자가 Settings → Orca CLI 로
/// 등록해야 심볼릭 링크가 생기는데, 우리 쪽에서 그걸 기대할 수는 없다).
fn orca_bin() -> String {
    if let Ok(b) = std::env::var("ORCA_BIN") {
        return b;
    }
    const BUNDLED: &str = "/Applications/Orca.app/Contents/Resources/bin/orca";
    if Path::new(BUNDLED).exists() {
        return BUNDLED.to_string();
    }
    "orca".into()
}

/// Orca 앱 데이터 디렉터리(`~/Library/Application Support/orca`).
fn support_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("orca");
    p.is_dir().then_some(p)
}

/// 훅 상태 파일 경로.
fn status_path() -> Option<PathBuf> {
    let p = support_dir()?.join("agent-hooks").join("last-status.json");
    p.exists().then_some(p)
}

/// Orca 런타임(데몬)이 살아 있는가.
///
/// CLI 를 헛돌리지 않기 위한 값싼 사전 확인이다. 데몬은 `daemon-v<N>.pid` 에 자기 pid 를
/// JSON 으로 남기는데, 그 파일은 비정상 종료 시 남을 수 있으므로 **pid 가 실제로 살아 있는지**
/// 까지 본다(`kill(pid, 0)`). 버전 접미사는 Orca 가 올라가면 바뀌므로 이름을 박지 않고 훑는다.
fn daemon_alive() -> bool {
    let Some(dir) = support_dir().map(|d| d.join("daemon")) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return false;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("daemon-") && name.ends_with(".pid")) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let Some(pid) = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("pid").and_then(|p| p.as_i64()))
        else {
            continue;
        };
        if pid_alive(pid as i32) {
            return true;
        }
    }
    false
}

/// pid 가 살아 있는가. 시그널 0 은 아무것도 보내지 않고 존재/권한만 확인한다.
#[cfg(target_os = "macos")]
fn pid_alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

/// macOS 외에서는 확인 수단을 두지 않는다 — 확인 실패로 목록을 비우는 것보다 CLI 에 맡기는
/// 편이 낫다(어차피 Orca 가 없으면 실행이 실패한다).
#[cfg(not(target_os = "macos"))]
fn pid_alive(_pid: i32) -> bool {
    true
}

// ─────────────────────────── 상태 파일 ───────────────────────────

/// pane 하나의 마지막 에이전트 상태.
#[derive(Clone)]
struct StatusRow {
    /// Claude 트랜스크립트 파일명(`providerSession.id`). 프롬프트·recap·토큰을 herdr 백엔드와
    /// **같은 함수**로 읽는 근거다.
    session_id: Option<String>,
    /// `claude` / `codex` / … (`payload.agentType`).
    agent: String,
    /// herdr 어휘로 옮긴 진행 상태.
    status: String,
}

/// Orca 의 상태 이름 → herdr 의 상태 이름.
///
/// Orca 쪽 매핑(앱 번들에서 확인): `UserPromptSubmit`·`PreToolUse`·`PostToolUse` → `working`,
/// `PermissionRequest` 와 AskUserQuestion 의 `PreToolUse` → `waiting`, `Stop`·`StopFailure`
/// → `done`. 즉 세 값이 그대로 우리 working/blocked/done 이다. `SubagentStop` 은 Orca 가
/// 자체 롤업으로 흡수해 pane 상태를 흔들지 않으므로(herdr·cmux 통합이 같은 이유로 무시한다)
/// 여기서 따로 걸러 낼 것이 없다.
fn map_state(state: &str) -> &'static str {
    match state {
        "working" => "working",
        "waiting" => "blocked",
        "done" => "done",
        _ => "idle",
    }
}

/// 상태 파일을 pane 키별로 읽는다. 파일이 없거나 깨졌으면 빈 맵(= 에이전트 없음).
fn read_status() -> HashMap<String, StatusRow> {
    let mut out = HashMap::new();
    let Some(path) = status_path() else {
        return out;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return out;
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return out;
    };
    let Some(entries) = v.get("entries").and_then(|e| e.as_object()) else {
        return out;
    };
    for (pane_key, entry) in entries {
        let payload = entry.get("payload");
        let state = payload
            .and_then(|p| p.get("state"))
            .and_then(|s| s.as_str())
            .unwrap_or("");
        out.insert(
            pane_key.clone(),
            StatusRow {
                session_id: entry
                    .pointer("/providerSession/id")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                agent: payload
                    .and_then(|p| p.get("agentType"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("claude")
                    .to_string(),
                status: map_state(state).to_string(),
            },
        );
    }
    out
}

// ─────────────────────────── 터미널 목록(CLI) ───────────────────────────

/// 살아 있는 터미널 하나.
#[derive(Clone)]
struct TermRow {
    /// 동작(전환·전송·읽기)의 대상. **런타임 스코프**라 Orca 를 재시작하면 바뀐다 —
    /// 그래서 저장하지 않고 매번 목록에서 다시 얻는다.
    handle: String,
    /// `"<tabId>:<leafId>"` — 상태 파일과의 조인 키.
    pane_key: String,
    cwd: Option<String>,
    /// 에이전트가 붙인 작업 이름(탭 제목).
    title: String,
}

/// `(캐시 시각, 목록)`. 실패도 빈 목록으로 캐시해 실패를 반복하지 않는다.
static TERMS: Mutex<Option<(u64, Vec<TermRow>)>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 지금 살아 있는 터미널 목록(TTL 캐시). Orca 가 꺼져 있으면 CLI 를 띄우지 않는다.
fn terminals() -> Vec<TermRow> {
    let now = now_ms();
    if let Ok(g) = TERMS.lock() {
        if let Some((at, rows)) = g.as_ref() {
            if now.saturating_sub(*at) < TERMS_TTL_MS {
                return rows.clone();
            }
        }
    }
    let rows = if daemon_alive() {
        fetch_terminals().unwrap_or_else(|e| {
            log::warn!("orca terminal list 실패: {e}");
            Vec::new()
        })
    } else {
        Vec::new()
    };
    if let Ok(mut g) = TERMS.lock() {
        *g = Some((now, rows.clone()));
    }
    rows
}

/// `orca terminal list --json` 을 실제로 호출해 파싱한다.
fn fetch_terminals() -> Result<Vec<TermRow>, String> {
    let v = run_orca(&["terminal", "list", "--json"])?;
    let list = v
        .pointer("/result/terminals")
        .and_then(|x| x.as_array())
        .ok_or_else(|| "terminal list 응답에 terminals 가 없습니다.".to_string())?;
    let str_of = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).map(String::from);
    Ok(list
        .iter()
        .filter(|t| {
            // 붙어 있지 않은(프로세스가 사라진) pane 은 목록에서 뺀다 — 이게 상태 파일의
            // 7일짜리 잔여 엔트리를 걸러 내는 생존 확인이다.
            !t.get("orphaned").and_then(|x| x.as_bool()).unwrap_or(false)
        })
        .filter_map(|t| {
            let handle = str_of(t, "handle")?;
            let tab = str_of(t, "tabId")?;
            let leaf = str_of(t, "leafId")?;
            Some(TermRow {
                handle,
                pane_key: format!("{tab}:{leaf}"),
                cwd: str_of(t, "worktreePath"),
                title: str_of(t, "title").unwrap_or_default(),
            })
        })
        .collect())
}

// ─────────────────────────── pane 참조 ───────────────────────────

/// pane 식별자를 herdr 와 **같은 `"<워크스페이스>:<pane>"` 형식**으로 만든다.
///
/// 세션 목록 뷰는 `pane_id.startsWith(workspace_id + ":")` 로 워크스페이스에 딸린 pane 을
/// 찾는다(`claude-bridge-view.tsx` 의 `paneOf`). Orca 는 워크스페이스 = pane 키,
/// pane = 그 뒤에 붙인 handle 이므로 `"<tabId>:<leafId>:<handle>"` 가 된다. handle 을 **뒤**에
/// 두는 이유는 위 접두어 규칙을 지키면서도 `rsplit_once(':')` 하나로 되돌릴 수 있기 때문이다.
fn pane_ref(pane_key: &str, handle: &str) -> String {
    format!("{pane_key}:{handle}")
}

/// `pane_ref` 에서 동작 대상 handle 을 되돌린다. 스냅샷을 다시 읽지 않고 형식만으로 판단한다.
fn handle_of(pane_id: &str) -> &str {
    pane_id.rsplit_once(':').map_or(pane_id, |(_, h)| h)
}

/// `pane_ref` 에서 워크스페이스(= pane 키)를 되돌린다. `Both` 모드의 중복 제거에 쓴다.
pub fn workspace_of(pane_id: &str) -> String {
    pane_id
        .rsplit_once(':')
        .map_or(pane_id, |(ws, _)| ws)
        .to_string()
}

/// 카드에 보일 이름. Claude 가 터미널 제목에 붙이는 진행 표시 글리프(`✳`·`✻` …)는 떼어 낸다 —
/// 상태는 카드의 상태 칩이 이미 말하고, 글리프는 매 턴 바뀌어 이름이 흔들려 보인다.
fn label_of(t: &TermRow) -> String {
    let title = t
        .title
        .trim_start_matches(|c: char| "✳✻✽✶*·".contains(c) || c.is_whitespace())
        .trim();
    if !title.is_empty() {
        return title.to_string();
    }
    // 제목이 없으면 작업 폴더 이름으로 대신한다(빈 카드보다 낫다).
    t.cwd
        .as_deref()
        .and_then(|c| c.rsplit('/').next())
        .unwrap_or("Orca")
        .to_string()
}

// ─────────────────────────── 목록 (herdr 와 같은 모양) ───────────────────────────

/// 실행 중인 Claude 세션 목록.
///
/// **상태 기록이 있는 pane 만** 에이전트로 본다. 그냥 셸을 띄워 둔 탭은 훅을 쏜 적이 없어
/// 상태 파일에 없으므로 자연히 빠진다.
pub fn list_agents() -> Result<Vec<HerdrAgent>, String> {
    let status = read_status();
    let mut out: Vec<HerdrAgent> = terminals()
        .into_iter()
        .filter_map(|t| {
            let s = status.get(&t.pane_key)?;
            Some(HerdrAgent {
                pane_id: pane_ref(&t.pane_key, &t.handle),
                agent: Some(s.agent.clone()),
                agent_status: s.status.clone(),
                cwd: t.cwd,
                session_id: s.session_id.clone(),
                session: SESSION.to_string(),
            })
        })
        .collect();
    // 폴링마다 순서가 흔들리면 목록이 튄다.
    out.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
    Ok(out)
}

/// 워크스페이스(작업) 목록.
///
/// **pane 하나가 카드 하나**다. Orca 의 worktree 로 묶지 않는 이유는 cmux 가 herdr 세션들을 한
/// 탭으로 뭉쳐 보이던 것과 같은 문제 때문이다 — 한 worktree 에서 에이전트를 두 개 띄우면 카드가
/// 하나로 합쳐지고, 이동도 그 묶음까지만 닿는다. 반대로 pane 단위면 `terminal switch` 가 정확히
/// 그 pane 을 띄운다.
///
/// 프롬프트·recap·토큰은 herdr 백엔드와 **같은 함수**로 트랜스크립트에서 읽으므로 화면에 보이는
/// 정보가 백엔드에 따라 달라지지 않는다.
pub fn list_workspaces() -> Result<Vec<HerdrWorkspace>, String> {
    let status = read_status();
    let mut out = Vec::new();
    for t in terminals() {
        let Some(s) = status.get(&t.pane_key) else {
            continue;
        };
        let info = match s.session_id.as_deref() {
            Some(sid) => read_session_info(sid),
            None => Default::default(),
        };
        out.push(HerdrWorkspace {
            workspace_id: t.pane_key.clone(),
            label: label_of(&t),
            agent_status: s.status.clone(),
            // Orca 는 "지금 보고 있는 pane" 을 목록에 내주지 않는다. 강조가 하나도 없는 편이
            // 엉뚱한 카드를 현재 작업으로 가리키는 것보다 낫다.
            focused: false,
            pane_count: 1,
            last_prompt: info.last_prompt,
            last_prompt_at: info.last_prompt_at,
            recap: info.recap,
            token_usage: info.tokens,
            agent: Some(s.agent.clone()),
            session: SESSION.to_string(),
        });
    }
    out.sort_by(|a, b| (&a.label, &a.workspace_id).cmp(&(&b.label, &b.workspace_id)));
    Ok(out)
}

// ─────────────────────────── 동작 (CLI) ───────────────────────────

/// Orca CLI 를 호출하고 stdout 을 JSON 으로 파싱한다.
///
/// CLI 는 실패도 `{"ok":false,"error":{...}}` 로 0 종료할 수 있어 **종료 코드만 보면 안 된다**.
fn run_orca(args: &[&str]) -> Result<Value, String> {
    let out = Command::new(orca_bin())
        .args(args)
        .output()
        .map_err(|e| format!("orca 실행 실패: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(stdout.trim()).unwrap_or(Value::Null);
    if v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
        return Ok(v);
    }
    // 오류 메시지는 JSON 안(구조화) 또는 stderr(실행 자체 실패) 어느 쪽에도 올 수 있다.
    let msg = v
        .pointer("/error/message")
        .or_else(|| v.get("error"))
        .and_then(|x| x.as_str())
        .map(String::from)
        .unwrap_or_else(|| String::from_utf8_lossy(&out.stderr).trim().to_string());
    Err(if msg.is_empty() {
        "orca 명령이 실패했습니다(Orca 가 실행 중인지 확인해 주세요).".to_string()
    } else {
        msg
    })
}

/// Orca 앱을 앞으로 가져온다. 다른 Space 에 있으면 macOS 가 그 Space 로 전환한다
/// (herdr 백엔드의 `focus_terminal_app` 과 같은 원리 — AXRaise 로는 Space 를 못 넘는다).
fn focus_app() {
    #[cfg(target_os = "macos")]
    {
        let target = if Path::new(ORCA_APP).exists() {
            ORCA_APP
        } else {
            "Orca"
        };
        let _ = Command::new("open").args(["-a", target]).output();
    }
}

/// 워크스페이스(= pane 키)에 해당하는 터미널을 앞으로 가져온다.
///
/// 워크스페이스와 pane 이 1:1 이라 pane 전환과 같은 동작이지만, handle 은 저장하지 않으므로
/// 목록에서 다시 찾는다(런타임 스코프라 Orca 재시작 뒤엔 옛 handle 이 무효다).
pub fn focus_workspace(workspace_id: &str) -> Result<(), String> {
    let handle = terminals()
        .into_iter()
        .find(|t| t.pane_key == workspace_id)
        .map(|t| t.handle)
        .ok_or_else(|| "Orca 에서 해당 터미널을 찾지 못했습니다(닫혔을 수 있습니다).".to_string());
    let r = match &handle {
        Ok(h) => run_orca(&["terminal", "switch", "--terminal", h, "--json"]).map(|_| ()),
        Err(e) => Err(e.clone()),
    };
    // 전환에 실패해도 앱은 앞으로 띄운다 — 아무 반응도 없는 것보다 낫다.
    focus_app();
    r
}

/// 해당 pane 을 앞으로 가져온다.
pub fn focus_pane(pane_id: &str) -> Result<(), String> {
    let r = run_orca(&["terminal", "switch", "--terminal", handle_of(pane_id), "--json"]).map(|_| ());
    focus_app();
    r
}

/// 프롬프트를 입력하고 Enter 를 보낸다. Orca 는 붙여넣기와 Enter 가 한 호출이라
/// (cmux 처럼) 텍스트만 들어간 채 남는 중간 상태가 없다.
pub fn send_prompt(pane_id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    run_orca(&[
        "terminal",
        "send",
        "--terminal",
        handle_of(pane_id),
        "--text",
        text,
        "--enter",
        "--json",
    ])
    .map(|_| ())
}

/// pane 의 최근 화면을 읽는다. herdr 의 `agent read` 대응.
/// 응답은 줄 배열(`result.terminal.tail`)이라 그대로 이어 붙인다.
pub fn read_pane(pane_id: &str, lines: u32) -> Result<String, String> {
    let n = lines.to_string();
    let v = run_orca(&[
        "terminal",
        "read",
        "--terminal",
        handle_of(pane_id),
        "--limit",
        &n,
        "--json",
    ])?;
    let tail = v
        .pointer("/result/terminal/tail")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|l| l.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Ok(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 상태 파일의 실제 모양(Orca 1.4.x)을 그대로 넣어 조인에 필요한 세 값이 나오는지 본다.
    #[test]
    fn reads_session_id_and_state_from_status_entry() {
        let raw = r#"{"version":2,"entries":{"tab-1:leaf-2":{
            "paneKey":"tab-1:leaf-2",
            "worktreeId":"repo-1::/tmp/wt",
            "hookEventName":"PermissionRequest",
            "providerSession":{"key":"session_id","id":"abc-123","transcriptPath":"/x.jsonl"},
            "payload":{"state":"waiting","agentType":"claude","prompt":"안녕"},
            "receivedAt":1785152097033}}}"#;
        let v: Value = serde_json::from_str(raw).unwrap();
        let entry = &v["entries"]["tab-1:leaf-2"];
        assert_eq!(
            entry.pointer("/providerSession/id").unwrap().as_str(),
            Some("abc-123")
        );
        // Orca 의 waiting 은 우리 blocked 다 — 이 한 줄이 어긋나면 입력 대기 알림이 통째로 죽는다.
        assert_eq!(map_state("waiting"), "blocked");
        assert_eq!(map_state("working"), "working");
        assert_eq!(map_state("done"), "done");
        assert_eq!(map_state("무엇이든"), "idle");
    }

    /// pane 참조는 herdr 의 `"<워크스페이스>:<pane>"` 규칙을 지켜야 한다 — 세션 목록 뷰가
    /// `startsWith(workspace_id + ":")` 로 pane 을 찾기 때문이다.
    #[test]
    fn pane_ref_keeps_workspace_prefix() {
        let id = pane_ref("tab-1:leaf-2", "term_abc");
        assert!(id.starts_with("tab-1:leaf-2:"));
        assert_eq!(handle_of(&id), "term_abc");
        assert_eq!(workspace_of(&id), "tab-1:leaf-2");
    }

    /// 실제로 돌고 있는 Orca 를 상대로 조인 결과를 눈으로 확인하는 진단용 테스트.
    /// (Orca 가 떠 있어야 하고 결과가 환경마다 달라 CI 에서는 돌리지 않는다.)
    /// `cargo test --lib orca::tests::live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_snapshot() {
        println!("daemon_alive = {}", daemon_alive());
        for a in list_agents().unwrap() {
            println!(
                "agent  status={:<8} session_id={:?} pane={}",
                a.agent_status, a.session_id, a.pane_id
            );
        }
        for w in list_workspaces().unwrap() {
            println!(
                "ws     status={:<8} label={:?} prompt={:?}",
                w.agent_status,
                w.label,
                w.last_prompt.as_deref().map(|p| &p[..p.len().min(40)])
            );
        }
    }

    /// 제목의 진행 글리프는 이름이 아니다.
    #[test]
    fn label_strips_progress_glyph() {
        let t = TermRow {
            handle: "term_a".into(),
            pane_key: "t:l".into(),
            cwd: Some("/Users/x/my-space".into()),
            title: "✳ 로그가 계속 표시되는 문제".into(),
        };
        assert_eq!(label_of(&t), "로그가 계속 표시되는 문제");

        let empty = TermRow {
            title: String::new(),
            ..t
        };
        assert_eq!(label_of(&empty), "my-space");
    }
}
