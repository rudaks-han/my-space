//! Google 드라이브 연동 — 최근에 열어본 파일 조회.
//!
//! 데스크톱 앱용 OAuth 2.0(루프백) 흐름은 gcal.rs 와 동일하다:
//!   1. 로컬 127.0.0.1 임의 포트로 리스너를 연다.
//!   2. 브라우저로 구글 동의 화면을 연다(redirect_uri = http://127.0.0.1:PORT).
//!   3. 로그인/동의 후 구글이 그 주소로 code 를 리다이렉트 → 리스너가 받는다.
//!   4. code 를 access/refresh 토큰으로 교환한다.
//!   5. refresh_token 을 저장하고, 이후 조회 시 access_token 을 갱신해 쓴다.
//!
//! client_id / client_secret 은 사용자가 Google Cloud "데스크톱 앱" OAuth 클라이언트에서
//! 발급받아 입력한다. 토큰 등은 앱 설정 폴더의 gdrive.json 에 저장한다(웹뷰에 노출 안 함).
//! 캘린더 연동과 완전히 독립된 별도 연결이다.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::task::JoinSet;

const CONFIG_FILE: &str = "gdrive.json";
/// 드라이브 읽기 권한 + 계정 이메일(표시용).
///
/// ⚠️ `drive.metadata.readonly` 가 아니라 `drive.readonly` 다. 공유 드라이브 목록을 주는
/// `drives.list` 가 metadata.readonly 를 받지 않고 "insufficient authentication scopes" 로
/// 거절하기 때문이다(파일 조회 `files.list` 는 metadata.readonly 로도 된다).
/// 스코프를 바꿔도 이미 저장된 refresh_token 은 옛 권한 그대로이므로, 사용자가 설정에서
/// 연결을 해제하고 다시 연결해야 적용된다.
const SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly email";
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
pub struct GdriveStatus {
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
fn status_of(cfg: &Config) -> GdriveStatus {
    GdriveStatus {
        connected: !cfg.refresh_token.is_empty(),
        email: (!cfg.email.is_empty()).then(|| cfg.email.clone()),
        client_id: (!cfg.client_id.is_empty()).then(|| cfg.client_id.clone()),
        has_secret: !cfg.client_secret.is_empty(),
    }
}

#[derive(Serialize)]
pub struct DriveFile {
    id: String,
    name: String,
    mime_type: String,
    /// 웹(Chrome)에서 파일을 여는 링크.
    web_view_link: Option<String>,
    /// 구글이 제공하는 파일 유형 아이콘 URL(표시용).
    icon_link: Option<String>,
    /// 다른 사람이 최근 수정했으면 그 사람 이름. None 이면 "내가 열어본 항목".
    reason_modified_by: Option<String>,
    /// 추천 이유에 표시할 시각(RFC3339). 프런트에서 오늘=시각, 그 외=날짜로 포맷.
    reason_time: Option<String>,
    /// 소유자 이름(owner_me 면 프런트에서 "나"로 표시). 공유 드라이브면 None → "—".
    owner_name: Option<String>,
    owner_me: bool,
    owner_photo: Option<String>,
    /// 위치(부모 폴더명 / "내 드라이브" / "공유 문서함").
    location: Option<String>,
    /// 마지막 수정 시각(RFC3339) — 폴더 탐색 목록의 "마지막으로 수정한 날짜" 컬럼.
    modified_time: Option<String>,
    /// 바이트 크기. 폴더/구글 문서는 None → "—".
    size: Option<u64>,
    /// 폴더면 true — 행을 클릭했을 때 열지 않고 안으로 들어간다.
    is_folder: bool,
    /// 이 항목이 속한 공유 드라이브 id. 내 드라이브 항목이면 None.
    /// 폴더로 들어갈 때 corpora=drive 로 조회하기 위해 프런트가 그대로 넘겨준다.
    drive_id: Option<String>,
}

#[derive(Serialize)]
pub struct DriveFilePage {
    files: Vec<DriveFile>,
    /// 다음 페이지 토큰. None 이면 더 없음("더보기" 숨김).
    next_page_token: Option<String>,
}

/// 좌측 트리의 폴더 노드 하나.
#[derive(Serialize)]
pub struct DriveFolder {
    id: String,
    name: String,
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
pub fn gdrive_status(app: tauri::AppHandle) -> Result<GdriveStatus, String> {
    Ok(status_of(&read_config(&app)))
}

/// 연동 해제 — 토큰만 지우고 OAuth 클라이언트 정보는 남긴다(gmail.rs 와 같은 이유:
/// 동의 화면이 "테스트 중"이면 7일마다 재연결하게 되는데, 그때마다 클라이언트 ID/보안
/// 비밀을 콘솔에서 다시 복사해 오게 만들 이유가 없다). 클라이언트 자체를 바꿀 때만
/// forget_client 로 완전히 지운다.
#[tauri::command]
pub fn gdrive_disconnect(
    app: tauri::AppHandle,
    forget_client: Option<bool>,
) -> Result<GdriveStatus, String> {
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
pub async fn gdrive_start_auth(
    app: tauri::AppHandle,
    client_id: String,
    client_secret: String,
) -> Result<GdriveStatus, String> {
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

/// 내 드라이브 루트 폴더 id(위치를 "내 드라이브"로 표시하기 위한 비교용).
async fn fetch_root_id(client: &reqwest::Client, access: &str) -> Option<String> {
    let v: Value = client
        .get("https://www.googleapis.com/drive/v3/files/root")
        .bearer_auth(access)
        .query(&[("fields", "id")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    v.get("id").and_then(|x| x.as_str()).map(String::from)
}

/// 부모 폴더 id 집합을 이름으로 해석한다(각 폴더를 동시에 files.get). 접근 불가한
/// 폴더(공유받은 항목 등)는 결과에서 빠진다.
async fn resolve_parents(
    client: &reqwest::Client,
    access: &str,
    ids: HashSet<String>,
) -> HashMap<String, String> {
    let mut set = JoinSet::new();
    for id in ids {
        let client = client.clone();
        let access = access.to_string();
        let url = format!("https://www.googleapis.com/drive/v3/files/{id}");
        set.spawn(async move {
            let v: Value = client
                .get(&url)
                .bearer_auth(&access)
                .query(&[("fields", "id,name"), ("supportsAllDrives", "true")])
                .send()
                .await
                .ok()?
                .json()
                .await
                .ok()?;
            let name = v.get("name").and_then(|x| x.as_str())?.to_string();
            Some((id, name))
        });
    }
    let mut map = HashMap::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some((id, name))) = res {
            map.insert(id, name);
        }
    }
    map
}

/// 최근에 열어본 파일 조회(구글 드라이브 "추천 파일"과 동일한 viewedByMeTime 내림차순).
/// page_token 이 있으면 다음 페이지("더보기")를 이어서 가져온다.
#[tauri::command]
pub async fn gdrive_recent(
    app: tauri::AppHandle,
    page_token: Option<String>,
) -> Result<DriveFilePage, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    let client = reqwest::Client::new();
    let page_token = page_token.unwrap_or_default();
    let mut query = vec![
        // 최근 활동순(recency = 파일의 모든 시각 중 가장 최근). 구글 드라이브의
        // "추천" ML 랭킹은 API 로 노출되지 않아, 홈 느낌에 가장 근접한 근사치로 쓴다.
        ("orderBy", "recency desc".to_string()),
        ("pageSize", "25".to_string()),
        ("q", "trashed = false".to_string()),
        (
            "fields",
            "nextPageToken,files(id,name,mimeType,webViewLink,iconLink,\
             viewedByMeTime,modifiedTime,size,shared,parents,driveId,\
             owners(displayName,me,photoLink),lastModifyingUser(displayName,me))"
                .to_string(),
        ),
        // 공유 드라이브 항목까지 포함(추천 파일에 섞여 나오므로).
        ("supportsAllDrives", "true".to_string()),
        ("includeItemsFromAllDrives", "true".to_string()),
        ("corpora", "allDrives".to_string()),
        ("spaces", "drive".to_string()),
    ];
    if !page_token.is_empty() {
        query.push(("pageToken", page_token));
    }

    let v: Value = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(&access)
        .query(&query)
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
            .unwrap_or("drive_error");
        return Err(msg.to_string());
    }

    let next_page_token = v
        .get("nextPageToken")
        .and_then(|x| x.as_str())
        .map(String::from);

    let items: Vec<Value> = v
        .get("files")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();

    // 위치 표시용: 파일들의 첫 부모 id 를 모아 이름을 한 번에 해석한다.
    let parent_ids: HashSet<String> = items
        .iter()
        .filter_map(|it| {
            it.pointer("/parents/0")
                .and_then(|x| x.as_str())
                .map(String::from)
        })
        .collect();

    let root_id = fetch_root_id(&client, &access).await;
    let parent_names = resolve_parents(&client, &access, parent_ids).await;

    let mut files = Vec::new();
    for it in &items {
        // 폴더는 "열어본 파일" 목록에서 제외한다.
        if it.get("mimeType").and_then(|x| x.as_str())
            == Some("application/vnd.google-apps.folder")
        {
            continue;
        }

        // 추천 이유: 내가 마지막으로 본 시각 vs 남이 마지막으로 수정한 시각을 비교.
        let viewed = it.get("viewedByMeTime").and_then(|x| x.as_str());
        let modified = it.get("modifiedTime").and_then(|x| x.as_str());
        let modifier = it.pointer("/lastModifyingUser/displayName").and_then(|x| x.as_str());
        let modifier_me = it
            .pointer("/lastModifyingUser/me")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        // RFC3339(Z) 문자열은 사전식 비교가 시간 비교와 일치한다.
        let use_modified = match (viewed, modified) {
            (Some(v), Some(m)) => m > v,
            (None, Some(_)) => true,
            _ => false,
        };
        let (reason_modified_by, reason_time) = if use_modified && modifier.is_some() && !modifier_me
        {
            (modifier.map(String::from), modified.map(String::from))
        } else {
            (None, viewed.or(modified).map(String::from))
        };

        let owner = it.pointer("/owners/0");
        let owner_name = owner
            .and_then(|o| o.get("displayName"))
            .and_then(|x| x.as_str())
            .map(String::from);
        let owner_me = owner
            .and_then(|o| o.get("me"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        let owner_photo = owner
            .and_then(|o| o.get("photoLink"))
            .and_then(|x| x.as_str())
            .map(String::from);

        let parent = it.pointer("/parents/0").and_then(|x| x.as_str());
        let shared = it.get("shared").and_then(|x| x.as_bool()).unwrap_or(false);
        let location = match parent {
            Some(pid) if Some(pid) == root_id.as_deref() => Some("내 드라이브".to_string()),
            Some(pid) => parent_names.get(pid).cloned().or_else(|| {
                if shared {
                    Some("공유 문서함".to_string())
                } else {
                    None
                }
            }),
            None => {
                if shared {
                    Some("공유 문서함".to_string())
                } else {
                    None
                }
            }
        };

        files.push(DriveFile {
            id: it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            name: it
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("(제목 없음)")
                .to_string(),
            mime_type: it.get("mimeType").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            web_view_link: it.get("webViewLink").and_then(|x| x.as_str()).map(String::from),
            icon_link: it.get("iconLink").and_then(|x| x.as_str()).map(String::from),
            reason_modified_by,
            reason_time,
            owner_name,
            owner_me,
            owner_photo,
            location,
            modified_time: modified.map(String::from),
            size: parse_size(it),
            is_folder: false,
            drive_id: it.get("driveId").and_then(|x| x.as_str()).map(String::from),
        });
    }

    Ok(DriveFilePage {
        files,
        next_page_token,
    })
}

/// size 는 구글이 문자열로 준다(int64). 폴더/구글 문서에는 아예 없다.
fn parse_size(it: &Value) -> Option<u64> {
    it.get("size")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse().ok())
}

/// 쿼리 안에 들어가는 파일 id — 작은따옴표만 막으면 충분하다.
fn escape_id(id: &str) -> String {
    id.replace('\\', "\\\\").replace('\'', "\\'")
}

/// 폴더 탐색 목록에서 쓰는 필드 집합(추천 이유·위치 해석이 필요 없으므로 추천 목록보다 가볍다).
const BROWSE_FIELDS: &str = "nextPageToken,files(id,name,mimeType,webViewLink,iconLink,\
     modifiedTime,size,driveId,owners(displayName,me,photoLink))";

/// 폴더에 매이지 않은 조회(내 드라이브 + 모든 공유 드라이브)에 쓰는 공통 파라미터.
/// `gdrive_recent` 가 쓰는 것과 같은 조합이다 — 공유 드라이브 항목을 실제로 돌려주는 게
/// 확인된 유일한 조합이므로, 새 조회도 여기서 벗어나지 않는다.
fn all_drives_params(query: &mut Vec<(&'static str, String)>) {
    query.push(("supportsAllDrives", "true".to_string()));
    query.push(("includeItemsFromAllDrives", "true".to_string()));
    query.push(("corpora", "allDrives".to_string()));
    query.push(("spaces", "drive".to_string()));
}

/// files.list 를 호출해 목록 페이지로 매핑한다(부모 이름 해석 없음).
async fn list_files(access: &str, query: &[(&str, String)]) -> Result<DriveFilePage, String> {
    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access)
        .query(query)
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
            .unwrap_or("drive_error");
        // 조회 실패는 화면에서 "빈 폴더"와 구분이 안 되므로 반드시 로그에 남긴다.
        log::warn!("drive files.list failed: {msg} (query={query:?})");
        return Err(msg.to_string());
    }

    let files = v
        .get("files")
        .and_then(|x| x.as_array())
        .map(|items| items.iter().map(map_browse_file).collect())
        .unwrap_or_default();

    Ok(DriveFilePage {
        files,
        next_page_token: v
            .get("nextPageToken")
            .and_then(|x| x.as_str())
            .map(String::from),
    })
}

fn map_browse_file(it: &Value) -> DriveFile {
    let mime = it
        .get("mimeType")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let owner = it.pointer("/owners/0");
    DriveFile {
        id: it.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        name: it
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("(제목 없음)")
            .to_string(),
        is_folder: mime == FOLDER_MIME,
        mime_type: mime,
        web_view_link: it
            .get("webViewLink")
            .and_then(|x| x.as_str())
            .map(String::from),
        icon_link: it.get("iconLink").and_then(|x| x.as_str()).map(String::from),
        reason_modified_by: None,
        reason_time: None,
        owner_name: owner
            .and_then(|o| o.get("displayName"))
            .and_then(|x| x.as_str())
            .map(String::from),
        owner_me: owner
            .and_then(|o| o.get("me"))
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        owner_photo: owner
            .and_then(|o| o.get("photoLink"))
            .and_then(|x| x.as_str())
            .map(String::from),
        location: None,
        modified_time: it
            .get("modifiedTime")
            .and_then(|x| x.as_str())
            .map(String::from),
        size: parse_size(it),
        drive_id: it.get("driveId").and_then(|x| x.as_str()).map(String::from),
    }
}

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

/// 공유 드라이브 목록. 트리의 "공유 드라이브" 노드를 펼칠 때와, 그 노드를 선택했을 때
/// 목록 패널에 폴더 행으로 보여줄 때 둘 다 이걸 쓴다.
async fn fetch_shared_drives(access: &str) -> Result<Vec<DriveFolder>, String> {
    let client = reqwest::Client::new();
    let v: Value = client
        .get("https://www.googleapis.com/drive/v3/drives")
        .bearer_auth(access)
        .query(&[("pageSize", "100"), ("fields", "drives(id,name)")])
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
            .unwrap_or("drive_error");
        log::warn!("drive drives.list failed: {msg}");
        return Err(msg.to_string());
    }

