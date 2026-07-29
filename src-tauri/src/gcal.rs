//! Google 캘린더 연동 — 오늘 일정 조회.
//!
//! 데스크톱 앱용 OAuth 2.0(루프백) 흐름:
//!   1. 로컬 127.0.0.1 임의 포트로 리스너를 연다.
//!   2. 브라우저로 구글 동의 화면을 연다(redirect_uri = http://127.0.0.1:PORT).
//!   3. 로그인/동의 후 구글이 그 주소로 code 를 리다이렉트 → 리스너가 받는다.
//!   4. code 를 access/refresh 토큰으로 교환한다.
//!   5. refresh_token 을 저장하고, 이후 조회 시 access_token 을 갱신해 쓴다.
//!
//! client_id / client_secret 은 사용자가 Google Cloud "데스크톱 앱" OAuth 클라이언트에서
//! 발급받아 입력한다. 토큰 등은 앱 설정 폴더의 gcal.json 에 저장한다(웹뷰에 노출 안 함).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const CONFIG_FILE: &str = "gcal.json";
/// 전체 calendar 스코프: 일정 조회 + 회의실 예약(쓰기)까지 커버한다.
/// (기존 readonly 로 연결된 사용자는 예약 시 재연결이 필요하다 — can_write 로 구분.)
/// directory.readonly 는 참석자 이메일을 이름으로 바꾸는 데 쓴다(없어도 동작 — can_directory 로 구분).
const SCOPE: &str = "https://www.googleapis.com/auth/calendar \
    https://www.googleapis.com/auth/directory.readonly email profile";

/// 저장된 scope 문자열이 쓰기(이벤트 생성) 가능한 권한을 포함하는지.
fn scope_can_write(scope: &str) -> bool {
    scope.split_whitespace().any(|s| {
        s == "https://www.googleapis.com/auth/calendar"
            || s == "https://www.googleapis.com/auth/calendar.events"
    })
}

/// 저장된 scope 가 도메인 주소록(참석자 이름) 조회를 포함하는지.
fn scope_can_directory(scope: &str) -> bool {
    scope
        .split_whitespace()
        .any(|s| s == "https://www.googleapis.com/auth/directory.readonly")
}
/// 브라우저 로그인 완료를 기다리는 최대 시간.
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Serialize, Deserialize, Default)]
struct Config {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    email: String,
    /// 내 표시 이름(profile 스코프). 참석자 목록에서 나를 이름으로 보여줄 때 쓴다.
    #[serde(default)]
    name: String,
    /// 마지막 인증에서 승인된 scope(공백 구분). 예약 가능 여부 판별용.
    /// 기존(readonly) 설정 파일엔 없으므로 default 로 빈 문자열.
    #[serde(default)]
    scope: String,
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(CONFIG_FILE))
}

fn read_config(app: &tauri::AppHandle) -> Config {
    (|| {
        let raw = std::fs::read_to_string(config_path(app).ok()?).ok()?;
        serde_json::from_str::<Config>(&raw).ok()
    })()
    .unwrap_or_default()
}

fn write_config(app: &tauri::AppHandle, cfg: &Config) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(app)?, json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GcalStatus {
    connected: bool,
    email: Option<String>,
    /// 회의실 예약(이벤트 쓰기)이 가능한지. false 면 재연결이 필요하다.
    can_write: bool,
    /// 도메인 주소록으로 참석자 이름을 채울 수 있는지. false 면 재연결이 필요하다.
    can_directory: bool,
}

/// 내 구글 캘린더 목록 항목(회의실 선택용).
#[derive(Serialize)]
pub struct CalendarInfo {
    id: String,
    summary: String,
    primary: bool,
}

/// 일정 참석자 한 명.
#[derive(Serialize)]
pub struct Attendee {
    /// displayName, 없으면 이메일의 로컬 파트.
    name: String,
    email: String,
    /// "accepted" | "declined" | "tentative" | "needsAction"
    response_status: String,
    organizer: bool,
    /// 나 자신인지(구글이 `self` 로 표시).
    is_self: bool,
}

