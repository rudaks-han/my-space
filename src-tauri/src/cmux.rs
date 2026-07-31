//! cmux 연동 — cmux 터미널에서 도는 Claude Code 세션을 herdr 와 **같은 데이터 모양**
//! (`HerdrAgent` / `HerdrWorkspace`)으로 읽어 온다. 세션 목록 뷰·펫·홈 카드는 어느
//! 백엔드로 읽었는지 알 필요가 없다.
//!
//! ## 상태를 어디서 얻는가 (실험으로 확정된 사실)
//! herdr 는 CLI(=소켓)로 pane 상태를 물어볼 수 있지만, **cmux 소켓은 cmux 안에서 시작된
//! 프로세스만 붙을 수 있다** ("Access denied - only processes started inside cmux can
//! connect"). My Space 는 Finder/LaunchAgent 에서 뜨므로 목록 조회에 소켓을 쓸 수 없다.
//!
//! 대신 cmux 는 자기 이벤트를 `~/.cmuxterm/events.jsonl` 에 남기고, 그 안에
//! `agent.hook.<훅이름>` 이벤트가 있다. cmux 안에서 `claude` 를 실행하면
//! `cmux-claude-wrapper` 가 `--settings` 로 훅 묶음을 주입하기 때문이다(사용자가 따로
//! 설치할 것이 없다). 그 payload 가 우리에게 필요한 전부를 준다:
//!   - `session_id`: `"claude-<uuid>"` — **uuid 가 곧 Claude 트랜스크립트 파일명**이다.
//!     그래서 herdr 백엔드가 쓰던 `read_session_info()` / `find_transcript()` /
//!     `ask_file_exists()` 가 그대로 재사용된다(프롬프트·recap·토큰·질문 픽커).
//!   - `workspace_id`: cmux 워크스페이스(탭) — 이동(focus)의 대상.
//!   - `hook_event_name` + `phase`: 진행 상태 그 자체(아래 `status_of`).
//!   - `cwd`, `_source`(claude/codex/…), `_ppid`(에이전트 프로세스 — 생존 확인용).
//! 워크스페이스 제목·cwd·선택 여부는 `workspace.created|selected`, 워크스페이스 ↔ surface
//! (=pane) 대응은 `surface.created|focused|selected` 에서 온다.
//!
//! ## 그래서 소켓은 "동작"에만 쓴다
//! 목록·상태는 파일이라 항상 읽히지만, 이동·프롬프트 전송·화면 읽기는 CLI(=소켓)를 거친다.
//! 소켓 비밀번호(cmux 설정에서 만든 값)가 없으면 **목록은 정상이고 그 세 동작만 실패**한다.
//! 이 비대칭은 의도된 것이다 — 비밀번호를 안 넣어도 세션 목록은 보여야 한다.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::Ordering;

use crate::herdr::{read_session_info, HerdrAgent, HerdrWorkspace};

/// herdr 의 "세션 이름" 자리에 들어갈 값. cmux 는 앱 하나가 전부라 멀티플렉서 세션 개념이
/// 없으므로 고정 문자열을 쓴다(UI 의 세션 꼬리표는 값이 하나뿐이면 표시되지 않는다).
pub const SESSION: &str = "cmux";

/// 이벤트 로그를 얼마나 거슬러 읽을지. 이벤트는 한 줄에 수백 바이트라 1MB 면 수천 건이다.
/// 앞이 잘려 깨진 첫 줄은 JSON 파싱에서 그냥 버려진다.
const TAIL_BYTES: u64 = 1024 * 1024;

/// cmux CLI 경로. 앱 번들 안에 있고 PATH 에는 보통 없다(셸 통합이 넣어 주는 shim 은
/// cmux 안에서만 유효하므로 우리 쪽에서는 기대할 수 없다).
fn cmux_bin() -> String {
    if let Ok(b) = std::env::var("CMUX_BIN") {
        return b;
    }
    const BUNDLED: &str = "/Applications/cmux.app/Contents/Resources/bin/cmux";
    if Path::new(BUNDLED).exists() {
        return BUNDLED.to_string();
    }
    "cmux".into()
}

/// cmux 앱 번들 경로(OS 앱 활성화용).
const CMUX_APP: &str = "/Applications/cmux.app";

