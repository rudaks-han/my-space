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
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const CONFIG_FILE: &str = "gcal.json";
const SCOPE: &str = "https://www.googleapis.com/auth/calendar.readonly email";
/// 브라우저 로그인 완료를 기다리는 최대 시간.
const AUTH_TIMEOUT: Duration = Duration::from_secs(180);

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
pub struct GcalStatus {
    connected: bool,
    email: Option<String>,
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
}

/// 브라우저 리다이렉트로 돌아온 인증 코드를 로컬 리스너에서 받는다.
fn wait_for_code(
    listener: TcpListener,
    expected_state: String,
    timeout: Duration,
) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
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
                    let dv = urlencoding::decode(v).map(|s| s.into_owned()).unwrap_or_default();
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
pub fn gcal_status(app: tauri::AppHandle) -> Result<GcalStatus, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        Ok(GcalStatus {
            connected: false,
            email: None,
        })
    } else {
        Ok(GcalStatus {
            connected: true,
            email: if cfg.email.is_empty() {
                None
            } else {
                Some(cfg.email)
            },
        })
    }
}

/// 연동 해제(저장 토큰 삭제).
#[tauri::command]
pub fn gcal_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(path) = config_path(&app) {
        let _ = std::fs::remove_file(path);
    }
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
    let email = fetch_email(access).await.unwrap_or_default();

    let cfg = Config {
        client_id,
        client_secret,
        refresh_token,
        email: email.clone(),
    };
    write_config(&app, &cfg)?;

    Ok(GcalStatus {
        connected: true,
        email: if email.is_empty() { None } else { Some(email) },
    })
}

/// 오늘(로컬 타임존) 일정 조회.
#[tauri::command]
pub async fn gcal_today(app: tauri::AppHandle) -> Result<Vec<CalendarEvent>, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    // 오늘 00:00 ~ 내일 00:00 (로컬)
    use chrono::{Duration as ChronoDuration, Local, TimeZone};
    let today = Local::now().date_naive();
    let start = today.and_hms_opt(0, 0, 0).unwrap();
    let start = Local
        .from_local_datetime(&start)
        .single()
        .ok_or("time_error")?;
    let end = start + ChronoDuration::days(1);
    let time_min = start.to_rfc3339();
    let time_max = end.to_rfc3339();

    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://www.googleapis.com/calendar/v3/calendars/primary/events")
        .bearer_auth(&access)
        .query(&[
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("maxResults", "50"),
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
            });
        }
    }
    Ok(events)
}
