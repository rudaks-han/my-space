//! Gmail 연동 — 받은편지함/보낸편지함 목록과 메일 본문 조회(읽기 전용).
//!
//! 데스크톱 앱용 OAuth 2.0(루프백) 흐름은 gcal.rs / gdrive.rs 와 동일하다:
//!   1. 로컬 127.0.0.1 임의 포트로 리스너를 연다.
//!   2. 브라우저로 구글 동의 화면을 연다(redirect_uri = http://127.0.0.1:PORT).
//!   3. 로그인/동의 후 구글이 그 주소로 code 를 리다이렉트 → 리스너가 받는다.
//!   4. code 를 access/refresh 토큰으로 교환한다.
//!   5. refresh_token 을 저장하고, 이후 조회 시 access_token 을 갱신해 쓴다.
//!
//! client_id / client_secret 은 사용자가 Google Cloud "데스크톱 앱" OAuth 클라이언트에서
//! 발급받아 입력한다. 토큰 등은 앱 설정 폴더의 gmail.json 에 저장한다(웹뷰에 노출 안 함).
//! 캘린더·드라이브 연동과 완전히 독립된 별도 연결이다(스코프가 gmail.readonly 라서).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::task::JoinSet;

const CONFIG_FILE: &str = "gmail.json";
/// 메일 읽기 + 라벨 수정(읽음 처리) 권한 + 계정 이메일(표시용).
/// gmail.modify 는 읽기를 포함하며, 영구 삭제만 제외한 읽기/쓰기를 허용한다.
const SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify email";
/// 브라우저 로그인 완료를 기다리는 최대 시간.
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);
/// 한 폴더에서 가져올 메일 개수(목록 표시·미읽음 계산용). 너무 크면 메타데이터
/// 조회가 그만큼 늘어난다. 프런트의 PAGE_SIZE 와 같아야 페이지 범위 표시가 맞다.
const LIST_SIZE: &str = "50";

#[derive(Serialize, Deserialize, Default)]
struct Config {
    client_id: String,
    client_secret: String,
    refresh_token: String,
    email: String,
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
pub struct GmailStatus {
    connected: bool,
    email: Option<String>,
    /// 저장된 OAuth 클라이언트 ID. 재연결 폼을 자동으로 채우는 용도다.
    client_id: Option<String>,
    /// 보안 비밀이 저장돼 있는지. 값 자체는 웹뷰로 절대 내보내지 않으므로
    /// "저장됨"만 알리고, 재연결 때는 빈 값으로 두면 Rust 가 저장분을 쓴다.
    has_secret: bool,
}

/// 입력값을 다듬고, 비어 있으면 대체값(보통 저장된 값)을 쓴다.
fn some_or(input: String, fallback: String) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        fallback
    } else {
        trimmed.to_string()
    }
}

/// 저장된 설정 → 프런트에 보낼 상태. connected 판정은 refresh_token 유무다.
fn status_of(cfg: &Config) -> GmailStatus {
    GmailStatus {
        connected: !cfg.refresh_token.is_empty(),
        email: (!cfg.email.is_empty()).then(|| cfg.email.clone()),
        client_id: (!cfg.client_id.is_empty()).then(|| cfg.client_id.clone()),
        has_secret: !cfg.client_secret.is_empty(),
    }
}

/// 목록에 표시할 메일 한 통(메타데이터). 본문은 별도 명령으로 가져온다.
#[derive(Serialize)]
pub struct GmailMessage {
    id: String,
    thread_id: String,
    /// 보낸사람 표시 이름(없으면 이메일).
    from_name: String,
    from_email: String,
    /// 받는사람(보낸편지함에서 상대를 표시하는 데 쓴다).
    to: String,
    subject: String,
    /// 구글이 주는 본문 미리보기 한 줄.
    snippet: String,
    /// 수신/발신 시각(epoch ms).
    date: i64,
    /// 안 읽음 여부(UNREAD 라벨).
    unread: bool,
}

