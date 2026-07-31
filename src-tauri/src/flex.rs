//! Flex(flex.team) 휴가/일정 연동 — 공개 API 가 없어 웹 API 를 그대로 호출한다.
//!
//! 인증은 두 갈래를 순서대로 시도한다.
//!  1. 메모리 캐시 — 직전에 통했던 Cookie 헤더(자동 로그인 결과 포함).
//!  2. 저장된 계정으로 **자동 로그인**(아래).
//!
//! 계정은 설정 → Flex 휴가에서 등록한다. (예전에는 Chrome 에 로그인된 flex 세션
//! 쿠키를 재사용하는 갈래도 있었지만, 계정 로그인만 지원하도록 제거했다.)
//!
//! ── 자동 로그인 ──
//! 로그인 화면이 쓰는 내부 API 를 그대로 호출한다(브라우저를 띄우지 않는다).
//! 5단계이고, 2~4단계는 1단계에서 받은 세션 id 를 `FlexTeam-V2-Login-Session-Id`
//! 헤더로 들고 다닌다. 비밀번호는 클라이언트에서 암호화하지 않는다(웹도 평문 전송).
//!
//! ```text
//! POST /api-public/v2/auth/challenge                 {}                    → sessionId
//! POST /api-public/v2/auth/verification/identifier   {"identifier": 이메일}
//! POST /api-public/v2/auth/authentication/password   {"password": 비밀번호}
//! POST /api-public/v2/auth/authorization             {}                    → 워크스페이스 accessToken
//! POST /api-public/v2/auth/tokens/customer-user/exchange/all               → AID 토큰
//!        (헤더 FlexTeam-V2-Workspace-Access: 워크스페이스 accessToken)
//! ```
//!
//! 마지막 AID 토큰을 `Cookie: AID=<토큰>` 으로 붙이면 `/api/v2/...` 가 열린다(약 12시간 유효).
//! 웹도 이 값을 `AID` 쿠키에 넣어 쓴다. 만료되면 401 → 다시 로그인한다.
//!
//! OTP·SSO 처럼 비밀번호만으로 끝나지 않는 계정은 중간 단계에서 걸리며, 그때는 서버가 준
//! 한국어 메시지를 그대로 올려 보낸다.
//!
//! 계정은 앱 설정 디렉터리의 `flex.json` 에 저장하고, 비밀번호는 이 맥의 하드웨어
//! UUID 로 유도한 키로 AES-128-CBC 암호화해 둔다(파일만 유출돼선 못 푼다. 같은 기기에서
//! 앱 소스를 아는 사람은 풀 수 있는 수준의 보호다).
//!
//! 응답은 아직 스키마를 확정하지 않아 raw JSON(Value)으로 그대로 프론트에 넘긴다.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::Engine;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

const BASE: &str = "https://flex.team";
/// 로그인이 살아 있는지 확인할 때 때리는 가장 가벼운 API.
const PROBE_PATH: &str = "/api/v2/calendar/calendars/primary";
/// 계정 저장 파일(앱 설정 디렉터리).
const CONFIG_FILE: &str = "flex.json";
/// 로그인 세션 id 를 실어 나르는 헤더.
const LOGIN_SESSION_HEADER: &str = "FlexTeam-V2-Login-Session-Id";
/// 워크스페이스 토큰 → 사용자 토큰 교환에 쓰는 헤더.
const WORKSPACE_ACCESS_HEADER: &str = "FlexTeam-V2-Workspace-Access";
const UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MySpace";

/// 이벤트 조회 시 함께 요청하는 유형/상태(사용자가 준 URL 과 동일).
const EVENT_TYPES: [&str; 5] = [
    "MEETING",
    "TIME_OFF",
    "WORK_RECORD",
    "BIRTHDAY",
    "COMPANY_JOIN_DAY",
];
const STATUSES: [&str; 2] = ["CONFIRMED", "TENTATIVE"];

