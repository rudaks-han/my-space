//! herdr 연동 — 터미널에서 herdr 로 실행 중인 Claude Code 세션의 AskUserQuestion 을
//! My Space 트레이 팝오버에서 받아 선택지를 고르고, 그 선택을 다시 터미널로 돌려보낸다.
//!
//! ## 배경 (실험으로 확정된 사실)
//! - herdr 는 각 agent 를 실제 PTY pane 으로 소유하고, CLI(=소켓 API)로 pane 을 제어한다.
//! - Claude 가 AskUserQuestion 을 띄우면 그 pane 의 agent_status 가 `blocked` 로 바뀐다.
//! - 선택은 방향키+Enter 로 한다(현재 커서는 기본값 1번, 목표까지 ↓ 이동 후 Enter).
//!
//! ## 질문 데이터: 화면 스크래핑이 아니라 트랜스크립트 JSON
//! pane 화면을 긁으면 옵션의 여러 줄 `preview` 때문에 렌더링이 깨져 파싱이 불안정하다.
//! 대신 Claude Code 가 남기는 세션 트랜스크립트(`~/.claude/projects/<proj>/<session>.jsonl`)
//! 에서 AskUserQuestion tool_use 입력(questions/options)을 그대로 읽는다.
//! herdr `agent list` 의 `agent_session.value` 가 곧 트랜스크립트 파일명(세션 ID)이라
//! blocked pane → 세션 → 트랜스크립트로 정확히 연결된다.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

use crate::pet;

/// blocked 폴링 주기.
const POLL_MS: u64 = 800;

/// 실행 중인 herdr agent 한 개.
#[derive(Clone, Serialize)]
pub struct HerdrAgent {
    pub pane_id: String,
    pub agent: Option<String>,
    pub agent_status: String,
    pub cwd: Option<String>,
    /// Claude 세션 ID(트랜스크립트 파일명). 질문 조회에 사용.
    pub session_id: Option<String>,
    /// 이 agent 가 속한 herdr 세션 이름(명령 라우팅용). default 세션이면 "default".
    pub session: String,
}

/// herdr 워크스페이스 한 개. label 은 rename 훅이 붙인 "프롬프트 요약"이라 작업 식별에 쓴다.
/// agent_status: working(진행중) / idle(완료·대기) / blocked(입력 대기) / done / unknown(에이전트 없음).
#[derive(Clone, Serialize)]
pub struct HerdrWorkspace {
    pub workspace_id: String,
    pub label: String,
    pub agent_status: String,
    pub focused: bool,
    pub pane_count: u32,
    /// 이 워크스페이스에서 마지막으로 입력한 프롬프트(세션 트랜스크립트 기준).
    pub last_prompt: Option<String>,
    /// 마지막 프롬프트 실행 시각(ISO8601 문자열). 목록을 최근순으로 정렬하는 데 쓴다.
    pub last_prompt_at: Option<String>,
    /// 세션에 recap(away_summary)이 있으면 그 요약 텍스트. 없으면 None.
    pub recap: Option<String>,
    /// 가장 최근 assistant 턴의 총 토큰(입력+출력+캐시). 진행 현황 표시용.
    pub token_usage: Option<u64>,
    /// 이 워크스페이스의 에이전트 종류(예: "claude"). 없으면 None.
    pub agent: Option<String>,
    /// 이 워크스페이스가 속한 herdr 세션 이름(명령 라우팅용). default 세션이면 "default".
    pub session: String,
}

/// AskUserQuestion 의 선택지 하나.
#[derive(Clone, Serialize)]
pub struct AskOption {
    /// 화면 표시 번호(1-base). 방향키 이동량 계산의 기준.
    pub number: u32,
    pub label: String,
    pub description: String,
    /// 옵션 미리보기(여러 줄 가능). 터미널 TUI 가 우측에 보여주는 내용.
    pub preview: String,
    /// (트랜스크립트 옵션은 모두 실제 옵션이라 항상 false. UI 호환용으로 유지.)
    pub is_builtin: bool,
}

/// 파싱된 AskUserQuestion.
#[derive(Clone, Serialize)]
pub struct AskQuestion {
    pub pane_id: String,
    /// 이 질문이 뜬 pane 의 herdr 세션 이름(focus 라우팅용).
    pub session: String,
    pub header: String,
    pub question: String,
    pub options: Vec<AskOption>,
    /// 질문이 막 뜬 시점의 기본 커서(항상 1번). 답변 시 이동량 계산에 쓴다.
    pub cursor: u32,
    pub multi_select: bool,
}

/// 트레이 팝오버에 잠깐 표시되는 알림 한 개(입력 대기 진입/작업 완료).
#[derive(Clone, Serialize)]
pub struct HerdrNotice {
    /// "blocked"(입력 대기) | "done"(작업 완료).
    pub kind: String,
    /// 사용자에게 보일 제목(워크스페이스 label).
    pub label: String,
    /// "이동" 시 라우팅에 쓰는 herdr 세션/워크스페이스.
    pub session: String,
    pub workspace_id: String,
    /// 목록 key·중복 방지용 고유 id.
    pub id: String,
}

/// 활성 알림 상태.
#[derive(Default)]
pub struct Notices {
    /// (알림, 만료시각). 만료 None = 영구 보관(완료 알림 — 트레이를 다시 열면 계속 보임).
    /// Some(t) = 그 시각에 사라짐(대기 알림 — 잠깐 뜨고 없어져도 됨).
    list: Mutex<Vec<(HerdrNotice, Option<std::time::Instant>)>>,
    /// 이 시각까지는 팝오버를 자동으로 띄운다(새 알림 도착 시 갱신). 이후엔 자동으로 열지 않는다
    /// (완료 알림이 영구 보관이어도 팝오버가 계속 강제로 열려 있지 않도록 분리).
    present_until: Mutex<Option<std::time::Instant>>,
}

/// 알림 팝오버 자동 표시 시간(도착 시 이만큼 떠 있다 자동으로 닫힘. 저장은 별개).
const NOTICE_TTL_MS: u64 = 7000;

/// watcher 실행 여부 플래그(중복 스레드 방지).
pub struct WatchState {
    running: Arc<AtomicBool>,
}

impl Default for WatchState {
    fn default() -> Self {
        WatchState {
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// 현재 대기 중인 질문(펫 말풍선이 표시). 펫 창이 마운트 시 이걸 조회하므로,
/// 이벤트를 놓쳐도(웹뷰 콜드 로드) 팝오버 내용이 채워진다.
/// 현재 대기 중인 질문들(pane 별). 여러 워크스페이스가 동시에 AskUserQuestion 을 띄울 수
/// 있으므로 리스트로 보관한다. 펫 창이 마운트 시 조회하고, 워처가 변경 시 갱신한다.
#[derive(Default)]
pub struct PendingQuestions(pub Mutex<Vec<AskQuestion>>);

/// 펫에게 "Claude Code 쪽에 알릴 게 있다/없다"를 전한다. 펫을 꺼 뒀으면 그동안만
/// 임시로 나타난다(pet.rs 의 PetAlert). 예전 팝오버와 달리 focus 를 뺏지 않는다 —
/// 응답이 필요한 질문도 사용자가 터미널에서 직접 답하므로 창을 앞으로 끌어올 이유가 없다.
fn set_pet_alert(app: &tauri::AppHandle, active: bool) {
    pet::set_alert(app, pet::AlertSource::Herdr, active);
}

/// 활성 알림 목록을 반환하고, 만료된 것(대기 알림)은 제거한다. 만료 None(완료 알림)은 유지.
fn prune_notices(app: &tauri::AppHandle) -> Vec<HerdrNotice> {
    let now = std::time::Instant::now();
    let Some(state) = app.try_state::<Notices>() else {
        return Vec::new();
    };
    let Ok(mut g) = state.list.lock() else {
        return Vec::new();
    };
    g.retain(|(_, exp)| exp.map_or(true, |t| t > now));
    g.iter().map(|(n, _)| n.clone()).collect()
}


// ─────────────────────────── 감시 백엔드 (herdr / cmux / orca) ───────────────────────────

/// 무엇을 보고 Claude Code 작업을 파악할지. **켠 것 여러 개를 동시에 본다.**
///
/// **지원하는 터미널은 herdr·cmux·orca 셋뿐이다.** 세션 목록은 (1) 어떤 터미널 pane 이 어떤
/// Claude 세션인지, (2) 그 세션이 지금 진행 중인지 대기 중인지를 터미널 쪽에서 받아야
/// 성립한다. 그걸 내주는 도구가 herdr(소켓 API), cmux(`~/.cmuxterm/events.jsonl` 의
/// `agent.hook.*` 이벤트), Orca(훅 상태 파일 + `orca terminal list`)뿐이다. 순수 터미널
/// 에뮬레이터(Ghostty·iTerm2·Terminal)는 pane↔세션 매핑도 진행 상태도 알려 주지 않으므로
/// 목록을 채울 수 없다.
///
/// 기본값은 **셋 다 켬**이다. 하나만 보면 반쪽만 보이기 때문이다: herdr 만 보면 다른 터미널에서
/// 바로 띄운 세션이 빠지고, cmux 만 보면 cmux 안에서 herdr 로 띄운 세션들이 **한 탭으로
/// 뭉친다**(같은 `CMUX_WORKSPACE_ID` 를 물려받으므로). 합칠 수 있는 근거는 모든 백엔드가
/// **같은 Claude `session_id`** 를 들고 있다는 것이다 — 그게 중복 제거의 키다(`dup_workspaces`).
/// 안 쓰는 백엔드의 비용은 사실상 0 이라(cmux 는 없는 파일, Orca 는 없는 데몬, herdr 는 실패하는
/// CLI 호출 한 번) 셋 다 켜 두는 것이 안전한 기본값이다.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Backends {
    pub herdr: bool,
    pub cmux: bool,
    pub orca: bool,
}

impl Backends {
    /// 하나도 안 켠 상태. 감시는 돌지만 목록이 항상 빈다(사용자가 명시적으로 고른 상태).
    fn none() -> Self {
        Self {
            herdr: false,
            cmux: false,
            orca: false,
        }
    }
}

/// 백엔드 캐시. `UNSET` 이면 아직 파일을 안 읽은 상태(비트 조합과 겹치지 않는 값이어야 한다).
const BACKEND_UNSET: u8 = u8::MAX;
const BIT_HERDR: u8 = 1;
const BIT_CMUX: u8 = 2;
const BIT_ORCA: u8 = 4;
static BACKEND: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(BACKEND_UNSET);

/// 저장/캐시용 비트 조합.
fn backend_code(b: Backends) -> u8 {
    (if b.herdr { BIT_HERDR } else { 0 })
        | (if b.cmux { BIT_CMUX } else { 0 })
        | (if b.orca { BIT_ORCA } else { 0 })
}

fn backend_from_code(code: u8) -> Backends {
    Backends {
        herdr: code & BIT_HERDR != 0,
        cmux: code & BIT_CMUX != 0,
        orca: code & BIT_ORCA != 0,
    }
}

/// 설정 문자열 → 백엔드 집합. 형식은 쉼표로 이은 이름(`"herdr,orca"`).
///
/// 예전 단일 선택 값도 그대로 받는다. `"both"` 는 **"그때 있던 전부"**(herdr+cmux)였고 기본값
/// 이기도 했으므로 셋 다 켠 것으로 옮긴다 — `"cmux"` 처럼 하나만 콕 집어 고른 사람의 선택은
/// 그대로 두되, 기본값을 쓰던 사람이 Orca 만 빠진 채로 남는 일은 막는다.
fn backend_from_str(s: &str) -> Backends {
    if s.trim() == "both" {
        return Backends {
            herdr: true,
            cmux: true,
            orca: true,
        };
    }
    let mut b = Backends::none();
    for name in s.split(',') {
        match name.trim() {
            "herdr" => b.herdr = true,
            "cmux" => b.cmux = true,
            "orca" => b.orca = true,
            _ => {}
        }
    }
    b
}

/// 백엔드 집합 → 설정 문자열.
fn backend_to_str(b: Backends) -> String {
    let mut names = Vec::new();
    if b.herdr {
        names.push("herdr");
    }
    if b.cmux {
        names.push("cmux");
    }
    if b.orca {
        names.push("orca");
    }
    if names.is_empty() {
        // 빈 문자열로 쓰면 "파일이 비었다 = 저장한 적 없다"와 구분되지 않아, 다음 실행에서
        // 기본값(셋 다 켬)으로 되살아난다. 전부 끈 것도 선택이므로 이름을 붙여 남긴다.
        return "none".to_string();
    }
    names.join(",")
}

/// 선택한 백엔드를 담아 두는 파일. 설정(localStorage)은 Rust 가 읽을 수 없고, 감시 루프는
/// 창이 열리기 전(로그인 자동 시작)부터 돌아야 하므로 `watch-disabled` 와 같은 방식으로
/// 파일에 남긴다.
fn backend_file() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(format!("{h}/.myspace/backend")))
}

