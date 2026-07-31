//! 화면 공유 — 내 화면을 URL 하나로 남에게 보여 준다.
//!
//! **왜 앱이 화면을 직접 캡처하지 않는가.** WKWebView 는 `getDisplayMedia()` 를 지원하지
//! 않는다(Apple 이 임베드 웹뷰에는 `getUserMedia` 만 허용). 그래서 앱 화면 안에서 웹 표준
//! 화면공유를 띄우는 길은 막혀 있고, 남은 선택은 (a) Rust 가 ScreenCaptureKit 으로 캡처해
//! H.264/VP8 로 인코딩하고 RTP 까지 직접 싸거나, (b) 캡처·인코딩을 시스템 브라우저에 맡기고
//! 앱은 **서버 역할만** 하는 것이다. 여기는 (b) 다 — 비디오 코덱 의존이 하나도 없고,
//! 화질·지연은 크롬의 하드웨어 인코더 그대로다.
//!
//! ```text
//! [내 PC]  My Space
//!   ├ http://127.0.0.1:P1/s/<sender_token>  ← 크롬이 여는 송신 페이지. 로컬 전용이라
//!   │                                          상대방에게 주는 주소가 아니다.
//!   ├ /ws                                    ← SDP·ICE 중계 + 릴레이 프레임 (이 파일의 Hub)
//!   ├ https://<LAN IP>:P2/v/<token>          ← 같은 망에 있을 때의 시청 주소(망마다 하나)
//!   └ https://<터널>/v/<token>                ← 어느 망에서나 열리는 시청 주소
//! ```
//!
//! **상대방에게 주는 주소에는 절대 loopback 이 들어가지 않는다.** 받은 사람이 열면
//! 자기 PC 를 보게 되기 때문이다(`viewer_urls_never_point_at_loopback` 이 이걸 고정한다).
//! `127.0.0.1` 이 쓰이는 곳은 셋뿐이다: 송신 페이지 주소, 터널의 오리진, 인증서 SAN.
//! 거꾸로 송신 경로는 **반드시** localhost 여야 하고 그 사실이 강제된다 — `is_local_host`
//! 가 `/s/<token>` 과 `role=sender` 소켓을 Host 헤더로 걸러서, 터널 URL 로는 송신자가
//! 될 수 없게 한다(막지 않으면 sender_token 이 새는 순간 화면을 바꿔치기할 수 있다).
//!
//! **리스너가 두 개인 이유는 secure context 때문이다.** `RTCPeerConnection` 과
//! `getDisplayMedia` 는 보안 컨텍스트에서만 존재한다. 송신 쪽은 `http://127.0.0.1` 이
//! 예외로 인정돼서 평문 HTTP 로 열면 인증서 경고 없이 동작한다. 반면 시청자가 여는
//! `http://<LAN IP>` 는 예외가 아니라 **WebRTC 가 아예 없다** — 그래서 LAN 용으로는
//! 자체 서명 인증서로 HTTPS 리스너를 따로 띄운다(상대방은 첫 접속 때 경고를 한 번 넘긴다).
//! 터널을 쓰면 제공자가 정식 인증서로 종단해 주므로 경고가 없다.
//! HTTP 리스너를 127.0.0.1 에만 묶는 것도 이 때문이다 — 경고 없는 평문 주소는 이 PC 안에서만
//! 유효해야 하고, 터널의 오리진으로도 그대로 쓴다.
//!
//! **영상 경로는 두 단계다.** 먼저 P2P(WebRTC)를 시도하고, TURN 서버가 없어 NAT 를 넘지
//! 못하면 시청 페이지가 **릴레이로 물러난다** — 송신 탭이 캔버스로 뜬 JPEG 프레임을 이
//! 서버를 거쳐 받는다(저화질). 덕분에 "URL 은 열리는데 검은 화면"이 없다.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Emitter, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

/// 송신 페이지(크롬이 연다). 토큰은 URL 경로에서 읽으므로 치환 없이 그대로 서빙한다.
const SENDER_HTML: &str = include_str!("screenshare/sender.html");
/// 시청 페이지(상대방이 연다).
const VIEWER_HTML: &str = include_str!("screenshare/viewer.html");

/// 우선 시도하는 포트. 이미 쓰이면 임의 포트로 물러난다 — 주소가 예측 가능하면
/// 사용자가 URL 을 눈으로 확인하기 쉽지만, 충돌로 공유가 아예 안 되는 편이 더 나쁘다.
const PREFERRED_HTTP_PORT: u16 = 7777;
const PREFERRED_HTTPS_PORT: u16 = 7778;

/// cloudflared 후보 경로. GUI 로 실행된 앱은 PATH 가 최소(`/usr/bin:/bin:…`)라
/// Homebrew 경로가 없으므로 직접 짚어 준다.
const CLOUDFLARED_CANDIDATES: &[&str] = &[
    "/opt/homebrew/bin/cloudflared",
    "/usr/local/bin/cloudflared",
    "cloudflared",
];

/// 소켓 태스크로 보낼 것. 릴레이 폴백이 JPEG 프레임을 실어 보내므로
/// 텍스트 채널만으로는 부족하다.
#[derive(Debug, PartialEq)]
enum Out {
    Text(String),
    Bin(Vec<u8>),
}

/// 시그널링 채널 한쪽 끝.
type Tx = UnboundedSender<Out>;

/// 송신자 1명 ↔ 시청자 N명 사이를 중계하는 허브.
///
/// 기본 경로에서는 offer/answer/candidate JSON 만 지나간다(영상은 P2P). 다만 NAT 를
/// 넘지 못한 시청자는 **릴레이로 물러나며**, 그때는 JPEG 프레임도 여기를 지나간다 —
/// 터널이 열려 있는 곳이면 무조건 보이게 하려면 서버를 거치는 경로가 하나 있어야 한다.
#[derive(Default)]
struct Hub {
    inner: Mutex<HubInner>,
}

#[derive(Default)]
struct HubInner {
    /// 현재 송신 소켓. id 를 함께 들고 있는 이유는 **교체 경합** 때문이다 —
    /// 새 송신 탭이 붙어 교체된 뒤 옛 탭의 소켓이 닫히면서 detach 를 시도하는데,
    /// id 를 비교하지 않으면 방금 붙은 새 송신자를 지워 버린다.
    sender: Option<(u64, Tx)>,
    viewers: Vec<(u64, Tx)>,
    /// 릴레이로 보고 있는 시청자. 프레임은 이 집합에만 브로드캐스트한다 —
    /// P2P 로 잘 보고 있는 시청자에게 보내면 대역폭만 두 배로 쓴다.
    relay: Vec<u64>,
    next_id: u64,
}

impl Hub {
    fn next_id(inner: &mut HubInner) -> u64 {
        inner.next_id += 1;
        inner.next_id
    }