/// 한 폴더의 메일 한 페이지(페이지네이션).
#[derive(Serialize)]
pub struct GmailPage {
    messages: Vec<GmailMessage>,
    /// 다음 페이지 토큰. None 이면 다음 페이지 없음.
    next_page_token: Option<String>,
    /// 폴더 전체 메일 수(구글이 주는 근사치).
    result_size_estimate: i64,
}

/// 메일 한 통의 본문(읽기 화면용).
#[derive(Serialize)]
pub struct GmailBody {
    subject: String,
    from_name: String,
    from_email: String,
    to: String,
    date: i64,
    /// HTML 본문(있으면 우선). 프런트에서 sandbox iframe 으로 렌더한다.
    html: Option<String>,
    /// 순수 텍스트 본문(HTML 이 없을 때).
    text: Option<String>,
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

/// access_token 으로 계정 이메일 조회(표시용).
async fn fetch_email(access: &str) -> Option<String> {
    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access)
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("email").and_then(|x| x.as_str()).map(String::from)
}

/// 저장된 연동 상태.
#[tauri::command]
pub fn gmail_status(app: tauri::AppHandle) -> Result<GmailStatus, String> {
    Ok(status_of(&read_config(&app)))
}

/// 연동 해제 — 토큰(refresh_token·이메일)만 지우고 OAuth 클라이언트 정보는 남긴다.
/// 동의 화면이 "테스트 중"이면 refresh_token 이 7일마다 무효(invalid_grant)가 되는데,
/// 그때마다 해제 → 재연결을 하게 되므로 클라이언트 ID/보안 비밀까지 지우면 매번
/// Google Cloud 콘솔에서 다시 복사해 와야 한다. 클라이언트 자체를 바꿀 때만
/// forget_client 로 완전히 지운다.
#[tauri::command]
pub fn gmail_disconnect(
    app: tauri::AppHandle,
    forget_client: Option<bool>,
) -> Result<GmailStatus, String> {
    let mut cfg = read_config(&app);
    cfg.refresh_token.clear();
    cfg.email.clear();
    if forget_client.unwrap_or(false) {
        cfg.client_id.clear();
        cfg.client_secret.clear();
    }

    // 남길 게 없으면 파일도 남기지 않는다(미연결 상태와 동일).
    if cfg.client_id.is_empty() && cfg.client_secret.is_empty() {
        if let Ok(path) = config_path(&app) {
            let _ = std::fs::remove_file(path);
        }
    } else {
        write_config(&app, &cfg)?;
    }
    Ok(status_of(&cfg))
}

/// OAuth 로그인 시작: 브라우저를 열고 루프백으로 코드를 받아 토큰을 저장한다.
#[tauri::command]
pub async fn gmail_start_auth(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<GmailStatus, String> {
    // 빈 값으로 오면 저장된 값을 쓴다. 보안 비밀은 웹뷰로 내보내지 않으므로
    // 프런트가 되돌려줄 방법이 없고, 재연결 때 다시 입력하지 않게 하려면 여기서 채워야 한다.
    let saved = read_config(&app);
    let client_id = some_or(client_id, saved.client_id);
    let client_secret = some_or(client_secret, saved.client_secret);
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
    let email = fetch_email(access).await.unwrap_or_default();

    let cfg = Config {
        client_id,
        client_secret,
        refresh_token,
        email,
    };
    write_config(&app, &cfg)?;

    Ok(status_of(&cfg))
}

/// 헤더 목록에서 name(대소문자 무시)에 해당하는 값을 찾는다.
fn header<'a>(headers: &'a [Value], name: &str) -> &'a str {
    headers
        .iter()
        .find_map(|h| {
            let matches = h
                .get("name")
                .and_then(|x| x.as_str())
                .map(|n| n.eq_ignore_ascii_case(name))
                .unwrap_or(false);
            if matches {
                h.get("value").and_then(|x| x.as_str())
            } else {
                None
            }
        })
        .unwrap_or("")
}

