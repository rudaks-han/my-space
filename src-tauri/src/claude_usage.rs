//! Claude Code 사용량(5시간 세션·주간 rate-limit) 조회.
//!
//! `~/.claude/ratelimit-collect.js` 가 쓰는 것과 같은 권위 엔드포인트
//! `GET https://api.anthropic.com/api/oauth/usage` 를 호출한다. 인증은 Claude Code 의
//! OAuth accessToken 으로 하며, macOS 는 Keychain 서비스 `Claude Code-credentials`,
//! 그 외 플랫폼/실패 시 `~/.claude/.credentials.json` 에서 읽는다.
//! 응답은 `{ five_hour, seven_day, seven_day_sonnet }` 이고 각 창은 `{ utilization, resets_at }`.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// ratelimit-collect.js 와 동일한 OAuth 베타 헤더.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// 매 호출마다 Client 를 새로 만들지 않도록 커넥션 풀을 재사용한다(slack.rs 와 같은 패턴).
fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// 사용량 창 하나. `utilization` 은 0~100(%) 사용률, `resets_at` 은 초기화 UTC 시각.
#[derive(Serialize, Clone, Default)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: Option<String>,
}

/// `/usage` 응답 전체(세 창 모두 없을 수도 있다).
#[derive(Serialize, Default)]
pub struct ClaudeUsage {
    /// 5시간 세션 사용률.
    pub five_hour: Option<UsageWindow>,
    /// 주간(7일) 사용률 — 상태바의 "week".
    pub seven_day: Option<UsageWindow>,
    /// 주간 Sonnet 전용 사용률.
    pub seven_day_sonnet: Option<UsageWindow>,
}

/// Keychain(macOS) → 파일 순으로 `claudeAiOauth.accessToken` 을 읽는다.
fn read_access_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(t) = token_from_keychain() {
            return Some(t);
        }
    }
    token_from_file()
}

/// macOS Keychain 의 `Claude Code-credentials` 항목(JSON)에서 토큰을 꺼낸다.
#[cfg(target_os = "macos")]
fn token_from_keychain() -> Option<String> {
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    parse_token(raw.trim())
}

/// `~/.claude/.credentials.json` 에서 토큰을 꺼낸다(Keychain 실패 시 대비).
fn token_from_file() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home)
        .join(".claude")
        .join(".credentials.json");
    let raw = std::fs::read_to_string(path).ok()?;
    parse_token(&raw)
}

fn parse_token(raw: &str) -> Option<String> {
    let v: Value = serde_json::from_str(raw).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(String::from)
}

/// 응답의 창 하나를 파싱한다. utilization 이 숫자가 아니면 None(그 창은 없는 것으로 취급).
fn window_from(v: &Value) -> Option<UsageWindow> {
    let utilization = v.get("utilization")?.as_f64()?;
    let resets_at = v
        .get("resets_at")
        .and_then(|x| x.as_str())
        .map(String::from);
    Some(UsageWindow {
        utilization,
        resets_at,
    })
}

/// Claude Code 사용량을 조회한다. 자격증명이 없으면 `Err("no_credentials")`.
#[tauri::command]
pub async fn claude_usage() -> Result<ClaudeUsage, String> {
    let token = read_access_token().ok_or("no_credentials")?;
    let resp = http()
        .get(USAGE_URL)
        .bearer_auth(&token)
        .header("anthropic-beta", OAUTH_BETA)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, "my-space-usage/1.0")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("bad json: {e}"))?;
    Ok(ClaudeUsage {
        five_hour: v.get("five_hour").and_then(window_from),
        seven_day: v.get("seven_day").and_then(window_from),
        seven_day_sonnet: v.get("seven_day_sonnet").and_then(window_from),
    })
}