    /// 송신자를 등록한다. 이미 있던 송신자(교체 대상)와 지금 대기 중인 시청자 목록을 돌려준다.
    fn attach_sender(&self, tx: Tx) -> (u64, Option<Tx>, Vec<u64>) {
        let mut inner = self.inner.lock().unwrap();
        let id = Self::next_id(&mut inner);
        let prev = inner.sender.take().map(|(_, tx)| tx);
        inner.sender = Some((id, tx));
        let viewers = inner.viewers.iter().map(|(id, _)| *id).collect();
        (id, prev, viewers)
    }

    /// 송신자를 해제한다. 그 사이 다른 탭으로 교체됐으면 아무것도 하지 않고 false.
    fn detach_sender(&self, id: u64) -> bool {
        let mut inner = self.inner.lock().unwrap();
        match inner.sender {
            Some((cur, _)) if cur == id => {
                inner.sender = None;
                true
            }
            _ => false,
        }
    }

    /// 시청자를 등록한다. 지금 송신자가 붙어 있는지도 함께 돌려준다.
    fn add_viewer(&self, tx: Tx) -> (u64, bool) {
        let mut inner = self.inner.lock().unwrap();
        let id = Self::next_id(&mut inner);
        inner.viewers.push((id, tx));
        let has_sender = inner.sender.is_some();
        (id, has_sender)
    }

    fn remove_viewer(&self, id: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.viewers.retain(|(vid, _)| *vid != id);
        inner.relay.retain(|vid| *vid != id);
    }

    /// 이 시청자를 릴레이 모드로 올리거나 내린다. 돌려주는 값은 **릴레이 시청자 수** —
    /// 0 → 1 이 되는 순간 송신 탭이 프레임 캡처를 시작해야 하고, 1 → 0 이면 멈춰야 한다.
    fn set_relay(&self, id: u64, on: bool) -> usize {
        let mut inner = self.inner.lock().unwrap();
        if on {
            if !inner.relay.contains(&id) {
                inner.relay.push(id);
            }
        } else {
            inner.relay.retain(|vid| *vid != id);
        }
        inner.relay.len()
    }

    fn to_sender(&self, msg: String) {
        let inner = self.inner.lock().unwrap();
        if let Some((_, tx)) = inner.sender.as_ref() {
            let _ = tx.send(Out::Text(msg));
        }
    }

    fn to_viewer(&self, id: u64, msg: String) {
        let inner = self.inner.lock().unwrap();
        if let Some((_, tx)) = inner.viewers.iter().find(|(vid, _)| *vid == id) {
            let _ = tx.send(Out::Text(msg));
        }
    }

    fn broadcast_viewers(&self, msg: String) {
        let inner = self.inner.lock().unwrap();
        for (_, tx) in inner.viewers.iter() {
            let _ = tx.send(Out::Text(msg.clone()));
        }
    }

    /// JPEG 프레임 한 장을 릴레이 시청자들에게 뿌린다.
    fn broadcast_frame(&self, frame: Vec<u8>) {
        let inner = self.inner.lock().unwrap();
        let targets: Vec<&Tx> = inner
            .viewers
            .iter()
            .filter(|(id, _)| inner.relay.contains(id))
            .map(|(_, tx)| tx)
            .collect();
        // 마지막 수신자에게는 복제 없이 그대로 넘긴다(1:1 릴레이가 가장 흔한 경우).
        for (i, tx) in targets.iter().enumerate() {
            if i + 1 == targets.len() {
                let _ = tx.send(Out::Bin(frame));
                return;
            }
            let _ = tx.send(Out::Bin(frame.clone()));
        }
    }

    fn relay_count(&self) -> usize {
        self.inner.lock().unwrap().relay.len()
    }

    fn counts(&self) -> (bool, usize) {
        let inner = self.inner.lock().unwrap();
        (inner.sender.is_some(), inner.viewers.len())
    }
}

/// 터널(cloudflared)의 현재 상태. stderr 파서 스레드가 갱신한다.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TunnelInfo {
    /// "off" | "starting" | "ready" | "failed"
    state: String,
    url: Option<String>,
    error: Option<String>,
}

impl TunnelInfo {
    fn off() -> Self {
        Self {
            state: "off".into(),
            url: None,
            error: None,
        }
    }
    fn starting() -> Self {
        Self {
            state: "starting".into(),
            url: None,
            error: None,
        }
    }
}

struct Tunnel {
    /// cloudflared 프로세스. 시작에 **실패했을 때는 `None`** 이다 — 상태만 "failed" 로
    /// 보여 주면 되므로 자리를 메우려고 더미 프로세스를 띄우지 않는다.
    child: Option<Child>,
    info: Arc<Mutex<TunnelInfo>>,
}

/// 실행 중인 공유 세션 하나. 두 리스너와(있으면) 터널 프로세스를 소유한다.
struct Session {
    hub: Arc<Hub>,
    /// 시청 URL 토큰.
    token: String,
    /// 송신 페이지 토큰. 시청 토큰과 **따로** 두어, 시청 URL 을 받은 사람이
    /// 송신자로 붙어 화면을 바꿔치기하는 것을 막는다.
    sender_token: String,
    http_port: u16,
    https_port: u16,
    /// 시청자가 붙을 수 있는 이 PC 의 주소 전부(망이 여럿일 수 있다). loopback 은 없다.
    lan_ips: Vec<String>,
    http_handle: axum_server::Handle,
    https_handle: axum_server::Handle,
    tunnel: Option<Tunnel>,
}

impl Session {
    fn sender_url(&self) -> String {
        format!("http://127.0.0.1:{}/s/{}", self.http_port, self.sender_token)
    }

    fn lan_urls(&self) -> Vec<String> {
        self.lan_ips
            .iter()
            .map(|ip| format!("https://{}:{}/v/{}", ip, self.https_port, self.token))
            .collect()
    }

    /// 송신 탭에 보낼 시청 주소 목록. `lan_urls()` 를 그대로 쓰므로 loopback 은
    /// 들어가지 않는다 — 송신 탭에서 복사한 주소가 곧 상대방에게 갈 주소다.
    fn urls_message(&self) -> String {
        let tunnel = self.tunnel_info();
        json!({
            "type": "urls",
            "lan": self.lan_urls(),
            "tunnel": tunnel.url,
            "tunnelState": tunnel.state,
        })
        .to_string()
    }

    fn tunnel_info(&self) -> TunnelInfo {
        self.tunnel
            .as_ref()
            .and_then(|t| t.info.lock().ok().map(|i| i.clone()))
            .unwrap_or_else(TunnelInfo::off)
    }

    fn status(&self) -> ShareStatus {
        let (sender_connected, viewers) = self.hub.counts();
        let tunnel = self.tunnel_info();
        ShareStatus {
            active: true,
            sender_connected,
            viewers,
            relay_viewers: self.hub.relay_count(),
            sender_url: Some(self.sender_url()),
            lan_urls: self.lan_urls(),
            tunnel_url: tunnel.url,
            tunnel_state: tunnel.state,
            tunnel_error: tunnel.error,
        }
    }
}

/// 앱 전역 상태(lib.rs 에서 manage).
#[derive(Default)]
pub struct ShareState(Mutex<Option<Session>>);

