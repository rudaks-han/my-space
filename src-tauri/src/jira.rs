//! Jira(Atlassian Cloud) 내 담당 이슈 조회.
//!
//! 설정(사이트 URL·계정 이메일·API 토큰)을 앱 설정 폴더의 파일에 저장하고, 모든 REST 호출을
//! 여기(Rust)에서 처리한다 — 토큰이 웹뷰(localStorage)에 노출되지 않게 하기 위함.
//! 인증은 Jira Cloud 표준인 Basic 인증(email:api_token)이다.
//!
//! API 토큰 발급: id.atlassian.com → 보안 → API 토큰 만들기.
//!
//! 이슈 검색은 신규 엔드포인트 `GET /rest/api/3/search/jql` 를 먼저 쓰고, 구형 사이트를 위해
//! 실패 시 `GET /rest/api/3/search` 로 폴백한다(구 엔드포인트는 Cloud 에서 제거되는 중).
//!
//! 본문·댓글은 API v3 에서 ADF(Atlassian Document Format) JSON 으로 오므로 `adf_to_text` 로
//! 평문화해서 넘긴다(웹뷰에서 HTML 을 렌더링하지 않기 위함 — XSS 표면을 만들지 않는다).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 프로세스 전역 reqwest 클라이언트(커넥션 재사용 — slack.rs 와 같은 이유).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

const CONFIG_FILE: &str = "jira_config.json";
/// 한 번에 가져올 이슈 수 상한.
const MAX_ISSUES: usize = 100;
/// 이슈 상세에서 가져올 댓글 수 상한.
const MAX_COMMENTS: usize = 50;

/// 목록 조회 시 요청할 필드(전체를 받으면 응답이 매우 커진다).
const LIST_FIELDS: &str =
    "summary,status,priority,issuetype,project,updated,created,duedate,parent,assignee";

#[derive(Serialize, Deserialize, Clone)]
struct JiraConfig {
    /// 사이트 주소. 끝 슬래시 없이 저장한다(예: https://example.atlassian.net).
    url: String,
    /// 계정 이메일.
    user: String,
    /// API 토큰.
    token: String,
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_config(app: &tauri::AppHandle) -> Option<JiraConfig> {
    let path = app_dir(app).ok()?.join(CONFIG_FILE);
    let raw = std::fs::read_to_string(path).ok()?;
    let cfg: JiraConfig = serde_json::from_str(&raw).ok()?;
    if cfg.url.is_empty() || cfg.user.is_empty() || cfg.token.is_empty() {
        None
    } else {
        Some(cfg)
    }
}

/// 사용자가 붙여넣은 주소를 정규화한다. 스킴이 없으면 https 를 붙이고, 끝 슬래시와
/// 실수로 함께 복사한 경로(/jira, /browse/... 등)는 떼어 사이트 루트만 남긴다.
fn normalize_url(input: &str) -> Result<String, String> {
    let s = input.trim().trim_end_matches('/');
    if s.is_empty() {
        return Err("empty_url".into());
    }
    let with_scheme = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    // 스킴 뒤 첫 '/' 이전까지가 호스트 — 그 뒤 경로는 버린다.
    let rest_at = with_scheme.find("://").map(|i| i + 3).unwrap_or(0);
    let host_end = with_scheme[rest_at..]
        .find('/')
        .map(|i| rest_at + i)
        .unwrap_or(with_scheme.len());
    let base = with_scheme[..host_end].trim_end_matches('/').to_string();
    if base[rest_at..].is_empty() {
        return Err("empty_url".into());
    }
    Ok(base)
}

/// Jira REST GET. 실패는 사람이 읽을 수 있는 문자열로 바꾼다.
async fn api_get(cfg: &JiraConfig, path: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let url = format!("{}{}", cfg.url, path);
    let resp = http()
        .get(&url)
        .basic_auth(&cfg.user, Some(&cfg.token))
        .header("Accept", "application/json")
        .query(params)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        // Jira 는 에러를 {"errorMessages":[...],"errors":{...}} 로 준다.
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("errorMessages")
                    .and_then(|m| m.as_array())
                    .and_then(|a| a.first())
                    .and_then(|x| x.as_str())
                    .map(String::from)
            })
            .unwrap_or_default();
        return Err(match status.as_u16() {
            401 => "unauthorized".to_string(),
            403 => "forbidden".to_string(),
            404 => format!("not_found:{path}"),
            code => {
                if detail.is_empty() {
                    format!("http_{code}")
                } else {
                    format!("http_{code}: {detail}")
                }
            }
        });
    }

    serde_json::from_str(&body).map_err(|e| format!("invalid_json: {e}"))
}

