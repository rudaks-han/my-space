//! Slack 안 읽은 메시지 조회 기능.
//!
//! 사용자 토큰(xoxp-)을 앱 설정 폴더의 파일에 저장하고, 모든 Slack Web API 호출을
//! 여기(Rust)에서 처리한다 — 토큰이 웹뷰(localStorage)에 노출되지 않게 하기 위함.
//!
//! 채널이 매우 많을 수 있어(수백 개) "전체"를 매번 확인하지 않는다. 사용자가 고른
//! 채널 id 목록을 파일에 저장해두고, 안 읽음 조회는 그 채널만 대상으로 한다.
//!
//! **DM·그룹 DM 은 예외로 고르지 않아도 항상 대상이다** — 개인에게 직접 온 말은 거의 항상
//! 중요한데, 그것을 채널 선택 목록에서 사람마다 하나씩 골라 두게 하는 것은 현실적이지 않다
//! (누가 언제 처음 말을 걸지 알 수 없으므로 애초에 고를 수가 없다). 대신 **자동으로 포함된
//! 대화에서는 봇·앱이 보낸 메시지를 세지 않는다**: 앱 DM(빌드 알림, 설문 봇 …)까지 개인
//! 메시지로 취급하면 자동 포함이 곧 소음이 된다. 반대로 **사용자가 직접 고른 채널에서는
//! 봇 메시지를 거르지 않는다** — 봇 알림 채널(예: 점심 메뉴)은 그걸 보려고 고른 것이다.
//!
//! 자동 포함의 대가는 호출량이다(실측: 이 워크스페이스의 DM 173개 = 1:1 80 + 그룹 93).
//! `conversations.info` 는 Tier 3(분당 50회)라 매 주기에 전부 확인하는 것은 불가능하고,
//! 한 번에 전체 안 읽음을 주는 API 도 없다(`users.counts`·`client.counts` 는
//! `not_allowed_token_type`, `im.list`·`mpim.list` 는 폐기됨). 대화 목록의 `updated` 는
//! 활동 시각이 **아니어서**(실측: 최신 메시지보다 14일 뒤처진 대화가 있었다) 선별에 쓸 수
//! 없다. 그래서 자동 DM 은 **회전 스캔**한다 — `DM_SCAN_PER_POLL` 참고.
//!
//! 필요한 사용자 토큰 스코프:
//!   channels:read, groups:read, im:read, mpim:read            (대화 목록·정보)
//!   channels:history, groups:history, im:history, mpim:history (메시지 읽기)
//!   users:read                                                (보낸 사람 이름)
//!
//! 안 읽음 판정: conversations.info 의 unread_count_display 는 항상 채워지지 않으므로,
//! last_read 이후의 메시지를 conversations.history 로 가져와 (내 메시지·시스템 메시지 제외)
//! 남는 게 있으면 안 읽음으로 본다. 한 군데만 예외로 그 값을 믿는데, **1:1 DM 에는 실려
//! 오는 것이 실측으로 확인됐고**(안 읽음이 있는 DM 에서 `1` 을 돌려줬다) 자동 포함된 DM 은
//! 수가 많아 "0이면 히스토리를 건너뛴다" 는 지름길이 호출을 절반으로 줄이기 때문이다
//! (`scan_conversation` 의 한계 설명 참고). 그룹 DM 에는 이 값이 없다.
//!
//! 스레드(댓글)는 채널과 읽음 상태가 별개이고, **구독 중인 스레드만** 셀 수 있다 —
//! Slack 이 스레드 읽음 위치를 구독 스레드에만 알려 주기 때문이다(`slack_unreads` 참고).

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// 프로세스 전역에서 공유하는 reqwest 클라이언트.
/// 매 API 호출마다 `Client::new()` 하면 커넥션 풀이 없어 요청마다 새 TCP/TLS 연결을 열게 되고
/// ("starting new connection" 로그 폭주), 폴링 시 불필요한 핸드셰이크 비용이 든다. 하나를 재사용해
/// keep-alive 커넥션을 재활용한다(Client 는 내부적으로 Arc 라 복제/공유가 저렴하다).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

const TOKEN_FILE: &str = "slack_token.txt";
const SELECTED_FILE: &str = "slack_selected.json";
/// users.conversations 페이지네이션 상한(200 * 8 = 최대 1600개 대화).
const MAX_CONVO_PAGES: usize = 8;
/// 채널당 가져올 최근 히스토리 수(최상위 미읽음 판정 + 스레드 부모 탐색용).
const HISTORY_LIMIT: usize = 30;
/// 카드에 실제로 보여줄 미리보기 메시지 수.
const PREVIEW_LIMIT: usize = 6;
/// 채널당 답글을 조회할 스레드(부모) 최대 개수(요청 폭주 방지).
const MAX_THREAD_SCANS: usize = 10;
/// 스레드 하나에서 가져올 최대 답글 수.
const THREAD_REPLY_LIMIT: usize = 30;
/// 자동 포함된 DM 을 한 번의 조회에서 몇 개까지 확인할지.
///
/// `conversations.info` 는 Tier 3(분당 50회)이고 **선택 채널도 같은 버킷을 쓴다**. 기본
/// 폴링 주기(120초)에 쓸 수 있는 예산이 약 100회이므로, 선택 채널 몫을 남기고 이만큼만
/// 회전시킨다. DM 173개면 한 바퀴에 약 7주기(≈14분)가 걸린다 — 자주 대화하는 상대는
/// `hot`(지난번 안 읽음이 있던 대화)으로 매번 확인되므로 이 지연은 **한동안 말이 없던
/// 상대가 처음 말을 걸었을 때**의 최악값이다.
const DM_SCAN_PER_POLL: usize = 24;
/// DM 목록(`users.conversations`)을 다시 받아오는 주기. 목록 자체는 1~8회 호출이라
/// 매번 받아올 이유가 없지만, 새로 열린 DM 을 이 시간 안에는 알아채야 한다.
const DM_LIST_TTL: Duration = Duration::from_secs(600);