/// 프론트엔드에 주는 스냅샷. `screenshare:state` 이벤트로도 같은 모양이 나간다.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    active: bool,
    /// 송신 탭이 실제로 화면을 잡고 붙어 있는지.
    sender_connected: bool,
    viewers: usize,
    /// 그중 P2P 가 막혀 **릴레이로** 보고 있는 사람 수(화질이 낮으므로 UI 에 알린다).
    relay_viewers: usize,
    /// 송신 페이지 주소. **localhost 이며 상대방에게 주는 주소가 아니다** —
    /// 앱이 "다시 열기"로 브라우저에 띄우는 데만 쓴다.
    sender_url: Option<String>,
    /// 같은 망에 있을 때 쓰는 시청 주소들(망이 여럿이면 여럿).
    lan_urls: Vec<String>,
    tunnel_url: Option<String>,
    tunnel_state: String,
    tunnel_error: Option<String>,
}

impl ShareStatus {
    fn idle() -> Self {
        Self {
            active: false,
            sender_connected: false,
            viewers: 0,
            relay_viewers: 0,
            sender_url: None,
            lan_urls: Vec::new(),
            tunnel_url: None,
            tunnel_state: "off".into(),
            tunnel_error: None,
        }
    }
}

/// 라우터가 들고 다니는 컨텍스트.
#[derive(Clone)]
struct Ctx {
    app: tauri::AppHandle,
    hub: Arc<Hub>,
    token: Arc<String>,
    sender_token: Arc<String>,
}

// ─────────────────────────── 커맨드 ───────────────────────────

/// 공유를 시작한다. 리스너 두 개를 띄우고, 송신 페이지를 브라우저로 열어 준다.
/// `tunnel` 이 true 면 cloudflared 로 외부 접근용 URL 도 만든다(비동기로 준비되므로
/// 반환 시점에는 `tunnelState: "starting"` 일 수 있다).
#[tauri::command]
pub async fn screenshare_start(app: tauri::AppHandle, tunnel: bool) -> Result<ShareStatus, String> {
    // 재시작 의미로 호출될 수 있으니 이전 세션은 먼저 정리한다.
    stop_inner(&app);

    let token = random_token(24);
    let sender_token = random_token(24);
    let hub = Arc::new(Hub::default());
    let lan_ips = lan_ips();

    let http_listener = bind_listener("127.0.0.1", PREFERRED_HTTP_PORT)?;
    let https_listener = bind_listener("0.0.0.0", PREFERRED_HTTPS_PORT)?;
    let http_port = http_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    let https_port = https_listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    let ctx = Ctx {
        app: app.clone(),
        hub: hub.clone(),
        token: Arc::new(token.clone()),
        sender_token: Arc::new(sender_token.clone()),
    };
    let router = build_router().with_state(ctx);

    // 자체 서명 인증서. 시청자가 쓸 수 있는 IP 를 모두 SAN 에 넣어 둔다 — 빠뜨리면
    // 그 주소로 접근한 사람은 "이름 불일치" 경고를 한 번 더 보게 된다.
    let tls = build_tls(&lan_ips).await?;

    let http_handle = axum_server::Handle::new();
    let https_handle = axum_server::Handle::new();

    {
        let router = router.clone();
        let handle = http_handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum_server::from_tcp(http_listener)
                .handle(handle)
                .serve(router.into_make_service())
                .await
            {
                log::error!("화면공유 HTTP 리스너 종료: {e}");
            }
        });
    }
    {
        let handle = https_handle.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = axum_server::from_tcp_rustls(https_listener, tls)
                .handle(handle)
                .serve(router.into_make_service())
                .await
            {
                log::error!("화면공유 HTTPS 리스너 종료: {e}");
            }
        });
    }

    let tunnel = if tunnel {
        match start_tunnel(app.clone(), http_port, token.clone()) {
            Ok(t) => Some(t),
            Err(e) => {
                // 터널은 부가 기능이다 — 실패해도 LAN 공유는 계속 살려 둔다.
                log::warn!("cloudflared 터널 시작 실패: {e}");
                Some(Tunnel {
                    child: None,
                    info: Arc::new(Mutex::new(TunnelInfo {
                        state: "failed".into(),
                        url: None,
                        error: Some(e),
                    })),
                })
            }
        }
    } else {
        None
    };

    let session = Session {
        hub,
        token,
        sender_token,
        http_port,
        https_port,
        lan_ips,
        http_handle,
        https_handle,
        tunnel,
    };
    let status = session.status();
    let sender_url = session.sender_url();

    if let Ok(mut guard) = app.state::<ShareState>().0.lock() {
        *guard = Some(session);
    }

    log::info!("화면공유 시작 — http:{http_port} https:{https_port}");
    open_in_browser(&sender_url);
    let _ = app.emit("screenshare:state", status.clone());
    Ok(status)
}

/// 공유를 끝낸다(리스너 종료 + 터널 프로세스 종료).
#[tauri::command]
pub fn screenshare_stop(app: tauri::AppHandle) -> ShareStatus {
    stop_inner(&app);
    let status = ShareStatus::idle();
    let _ = app.emit("screenshare:state", status.clone());
    status
}

/// 현재 상태(뷰가 마운트될 때 조회 — 탭을 다시 열어도 진행 중인 공유가 보이도록).
#[tauri::command]
pub fn screenshare_status(app: tauri::AppHandle) -> ShareStatus {
    app.state::<ShareState>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.status()))
        .unwrap_or_else(ShareStatus::idle)
}

/// 사외 공유 주소를 만들 수 있는지(= cloudflared 가 있는지).
///
/// 공유를 시작한 **뒤에** 실패를 알려 주면 늦다 — 이미 상대를 기다리게 한 상태다.
/// 뷰가 마운트될 때 이걸 물어보고, 없으면 체크박스를 끄고 설치 안내를 먼저 보여 준다.
#[tauri::command]
pub fn screenshare_tunnel_available() -> bool {
    CLOUDFLARED_CANDIDATES.iter().any(|bin| {
        if bin.contains('/') {
            std::path::Path::new(bin).is_file()
        } else {
            // PATH 에 있는지는 실행해 봐야 안다(GUI 앱의 PATH 는 최소라 보통 실패한다).
            Command::new(bin)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
    })
}

/// 송신 탭을 다시 연다(실수로 탭을 닫았을 때). 세션은 그대로 두고 페이지만 새로 띄운다.
#[tauri::command]
pub fn screenshare_reopen_sender(app: tauri::AppHandle) -> Result<(), String> {
    let url = app
        .state::<ShareState>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.sender_url()))
        .ok_or_else(|| "공유가 실행 중이 아닙니다".to_string())?;
    open_in_browser(&url);
    Ok(())
}