/// cmux 이벤트 로그(`~/.cmuxterm/events.jsonl`).
fn events_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join(".cmuxterm").join("events.jsonl");
    p.exists().then_some(p)
}

/// 소켓 비밀번호 저장 경로. 설정(localStorage)은 Rust 가 못 읽으므로 파일로 받아 둔다
/// (`~/.myspace/watch-disabled` 와 같은 방식). 비밀번호이므로 0600 으로 쓴다.
fn password_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".myspace").join("cmux-password"))
}

/// 저장된 소켓 비밀번호(없거나 비어 있으면 None).
fn socket_password() -> Option<String> {
    let raw = std::fs::read_to_string(password_path()?).ok()?;
    let pw = raw.trim().to_string();
    (!pw.is_empty()).then_some(pw)
}

/// 소켓 비밀번호를 저장한다(빈 문자열이면 파일을 지운다).
/// 값이 바뀌었으니 인증 실패 백오프도 함께 푼다 — 방금 비밀번호를 넣은 사용자가 1분을
/// 기다려야 한다면 "설정했는데 안 된다"로 보인다.
pub fn set_socket_password(pw: &str) {
    DENIED_UNTIL.store(0, Ordering::Relaxed);
    let Some(path) = password_path() else { return };
    if pw.trim().is_empty() {
        let _ = std::fs::remove_file(&path);
        return;
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&path, pw.trim().as_bytes()).is_ok() {
        // 홈 디렉터리라 해도 비밀번호 파일을 world-readable 로 두지 않는다.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

// ─────────────────────────── 프로세스 상태 ───────────────────────────

/// `ps` 한 번으로 (살아 있는 pid 집합, cmux 앱 실행 여부)를 함께 얻는다.
/// 매 폴링마다 도는 경로라 호출을 하나로 합쳐 둔다.
fn process_snapshot() -> (HashSet<u32>, bool) {
    let mut pids = HashSet::new();
    let mut cmux_up = false;
    let Ok(out) = Command::new("ps").args(["-axo", "pid=,comm="]).output() else {
        // ps 를 못 돌리면 "다 살아 있다"로 본다 — 생존 확인 실패 때문에 목록이 비는 것이
        // 더 나쁜 오동작이다.
        return (pids, true);
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let Some(pid) = it.next().and_then(|p| p.parse::<u32>().ok()) else {
            continue;
        };
        pids.insert(pid);
        let comm = it.collect::<Vec<_>>().join(" ");
        if comm.ends_with("/cmux.app/Contents/MacOS/cmux") {
            cmux_up = true;
        }
    }
    (pids, cmux_up)
}

// ─────────────────────────── 이벤트 로그 스캔 ───────────────────────────

/// 워크스페이스(=cmux 탭) 한 개.
#[derive(Default, Clone)]
struct WsRow {
    /// cmux 가 붙인 제목. `Stop` 훅의 auto-name 이 작업 요약으로 바꿔 주기도 한다.
    title: String,
    /// 사용자가 직접 붙인 제목(있으면 이게 우선).
    custom_title: Option<String>,
    cwd: Option<String>,
    selected: bool,
    tab_count: u32,
    /// 이 워크스페이스에서 가장 최근에 포커스된 surface(=herdr 의 pane 자리).
    surface: Option<String>,
}

/// 이 워크스페이스에 보일 이름.
impl WsRow {
    fn label(&self) -> String {
        self.custom_title
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.title)
            .to_string()
    }
}

/// 실행 중인 에이전트 한 개(= Claude 세션 하나).
#[derive(Clone)]
struct AgentRow {
    /// Claude 트랜스크립트 파일명(= `claude-` 접두어를 벗긴 uuid).
    session_id: String,
    workspace_id: String,
    cwd: Option<String>,
    agent_status: String,
    /// `claude` / `codex` / `opencode` …
    source: String,
    /// 에이전트 프로세스 pid(생존 확인용). 없으면 확인을 건너뛴다.
    pid: Option<u32>,
}

/// 훅 이벤트 → 진행 상태. herdr 의 4상태(working/idle/blocked/done)에 맞춘다.
///
/// `None` 은 "상태를 건드리지 않는다"는 뜻이다. 특히 `SubagentStop` 은 herdr 통합이 같은
/// 이유로 무시한다 — 본 턴이 이미 끝난 뒤에도 recap 때문에 늦게 오므로, 이걸로 상태를
/// 되돌리면 끝난 작업이 다시 진행 중으로 보인다.
fn status_of(event: &str, phase: &str) -> Option<&'static str> {
    match event {
        "SessionStart" => Some("idle"),
        "UserPromptSubmit" => Some("working"),
        "PreToolUse" | "PostToolUse" | "PostToolUseFailure" => Some("working"),
        // 사용자 확인이 필요한 순간. cmux wrapper 는 Notification 과 PermissionRequest
        // 둘 다 걸어 두므로 어느 쪽으로 와도 대기로 잡힌다.
        "Notification" => Some("blocked"),
        // PermissionRequest 는 동기 훅(타임아웃 125초)이라 completed = 사용자가 답했다는 뜻.
        "PermissionRequest" if phase == "received" => Some("blocked"),
        "PermissionRequest" => Some("working"),
        "Stop" | "StopFailure" => Some("done"),
        _ => None,
    }
}