/// Slack 메시지 ts("1234567890.123456") → f64. 파싱 실패 시 0.0.
fn ts_f(m: &Value) -> f64 {
    m.get("ts")
        .and_then(|x| x.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
}

/// 메시지 표시 텍스트. 본문(text)이 비어 있으면(봇/앱 메시지) blocks·attachments 에서
/// 내용을 최대한 끌어온다(예: 점심 메뉴 봇은 본문이 blocks/attachments 에 담긴다).
fn message_text(m: &Value) -> String {
    if let Some(t) = m.get("text").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        return t.to_string();
    }
    // Block Kit section 텍스트.
    if let Some(blocks) = m.get("blocks").and_then(|x| x.as_array()) {
        let mut buf = String::new();
        for b in blocks {
            if let Some(s) = b.pointer("/text/text").and_then(|x| x.as_str()) {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(s);
            }
        }
        if !buf.is_empty() {
            return buf;
        }
    }
    // 첨부(attachments) 폴백.
    if let Some(atts) = m.get("attachments").and_then(|x| x.as_array()) {
        for a in atts {
            for key in ["text", "fallback", "pretext", "title"] {
                if let Some(s) = a.get(key).and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
                    return s.to_string();
                }
            }
        }
    }
    String::new()
}

/// 실제 대화 내용이 아닌 시스템/멤버십 이벤트 subtype (안 읽음에서 제외).
/// ⚠️ bot_message·file_share·thread_broadcast 등 내용 있는 subtype 은 제외하지 않는다
///    (봇이 올리는 알림 채널 - 예: 점심 메뉴 - 이 안 보이던 문제 방지).
fn is_system_subtype(subtype: &str) -> bool {
    matches!(
        subtype,
        "channel_join"
            | "channel_leave"
            | "channel_topic"
            | "channel_purpose"
            | "channel_name"
            | "channel_archive"
            | "channel_unarchive"
            | "group_join"
            | "group_leave"
            | "group_topic"
            | "group_purpose"
            | "group_name"
            | "group_archive"
            | "group_unarchive"
            | "bot_add"
            | "bot_remove"
            | "pinned_item"
            | "unpinned_item"
            | "reminder_add"
    )
}

/// 봇·앱이 보낸 메시지인가.
///
/// **자동 포함된 DM 에만 적용한다.** 사용자가 직접 고른 채널에서 이걸 거르면 봇 알림
/// 채널이 통째로 사라진다(모듈 주석과 `is_system_subtype` 의 경고 참고).
///
/// 세 가지를 모두 본다: 앱이 보낸 메시지는 `bot_id` 를 달고 오고(사용자 토큰으로 올린
/// 워크플로 메시지 포함), 고전적인 봇 메시지는 `subtype: bot_message` 이며, Slackbot 은
/// 둘 다 없이 `user: USLACKBOT` 로만 구분된다.
fn is_bot_message(m: &Value) -> bool {
    m.get("bot_id").is_some()
        || m.get("subtype").and_then(|x| x.as_str()) == Some("bot_message")
        || m.get("user").and_then(|x| x.as_str()) == Some("USLACKBOT")
}

/// 자동 포함 DM 의 회전 스캔 상태(프로세스 전역).
#[derive(Default)]
struct DmScan {
    /// 회전 대상 DM id. 없으면 아직 목록을 못 받아온 것이다.
    ids: Vec<String>,
    fetched_at: Option<std::time::Instant>,
    /// 다음 주기에 확인을 시작할 위치.
    cursor: usize,
    /// 지난 조회에서 안 읽음이 있던 DM. **회전과 무관하게 매번 확인한다** — 사용자가
    /// Slack 에서 읽었을 때 목록에서 바로 빠져야 하고(펫 알림도 그때 거둬진다), 대화가
    /// 오가는 중인 상대는 다음 답장도 곧 올 가능성이 높다.
    hot: std::collections::HashSet<String>,
}

fn dm_scan() -> &'static std::sync::Mutex<DmScan> {
    static STATE: OnceLock<std::sync::Mutex<DmScan>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// 이번 조회에서 확인할 자동 포함 DM id 목록(선택 채널은 어차피 매번 보므로 제외).
