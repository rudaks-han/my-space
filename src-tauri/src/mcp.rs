//! IntelliJ IDEA 내장 MCP 서버와 통신하는 최소 클라이언트.
//!
//! IntelliJ 2025.2+ 는 IDE 안에 MCP 서버를 내장한다(Settings → Tools → MCP Server).
//! 전송 방식은 **SSE 전용**이다: `GET /sse` 로 스트림을 열면 서버가 먼저
//! `event: endpoint` 로 POST 대상 경로(`/message?sessionId=…`)를 알려준다.
//! 이후 JSON-RPC 요청은 그 경로로 POST 하고, **응답은 POST 의 본문이 아니라
//! 열어둔 SSE 스트림으로** 되돌아온다. 그래서 요청 id 별로 대기 채널을 두고
//! 리더 태스크가 응답을 짝지어 준다.
//!
//! 포트는 IDE 가 정하고 **재시작마다 달라질 수 있다**(실측: 64342 → 64442). 그래서
//! 흔한 후보를 먼저 보고, 실패하면 IDE 프로세스가 열어 둔 포트를 직접 훑는다.
//!
//! IDE 설정에서 MCP 서버가 꺼져 있으면 서버가 **restricted 모드**로 응답한다(HTTP 401,
//! "provide valid authorization token"). 이때는 토큰 없이 쓸 수 없으므로, 사용자에게
//! "Enable MCP Server 를 켜라" 고 정확히 안내한다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

/// 빠른 경로로 먼저 훑는 포트 후보. IDE 가 내장 웹서버 포트(기본 63342) 기준으로
/// 오프셋을 더해 쓰는데, 그 오프셋이 버전·상태에 따라 달라진다(실측: 64342 → 64442).
/// 그래서 이 목록으로 못 찾으면 IDE 프로세스가 열어 둔 포트를 직접 훑는다.
const PORTS: [u16; 4] = [64342, 64442, 64343, 64443];
/// SSE 로 endpoint 이벤트가 올 때까지 기다리는 시간.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// 일반 JSON-RPC 요청 응답 대기 시간. IDE 가 인덱싱 중이면 느릴 수 있어 넉넉히 둔다.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

/// 포트 하나를 시도한 결과. 안내 문구를 다르게 주기 위해 사유를 구분한다.
enum ProbeError {
    /// 그 포트에 MCP 서버가 없다(연결 거부·다른 서비스·핸드셰이크 실패).
    NotThere(String),
    /// MCP 서버는 응답하지만 **restricted 모드**다. IDE 설정에서 MCP 서버가 꺼져 있으면
    /// 이 상태가 되고, 토큰 없이는 쓸 수 없다.
    Restricted,
}