/// 현재 백엔드 집합.
///
/// 저장된 값이 **아예 없으면** 셋 다 켠 상태로 시작한다 — 설정의 기본값과 같아야 하기 때문이다.
/// 로그인 자동 시작에서는 감시 루프가 창(=설정)보다 먼저 도는데, 여기서 herdr 만 켜면
/// 프런트가 뜰 때까지 다른 터미널의 세션이 빠진 목록을 방출한다.
pub fn backend() -> Backends {
    let code = BACKEND.load(Ordering::Relaxed);
    if code != BACKEND_UNSET {
        return backend_from_code(code);
    }
    let saved = backend_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let b = if saved.is_empty() {
        Backends {
            herdr: true,
            cmux: true,
            orca: true,
        }
    } else {
        backend_from_str(&saved)
    };
    BACKEND.store(backend_code(b), Ordering::Relaxed);
    b
}

/// 백엔드(와 cmux 소켓 비밀번호)를 설정한다. 설정 화면에서 바꾸는 즉시 호출된다.
/// 감시 루프는 매 폴링마다 `backend()` 를 보므로 재시작 없이 다음 틱부터 새 백엔드를 읽는다.
#[tauri::command]
pub fn herdr_set_backend(backend: String, password: Option<String>) {
    let b = backend_from_str(&backend);
    BACKEND.store(backend_code(b), Ordering::Relaxed);
    if let Some(path) = backend_file() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, backend_to_str(b));
    }
    // 비밀번호는 cmux 쪽이 파일로 들고 있는다(액션에서만 필요).
    if let Some(pw) = password {
        crate::cmux::set_socket_password(&pw);
    }
    log::info!("claude watch backend = {b:?}");
}

/// herdr 실행 파일 경로. Finder 실행 앱은 PATH 에 ~/.local/bin 이 없을 수 있어 직접 확인.
fn herdr_bin() -> String {
    if let Ok(b) = std::env::var("HERDR_BIN") {
        return b;
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = format!("{home}/.local/bin/herdr");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "herdr".into()
}

/// herdr 가 **없는** 상태(미설치 또는 데몬 미실행)를 뜻하는 오류 메시지의 접두사.
/// herdr 는 셋 다 켜 두는 게 기본값인 선택 백엔드라 이건 고장이 아니라 정상 상태다 —
/// `is_absent` 로 구분해 로그 레벨을 낮추는 데 쓴다.
const ABSENT: &str = "herdr 없음";

/// `run_herdr` 오류가 "herdr 가 없어서"인지. 문구가 아니라 `ABSENT` 접두사로 판단한다.
fn is_absent(err: &str) -> bool {
    err.starts_with(ABSENT)
}

/// 목록 조회 실패 로그. herdr 부재는 경고가 아니므로 debug 로 남긴다 —
/// 감시 루프가 800ms 마다 도는 탓에, warn 으로 남기면 herdr 를 안 쓰는 사람의 로그가
/// 시작 직후부터 ConnectionRefused 로 덮인다.
fn log_list_err(what: &str, err: &str) {
    if is_absent(err) {
        log::debug!("{what}: {err}");
    } else {
        log::warn!("{what}: {err}");
    }
}

/// herdr CLI 를 호출하고 stdout 을 JSON 으로 파싱한다.
/// session 을 주면 `--session <name>` 전역 플래그를 서브커맨드 앞에 붙여 해당 세션 소켓을 대상으로 한다.
fn run_herdr(session: Option<&str>, args: &[&str]) -> Result<Value, String> {
    let mut full: Vec<&str> = Vec::new();
    if let Some(s) = session {
        full.push("--session");
        full.push(s);
    }
    full.extend_from_slice(args);
    let out = Command::new(herdr_bin())
        .args(&full)
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!("{ABSENT}(실행 파일 미설치)"),
            _ => format!("herdr 실행 실패: {e}"),
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // 소켓 connection refused = herdr 데몬이 안 떠 있음. 응답이 없는 다른 이유들과
        // 섞으면 "정상 상태"와 "진짜 오류"를 로그에서 구분할 수 없다.
        if stderr.contains("ConnectionRefused") || stderr.contains("Connection refused") {
            return Err(format!("{ABSENT}(데몬 미실행)"));
        }
        return Err(format!("herdr 응답 없음: {stderr}"));
    }
    serde_json::from_str::<Value>(&stdout).map_err(|e| format!("herdr JSON 파싱 실패: {e}"))
}

/// running 상태인 herdr 세션 이름들. 사용자가 `herdr --session <name>` 으로 여러 세션을 띄우면
/// 각각 별도 소켓을 쓰므로, 목록/명령을 세션마다 반복해 합쳐야 전체가 보인다.
///
/// **하나도 안 돌면 빈 목록**을 낸다 — 예전에는 빈 결과를 `["default"]` 로 채웠는데, 그러면
/// 감시 루프가 800ms 마다 죽은 소켓을 찔러 ConnectionRefused 경고를 로그에 쏟아부었다.
/// `session list` 는 소켓 파일만 보므로 **데몬 없이도 동작**하고(rc 0, `running: false`),
/// 따라서 이 판단은 실패하는 호출 없이 끝난다.
///
/// `sessions` 배열을 못 얻은 경우에만 `["default"]` 로 폴백한다 — `session list --json` 이
/// 없는 옛 herdr 도 계속 동작해야 하므로, "조회 실패"와 "세션이 없음"은 구분해야 한다.
fn running_sessions() -> Vec<String> {
    sessions_from(run_herdr(None, &["session", "list", "--json"]).ok().as_ref())
}