/// 이벤트 로그를 훑어 (워크스페이스, 에이전트) 스냅샷을 만든다.
///
/// 로그는 append-only 라 **오래된 줄부터 순서대로** 적용하면 마지막 상태가 남는다.
/// cmux 를 재시작하면 `boot_id` 가 바뀌므로 **가장 최근 boot_id 의 줄만** 본다 — 지난
/// 실행의 워크스페이스는 이미 사라졌는데 목록에 남는 것을 막는다.
fn scan() -> (HashMap<String, WsRow>, HashMap<String, AgentRow>) {
    let Some(path) = events_path() else {
        return (HashMap::new(), HashMap::new());
    };
    let Some(text) = crate::herdr::read_tail(&path, TAIL_BYTES) else {
        return (HashMap::new(), HashMap::new());
    };
    scan_text(&text)
}

/// 이벤트 로그 본문만 받아 스냅샷을 만든다(파일 읽기와 분리 — 상태 머신은 조용히 틀리기
/// 쉬운 부분이라 본문만 넣고 결과를 확인할 수 있어야 한다).
fn scan_text(text: &str) -> (HashMap<String, WsRow>, HashMap<String, AgentRow>) {
    let mut wss: HashMap<String, WsRow> = HashMap::new();
    let mut agents: HashMap<String, AgentRow> = HashMap::new();

    // 마지막으로 등장한 boot_id = 지금 돌고 있는 cmux 의 실행 id.
    let boot = text
        .lines()
        .rev()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|v| {
            v.get("boot_id")
                .and_then(|x| x.as_str())
                .map(String::from)
        });
    let Some(boot) = boot else {
        return (wss, agents);
    };

    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("boot_id").and_then(|x| x.as_str()) != Some(boot.as_str()) {
            continue;
        }
        let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let p = v.get("payload").cloned().unwrap_or(Value::Null);
        let str_of = |o: &Value, k: &str| o.get(k).and_then(|x| x.as_str()).map(String::from);

        match name {
            "workspace.created" | "workspace.selected" => {
                let Some(id) = str_of(&p, "workspace_id") else {
                    continue;
                };
                let selected = p
                    .get("selected")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                if selected {
                    // 선택은 하나뿐이다(창이 여러 개면 마지막으로 고른 것이 이긴다 —
                    // focused 는 표시용 힌트라 이 근사로 충분하다).
                    for w in wss.values_mut() {
                        w.selected = false;
                    }
                }
                let row = wss.entry(id).or_default();
                if let Some(t) = str_of(&p, "title") {
                    row.title = t;
                }
                row.custom_title = str_of(&p, "custom_title");
                if let Some(c) = str_of(&p, "cwd") {
                    row.cwd = Some(c);
                }
                row.selected = selected;
                row.tab_count = p
                    .get("tab_count")
                    .and_then(|x| x.as_u64())
                    .unwrap_or(row.tab_count as u64) as u32;
            }
            "workspace.closed" => {
                if let Some(id) = str_of(&p, "workspace_id") {
                    wss.remove(&id);
                    // 그 워크스페이스에 매달린 에이전트도 함께 사라진다.
                    agents.retain(|_, a| a.workspace_id != id);
                }
            }
            "surface.created" | "surface.focused" | "surface.selected" => {
                // surface 이벤트의 workspace_id 는 payload 가 아니라 봉투(envelope)에 있다.
                let Some(ws) = v.get("workspace_id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let Some(surface) = str_of(&p, "surface_id") else {
                    continue;
                };
                wss.entry(ws.to_string()).or_default().surface = Some(surface);
            }
            "surface.closed" => {
                let Some(ws) = v.get("workspace_id").and_then(|x| x.as_str()) else {
                    continue;
                };
                let closed = str_of(&p, "surface_id");
                if let Some(row) = wss.get_mut(ws) {
                    if row.surface == closed {
                        row.surface = None;
                    }
                }
            }
            n if n.starts_with("agent.hook.") => {
                let event = &n["agent.hook.".len()..];
                let Some(raw_sid) = str_of(&p, "session_id") else {
                    continue;
                };
                let source = str_of(&p, "_source").unwrap_or_else(|| "claude".into());
                // `"claude-<uuid>"` → `<uuid>`(트랜스크립트 파일명). 접두어가 없으면 그대로.
                let session_id = raw_sid
                    .strip_prefix(&format!("{source}-"))
                    .unwrap_or(&raw_sid)
                    .to_string();

                if event == "SessionEnd" {
                    agents.remove(&session_id);
                    continue;
                }
                let phase = p
                    .get("phase")
                    .and_then(|x| x.as_str())
                    .unwrap_or("received");
                let Some(status) = status_of(event, phase) else {
                    continue;
                };
                let workspace_id = str_of(&p, "workspace_id")
                    .or_else(|| v.get("workspace_id").and_then(|x| x.as_str()).map(String::from))
                    .unwrap_or_default();
                let row = agents.entry(session_id.clone()).or_insert_with(|| AgentRow {
                    session_id,
                    workspace_id: workspace_id.clone(),
                    cwd: None,
                    agent_status: status.to_string(),
                    source: source.clone(),
                    pid: None,
                });
                if !workspace_id.is_empty() {
                    row.workspace_id = workspace_id;
                }
                if let Some(c) = str_of(&p, "cwd") {
                    row.cwd = Some(c);
                }
                if let Some(pid) = p.get("_ppid").and_then(|x| x.as_u64()) {
                    row.pid = Some(pid as u32);
                }
                row.source = source;
                row.agent_status = status.to_string();
            }
            _ => {}
        }
    }

    (wss, agents)
}