#[derive(Serialize)]
pub struct CalendarEvent {
    summary: String,
    /// RFC3339 dateTime 또는 all-day 면 "YYYY-MM-DD".
    start: String,
    end: String,
    all_day: bool,
    location: Option<String>,
    html_link: Option<String>,
    meet_link: Option<String>,
    /// 참석자(없으면 빈 배열). 회의실 등 리소스는 빠진다.
    attendees: Vec<Attendee>,
    /// 구글의 eventType — "default" | "outOfOffice" | "focusTime" | "workingLocation" | …
    /// 휴가/외근을 제목 추측 없이 구분하는 데 쓴다.
    event_type: String,
}

/// 이벤트 JSON 의 attendees 를 읽는다. 회의실 같은 리소스 참석자는 장소로 이미 보이므로 뺀다.
/// 정렬은 주최자 → 나 → 나머지(원래 순서 유지).
/// `names` 는 이메일(소문자) → 이름 사전 — 구글이 displayName 을 안 줄 때 여기서 채운다.
fn parse_attendees(it: &Value, names: &HashMap<String, String>) -> Vec<Attendee> {
    let Some(arr) = it.get("attendees").and_then(|x| x.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<Attendee> = arr
        .iter()
        .filter(|a| !a.get("resource").and_then(|x| x.as_bool()).unwrap_or(false))
        .filter_map(|a| {
            let email = a
                .get("email")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            // 이 이벤트의 displayName → 사전 → 아이디(이메일 로컬 파트) 순으로 폴백.
            let name = a
                .get("displayName")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .or_else(|| names.get(&email.to_lowercase()).cloned())
                .unwrap_or_else(|| email.split('@').next().unwrap_or("").to_string());
            if name.is_empty() {
                return None;
            }
            Some(Attendee {
                name,
                email,
                response_status: a
                    .get("responseStatus")
                    .and_then(|x| x.as_str())
                    .unwrap_or("needsAction")
                    .to_string(),
                organizer: a
                    .get("organizer")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false),
                is_self: a.get("self").and_then(|x| x.as_bool()).unwrap_or(false),
            })
        })
        .collect();
    // sort_by_key 는 안정 정렬이라 같은 그룹 안에서는 구글이 준 순서가 유지된다.
    out.sort_by_key(|a| {
        if a.organizer {
            0
        } else if a.is_self {
            1
        } else {
            2
        }
    });
    out
}

// ── 참석자 이름 사전 ────────────────────────────────────────────────────────────
//
// 캘린더 API 의 `attendees[].displayName` 은 초대한 사람이 이름을 직접 넣었을 때만 채워진다.
// 같은 사람이 어떤 일정에는 "홍길동", 다른 일정에는 아예 없이 오므로, 이름을 두 군데서 모은다:
//   1. 응답 안에 한 번이라도 등장한 displayName(공짜, 스코프 불필요)
//   2. Workspace 도메인 주소록(People API, directory.readonly 스코프 필요)
// 둘 다 실패하면 이메일 로컬 파트(=아이디)로 폴백한다. 사전은 파일에 남겨 다음 실행에도 쓴다.

const DIRECTORY_FILE: &str = "gcal-directory.json";
/// 주소록 갱신 주기 — 성공하면 7일, 실패하면 1시간 뒤 재시도.
const DIR_TTL_OK: u64 = 7 * 24 * 3600;
const DIR_TTL_FAIL: u64 = 3600;
/// 주소록 페이지 상한(1페이지 1000명) — 폭주 방지.
const DIR_MAX_PAGES: usize = 10;

#[derive(Serialize, Deserialize, Default, Clone)]
struct Directory {
    /// 마지막 주소록 갱신 "시도" 시각(unix secs).
    updated_at: u64,
    /// 그 시도가 성공했는지.
    ok: bool,
    /// 이메일(소문자) → 표시 이름.
    names: HashMap<String, String>,
}

/// 디스크 사전의 메모리 캐시. 5분 폴링마다 파일을 다시 읽지 않기 위한 것.
static DIRECTORY: LazyLock<Mutex<Option<Directory>>> = LazyLock::new(|| Mutex::new(None));

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 뮤텍스가 poison 돼도 사전은 그냥 캐시라 계속 쓴다.
fn directory_lock() -> std::sync::MutexGuard<'static, Option<Directory>> {
    DIRECTORY.lock().unwrap_or_else(|e| e.into_inner())
}

fn directory_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(DIRECTORY_FILE))
}