/// 실행 중인 JetBrains IDE 프로세스가 LISTEN 중인 포트들.
///
/// MCP 서버 포트는 IDE 가 정하고 재시작마다 바뀔 수 있어 고정 범위 추측이 통하지 않는다.
/// IDE 프로세스에서 직접 읽어 후보로 쓴다(오름차순, 중복 제거).
fn ide_listen_ports() -> Vec<u16> {
    let out = match std::process::Command::new("lsof")
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fcn"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    let mut ports = Vec::new();
    let mut is_ide = false;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        match line.split_at(line.char_indices().nth(1).map_or(0, |(i, _)| i)) {
            // c<command>: 이후 n 줄들의 소유 프로세스가 바뀐다.
            ("c", cmd) => is_ide = cmd.starts_with("idea") || cmd.contains("IntelliJ"),
            // n<addr>: 주소의 마지막 ':' 뒤가 포트.
            ("n", addr) if is_ide => {
                if let Some(port) = addr.rsplit_once(':').and_then(|(_, p)| p.parse::<u16>().ok())
                {
                    ports.push(port);
                }
            }
            _ => {}
        }
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// 살아 있는 MCP 세션 하나.
pub struct Conn {
    http: reqwest::Client,
    /// JSON-RPC 를 POST 할 절대 URL.
    post_url: String,
    /// 연결한 서버 주소(`http://127.0.0.1:64342`). 상태 표시용.
    pub base: String,
    pending: Pending,
    next_id: AtomicU64,
    /// SSE 스트림이 끊기면 false 가 된다(다음 호출에서 재연결).
    alive: Arc<AtomicBool>,
}

impl Conn {
    /// JSON-RPC 요청을 보내고 SSE 로 돌아오는 응답을 기다린다.
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err("MCP 연결이 끊어졌습니다".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.http.post(&self.post_url).json(&body).send().await {
            self.pending.lock().unwrap().remove(&id);
            return Err(format!("MCP 요청 실패: {e}"));
        }

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(res)) => res,
            // 리더가 채널을 떨어뜨렸다 = 스트림이 끊겼다.
            Ok(Err(_)) => Err("MCP 연결이 끊어졌습니다".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("MCP 응답 시간 초과({}초): {method}", CALL_TIMEOUT.as_secs()))
            }
        }
    }

    /// 응답을 기다리지 않는 알림(notification).
    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.http
            .post(&self.post_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("MCP 알림 실패: {e}"))?;
        Ok(())
    }

    /// 도구를 호출한다. MCP 는 결과를 `content:[{type:"text",text:"…"}]` 로 감싸 주는데,
    /// IntelliJ 도구들은 그 text 안에 JSON 을 담으므로 한 번 더 파싱해서 돌려준다.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        let res = self
            .request("tools/call", json!({ "name": name, "arguments": args }))
            .await?;

        let text = res
            .get("content")
            .and_then(|c| c.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| i.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();

        // isError 면 그 text 가 사람이 읽을 오류 메시지다.
        if res.get("isError").and_then(|v| v.as_bool()) == Some(true) {
            return Err(if text.is_empty() {
                format!("{name} 호출이 실패했습니다")
            } else {
                text
            });
        }

        Ok(serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text)))
    }
}