/// 살아 있는 에이전트만 남긴 스냅샷. cmux 가 떠 있지 않으면 빈 값을 준다
/// (지난 실행의 상태가 그대로 보이면 "지금 뭐가 도는가"라는 뷰의 전제가 깨진다).
fn snapshot() -> (HashMap<String, WsRow>, Vec<AgentRow>) {
    let (pids, cmux_up) = process_snapshot();
    if !cmux_up {
        return (HashMap::new(), Vec::new());
    }
    let (wss, agents) = scan();
    let mut live: Vec<AgentRow> = agents
        .into_values()
        // pid 를 모르는 건 남긴다(정리 못 하는 편이, 살아 있는 세션을 지우는 것보다 낫다).
        .filter(|a| a.pid.map_or(true, |p| pids.contains(&p)))
        .collect();
    live.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    (wss, live)
}

/// 워크스페이스에 보일 상태. 한 워크스페이스에 여러 에이전트가 있으면 사람이 봐야 하는
/// 쪽을 올린다(펫의 mood 우선순위와 같은 규칙).
fn merge_status(rows: &[&AgentRow]) -> String {
    for want in ["blocked", "working", "done", "idle"] {
        if rows.iter().any(|a| a.agent_status == want) {
            return want.to_string();
        }
    }
    // 에이전트가 없는 워크스페이스(터미널만 열어 둔 탭). herdr 도 같은 값을 쓴다.
    "unknown".to_string()
}

