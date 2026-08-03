//! IntelliJ HTTP Client(`.http` 파일) 백엔드 — 파일 찾기·읽기·쓰기, 환경 파일 파싱,
//! 그리고 **요청 전송**.
//!
//! 왜 요청을 Rust 가 보내는가: 웹뷰에서 임의 호스트로 fetch 하면 CORS 에 막히고
//! (`es.rs` 헤더의 설명과 같은 이유), `Host`·`Cookie` 처럼 브라우저가 못 쓰게 막아 둔
//! 헤더도 `.http` 파일에서는 흔하게 쓴다. 그래서 프론트가 파일을 파싱해 만든 최종
//! 요청(메서드·URL·헤더·본문)을 여기로 넘기고, reqwest 가 그대로 보낸다.
//!
//! **파싱은 프론트엔드 몫이다**(`src/features/intellij-http/http-parse.ts`).
//! 편집기가 커서 위치의 요청을 알아야 하고(거터의 ▶), 변수 미해결을 즉시 빨갛게
//! 보여 줘야 하므로 파서가 화면과 같은 tick 에 있어야 한다 — 파싱을 Rust 로 옮기면
//! 타이핑마다 IPC 를 왕복해야 한다.
//!
//! 본문이 **바이트 조각의 배열**(`BodyChunk`)인 이유: `.http` 파일의 본문에는
//! `< ./profile.jpg` 처럼 파일을 그대로 끼워 넣는 줄이 올 수 있고, multipart 요청은
//! 경계선·파트 헤더가 본문 텍스트에 그대로 적혀 있다. 즉 최종 본문은
//! "텍스트 · 파일바이트 · 텍스트 …" 의 연결이다. 텍스트 파일 include 는 프론트가 읽어
//! 변수를 치환한 뒤 텍스트 조각으로 넘기고(IntelliJ 도 include 안의 `{{var}}` 를
//! 치환한다), UTF-8 이 아닌 파일만 경로 조각으로 남겨 여기서 바이트로 읽는다.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use crate::cowork::expand_home;

/// 편집기로 열 수 있는 확장자. IntelliJ 는 `.http` 와 `.rest` 를 HTTP Request 파일로 본다.
const EXTS: [&str; 2] = ["http", "rest"];

/// 탐색에서 건너뛰는 디렉터리.
///
/// `target`·`build` 는 빌드 산출물에 테스트 리소스가 복사돼 **같은 파일이 두 번** 보이는
/// 원인이고(cowork 는 `src/test/resources/http` 가 `target/test-classes/http` 로 복사된다),
/// `.idea` 는 IntelliJ 가 실행 기록을 `httpRequests/http-requests-log.http` 로 남겨 두는
/// 자리라 목록에 섞이면 방해가 된다.
const SKIP_DIRS: [&str; 13] = [
    ".git",
    ".idea",
    ".gradle",
    ".svn",
    "node_modules",
    "target",
    "build",
    "out",
    "dist",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
];

/// 탐색 깊이 상한(프로젝트 루트 = 0).
const MAX_DEPTH: usize = 12;
/// 목록 상한(폭주 방지). 이보다 많으면 이름순으로 잘라 돌려준다.
const MAX_FILES: usize = 5000;
/// 파일 하나를 문자열로 읽어 들이는 상한(편집기에 올릴 수 있는 크기).
const MAX_TEXT_BYTES: u64 = 4 * 1024 * 1024;
/// 본문에 끼워 넣는(`< ./file`) 파일 크기 상한.
const MAX_INCLUDE_BYTES: u64 = 64 * 1024 * 1024;
/// 요청 기본 타임아웃.
const DEFAULT_TIMEOUT_MS: u64 = 60_000;

/// 목록의 한 줄.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFileEntry {
    /// 절대 경로(읽기·쓰기에 그대로 되돌려 준다).
    pub path: String,
    /// 프로젝트 루트 기준 상대 경로 — 트리 그룹과 검색에 쓴다.
    pub rel: String,
    /// 파일명(확장자 포함).
    pub name: String,
    /// 상대 디렉터리("" 면 프로젝트 루트).
    pub dir: String,
    pub size: u64,
    /// 마지막 수정 시각(epoch ms). 못 읽으면 null.
    pub modified: Option<u64>,
}