///
/// 잠금은 `await` 를 사이에 두지 않는다 — 표준 `Mutex` 를 await 너머로 들고 가면 다른
/// 호출이 그동안 통째로 막힌다.
async fn dm_targets(token: &str, selected: &[String]) -> Vec<String> {
    let stale = {
        let s = dm_scan().lock().unwrap();
        s.fetched_at
            .map(|t| t.elapsed() >= DM_LIST_TTL)
            .unwrap_or(true)
    };
    if stale {
        // 목록을 못 받아오면(일시 오류) 이전 목록을 그대로 쓴다 — DM 감시가 통째로
        // 멎는 것보다 낫고, 다음 주기에 다시 시도한다.
        if let Ok(convos) = list_convos(token).await {
            let mut ids: Vec<String> = Vec::new();
            for c in &convos {
                let kind = kind_of(c);
                if kind != "im" && kind != "mpim" {
                    continue;
                }
                // 탈퇴한 사람과의 DM 은 새 메시지가 올 수 없다.
                if c.get("is_user_deleted")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Some(id) = c.get("id").and_then(|x| x.as_str()) {
                    ids.push(id.to_string());
                }
            }
            let mut s = dm_scan().lock().unwrap();
            // 사라진 대화는 hot 에서도 지운다(영원히 매번 확인하게 되는 것을 막는다).
            s.hot.retain(|id| ids.contains(id));
            s.ids = ids;
            s.fetched_at = Some(std::time::Instant::now());
            if s.cursor >= s.ids.len() {
                s.cursor = 0;
            }
        }
    }

    let mut s = dm_scan().lock().unwrap();
    let sel: std::collections::HashSet<&str> = selected.iter().map(String::as_str).collect();
    let mut out: Vec<String> = Vec::new();
    for id in &s.hot {
        if !sel.contains(id.as_str()) {
            out.push(id.clone());
        }
    }
    let n = s.ids.len();
    let take = DM_SCAN_PER_POLL.min(n);
    for i in 0..take {
        let id = s.ids[(s.cursor + i) % n].clone();
        if !sel.contains(id.as_str()) && !out.contains(&id) {
            out.push(id);
        }
    }
    s.cursor = if n == 0 { 0 } else { (s.cursor + take) % n };
    out
}

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_token(app: &tauri::AppHandle) -> Option<String> {
    let path = app_dir(app).ok()?.join(TOKEN_FILE);
    let token = std::fs::read_to_string(path).ok()?.trim().to_string();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

fn read_selected(app: &tauri::AppHandle) -> Vec<String> {
    (|| {
        let path = app_dir(app).ok()?.join(SELECTED_FILE);
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str::<Vec<String>>(&raw).ok()
    })()
    .unwrap_or_default()
}

#[derive(Serialize)]
pub struct SlackStatus {
    connected: bool,
    team: Option<String>,
    user: Option<String>,
}

impl SlackStatus {
    fn disconnected() -> Self {
        Self {
            connected: false,
            team: None,
            user: None,
        }
    }
    fn from_auth(v: &Value) -> Self {
        Self {
            connected: true,
            team: v.get("team").and_then(|x| x.as_str()).map(String::from),
            user: v.get("user").and_then(|x| x.as_str()).map(String::from),
        }
    }
}

/// 선택 UI 에 표시할 채널 정보.
#[derive(Serialize)]
pub struct ChannelInfo {
    id: String,
    name: String,
    kind: String,
}

#[derive(Serialize)]
pub struct UnreadMessage {
    user: String,
    text: String,
    ts: String,
    /// 스레드 답글이면 부모 메시지 ts. 최상위(채널) 메시지면 None.
    thread_ts: Option<String>,
    /// 스레드 답글일 때 부모(스레드 루트) 작성자. 화면에서 댓글 구조로 묶어 보여주기 위한 맥락.
    parent_user: Option<String>,
    /// 스레드 답글일 때 부모(스레드 루트) 본문(포맷된 텍스트).
    parent_text: Option<String>,
}

#[derive(Serialize)]
pub struct ChannelUnread {
    id: String,
    name: String,
    /// "channel" | "private" | "mpim" | "im"
    kind: String,
    unread: u32,
    /// HISTORY_LIMIT 만큼 가져왔을 때 그 이상 더 있을 수 있음(배지에 "+" 표시용).
    has_more: bool,
    messages: Vec<UnreadMessage>,
}

/// Slack Web API GET 호출. `ok:false` 는 error 문자열로, 429 는 Retry-After 만큼 대기 후 재시도.
async fn api_get(token: &str, method: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let client = http();
    let url = format!("https://slack.com/api/{method}");
    let mut attempts = 0u8;

    loop {
        let resp = client
            .get(&url)
            .bearer_auth(token)
            .query(params)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().as_u16() == 429 {
            attempts += 1;
            if attempts > 5 {
                return Err("rate_limited".into());
            }
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(5)
                .min(60);
            tokio::time::sleep(Duration::from_secs(wait)).await;
            continue;
        }

        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        if v.get("ok").and_then(|b| b.as_bool()) != Some(true) {
            let err = v
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("unknown_error");
            return Err(err.to_string());
        }
        return Ok(v);
    }
}

/// 사용자 id → 표시 이름. 요청 단위 캐시로 중복 호출을 줄인다.
async fn resolve_user(token: &str, uid: &str, cache: &mut HashMap<String, String>) -> String {
    if uid.is_empty() {
        return "알 수 없음".to_string();
    }
    if let Some(name) = cache.get(uid) {
        return name.clone();
    }
    let name = match api_get(token, "users.info", &[("user", uid.to_string())]).await {
        Ok(v) => {
            let u = v.get("user").cloned().unwrap_or_default();
            u.pointer("/profile/display_name")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| u.pointer("/profile/real_name").and_then(|x| x.as_str()))
                .or_else(|| u.get("name").and_then(|x| x.as_str()))
                .unwrap_or(uid)
                .to_string()
        }
        Err(_) => uid.to_string(),
    };
    cache.insert(uid.to_string(), name.clone());
    name
}