    Ok(v.get("drives")
        .and_then(|x| x.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|d| {
                    // 공유 드라이브의 루트 폴더 id 는 드라이브 id 와 같으므로 그대로 폴더로 쓴다.
                    Some(DriveFolder {
                        id: d.get("id").and_then(|x| x.as_str())?.to_string(),
                        name: d
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("(이름 없음)")
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// 트리 노드 펼치기 — 특정 폴더의 하위 "폴더"만 이름순으로 가져온다.
/// parent_id 가 "shared-drives" 면 공유 드라이브 목록을 대신 돌려준다.
///
/// 공유 드라이브 안이라고 해서 `corpora=drive` + `driveId` 로 좁히지 않는다. `in parents` 가
/// 이미 위치를 한 폴더로 못박아 코퍼스를 넓게 둬도 결과가 같고, allDrives 조합은 이
/// 계정에서 동작이 확인된 유일한 조합이기 때문이다.
#[tauri::command]
pub async fn gdrive_folders(
    app: tauri::AppHandle,
    parent_id: String,
) -> Result<Vec<DriveFolder>, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    if parent_id == "shared-drives" {
        return fetch_shared_drives(&access).await;
    }

    let mut query = vec![
        (
            "q",
            format!(
                "'{}' in parents and mimeType = '{FOLDER_MIME}' and trashed = false",
                escape_id(&parent_id)
            ),
        ),
        ("pageSize", "200".to_string()),
        ("fields", "files(id,name)".to_string()),
    ];
    all_drives_params(&mut query);

    let page = list_files(&access, &query).await?;
    let mut folders: Vec<DriveFolder> = page
        .files
        .into_iter()
        .map(|f| DriveFolder {
            id: f.id,
            name: f.name,
        })
        .collect();
    // orderBy 를 API 에 맡기지 않고 여기서 정렬한다 — 넓은 코퍼스에서는 무시될 수 있다.
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(folders)
}

/// 좌측 트리에서 고른 항목의 파일 목록. kind 는 프런트의 DriveNode.kind 와 1:1 이다.
///   my-drive / folder / shared-drives / shared-with-me / recent / starred
#[tauri::command]
pub async fn gdrive_list(
    app: tauri::AppHandle,
    kind: String,
    id: Option<String>,
    page_token: Option<String>,
) -> Result<DriveFilePage, String> {
    let cfg = read_config(&app);
    if cfg.refresh_token.is_empty() {
        return Err("not_connected".into());
    }
    let access = access_token(&cfg).await?;

    // "공유 드라이브" 노드 자체는 파일이 아니라 드라이브 목록을 폴더 행으로 보여준다.
    if kind == "shared-drives" {
        let drives = fetch_shared_drives(&access).await?;
        return Ok(DriveFilePage {
            files: drives
                .into_iter()
                .map(|d| DriveFile {
                    web_view_link: Some(format!("https://drive.google.com/drive/folders/{}", d.id)),
                    drive_id: Some(d.id.clone()),
                    id: d.id,
                    name: d.name,
                    mime_type: FOLDER_MIME.to_string(),
                    icon_link: None,
                    reason_modified_by: None,
                    reason_time: None,
                    owner_name: None,
                    owner_me: false,
                    owner_photo: None,
                    location: None,
                    modified_time: None,
                    size: None,
                    is_folder: true,
                })
                .collect(),
            next_page_token: None,
        });
    }

    // 폴더 우선 + 이름순이 드라이브 웹의 기본 정렬이다. 시간 기반 목록만 예외.
    // 내 드라이브 루트만 기본 코퍼스(user)를 쓰고, 나머지는 공유 드라이브까지 포함해야 하므로
    // gdrive_recent 와 같은 allDrives 조합으로 간다.
    let (q, order_by, all_drives) = match kind.as_str() {
        "my-drive" => (
            "'root' in parents and trashed = false".to_string(),
            "folder,name",
            false,
        ),
        "folder" => {
            let fid = id.as_deref().ok_or("folder_id_required")?;
            (
                format!("'{}' in parents and trashed = false", escape_id(fid)),
                "folder,name",
                true,
            )
        }
        "shared-with-me" => (
            "sharedWithMe = true and trashed = false".to_string(),
            "sharedWithMeTime desc",
            false,
        ),
        "recent" => (
            format!("trashed = false and mimeType != '{FOLDER_MIME}'"),
            "viewedByMeTime desc",
            true,
        ),
        "starred" => (
            "starred = true and trashed = false".to_string(),
            "folder,name",
            true,
        ),
        other => return Err(format!("unknown_view: {other}")),
    };

    let mut query = vec![
        ("q", q),
        ("orderBy", order_by.to_string()),
        ("pageSize", "50".to_string()),
        ("fields", BROWSE_FIELDS.to_string()),
    ];
    if all_drives {
        all_drives_params(&mut query);
    } else {
        query.push(("supportsAllDrives", "true".to_string()));
        query.push(("includeItemsFromAllDrives", "true".to_string()));
        query.push(("spaces", "drive".to_string()));
    }
    if let Some(token) = page_token.filter(|t| !t.is_empty()) {
        query.push(("pageToken", token));
    }

    list_files(&access, &query).await
}