/// 직전에 통했던 Cookie 헤더. Chrome 쿠키를 매번 복호화하지 않으려는 캐시이기도 하다.
/// 401 이 나면 비운다.
static SESSION: Mutex<Option<String>> = Mutex::new(None);
/// 자동 로그인 동시 실행 방지 — 화면 여러 곳에서 동시에 새로고침해도 로그인은 한 번만.
static LOGIN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/* ────────────────────────────── 계정 저장 ────────────────────────────── */

#[derive(Serialize, Deserialize, Default)]
struct FlexConfig {
    /// 로그인 이메일(평문 — 비밀이 아니다).
    #[serde(default)]
    email: String,
    /// AES-128-CBC 로 암호화한 비밀번호(base64). 비어 있으면 저장된 비밀번호 없음.
    #[serde(default)]
    password_enc: String,
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_dir(app)?.join(CONFIG_FILE))
}

fn read_config(app: &tauri::AppHandle) -> FlexConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<FlexConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_config(app: &tauri::AppHandle, cfg: &FlexConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    // 비밀번호가 들어 있으니 본인만 읽게 한다(0600).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 이 맥에 묶인 비밀 문자열. 하드웨어 UUID 를 쓰고, 못 읽으면 고정값으로 떨어진다.
fn machine_secret() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            if let Ok(text) = String::from_utf8(out.stdout) {
                if let Some(line) = text.lines().find(|l| l.contains("IOPlatformUUID")) {
                    if let Some(uuid) = line.split('"').nth(3) {
                        return format!("myspace-flex:{uuid}");
                    }
                }
            }
        }
    }
    "myspace-flex:fallback".to_string()
}

/// 기기 비밀 → AES 키·IV.
fn derive_key_iv() -> ([u8; 16], [u8; 16]) {
    let secret = machine_secret();
    let mut key = [0u8; 16];
    let mut iv = [0u8; 16];
    pbkdf2_hmac::<Sha1>(secret.as_bytes(), b"myspace-flex-key", 4096, &mut key);
    pbkdf2_hmac::<Sha1>(secret.as_bytes(), b"myspace-flex-iv", 4096, &mut iv);
    (key, iv)
}

fn encrypt_password(plain: &str) -> String {
    let (key, iv) = derive_key_iv();
    let ct = Aes128CbcEnc::new(GenericArray::from_slice(&key), GenericArray::from_slice(&iv))
        .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(ct)
}

fn decrypt_password(enc: &str) -> Option<String> {
    if enc.is_empty() {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(enc).ok()?;
    let (key, iv) = derive_key_iv();
    let pt = Aes128CbcDec::new(GenericArray::from_slice(&key), GenericArray::from_slice(&iv))
        .decrypt_padded_vec_mut::<Pkcs7>(&raw)
        .ok()?;
    String::from_utf8(pt).ok()
}

/// 저장된 (이메일, 비밀번호). 둘 중 하나라도 없으면 None.
fn saved_credentials(app: &tauri::AppHandle) -> Option<(String, String)> {
    let cfg = read_config(app);
    if cfg.email.trim().is_empty() {
        return None;
    }
    let pw = decrypt_password(&cfg.password_enc)?;
    if pw.is_empty() {
        return None;
    }
    Some((cfg.email, pw))
}

/* ────────────────────────────── 쿠키 캐시 ────────────────────────────── */

fn cached_cookie() -> Option<String> {
    SESSION.lock().ok().and_then(|g| g.clone())
}

fn remember_cookie(cookie: &str) {
    if let Ok(mut g) = SESSION.lock() {
        *g = Some(cookie.to_string());
    }
}

fn forget_cookie() {
    if let Ok(mut g) = SESSION.lock() {
        *g = None;
    }
}

/// 시도할 쿠키 후보 — 지금은 캐시된 세션 하나뿐이다(없으면 빈 목록 → 자동 로그인).
fn cookie_candidates() -> Vec<String> {
    cached_cookie().into_iter().collect()
}

/* ────────────────────────────── HTTP 호출 ────────────────────────────── */

enum SendError {
    /// 401/403 — 이 쿠키로는 안 된다(다음 후보/자동 로그인으로).
    Unauthorized,
    Other(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::Unauthorized => write!(f, "not_logged_in"),
            SendError::Other(e) => write!(f, "{e}"),
        }
    }
}