/// 사전을 읽는다(메모리 → 파일 → 빈 사전).
fn load_directory(app: &tauri::AppHandle) -> Directory {
    let mut slot = directory_lock();
    if slot.is_none() {
        *slot = Some(
            (|| {
                let raw = std::fs::read_to_string(directory_path(app).ok()?).ok()?;
                serde_json::from_str::<Directory>(&raw).ok()
            })()
            .unwrap_or_default(),
        );
    }
    slot.clone().unwrap_or_default()
}

/// 새로 알아낸 이름을 사전에 합치고, 실제로 바뀐 게 있을 때만 파일에 쓴다.
/// `attempt` 가 Some 이면 주소록 갱신 시도 결과(성공 여부)도 함께 기록한다.
fn merge_names(app: &tauri::AppHandle, learned: HashMap<String, String>, attempt: Option<bool>) {
    let snapshot = {
        let mut slot = directory_lock();
        let dir = slot.get_or_insert_with(Directory::default);
        let mut changed = false;
        for (email, name) in learned {
            if dir.names.get(&email) != Some(&name) {
                dir.names.insert(email, name);
                changed = true;
            }
        }
        if let Some(ok) = attempt {
            dir.updated_at = now_secs();
            dir.ok = ok;
            changed = true;
        }
        if changed {
            Some(dir.clone())
        } else {
            None
        }
    };
    if let Some(dir) = snapshot {
        if let Ok(path) = directory_path(app) {
            if let Ok(json) = serde_json::to_string(&dir) {
                let _ = std::fs::write(path, json);
            }
        }
    }
}

/// 이벤트 목록 응답에 흩어져 있는 displayName 을 이메일→이름으로 긁어모은다.
fn learn_names(v: &Value) -> HashMap<String, String> {
    fn add(out: &mut HashMap<String, String>, who: &Value) {
        // 회의실 등 리소스는 사람 사전에 넣지 않는다.
        if who
            .get("resource")
            .and_then(|x| x.as_bool())
            .unwrap_or(false)
        {
            return;
        }
        let email = who.get("email").and_then(|x| x.as_str()).unwrap_or("");
        let name = who
            .get("displayName")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if !email.is_empty() && !name.is_empty() {
            out.insert(email.to_lowercase(), name.to_string());
        }
    }

    let mut out = HashMap::new();
    for it in v
        .get("items")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
    {
        for key in ["organizer", "creator"] {
            if let Some(who) = it.get(key) {
                add(&mut out, who);
            }
        }
        for a in it
            .get("attendees")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            add(&mut out, a);
        }
    }
    out
}

/// Workspace 도메인 주소록을 통째로 가져온다. 권한/API 미설정 등 어떤 이유로든 실패하면 None.
async fn fetch_directory(access: &str) -> Option<HashMap<String, String>> {
    let client = reqwest::Client::new();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut page: Option<String> = None;

    for _ in 0..DIR_MAX_PAGES {
        let mut query = vec![
            ("readMask", "names,emailAddresses".to_string()),
            (
                "sources",
                "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE".to_string(),
            ),
            ("pageSize", "1000".to_string()),
        ];
        if let Some(token) = &page {
            query.push(("pageToken", token.clone()));
        }
        let v: Value = client
            .get("https://people.googleapis.com/v1/people:listDirectoryPeople")
            .bearer_auth(access)
            .query(&query)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        if v.get("error").is_some() {
            return None;
        }
        for p in v
            .get("people")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            let name = p
                .pointer("/names/0/displayName")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if name.is_empty() {
                continue;
            }
            for e in p
                .get("emailAddresses")
                .and_then(|x| x.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(addr) = e.get("value").and_then(|x| x.as_str()) {
                    names.insert(addr.to_lowercase(), name.to_string());
                }
            }
        }
        match v.get("nextPageToken").and_then(|x| x.as_str()) {
            Some(t) if !t.is_empty() => page = Some(t.to_string()),
            _ => break,
        }
    }
    Some(names)
}