fn stop_inner(app: &tauri::AppHandle) {
    let session = app
        .state::<ShareState>()
        .0
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    let Some(mut session) = session else { return };

    // 시청 페이지들이 "종료됨"을 즉시 알 수 있게 알려 준 뒤 리스너를 닫는다.
    session
        .hub
        .broadcast_viewers(json!({ "type": "sender-gone" }).to_string());

    let grace = Some(std::time::Duration::from_millis(300));
    session.http_handle.graceful_shutdown(grace);
    session.https_handle.graceful_shutdown(grace);

    if let Some(child) = session.tunnel.as_mut().and_then(|t| t.child.as_mut()) {
        let _ = child.kill();
        let _ = child.wait();
    }
    log::info!("화면공유 중지");
}

// ─────────────────────────── HTTP 핸들러 ───────────────────────────

/// 라우터. state 를 붙이기 전 단계로 떼어 둔다 — 잘못된 경로 패턴은 컴파일이 아니라
/// `route()` 호출 **시점에 패닉**하므로(공유를 시작하려는 순간 앱이 죽는다)
/// 테스트에서 이 함수만 불러 검증한다.
fn build_router() -> Router<Ctx> {
    Router::new()
        .route("/s/{token}", get(sender_page))
        .route("/v/{token}", get(viewer_page))
        .route("/ws", get(ws_handler))
        .fallback(get(not_found))
}

fn html(body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // 토큰이 매 세션 바뀌므로 캐시가 남으면 옛 페이지가 뜬다.
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}

async fn sender_page(
    Path(token): Path<String>,
    headers: HeaderMap,
    State(ctx): State<Ctx>,
) -> Response {
    if token != *ctx.sender_token || !is_local_host(&headers) {
        return not_found().await;
    }
    html(SENDER_HTML)
}

/// 이 요청이 **이 PC 안에서** 온 것인지(Host 가 localhost 인지).
///
/// 송신 페이지와 송신 소켓은 로컬 전용이어야 한다. HTTP 리스너는 127.0.0.1 에만
/// 묶여 있지만 터널이 그 리스너를 오리진으로 쓰므로, 터널 URL 로도 `/s/<token>` 에
/// 닿을 수 있다 — 그때 Host 는 `xxx.trycloudflare.com` 이므로 여기서 걸러진다.
/// (막지 않으면 sender_token 이 새는 순간 외부에서 화면을 바꿔치기할 수 있다.)
fn is_local_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    // `127.0.0.1:7777`, `localhost:7777`, `[::1]:7777` 에서 호스트 부분만 떼어낸다.
    let name = match host.strip_prefix('[') {
        Some(rest) => rest.split(']').next().unwrap_or(""),
        None => host.rsplit_once(':').map_or(host, |(h, _)| h),
    };
    matches!(name, "127.0.0.1" | "localhost" | "::1")
}

async fn viewer_page(Path(token): Path<String>, State(ctx): State<Ctx>) -> Response {
    if token != *ctx.token {
        return not_found().await;
    }
    html(VIEWER_HTML)
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "링크가 올바르지 않거나 공유가 이미 끝났습니다.",
    )
        .into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    role: String,
    token: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    State(ctx): State<Ctx>,
) -> Response {
    let is_sender = match q.role.as_str() {
        // 송신 소켓도 로컬 전용이다 — 페이지만 막고 소켓을 열어 두면 우회가 된다.
        "sender" if q.token == *ctx.sender_token && is_local_host(&headers) => true,
        "viewer" if q.token == *ctx.token => false,
        _ => return (StatusCode::FORBIDDEN, "forbidden").into_response(),
    };
    ws.on_upgrade(move |socket| async move {
        if is_sender {
            sender_socket(socket, ctx).await;
        } else {
            viewer_socket(socket, ctx).await;
        }
    })
}

/// 송신 탭의 소켓. 받은 offer/candidate 를 `to` 가 가리키는 시청자에게 넘긴다.
async fn sender_socket(mut socket: WebSocket, ctx: Ctx) {
    let (tx, mut rx) = unbounded_channel::<Out>();
    let (id, prev, viewers) = ctx.hub.attach_sender(tx.clone());

    // 같은 토큰으로 다른 탭이 붙었다면 옛 탭은 물러나게 한다.
    if let Some(prev) = prev {
        let _ = prev.send(Out::Text(json!({ "type": "replaced" }).to_string()));
    }
    // 시청 페이지가 먼저 열려 있었을 수 있으므로 현재 목록을 알려 준다.
    let _ = tx.send(Out::Text(
        json!({ "type": "peers", "ids": viewers }).to_string(),
    ));
    // 릴레이 인원도 함께 알려야 한다 — 송신 탭이 새로 붙은 경우(닫았다 다시 열기,
    // 다른 화면으로 재공유) 이걸 빼먹으면 이미 릴레이로 보고 있던 사람은 프레임이
    // 끊긴 채 검은 화면만 보게 된다.
    let _ = tx.send(Out::Text(
        json!({ "type": "relay-count", "count": ctx.hub.relay_count() }).to_string(),
    ));
    emit_state(&ctx.app);

    loop {
        // select! 로 한 태스크에서 수신·송신을 함께 다룬다(소켓을 쪼개지 않아
        // futures-util 의존이 필요 없다). 두 future 모두 취소 안전하다.
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                match msg {
                    // 릴레이 프레임(JPEG). 어느 시청자에게 갈지는 송신 탭이 정하지 않는다 —
                    // 릴레이로 물러난 시청자 전원이 같은 프레임을 본다.
                    Message::Binary(frame) => ctx.hub.broadcast_frame(frame.into()),
                    Message::Text(text) => {
                        let Ok(mut value) =
                            serde_json::from_str::<serde_json::Value>(text.as_str())
                        else {
                            continue;
                        };
                        let to = value.get("to").and_then(|v| v.as_u64());
                        if let Some(obj) = value.as_object_mut() {
                            obj.remove("to");
                        }
                        if let Some(to) = to {
                            ctx.hub.to_viewer(to, value.to_string());
                        }
                    }
                    _ => {}
                }
            }
            outgoing = rx.recv() => {
                let Some(out) = outgoing else { break };
                if send_out(&mut socket, out).await.is_err() {
                    break;
                }
            }
        }
    }

    // 교체된 뒤에 닫힌 소켓이면(detach 실패) 시청자에게 종료를 알리지 않는다 —
    // 새 송신 탭이 이미 화면을 보내고 있기 때문이다.
    if ctx.hub.detach_sender(id) {
        ctx.hub
            .broadcast_viewers(json!({ "type": "sender-gone" }).to_string());
    }
    emit_state(&ctx.app);
}