/// 쿠키 하나로 flex API 를 한 번 호출한다. body 가 Some 이면 POST(JSON), None 이면 GET.
async fn send(url: &str, body: Option<&Value>, cookie: &str) -> Result<Value, SendError> {
    let client = http();
    let mut req = match body {
        Some(_) => client.post(url),
        None => client.get(url),
    };
    req = req
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, UA);
    if let Some(b) = body {
        req = req.json(b);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| SendError::Other(e.to_string()))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| SendError::Other(e.to_string()))?;
    if !status.is_success() {
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(SendError::Unauthorized);
        }
        return Err(SendError::Other(format!(
            "flex_error {}: {}",
            status.as_u16(),
            text
        )));
    }
    serde_json::from_str::<Value>(&text).map_err(|e| SendError::Other(format!("json_parse: {e}")))
}

/// 이 쿠키로 로그인이 살아 있는지 확인.
async fn probe(cookie: &str) -> bool {
    send(&format!("{BASE}{PROBE_PATH}"), None, cookie)
        .await
        .is_ok()
}

/// 후보 쿠키를 차례로 써 보고, 전부 401 이면 저장된 계정으로 자동 로그인해 한 번 더 시도한다.
async fn flex_request(
    app: &tauri::AppHandle,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, String> {
    for cookie in cookie_candidates() {
        match send(url, body, &cookie).await {
            Ok(v) => {
                remember_cookie(&cookie);
                return Ok(v);
            }
            Err(SendError::Unauthorized) => forget_cookie(),
            Err(SendError::Other(e)) => return Err(e),
        }
    }

    // 쿠키가 없거나 전부 만료 — 계정이 저장돼 있으면 자동 로그인.
    if saved_credentials(app).is_none() {
        return Err("not_logged_in".into());
    }
    let cookie = auto_login(app).await?;
    send(url, body, &cookie).await.map_err(|e| e.to_string())
}

async fn flex_get(app: &tauri::AppHandle, url: &str) -> Result<Value, String> {
    flex_request(app, url, None).await
}

/* ────────────────────────────── 자동 로그인 ────────────────────────────── */

/// 로그인 단계 하나. 실패하면 서버가 준 한국어 메시지를 그대로 올린다
/// ("계정 또는 비밀번호에 오류가 있어요." 처럼 그대로 보여 주면 되는 문구다).
async fn auth_post(path: &str, body: &Value, headers: &[(&str, &str)]) -> Result<Value, String> {
    let mut req = http()
        .post(format!("{BASE}{path}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, UA)
        .header(reqwest::header::ORIGIN, BASE)
        .header(reqwest::header::REFERER, format!("{BASE}/auth/login"))
        .json(body);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<Value>(&text).ok();

    if !status.is_success() {
        let msg = parsed
            .as_ref()
            .and_then(|v| v["message"].as_str().or_else(|| v["detail"].as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("로그인 실패({})", status.as_u16()));
        return Err(msg);
    }
    parsed.ok_or_else(|| format!("json_parse: {path}"))
}

/// 이메일·비밀번호로 로그인해 API 에 붙일 Cookie 헤더를 만든다.
async fn http_login(email: &str, password: &str) -> Result<String, String> {
    // 1) 로그인 세션 열기.
    let challenge = auth_post("/api-public/v2/auth/challenge", &json!({}), &[]).await?;
    let sid = challenge["sessionId"]
        .as_str()
        .ok_or("로그인 세션을 열지 못했습니다.")?
        .to_string();
    let session = [(LOGIN_SESSION_HEADER, sid.as_str())];

    // 2) 이메일 확인. SSO 전용 계정 등은 여기서 AUTHENTICATION 으로 넘어가지 않는다.
    let verified = auth_post(
        "/api-public/v2/auth/verification/identifier",
        &json!({ "identifier": email }),
        &session,
    )
    .await?;
    if verified["nextStep"] != "AUTHENTICATION" {
        return Err(format!(
            "비밀번호 로그인을 쓸 수 없는 계정입니다(다음 단계: {}).",
            verified["nextStep"]
        ));
    }

    // 3) 비밀번호. OTP 등이 더 필요하면 AUTHORIZATION 으로 넘어가지 않는다.
    let authed = auth_post(
        "/api-public/v2/auth/authentication/password",
        &json!({ "password": password }),
        &session,
    )
    .await?;
    if authed["nextStep"] != "AUTHORIZATION" {
        return Err(format!(
            "추가 인증이 필요한 계정입니다(다음 단계: {}).",
            authed["nextStep"]
        ));
    }

    // 4) 워크스페이스 토큰 발급.
    let authorized = auth_post("/api-public/v2/auth/authorization", &json!({}), &session).await?;
    let workspace_token = authorized
        .pointer("/v2Response/workspaceToken/accessToken/token")
        .and_then(|v| v.as_str())
        .ok_or("워크스페이스 토큰을 받지 못했습니다.")?
        .to_string();

    // 5) 워크스페이스 토큰 → 사용자 토큰(AID) 교환.
    let granted = auth_post(
        "/api-public/v2/auth/tokens/customer-user/exchange/all",
        &json!({}),
        &[(WORKSPACE_ACCESS_HEADER, workspace_token.as_str())],
    )
    .await?;
    let aid = granted
        .pointer("/tokens/0/token")
        .and_then(|v| v.as_str())
        .ok_or("사용자 토큰을 받지 못했습니다.")?;

    // 웹이 쓰는 것과 같은 쿠키 이름. AID 만 있어도 열리지만 버전 표시도 같이 보낸다.
    Ok(format!("FlexTeam-Version=V2; AID={aid}"))
}

/// 저장된 계정으로 로그인해 Cookie 헤더를 돌려준다(동시 호출은 한 번만 실제로 로그인).
async fn auto_login(app: &tauri::AppHandle) -> Result<String, String> {
    let _guard = LOGIN_LOCK.lock().await;

    // 기다리는 동안 다른 호출이 이미 로그인해 놨을 수 있다.
    if let Some(c) = cached_cookie() {
        if probe(&c).await {
            return Ok(c);
        }
        forget_cookie();
    }

    let (email, password) = saved_credentials(app).ok_or("no_credentials")?;
    let cookie = http_login(&email, &password).await?;
    remember_cookie(&cookie);
    log::info!("flex: 자동 로그인 성공");
    Ok(cookie)
}

/* ────────────────────────────── 커맨드 ────────────────────────────── */

/// 조직(구성원) 정보. 프론트에서 localStorage 에 캐시해 새로고침 전까지 재사용한다.
#[tauri::command]
pub async fn flex_coworkers(app: tauri::AppHandle) -> Result<Value, String> {
    flex_get(
        &app,
        &format!("{BASE}/api/v2/calendar/calendars/coworkers?size=500"),
    )
    .await
}

/// 내 정보(primary 캘린더). `token` 이 내 calendarId — **이름도 부서도 없다.**
#[tauri::command]
pub async fn flex_primary(app: tauri::AppHandle) -> Result<Value, String> {
    flex_get(&app, &format!("{BASE}{PROBE_PATH}")).await
}

/// 로그인한 나 자신 — **이름과 부서**.
///
/// 두 번 호출해서 만든다. primary 는 이름도 부서도 주지 않지만 `customerIdHash`(회사)와
/// `userIdHash`(나)를 주고, 그 둘로 구성원 검색을 부르면 내 인사 레코드가 나온다.
/// coworkers 목록에는 나 자신이 아예 빠져 있어서 이 경로가 내 부서를 아는 유일한 길이다.
///
/// ```text
/// GET /api/v2/calendar/calendars/primary                                  → customerIdHash, userIdHash
/// GET /api/v2/search/customers/{customerIdHash}/search-users/{userIdHash} → [{ departments, user{…} }]
/// ```
///
/// 두 번째 경로는 flex 웹 번들의 생성 클라이언트(`UserSearchControllerApi.searchUserByIds`)에서
/// 그대로 가져왔다. `userIdHashes` 는 콤마로 여러 명도 되지만 여기선 나 하나만 쓴다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlexMe {
    pub user_id_hash: String,
    /// 표시 이름(없으면 빈 문자열).
    pub name: String,
    /// 소속 부서명. 여러 직책이 있으면 `isPrimary` 인 것을 쓴다.
    pub department: Option<String>,
}

/// 검색 결과 한 건(`{ departments:[{name}], user:{ displayName, positions:[…] } }`)에서
/// 이름·부서를 뽑는다. 직책이 여러 개면 `isPrimary` 인 것이 소속이고, `positions` 가
/// 없으면 `departments` 의 첫 부서로 떨어진다.
fn me_from_search(user_id_hash: &str, rec: &Value) -> FlexMe {
    let department = rec["user"]["positions"]
        .as_array()
        .and_then(|ps| {
            ps.iter()
                .find(|p| p["isPrimary"].as_bool() == Some(true))
                .or_else(|| ps.first())
        })
        .and_then(|p| p["departmentName"].as_str())
        .or_else(|| rec["departments"][0]["name"].as_str())
        .map(|s| s.to_string());

    FlexMe {
        user_id_hash: user_id_hash.to_string(),
        name: rec["user"]["displayName"]
            .as_str()
            .or_else(|| rec["user"]["name"].as_str())
            .unwrap_or_default()
            .to_string(),
        department,
    }
}

#[tauri::command]
pub async fn flex_me(app: tauri::AppHandle) -> Result<FlexMe, String> {
    let primary = flex_get(&app, &format!("{BASE}{PROBE_PATH}")).await?;
    let customer = primary["customerIdHash"]
        .as_str()
        .ok_or("primary 응답에 customerIdHash 가 없습니다")?;
    let user_hash = primary["userIdHash"]
        .as_str()
        .ok_or("primary 응답에 userIdHash 가 없습니다")?;

    let found = flex_get(
        &app,
        &format!("{BASE}/api/v2/search/customers/{customer}/search-users/{user_hash}"),
    )
    .await?;
    // 응답은 검색 결과 배열이다(요청한 해시가 하나여도 배열).
    let rec = found
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(Value::Null);

    Ok(me_from_search(user_hash, &rec))
}

/// 기간 내 일정(휴가/회의/근무기록/생일/입사일).
/// POST 이며 body 에 조회할 구성원들의 캘린더 ID 목록을 담는다(coworkers 응답에서 수집).
/// date_min/date_max 는 RFC3339 문자열.
#[tauri::command]
pub async fn flex_events(
    app: tauri::AppHandle,
    date_min: String,
    date_max: String,
    calendar_ids: Vec<String>,
) -> Result<Value, String> {
    let mut url = format!(
        "{BASE}/api/v2/calendar/calendars/events?dateTimeMin={}&dateTimeMaxExclusive={}&timeZone={}&size=500",
        urlencoding::encode(&date_min),
        urlencoding::encode(&date_max),
        urlencoding::encode("Asia/Seoul"),
    );
    for t in EVENT_TYPES {
        url.push_str(&format!("&flexEventTypes={t}"));
    }
    for s in STATUSES {
        url.push_str(&format!("&statuses={s}"));
    }
    let body = serde_json::json!({ "calendarIds": calendar_ids });
    flex_request(&app, &url, Some(&body)).await
}

/// 설정 화면에 보여 줄 계정/세션 상태.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlexStatus {
    /// 저장된 로그인 이메일(없으면 null).
    pub email: Option<String>,
    /// 비밀번호까지 저장돼 자동 로그인이 가능한지.
    pub can_auto_login: bool,
    /// 지금 쓸 수 있는 세션이 있는지.
    pub logged_in: bool,
    /// 그 세션의 출처: "app"(자동 로그인) | null.
    pub source: Option<String>,
}

/// 계정 저장 여부 + 현재 세션이 살아 있는지 확인한다(설정 화면용).
#[tauri::command]
pub async fn flex_status(app: tauri::AppHandle) -> Result<FlexStatus, String> {
    let cfg = read_config(&app);
    let email = if cfg.email.trim().is_empty() {
        None
    } else {
        Some(cfg.email.clone())
    };

    // 캐시된 세션이 살아 있는지 확인한다(없거나 만료면 저장된 계정으로 자동 로그인 가능).
    let mut source = None;
    if let Some(cookie) = cached_cookie() {
        if probe(&cookie).await {
            remember_cookie(&cookie);
            source = Some("app".to_string());
        }
    }

    Ok(FlexStatus {
        email,
        can_auto_login: saved_credentials(&app).is_some(),
        logged_in: source.is_some(),
        source,
    })
}

/// 계정을 저장하고 곧바로 자동 로그인까지 시도한다(설정 화면의 "저장하고 로그인").
#[tauri::command]
pub async fn flex_save_account(
    app: tauri::AppHandle,
    email: String,
    password: String,
) -> Result<FlexStatus, String> {
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("empty_credentials".into());
    }
    write_config(
        &app,
        &FlexConfig {
            email,
            password_enc: encrypt_password(&password),
        },
    )?;
    forget_cookie();
    auto_login(&app).await?;
    flex_status(app).await
}

/// 저장된 계정을 지운다(세션 캐시도 함께 비운다).
#[tauri::command]
pub async fn flex_clear_account(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(path) = config_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    forget_cookie();
    Ok(())
}

/// 지금 바로 다시 로그인한다(설정 화면의 "다시 로그인").
#[tauri::command]
pub async fn flex_login_now(app: tauri::AppHandle) -> Result<FlexStatus, String> {
    forget_cookie();
    auto_login(&app).await?;
    flex_status(app).await
}

/// 휴가 신청 화면(내 휴가 대시보드) 주소.
const TIME_OFF_URL: &str = "https://flex.team/time-tracking/my-time-off/dashboard";

/// 휴가 신청 화면을 기본 브라우저에서 연다.
#[tauri::command]
pub async fn flex_open_time_off(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(TIME_OFF_URL, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실계정으로 `flex_me` 의 두 번 호출 흐름을 그대로 재현한다(부서가 나오는지 확인).
    #[tokio::test]
    #[ignore = "실제 계정과 네트워크가 필요하다"]
    async fn reads_my_department_for_real() {
        let home = std::env::var("HOME").expect("HOME");
        let cfg: FlexConfig = serde_json::from_str(
            &std::fs::read_to_string(
                PathBuf::from(home).join("Library/Application Support/com.rudaks.myspace/flex.json"),
            )
            .expect("flex.json"),
        )
        .expect("parse");
        let pw = decrypt_password(&cfg.password_enc).expect("복호화");
        let cookie = http_login(&cfg.email, &pw).await.expect("로그인");

        let primary = send(&format!("{BASE}{PROBE_PATH}"), None, &cookie)
            .await
            .map_err(|e| e.to_string())
            .expect("primary");
        let customer = primary["customerIdHash"].as_str().expect("customerIdHash");
        let user_hash = primary["userIdHash"].as_str().expect("userIdHash");
        let found = send(
            &format!("{BASE}/api/v2/search/customers/{customer}/search-users/{user_hash}"),
            None,
            &cookie,
        )
        .await
        .map_err(|e| e.to_string())
        .expect("search-users");

        let me = me_from_search(
            user_hash,
            found.as_array().and_then(|a| a.first()).expect("결과 1건"),
        );
        println!("이름={} / 부서={:?}", me.name, me.department);
        assert!(!me.name.is_empty(), "이름이 있어야 한다");
        assert!(me.department.is_some(), "부서가 있어야 한다");
    }

    /// 구성원 검색 응답에서 이름·부서를 뽑는다(실제 응답 구조 그대로, 값만 예시).
    #[test]
    fn reads_name_and_department_from_search() {
        let rec = json!({
            "departments": [{ "idHash": "D1", "name": "샘플본부" }],
            "user": {
                "displayName": "김샘플",
                "name": "김샘플",
                "positions": [
                    { "departmentName": "다른팀", "isPrimary": false },
                    { "departmentName": "샘플본부", "isPrimary": true },
                ],
            },
        });
        let me = me_from_search("U1", &rec);
        assert_eq!(me.user_id_hash, "U1");
        assert_eq!(me.name, "김샘플");
        // isPrimary 인 직책의 부서를 골라야 한다(배열 순서가 아니라).
        assert_eq!(me.department.as_deref(), Some("샘플본부"));
    }

    /// positions 가 없으면 departments 로 떨어지고, 아무것도 없으면 None.
    #[test]
    fn falls_back_to_departments_array() {
        let rec = json!({
            "departments": [{ "name": "샘플본부" }],
            "user": { "name": "김샘플" },
        });
        assert_eq!(
            me_from_search("U1", &rec).department.as_deref(),
            Some("샘플본부")
        );

        let empty = me_from_search("U1", &json!({}));
        assert_eq!(empty.department, None);
        assert_eq!(empty.name, "");
    }

    #[test]
    fn roundtrips_password() {
        let enc = encrypt_password("hunter2!한글");
        assert_ne!(enc, "hunter2!한글");
        assert_eq!(decrypt_password(&enc).as_deref(), Some("hunter2!한글"));
    }

    #[test]
    fn rejects_garbage_password_blob() {
        assert_eq!(decrypt_password(""), None);
        assert_eq!(decrypt_password("not-base64!!"), None);
    }

    /// 캐시된 세션이 후보로 나온다(자동 로그인 결과를 재사용).
    #[test]
    fn cached_session_is_a_candidate() {
        remember_cookie("AID=abc");
        let list = cookie_candidates();
        assert_eq!(list, vec!["AID=abc".to_string()]);
        forget_cookie();
        assert!(cookie_candidates().is_empty());
    }

    /// 실제 flex.team 에 로그인해 보는 통합 테스트 — 로그인 흐름이 바뀌면 여기서 먼저 깨진다.
    /// 계정이 필요하고 네트워크를 타므로 기본으로는 건너뛴다.
    ///
    /// ```sh
    /// FLEX_TEST_EMAIL=me@example.com FLEX_TEST_PASSWORD='...' \
    ///   cargo test --lib flex::tests::logs_in -- --ignored --nocapture
    /// ```
    #[tokio::test]
    #[ignore = "실제 계정과 네트워크가 필요하다"]
    async fn logs_in_and_reads_primary() {
        let (Ok(email), Ok(password)) = (
            std::env::var("FLEX_TEST_EMAIL"),
            std::env::var("FLEX_TEST_PASSWORD"),
        ) else {
            panic!("FLEX_TEST_EMAIL / FLEX_TEST_PASSWORD 환경변수가 필요합니다");
        };

        let cookie = http_login(&email, &password)
            .await
            .expect("로그인에 성공해야 한다");
        assert!(cookie.contains("AID="), "AID 쿠키가 있어야 한다: {cookie}");

        let me = send(&format!("{BASE}{PROBE_PATH}"), None, &cookie)
            .await
            .map_err(|e| e.to_string())
            .expect("primary 캘린더를 읽을 수 있어야 한다");
        assert!(
            me["token"].is_string(),
            "primary 응답에 token 이 있어야 한다: {me}"
        );

        // 뷰가 실제로 쓰는 엔드포인트도 같은 쿠키로 열려야 한다.
        let coworkers = send(
            &format!("{BASE}/api/v2/calendar/calendars/coworkers?size=500"),
            None,
            &cookie,
        )
        .await
        .map_err(|e| e.to_string())
        .expect("구성원 목록을 읽을 수 있어야 한다");
        let list = coworkers["calendars"]
            .as_array()
            .expect("calendars 배열이 있어야 한다");
        assert!(!list.is_empty(), "구성원이 한 명 이상이어야 한다");
        println!("구성원 {}명", list.len());

        // 잘못된 비밀번호는 서버 메시지를 그대로 올린다.
        let err = http_login(&email, "definitely-wrong-password-1")
            .await
            .expect_err("틀린 비밀번호는 실패해야 한다");
        assert!(!err.is_empty(), "오류 메시지가 있어야 한다");
        println!("틀린 비밀번호 메시지: {err}");
    }
}