/// Slack usergroup(subteam) id → 표시 이름. usergroups.list 를 1회 로드해 캐시.
/// (usergroups:read 스코프가 없으면 빈 맵이 되어 "@그룹" 으로 폴백)
async fn usergroup_name(
    token: &str,
    id: &str,
    gcache: &mut Option<HashMap<String, String>>,
) -> Option<String> {
    if gcache.is_none() {
        let mut map = HashMap::new();
        if let Ok(v) = api_get(token, "usergroups.list", &[]).await {
            if let Some(arr) = v.get("usergroups").and_then(|x| x.as_array()) {
                for g in arr {
                    let gid = g.get("id").and_then(|x| x.as_str());
                    let name = g
                        .get("handle")
                        .and_then(|x| x.as_str())
                        .filter(|s| !s.is_empty())
                        .or_else(|| g.get("name").and_then(|x| x.as_str()));
                    if let (Some(gid), Some(name)) = (gid, name) {
                        map.insert(gid.to_string(), name.to_string());
                    }
                }
            }
        }
        *gcache = Some(map);
    }
    gcache.as_ref().and_then(|m| m.get(id).cloned())
}

/// 하나의 `<...>` Slack 엔티티를 사람이 읽을 형태로 변환.
async fn render_entity(
    token: &str,
    inner: &str,
    ucache: &mut HashMap<String, String>,
    gcache: &mut Option<HashMap<String, String>>,
) -> String {
    // 링크 <url|label> / <url>
    if inner.starts_with("http://")
        || inner.starts_with("https://")
        || inner.starts_with("mailto:")
    {
        return match inner.split_once('|') {
            Some((_, label)) => label.to_string(),
            None => inner.to_string(),
        };
    }
    // 사용자 멘션 <@U123> / <@U123|name>
    if let Some(rest) = inner.strip_prefix('@') {
        if let Some((_, name)) = rest.split_once('|') {
            return format!("@{name}");
        }
        return format!("@{}", resolve_user(token, rest, ucache).await);
    }
    // 채널 멘션 <#C123|name> / <#C123>
    if let Some(rest) = inner.strip_prefix('#') {
        if let Some((_, name)) = rest.split_once('|') {
            return format!("#{name}");
        }
        return "#채널".to_string();
    }
    // 특수/그룹 멘션 <!...>
    if let Some(rest) = inner.strip_prefix('!') {
        if let Some(sub) = rest.strip_prefix("subteam^") {
            return match sub.split_once('|') {
                Some((_, name)) => format!("@{name}"),
                None => match usergroup_name(token, sub, gcache).await {
                    Some(name) => format!("@{name}"),
                    None => "@그룹".to_string(),
                },
            };
        }
        let kw = rest.split(['|', '^']).next().unwrap_or(rest);
        return match kw {
            "here" => "@here".to_string(),
            "channel" => "@channel".to_string(),
            "everyone" => "@everyone".to_string(),
            // <!date^...|fallback> 등은 마지막 | 뒤 폴백 문구 사용
            _ => rest
                .rsplit_once('|')
                .map(|(_, f)| f.to_string())
                .unwrap_or_else(|| format!("<!{rest}>")),
        };
    }
    // 알 수 없는 엔티티는 원형 유지
    format!("<{inner}>")
}

/// Slack 메시지 텍스트의 마크업(멘션·링크·엔티티)을 사람이 읽는 형태로 변환.
async fn format_message(
    token: &str,
    text: &str,
    ucache: &mut HashMap<String, String>,
    gcache: &mut Option<HashMap<String, String>>,
) -> String {
    let mut result = String::new();
    let mut rest = text;
    while let Some(lt) = rest.find('<') {
        result.push_str(&rest[..lt]);
        let after = &rest[lt + 1..];
        if let Some(gt) = after.find('>') {
            let inner = &after[..gt];
            result.push_str(&render_entity(token, inner, ucache, gcache).await);
            rest = &after[gt + 1..];
        } else {
            result.push('<');
            rest = after;
        }
    }
    result.push_str(rest);
    // Slack 이 이스케이프한 HTML 엔티티 디코드(각 괄호 처리 후에 수행)
    result
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn kind_of(c: &Value) -> &'static str {
    if c.get("is_im").and_then(|x| x.as_bool()).unwrap_or(false) {
        "im"
    } else if c.get("is_mpim").and_then(|x| x.as_bool()).unwrap_or(false) {
        "mpim"
    } else if c.get("is_private").and_then(|x| x.as_bool()).unwrap_or(false) {
        "private"
    } else {
        "channel"
    }
}

/// "mpdm-a--b--c-1" → "a, b, c" (아이디 파싱 폴백).
fn pretty_mpim(name: &str) -> String {
    let n = name.strip_prefix("mpdm-").unwrap_or(name);
    let n = n.strip_suffix("-1").unwrap_or(n);
    n.split("--").collect::<Vec<_>>().join(", ")
}