/// 읽어 온 파일 하나.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFileText {
    pub path: String,
    pub name: String,
    pub text: String,
    pub modified: Option<u64>,
}

/// 환경 파일에서 읽은 환경 하나.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpEnv {
    /// 환경 이름(`http-client.env.json` 의 최상위 키).
    pub name: String,
    /// 변수 표. 값은 문자열로 정규화한다(숫자·불리언·객체는 JSON 표기 그대로).
    pub vars: BTreeMap<String, String>,
    /// `http-client.private.env.json` 에서 온 키들 — 화면에서 값을 가려 준다.
    pub private_keys: Vec<String>,
}

/// 환경 파일 탐색 결과.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpEnvs {
    pub envs: Vec<HttpEnv>,
    /// 실제로 읽은 환경 파일들(가까운 것이 뒤 — 덮어쓴 순서 그대로).
    pub sources: Vec<String>,
}

/// `< ./file` 로 끼워 넣을 파일의 내용.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncludeFile {
    pub path: String,
    /// UTF-8 로 읽힌 텍스트. 바이너리면 null(그때는 프론트가 경로 조각으로 넘긴다).
    pub text: Option<String>,
    pub size: u64,
}

/// 최종 본문의 한 조각.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BodyChunk {
    /// 이미 변수 치환이 끝난 텍스트.
    Text { text: String },
    /// 바이너리 파일 — 여기서 바이트로 읽어 그대로 붙인다.
    File { path: String },
}

/// 보낼 요청.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReq {
    pub method: String,
    pub url: String,
    /// 순서와 중복을 유지해야 하므로 맵이 아니라 배열이다(`Set-Cookie` 등).
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Vec<BodyChunk>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// `# @no-redirect` — 리다이렉트를 따라가지 않는다.
    #[serde(default)]
    pub no_redirect: bool,
}

/// 응답.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRes {
    pub status: u16,
    /// "OK" 처럼 상태코드에 붙는 표준 문구(서버가 준 reason phrase 는 reqwest 가 버린다).
    pub status_text: String,
    pub http_version: String,
    pub headers: Vec<(String, String)>,
    /// 본문. UTF-8 이 아니면 대체 문자로 바꾼 문자열이 들어오고 `binary` 가 true 다.
    pub body: String,
    pub binary: bool,
    /// 본문 바이트 수.
    pub size: u64,
    pub elapsed_ms: u64,
    /// 리다이렉트를 따라간 뒤의 최종 URL.
    pub final_url: String,
}

/// `.http`/`.rest` 파일인지.
fn is_http_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| EXTS.contains(&e.as_str()))
}

/// 수정 시각을 epoch ms 로.
fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// 확장자를 확인하고 절대 경로로 만든다(쓰기·읽기 공용 관문).
fn resolve_http_path(path: &str) -> Result<PathBuf, String> {
    let p = expand_home(path);
    if !is_http_file(&p) {
        return Err(format!(
            "HTTP 요청 파일만 다룰 수 있습니다({}).",
            EXTS.iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }
    Ok(p)
}

/// 프로젝트 아래의 `.http`/`.rest` 파일을 모두 찾는다.
#[tauri::command]
pub fn http_list_files(project: String) -> Result<Vec<HttpFileEntry>, String> {
    let root = expand_home(&project);
    if !root.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", root.to_string_lossy()));
    }
    let mut out: Vec<HttpFileEntry> = Vec::new();
    walk(&root, &root, 0, &mut out);
    out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    out.truncate(MAX_FILES);
    Ok(out)
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<HttpFileEntry>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        // `is_dir()` 은 심볼릭 링크에 false 라, 링크된 폴더는 자연히 따라가지 않는다
        // (순환 참조와 프로젝트 밖으로 새는 것을 둘 다 막는다).
        if ft.is_dir() {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(root, &path, depth + 1, out);
            continue;
        }
        if !ft.is_file() || !is_http_file(&path) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .to_string();
        let dir_rel = Path::new(&rel)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(HttpFileEntry {
            path: path.to_string_lossy().to_string(),
            rel,
            name,
            dir: dir_rel,
            size: meta.len(),
            modified: modified_ms(&meta),
        });
        if out.len() >= MAX_FILES {
            return;
        }
    }
}