/// pane 식별자를 herdr 와 **같은 `"<워크스페이스>:<pane>"` 형식**으로 만든다.
///
/// 세션 목록 뷰는 `pane_id.startsWith(workspace_id + ":")` 로 워크스페이스에 딸린 pane 을
/// 찾는다(`claude-bridge-view.tsx` 의 `paneOf`). 그래서 cmux 도 이 형식을 지켜야 로그
/// 읽기·프롬프트 전송이 herdr 와 똑같이 동작한다. surface 를 아직 못 봤으면 뒤를 비워 두고,
/// `parse_target` 이 그 경우 워크스페이스를 대상으로 삼는다.
fn pane_ref(ws_id: &str, ws: Option<&WsRow>) -> String {
    let surface = ws.and_then(|w| w.surface.as_deref()).unwrap_or("");
    format!("{ws_id}:{surface}")
}

/// `pane_ref` 를 cmux CLI 인자로 되돌린다 → (플래그, 값).
/// 스냅샷을 다시 읽지 않고 형식만으로 판단한다(감시 루프가 pane 마다 호출하는 경로다).
fn parse_target(pane_id: &str) -> (&'static str, &str) {
    match pane_id.split_once(':') {
        Some((_, surface)) if !surface.is_empty() => ("--surface", surface),
        Some((ws, _)) => ("--workspace", ws),
        // ":" 가 없으면 예전 형식(surface 단독)으로 본다.
        None => ("--surface", pane_id),
    }
}

// ─────────────────────────── 목록 (herdr 와 같은 모양) ───────────────────────────

/// 실행 중인 Claude 세션 목록.
pub fn list_agents() -> Result<Vec<HerdrAgent>, String> {
    let (wss, agents) = snapshot();
    Ok(agents
        .into_iter()
        .map(|a| HerdrAgent {
            pane_id: pane_ref(&a.workspace_id, wss.get(&a.workspace_id)),
            agent: Some(a.source),
            agent_status: a.agent_status,
            cwd: a.cwd,
            session_id: Some(a.session_id),
            session: SESSION.to_string(),
        })
        .collect())
}

/// 워크스페이스(작업) 목록. 프롬프트·recap·토큰은 herdr 백엔드와 **같은 함수**로
/// 트랜스크립트에서 읽으므로 화면에 보이는 정보가 백엔드에 따라 달라지지 않는다.
pub fn list_workspaces() -> Result<Vec<HerdrWorkspace>, String> {
    let (wss, agents) = snapshot();
    let mut out = Vec::new();
    for (id, ws) in &wss {
        let mine: Vec<&AgentRow> = agents.iter().filter(|a| &a.workspace_id == id).collect();
        // 여러 세션이 한 탭에 있으면 가장 최근 것(정렬상 마지막)의 트랜스크립트를 쓴다.
        let primary = mine.last().copied();
        let info = match primary {
            Some(a) => read_session_info(&a.session_id),
            None => Default::default(),
        };
        out.push(HerdrWorkspace {
            workspace_id: id.clone(),
            label: ws.label(),
            agent_status: merge_status(&mine),
            focused: ws.selected,
            pane_count: ws.tab_count.max(1),
            last_prompt: info.last_prompt,
            last_prompt_at: info.last_prompt_at,
            recap: info.recap,
            token_usage: info.tokens,
            agent: primary.map(|a| a.source.clone()),
            session: SESSION.to_string(),
        });
    }
    // 이름 순으로 안정 정렬(폴링마다 순서가 흔들리면 목록이 튄다).
    out.sort_by(|a, b| (&a.label, &a.workspace_id).cmp(&(&b.label, &b.workspace_id)));
    Ok(out)
}

// ─────────────────────────── 동작 (CLI = 소켓) ───────────────────────────

/// 소켓 인증이 거부된 뒤 다시 시도하지 않을 기간. 감시 루프는 질문을 찾으려고 pane 마다
/// 화면 읽기를 시도하므로, 거부 상태에서 그대로 두면 800ms 마다 프로세스를 띄우고 실패한다.
const DENIED_BACKOFF_MS: u64 = 60_000;

/// "Access denied" 를 받은 시각 + 백오프. 0 이면 시도해도 되는 상태.
static DENIED_UNTIL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 소켓 접근이 거부됐다는 안내(원인이 특이해서 무엇을 해야 하는지까지 담는다).
fn denied_message() -> String {
    "cmux 소켓 접근이 거부됐습니다. cmux 설정 → Automation 에서 소켓 비밀번호를 만든 뒤 \
     My Space 설정 → Claude Code 에 같은 값을 넣어 주세요(세션 목록·상태는 비밀번호 \
     없이도 보입니다)."
        .to_string()
}