/// "홍길동 <a@b.com>" → ("홍길동", "a@b.com"). 이름이 없으면 이메일을 이름으로 쓴다.
fn parse_from(v: &str) -> (String, String) {
    if let Some(lt) = v.rfind('<') {
        let name = v[..lt].trim().trim_matches('"').trim().to_string();
        let email = v[lt + 1..].trim_end_matches('>').trim().to_string();
        let name = if name.is_empty() { email.clone() } else { name };
        (name, email)
    } else {
        let e = v.trim().to_string();
        (e.clone(), e)
    }
}

/// 메시지 하나의 메타데이터를 가져와 GmailMessage 로 만든다.
/// 레이트리밋(429) 등 일시 오류는 짧게 쉬고 최대 3회까지 재시도한다. 끝내 정상 메시지
/// 응답(payload 포함)을 못 받으면 None 을 반환한다 — 빈 행을 만들지 않기 위해서다.
async fn fetch_meta(client: &reqwest::Client, access: &str, id: &str) -> Option<GmailMessage> {
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}");
    let mut v: Value = Value::Null;
    for attempt in 0u64..3 {
        let resp = client
            .get(&url)
            .bearer_auth(access)
            .query(&[
                ("format", "metadata"),
                ("metadataHeaders", "From"),
                ("metadataHeaders", "To"),
                ("metadataHeaders", "Subject"),
                ("metadataHeaders", "Date"),
            ])
            .send()
            .await;
        let parsed = match resp {
            Ok(r) => r.json::<Value>().await,
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
                continue;
            }
        };
        match parsed {
            // 에러 응답(429/403 등)은 빈 메시지로 만들지 말고, 잠깐 쉬고 다시 시도한다.
            Ok(val) if val.get("error").is_some() => {
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
                continue;
            }
            Ok(val) => {
                v = val;
                break;
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1))).await;
                continue;
            }
        }
    }

    // 정상 메시지 리소스(payload)가 아니면 버린다(빈 행 방지).
    let headers = v.pointer("/payload/headers").and_then(|x| x.as_array())?;
    let (from_name, from_email) = parse_from(header(headers, "From"));
    let unread = v
        .get("labelIds")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().any(|l| l.as_str() == Some("UNREAD")))
        .unwrap_or(false);
    let date = v
        .get("internalDate")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    Some(GmailMessage {
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or(id).to_string(),
        thread_id: v
            .get("threadId")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        from_name,
        from_email,
        to: header(headers, "To").to_string(),
        subject: header(headers, "Subject").to_string(),
        snippet: v
            .get("snippet")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        date,
        unread,
    })
}

/// 한 폴더(받은편지함/보낸편지함)의 메일을 한 페이지 가져온다(최신순).
/// folder: "inbox" | "sent" (그 외는 inbox 로 간주).
/// page_token 이 있으면 그 다음 페이지를 가져온다("다음" 이동).
#[tauri::command]
pub async fn gmail_messages(
    app: tauri::AppHandle,
    folder: String,
    page_token: Option<String>,
) -> Result<GmailPage, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;
    let label = if folder == "sent" { "SENT" } else { "INBOX" };

    let client = reqwest::Client::new();
    // 1) 목록(id 만) 조회.
    let mut query: Vec<(&str, String)> = vec![
        ("labelIds", label.to_string()),
        ("maxResults", LIST_SIZE.to_string()),
    ];
    if let Some(tok) = page_token.filter(|t| !t.is_empty()) {
        query.push(("pageToken", tok));
    }
    let list: Value = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .bearer_auth(&access)
        .query(&query)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(err) = list.get("error") {
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("gmail_error");
        return Err(msg.to_string());
    }

    let next_page_token = list
        .get("nextPageToken")
        .and_then(|x| x.as_str())
        .map(String::from);
    let result_size_estimate = list
        .get("resultSizeEstimate")
        .and_then(|x| x.as_i64())
        .unwrap_or(0);

    let ids: Vec<String> = list
        .get("messages")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // 2) 각 메시지 메타데이터를 조회한다. 50개를 한꺼번에 쏘면 Gmail 레이트리밋(429)에
    //    걸리므로 세마포어로 동시 요청 수를 제한한다.
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let mut set = JoinSet::new();
    for id in ids.clone() {
        let client = client.clone();
        let access = access.clone();
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await.ok()?;
            fetch_meta(&client, &access, &id).await
        });
    }
    let mut map: HashMap<String, GmailMessage> = HashMap::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(m)) = res {
            map.insert(m.id.clone(), m);
        }
    }

    // 목록이 준 최신순을 유지한다(동시 조회라 도착 순서는 뒤섞이므로 id 순서로 재정렬).
    let messages = ids.into_iter().filter_map(|id| map.remove(&id)).collect();
    Ok(GmailPage {
        messages,
        next_page_token,
        result_size_estimate,
    })
}