/// 주소록을 지금 갱신해야 하면 "내가 한다"고 표시하고 true 를 준다.
/// 확인과 표시를 한 락 안에서 끝내야 회의실 여러 개를 동시에 조회할 때 중복으로 받아오지 않는다.
fn claim_directory_refresh(app: &tauri::AppHandle) -> bool {
    load_directory(app); // 파일 → 메모리 적재
    let mut slot = directory_lock();
    let dir = slot.get_or_insert_with(Directory::default);
    let ttl = if dir.ok { DIR_TTL_OK } else { DIR_TTL_FAIL };
    if dir.updated_at > 0 && now_secs().saturating_sub(dir.updated_at) < ttl {
        return false;
    }
    dir.updated_at = now_secs();
    dir.ok = false;
    true
}

/// 필요하면 주소록을 갱신한다. 권한이 없거나 실패해도 조용히 넘어간다 — 이름은 폴백으로 채운다.
async fn ensure_directory(app: &tauri::AppHandle, cfg: &Config, access: &str) {
    if !scope_can_directory(&cfg.scope) || !claim_directory_refresh(app) {
        return;
    }
    if let Some(names) = fetch_directory(access).await {
        merge_names(app, names, Some(true));
    }
}

/// 브라우저 리다이렉트로 돌아온 인증 코드를 로컬 리스너에서 받는다.
fn wait_for_code(
    listener: TcpListener,
    expected_state: String,
    timeout: Duration,
) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + timeout;

    loop {
        if Instant::now() > deadline {
            return Err("timeout".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or("");
                let query = path.split('?').nth(1).unwrap_or("");

                let (mut code, mut state, mut err) = (None, None, None);
                for pair in query.split('&') {
                    let mut it = pair.splitn(2, '=');
                    let k = it.next().unwrap_or("");
                    let v = it.next().unwrap_or("");
                    let dv = urlencoding::decode(v)
                        .map(|s| s.into_owned())
                        .unwrap_or_default();
                    match k {
                        "code" => code = Some(dv),
                        "state" => state = Some(dv),
                        "error" => err = Some(dv),
                        _ => {}
                    }
                }

                let body = "<html><head><meta charset=\"utf-8\"></head>\
                    <body style=\"font-family:-apple-system,sans-serif;padding:48px;text-align:center\">\
                    <h2>My Space 연동 완료 ✅</h2><p>이 창을 닫고 앱으로 돌아가세요.</p></body></html>";
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.as_bytes().len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();

                if let Some(e) = err {
                    return Err(e);
                }
                match (code, state) {
                    (Some(c), Some(s)) if s == expected_state => return Ok(c),
                    // favicon 등 code 없는 요청은 무시하고 계속 기다린다.
                    _ => continue,
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// 토큰 엔드포인트 POST(form). 오류면 error 문자열 반환.
async fn post_token(params: &[(&str, &str)]) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://oauth2.googleapis.com/token")
        .form(params)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        let desc = v
            .get("error_description")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        return Err(format!("{}: {}", err.as_str().unwrap_or("error"), desc));
    }
    Ok(v)
}

/// refresh_token 으로 access_token 을 갱신한다.
async fn access_token(cfg: &Config) -> Result<String, String> {
    let v = post_token(&[
        ("client_id", &cfg.client_id),
        ("client_secret", &cfg.client_secret),
        ("refresh_token", &cfg.refresh_token),
        ("grant_type", "refresh_token"),
    ])
    .await?;
    v.get("access_token")
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| "no_access_token".into())
}

/// access_token 으로 내 계정의 (이메일, 이름) 조회. 이름은 profile 스코프가 있어야 온다.
async fn fetch_profile(access: &str) -> (String, String) {
    let get = |key: &'static str, v: &Value| {
        v.get(key)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    let client = reqwest::Client::new();
    let v: Option<Value> = async {
        client
            .get("https://www.googleapis.com/oauth2/v2/userinfo")
            .bearer_auth(access)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()
    }
    .await;
    match v {
        Some(v) => (get("email", &v), get("name", &v)),
        None => (String::new(), String::new()),
    }
}

/// 저장된 연동 상태.
#[tauri::command]
pub fn gcal_status(app: tauri::AppHandle) -> Result<GcalStatus, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        Ok(GcalStatus {
            connected: false,
            email: None,
            can_write: false,
            can_directory: false,
        })
    } else {
        Ok(GcalStatus {
            connected: true,
            email: if cfg.email.is_empty() {
                None
            } else {
                Some(cfg.email)
            },
            can_write: scope_can_write(&cfg.scope),
            can_directory: scope_can_directory(&cfg.scope),
        })
    }
}