// ── ADF(Atlassian Document Format) → 평문 ────────────────────────────────────

/// 마지막 글자가 줄바꿈이 아닐 때만 줄바꿈을 넣는다(블록 중첩으로 빈 줄이 쌓이는 것 방지).
fn push_nl(out: &mut String) {
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
}

fn adf_to_text(node: &Value, out: &mut String) {
    let ty = node.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match ty {
        "text" => {
            if let Some(t) = node.get("text").and_then(|x| x.as_str()) {
                out.push_str(t);
            }
        }
        "hardBreak" => out.push('\n'),
        "mention" => out.push_str(
            node.pointer("/attrs/text")
                .and_then(|x| x.as_str())
                .unwrap_or("@사용자"),
        ),
        "emoji" => out.push_str(
            node.pointer("/attrs/text")
                .or_else(|| node.pointer("/attrs/shortName"))
                .and_then(|x| x.as_str())
                .unwrap_or(""),
        ),
        "inlineCard" | "blockCard" | "embedCard" => {
            if let Some(u) = node.pointer("/attrs/url").and_then(|x| x.as_str()) {
                out.push_str(u);
            }
        }
        "media" => out.push_str("[첨부]"),
        "rule" => {
            push_nl(out);
            out.push_str("———\n");
        }
        // 표는 셀을 각각 평문화한 뒤 " | " 로 잇는다(셀 안 문단의 줄바꿈은 공백으로).
        "tableRow" => {
            let cells: Vec<String> = node
                .get("content")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .map(|c| {
                            let mut s = String::new();
                            adf_to_text(c, &mut s);
                            s.trim().replace('\n', " ")
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push_str(&cells.join(" | "));
            push_nl(out);
        }
        _ => {
            if ty == "listItem" {
                out.push_str("• ");
            }
            if let Some(kids) = node.get("content").and_then(|x| x.as_array()) {
                for k in kids {
                    adf_to_text(k, out);
                }
            }
            if matches!(
                ty,
                "paragraph" | "heading" | "codeBlock" | "blockquote" | "listItem" | "panel"
            ) {
                push_nl(out);
            }
        }
    }
}

/// 본문 필드를 평문으로. ADF(객체)·구형 wiki 마크업(문자열)·null 모두 받는다.
fn rich_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(node) => {
            let mut out = String::new();
            adf_to_text(node, &mut out);
            out.trim_end().to_string()
        }
    }
}

// ── 프런트로 넘기는 모양 ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct JiraStatus {
    connected: bool,
    /// 연결된 사이트 주소(연결 안 됐으면 저장돼 있던 값이라도 보여 준다).
    url: Option<String>,
    /// 계정 이메일.
    user: Option<String>,
    /// Jira 상 표시 이름(myself 응답).
    display_name: Option<String>,
}

impl JiraStatus {
    fn disconnected(cfg: Option<&JiraConfig>) -> Self {
        Self {
            connected: false,
            url: cfg.map(|c| c.url.clone()),
            user: cfg.map(|c| c.user.clone()),
            display_name: None,
        }
    }
}

#[derive(Serialize)]
pub struct JiraIssue {
    key: String,
    summary: String,
    status: String,
    /// "new" | "indeterminate" | "done" | "undefined" — 색·그룹핑용.
    status_category: String,
    priority: Option<String>,
    issue_type: String,
    project_key: String,
    project_name: String,
    /// RFC3339.
    updated: String,
    created: String,
    /// "YYYY-MM-DD".
    due_date: Option<String>,
    /// 상위 이슈(에픽/부모) 키 + 제목.
    parent: Option<String>,
    /// 브라우저에서 열 주소.
    url: String,
}

#[derive(Serialize)]
pub struct JiraComment {
    id: String,
    author: String,
    created: String,
    body: String,
}

#[derive(Serialize)]
pub struct JiraIssueDetail {
    #[serde(flatten)]
    issue: JiraIssue,
    assignee: Option<String>,
    reporter: Option<String>,
    labels: Vec<String>,
    resolution: Option<String>,
    description: String,
    comments: Vec<JiraComment>,
    /// 댓글이 MAX_COMMENTS 보다 많아 잘렸는지.
    comments_truncated: bool,
}