/// 시청 페이지의 소켓. answer/candidate 는 항상 송신자 한 명에게 가므로 `from` 만 붙인다.
async fn viewer_socket(mut socket: WebSocket, ctx: Ctx) {
    let (tx, mut rx) = unbounded_channel::<Out>();
    let (id, has_sender) = ctx.hub.add_viewer(tx.clone());

    if has_sender {
        ctx.hub
            .to_sender(json!({ "type": "join", "from": id }).to_string());
    } else {
        let _ = tx.send(Out::Text(json!({ "type": "waiting" }).to_string()));
    }
    emit_state(&ctx.app);

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                let Some(Ok(msg)) = incoming else { break };
                let Message::Text(text) = msg else { continue };
                let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text.as_str()) else {
                    continue;
                };

                // 릴레이 요청·해제는 허브가 직접 처리한다(송신 탭에는 "몇 명이
                // 릴레이로 보는지"만 알려 준다 — 프레임 캡처를 켜고 끌 근거).
                if let Some(kind) = value.get("type").and_then(|v| v.as_str()) {
                    if kind == "relay" {
                        let on = value.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
                        let count = ctx.hub.set_relay(id, on);
                        ctx.hub
                            .to_sender(json!({ "type": "relay-count", "count": count }).to_string());
                        emit_state(&ctx.app);
                        continue;
                    }
                }

                if let Some(obj) = value.as_object_mut() {
                    obj.insert("from".into(), json!(id));
                }
                ctx.hub.to_sender(value.to_string());
            }
            outgoing = rx.recv() => {
                let Some(out) = outgoing else { break };
                if send_out(&mut socket, out).await.is_err() {
                    break;
                }
            }
        }
    }

    ctx.hub.remove_viewer(id);
    // 이 시청자가 릴레이였다면 남은 릴레이 수를 알려 줘야 송신 탭이 캡처를 멈춘다.
    let relay = ctx.hub.relay_count();
    ctx.hub
        .to_sender(json!({ "type": "leave", "from": id }).to_string());
    ctx.hub
        .to_sender(json!({ "type": "relay-count", "count": relay }).to_string());
    emit_state(&ctx.app);
}

/// 채널에서 꺼낸 것을 소켓으로 흘린다(텍스트/바이너리 분기만 한다).
async fn send_out(socket: &mut WebSocket, out: Out) -> Result<(), axum::Error> {
    match out {
        Out::Text(text) => socket.send(Message::Text(text.into())).await,
        Out::Bin(bytes) => socket.send(Message::Binary(bytes.into())).await,
    }
}

/// 시청자 수·송신 연결 여부가 바뀔 때마다 프론트에 현재 상태를 흘려 준다.
fn emit_state(app: &tauri::AppHandle) {
    let status = screenshare_status(app.clone());
    let _ = app.emit("screenshare:state", status);
    push_urls(app);
}

/// 송신 탭에 시청 주소를 밀어 준다.
///
/// 화면을 고른 사람이 **앱으로 돌아가지 않고 그 자리에서** 주소를 복사할 수 있어야 한다.
/// 터널 주소는 몇 초 뒤에야 준비되므로 한 번 보내고 끝낼 수 없다 — `emit_state` 에
/// 얹어 두면 접속·터널 준비·시청자 변동 어느 시점이든 최신 주소가 따라간다.
fn push_urls(app: &tauri::AppHandle) {
    let payload = app
        .state::<ShareState>()
        .0
        .lock()
        .ok()
        .and_then(|guard| {
            guard
                .as_ref()
                .map(|session| (session.hub.clone(), session.urls_message()))
        });
    // 락을 놓은 뒤에 보낸다(Hub 락과 겹치지 않게).
    if let Some((hub, message)) = payload {
        hub.to_sender(message);
    }
}

// ─────────────────────────── 인프라 헬퍼 ───────────────────────────

fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

/// 원하는 포트로 먼저 시도하고, 이미 쓰이면 임의 포트로 바인딩한다.
fn bind_listener(host: &str, preferred: u16) -> Result<TcpListener, String> {
    let listener = TcpListener::bind((host, preferred))
        .or_else(|_| TcpListener::bind((host, 0)))
        .map_err(|e| format!("{host} 포트를 열 수 없습니다: {e}"))?;
    // axum_server 가 tokio 리스너로 변환하므로 논블로킹이어야 한다.
    listener
        .set_nonblocking(true)
        .map_err(|e| e.to_string())?;
    Ok(listener)
}

/// 기본 경로(라우팅 테이블이 고르는) IP. UDP 소켓을 외부 주소로 "connect" 하면
/// 패킷을 보내지 않고도 출발지 주소를 알 수 있다.
fn primary_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

/// 시청자가 붙을 수 있는 이 PC 의 IPv4 주소 **전부**. 기본 경로 IP 가 맨 앞에 온다.
///
/// 하나만 알려주면 안 된다 — 이 PC 처럼 유선(사내망)과 Wi-Fi 에 동시에 붙어 있으면
/// 라우팅이 고른 주소는 한쪽 망뿐이고, 다른 망에 있는 사람은 그 주소로 접근할 수 없다.
/// loopback·link-local(169.254.x)은 상대방이 쓸 수 없으므로 제외한다 —
/// 시청 URL 에 127.0.0.1 이 들어가면 받은 사람은 자기 PC 를 보게 된다.
fn lan_ips() -> Vec<String> {
    let mut ips = collect_ipv4();
    if let Some(primary) = primary_ip() {
        ips.retain(|ip| *ip != primary);
        ips.insert(0, primary);
    }
    ips
}

#[cfg(target_os = "macos")]
fn collect_ipv4() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut addrs: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs 가 성공하면 연결 리스트를 채워 주고, 끝에서 freeifaddrs 로 해제한다.
    // 순회 중에는 각 노드의 ifa_addr 이 널인지 확인한 뒤에만 역참조한다.
    unsafe {
        if libc::getifaddrs(&mut addrs) != 0 {
            return out;
        }
        let mut cur = addrs;
        while !cur.is_null() {
            let ifa = &*cur;
            cur = ifa.ifa_next;

            if ifa.ifa_addr.is_null() {
                continue;
            }
            if i32::from((*ifa.ifa_addr).sa_family) != libc::AF_INET {
                continue;
            }
            let flags = ifa.ifa_flags as i32;
            if flags & libc::IFF_UP == 0 || flags & libc::IFF_LOOPBACK != 0 {
                continue;
            }
            let sin = ifa.ifa_addr as *const libc::sockaddr_in;
            let ip = std::net::Ipv4Addr::from(u32::from_be((*sin).sin_addr.s_addr));
            if ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() {
                continue;
            }
            let ip = ip.to_string();
            if !out.contains(&ip) {
                out.push(ip);
            }
        }
        libc::freeifaddrs(addrs);
    }
    out
}

#[cfg(not(target_os = "macos"))]
fn collect_ipv4() -> Vec<String> {
    primary_ip().into_iter().collect()
}

/// rustls 는 프로세스에 CryptoProvider 가 하나로 정해져 있어야 한다. 의존성 그래프에
/// ring 과 aws-lc-rs 가 함께 들어와 있으면 자동 선택이 패닉하므로 직접 정한다.
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

async fn build_tls(lan_ips: &[String]) -> Result<axum_server::tls_rustls::RustlsConfig, String> {
    ensure_crypto_provider();

    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    names.extend(lan_ips.iter().cloned());
    let cert = rcgen::generate_simple_self_signed(names)
        .map_err(|e| format!("자체 서명 인증서 생성 실패: {e}"))?;

    axum_server::tls_rustls::RustlsConfig::from_pem(
        cert.cert.pem().into_bytes(),
        cert.key_pair.serialize_pem().into_bytes(),
    )
    .await
    .map_err(|e| format!("TLS 설정 실패: {e}"))
}