/// 받은편지함 전체의 안 읽은 메일 수(정확한 총계). INBOX 라벨의 messagesUnread 를 쓴다.
#[tauri::command]
pub async fn gmail_unread_count(app: tauri::AppHandle) -> Result<i64, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX")
        .bearer_auth(&access)
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
            .unwrap_or("gmail_error");
        return Err(msg.to_string());
    }
    Ok(v.get("messagesUnread").and_then(|x| x.as_i64()).unwrap_or(0))
}

/// 메일 하나를 읽음 처리한다(UNREAD 라벨 제거). gmail.modify 스코프가 필요하다.
#[tauri::command]
pub async fn gmail_mark_read(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    let client = reqwest::Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify");
    let v: Value = client
        .post(&url)
        .bearer_auth(&access)
        .json(&serde_json::json!({ "removeLabelIds": ["UNREAD"] }))
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
            .unwrap_or("gmail_error");
        return Err(msg.to_string());
    }
    Ok(())
}

/// payload.body.data(base64url)를 문자열로 디코딩한다.
fn decode_part(payload: &Value) -> Option<String> {
    let data = payload.pointer("/body/data").and_then(|x| x.as_str())?;
    let cleaned: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cleaned.trim_end_matches('='))
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// payload 트리를 재귀로 훑어 text/html·text/plain 본문을 각각 첫 번째로 찾는다.
fn extract_bodies(payload: &Value, html: &mut Option<String>, text: &mut Option<String>) {
    let mime = payload
        .get("mimeType")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    if mime == "text/html" && html.is_none() {
        if let Some(s) = decode_part(payload) {
            *html = Some(s);
        }
    } else if mime == "text/plain" && text.is_none() {
        if let Some(s) = decode_part(payload) {
            *text = Some(s);
        }
    }
    if let Some(parts) = payload.get("parts").and_then(|x| x.as_array()) {
        for p in parts {
            extract_bodies(p, html, text);
        }
    }
}

/// 메일 한 통의 본문을 가져온다(읽기 화면). 이 호출은 해당 메일을 자동으로 읽음
/// 처리하지 않는다(gmail.readonly 스코프는 쓰기 불가).
#[tauri::command]
pub async fn gmail_message_body(app: tauri::AppHandle, id: String) -> Result<GmailBody, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    let client = reqwest::Client::new();
    let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}");
    let v: Value = client
        .get(&url)
        .bearer_auth(&access)
        .query(&[("format", "full")])
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
            .unwrap_or("gmail_error");
        return Err(msg.to_string());
    }

    let empty = Vec::new();
    let headers = v
        .pointer("/payload/headers")
        .and_then(|x| x.as_array())
        .unwrap_or(&empty);
    let (from_name, from_email) = parse_from(header(headers, "From"));
    let date = v
        .get("internalDate")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);

    let mut html = None;
    let mut text = None;
    if let Some(payload) = v.get("payload") {
        extract_bodies(payload, &mut html, &mut text);
    }

    Ok(GmailBody {
        subject: header(headers, "Subject").to_string(),
        from_name,
        from_email,
        to: header(headers, "To").to_string(),
        date,
        html,
        text,
    })
}