fn str_at(v: &Value, ptr: &str) -> Option<String> {
    v.pointer(ptr)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// 검색/상세 응답의 이슈 하나를 프런트 모양으로.
fn parse_issue(site: &str, v: &Value) -> JiraIssue {
    let key = str_at(v, "/key").unwrap_or_default();
    let parent = v.pointer("/fields/parent").and_then(|p| {
        let k = str_at(p, "/key")?;
        let s = str_at(p, "/fields/summary").unwrap_or_default();
        Some(if s.is_empty() {
            k
        } else {
            format!("{k} · {s}")
        })
    });
    JiraIssue {
        url: format!("{site}/browse/{key}"),
        summary: str_at(v, "/fields/summary").unwrap_or_else(|| "(제목 없음)".into()),
        status: str_at(v, "/fields/status/name").unwrap_or_else(|| "알 수 없음".into()),
        status_category: str_at(v, "/fields/status/statusCategory/key")
            .unwrap_or_else(|| "undefined".into()),
        priority: str_at(v, "/fields/priority/name"),
        issue_type: str_at(v, "/fields/issuetype/name").unwrap_or_default(),
        project_key: str_at(v, "/fields/project/key").unwrap_or_default(),
        project_name: str_at(v, "/fields/project/name").unwrap_or_default(),
        updated: str_at(v, "/fields/updated").unwrap_or_default(),
        created: str_at(v, "/fields/created").unwrap_or_default(),
        due_date: str_at(v, "/fields/duedate"),
        parent,
        key,
    }
}

// ── 명령 ─────────────────────────────────────────────────────────────────────

/// 설정을 검증(/myself 호출)하고 유효하면 파일에 저장한다.
#[tauri::command]
pub async fn jira_save_config(
    app: tauri::AppHandle,
    url: String,
    user: String,
    token: String,
) -> Result<JiraStatus, String> {
    let cfg = JiraConfig {
        url: normalize_url(&url)?,
        user: user.trim().to_string(),
        token: token.trim().to_string(),
    };
    if cfg.user.is_empty() {
        return Err("empty_user".into());
    }
    if cfg.token.is_empty() {
        return Err("empty_token".into());
    }

    let me = api_get(&cfg, "/rest/api/3/myself", &[]).await?;

    let json = serde_json::to_string(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(app_dir(&app)?.join(CONFIG_FILE), json).map_err(|e| e.to_string())?;

    Ok(JiraStatus {
        connected: true,
        url: Some(cfg.url),
        user: Some(cfg.user),
        display_name: str_at(&me, "/displayName"),
    })
}

/// 저장된 설정의 연결 상태.
#[tauri::command]
pub async fn jira_status(app: tauri::AppHandle) -> Result<JiraStatus, String> {
    let Some(cfg) = read_config(&app) else {
        return Ok(JiraStatus::disconnected(None));
    };
    match api_get(&cfg, "/rest/api/3/myself", &[]).await {
        Ok(me) => Ok(JiraStatus {
            connected: true,
            url: Some(cfg.url.clone()),
            user: Some(cfg.user.clone()),
            display_name: str_at(&me, "/displayName"),
        }),
        Err(_) => Ok(JiraStatus::disconnected(Some(&cfg))),
    }
}

/// 저장된 설정을 삭제한다(연결 해제).
#[tauri::command]
pub fn jira_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(dir) = app_dir(&app) {
        let _ = std::fs::remove_file(dir.join(CONFIG_FILE));
    }
    Ok(())
}

/// 내가 담당(assignee)인 이슈 목록. `include_done` 이 false 면 완료 상태는 제외한다.
#[tauri::command]
pub async fn jira_my_issues(
    app: tauri::AppHandle,
    include_done: Option<bool>,
) -> Result<Vec<JiraIssue>, String> {
    let cfg = read_config(&app).ok_or("no_config")?;
    let jql = if include_done.unwrap_or(false) {
        "assignee = currentUser() ORDER BY updated DESC".to_string()
    } else {
        "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC".to_string()
    };

    let params = [
        ("jql", jql),
        ("maxResults", MAX_ISSUES.to_string()),
        ("fields", LIST_FIELDS.to_string()),
    ];

    // 신규 엔드포인트 우선, 없으면(구형 사이트) 구 엔드포인트로 폴백.
    let v = match api_get(&cfg, "/rest/api/3/search/jql", &params).await {
        Ok(v) => v,
        Err(e) if e.starts_with("not_found:") => {
            api_get(&cfg, "/rest/api/3/search", &params).await?
        }
        Err(e) => return Err(e),
    };

    let issues = v
        .get("issues")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().map(|i| parse_issue(&cfg.url, i)).collect())
        .unwrap_or_default();
    Ok(issues)
}