/// 파일 하나를 읽는다.
#[tauri::command]
pub fn http_read_file(path: String) -> Result<HttpFileText, String> {
    let p = resolve_http_path(&path)?;
    let meta = p.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("파일이 아닙니다.".into());
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(format!(
            "파일이 너무 큽니다({:.1}MB).",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(HttpFileText {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone()),
        path: p.to_string_lossy().to_string(),
        text,
        modified: modified_ms(&meta),
    })
}

/// 편집한 내용을 저장한다. 저장 후의 수정 시각을 돌려준다(외부 변경 감지용).
#[tauri::command]
pub fn http_write_file(path: String, text: String) -> Result<Option<u64>, String> {
    let p = resolve_http_path(&path)?;
    if !p.is_file() {
        return Err("없는 파일에는 저장할 수 없습니다.".into());
    }
    fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(p.metadata().ok().and_then(|m| modified_ms(&m)))
}

/// 새 `.http` 파일을 만든다(빈 요청 템플릿).
#[tauri::command]
pub fn http_create_file(path: String, text: Option<String>) -> Result<HttpFileText, String> {
    let p = resolve_http_path(&path)?;
    if p.exists() {
        return Err("같은 이름의 파일이 이미 있습니다.".into());
    }
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = text.unwrap_or_else(|| "### 새 요청\nGET http://localhost:8080/\n".to_string());
    fs::write(&p, &body).map_err(|e| e.to_string())?;
    Ok(HttpFileText {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: p.to_string_lossy().to_string(),
        text: body,
        modified: p.metadata().ok().and_then(|m| modified_ms(&m)),
    })
}

/// JSON 값을 변수 값 문자열로.
fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `http-client.env.json` 한 개를 환경 표에 병합한다.
fn merge_env_file(
    path: &Path,
    private: bool,
    envs: &mut BTreeMap<String, (BTreeMap<String, String>, Vec<String>)>,
) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(obj) = root.as_object() else {
        return false;
    };
    for (env_name, vars) in obj {
        let Some(vars) = vars.as_object() else {
            continue;
        };
        let slot = envs.entry(env_name.clone()).or_default();
        for (k, v) in vars {
            slot.0.insert(k.clone(), as_text(v));
            if private && !slot.1.contains(k) {
                slot.1.push(k.clone());
            }
        }
    }
    true
}

/// 환경 파일을 찾을 디렉터리들 — `.http` 파일이 있는 폴더부터 프로젝트 루트까지,
/// **먼 것이 앞**(가까운 파일이 나중에 덮어쓰도록).
fn env_dirs(project: &Path, file: &Path) -> Vec<PathBuf> {
    let start = file.parent().unwrap_or(project).to_path_buf();
    let mut chain = Vec::new();
    let mut cur = Some(start.as_path());
    while let Some(d) = cur {
        chain.push(d.to_path_buf());
        if d == project {
            break;
        }
        cur = d.parent();
        // 프로젝트 밖으로 새면(파일이 프로젝트 밖) 그 폴더 하나만 본다.
        if cur.is_some_and(|p| !p.starts_with(project)) {
            break;
        }
    }
    if !chain.iter().any(|d| d == project) {
        chain.push(project.to_path_buf());
    }
    chain.reverse();
    chain
}