/// 송신 페이지를 시스템 브라우저로 연다. 크롬을 먼저 시도하는 이유는
/// `getDisplayMedia` 지원이 가장 확실하고 화면 선택 UI 가 익숙하기 때문이다.
///
/// **왜 `tauri_plugin_opener` 를 쓰지 않는가.** 그쪽은 detached 실행이라 대상 앱이
/// 없어도 `Ok` 를 돌려준다 — 크롬이 깔려 있지 않은 PC 에서 아무 창도 뜨지 않은 채
/// 성공으로 보이고, 기본 브라우저 폴백이 영영 돌지 않는다. "크롬이 실제로 열렸는가"를
/// 알아야 폴백을 걸 수 있으므로 플랫폼별로 직접 띄운다.
fn open_in_browser(url: &str) {
    if open_with_chrome(url) {
        return;
    }
    // 크롬이 없으면 기본 브라우저로. Safari 17+ / Edge 도 getDisplayMedia 를 지원한다.
    if let Err(e) = open_with_default(url) {
        log::error!("송신 페이지를 열 수 없습니다: {e}");
    }
}

/// macOS: `open -a` 는 대상 앱이 없으면 **0 이 아닌 코드로 끝나므로** 성공 여부를
/// 그대로 신뢰할 수 있다(그래서 여기만 `status()` 로 기다린다).
#[cfg(target_os = "macos")]
fn open_with_chrome(url: &str) -> bool {
    matches!(
        Command::new("open").args(["-a", "Google Chrome", url]).status(),
        Ok(s) if s.success()
    )
}

#[cfg(target_os = "macos")]
fn open_with_default(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).status().map(|_| ())
}

/// Windows: `cmd /C start chrome` 로 열지 않는다 — 셸이 인자를 한 번 더 파싱해서
/// URL 의 따옴표·`&` 처리가 걸리고, 크롬이 없을 때의 실패도 구분하기 어렵다.
/// cloudflared 와 같은 방식으로 실행 파일을 직접 찾아 넘긴다.
///
/// 이미 크롬 창이 떠 있으면 `chrome.exe` 는 기존 인스턴스에 URL 을 넘기고 **즉시 종료**하고,
/// 첫 실행이면 그대로 살아 있는다 — `status()` 로 기다리면 후자에서 공유 시작이 통째로
/// 멈춘다. 그래서 경로 존재를 먼저 확인하고 `spawn()` 성공만 본다.
#[cfg(target_os = "windows")]
fn open_with_chrome(url: &str) -> bool {
    // 사용자 단위 설치(LOCALAPPDATA)와 기기 단위 설치(Program Files) 둘 다 흔하다.
    ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]
        .iter()
        .filter_map(std::env::var_os)
        .map(|root| std::path::PathBuf::from(root).join(r"Google\Chrome\Application\chrome.exe"))
        .filter(|exe| exe.is_file())
        .any(|exe| {
            Command::new(&exe)
                .arg(url)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .is_ok()
        })
}

/// Windows: `start` 는 cmd 내장 명령이라 셸을 거쳐야 한다. 첫 인자는 창 제목으로 먹히므로
/// 빈 문자열을 하나 넣어 URL 이 제목으로 삼켜지지 않게 한다.
/// (여기 오는 URL 은 `http://127.0.0.1:<포트>/s/<영숫자 토큰>` 뿐이라 셸 메타문자가 없다.)
#[cfg(target_os = "windows")]
fn open_with_default(url: &str) -> std::io::Result<()> {
    Command::new("cmd")
        .args(["/C", "start", "", url])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|_| ())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_with_chrome(url: &str) -> bool {
    Command::new("google-chrome").arg(url).spawn().is_ok()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_with_default(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).status().map(|_| ())
}

/// 사외에서 열 수 있는 URL 을 만든다 — **cloudflared 로만** 한다.
///
/// 오리진은 **HTTP 리스너**(127.0.0.1)로 잡는다 — 자체 서명 HTTPS 를 가리키면
/// `--no-tls-verify` 가 필요하고, 어차피 공개 구간의 TLS 는 cloudflared 가 종단한다.
/// 공인 IP(`https://<WAN IP>:포트`)를 그대로 쓰는 길은 없다 — 이 PC 는 사내 NAT 뒤에 있어
/// 방화벽에서 포트포워딩을 열어 줘야 하고, 그건 사내 IT 권한이다.
///
/// 설치가 필요 없는 SSH 리버스 터널(localhost.run)을 폴백으로 두었다가 **걷어냈다.**
/// HTTP·WebSocket 은 통과하는 것을 확인했지만 무료 공용 서비스라 대역폭·가용성 보장이
/// 없고, 실제 공유가 되지 않는 사례가 나왔다. 되다 안 되다 하는 경로는 없는 편이 낫다 —
/// 화면이 안 보이는데 원인을 짚을 수 없게 만든다. 다시 넣지 말 것.
fn start_tunnel(app: tauri::AppHandle, http_port: u16, token: String) -> Result<Tunnel, String> {
    let mut last_err = String::from("cloudflared 를 찾을 수 없습니다");
    for bin in CLOUDFLARED_CANDIDATES {
        match Command::new(bin)
            .args([
                "tunnel",
                "--no-autoupdate",
                "--url",
                &format!("http://127.0.0.1:{http_port}"),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => return Ok(watch_tunnel(&app, child, &token)),
            Err(e) => last_err = format!("{bin}: {e}"),
        }
    }
    Err(format!(
        "{last_err} — `brew install cloudflared` 로 설치하면 사외 공유 주소를 만들 수 있습니다"
    ))
}

/// cloudflared 의 출력에서 공개 URL 을 긁어 상태에 채운다(진행 로그는 stderr 로 나온다).
fn watch_tunnel(app: &tauri::AppHandle, mut child: Child, token: &str) -> Tunnel {
    const LABEL: &str = "cloudflared";
    let info = Arc::new(Mutex::new(TunnelInfo::starting()));

    if let Some(stream) = child.stderr.take() {
        let info = info.clone();
        let app = app.clone();
        let token = token.to_string();
        std::thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                log::debug!("{LABEL}: {line}");
                let Some(url) = extract_tunnel_url(&line) else {
                    continue;
                };
                if let Ok(mut guard) = info.lock() {
                    // 여러 줄에 같은 URL 이 반복돼 나오므로 첫 번째만 쓴다.
                    if guard.state == "ready" {
                        continue;
                    }
                    guard.state = "ready".into();
                    guard.url = Some(format!("{url}/v/{token}"));
                    guard.error = None;
                }
                log::info!("화면공유 터널 준비됨({LABEL}): {url}");
                emit_state(&app);
            }
            // 스트림이 끝났다 = 프로세스 종료. URL 을 못 받은 채였다면 실패로 남긴다.
            if let Ok(mut guard) = info.lock() {
                if guard.state != "ready" {
                    guard.state = "failed".into();
                    guard.error = Some(format!("{LABEL} 이 URL 을 만들지 못한 채 종료했습니다"));
                }
            }
            emit_state(&app);
        });
    }

    Tunnel {
        child: Some(child),
        info,
    }
}