/// 연동 해제(저장 토큰 삭제). 참석자 이름 사전도 함께 버린다.
#[tauri::command]
pub fn gcal_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(path) = config_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(path) = directory_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    *directory_lock() = None;
    Ok(())
}

/// OAuth 로그인 시작: 브라우저를 열고 루프백으로 코드를 받아 토큰을 저장한다.
#[tauri::command]
pub async fn gcal_start_auth(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<GcalStatus, String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("client_id 와 client_secret 을 모두 입력하세요".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let state = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos().to_string())
        .unwrap_or_else(|_| "state".into());

    let auth_url = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&state={}",
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(SCOPE),
        urlencoding::encode(&state),
    );

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    // 브라우저 로그인 완료(코드 수신)를 블로킹 스레드에서 기다린다.
    let code = tokio::task::spawn_blocking(move || wait_for_code(listener, state, AUTH_TIMEOUT))
        .await
        .map_err(|e| e.to_string())??;

    // code → 토큰 교환
    let tokens = post_token(&[
        ("client_id", &client_id),
        ("client_secret", &client_secret),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
    ])
    .await?;

    let refresh_token = tokens
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .map(String::from)
        .ok_or_else(|| {
            "refresh_token 이 오지 않았습니다. 동의 화면에서 권한을 새로 승인해 주세요.".to_string()
        })?;
    let access = tokens
        .get("access_token")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    // 실제 승인된 scope(부분 동의 가능) — 없으면 요청한 SCOPE 로 간주.
    let scope = tokens
        .get("scope")
        .and_then(|x| x.as_str())
        .unwrap_or(SCOPE)
        .to_string();
    let (email, name) = fetch_profile(access).await;

    let cfg = Config {
        client_id,
        client_secret,
        refresh_token,
        email: email.clone(),
        name: name.clone(),
        scope: scope.clone(),
    };
    write_config(&app, &cfg)?;

    // 새 계정으로 붙었으니 이전 사전은 버리고, 내 이름부터 넣어 둔다.
    *directory_lock() = Some(Directory::default());
    if !email.is_empty() && !name.is_empty() {
        merge_names(&app, HashMap::from([(email.to_lowercase(), name)]), None);
    }

    Ok(GcalStatus {
        connected: true,
        email: if email.is_empty() { None } else { Some(email) },
        can_write: scope_can_write(&scope),
        can_directory: scope_can_directory(&scope),
    })
}

/// 오늘(로컬 타임존) 일정 조회.
#[tauri::command]
pub async fn gcal_today(app: tauri::AppHandle) -> Result<Vec<CalendarEvent>, String> {
    // 오늘 00:00 ~ 내일 00:00 (로컬)
    use chrono::{Duration as ChronoDuration, Local, TimeZone};
    let today = Local::now().date_naive();
    let start = Local
        .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or("time_error")?;
    let end = start + ChronoDuration::days(1);
    fetch_events(&app, "primary", &start.to_rfc3339(), &end.to_rfc3339()).await
}

/// 이번주 + 다음주 범위(오늘 00:00 ~ 다음다음주 월요일 00:00, 로컬)를 rfc3339 로 계산한다.
/// 주는 월요일에 시작한다. 프론트는 event.start 가 "다음주 월요일" 이전이면 이번주로 나눈다.
fn upcoming_range() -> Result<(String, String), String> {
    use chrono::{Datelike, Duration as ChronoDuration, Local, TimeZone};
    let today = Local::now().date_naive();
    let start = Local
        .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or("time_error")?;
    let from_monday = today.weekday().num_days_from_monday() as i64;
    let this_monday = today - ChronoDuration::days(from_monday);
    let end_date = this_monday + ChronoDuration::days(14);
    let end = Local
        .from_local_datetime(&end_date.and_hms_opt(0, 0, 0).unwrap())
        .single()
        .ok_or("time_error")?;
    Ok((start.to_rfc3339(), end.to_rfc3339()))
}

/// 이번주 + 다음주 내 일정 조회(primary).
#[tauri::command]
pub async fn gcal_upcoming(app: tauri::AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let (min, max) = upcoming_range()?;
    fetch_events(&app, "primary", &min, &max).await
}