/// SSE 한 줄을 처리한다. endpoint 이벤트면 경로를, 응답이면 대기 채널로 넘긴다.
fn handle_sse_line(
    line: &str,
    event: &mut String,
    pending: &Pending,
    endpoint_tx: &mut Option<oneshot::Sender<String>>,
) {
    if let Some(rest) = line.strip_prefix("event:") {
        *event = rest.trim().to_string();
        return;
    }
    let Some(rest) = line.strip_prefix("data:") else {
        // 빈 줄 = 이벤트 경계.
        if line.is_empty() {
            event.clear();
        }
        return;
    };
    let data = rest.trim();

    // 첫 이벤트는 POST 대상 경로다(event 이름이 없는 서버도 있어 모양으로도 판별).
    if event == "endpoint" || (endpoint_tx.is_some() && data.starts_with('/')) {
        if let Some(tx) = endpoint_tx.take() {
            let _ = tx.send(data.to_string());
        }
        return;
    }

    let Ok(msg) = serde_json::from_str::<Value>(data) else {
        return;
    };
    let Some(id) = msg.get("id").and_then(|v| v.as_u64()) else {
        return; // 서버 쪽 알림 — 지금은 쓰지 않는다.
    };
    let Some(tx) = pending.lock().unwrap().remove(&id) else {
        return;
    };
    let out = if let Some(err) = msg.get("error") {
        let m = err
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("알 수 없는 오류");
        Err(format!("MCP 오류: {m}"))
    } else {
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = tx.send(out);
}

/// 주어진 주소에 연결해 initialize 까지 마친 세션을 만든다.
async fn connect_at(base: &str) -> Result<Arc<Conn>, ProbeError> {
    let http = reqwest::Client::builder()
        // SSE 스트림은 계속 열려 있어야 하므로 전체 타임아웃을 걸지 않는다.
        .connect_timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| ProbeError::NotThere(e.to_string()))?;

    let mut resp = http
        .get(format!("{base}/sse"))
        .header("Accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| ProbeError::NotThere(format!("{base} 연결 실패: {e}")))?;
    // 401 = MCP 서버는 있지만 restricted 모드(IDE 에서 꺼져 있음).
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(ProbeError::Restricted);
    }
    if !resp.status().is_success() {
        return Err(ProbeError::NotThere(format!(
            "{base} 응답 코드 {}",
            resp.status()
        )));
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let (etx, erx) = oneshot::channel::<String>();

    // 리더 태스크: 스트림이 끊길 때까지 SSE 를 읽어 응답을 라우팅한다.
    {
        let pending = pending.clone();
        let alive = alive.clone();
        tauri::async_runtime::spawn(async move {
            let mut endpoint_tx = Some(etx);
            let mut event = String::new();
            let mut buf = String::new();
            loop {
                match resp.chunk().await {
                    Ok(Some(bytes)) => {
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // 마지막 조각은 줄이 덜 왔을 수 있으니 남겨 둔다.
                        while let Some(pos) = buf.find('\n') {
                            let line: String = buf.drain(..=pos).collect();
                            handle_sse_line(
                                line.trim_end_matches(['\r', '\n']),
                                &mut event,
                                &pending,
                                &mut endpoint_tx,
                            );
                        }
                    }
                    // 스트림 종료/오류 → 세션 폐기. 대기 중인 요청은 채널 drop 으로 깨운다.
                    _ => break,
                }
            }
            alive.store(false, Ordering::Relaxed);
            pending.lock().unwrap().clear();
        });
    }

    let post_path = tokio::time::timeout(HANDSHAKE_TIMEOUT, erx)
        .await
        .map_err(|_| {
            ProbeError::NotThere(format!("{base} 에서 MCP endpoint 이벤트를 받지 못했습니다"))
        })?
        .map_err(|_| ProbeError::NotThere(format!("{base} MCP 스트림이 즉시 끊겼습니다")))?;

    let conn = Arc::new(Conn {
        http,
        post_url: format!("{base}{post_path}"),
        base: base.to_string(),
        pending,
        next_id: AtomicU64::new(1),
        alive,
    });

    conn.request(
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "my-space", "version": env!("CARGO_PKG_VERSION") }
        }),
    )
    .await
    .map_err(ProbeError::NotThere)?;
    conn.notify("notifications/initialized", json!({}))
        .await
        .map_err(ProbeError::NotThere)?;

    Ok(conn)
}

/// 프로세스 전역 세션. 끊어지면 다음 호출에서 다시 연결한다.
static CONN: OnceLock<tokio::sync::Mutex<Option<Arc<Conn>>>> = OnceLock::new();