/// 환경 파일을 읽어 환경 목록을 돌려준다.
///
/// IntelliJ 와 같은 규칙: `.http` 파일이 있는 폴더에서 프로젝트 루트까지 올라가며
/// `http-client.env.json` 과 `http-client.private.env.json` 을 찾고, **가까운 파일이
/// 먼 파일을 덮어쓰며** private 이 public 을 덮어쓴다.
#[tauri::command]
pub fn http_env_files(project: String, file: String) -> Result<HttpEnvs, String> {
    let root = expand_home(&project);
    let f = expand_home(&file);
    let mut acc: BTreeMap<String, (BTreeMap<String, String>, Vec<String>)> = BTreeMap::new();
    let mut sources = Vec::new();
    for dir in env_dirs(&root, &f) {
        for (name, private) in [
            ("http-client.env.json", false),
            ("http-client.private.env.json", true),
        ] {
            let p = dir.join(name);
            if p.is_file() && merge_env_file(&p, private, &mut acc) {
                sources.push(p.to_string_lossy().to_string());
            }
        }
    }
    Ok(HttpEnvs {
        envs: acc
            .into_iter()
            .map(|(name, (vars, private_keys))| HttpEnv {
                name,
                vars,
                private_keys,
            })
            .collect(),
        sources,
    })
}

/// `base`(요청 파일) 기준 상대 경로를 절대 경로로.
fn resolve_relative(base: &str, rel: &str) -> PathBuf {
    let r = expand_home(rel);
    if r.is_absolute() {
        return r;
    }
    let base = expand_home(base);
    let dir = if base.is_dir() {
        base
    } else {
        base.parent().map(|p| p.to_path_buf()).unwrap_or_default()
    };
    dir.join(rel)
}

/// 본문에 끼워 넣을 파일을 읽는다.
///
/// UTF-8 로 읽히면 `text` 를 채워 준다 — 프론트가 그 안의 `{{var}}` 를 치환한 뒤
/// 텍스트 조각으로 보내기 위해서다(IntelliJ 도 텍스트 include 는 치환한다).
/// 바이너리(이미지·인증서 등)는 `text: null` 이고, 전송 시 경로 조각으로 넘어와
/// `http_send` 가 바이트를 그대로 읽는다.
#[tauri::command]
pub fn http_read_include(base: String, rel: String) -> Result<IncludeFile, String> {
    let p = resolve_relative(&base, &rel);
    let meta = p
        .metadata()
        .map_err(|e| format!("{}: {e}", p.to_string_lossy()))?;
    if !meta.is_file() {
        return Err(format!("파일이 아닙니다: {}", p.to_string_lossy()));
    }
    if meta.len() > MAX_INCLUDE_BYTES {
        return Err(format!(
            "끼워 넣을 파일이 너무 큽니다({:.1}MB).",
            meta.len() as f64 / (1024.0 * 1024.0)
        ));
    }
    let bytes = fs::read(&p).map_err(|e| e.to_string())?;
    Ok(IncludeFile {
        path: p.to_string_lossy().to_string(),
        size: meta.len(),
        text: String::from_utf8(bytes).ok(),
    })
}

/// `>>`(응답 저장) 지시자 처리 — 응답 본문을 파일로 쓴다.
///
/// `overwrite` 가 false 면(`>>`) 이미 있는 파일은 건드리지 않고 새 이름을 만들어
/// 쓴다(IntelliJ 도 `>>` 는 덮어쓰지 않고 `-1`, `-2` 를 붙인다). true 면(`>>!`) 덮어쓴다.
#[tauri::command]
pub fn http_save_response(
    base: String,
    rel: String,
    text: String,
    overwrite: bool,
) -> Result<String, String> {
    let mut p = resolve_relative(&base, &rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if !overwrite && p.exists() {
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "response".into());
        let ext = p.extension().map(|e| e.to_string_lossy().to_string());
        let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
        for n in 1..1000 {
            let name = match &ext {
                Some(e) => format!("{stem}-{n}.{e}"),
                None => format!("{stem}-{n}"),
            };
            let cand = dir.join(name);
            if !cand.exists() {
                p = cand;
                break;
            }
        }
    }
    fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(p.to_string_lossy().to_string())
}