/// 이슈 하나의 상세(본문 + 댓글).
#[tauri::command]
pub async fn jira_issue_detail(
    app: tauri::AppHandle,
    key: String,
) -> Result<JiraIssueDetail, String> {
    let cfg = read_config(&app).ok_or("no_config")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("empty_key".into());
    }

    let v = api_get(
        &cfg,
        &format!("/rest/api/3/issue/{key}"),
        &[(
            "fields",
            format!("{LIST_FIELDS},description,reporter,labels,resolution"),
        )],
    )
    .await?;

    // 댓글은 별도 호출 — 오래된 순으로 최대 MAX_COMMENTS 개.
    let (comments, comments_truncated) = match api_get(
        &cfg,
        &format!("/rest/api/3/issue/{key}/comment"),
        &[
            ("maxResults", MAX_COMMENTS.to_string()),
            ("orderBy", "created".to_string()),
        ],
    )
    .await
    {
        Ok(c) => {
            let total = c.get("total").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
            let list = c
                .get("comments")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .map(|c| JiraComment {
                            id: str_at(c, "/id").unwrap_or_default(),
                            author: str_at(c, "/author/displayName")
                                .unwrap_or_else(|| "알 수 없음".into()),
                            created: str_at(c, "/created").unwrap_or_default(),
                            body: rich_text(c.get("body")),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let truncated = total > list.len();
            (list, truncated)
        }
        // 댓글 권한이 없거나 실패해도 본문은 보여 준다.
        Err(e) => {
            log::info!("Jira 댓글 조회 실패({key}): {e}");
            (Vec::new(), false)
        }
    };

    Ok(JiraIssueDetail {
        issue: parse_issue(&cfg.url, &v),
        assignee: str_at(&v, "/fields/assignee/displayName"),
        reporter: str_at(&v, "/fields/reporter/displayName"),
        labels: v
            .pointer("/fields/labels")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        resolution: str_at(&v, "/fields/resolution/name"),
        description: rich_text(v.pointer("/fields/description")),
        comments,
        comments_truncated,
    })
}

/// 이슈를 시스템 브라우저에서 연다.
#[tauri::command]
pub fn jira_open_issue(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let cfg = read_config(&app).ok_or("no_config")?;
    let url = format!("{}/browse/{}", cfg.url, key.trim());
    app.opener()
        .open_url(&url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 사이트 주소는 사용자가 브라우저 주소창에서 통째로 복사해 붙이기 쉬우므로,
    /// 스킴 없음·끝 슬래시·뒤에 붙은 경로를 모두 사이트 루트로 정규화해야 한다.
    #[test]
    fn normalizes_site_url() {
        let expected = "https://example.atlassian.net";
        assert_eq!(normalize_url("example.atlassian.net").unwrap(), expected);
        assert_eq!(
            normalize_url("https://example.atlassian.net/").unwrap(),
            expected
        );
        assert_eq!(
            normalize_url(" https://example.atlassian.net/jira/software/projects/AB ").unwrap(),
            expected
        );
        assert!(normalize_url("  ").is_err());
    }

    /// 본문·댓글은 ADF(JSON 트리)로 오므로 문단·목록·표·멘션이 읽을 수 있는
    /// 평문으로 접혀야 한다(웹뷰에는 평문만 넘긴다).
    #[test]
    fn flattens_adf_to_text() {
        let doc = json!({"type":"doc","version":1,"content":[
          {"type":"paragraph","content":[{"type":"text","text":"첫 줄 "},{"type":"mention","attrs":{"text":"@홍길동"}},{"type":"text","text":" 확인"}]},
          {"type":"bulletList","content":[
            {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"항목1"}]}]},
            {"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"항목2"}]}]}]},
          {"type":"table","content":[
            {"type":"tableRow","content":[
              {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"A"}]}]},
              {"type":"tableHeader","content":[{"type":"paragraph","content":[{"type":"text","text":"B"}]}]}]},
            {"type":"tableRow","content":[
              {"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"1"}]}]},
              {"type":"tableCell","content":[{"type":"paragraph","content":[{"type":"text","text":"2"}]}]}]}]},
          {"type":"paragraph","content":[{"type":"text","text":"끝"},{"type":"hardBreak"},{"type":"inlineCard","attrs":{"url":"https://x.example"}}]}
        ]});
        assert_eq!(
            rich_text(Some(&doc)),
            "첫 줄 @홍길동 확인\n• 항목1\n• 항목2\nA | B\n1 | 2\n끝\nhttps://x.example"
        );
        // 구형 사이트는 본문이 wiki 마크업 문자열로 온다.
        assert_eq!(rich_text(Some(&json!("옛 위키 텍스트"))), "옛 위키 텍스트");
        assert_eq!(rich_text(None), "");
        assert_eq!(rich_text(Some(&json!(null))), "");
    }
}