/// 내 구글 캘린더 목록(구독 캘린더) — 회의실 선택용.
#[tauri::command]
pub async fn gcal_calendars(app: tauri::AppHandle) -> Result<Vec<CalendarInfo>, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;
    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://www.googleapis.com/calendar/v3/users/me/calendarList")
        .bearer_auth(&access)
        .query(&[("minAccessRole", "reader"), ("maxResults", "250")])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("calendar_error");
        return Err(msg.to_string());
    }
    let mut out = Vec::new();
    if let Some(items) = v.get("items").and_then(|x| x.as_array()) {
        for it in items {
            let id = it.get("id").and_then(|x| x.as_str()).unwrap_or("");
            if id.is_empty() {
                continue;
            }
            let summary = it
                .get("summaryOverride")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| it.get("summary").and_then(|x| x.as_str()))
                .unwrap_or(id)
                .to_string();
            out.push(CalendarInfo {
                id: id.to_string(),
                summary,
                primary: it.get("primary").and_then(|x| x.as_bool()).unwrap_or(false),
            });
        }
    }
    Ok(out)
}

/// 특정 캘린더(회의실)의 이번주+다음주 일정 조회.
#[tauri::command]
pub async fn gcal_calendar_events(
    app: tauri::AppHandle,
    calendar_id: String,
) -> Result<Vec<CalendarEvent>, String> {
    let (min, max) = upcoming_range()?;
    fetch_events(&app, &calendar_id, &min, &max).await
}