/// cloudflared 가 발급하는 주소의 도메인. 로그에는 API 주소 같은 무관한 URL 이 섞여
/// 나오므로(`api.trycloudflare.com/tunnel`), 이 도메인으로 **끝나는** 것만 받아들인다.
const TUNNEL_DOMAIN: &str = ".trycloudflare.com";

/// cloudflared 로그 한 줄에서 공개 URL 을 뽑는다.
/// 출력이 표 형태(`|  https://xxx.trycloudflare.com   |`)라 구분자·공백을 걷어내고,
/// 한 줄에 여러 URL 이 있을 수 있으므로 https 후보를 모두 훑는다.
fn extract_tunnel_url(line: &str) -> Option<&str> {
    let mut offset = 0;
    while let Some(found) = line[offset..].find("https://") {
        let start = offset + found;
        let rest = &line[start..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == ',')
            .unwrap_or(rest.len());
        let url = rest[..end].trim_end_matches('/');
        if url.ends_with(TUNNEL_DOMAIN) {
            return Some(url);
        }
        offset = start + "https://".len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 자체 서명 인증서 생성과 rustls 설정은 **공유를 시작하는 순간** 처음 실행되는
    /// 코드다. 프로세스에 CryptoProvider 가 정해지지 않은 채로 두면 여기서 패닉하므로
    /// (의존성 그래프에 ring·aws-lc-rs 가 함께 있다) 실제로 통과하는지 확인한다.
    #[tokio::test]
    async fn builds_self_signed_tls_config() {
        // 망이 여럿인 PC 에서도 인증서 하나로 커버해야 한다(SAN 에 모두 들어간다).
        build_tls(&["192.168.0.42".to_string(), "172.16.100.225".to_string()])
            .await
            .expect("자체 서명 TLS 설정이 만들어져야 한다");
        // 두 번째 호출도 성공해야 한다 — install_default 는 한 번만 성공하고
        // 이후에는 Err 를 돌려주는데, 그걸 오류로 다루면 재시작이 불가능해진다.
        build_tls(&[]).await.expect("두 번째 시작도 되어야 한다");
    }

    fn session_for_test(lan_ips: &[&str]) -> Session {
        Session {
            hub: Arc::new(Hub::default()),
            token: "VIEWTOKEN".into(),
            sender_token: "SENDTOKEN".into(),
            http_port: 7777,
            https_port: 7778,
            lan_ips: lan_ips.iter().map(|s| s.to_string()).collect(),
            http_handle: axum_server::Handle::new(),
            https_handle: axum_server::Handle::new(),
            tunnel: None,
        }
    }

    /// **상대방에게 주는 주소에 loopback 이 들어가면 안 된다** — 받은 사람이 열면
    /// 자기 PC 를 보게 되고, 왜 안 되는지도 알기 어렵다. 반대로 송신 주소는
    /// 반드시 localhost 여야 한다(secure context 예외 + 인증서 경고 회피).
    #[test]
    fn viewer_urls_never_point_at_loopback() {
        let session = session_for_test(&["172.16.100.225", "192.168.11.94"]);

        let urls = session.lan_urls();
        assert_eq!(urls.len(), 2, "망이 여럿이면 주소도 여럿이어야 한다");
        for url in &urls {
            assert!(!url.contains("127.0.0.1"), "시청 주소에 loopback: {url}");
            assert!(!url.contains("localhost"), "시청 주소에 loopback: {url}");
            assert!(url.starts_with("https://"), "시청 주소는 https 여야 한다: {url}");
            assert!(url.ends_with("/v/VIEWTOKEN"));
        }
        assert_eq!(urls[0], "https://172.16.100.225:7778/v/VIEWTOKEN");

        // 송신 주소만 localhost 다. 시청 토큰이 아니라 송신 토큰을 쓴다.
        let sender = session.sender_url();
        assert_eq!(sender, "http://127.0.0.1:7777/s/SENDTOKEN");
        assert!(!sender.contains("VIEWTOKEN"), "시청 토큰이 새면 안 된다");

        // 상태 스냅샷(프론트가 그대로 화면에 뿌린다)에도 같은 규칙이 지켜져야 한다.
        let status = session.status();
        assert!(status.lan_urls.iter().all(|u| !u.contains("127.0.0.1")));
    }

    /// 송신 탭이 복사하는 주소가 곧 상대방에게 갈 주소다 — 여기에도 loopback 이
    /// 없어야 하고, 시청 토큰만 담겨야 한다.
    #[test]
    fn sender_tab_receives_loopback_free_viewer_urls() {
        let message = session_for_test(&["172.16.100.225"]).urls_message();

        assert!(message.contains(r#""type":"urls""#));
        assert!(message.contains("https://172.16.100.225:7778/v/VIEWTOKEN"));
        assert!(
            !message.contains("127.0.0.1"),
            "송신 탭에 loopback 주소를 주면 그대로 복사해서 전달한다: {message}"
        );
        assert!(!message.contains("localhost"), "{message}");
        assert!(!message.contains("SENDTOKEN"), "송신 토큰은 담지 않는다");
    }

    /// 망에 붙어 있지 않으면 LAN 주소는 아예 없어야 한다 — loopback 으로 대체하면
    /// "주소는 나왔는데 아무도 못 여는" 상태가 된다.
    #[test]
    fn no_lan_urls_when_offline() {
        assert!(session_for_test(&[]).lan_urls().is_empty());
    }

    /// 실제 이 PC 에서 수집되는 주소에도 loopback·link-local 이 섞이면 안 된다.
    #[test]
    fn collected_ips_are_usable_by_others() {
        for ip in lan_ips() {
            let parsed: std::net::Ipv4Addr = ip.parse().expect("IPv4 여야 한다");
            assert!(!parsed.is_loopback(), "loopback 이 섞였다: {ip}");
            assert!(!parsed.is_link_local(), "link-local 이 섞였다: {ip}");
        }
    }

    /// 송신 페이지·소켓은 로컬 전용이다. 터널 URL 로 들어온 요청(Host 가 터널 도메인)은
    /// 막아야 한다 — 안 막으면 sender_token 이 새는 순간 외부에서 화면을 바꿔치기할 수 있다.
    #[test]
    fn only_localhost_may_act_as_sender() {
        let local = |host: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::HOST, host.parse().unwrap());
            is_local_host(&headers)
        };

        assert!(local("127.0.0.1:7777"));
        assert!(local("localhost:7777"));
        assert!(local("localhost"));
        assert!(local("[::1]:7777"));

        assert!(!local("abc-def.trycloudflare.com"), "터널 경유는 막아야 한다");
        assert!(!local("172.16.100.225:7778"), "LAN 경유도 막아야 한다");
        // Host 헤더가 없으면 판단할 수 없으므로 거부한다.
        assert!(!is_local_host(&HeaderMap::new()));
    }

    /// axum 은 잘못된 경로 패턴(예: 0.7 시절의 `:token`)을 `route()` 호출에서 패닉으로
    /// 알린다 — 컴파일은 통과하고 공유를 시작하는 순간 앱이 죽는다.
    #[test]
    fn route_patterns_are_valid() {
        let _ = build_router();
    }

    /// 이미 쓰이는 포트여도 공유는 시작돼야 한다(임의 포트로 물러난다).
    #[test]
    fn falls_back_to_random_port_when_preferred_is_taken() {
        let taken = bind_listener("127.0.0.1", PREFERRED_HTTP_PORT).unwrap();
        let port = taken.local_addr().unwrap().port();

        let second = bind_listener("127.0.0.1", port).unwrap();
        assert_ne!(second.local_addr().unwrap().port(), port);
    }

    /// 송신 탭을 새로 열면 옛 탭은 물러나야 하고, **뒤늦게 닫히는 옛 소켓이
    /// 새 송신자를 지우면 안 된다** — 이걸 놓치면 새 탭이 붙는 순간 공유가 끊긴다.
    #[test]
    fn replacing_sender_does_not_let_stale_socket_detach_it() {
        let hub = Hub::default();
        let (tx_old, mut rx_old) = unbounded_channel::<Out>();
        let (tx_new, _rx_new) = unbounded_channel::<Out>();

        let (old_id, prev, _) = hub.attach_sender(tx_old);
        assert!(prev.is_none());

        let (new_id, prev, _) = hub.attach_sender(tx_new);
        // 교체 대상(옛 송신자)의 채널을 돌려받아 "물러나라"고 알릴 수 있어야 한다.
        prev.expect("옛 송신자 채널")
            .send(Out::Text("bye".into()))
            .unwrap();
        assert_eq!(rx_old.try_recv().unwrap(), Out::Text("bye".into()));

        // 옛 소켓이 이제야 닫힌다 — 새 송신자는 살아 있어야 한다.
        assert!(!hub.detach_sender(old_id));
        assert!(hub.counts().0, "새 송신자가 남아 있어야 한다");
        assert!(hub.detach_sender(new_id));
        assert!(!hub.counts().0);
    }

    /// 시청자별 라우팅: `to` 로 지목한 시청자에게만 가야 한다.
    #[test]
    fn routes_messages_to_the_addressed_viewer_only() {
        let hub = Hub::default();
        let (tx_a, mut rx_a) = unbounded_channel::<Out>();
        let (tx_b, mut rx_b) = unbounded_channel::<Out>();

        let (id_a, has_sender) = hub.add_viewer(tx_a);
        assert!(!has_sender, "송신자가 없으면 알려 줘야 한다(대기 표시용)");
        let (id_b, _) = hub.add_viewer(tx_b);
        assert_ne!(id_a, id_b);

        hub.to_viewer(id_a, "offer-a".into());
        assert_eq!(rx_a.try_recv().unwrap(), Out::Text("offer-a".into()));
        assert!(rx_b.try_recv().is_err());

        hub.remove_viewer(id_a);
        assert_eq!(hub.counts().1, 1);
        hub.broadcast_viewers("gone".into());
        assert!(rx_a.try_recv().is_err());
        assert_eq!(rx_b.try_recv().unwrap(), Out::Text("gone".into()));
    }

    /// 릴레이 프레임은 **릴레이로 물러난 시청자에게만** 가야 한다. P2P 로 잘 보고 있는
    /// 시청자에게도 보내면 업로드 대역폭을 두 배로 쓰면서 화면은 나아지지 않는다.
    #[test]
    fn relay_frames_reach_only_relay_viewers() {
        let hub = Hub::default();
        let (tx_p2p, mut rx_p2p) = unbounded_channel::<Out>();
        let (tx_relay, mut rx_relay) = unbounded_channel::<Out>();

        let (_id_p2p, _) = hub.add_viewer(tx_p2p);
        let (id_relay, _) = hub.add_viewer(tx_relay);

        // 아직 아무도 릴레이가 아니면 프레임은 어디로도 가지 않는다.
        hub.broadcast_frame(vec![1, 2, 3]);
        assert!(rx_p2p.try_recv().is_err());
        assert!(rx_relay.try_recv().is_err());

        assert_eq!(hub.set_relay(id_relay, true), 1);
        hub.broadcast_frame(vec![0xFF, 0xD8]);
        assert_eq!(rx_relay.try_recv().unwrap(), Out::Bin(vec![0xFF, 0xD8]));
        assert!(rx_p2p.try_recv().is_err(), "P2P 시청자에게 가면 안 된다");

        // 릴레이 시청자가 떠나면 카운트가 0 이 되어야 송신 탭이 캡처를 멈춘다.
        hub.remove_viewer(id_relay);
        assert_eq!(hub.relay_count(), 0);
        hub.broadcast_frame(vec![9]);
        assert!(rx_p2p.try_recv().is_err());
    }

    /// cloudflared 는 URL 을 표 형태로 찍어 준다 — 구분자·공백을 걷어내야 한다.
    #[test]
    fn extracts_url_from_boxed_log_line() {
        let line = "2026-07-31T05:00:00Z INF |  https://abc-def-ghi.trycloudflare.com    |";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://abc-def-ghi.trycloudflare.com")
        );
    }

    /// 같은 도메인의 API 주소(`api.trycloudflare.com/tunnel`)를 공개 URL 로 오인하면
    /// 시청 링크가 엉뚱한 곳을 가리킨다.
    #[test]
    fn ignores_unrelated_urls() {
        let line = "INF Requesting new quick tunnel on https://api.trycloudflare.com/tunnel";
        assert_eq!(extract_tunnel_url(line), None);
        assert_eq!(extract_tunnel_url("INF starting tunnel"), None);
    }

    /// 한 줄에 무관한 URL 이 먼저 나오고 뒤에 실제 주소가 오는 경우 — 첫 https 에서
    /// 멈추면 공유 링크가 엉뚱한 곳을 가리킨다.
    #[test]
    fn extracts_url_after_unrelated_links_on_the_same_line() {
        let line = "INF see https://developers.cloudflare.com/docs | https://abc-def.trycloudflare.com |";
        assert_eq!(
            extract_tunnel_url(line),
            Some("https://abc-def.trycloudflare.com")
        );
    }

    /// localhost.run(`*.lhr.life`) 폴백은 걷어냈다 — 되다 안 되다 하는 경로였다.
    /// 실수로 되살아나지 않도록 그 도메인은 받아들이지 않는 것을 못 박는다.
    #[test]
    fn rejects_the_removed_ssh_tunnel_domain() {
        assert_eq!(
            extract_tunnel_url("INF https://6f523f8bfb1f19.lhr.life tunneled"),
            None
        );
    }
}