/// 요청 하나를 보낸다.
#[tauri::command]
pub async fn http_send(req: SendReq) -> Result<SendRes, String> {
    let url = req.url.trim();
    if url.is_empty() {
        return Err("URL 이 비어 있습니다.".into());
    }
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("URL 을 해석할 수 없습니다: {url}\n({e})"))?;
    let method = reqwest::Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|_| format!("지원하지 않는 메서드: {}", req.method))?;

    // 본문 조각을 바이트로 이어 붙인다.
    let mut body: Vec<u8> = Vec::new();
    for chunk in &req.body {
        match chunk {
            BodyChunk::Text { text } => body.extend_from_slice(text.as_bytes()),
            BodyChunk::File { path } => {
                let p = expand_home(path);
                let bytes = fs::read(&p)
                    .map_err(|e| format!("본문 파일을 읽을 수 없습니다: {path}\n({e})"))?;
                body.extend_from_slice(&bytes);
            }
        }
    }

    let mut builder = reqwest::Client::builder()
        // 사내 서버가 자체 서명 인증서를 쓰는 경우가 많다(es.rs 와 같은 판단).
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_millis(
            req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        ));
    if req.no_redirect {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut rb = client.request(method, parsed.clone());
    for (name, value) in &req.headers {
        let n = name.trim();
        if n.is_empty() {
            continue;
        }
        let hn = reqwest::header::HeaderName::from_bytes(n.as_bytes())
            .map_err(|_| format!("헤더 이름이 올바르지 않습니다: {n}"))?;
        let hv = reqwest::header::HeaderValue::from_str(value.trim())
            .map_err(|_| format!("헤더 값이 올바르지 않습니다: {n}"))?;
        rb = rb.header(hn, hv);
    }
    if !body.is_empty() {
        rb = rb.body(body);
    }

    let started = Instant::now();
    let resp = rb.send().await.map_err(|e| format!("요청 실패: {e}"))?;
    let status = resp.status();
    let version = format!("{:?}", resp.version());
    let final_url = resp.url().to_string();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                v.to_str().unwrap_or("<바이너리 헤더 값>").to_string(),
            )
        })
        .collect();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let size = bytes.len() as u64;
    let (text, binary) = match String::from_utf8(bytes.to_vec()) {
        Ok(s) => (s, false),
        Err(e) => (String::from_utf8_lossy(e.as_bytes()).to_string(), true),
    };

    Ok(SendRes {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        http_version: version,
        headers,
        body: text,
        binary,
        size,
        elapsed_ms,
        final_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myspace-http-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn accepts_http_extensions_only() {
        assert!(is_http_file(Path::new("/a/b/api.http")));
        assert!(is_http_file(Path::new("/a/b/api.REST")));
        assert!(!is_http_file(Path::new("/a/b/api.json")));
        assert!(!is_http_file(Path::new("/a/b/api")));
    }

    #[test]
    fn write_refuses_other_extensions() {
        let err = http_write_file("/tmp/x.json".into(), "x".into()).unwrap_err();
        assert!(err.contains("HTTP 요청 파일"), "{err}");
    }

    /// 빌드 산출물 폴더를 건너뛰지 않으면 `src/test/resources` 의 파일이
    /// `target/test-classes` 사본과 함께 두 번 보인다 — 실제로 cowork 가 그렇다.
    #[test]
    fn skips_build_output_dirs() {
        let root = tmp("walk");
        fs::create_dir_all(root.join("src/test/resources/http")).unwrap();
        fs::create_dir_all(root.join("target/test-classes/http")).unwrap();
        fs::create_dir_all(root.join(".idea/httpRequests")).unwrap();
        fs::write(root.join("src/test/resources/http/a.http"), "GET /").unwrap();
        fs::write(root.join("target/test-classes/http/a.http"), "GET /").unwrap();
        fs::write(root.join(".idea/httpRequests/http-requests-log.http"), "x").unwrap();
        fs::write(root.join("root.rest"), "GET /").unwrap();

        let list = http_list_files(root.to_string_lossy().to_string()).unwrap();
        let rels: Vec<&str> = list.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["root.rest", "src/test/resources/http/a.http"]);
        assert_eq!(list[1].dir, "src/test/resources/http");
    }

    /// 가까운 환경 파일이 먼 것을, private 이 public 을 덮어쓴다.
    #[test]
    fn env_files_nearest_and_private_win() {
        let root = tmp("env");
        let sub = root.join("mod/http");
        fs::create_dir_all(&sub).unwrap();
        fs::write(
            root.join("http-client.env.json"),
            r#"{"dev":{"host":"root","port":1},"prod":{"host":"p"}}"#,
        )
        .unwrap();
        fs::write(
            sub.join("http-client.env.json"),
            r#"{"dev":{"host":"near"}}"#,
        )
        .unwrap();
        fs::write(
            sub.join("http-client.private.env.json"),
            r#"{"dev":{"token":"secret"}}"#,
        )
        .unwrap();
        fs::write(sub.join("a.http"), "GET /").unwrap();

        let envs = http_env_files(
            root.to_string_lossy().to_string(),
            sub.join("a.http").to_string_lossy().to_string(),
        )
        .unwrap();
        let dev = envs.envs.iter().find(|e| e.name == "dev").unwrap();
        assert_eq!(dev.vars.get("host").unwrap(), "near");
        // 먼 파일에만 있던 변수는 남아 있어야 한다(덮어쓰기가 아니라 병합).
        assert_eq!(dev.vars.get("port").unwrap(), "1");
        assert_eq!(dev.vars.get("token").unwrap(), "secret");
        assert_eq!(dev.private_keys, vec!["token"]);
        assert_eq!(envs.sources.len(), 3);
        assert!(envs.envs.iter().any(|e| e.name == "prod"));
    }

    /// 본문 조각(텍스트 + 파일)이 순서대로 이어 붙어 나가는지 — multipart 요청이
    /// 이 규칙 하나에 달려 있다. 헤더가 그대로 전달되는지도 같이 본다.
    #[tokio::test]
    async fn sends_body_chunks_in_order() {
        use axum::{routing::post, Router};

        let root = tmp("send");
        let bin = root.join("part.bin");
        fs::write(&bin, b"MIDDLE").unwrap();

        // 받은 메서드·헤더·본문을 그대로 돌려주는 에코 서버.
        let app = Router::new().route(
            "/echo",
            post(|headers: axum::http::HeaderMap, body: String| async move {
                let auth = headers
                    .get("x-attic-user")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                format!("{auth}|{body}")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let res = http_send(SendReq {
            method: "POST".into(),
            url: format!("http://127.0.0.1:{port}/echo"),
            headers: vec![("X-Attic-User".into(), "gdhong".into())],
            body: vec![
                BodyChunk::Text { text: "A\n".into() },
                BodyChunk::File {
                    path: bin.to_string_lossy().to_string(),
                },
                BodyChunk::Text { text: "\nZ".into() },
            ],
            timeout_ms: Some(5000),
            no_redirect: false,
        })
        .await
        .unwrap();

        assert_eq!(res.status, 200);
        assert_eq!(res.body, "gdhong|A\nMIDDLE\nZ");
        assert!(!res.binary);
    }

    /// `>>` 는 덮어쓰지 않고 새 이름을 만든다.
    #[test]
    fn save_response_keeps_existing_when_not_overwriting() {
        let root = tmp("save");
        fs::write(root.join("out.json"), "old").unwrap();
        let base = root.join("a.http").to_string_lossy().to_string();
        let p = http_save_response(base.clone(), "out.json".into(), "new".into(), false).unwrap();
        assert!(p.ends_with("out-1.json"), "{p}");
        assert_eq!(fs::read_to_string(root.join("out.json")).unwrap(), "old");
        let p2 = http_save_response(base, "out.json".into(), "new".into(), true).unwrap();
        assert!(p2.ends_with("out.json"), "{p2}");
        assert_eq!(fs::read_to_string(root.join("out.json")).unwrap(), "new");
    }
}