/// `herdr session list --json` 응답 → 조회할 세션 이름들. 위 규칙의 순수 함수 부분.
fn sessions_from(listed: Option<&Value>) -> Vec<String> {
    let Some(arr) = listed.and_then(|v| v.get("sessions")).and_then(|s| s.as_array()) else {
        return vec!["default".into()];
    };
    arr.iter()
        .filter(|s| s.get("running").and_then(|r| r.as_bool()).unwrap_or(false))
        .filter_map(|s| s.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect()
}

/// 한 herdr 세션의 agent 목록.
fn list_agents_in(session: &str) -> Result<Vec<HerdrAgent>, String> {
    let v = run_herdr(Some(session), &["agent", "list"])?;
    let arr = v
        .pointer("/result/agents")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    let agents = arr
        .iter()
        .filter_map(|a| {
            let pane_id = a.get("pane_id")?.as_str()?.to_string();
            Some(HerdrAgent {
                pane_id,
                agent: a.get("agent").and_then(|x| x.as_str()).map(String::from),
                agent_status: a
                    .get("agent_status")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                cwd: a.get("cwd").and_then(|x| x.as_str()).map(String::from),
                session_id: a
                    .pointer("/agent_session/value")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                session: session.to_string(),
            })
        })
        .collect();
    Ok(agents)
}

/// 실행 중인 모든 herdr 세션의 agent 를 합쳐 반환한다(세션 하나가 실패해도 나머지는 유지).
fn list_agents_herdr() -> Result<Vec<HerdrAgent>, String> {
    let mut out = Vec::new();
    for session in running_sessions() {
        match list_agents_in(&session) {
            Ok(mut a) => out.append(&mut a),
            Err(e) => log_list_err(&format!("herdr agent list 실패 (session={session})"), &e),
        }
    }
    Ok(out)
}

/// pane_id 에서 그 pane 이 속한 워크스페이스를 뽑는 규칙. 백엔드마다 pane_id 를 만드는
/// 방식이 달라(`cmux::pane_ref` 는 앞이, `orca::pane_ref` 는 뒤가 pane) 함수로 받는다.
type WsOfPane = fn(&str) -> String;

/// cmux pane_id 는 `"<워크스페이스>:<surface>"` 형식이라 앞 조각이 워크스페이스다.
fn cmux_ws_of(pane_id: &str) -> String {
    pane_id.split(':').next().unwrap_or(pane_id).to_string()
}

/// 여러 백엔드를 함께 볼 때 버려야 할 워크스페이스를 고른다(herdr 를 남긴다).
///
/// **다른 터미널 안에서 herdr 를 띄운 탭**이 그 대상이다. 그런 탭은 그 터미널의 훅이 세션을
/// 기록하기는 하지만(cmux 는 `CMUX_WORKSPACE_ID`, Orca 는 pane 훅을 물려받으므로) herdr 세션
/// 여러 개가 한 탭으로 뭉쳐 보이고 이동도 탭 단위까지만 된다 — 같은 세션을 herdr 쪽 카드가 더
/// 정확하게 보여 주므로 그쪽을 버린다. 판단 근거는 **herdr 에도 있는 `session_id`** 다.
///
/// 세션 단위가 아니라 워크스페이스 단위로 버리는 이유: 세션만 걸러 내면 그 세션이 속한
/// 워크스페이스 카드는 남아서 "빈 카드"가 되거나 다른 세션의 상태를 대표로 보여 준다.
/// agent 목록과 워크스페이스 목록이 같은 기준으로 잘려야 둘이 어긋나지 않는다.
fn dup_workspaces(
    kept: &[HerdrAgent],
    incoming: &[HerdrAgent],
    ws_of: WsOfPane,
) -> HashSet<String> {
    let kept_sids: HashSet<&str> = kept
        .iter()
        .filter_map(|a| a.session_id.as_deref())
        .collect();
    incoming
        .iter()
        .filter(|a| {
            a.session_id
                .as_deref()
                .is_some_and(|s| kept_sids.contains(s))
        })
        .map(|a| ws_of(&a.pane_id))
        .collect()
}

/// 켜 둔 백엔드 전부에서 agent 목록을 읽어 합친다(호출부는 어느 백엔드인지 알 필요가 없다).
///
/// 한쪽이 실패해도 다른 쪽을 그대로 낸다 — herdr 를 안 쓰는 사람이 셋 다 켜 두어도 나머지
/// 목록은 나와야 한다(그 반대도 마찬가지).
fn list_agents() -> Result<Vec<HerdrAgent>, String> {
    let b = backend();
    // herdr 하나만 켠 흔한 경우는 합치기·중복 제거를 통째로 건너뛴다.
    if b.herdr && !b.cmux && !b.orca {
        return list_agents_herdr();
    }
    let mut out = if b.herdr {
        list_agents_herdr().unwrap_or_else(|e| {
            log_list_err("herdr agent 목록 실패", &e);
            Vec::new()
        })
    } else {
        Vec::new()
    };
    for (on, name, load, ws_of) in other_backends(b) {
        if !on {
            continue;
        }
        let rows = load().unwrap_or_else(|e| {
            log::warn!("{name} agent 목록 실패: {e}");
            Vec::new()
        });
        let dup = dup_workspaces(&out, &rows, ws_of);
        out.extend(rows.into_iter().filter(|a| !dup.contains(&ws_of(&a.pane_id))));
    }
    Ok(out)
}

/// herdr 가 아닌 백엔드들을 (켜짐, 이름, agent 로더, pane→워크스페이스 규칙)로 나열한다.
/// 목록 두 곳(agent·워크스페이스)이 **같은 순서와 같은 규칙**으로 돌아야 둘이 어긋나지 않는다.
fn other_backends(
    b: Backends,
) -> [(bool, &'static str, fn() -> Result<Vec<HerdrAgent>, String>, WsOfPane); 2] {
    [
        (b.cmux, "cmux", crate::cmux::list_agents, cmux_ws_of),
        (b.orca, "orca", crate::orca::list_agents, crate::orca::workspace_of),
    ]
}

/// `~/.claude/projects` 경로.
fn claude_projects_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let p = PathBuf::from(home).join(".claude").join("projects");
    p.exists().then_some(p)
}

/// 세션 ID(=파일명)로 트랜스크립트 파일을 찾는다(모든 프로젝트 폴더 검색).
fn find_transcript(session_id: &str) -> Option<PathBuf> {
    let base = claude_projects_dir()?;
    let file = format!("{session_id}.jsonl");
    for entry in std::fs::read_dir(&base).ok()? {
        let dir = entry.ok()?.path();
        if dir.is_dir() && dir.join(&file).exists() {
            return Some(dir.join(&file));
        }
    }
    None
}

/// 파일 끝부분만 읽는다(큰 파일 대비). UTF-8 경계는 lossy 처리.
/// cmux 백엔드도 이벤트 로그를 같은 방식으로 훑는다.
pub(crate) fn read_tail(path: &std::path::Path, max: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(max)));
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// s 에서 start..end 사이의 부분문자열(태그 제외).
fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let i = s.find(start)? + start.len();
    let j = s[i..].find(end)? + i;
    Some(&s[i..j])
}

