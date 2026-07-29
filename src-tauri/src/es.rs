//! Elasticsearch 뷰어 — 임의의 ES 클러스터에 REST 요청을 대신 보내 주는 얇은 프록시.
//!
//! 브라우저(웹뷰)에서 임의 호스트로 직접 fetch 하면 CORS 에 막히므로(크롬 확장은
//! host_permissions 로 우회했지만 여기선 불가), 연결 정보와 함께 method/path/body 를
//! 받아 Rust(reqwest)가 요청을 보내고 응답(JSON)을 그대로 되돌려 준다.
//!
//! 프론트엔드의 `es-client.ts` 가 이 명령 하나만 호출해 info/indices/mapping/search/
//! delete 등 모든 ES 동작을 구성한다. 상태코드와 원문 응답을 함께 넘겨, ES 의 에러
//! 사유(root_cause 등)를 프론트에서 그대로 해석할 수 있게 한다.
//!
//! 사내 ES 는 자체 서명 인증서(https)를 쓰는 경우가 많아 인증서 검증은 끈다
//! (내부 도구 목적).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 연결 정보. 프론트엔드(localStorage)에서 요청마다 그대로 넘겨준다.
#[derive(Deserialize)]
pub struct EsConfig {
    pub host: String,
    /// 비어 있으면(None) 포트 없이 접속.
    pub port: Option<u16>,
    #[serde(default)]
    pub https: bool,
    pub username: Option<String>,
    pub password: Option<String>,
}

/// ES 응답 봉투. HTTP 상태와 파싱된 JSON 본문을 함께 담아, 프론트가 성공/실패를
/// 판단하고 에러 사유를 뽑아낼 수 있게 한다.
#[derive(Serialize)]
pub struct EsResponse {
    /// 2xx 여부.
    pub ok: bool,
    /// HTTP 상태코드.
    pub status: u16,
    /// 파싱된 JSON 본문. JSON 이 아니면 문자열을 그대로 담고, 본문이 없으면 null.
    pub body: Value,
}

impl EsConfig {
    /// `{proto}://{host}[:{port}]` 형태의 베이스 URL.
    fn base_url(&self) -> String {
        let proto = if self.https { "https" } else { "http" };
        let host = self.host.trim();
        match self.port {
            Some(p) => format!("{proto}://{host}:{p}"),
            None => format!("{proto}://{host}"),
        }
    }
}

/// 임의의 ES REST 요청을 대신 보낸다.
///
/// - `method`: "GET" | "POST" | "PUT" | "DELETE" …
/// - `path`: "/_cat/indices?format=json" 처럼 앞에 슬래시로 시작하는 경로+쿼리스트링.
/// - `body`: JSON 본문(있으면 Content-Type: application/json 으로 전송).
#[tauri::command]
pub async fn es_request(
    config: EsConfig,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<EsResponse, String> {
    if config.host.trim().is_empty() {
        return Err("호스트를 입력하세요.".into());
    }

    let url = format!("{}{}", config.base_url(), path);
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("지원하지 않는 메서드: {method}"))?;

    let client = reqwest::Client::builder()
        // 사내 ES 자체 서명 인증서 허용(내부 도구).
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.request(method, &url);

    // Basic 인증(아이디가 있으면).
    if let Some(user) = config.username.as_ref().filter(|u| !u.trim().is_empty()) {
        req = req.basic_auth(user.trim(), config.password.as_deref());
    }
    req = req.header(reqwest::header::ACCEPT, "application/json");
    if let Some(b) = &body {
        req = req.json(b);
    }

    let resp = req.send().await.map_err(|e| {
        // 네트워크 계층 실패(연결 거부·타임아웃·DNS 등)는 상태코드가 없다.
        format!(
            "네트워크 오류: {} 에 연결할 수 없습니다.\n호스트/포트/HTTPS 설정을 확인하세요.\n({e})",
            config.base_url()
        )
    })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    // 본문을 JSON 으로 파싱하되, 실패하면 원문 문자열을 그대로 담는다.
    let parsed: Value = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };

    Ok(EsResponse {
        ok: status.is_success(),
        status: status.as_u16(),
        body: parsed,
    })
}