/// 주어진 캘린더의 로컬 범위(RFC3339) 일정을 시간순으로 가져온다.
async fn fetch_events(
    app: &tauri::AppHandle,
    calendar_id: &str,
    time_min: &str,
    time_max: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let cfg = read_config(app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;
    // 참석자 이름용 도메인 주소록(주기적으로만 갱신, 실패해도 무시).
    ensure_directory(app, &cfg, &access).await;

    let client = reqwest::Client::new();
    let url = format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events",
        urlencoding::encode(calendar_id)
    );
    let v: Value = client
        .get(&url)
        .bearer_auth(&access)
        .query(&[
            ("timeMin", time_min),
            ("timeMax", time_max),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "100"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("calendar_error");
        return Err(msg.to_string());
    }

    // 이번 응답에서 새로 알게 된 이름을 사전에 합친 뒤, 그 사전으로 참석자 이름을 채운다.
    merge_names(app, learn_names(&v), None);
    let names = load_directory(app).names;

    let mut events = Vec::new();
    if let Some(items) = v.get("items").and_then(|x| x.as_array()) {
        for it in items {
            // 취소된 일정 제외
            if it.get("status").and_then(|x| x.as_str()) == Some("cancelled") {
                continue;
            }
            let start_obj = it.get("start").cloned().unwrap_or_default();
            let end_obj = it.get("end").cloned().unwrap_or_default();
            let all_day = start_obj.get("date").is_some();
            let start = start_obj
                .get("dateTime")
                .or_else(|| start_obj.get("date"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let end = end_obj
                .get("dateTime")
                .or_else(|| end_obj.get("date"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();

            let meet_link = it
                .get("hangoutLink")
                .and_then(|x| x.as_str())
                .map(String::from)
                .or_else(|| {
                    it.pointer("/conferenceData/entryPoints")
                        .and_then(|x| x.as_array())
                        .and_then(|arr| {
                            arr.iter()
                                .find(|e| {
                                    e.get("entryPointType").and_then(|t| t.as_str())
                                        == Some("video")
                                })
                                .and_then(|e| e.get("uri").and_then(|u| u.as_str()))
                                .map(String::from)
                        })
                });

            events.push(CalendarEvent {
                summary: it
                    .get("summary")
                    .and_then(|x| x.as_str())
                    .unwrap_or("(제목 없음)")
                    .to_string(),
                start,
                end,
                all_day,
                location: it
                    .get("location")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                html_link: it
                    .get("htmlLink")
                    .and_then(|x| x.as_str())
                    .map(String::from),
                meet_link,
                attendees: parse_attendees(it, &names),
                event_type: it
                    .get("eventType")
                    .and_then(|x| x.as_str())
                    .unwrap_or("default")
                    .to_string(),
            });
        }
    }
    Ok(events)
}

/// 회의실 예약 — 내 primary 캘린더에 일정을 만들고 회의실을 리소스로 첨부한다.
/// date="YYYY-MM-DD", start_hm/end_hm="HH:MM" (로컬). 겹치면 예약 없이 오류를 낸다.
#[tauri::command]
pub async fn gcal_book_room(
    app: tauri::AppHandle,
    room_id: String,
    room_name: String,
    title: String,
    date: String,
    start_hm: String,
    end_hm: String,
) -> Result<CalendarEvent, String> {
    use chrono::{Local, NaiveDate, NaiveTime, TimeZone};

    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    if !scope_can_write(&cfg.scope) {
        return Err("need_reconnect".into());
    }

    let day = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|_| "날짜 형식이 올바르지 않습니다".to_string())?;
    let parse_hm = |s: &str| {
        NaiveTime::parse_from_str(s.trim(), "%H:%M")
            .map_err(|_| "시각 형식이 올바르지 않습니다".to_string())
    };
    let st = parse_hm(&start_hm)?;
    let et = parse_hm(&end_hm)?;
    if et <= st {
        return Err("종료 시각이 시작 시각보다 뒤여야 합니다".into());
    }
    let start_dt = Local
        .from_local_datetime(&day.and_time(st))
        .single()
        .ok_or("time_error")?;
    let end_dt = Local
        .from_local_datetime(&day.and_time(et))
        .single()
        .ok_or("time_error")?;
    let time_min = start_dt.to_rfc3339();
    let time_max = end_dt.to_rfc3339();

    // 이미 예약된 시간대여도 그대로 예약을 진행한다(사용자 요청 — 중복 예약 허용).
    // 내 캘린더에 이벤트 생성 + 회의실을 리소스 참석자로 첨부.
    let access = access_token(&cfg).await?;
    let body = serde_json::json!({
        "summary": if title.trim().is_empty() { "회의" } else { title.trim() },
        "start": { "dateTime": time_min, "timeZone": "Asia/Seoul" },
        "end": { "dateTime": time_max, "timeZone": "Asia/Seoul" },
        "attendees": [ { "email": room_id, "resource": true, "displayName": room_name } ],
    });

    let client = reqwest::Client::new();
    let v: Value = client
        .post("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .bearer_auth(&access)
        .query(&[("sendUpdates", "none"), ("conferenceDataVersion", "0")])
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("calendar_error");
        return Err(msg.to_string());
    }

    let start_obj = v.get("start").cloned().unwrap_or_default();
    let end_obj = v.get("end").cloned().unwrap_or_default();
    Ok(CalendarEvent {
        summary: v
            .get("summary")
            .and_then(|x| x.as_str())
            .unwrap_or("회의")
            .to_string(),
        start: start_obj
            .get("dateTime")
            .and_then(|x| x.as_str())
            .unwrap_or(&time_min)
            .to_string(),
        end: end_obj
            .get("dateTime")
            .and_then(|x| x.as_str())
            .unwrap_or(&time_max)
            .to_string(),
        all_day: false,
        location: Some(room_name),
        html_link: v.get("htmlLink").and_then(|x| x.as_str()).map(String::from),
        meet_link: None,
        // 예약은 회의실(리소스)만 첨부하므로 사람 참석자는 없다.
        attendees: parse_attendees(&v, &HashMap::new()),
        event_type: "default".to_string(),
    })
}

// ── 다른 구성원 일정 ────────────────────────────────────────────────────────────
//
// 도메인 구성원을 골라 그 사람의 캘린더를 그대로 조회한다. Workspace 기본 공개 범위에 따라
// 두 갈래로 갈리므로 둘 다 지원한다:
//   - "모든 정보 보기" → events API 로 제목·장소·참석자까지 (access = "full")
//   - "한가함/바쁨"    → events 가 403/404 → freeBusy API 로 구간만 (access = "busy")
// 둘 다 막히면 denied 로 돌려주고 UI 에서 사유를 보여준다(한 명이 막혀도 나머지는 보여야 한다).

/// 도메인 구성원 한 명(일정 조회 대상 검색용).
#[derive(Serialize)]
pub struct Person {
    email: String,
    name: String,
}

/// 구성원 한 명의 일정 조회 결과.
#[derive(Serialize)]
pub struct PersonSchedule {
    email: String,
    /// "full" = 제목까지 보이는 상세 일정, "busy" = 바쁨 구간만, "denied" = 볼 수 없음.
    access: String,
    events: Vec<CalendarEvent>,
    /// access == "denied" 일 때의 원인.
    error: Option<String>,
}

/// 구성원 검색 목록 — 참석자 이름 사전(도메인 주소록)을 그대로 쓴다.
/// 캐시가 비었거나 `force` 면 지금 받아오고, 아니면 캐시를 즉시 돌려준다(검색은 로컬에서 한다).
#[tauri::command]
pub async fn gcal_people(app: tauri::AppHandle, force: bool) -> Result<Vec<Person>, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    if (force || load_directory(&app).names.is_empty()) && scope_can_directory(&cfg.scope) {
        let access = access_token(&cfg).await?;
        match fetch_directory(&access).await {
            Some(names) => merge_names(&app, names, Some(true)),
            None => merge_names(&app, HashMap::new(), Some(false)),
        }
    }

    let names = load_directory(&app).names;
    if names.is_empty() {
        return Err(if scope_can_directory(&cfg.scope) {
            "directory_unavailable"
        } else {
            "need_directory_scope"
        }
        .into());
    }
    let mut out: Vec<Person> = names
        .into_iter()
        .map(|(email, name)| Person { email, name })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.email.cmp(&b.email)));
    Ok(out)
}

/// 구성원 한 명의 이번주+다음주 일정. 상세가 막히면 바쁨 구간으로 폴백한다.
#[tauri::command]
pub async fn gcal_person_events(
    app: tauri::AppHandle,
    email: String,
) -> Result<PersonSchedule, String> {
    let (min, max) = upcoming_range()?;
    let detail = match fetch_events(&app, &email, &min, &max).await {
        Ok(events) => {
            return Ok(PersonSchedule {
                email,
                access: "full".into(),
                events,
                error: None,
            })
        }
        Err(e) => e,
    };

    // 상세가 막혔다 — 공개 범위가 "한가함/바쁨" 뿐일 수 있으니 구간만 받아 본다.
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;
    match fetch_free_busy(&access, &email, &min, &max).await {
        Ok(events) => Ok(PersonSchedule {
            email,
            access: "busy".into(),
            events,
            error: None,
        }),
        Err(_) => Ok(PersonSchedule {
            email,
            access: "denied".into(),
            events: Vec::new(),
            // 상세 조회 쪽 오류가 원인을 더 잘 설명한다.
            error: Some(detail),
        }),
    }
}

/// freeBusy API — 제목 없이 "바쁨" 구간만 가져온다.
async fn fetch_free_busy(
    access: &str,
    email: &str,
    time_min: &str,
    time_max: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let client = reqwest::Client::new();
    let v: Value = client
        .post("https://www.googleapis.com/calendar/v3/freeBusy")
        .bearer_auth(access)
        .json(&serde_json::json!({
            "timeMin": time_min,
            "timeMax": time_max,
            "items": [ { "id": email } ],
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("freebusy_error");
        return Err(msg.to_string());
    }
    // items 에 한 명만 넣었으므로 calendars 의 첫 항목이 그 사람이다
    // (키는 요청한 이메일의 정규화된 형태라 그대로 찾으면 어긋날 수 있다).
    let cal = v
        .get("calendars")
        .and_then(|x| x.as_object())
        .and_then(|m| m.values().next())
        .ok_or_else(|| "freebusy_error".to_string())?;
    if let Some(errs) = cal.get("errors").and_then(|x| x.as_array()) {
        let reason = errs
            .first()
            .and_then(|e| e.get("reason"))
            .and_then(|x| x.as_str())
            .unwrap_or("notFound");
        return Err(reason.to_string());
    }

    let mut out = Vec::new();
    for b in cal
        .get("busy")
        .and_then(|x| x.as_array())
        .into_iter()
        .flatten()
    {
        let (Some(start), Some(end)) = (
            b.get("start").and_then(|x| x.as_str()),
            b.get("end").and_then(|x| x.as_str()),
        ) else {
            continue;
        };
        out.push(CalendarEvent {
            summary: "바쁨".into(),
            start: start.to_string(),
            end: end.to_string(),
            all_day: false,
            location: None,
            html_link: None,
            meet_link: None,
            attendees: Vec::new(),
            event_type: "default".into(),
        });
    }
    Ok(out)
}