/// 그룹 DM(mpim)의 멤버 id 를 표시 이름으로 바꿔 "가, 나, 다" 로 만든다.
/// 채널 이름은 사용자 핸들(아이디)만 담고 있어, 멤버를 실제 이름으로 보여주려면
/// conversations.members 로 멤버 uid 를 얻어 resolve_user 로 표시 이름을 붙인다.
/// 실패하면 None 을 돌려 채널 이름 파싱 폴백을 쓴다.
async fn mpim_member_names(
    token: &str,
    channel: &str,
    cache: &mut HashMap<String, String>,
) -> Option<String> {
    if channel.is_empty() {
        return None;
    }
    let v = api_get(
        token,
        "conversations.members",
        &[("channel", channel.to_string())],
    )
    .await
    .ok()?;
    let members = v.get("members").and_then(|x| x.as_array())?;
    let mut names = Vec::new();
    for m in members {
        if let Some(uid) = m.as_str() {
            names.push(resolve_user(token, uid, cache).await);
        }
    }
    if names.is_empty() {
        return None;
    }
    Some(names.join(", "))
}

/// 대화 객체(users.conversations / conversations.info 의 channel)에서 표시 이름을 만든다.
async fn convo_name(token: &str, c: &Value, cache: &mut HashMap<String, String>) -> String {
    if c.get("is_im").and_then(|x| x.as_bool()).unwrap_or(false) {
        let uid = c.get("user").and_then(|x| x.as_str()).unwrap_or("");
        return resolve_user(token, uid, cache).await;
    }
    if c.get("is_mpim").and_then(|x| x.as_bool()).unwrap_or(false) {
        let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(names) = mpim_member_names(token, id, cache).await {
            return names;
        }
        if let Some(n) = c.get("name").and_then(|x| x.as_str()) {
            return pretty_mpim(n);
        }
    }
    c.get("name")
        .and_then(|x| x.as_str())
        .or_else(|| c.get("id").and_then(|x| x.as_str()))
        .unwrap_or("?")
        .to_string()
}

/// 내가 속한 모든 대화 목록(페이지네이션).
async fn list_convos(token: &str) -> Result<Vec<Value>, String> {
    let mut convos: Vec<Value> = Vec::new();
    let mut cursor = String::new();
    for _ in 0..MAX_CONVO_PAGES {
        let mut params = vec![
            (
                "types",
                "public_channel,private_channel,mpim,im".to_string(),
            ),
            ("exclude_archived", "true".to_string()),
            ("limit", "200".to_string()),
        ];
        if !cursor.is_empty() {
            params.push(("cursor", cursor.clone()));
        }
        let v = api_get(token, "users.conversations", &params).await?;
        if let Some(arr) = v.get("channels").and_then(|c| c.as_array()) {
            convos.extend(arr.iter().cloned());
        }
        cursor = v
            .pointer("/response_metadata/next_cursor")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if cursor.is_empty() {
            break;
        }
    }
    Ok(convos)
}

/// 토큰을 검증(auth.test)하고 유효하면 파일에 저장한다.
#[tauri::command]
pub async fn slack_save_token(app: tauri::AppHandle, token: String) -> Result<SlackStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("empty_token".into());
    }
    let v = api_get(&token, "auth.test", &[]).await?;
    std::fs::write(app_dir(&app)?.join(TOKEN_FILE), &token).map_err(|e| e.to_string())?;
    Ok(SlackStatus::from_auth(&v))
}

/// 저장된 토큰의 연결 상태를 반환한다.
#[tauri::command]
pub async fn slack_status(app: tauri::AppHandle) -> Result<SlackStatus, String> {
    match read_token(&app) {
        None => Ok(SlackStatus::disconnected()),
        Some(token) => match api_get(&token, "auth.test", &[]).await {
            Ok(v) => Ok(SlackStatus::from_auth(&v)),
            Err(_) => Ok(SlackStatus::disconnected()),
        },
    }
}

/// 저장된 토큰을 삭제한다(연결 해제). 선택 목록은 남겨둔다.
#[tauri::command]
pub fn slack_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(dir) = app_dir(&app) {
        let _ = std::fs::remove_file(dir.join(TOKEN_FILE));
    }
    Ok(())
}