/// 살아 있는 세션을 돌려준다. 없거나 끊겼으면 포트 후보를 훑어 새로 연결한다.
pub async fn conn() -> Result<Arc<Conn>, String> {
    let cell = CONN.get_or_init(|| tokio::sync::Mutex::new(None));
    let mut guard = cell.lock().await;

    if let Some(c) = guard.as_ref() {
        if c.alive.load(Ordering::Relaxed) {
            return Ok(c.clone());
        }
    }

    // 환경변수로 주소를 강제할 수 있게 해 둔다(포트를 바꿔 쓰는 경우).
    let candidates: Vec<String> = match std::env::var("MYSPACE_INTELLIJ_MCP_URL") {
        Ok(u) if !u.trim().is_empty() => vec![u.trim().trim_end_matches('/').to_string()],
        _ => {
            // 흔한 후보 → IDE 프로세스가 실제로 열어 둔 포트(중복 제거).
            let mut ports: Vec<u16> = PORTS.to_vec();
            for p in ide_listen_ports() {
                if !ports.contains(&p) {
                    ports.push(p);
                }
            }
            ports
                .iter()
                .map(|p| format!("http://127.0.0.1:{p}"))
                .collect()
        }
    };

    let mut errors = Vec::new();
    let mut restricted = false;

    for base in &candidates {
        match connect_at(base).await {
            Ok(c) => {
                *guard = Some(c.clone());
                return Ok(c);
            }
            // restricted 는 "서버를 찾았다" 는 뜻이므로 가장 정확한 안내다. 계속 훑지 않는다.
            Err(ProbeError::Restricted) => {
                restricted = true;
                break;
            }
            Err(ProbeError::NotThere(e)) => errors.push(e),
        }
    }

    *guard = None;
    if restricted {
        return Err("IntelliJ MCP 서버가 restricted 모드입니다(인증 토큰 필요). \
             IntelliJ 의 Settings → Tools → MCP Server 에서 \
             'Enable MCP Server' 를 켠 뒤 다시 확인하세요."
            .to_string());
    }
    Err(format!(
        "IntelliJ MCP 서버를 찾을 수 없습니다. IntelliJ 가 실행 중이고 \
         Settings → Tools → MCP Server 에서 서버가 켜져 있는지 확인하세요. ({})",
        errors.join(" / ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// IDE 프로세스가 열어 둔 포트를 찾아내야 한다.
    /// MCP 포트는 재시작마다 바뀔 수 있어(실측 64342 → 64442) 이 탐색이 유일하게 믿을 만하다.
    #[test]
    #[ignore = "실행 중인 IntelliJ 가 필요하다"]
    fn discovers_ide_ports() {
        let ports = ide_listen_ports();
        println!("IDE LISTEN 포트: {ports:?}");
        assert!(!ports.is_empty(), "IDE 포트를 하나도 못 찾았다");
        // 내장 웹서버(기본 63342)는 늘 열려 있다 — 탐색이 제대로 됐다는 신호.
        assert!(
            ports.iter().any(|p| *p >= 63000),
            "내장 웹서버 대역 포트가 없다: {ports:?}"
        );
    }

    /// 연결 실패 시 사유에 맞는 안내가 나와야 한다.
    /// restricted 모드(= IDE 에서 MCP 서버가 꺼짐)와 "서버 없음" 은 조치가 다르다.
    #[test]
    #[ignore = "실행 중인 IntelliJ 가 필요하다"]
    fn reports_actionable_error_when_unavailable() {
        let msg = tauri::async_runtime::block_on(conn()).err();
        match msg {
            None => println!("연결됨 — 이 테스트는 연결이 안 될 때를 확인한다"),
            Some(e) => {
                println!("안내 문구: {e}");
                assert!(
                    e.contains("Enable MCP Server") || e.contains("찾을 수 없습니다"),
                    "조치를 알려주지 않는 문구다: {e}"
                );
            }
        }
    }

    /// 실제 IntelliJ 와 통신해 SSE 핸드셰이크·JSON-RPC 왕복·도구 호출을 확인한다.
    /// IDE 가 떠 있어야 하므로 기본 실행에서는 제외한다:
    ///   cargo test --lib mcp -- --ignored --nocapture
    #[test]
    #[ignore = "실행 중인 IntelliJ 가 필요하다"]
    fn talks_to_intellij() {
        tauri::async_runtime::block_on(async {
            let c = conn().await.expect("연결 실패");
            println!("connected: {}", c.base);

            let tools = c.request("tools/list", json!({})).await.expect("tools/list 실패");
            let names: Vec<&str> = tools["tools"]
                .as_array()
                .expect("tools 배열")
                .iter()
                .filter_map(|t| t["name"].as_str())
                .collect();
            println!("tools: {}", names.len());
            assert!(names.contains(&"execute_run_configuration"));

            // 도구 호출 + text 안의 JSON 파싱까지 확인.
            let res = c
                .call_tool(
                    "get_run_configurations",
                    json!({ "projectPath": "/Users/rudaks/_WORK/_ENOMIX_GIT/spectrakr/cowork" }),
                )
                .await
                .expect("get_run_configurations 실패");
            let configs = res["configurations"].as_array().expect("configurations 배열");
            println!("configurations: {}", configs.len());
            assert!(configs
                .iter()
                .any(|c| c["name"].as_str() == Some("RegistryApplication")));
        });
    }
}