/// start_tag..end_tag 블록(태그 포함)을 모두 제거.
fn remove_block(s: &str, start_tag: &str, end_tag: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        match rest.find(start_tag) {
            Some(i) => {
                out.push_str(&rest[..i]);
                match rest[i..].find(end_tag) {
                    Some(j) => rest = &rest[i + j + end_tag.len()..],
                    None => return out, // 닫는 태그 없으면 이후 전부 제거
                }
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// `<local-command-XXX> … </local-command-XXX>` 블록 제거(접미사 가변).
fn remove_local_command(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        match rest.find("<local-command-") {
            Some(i) => {
                out.push_str(&rest[..i]);
                match rest[i..].find("</local-command-") {
                    Some(j) => {
                        let after = &rest[i + j..];
                        match after.find('>') {
                            Some(k) => rest = &after[k + 1..],
                            None => return out,
                        }
                    }
                    None => return out,
                }
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// 모든 `<…>` 태그 제거.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

/// 사용자 입력 텍스트만 남긴다: 슬래시 명령 변환, 하네스 주입 블록(task-notification /
/// system-reminder / local-command) 제거, 잔여 태그 제거, 공백 정규화.
/// (참고: cowork-statusline.js 의 cleanPromptText 와 동일 규칙)
fn clean_prompt_text(raw: &str) -> String {
    // 슬래시 명령: "<command-name>/x</command-name><command-args>y</command-args>" → "/x y"
    if let Some(name) = between(raw, "<command-name>", "</command-name>") {
        let args = between(raw, "<command-args>", "</command-args>")
            .unwrap_or("")
            .trim();
        let name = name.trim();
        return if args.is_empty() {
            name.to_string()
        } else {
            format!("{name} {args}")
        };
    }
    let s = remove_block(raw, "<task-notification>", "</task-notification>");
    let s = remove_block(&s, "<system-reminder>", "</system-reminder>");
    let s = remove_local_command(&s);
    let s = strip_tags(&s);
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 트랜스크립트 한 엔트리에서 "사용자가 실제 입력한 프롬프트"를 뽑는다. 아니면 빈 문자열.
/// 주입 메타(isMeta)·도구 결과(tool_result)·시스템 알림은 제외한다.
fn extract_user_prompt(entry: &Value) -> String {
    if entry.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false) {
        return String::new();
    }
    if entry.pointer("/message/role").and_then(|x| x.as_str()) != Some("user") {
        return String::new();
    }
    let content = entry.pointer("/message/content");
    if let Some(s) = content.and_then(|c| c.as_str()) {
        return clean_prompt_text(s);
    }
    if let Some(arr) = content.and_then(|c| c.as_array()) {
        // text 블록만 사용(tool_result 만 있는 엔트리는 프롬프트 아님).
        let joined: String = arr
            .iter()
            .filter_map(|b| {
                (b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .then(|| b.get("text").and_then(|x| x.as_str()))
                    .flatten()
            })
            .collect::<Vec<_>>()
            .join(" ");
        if !joined.is_empty() {
            return clean_prompt_text(&joined);
        }
    }
    String::new()
}

/// recap(away_summary) content 에서 사용자에게 보일 부분만 남긴다(끝의 "(disable recaps ...)" 안내 제거).
fn clean_recap(s: &str) -> String {
    let body = match s.find("(disable recaps") {
        Some(i) => &s[..i],
        None => s,
    };
    body.trim().to_string()
}

/// 세션 트랜스크립트에서 한 번의 스캔으로 뽑아낸 정보.
///
/// 백엔드(herdr / cmux)와 무관하게 **여기서 나온 값만** 화면에 쓰인다 — 두 백엔드가
/// 주는 것은 "어떤 pane 이 어떤 Claude 세션인지"와 진행 상태뿐이다.
#[derive(Default)]
pub(crate) struct SessionInfo {
    /// 마지막 사용자 프롬프트(정리 후 비어있는 도구 결과·알림 엔트리는 건너뜀).
    pub(crate) last_prompt: Option<String>,
    /// 그 프롬프트 엔트리의 timestamp(ISO8601).
    pub(crate) last_prompt_at: Option<String>,
    /// 마지막 recap(away_summary) content.
    pub(crate) recap: Option<String>,
    /// 가장 최근 assistant 턴의 총 토큰(입력+출력+캐시). 진행 현황 표시용.
    pub(crate) tokens: Option<u64>,
}

/// 세션 트랜스크립트에서 마지막 프롬프트/시각/recap/토큰을 한 번의 역순 스캔으로 뽑는다.
/// 각각 "가장 최근" 것을 취한다(파일 끝에서부터).
pub(crate) fn read_session_info(session_id: &str) -> SessionInfo {
    let mut info = SessionInfo::default();
    let Some(path) = find_transcript(session_id) else {
        return info;
    };
    let Some(len) = std::fs::metadata(&path).ok().map(|m| m.len()) else {
        return info;
    };
    // 끝부분 256KB 만 먼저 훑고, 아무것도 못 찾으면 파일 전체로 확대(긴 세션 대비).
    let windows: &[u64] = if len > 256 * 1024 {
        &[256 * 1024, u64::MAX]
    } else {
        &[u64::MAX]
    };
    for &max in windows {
        let Some(text) = read_tail(&path, max) else {
            continue;
        };
        let (mut prompt, mut prompt_at, mut recap, mut tokens) = (None, None, None, None);
        for line in text.lines().rev() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if recap.is_none()
                && v.get("type").and_then(|x| x.as_str()) == Some("system")
                && v.get("subtype").and_then(|x| x.as_str()) == Some("away_summary")
            {
                if let Some(c) = v.get("content").and_then(|x| x.as_str()) {
                    let c = clean_recap(c);
                    if !c.is_empty() {
                        recap = Some(c);
                    }
                }
            }
            // 가장 최근 assistant 턴의 usage 합계(입력+출력+캐시).
            if tokens.is_none()
                && v.pointer("/message/role").and_then(|x| x.as_str()) == Some("assistant")
            {
                if let Some(u) = v.pointer("/message/usage") {
                    let get = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    let total = get("input_tokens")
                        + get("output_tokens")
                        + get("cache_read_input_tokens")
                        + get("cache_creation_input_tokens");
                    if total > 0 {
                        tokens = Some(total);
                    }
                }
            }
            if prompt.is_none() {
                let p = extract_user_prompt(&v);
                if !p.is_empty() {
                    prompt_at = v.get("timestamp").and_then(|x| x.as_str()).map(String::from);
                    prompt = Some(p);
                }
            }
            if prompt.is_some() && recap.is_some() && tokens.is_some() {
                break;
            }
        }
        // 이 창에서 찾은 값으로 갱신(더 큰 창으로 확대해도 recap/tokens 는 함께 갱신됨).
        info = SessionInfo {
            last_prompt: prompt,
            last_prompt_at: prompt_at,
            recap,
            tokens,
        };
        // 프롬프트를 찾았으면 충분하다. 못 찾았고 더 큰 창이 남아 있으면 계속 확대해서 찾는다
        // (긴 세션은 마지막 프롬프트가 256KB tail 밖일 수 있음 — tokens 만 찾고 멈추면 안 됨).
        if info.last_prompt.is_some() {
            break;
        }
    }
    info
}

/// 한 herdr 세션의 워크스페이스 목록.
fn list_workspaces_in(session: &str) -> Result<Vec<HerdrWorkspace>, String> {
    let v = run_herdr(Some(session), &["workspace", "list"])?;
    let arr = v
        .pointer("/result/workspaces")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    // workspace_id → session_id 매핑(같은 세션 agent 목록에서). pane_id 는 "<ws>:p.." 형식.
    // 세션마다 pane_id/workspace_id 가 겹칠 수 있어 반드시 세션-로컬 agent 목록으로만 매칭한다.
    let agents = list_agents_in(session).unwrap_or_default();
    let workspaces = arr
        .iter()
        .filter_map(|w| {
            let workspace_id = w.get("workspace_id")?.as_str()?.to_string();
            let matched = agents
                .iter()
                .find(|a| a.pane_id.starts_with(&format!("{workspace_id}:")));
            let session_id = matched.and_then(|a| a.session_id.clone());
            let agent = matched.and_then(|a| a.agent.clone());
            let info = match session_id.as_deref() {
                Some(sid) => read_session_info(sid),
                None => SessionInfo::default(),
            };
            Some(HerdrWorkspace {
                workspace_id,
                label: w.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                agent_status: w
                    .get("agent_status")
                    .and_then(|x| x.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                focused: w.get("focused").and_then(|x| x.as_bool()).unwrap_or(false),
                pane_count: w.get("pane_count").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                last_prompt: info.last_prompt,
                last_prompt_at: info.last_prompt_at,
                recap: info.recap,
                token_usage: info.tokens,
                agent,
                session: session.to_string(),
            })
        })
        .collect();
    Ok(workspaces)
}

/// 실행 중인 모든 herdr 세션의 워크스페이스를 합쳐 반환한다(세션 하나가 실패해도 나머지는 유지).
fn list_workspaces_herdr() -> Result<Vec<HerdrWorkspace>, String> {
    let mut out = Vec::new();
    for session in running_sessions() {
        match list_workspaces_in(&session) {
            Ok(mut w) => out.append(&mut w),
            Err(e) => log_list_err(&format!("herdr workspace list 실패 (session={session})"), &e),
        }
    }
    Ok(out)
}

/// 켜 둔 백엔드 전부에서 워크스페이스 목록을 읽어 합친다. 중복 규칙은 `dup_workspaces` 참고
/// (같은 Claude 세션이 두 백엔드에 잡히면 herdr 쪽을 남긴다).
fn list_workspaces() -> Result<Vec<HerdrWorkspace>, String> {
    let b = backend();
    if b.herdr && !b.cmux && !b.orca {
        return list_workspaces_herdr();
    }
    let mut out = if b.herdr {
        list_workspaces_herdr().unwrap_or_else(|e| {
            log_list_err("herdr 워크스페이스 목록 실패", &e);
            Vec::new()
        })
    } else {
        Vec::new()
    };
    // 중복 판단은 agent 의 session_id 로만 할 수 있으므로 agent 목록을 함께 읽는다.
    // `list_agents` 와 **같은 순서·같은 규칙**으로 돌아야 두 목록이 어긋나지 않는다.
    let mut kept_agents = if b.herdr {
        list_agents_herdr().unwrap_or_default()
    } else {
        Vec::new()
    };
    let loaders: [(bool, &str, fn() -> Result<Vec<HerdrWorkspace>, String>); 2] = [
        (b.cmux, "cmux", crate::cmux::list_workspaces),
        (b.orca, "orca", crate::orca::list_workspaces),
    ];
    for ((on, name, load_ws), (_, _, load_agents, ws_of)) in
        loaders.into_iter().zip(other_backends(b))
    {
        if !on {
            continue;
        }
        let rows = load_ws().unwrap_or_else(|e| {
            log::warn!("{name} 워크스페이스 목록 실패: {e}");
            Vec::new()
        });
        let incoming = load_agents().unwrap_or_default();
        let dup = dup_workspaces(&kept_agents, &incoming, ws_of);
        if !dup.is_empty() {
            log::debug!("herdr 와 겹치는 {name} 워크스페이스 {} 개 제외", dup.len());
        }
        out.extend(rows.into_iter().filter(|w| !dup.contains(&w.workspace_id)));
        kept_agents.extend(incoming.into_iter().filter(|a| !dup.contains(&ws_of(&a.pane_id))));
    }
    Ok(out)
}

/// pane 텍스트(ANSI 제거)를 herdr 소켓으로 읽는다. source: "recent"(스크롤백 포함) | "visible"(현재 화면만).
fn read_pane_text_src(session: &str, pane_id: &str, lines: u32, source: &str) -> Result<String, String> {
    let n = lines.to_string();
    let v = run_herdr(Some(session), &["agent", "read", pane_id, "--source", source, "--lines", &n])?;
    Ok(v.pointer("/result/read/text")
        .or_else(|| v.pointer("/result/text"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
}

/// 이 동작(이동·전송·읽기)을 어느 백엔드로 보낼지.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Route {
    Herdr,
    Cmux,
    Orca,
}

/// 동작을 **세션 이름으로** 가른다 — cmux·Orca 백엔드가 만든 항목은 세션이 늘 고정 문자열
/// (`"cmux"` / `"orca"`)이기 때문이다. 목록을 만든 백엔드가 그대로 동작도 받으므로, 한 화면에
/// 여러 터미널의 작업이 섞여 있어도 각 카드의 이동·전송이 제 짝으로 간다.
/// (`herdr --session cmux` 처럼 herdr 세션 이름을 그 값으로 준 경우만 어긋나는데, 그건 감수한다.)
///
/// 백엔드가 하나만 켜져 있으면 세션 이름과 무관하게 그쪽으로 보낸다 — 예전 형식으로 저장된
/// 항목이나 이름이 빈 항목도 동작해야 하기 때문이다.
fn route_of(session: &str) -> Route {
    let b = backend();
    match (b.herdr, b.cmux, b.orca) {
        (true, false, false) => Route::Herdr,
        (false, true, false) => Route::Cmux,
        (false, false, true) => Route::Orca,
        _ if session == crate::cmux::SESSION => Route::Cmux,
        _ if session == crate::orca::SESSION => Route::Orca,
        _ => Route::Herdr,
    }
}

/// 기본 read(스크롤백 포함 recent). 질문 파싱·수동 로그용.
/// cmux·Orca 는 멀티플렉서 세션 개념이 없어 `session` 을 라우팅에만 쓰고 pane 만 본다.
fn read_pane_text(session: &str, pane_id: &str, lines: u32) -> Result<String, String> {
    match route_of(session) {
        Route::Cmux => crate::cmux::read_pane(pane_id, lines),
        Route::Orca => crate::orca::read_pane(pane_id, lines),
        Route::Herdr => read_pane_text_src(session, pane_id, lines, "recent"),
    }
}

/// preview 박스를 그리는 데 쓰이는 문자들(라벨에서 잘라내기 위함).
const BOX_CHARS: &str = "│┃┆┇┊┋┌┐└┘├┤┬┴┼─━╭╮╯╰╱╲╳✂";

/// 수평 구분선인가?
fn is_rule(line: &str) -> bool {
    let t = line.trim();
    t.chars().count() >= 10 && t.chars().all(|c| matches!(c, '─' | '—' | '-'))
}

/// 옵션 라벨 정리: 오른쪽 preview 박스(박스문자) 또는 2칸 이상 공백에서 잘라낸다.
fn clean_label(s: &str) -> String {
    let s = s.trim();
    let s = s.split(|c| BOX_CHARS.contains(c)).next().unwrap_or(s);
    let s = match s.find("  ") {
        Some(i) => &s[..i],
        None => s,
    };
    s.trim().to_string()
}

/// 설명·질문 정리: 박스문자에서만 잘라낸다(내부 공백은 유지).
fn clean_desc(s: &str) -> String {
    s.split(|c| BOX_CHARS.contains(c))
        .next()
        .unwrap_or(s)
        .trim()
        .to_string()
}

/// "❯ 1. label" / "  2. label" 옵션 줄 파싱. 반환: (커서 여부, 번호, label).
fn parse_option_line(line: &str) -> Option<(bool, u32, String)> {
    let mut s = line.trim_start();
    let cursor = s.starts_with('❯');
    if cursor {
        s = s.trim_start_matches('❯').trim_start();
    }
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let rest = s[digits.len()..].strip_prefix('.')?;
    let number: u32 = digits.parse().ok()?;
    let label = clean_label(rest);
    if label.is_empty() {
        return None;
    }
    Some((cursor, number, label))
}

/// pane 터미널 화면에서 AskUserQuestion 을 파싱한다(preview 박스 레이아웃 대응).
fn parse_terminal_question(pane_id: &str, text: &str) -> Option<AskQuestion> {
    let lines: Vec<&str> = text.lines().collect();

    // 선택 폼 footer.
    let footer_idx = lines.iter().rposition(|l| {
        let low = l.to_lowercase();
        low.contains("to select") && (low.contains("navigate") || low.contains("cancel"))
    })?;
    // 현재 폼만 보도록 상단 경계를 footer 위 가장 가까운 ☐ 헤더로.
    let header_idx = lines[..footer_idx]
        .iter()
        .rposition(|l| l.contains('☐') || l.contains('☑'));
    let start = header_idx.unwrap_or_else(|| footer_idx.saturating_sub(60));
    let window = &lines[start..footer_idx];

    // 다른 종류의 blocked 폼 배제.
    let joined = window.join("\n").to_lowercase();
    const DENY: [&str; 4] = [
        "do you want to proceed",
        "select model",
        "switch model",
        "run a dynamic workflow",
    ];
    if DENY.iter().any(|d| joined.contains(d)) {
        return None;
    }

    // 옵션 수집 + 커서.
    let mut options: Vec<AskOption> = Vec::new();
    let mut cursor = 1u32;
    let mut first_opt: Option<usize> = None;
    for (i, line) in window.iter().enumerate() {
        if let Some((is_cursor, number, label)) = parse_option_line(line) {
            if first_opt.is_none() {
                first_opt = Some(i);
            }
            if is_cursor {
                cursor = number;
            }
            // 다음 줄이 설명이면 취한다(preview 모드에선 설명이 없어 비어 있음).
            let mut description = String::new();
            if let Some(next) = window.get(i + 1) {
                let nt = next.trim();
                if !nt.is_empty()
                    && !is_rule(next)
                    && parse_option_line(next).is_none()
                    && !nt.starts_with(|c| BOX_CHARS.contains(c))
                    && !nt.contains('☐')
                {
                    description = clean_desc(next);
                }
            }
            options.push(AskOption {
                number,
                label,
                description,
                preview: String::new(),
                is_builtin: false,
            });
        }
    }
    if options.is_empty() {
        return None;
    }

    let header = window
        .iter()
        .find(|l| l.contains('☐') || l.contains('☑'))
        .map(|l| clean_label(&l.replace('☐', "").replace('☑', "")))
        .unwrap_or_default();

    let mut question = String::new();
    if let Some(fo) = first_opt {
        for l in window[..fo].iter().rev() {
            let t = l.trim();
            if t.is_empty() || is_rule(l) || t.contains('☐') || t.contains('☑') {
                continue;
            }
            question = clean_desc(l);
            break;
        }
    }

    let multi_select = lines[footer_idx].to_lowercase().contains("space");
    Some(AskQuestion {
        pane_id: pane_id.to_string(),
        session: String::new(), // read_question 에서 채운다.
        header,
        question,
        options,
        cursor,
        multi_select,
    })
}

/// pane 을 읽어 대기 중 AskUserQuestion 을 파싱한다(터미널 화면 기반).
fn read_terminal_question(session: &str, pane_id: &str) -> Option<AskQuestion> {
    let text = read_pane_text(session, pane_id, 80).ok()?;
    parse_terminal_question(pane_id, &text)
}

// ── 후크(PreToolUse) 파일 기반 구조화 JSON 읽기 ──
// AskUserQuestion 후크가 도구 실행 직전에 tool_input 을 ~/.myspace/ask/<session>.json 에
// 기록한다(trascript flush 지연 회피). 이게 있으면 preview 까지 정확한 데이터를 얻는다.

/// tool_use 입력에서 questions 배열을 꺼낸다.
/// 정상: `input.questions`. 파싱 실패했던 호출: `input.__unparsedToolInput.raw`(문자열)를
/// 다시 JSON 으로 파싱해 복구한다.
fn extract_questions(input: &Value) -> Option<Value> {
    if let Some(q) = input.get("questions") {
        return Some(q.clone());
    }
    let raw = input
        .pointer("/__unparsedToolInput/raw")
        .and_then(|x| x.as_str())?;
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("questions").cloned())
}

/// tool_input(JSON)의 questions[0] 로 AskQuestion 을 만든다(다중 질문 중 첫 번째만).
fn build_question(pane_id: &str, input: &Value) -> Option<AskQuestion> {
    let questions = extract_questions(input)?;
    let q0 = questions.get(0)?;
    let mut options = Vec::new();
    if let Some(opts) = q0.get("options").and_then(|x| x.as_array()) {
        for (i, o) in opts.iter().enumerate() {
            options.push(AskOption {
                number: (i as u32) + 1,
                label: o.get("label").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                description: o
                    .get("description")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                preview: o.get("preview").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                is_builtin: false,
            });
        }
    }
    if options.is_empty() {
        return None;
    }
    Some(AskQuestion {
        pane_id: pane_id.to_string(),
        session: String::new(), // read_question 에서 채운다.
        header: q0.get("header").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        question: q0.get("question").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        options,
        cursor: 1,
        multi_select: q0.get("multiSelect").and_then(|x| x.as_bool()).unwrap_or(false),
    })
}

/// 후크가 남긴 `~/.myspace/ask/<session_id>.json` 에서 질문을 읽는다.
fn read_hook_question(session_id: &str, pane_id: &str) -> Option<AskQuestion> {
    let home = std::env::var("HOME").ok()?;
    let path = format!("{home}/.myspace/ask/{session_id}.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let v: Value = serde_json::from_str(&content).ok()?;
    build_question(pane_id, v.get("tool_input")?)
}

/// 후크가 기록한 질문 파일(`~/.myspace/ask/<sid>.json`)이 있는지. 후크 blocking 중엔
/// herdr 가 pane 을 아직 "blocked" 로 안 볼 수 있어(픽커 미표시), 이 파일 존재도 트리거로 쓴다.
fn ask_file_exists(sid: &str) -> bool {
    std::env::var("HOME")
        .map(|h| std::path::Path::new(&format!("{h}/.myspace/ask/{sid}.json")).exists())
        .unwrap_or(false)
}

/// 대기 중 질문을 읽는다. 후크 파일(정확한 JSON) 우선, 없으면 터미널 화면 파싱으로 폴백.
fn read_question(session: &str, session_id: Option<&str>, pane_id: &str) -> Option<AskQuestion> {
    let mut q = session_id
        .and_then(|sid| read_hook_question(sid, pane_id))
        .or_else(|| read_terminal_question(session, pane_id))?;
    // focus 라우팅에 쓰도록 herdr 세션 이름을 채운다.
    q.session = session.to_string();
    Some(q)
}


// ─────────────────────────── Tauri 커맨드 ───────────────────────────

/// 실행 중인 herdr agent 목록을 반환한다.
#[tauri::command]
pub fn herdr_list_agents() -> Result<Vec<HerdrAgent>, String> {
    list_agents()
}

/// 워크스페이스 목록(작업 진행 현황: label + 상태)을 반환한다.
#[tauri::command]
pub fn herdr_list_workspaces() -> Result<Vec<HerdrWorkspace>, String> {
    list_workspaces()
}

/// 해당 워크스페이스로 herdr 를 이동(focus)하고 터미널 창을 앞으로 가져온다.
#[tauri::command]
pub fn herdr_focus_workspace(session: String, workspace_id: String) -> Result<(), String> {
    // cmux·Orca 는 탭 전환과 창 활성화를 자기 CLI 로 처리한다(호스트 터미널 탐색이 필요 없다).
    match route_of(&session) {
        Route::Cmux => return crate::cmux::focus_workspace(&workspace_id),
        Route::Orca => return crate::orca::focus_workspace(&workspace_id),
        Route::Herdr => {}
    }
    run_herdr(Some(&session), &["workspace", "focus", &workspace_id])?;
    // 펫을 여기서 직접 숨기지는 않는다 — 다른 작업의 알림이 남아 있을 수 있고,
    // 정리 판단은 감시 루프(set_pet_alert)가 한 곳에서 한다.
    // Kaku pane/탭 선택 + OS 앱 활성화(다른 Space 면 macOS 가 전환). 아래 헬퍼 doc 참고.
    focus_terminal_for_session(&session);
    Ok(())
}

/// 해당 pane 의 Claude 세션에 프롬프트를 입력·전송한다.
/// `herdr pane run` 은 텍스트를 붙여넣고 Enter 까지 원자적으로 처리한다(작업 중이면 큐잉됨).
#[tauri::command]
pub fn herdr_send_prompt(session: String, pane_id: String, text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }
    match route_of(&session) {
        Route::Cmux => return crate::cmux::send_prompt(&pane_id, &text),
        Route::Orca => return crate::orca::send_prompt(&pane_id, &text),
        Route::Herdr => {}
    }
    // run_herdr 는 JSON stdout 을 요구하는데 `pane run` 은 성공 시 출력이 없을 수 있어
    // 오탐(에러)이 난다. 여기선 종료 상태만 확인한다.
    let out = Command::new(herdr_bin())
        .args(["--session", &session, "pane", "run", &pane_id, &text])
        .output()
        .map_err(|e| format!("herdr 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// 특정 pane(workspace)의 최근 터미널 출력(주고받은 메시지)을 herdr 소켓으로 읽는다.
/// `herdr agent read` 는 소켓 API `pane.read` 의 래퍼이므로 소켓을 통해 가져온다.
#[tauri::command]
pub fn herdr_read_pane(
    session: String,
    pane_id: String,
    lines: Option<u32>,
) -> Result<String, String> {
    read_pane_text(&session, &pane_id, lines.unwrap_or(200))
}

/// 특정 pane 의 대기 중 AskUserQuestion 을 조회한다(수동 새로고침용).
#[tauri::command]
pub fn herdr_read_question(
    session: String,
    pane_id: String,
) -> Result<Option<AskQuestion>, String> {
    let agents = list_agents()?;
    // pane_id 는 세션 간 겹칠 수 있으므로 세션까지 일치하는 agent 로만 session_id 를 찾는다.
    let sid = agents
        .iter()
        .find(|a| a.session == session && a.pane_id == pane_id)
        .and_then(|a| a.session_id.clone());
    Ok(read_question(&session, sid.as_deref(), &pane_id))
}

/// herdr 를 실행 중인 "호스트 터미널 앱(.app)"을 프로세스 조상에서 동적으로 찾는다.
/// (예: Kaku, Ghostty, iTerm2, Terminal … 하드코딩하지 않고 감지)
#[cfg(target_os = "macos")]
fn detect_terminal_app() -> Option<String> {
    let out = Command::new("ps").args(["-axo", "pid=,ppid=,comm="]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let procs: Vec<(i32, i32, String)> = text
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid: i32 = it.next()?.parse().ok()?;
            let ppid: i32 = it.next()?.parse().ok()?;
            let comm = it.collect::<Vec<_>>().join(" ");
            (!comm.is_empty()).then_some((pid, ppid, comm))
        })
        .collect();

    // herdr 프로세스에서 시작해 부모를 거슬러 올라가며 .app 번들 경로를 찾는다.
    let mut cur = procs
        .iter()
        .find(|(_, _, c)| c.ends_with("/herdr") || c == "herdr")
        .map(|(p, _, _)| *p)?;
    for _ in 0..16 {
        let Some((_, ppid, comm)) = procs.iter().find(|(p, _, _)| *p == cur).cloned() else {
            break;
        };
        if let Some(app) = comm.split('/').find(|s| s.ends_with(".app")) {
            return Some(app.trim_end_matches(".app").to_string());
        }
        if ppid <= 1 {
            break;
        }
        cur = ppid;
    }
    None
}

/// 호스트 터미널 앱을 OS 레벨로 앞으로 가져온다(macOS: `open -a <App>`).
fn focus_terminal_app() {
    #[cfg(target_os = "macos")]
    {
        if let Some(app) = detect_terminal_app() {
            log::info!("focus terminal app: {app}");
            let _ = Command::new("open").args(["-a", &app]).output();
        }
    }
}

/// 해당 세션의 호스트 터미널을 앞으로 가져온다(Slack 딥링크와 같은 원리 = OS 앱 활성화).
///
/// 다른 Space(가상 데스크탑)로의 전환은 **AXRaise 로는 불가능**하다(AX API 는 같은 Space
/// 안에서만 창 순서를 바꾼다). Space 전환은 오직 OS 앱 활성화(`open -a`)로만 되므로,
/// 순서를 이렇게 둔다:
///   1) Kaku 면 `kaku cli activate-pane` 으로 mux 상 해당 pane/탭을 먼저 활성화하고
///      (그 pane 이 속한 창이 Kaku 의 활성 창이 된다), 같은 Space 안이면 AXRaise 로 정확한 창을 올린다.
///   2) 이어서 항상 `open -a`(OS 앱 활성화)를 호출한다 — 대상 창이 다른 Space 에 있으면
///      macOS 가 그 Space 로 전환한다.
///
/// ⚠️ 2)의 Space 전환은 macOS "응용 프로그램으로 전환 시 열린 윈도우가 있는 Space 로 전환"
/// (NSGlobalDomain `AppleSpacesSwitchOnActivate`) 설정이 켜져 있어야 동작한다.
fn focus_terminal_for_session(session: &str) {
    let _ = kaku_activate_session_pane(session);
    focus_terminal_app();
}

/// kaku(터미널) 실행 파일 경로를 찾는다. 없으면 None(=Kaku 아님 → 탭 전환 생략).
#[cfg(target_os = "macos")]
fn kaku_bin() -> Option<String> {
    if let Ok(b) = std::env::var("KAKU_BIN") {
        return Some(b);
    }
    let app = "/Applications/Kaku.app/Contents/MacOS/kaku";
    if std::path::Path::new(app).exists() {
        return Some(app.to_string());
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = format!("{home}/.config/kaku/zsh/bin/kaku");
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    None
}

/// 특정 herdr 세션 클라이언트가 실행 중인 TTY(예: "ttys025")를 찾는다.
/// herdr 서버/probe 는 제외하고, default 세션은 `--session` 인자가 없는 클라이언트로 식별한다.
#[cfg(target_os = "macos")]
fn herdr_session_tty(session: &str) -> Option<String> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,tty=,command="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(_pid), Some(tty)) = (it.next(), it.next()) else {
            continue;
        };
        if tty == "??" {
            continue;
        }
        let cmd: Vec<&str> = it.collect();
        // 첫 토큰 basename 이 herdr 인 클라이언트만(서버 제외).
        let Some(first) = cmd.first() else { continue };
        if first.rsplit('/').next().unwrap_or(first) != "herdr" {
            continue;
        }
        if cmd.iter().any(|t| *t == "server") {
            continue;
        }
        let matches = if session == "default" {
            !cmd.iter().any(|t| *t == "--session")
        } else {
            cmd.windows(2).any(|w| w[0] == "--session" && w[1] == session)
        };
        if matches {
            return Some(tty.to_string());
        }
    }
    None
}

/// `file://host/path` 또는 `file:///path` 형태의 URL 에서 파일시스템 경로를 뽑는다(끝 슬래시 제거).
#[cfg(target_os = "macos")]
fn fs_path_from_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    // 호스트 부분을 건너뛰고 첫 '/' 부터가 경로(호스트가 없으면 rest 가 이미 "/..." 로 시작).
    let path = &rest[rest.find('/')?..];
    let trimmed = path.trim_end_matches('/');
    Some(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

/// cwd 에 해당하는 Kaku OS 창을 앞으로 가져온다(System Events 로 AXRaise).
/// Kaku 창 제목은 cwd 의 꼬리(마지막 1~2 경로요소)라, "cwd 가 창 제목으로 끝나는" 창을 찾아 올린다.
/// `kaku cli activate-pane` 은 별도 GUI 창을 OS 앞으로 못 올리므로 이 방식이 필요하다.
/// ⚠️ My Space 앱에 손쉬운 사용(Accessibility) 권한이 있어야 동작한다(없으면 조용히 실패).
/// 성공(창을 찾아 AXRaise)하면 true. 다른 Space 등으로 창을 못 찾으면 false.
#[cfg(target_os = "macos")]
fn raise_kaku_window_for_cwd(cwd: &str) -> bool {
    // activate-pane 직후에는 Kaku 창 제목(=활성 pane 의 cwd)이 아직 갱신되기 전일 수 있어,
    // 한 번만 훑으면 매칭에 실패한다(그래서 "두 번 클릭해야 이동" 증상이 났다). 제목이 맞는
    // 창을 찾을 때까지 짧게 재시도(최대 ~0.6초)해 제목 repaint 경합을 흡수한다.
    const SCRIPT: &str = r#"on run argv
  set cwd to item 1 of argv
  tell application "System Events"
    repeat 12 times
      repeat with p in (every process whose name contains "aku")
        repeat with w in (windows of p)
          set t to ""
          try
            set t to title of w
          end try
          if t is not "" and cwd ends with t then
            perform action "AXRaise" of w
            set frontmost of p to true
            delay 0.05
            set frontmost of p to true
            return "ok"
          end if
        end repeat
      end repeat
      delay 0.05
    end repeat
  end tell
  return "notfound"
end run"#;
    match Command::new("osascript").arg("-e").arg(SCRIPT).arg(cwd).output() {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            let stderr = String::from_utf8_lossy(&o.stderr);
            let ok = stdout.trim() == "ok";
            log::info!(
                "raise_kaku_window_for_cwd({cwd}) status={} stdout={:?} stderr={:?}",
                o.status.code().unwrap_or(-1),
                stdout.trim(),
                stderr.trim()
            );
            ok
        }
        Err(e) => {
            log::warn!("osascript AXRaise 실패: {e}");
            false
        }
    }
}

/// 해당 herdr 세션이 떠 있는 Kaku pane/탭을 활성화한다. Kaku 세션이면 true(아니면 false).
/// 두 herdr 세션이 같은 Kaku 창의 다른 탭이거나 별도 창(다른 Space 포함)일 때 "이동" 이 올바른 곳을 활성화한다.
/// 세션 클라이언트의 TTY 로 pane 을 찾아 (1) `kaku cli activate-pane` 으로 Kaku 내부 pane/탭을 선택하고,
/// (2) 그 pane 의 cwd 로 OS 창을 AXRaise 한다(같은 Space 안에서 정확한 창을 앞으로).
/// ⚠️ AXRaise 는 Space 를 넘지 못한다 — 다른 Space 로의 전환은 caller(focus_terminal_for_session)의
/// `open -a`(OS 앱 활성화)가 담당한다. 반환값은 Kaku 세션인지 여부일 뿐, Space 전환 성공을 뜻하지 않는다.
#[cfg(target_os = "macos")]
fn kaku_activate_session_pane(session: &str) -> bool {
    let Some(kaku) = kaku_bin() else { return false };
    let Some(tty) = herdr_session_tty(session) else {
        return false;
    };
    let target = format!("/dev/{tty}");
    let Ok(out) = Command::new(&kaku)
        .args(["cli", "list", "--format", "json"])
        .output()
    else {
        return false;
    };
    let Ok(panes) = serde_json::from_slice::<Value>(&out.stdout) else {
        return false;
    };
    let pane = panes.as_array().and_then(|arr| {
        arr.iter()
            .find(|p| p.get("tty_name").and_then(|x| x.as_str()) == Some(target.as_str()))
    });
    let Some(pane) = pane else {
        log::info!("kaku pane for session={session} tty={tty} 를 찾지 못함");
        return false;
    };
    // 1) Kaku 내부에서 해당 pane(탭) 선택.
    if let Some(id) = pane.get("pane_id").and_then(|x| x.as_u64()) {
        log::info!("kaku activate-pane {id} (session={session}, tty={tty})");
        let _ = Command::new(&kaku)
            .args(["cli", "activate-pane", "--pane-id", &id.to_string()])
            .status();
    }
    // 2) 그 pane 이 속한 OS 창을 앞으로(cwd → 창 제목 매칭 AXRaise).
    //    AXRaise 성공 시 true → caller 가 open -a 를 생략(엉뚱한 창 올림 방지).
    //    실패(다른 Space 로 열거 불가 등) 시 false → caller 가 open -a 로 폴백한다.
    //    창이 하나뿐이면(=default 세션만 사용) open -a 가 그 창을 정확히 앞으로 가져온다.
    pane.get("cwd")
        .and_then(|x| x.as_str())
        .and_then(fs_path_from_file_url)
        .map(|cwd| raise_kaku_window_for_cwd(&cwd))
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn kaku_activate_session_pane(_session: &str) -> bool {
    false
}

/// 해당 pane(workspace)으로 herdr 를 이동(focus)시키고 호스트 터미널 창을 앞으로 가져온다.
/// 사용자가 알림 항목을 클릭하면 그 워크스페이스로 전환해 터미널에서 직접 선택하게 한다.
#[tauri::command]
pub fn herdr_focus_pane(session: String, pane_id: String) -> Result<(), String> {
    match route_of(&session) {
        Route::Cmux => return crate::cmux::focus_pane(&pane_id),
        Route::Orca => return crate::orca::focus_pane(&pane_id),
        Route::Herdr => {}
    }
    run_herdr(Some(&session), &["agent", "focus", &pane_id])?; // herdr 내부 pane 전환
    // 펫 정리는 감시 루프가 맡는다(herdr_focus_workspace 와 같은 이유).
    // Kaku pane/탭 선택 + OS 앱 활성화(다른 Space 면 macOS 가 전환). 아래 헬퍼 doc 참고.
    focus_terminal_for_session(&session);
    Ok(())
}

/// 현재 대기 중인 질문 목록(펫 창이 마운트 시 조회).
#[tauri::command]
pub fn herdr_current_questions(app: tauri::AppHandle) -> Vec<AskQuestion> {
    app.state::<PendingQuestions>()
        .0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/// 입력 대기/작업 완료 알림을 펫 말풍선에 잠깐 띄운다(메인 창 감지 로직이 호출).
/// 알림을 저장하고 펫에 알린 뒤, 활성 목록을 모든 창에 방출한다.
/// 만료(NOTICE_TTL_MS)는 감시 루프가 정리하며, 만료되고 대기 질문도 없으면 알림이 꺼진다
/// (펫을 설정에서 켜 뒀다면 캐릭터는 그대로 남고 말풍선만 사라진다).
#[tauri::command]
pub fn herdr_notify(
    app: tauri::AppHandle,
    kind: String,
    label: String,
    session: String,
    workspace_id: String,
) {
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();
    let is_done = kind == "done";
    let notice = HerdrNotice {
        kind,
        label,
        session: session.clone(),
        workspace_id: workspace_id.clone(),
        id,
    };
    let now = std::time::Instant::now();
    let state = app.state::<Notices>();
    let list = {
        let Ok(mut g) = state.list.lock() else {
            return;
        };
        // 같은 워크스페이스의 기존 알림은 교체(중복 방지 — 새 프롬프트/상태로 갱신).
        g.retain(|(n, _)| !(n.session == session && n.workspace_id == workspace_id));
        // 완료 알림은 만료 없이 영구 보관(트레이를 다시 열면 계속 보임), 대기 알림은 TTL 후 사라짐.
        let expiry = if is_done {
            None
        } else {
            Some(now + std::time::Duration::from_millis(NOTICE_TTL_MS))
        };
        g.push((notice, expiry));
        g.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()
    };
    // 도착 순간부터 설정된 시간(설정 → 데스크톱 펫 → 알림 표시 시간)만큼 알린다.
    // 0(항상 표시)이면 시각으로 끊지 않고 None 을 넣는다 — 감시 루프가 "알림이 남아 있는
    // 동안"으로 해석한다(아래 notice_active 참고).
    if let Ok(mut u) = state.present_until.lock() {
        let secs = pet::notice_ttl_secs(&app);
        *u = if secs == 0 {
            None
        } else {
            Some(now + std::time::Duration::from_secs(secs))
        };
    }
    set_pet_alert(&app, true);
    let _ = app.emit("herdr:notices", list);
}

/// 알림 하나를 목록에서 제거한다(말풍선에서 "이동"으로 처리했을 때 등). 남은 목록을 방출한다.
#[tauri::command]
pub fn herdr_dismiss_notice(app: tauri::AppHandle, id: String) {
    let state = app.state::<Notices>();
    let list = {
        let Ok(mut g) = state.list.lock() else {
            return;
        };
        g.retain(|(n, _)| n.id != id);
        g.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>()
    };
    let _ = app.emit("herdr:notices", list);
}

/// 현재 활성 알림 목록(펫 창이 마운트 시 조회).
#[tauri::command]
pub fn herdr_current_notices(app: tauri::AppHandle) -> Vec<HerdrNotice> {
    prune_notices(&app)
}

/// 감시 "꺼짐" 플래그 파일 경로(~/.myspace/watch-disabled). 존재하면 꺼짐으로 간주.
/// 설정(localStorage)은 Rust 가 못 읽으므로, 부팅 시 자동 시작 여부를 이 파일로 판단한다.
fn watch_disabled_flag() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(format!("{h}/.myspace/watch-disabled")))
}

/// 저장된 감시 설정이 "꺼짐"인지(부팅 시 자동 시작 여부 판단용).
pub fn watch_disabled() -> bool {
    watch_disabled_flag().map(|p| p.exists()).unwrap_or(false)
}

/// blocked 감시를 시작한다. 이미 돌고 있으면 아무 것도 하지 않는다.
#[tauri::command]
pub fn herdr_start_watch(app: tauri::AppHandle) {
    // 명시적으로 켰으므로 "꺼짐" 플래그를 지운다(재시작 후에도 켜짐 유지).
    if let Some(flag) = watch_disabled_flag() {
        let _ = std::fs::remove_file(&flag);
    }
    let state = app.state::<WatchState>();
    if state.running.swap(true, Ordering::SeqCst) {
        return;
    }
    let running = state.running.clone();
    std::thread::spawn(move || {
        log::info!("claude watcher started (backend={:?})", backend());
        // ~/.myspace 준비(heartbeat·ask·answer 공용 위치).
        let myspace_dir = std::env::var("HOME")
            .ok()
            .map(|h| format!("{h}/.myspace"));
        if let Some(dir) = &myspace_dir {
            let _ = std::fs::create_dir_all(dir);
        }
        // 질문을 이미 띄운 pane 집합. blocked 로 "전환"되는 순간만 보지 않고,
        // "blocked 인데 아직 질문을 못 띄운" pane 을 매 폴링마다 다시 확인한다
        // (질문이 blocked 보다 늦게 뜨거나 트랜스크립트 flush 가 늦는 타이밍 문제 해결).
        let mut prev_sig: Vec<String> = Vec::new(); // 이전 대기 목록 시그니처
        let mut logged_empty: HashSet<String> = HashSet::new();
        let mut prev_visible = false; // 팝오버 표시 상태(변화 시에만 show/hide 호출 → focus 도둑 방지)
        let mut prev_notice_sig: Vec<String> = Vec::new(); // 이전 알림 목록 시그니처
        while running.load(Ordering::SeqCst) {
            // heartbeat: 후크가 "My Space 감시 중"을 알 수 있게 매 틱 파일을 갱신한다.
            if let Some(dir) = &myspace_dir {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let _ = std::fs::write(format!("{dir}/watching"), ms.to_string());
            }

            // 작업 진행 현황(워크스페이스 label + 상태)도 함께 방출.
            if let Ok(ws) = list_workspaces() {
                let _ = app.emit("herdr:workspaces", ws);
            }

            if let Ok(agents) = list_agents() {
                let _ = app.emit("herdr:agents", agents.clone());
                // pane_id 는 세션 간 겹칠 수 있으므로 "<session>\0<pane_id>" 로 식별한다.
                let pane_key = |a: &HerdrAgent| format!("{}\0{}", a.session, a.pane_id);
                // 대기 여부 = 후크 ask 파일 존재 OR herdr blocked.
                let pending_now: HashSet<String> = agents
                    .iter()
                    .filter(|a| {
                        a.session_id.as_deref().map(ask_file_exists).unwrap_or(false)
                            || a.agent_status == "blocked"
                    })
                    .map(pane_key)
                    .collect();

                // 현재 대기 중인 AskUserQuestion 목록을 구성한다.
                let mut questions: Vec<AskQuestion> = Vec::new();
                for a in &agents {
                    let key = pane_key(a);
                    if !pending_now.contains(&key) {
                        continue;
                    }
                    if let Some(q) = read_question(&a.session, a.session_id.as_deref(), &a.pane_id) {
                        logged_empty.remove(&key);
                        questions.push(q);
                    } else if logged_empty.insert(key) {
                        // 대기지만 AskUserQuestion 아님(권한 프롬프트 등) — pane 당 한 번만 로그.
                        log::info!(
                            "herdr pending session={} pane={} but no AskUserQuestion",
                            a.session,
                            a.pane_id
                        );
                    }
                }
                questions.sort_by(|x, y| (&x.session, &x.pane_id).cmp(&(&y.session, &y.pane_id)));
                logged_empty.retain(|p| pending_now.contains(p));

                // 목록이 바뀌었을 때만 상태 저장·팝오버 표시/숨김·이벤트 방출.
                let sig: Vec<String> = questions
                    .iter()
                    .map(|q| format!("{}|{}|{}", q.session, q.pane_id, q.question))
                    .collect();
                if sig != prev_sig {
                    prev_sig = sig;
                    if let Ok(mut g) = app.state::<PendingQuestions>().0.lock() {
                        *g = questions.clone();
                    }
                    log::info!("herdr pending questions: {}", questions.len());
                    let _ = app.emit("herdr:questions", questions);
                }
            }

            // 알림(입력 대기/작업 완료) 만료 정리 + 변경 시 모든 창에 방출. (완료 알림은 만료 None 이라 유지됨)
            let notices = prune_notices(&app);
            let notice_sig: Vec<String> = notices.iter().map(|n| n.id.clone()).collect();
            if notice_sig != prev_notice_sig {
                prev_notice_sig = notice_sig;
                let _ = app.emit("herdr:notices", notices.clone());
            }

            // 자동 표시 = 대기 질문 있음 OR 알림 표시 시간 안. 변화가 있을 때만 show/hide.
            // (완료 알림이 목록에 남아 있어도 시간이 지나면 닫힌다 → 트레이 메뉴로 다시 볼 수 있다)
            let has_questions = app
                .state::<PendingQuestions>()
                .0
                .lock()
                .map(|g| !g.is_empty())
                .unwrap_or(false);
            let notice_active = if pet::notice_ttl_secs(&app) == 0 {
                // "항상 표시" — 시각으로 끊지 않고 알림이 남아 있는 동안 계속 띄운다.
                // 이때 herdr_notify 는 present_until 을 None 으로 두므로 시각을 볼 수 없다
                // (None 을 그대로 시각 비교에 넣으면 false 가 되어 아예 안 뜬다).
                !notices.is_empty()
            } else {
                app.state::<Notices>()
                    .present_until
                    .lock()
                    .ok()
                    .and_then(|u| *u)
                    .map_or(false, |t| std::time::Instant::now() < t)
            };
            let want_visible = has_questions || notice_active;
            if want_visible != prev_visible {
                prev_visible = want_visible;
                set_pet_alert(&app, want_visible);
            }

            std::thread::sleep(std::time::Duration::from_millis(POLL_MS));
        }
    });
}

/// blocked 감시를 멈춘다.
#[tauri::command]
pub fn herdr_stop_watch(app: tauri::AppHandle) {
    app.state::<WatchState>()
        .running
        .store(false, Ordering::SeqCst);
    // 재시작 후에도 꺼짐이 유지되도록 "꺼짐" 플래그를 남긴다.
    if let Some(flag) = watch_disabled_flag() {
        if let Some(dir) = flag.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&flag, b"1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 설정 문자열 ↔ 백엔드 집합. 프런트(`migrateWatchBackend`)와 **같은 규칙**이어야 한다 —
    /// 어긋나면 화면과 감시 루프가 서로 다른 백엔드를 본다.
    #[test]
    fn parses_and_round_trips_backend_list() {
        let all = backend_from_str("herdr,cmux,orca");
        assert_eq!(backend_to_str(all), "herdr,cmux,orca");
        assert_eq!(backend_from_code(backend_code(all)), all);

        // 예전 단일 선택 값. "both" 는 기본값이자 "그때 있던 전부"였으므로 셋 다로 옮긴다.
        assert_eq!(backend_from_str("both"), all);
        assert_eq!(backend_to_str(backend_from_str("cmux")), "cmux");

        // 전부 끈 상태는 빈 문자열이 아니라 이름으로 남아야 한다(빈 파일 = 저장 안 함).
        assert_eq!(backend_to_str(Backends::none()), "none");
        assert_eq!(backend_from_str("none"), Backends::none());
    }

    /// 라우팅은 세션 이름으로 가르되, 하나만 켜져 있으면 이름과 무관하게 그쪽으로 간다.
    #[test]
    fn routes_actions_by_session_name() {
        assert_eq!(crate::orca::SESSION, "orca");
        assert_eq!(crate::cmux::SESSION, "cmux");
        // route_of 는 저장된 설정을 읽으므로 여기서는 이름 상수만 고정한다 —
        // 이 둘이 바뀌면 혼합 모드의 이동·전송이 조용히 엉뚱한 앱으로 간다.
    }

    /// herdr 가 설치돼 있지만 데몬이 안 떠 있으면 **찔러 볼 세션이 없다**. 여기서 `["default"]`
    /// 로 폴백하면 감시 루프가 800ms 마다 죽은 소켓에 붙어 ConnectionRefused 경고를 쏟는다.
    /// 반대로 `sessions` 를 못 읽은 경우(옛 CLI)는 폴백이 유지돼야 한다.
    #[test]
    fn lists_no_session_when_herdr_daemon_is_down() {
        let down = serde_json::json!({
            "sessions": [{ "name": "default", "running": false, "default": true }]
        });
        assert!(sessions_from(Some(&down)).is_empty());

        let up = serde_json::json!({
            "sessions": [
                { "name": "default", "running": true },
                { "name": "side", "running": false },
                { "name": "work", "running": true },
            ]
        });
        assert_eq!(sessions_from(Some(&up)), vec!["default", "work"]);

        // 조회 실패(옛 herdr 는 `session list --json` 이 없다) → 기존 동작 유지.
        assert_eq!(sessions_from(None), vec!["default"]);
        assert_eq!(sessions_from(Some(&serde_json::json!({}))), vec!["default"]);
    }

    /// herdr 부재는 정상 상태라 로그를 낮춰야 한다 — 그 판단은 `ABSENT` 접두사로만 한다
    /// (문구로 판단하면 메시지를 다듬는 순간 조용히 깨진다).
    #[test]
    fn marks_missing_herdr_as_absent_not_failure() {
        assert!(is_absent(&format!("{ABSENT}(데몬 미실행)")));
        assert!(is_absent(&format!("{ABSENT}(실행 파일 미설치)")));
        assert!(!is_absent("herdr JSON 파싱 실패: expected value"));
        assert!(!is_absent("herdr 응답 없음: usage: herdr ..."));
    }
}