/// 선택 UI 용 전체 채널 목록(이름 해석 포함).
#[tauri::command]
pub async fn slack_channels(app: tauri::AppHandle) -> Result<Vec<ChannelInfo>, String> {
    let token = read_token(&app).ok_or("no_token")?;
    let convos = list_convos(&token).await?;
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut out: Vec<ChannelInfo> = Vec::new();
    for c in &convos {
        let id = c.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let kind = kind_of(c).to_string();
        let name = convo_name(&token, c, &mut cache).await;
        out.push(ChannelInfo { id, name, kind });
    }
    // 이름순 정렬(대소문자 무시).
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 저장된 선택 채널 id 목록.
#[tauri::command]
pub fn slack_get_selected(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(read_selected(&app))
}

/// 선택 채널 id 목록을 저장한다.
#[tauri::command]
pub fn slack_set_selected(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    let json = serde_json::to_string(&ids).map_err(|e| e.to_string())?;
    std::fs::write(app_dir(&app)?.join(SELECTED_FILE), json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 선택한 채널 + 자동 포함된 DM 을 대상으로 안 읽은 메시지를 조회한다.
///
/// DM 은 고르지 않아도 대상이지만 173개를 매번 확인할 수는 없어 회전 스캔한다
/// (`dm_targets`). 그래서 이 명령의 결과는 "선택 채널 전부 + 이번 차례의 DM" 이며,
/// 화면과 알림은 그 합집합을 누적해서 보는 게 아니라 매번 이 스냅샷으로 갱신된다 —
/// 이번에 확인하지 않은 DM 은 조용히 빠지는 게 아니라 **다음 차례에 다시 들어온다**.
#[tauri::command]
pub async fn slack_unreads(app: tauri::AppHandle) -> Result<Vec<ChannelUnread>, String> {
    let token = read_token(&app).ok_or("no_token")?;
    let selected = read_selected(&app);
    let dms = dm_targets(&token, &selected).await;
    if selected.is_empty() && dms.is_empty() {
        return Ok(Vec::new());
    }

    // 내 메시지는 안 읽음에서 제외하기 위해 내 user_id 확보.
    let me = api_get(&token, "auth.test", &[])
        .await
        .ok()
        .and_then(|v| v.get("user_id").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();

    let mut cache: HashMap<String, String> = HashMap::new();
    // usergroup(subteam) 이름 캐시. None = 아직 로드 안 함.
    let mut gcache: Option<HashMap<String, String>> = None;
    let mut result: Vec<ChannelUnread> = Vec::new();
    // history 스코프 부족으로 못 읽은 채널이 있었는지(모두 실패했을 때만 사용자에게 알림).
    let mut missing_scope = false;
    // 이번에 실제로 확인한 자동 DM 과 그중 안 읽음이 있던 것 — `hot` 갱신용.
    // 오류로 건너뛴 대화는 어느 쪽에도 넣지 않는다(hot 에 있었다면 그대로 남는다).
    let mut scanned_dms: Vec<String> = Vec::new();
    let mut unread_dms: Vec<String> = Vec::new();

    let targets = selected
        .iter()
        .map(|id| (id.clone(), false))
        .chain(dms.iter().map(|id| (id.clone(), true)));

    for (id, auto) in targets {
        match scan_conversation(&token, &id, auto, &me, &mut cache, &mut gcache).await {
            Ok(found) => {
                if auto {
                    scanned_dms.push(id.clone());
                    if found.is_some() {
                        unread_dms.push(id.clone());
                    }
                }
                if let Some(c) = found {
                    result.push(c);
                }
            }
            Err(e) => {
                if e.contains("missing_scope") {
                    missing_scope = true;
                }
            }
        }
    }

    {
        let mut s = dm_scan().lock().unwrap();
        for id in &scanned_dms {
            s.hot.remove(id);
        }
        for id in &unread_dms {
            s.hot.insert(id.clone());
        }
    }

    // 읽은 채널이 하나도 없고 스코프 부족이 원인이면 사용자에게 알린다.
    if result.is_empty() && missing_scope {
        return Err("missing_scope".into());
    }
    Ok(result)
}

/// 대화 하나의 안 읽음을 조회한다.
///
/// `auto` = 사용자가 고른 게 아니라 DM 이라서 자동으로 포함된 대화. 두 가지가 달라진다:
/// **봇·앱 메시지를 세지 않고**(모듈 주석 참고), `unread_count_display` 가 0이면
/// 히스토리를 받지 않는다. 뒤쪽은 호출을 절반으로 줄이는 지름길인데, 그 값은 1:1 DM 에만
/// 실려 오고(그룹 DM 에는 없어 그대로 히스토리를 본다) **스레드 답글은 세지 않으므로**,
/// 채널 타임라인에 아무것도 없고 스레드 답글만 안 읽은 DM 은 놓친다. DM 에서 스레드는
/// 드물고, 그걸 잡자고 173개 대화의 히스토리를 매번 받는 것은 예산이 감당하지 못한다.
///
/// `Ok(None)` = 확인했고 안 읽음 없음. `Err` = 이 대화만 건너뜀(사유 문자열).
async fn scan_conversation(
    token: &str,
    id: &str,
    auto: bool,
    me: &str,
    cache: &mut HashMap<String, String>,
    gcache: &mut Option<HashMap<String, String>>,
) -> Result<Option<ChannelUnread>, String> {
    let info = api_get(token, "conversations.info", &[("channel", id.to_string())]).await?;
    let ch = info.get("channel").cloned().unwrap_or_default();
    let last_read_str = ch
        .get("last_read")
        .and_then(|x| x.as_str())
        .unwrap_or("0")
        .to_string();
    let last_read: f64 = last_read_str.parse().unwrap_or(0.0);

    // 자동 포함 DM 의 지름길: Slack 이 "안 읽음 0" 이라고 답하면 히스토리를 받지 않는다.
    if auto
        && ch
            .get("unread_count_display")
            .and_then(|x| x.as_u64())
            .is_some_and(|n| n == 0)
    {
        return Ok(None);
    }

    // 최근 히스토리(오래된 필터 없이): 최상위 미읽음 판정 + 스레드 부모 후보 파악.
    // (oldest=last_read 로 자르면 부모가 오래된 스레드의 새 답글을 놓치므로 최근 창 전체를 본다.)
    let hist = api_get(
        token,
        "conversations.history",
        &[
            ("channel", id.to_string()),
            ("limit", HISTORY_LIMIT.to_string()),
        ],
    )
    .await?;

    let api_has_more = hist.get("has_more").and_then(|x| x.as_bool()).unwrap_or(false);
    let empty: Vec<Value> = Vec::new();
    let raw = hist
        .get("messages")
        .and_then(|m| m.as_array())
        .unwrap_or(&empty);

    // 시스템/멤버십 이벤트만 제외(고른 채널에서는 봇 메시지·파일 공유 등을 포함한다)
    // + last_read 이후 + 내 메시지 아님. 자동 포함된 DM 에서만 봇·앱 메시지를 뺀다.
    let is_unread = |m: &Value| {
        let content = match m.get("subtype").and_then(|x| x.as_str()) {
            None => true,
            Some(s) => !is_system_subtype(s),
        };
        content
            && !(auto && is_bot_message(m))
            && ts_f(m) > last_read
            && m.get("user").and_then(|x| x.as_str()) != Some(me)
    };

    // (ts, uid, username 폴백, 원문, thread_ts) 를 소유값으로 모은다.
    let mut pending: Vec<(String, String, Option<String>, String, Option<String>)> = Vec::new();
    // 스레드 부모(루트) 원문: parent_ts → (uid, username 폴백, 원문). 화면에서 답글을 부모 아래로
    // 묶어 보여주기 위한 맥락이다. 부모는 안 읽음이 아닐 수 있으므로 pending 에는 넣지 않는다.
    let mut thread_parents_raw: HashMap<String, (String, Option<String>, String)> =
        HashMap::new();
    let extract = |m: &Value, thread_ts: Option<String>| {
        (
            m.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            m.get("user").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            m.get("username").and_then(|x| x.as_str()).map(String::from),
            message_text(m),
            thread_ts,
        )
    };

    // 최상위(채널) 미읽음.
    for m in raw.iter() {
        if is_unread(m) {
            pending.push(extract(m, None));
        }
    }
    // 최상위 미읽음이 히스토리 창을 넘어갈 수 있는지("+" 표시용).
    let oldest_fetched = raw.last().map(ts_f).unwrap_or(0.0);
    let mut has_more = api_has_more && oldest_fetched > last_read;

    // 스레드 미읽음: 답글이 있고 마지막 답글이 last_read 이후인 부모만 replies 조회.
    let mut thread_scans = 0usize;
    for m in raw.iter() {
        if thread_scans >= MAX_THREAD_SCANS {
            break;
        }
        let reply_count = m.get("reply_count").and_then(|x| x.as_u64()).unwrap_or(0);
        if reply_count == 0 {
            continue;
        }
        let latest_reply = m
            .get("latest_reply")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        // 스레드(댓글) 읽음 상태는 채널 읽음과 **별개**다. 채널을 다 읽어도 스레드 답글은
        // 안 읽음일 수 있으므로 채널 last_read 로는 판단할 수 없다.
        //
        // ⚠️ **구독하지 않은 스레드는 건너뛴다. 채널 last_read 로 폴백하면 안 된다.**
        // Slack 은 스레드 읽음 위치(last_read)를 **구독 중인 스레드에만** 실어 준다
        // (선택 채널 41개 스레드 전수 확인: `subscribed == true` ⟺ `last_read` 있음,
        //  예외 없음 — `conversations.replies` 의 부모도 똑같아서 거기서 다시 얻을 수 없다).
        // 미구독 스레드에서 채널 last_read 로 폴백하면 **그 답글은 영원히 안 읽음으로 남는다**:
        // 답글은 채널 타임라인에 없으므로 채널을 아무리 읽어도 채널 last_read 가 답글 ts 를
        // 넘지 못하고, 사용자가 Slack 에서 그 스레드를 열어 읽어도 읽음 위치가 기록되지 않아
        // 앱이 알 방법이 자체가 없다(실제로 그렇게 안 읽음이 안 사라졌다).
        // 건너뛰는 것이 Slack 본체와도 같은 규칙이다 — 구독하지 않은 스레드의 답글은 Slack 의
        // 안 읽음 배지에도 스레드 탭에도 잡히지 않는다. 나를 멘션한 답글은 Slack 이 자동으로
        // 구독시키므로 이 규칙으로도 놓치지 않는다.
        let Some(thread_read_str) = m
            .get("last_read")
            .and_then(|x| x.as_str())
            .map(String::from)
        else {
            continue;
        };
        let thread_read: f64 = thread_read_str.parse().unwrap_or(0.0);
        if latest_reply <= thread_read {
            continue;
        }
        let parent_ts = m.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if parent_ts.is_empty() {
            continue;
        }
        thread_scans += 1;

        let replies = match api_get(
            token,
            "conversations.replies",
            &[
                ("channel", id.to_string()),
                ("ts", parent_ts.clone()),
                ("oldest", thread_read_str.clone()),
                ("inclusive", "false".to_string()),
                ("limit", THREAD_REPLY_LIMIT.to_string()),
            ],
        )
        .await
        {
            Ok(v) => v,
            Err(_) => continue, // 그 스레드만 건너뛴다
        };
        let rempty: Vec<Value> = Vec::new();
        let rmsgs = replies
            .get("messages")
            .and_then(|x| x.as_array())
            .unwrap_or(&rempty);
        // conversations.replies 는 부모(스레드 루트)를 항상 첫 요소로 포함한다. 부모의
        // last_read 를 여기서 다시 읽지는 않는다 — 위 history 의 값과 **항상 같기 때문이다**
        // (전수 확인: 구독 스레드는 양쪽 다 같은 값, 미구독은 양쪽 다 없음). 부모를 찾는 건
        // 원문(작성자·본문)을 맥락용으로 쓰기 위해서다(안 읽음 여부와는 무관).
        let parent_msg = rmsgs
            .iter()
            .find(|r| r.get("ts").and_then(|x| x.as_str()) == Some(parent_ts.as_str()));
        if let Some(p) = parent_msg {
            thread_parents_raw.entry(parent_ts.clone()).or_insert_with(|| {
                (
                    p.get("user").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    p.get("username").and_then(|x| x.as_str()).map(String::from),
                    message_text(p),
                )
            });
        }
        for r in rmsgs.iter() {
            let rts = r.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_string();
            // 부모 자신 제외 + 이 스레드 기준 안 읽음(ts > thread_read) + 이미 수집된 건 제외.
            if rts.is_empty() || rts == parent_ts || ts_f(r) <= thread_read {
                continue;
            }
            // 시스템/멤버십 이벤트·내 답글 제외(is_unread 는 채널 기준이라 여기선 직접 검사).
            // 자동 포함 DM 의 봇 제외도 같은 이유로 여기서 한 번 더 본다.
            let content = match r.get("subtype").and_then(|x| x.as_str()) {
                None => true,
                Some(s) => !is_system_subtype(s),
            };
            if !content
                || (auto && is_bot_message(r))
                || r.get("user").and_then(|x| x.as_str()) == Some(me)
            {
                continue;
            }
            if pending.iter().any(|p| p.0 == rts) {
                continue;
            }
            pending.push(extract(r, Some(parent_ts.clone())));
        }
    }

    if pending.is_empty() {
        return Ok(None);
    }

    // 시간순 정렬(오래된 → 최신).
    pending.sort_by(|a, b| {
        a.0.parse::<f64>()
            .unwrap_or(0.0)
            .partial_cmp(&b.0.parse::<f64>().unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let unread = pending.len() as u32;
    // 미리보기 몇 개만(최신 쪽) 남긴다.
    if pending.len() > PREVIEW_LIMIT {
        has_more = true;
        pending.drain(0..(pending.len() - PREVIEW_LIMIT));
    }

    // 스레드 부모 표시값(작성자·본문) 캐시: parent_ts → (user, text). 한 번만 해석한다.
    let mut parent_display: HashMap<String, (String, String)> = HashMap::new();
    let mut messages: Vec<UnreadMessage> = Vec::new();
    for (ts, uid, uname, text_raw, thread_ts) in &pending {
        let text = format_message(token, text_raw, cache, gcache).await;
        let user = if uid.is_empty() {
            uname.clone().unwrap_or_else(|| "봇".to_string())
        } else {
            resolve_user(token, uid, cache).await
        };

        // 스레드 답글이면 부모(루트) 작성자·본문을 함께 실어 화면에서 댓글 구조로 묶는다.
        let (parent_user, parent_text) = if let Some(pts) = thread_ts {
            if !parent_display.contains_key(pts) {
                if let Some((puid, puname, praw)) = thread_parents_raw.get(pts).cloned() {
                    let pt = format_message(token, &praw, cache, gcache).await;
                    let pu = if puid.is_empty() {
                        puname.unwrap_or_else(|| "봇".to_string())
                    } else {
                        resolve_user(token, &puid, cache).await
                    };
                    parent_display.insert(pts.clone(), (pu, pt));
                }
            }
            match parent_display.get(pts) {
                Some((pu, pt)) => (Some(pu.clone()), Some(pt.clone())),
                None => (None, None),
            }
        } else {
            (None, None)
        };

        messages.push(UnreadMessage {
            user,
            text,
            ts: ts.clone(),
            thread_ts: thread_ts.clone(),
            parent_user,
            parent_text,
        });
    }

    let name = convo_name(token, &ch, cache).await;
    Ok(Some(ChannelUnread {
        id: id.to_string(),
        name,
        kind: kind_of(&ch).to_string(),
        unread,
        has_more,
        messages,
    }))
}

/// Slack 데스크톱 앱을 해당 채널(가능하면 특정 메시지)로 연다.
/// `slack://channel?team=...&id=...&message=<ts>` 딥링크를 시스템 핸들러(=Slack 앱)로 넘긴다.
/// team_id 는 auth.test 로 얻는다(딥링크가 정확한 워크스페이스로 열리게 함).
#[tauri::command]
pub async fn slack_open_message(
    app: tauri::AppHandle,
    channel: String,
    ts: String,
    thread_ts: Option<String>,
) -> Result<(), String> {
    let token = read_token(&app).ok_or("no_token")?;
    let team = api_get(&token, "auth.test", &[])
        .await
        .ok()
        .and_then(|v| v.get("team_id").and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();

    let mut url = String::from("slack://channel?");
    if !team.is_empty() {
        url.push_str(&format!("team={team}&"));
    }
    url.push_str(&format!("id={channel}"));
    if !ts.is_empty() {
        url.push_str(&format!("&message={ts}"));
    }
    // 스레드 답글이면 thread_ts 를 붙여 해당 스레드가 열리게 한다.
    if let Some(t) = thread_ts.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&thread_ts={t}"));
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