/// cmux CLI 를 호출한다. 인증이 막혀 있는 동안은 아예 실행하지 않는다(위 백오프 참고).
fn run_cmux(args: &[&str]) -> Result<String, String> {
    if now_ms() < DENIED_UNTIL.load(Ordering::Relaxed) {
        return Err(denied_message());
    }
    let mut cmd = Command::new(cmux_bin());
    cmd.args(args);
    // 레거시 명령 별칭 안내문이 stdout 에 섞이는 것을 막는다.
    cmd.env("CMUX_QUIET", "1");
    if let Some(pw) = socket_password() {
        cmd.env("CMUX_SOCKET_PASSWORD", pw);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("cmux 실행 실패: {e}"))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).to_string());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if err.contains("Access denied") {
        DENIED_UNTIL.store(now_ms() + DENIED_BACKOFF_MS, Ordering::Relaxed);
        return Err(denied_message());
    }
    Err(if err.is_empty() {
        "cmux 명령이 실패했습니다.".to_string()
    } else {
        err
    })
}

/// cmux 앱을 앞으로 가져온다. 다른 Space 에 있으면 macOS 가 그 Space 로 전환한다
/// (herdr 백엔드의 `focus_terminal_app` 과 같은 원리 — AXRaise 로는 Space 를 못 넘는다).
fn focus_app() {
    #[cfg(target_os = "macos")]
    {
        let target = if Path::new(CMUX_APP).exists() {
            CMUX_APP
        } else {
            "cmux"
        };
        let _ = Command::new("open").args(["-a", target]).output();
    }
}

/// 해당 워크스페이스(탭)로 전환하고 cmux 창을 앞으로 가져온다.
pub fn focus_workspace(workspace_id: &str) -> Result<(), String> {
    let r = run_cmux(&["select-workspace", "--workspace", workspace_id]);
    // 소켓이 막혀 있어도 앱은 앞으로 띄운다 — 탭 전환만 못 하는 것이 아무 반응도 없는 것보다 낫다.
    focus_app();
    r.map(|_| ())
}

/// 해당 pane 을 포커스하고 cmux 창을 앞으로 가져온다. surface 를 모르면(pane 참조의 뒤가
/// 비어 있으면) 워크스페이스 전환으로 물러난다.
pub fn focus_pane(pane_id: &str) -> Result<(), String> {
    let (flag, value) = parse_target(pane_id);
    let r = if flag == "--workspace" {
        run_cmux(&["select-workspace", "--workspace", value])
    } else {
        // 워크스페이스도 함께 전환해야 다른 탭에 있는 pane 이 실제로 보인다.
        if let Some((ws, _)) = pane_id.split_once(':') {
            let _ = run_cmux(&["select-workspace", "--workspace", ws]);
        }
        run_cmux(&["focus-panel", "--panel", value])
    };
    focus_app();
    r.map(|_| ())
}

/// 프롬프트를 입력하고 Enter 를 보낸다.
///
/// herdr 의 `pane run` 은 붙여넣기+Enter 가 한 호출이었지만 cmux 는 `send` 와 `send-key`
/// 두 번이다. 그래서 첫 호출이 성공하고 둘째가 실패하면 텍스트만 입력된 채로 남는다 —
/// 사용자가 터미널에서 Enter 만 누르면 되는 상태이므로, 굳이 지우지 않고 오류만 올린다.
pub fn send_prompt(pane_id: &str, text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let (flag, value) = parse_target(pane_id);
    run_cmux(&["send", flag, value, text])?;
    run_cmux(&["send-key", flag, value, "enter"])?;
    Ok(())
}

/// pane 의 최근 화면(스크롤백 포함)을 읽는다. herdr 의 `agent read` 대응.
pub fn read_pane(pane_id: &str, lines: u32) -> Result<String, String> {
    let n = lines.to_string();
    let (flag, value) = parse_target(pane_id);
    run_cmux(&["read-screen", flag, value, "--scrollback", "--lines", &n])
}
