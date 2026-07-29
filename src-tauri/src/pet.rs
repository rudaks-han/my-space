//! 데스크톱 펫 창(`pet`) — 화면 위에 떠 있는 캐릭터이자, 앱의 **유일한 알림 창구**.
//!
//! 예전에는 트레이 아이콘 아래에 뜨는 팝오버 창(`widget`)이 리마인더와 Claude Code 알림을
//! 맡았지만, 펫이 같은 내용을 이미 말풍선으로 보여 주므로 팝오버는 없앴다(창이 하나 줄어
//! WebContent 프로세스도 하나 줄어든다). 그 대신 펫은 설정에서 꺼 뒀더라도 알릴 것이 생기면
//! 잠깐 나타나야 한다 — 아래 `PetAlert` 참고.
//!
//! 창은 투명·무테·always-on-top 이고 캐릭터(+말풍선) 크기만큼만 잡는다. 투명한 빈 영역도
//! 마우스 클릭을 먹으므로, 창을 내용에 딱 맞춰 두는 것이 곧 "뒤 창을 가리지 않는다"는 뜻이다
//! (프론트엔드가 내용 크기를 재서 `pet_resize` 를 부른다).
//!
//! 크기가 바뀔 때는 **바닥 중앙**을 고정한다 — 말풍선이 붙어 창이 커져도 캐릭터는 제자리에
//! 있는 것처럼 보여야 하기 때문이다. 그래서 저장·복원하는 위치도 좌상단이 아니라 바닥 중앙이다.

use base64::Engine as _;
use serde::Serialize;
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager};

/// 펫 창 라벨. `capabilities/default.json` 의 windows 목록과
/// 프론트엔드 `window-role.ts` 의 PET_WINDOW_LABEL 과 같아야 한다.
const LABEL: &str = "pet";

/// 기본 위치를 잡을 때 화면 오른쪽에서 띄울 여백.
const MARGIN: f64 = 24.0;
/// 기본 위치를 잡을 때 화면 바닥에서 띄울 높이(macOS Dock 을 피한다).
const DOCK_GAP: f64 = 96.0;
/// 화면 경계 보정 시 남길 최소 여백.
const EDGE: f64 = 4.0;

/// 캐릭터 바닥 중앙(논리 좌표). 창을 리사이즈해도 변하지 않는 기준점이라
/// 프론트엔드가 이 값을 저장해 두고 다음 실행에서 `pet_show` 로 되돌린다.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetAnchor {
    pub center_x: f64,
    pub bottom: f64,
}

/// 창이 놓인 모니터의 논리 좌표계 경계 (x, y, width, height).
fn monitor_bounds(win: &tauri::Window) -> Option<(f64, f64, f64, f64)> {
    let m = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| win.primary_monitor().ok().flatten())?;
    let scale = m.scale_factor();
    let p = m.position().to_logical::<f64>(scale);
    let s = m.size().to_logical::<f64>(scale);
    Some((p.x, p.y, s.width, s.height))
}

/// 논리 좌표계에서의 현재 창 위치·크기 (x, y, width, height).
fn logical_rect(win: &tauri::Window) -> Option<(f64, f64, f64, f64)> {
    let scale = win.scale_factor().ok()?;
    let p = win.outer_position().ok()?.to_logical::<f64>(scale);
    let s = win.outer_size().ok()?.to_logical::<f64>(scale);
    Some((p.x, p.y, s.width, s.height))
}

/// 좌상단 좌표를 모니터 안으로 밀어 넣는다(펫이 화면 밖으로 나가 사라지지 않게).
fn clamp(win: &tauri::Window, x: f64, y: f64, w: f64, h: f64) -> (f64, f64) {
    let Some((mx, my, mw, mh)) = monitor_bounds(win) else {
        return (x, y);
    };
    (
        x.min(mx + mw - w - EDGE).max(mx + EDGE),
        y.min(my + mh - h - EDGE).max(my + EDGE),
    )
}

/// 저장된 위치가 없을 때 앉힐 자리 — 화면 오른쪽 아래(Dock 위).
fn default_origin(win: &tauri::Window, w: f64, h: f64) -> (f64, f64) {
    match monitor_bounds(win) {
        Some((mx, my, mw, mh)) => (mx + mw - w - MARGIN, my + mh - h - DOCK_GAP),
        None => (MARGIN, MARGIN),
    }
}

/// 펫 창을 띄운다.
///
/// `center_x`/`bottom`(캐릭터 바닥 중앙, 논리 좌표)이 있으면 그 자리에, 없으면 화면 오른쪽
/// 아래에 앉힌다. `width`/`height` 는 **여백까지 포함한 창 크기**여야 한다
/// (프론트엔드 `petWindowSize()`) — 캐릭터 크기만 넘기면 첫 표시에서 위쪽이 잘린다.
///
/// 표시 직후 `pet:shown` 을 보낸다. 창을 다시 띄우면 내용 크기는 그대로여서 펫 창의
/// ResizeObserver 가 울리지 않으므로, 말풍선이 떠 있던 상태라면 여기서 정한 크기에 맞춰
/// 잘린 채로 남는다 — 이 신호를 받아 프론트엔드가 실제 크기를 다시 알려 준다.
///
/// 창을 띄우는 일은 Rust 가 한다 — 숨은 창의 웹뷰는 로드되지 않으므로 펫 창이 스스로
/// 자신을 띄울 수 없다.
#[tauri::command]
pub fn pet_show(
    app: tauri::AppHandle,
    width: f64,
    height: f64,
    center_x: Option<f64>,
    bottom: Option<f64>,
) -> Result<(), String> {
    let win = app.get_window(LABEL).ok_or("pet 창이 없습니다")?;
    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    let (x, y) = match (center_x, bottom) {
        (Some(cx), Some(b)) => (cx - width / 2.0, b - height),
        _ => default_origin(&win, width, height),
    };
    let (x, y) = clamp(&win, x, y, width, height);
    let _ = win.set_position(LogicalPosition::new(x, y));

    win.show().map_err(|e| e.to_string())?;
    // 창 생성 옵션만으로는 다른 Space 로 넘어갔을 때 유지되지 않으므로 띄울 때마다 다시 건다.
    let _ = win.set_always_on_top(true);
    let _ = win.set_visible_on_all_workspaces(true);
    let _ = win.emit("pet:shown", ());
    Ok(())
}

/// 펫 창을 숨긴다(설정 off, 또는 알림이 모두 정리됐을 때).
#[tauri::command]
pub fn pet_hide(app: tauri::AppHandle) {
    if let Some(win) = app.get_window(LABEL) {
        let _ = win.hide();
    }
}

/*
 * ── 알림 때만 잠깐 나타나기 ─────────────────────────────────────────────────
 *
 * 펫은 설정("상시 표시", `settings.pet.enabled`)에서 꺼 둘 수 있지만, 팝오버 창을 없앤
 * 뒤로는 펫이 리마인더·Claude Code 알림의 **유일한 창구**다. 꺼져 있다고 알림을 삼키면
 * 안 되므로, 알릴 것이 생기는 동안만 임시로 띄우고 정리되면 다시 숨긴다.
 *
 * 표시 여부를 왜 여기서 결정하지 않는가: 창 크기와 앵커 계산이 프론트엔드에 있다
 * (`petWindowSize()` / `readPetAnchor()`). 그래서 Rust 는 "알릴 게 있다/없다"만 들고
 * 메인 창의 PetController 에 알리고, 실제 `pet_show` / `pet_hide` 는 그쪽이 부른다
 * (표시 조건 = 상시 표시 || 알림). 펫 창 자신에게 물을 수 없는 이유는 숨은 창의 웹뷰가
 * 로드되지 않아 "알릴 게 생겼다"를 알아챌 주체가 될 수 없기 때문이다.
 */

/// 알림 출처. **출처별로 따로** 들어야 한다 — 하나의 bool 로 합치면 리마인더를 확인한
/// 순간 Claude 알림까지 꺼지고, herdr 감시 루프가 다음 tick 에 다시 켜면서 펫이 깜빡인다.
#[derive(Clone, Copy)]
pub enum AlertSource {
    /// Claude Code(herdr) 입력 대기·작업 완료 알림.
    Herdr,
    /// 사용자가 걸어 둔 리마인더.
    Reminder,
}

/// 알림 때문에 펫을 띄워 둬야 하는지(출처별). 설정의 "상시 표시"와는 별개의 축이다.
#[derive(Default)]
pub struct PetAlert(pub std::sync::Mutex<(bool, bool)>);

/// 한 출처의 알림 상태를 갱신하고, **합친 결과가 바뀌었을 때만** 메인 창에 알린다
/// (같은 값을 되풀어 보내면 PetController 의 effect 가 다시 돌아 창이 기본 크기로 되돌아간다).
pub fn set_alert(app: &tauri::AppHandle, source: AlertSource, active: bool) {
    let Some(state) = app.try_state::<PetAlert>() else {
        return;
    };
    let Ok(mut g) = state.0.lock() else {
        return;
    };
    let before = g.0 || g.1;
    match source {
        AlertSource::Herdr => g.0 = active,
        AlertSource::Reminder => g.1 = active,
    }
    let after = g.0 || g.1;
    if before == after {
        return;
    }
    // 창 제어는 메인 창만 한다 — 팝아웃 창까지 받으면 서로 위치를 되돌린다.
    let _ = app.emit_to("main", "pet:alert", after);
}

/// 현재 알림 상태. 메인 창이 마운트 시 한 번 조회한다(웹뷰 콜드 로드로 이벤트를 놓쳤을 때).
#[tauri::command]
pub fn pet_alert(app: tauri::AppHandle) -> bool {
    app.state::<PetAlert>()
        .0
        .lock()
        .map(|g| g.0 || g.1)
        .unwrap_or(false)
}

/// 트레이 메뉴의 "펫 표시/숨기기". 설정은 localStorage 에 있어 Rust 가 뒤집을 수 없으므로
/// 메인 창에 요청만 보낸다(`pet:toggle` → PetController 가 `setPet({ enabled })`).
pub fn request_toggle(app: &tauri::AppHandle) {
    let _ = app.emit_to("main", "pet:toggle", ());
}

/// 창을 내용 크기에 맞춘다. **바닥 중앙을 고정**하고 위·양옆으로만 자라므로
/// 말풍선이 붙거나 사라져도 캐릭터는 움직이지 않는다.
#[tauri::command]
pub fn pet_resize(window: tauri::Window, width: f64, height: f64) -> Result<(), String> {
    let (x, y, w, h) = logical_rect(&window).ok_or("창 좌표를 읽을 수 없습니다")?;
    let center_x = x + w / 2.0;
    let bottom = y + h;

    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    let (nx, ny) = clamp(&window, center_x - width / 2.0, bottom - height, width, height);
    window
        .set_position(LogicalPosition::new(nx, ny))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 마우스 이벤트를 통과시킨다(장식 모드). 켜면 펫이 뒤 창의 클릭을 막지 않지만,
/// 그 대가로 펫 자체를 클릭·드래그할 수도 없다.
#[tauri::command]
pub fn pet_set_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let win = app.get_window(LABEL).ok_or("pet 창이 없습니다")?;
    win.set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())
}

/// 지금 창의 바닥 중앙 좌표. 드래그로 옮긴 자리를 프론트엔드가 저장할 때 쓴다
/// (좌상단은 리사이즈로 계속 바뀌므로 저장 기준이 될 수 없다).
#[tauri::command]
pub fn pet_anchor(window: tauri::Window) -> Option<PetAnchor> {
    logical_rect(&window).map(|(x, y, w, h)| PetAnchor {
        center_x: x + w / 2.0,
        bottom: y + h,
    })
}

/// 직접 등록한 캐릭터 이미지의 최대 크기. 내용을 data URL 로 설정(localStorage)에 박아 두므로
/// 큰 파일을 그대로 받으면 저장 한도를 넘겨 설정 전체가 저장되지 않는다.
const MAX_IMAGE_BYTES: usize = 512 * 1024;

/// `~/` 를 홈 디렉터리로 펼친다.
fn expand_home(path: &str) -> String {
    match path.strip_prefix("~/") {
        Some(rest) => match std::env::var("HOME") {
            Ok(home) => format!("{home}/{rest}"),
            Err(_) => path.to_string(),
        },
        None => path.to_string(),
    }
}

/// 확장자 → MIME. 웹뷰가 그릴 수 있는 형식만 받는다.
fn image_mime(path: &str) -> Result<&'static str, String> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "svg" => Ok("image/svg+xml"),
        other => Err(format!(
            "지원하지 않는 형식입니다: .{other} (png·jpg·gif·webp·svg)"
        )),
    }
}

/// 이미지 파일을 읽어 data URL 로 돌려준다.
fn read_image_data_url(path: &str, max_bytes: usize) -> Result<String, String> {
    let mime = image_mime(path)?;
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "이미지가 너무 큽니다({}KB). {}KB 이하로 줄여 주세요.",
            bytes.len() / 1024,
            max_bytes / 1024
        ));
    }
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

/// 이미지 파일을 읽어 data URL 로 돌려준다(`species: "custom"` 용).
///
/// 경로가 아니라 내용을 저장하는 이유: 펫 창·메인 창이 각자 파일을 읽지 않아도 되고,
/// 원본 파일이 사라져도 펫이 빈 창이 되지 않는다(cowork 의 css 가져오기와 같은 방식).
#[tauri::command]
pub fn pet_read_image(path: String) -> Result<String, String> {
    read_image_data_url(&expand_home(&path), MAX_IMAGE_BYTES)
}

/*
 * ── 다이얼 뱃지에 쓸 안읽음 건수 ─────────────────────────────────────────────
 *
 * Slack·Gmail 폴링은 메인 창이 이미 돌린다(펫 창에 Provider 를 또 두면 폴링이 두 배가
 * 되고 연결 상태도 두 벌이 된다). 그 결과를 펫 창에 넘기는 통로가 필요한데, localStorage +
 * `storage` 이벤트로 하면 **창을 띄운 순서에 따라 값이 도착하지 않을 수 있다** —
 * 펫 창이 먼저 떠서 빈 값을 읽으면 그 뒤에 갱신을 받지 못한 채 0 으로 남는다.
 *
 * 그래서 herdr 알림과 **같은 방식**을 쓴다: 상태는 Rust 가 들고, 바뀌면 모든 창에 방출하고,
 * 웹뷰는 마운트 시 한 번 조회한다(콜드 로드로 이벤트를 놓쳐도 채워지도록).
 */

/// 메뉴 하나에 붙일 뱃지 숫자.
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetFeedItem {
    /// `menus.tsx` 의 메뉴 id.
    pub menu_id: String,
    pub count: u32,
}

/// 현재 뱃지 숫자들(메인 창이 갱신, 펫 창이 조회).
#[derive(Default)]
pub struct PetFeed(pub std::sync::Mutex<Vec<PetFeedItem>>);

/// 안읽음 건수를 갱신하고 모든 창에 알린다(메인 창의 PetFeedPublisher 가 호출).
#[tauri::command]
pub fn pet_set_feed(app: tauri::AppHandle, items: Vec<PetFeedItem>) {
    if let Ok(mut g) = app.state::<PetFeed>().0.lock() {
        *g = items.clone();
    }
    let _ = app.emit("pet:feed", items);
}

/// 현재 안읽음 건수. 펫 창이 마운트 시 한 번 조회한다(이벤트를 놓쳤을 때를 위해).
#[tauri::command]
pub fn pet_feed(app: tauri::AppHandle) -> Vec<PetFeedItem> {
    app.state::<PetFeed>()
        .0
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

/*
 * ── 알림 표시 시간 ──────────────────────────────────────────────────────────
 *
 * 이 값을 Rust 가 알아야 하는 이유: 상시 표시를 꺼 두면 펫은 알림이 있을 때만 잠깐 뜨는데,
 * 그 표시 시간을 정하는 쪽이 herdr 감시 루프(`present_until`)다. 프론트엔드의 말풍선
 * 유지 시간만 바꾸면 둘이 어긋나 같은 알림이 설정에 따라 7초/12초로 다르게 보인다
 * (실제로 그렇게 어긋나 있었다). 그래서 설정값을 메인 창이 여기로 밀어 넣고
 * 양쪽이 같은 값을 쓴다.
 */

/// 기본 표시 시간(초). 프론트엔드 기본값(`settings.pet.noticeSeconds`)과 같아야 한다.
const DEFAULT_NOTICE_SECS: u64 = 12;

/// 알림을 보여 줄 시간(초). **0 = 항상 표시**(사용자가 치울 때까지).
pub struct NoticeTtl(pub std::sync::Mutex<u64>);

impl Default for NoticeTtl {
    fn default() -> Self {
        NoticeTtl(std::sync::Mutex::new(DEFAULT_NOTICE_SECS))
    }
}

/// 설정의 알림 표시 시간을 Rust 에 반영한다(메인 창의 PetController 가 호출).
#[tauri::command]
pub fn pet_set_notice_ttl(app: tauri::AppHandle, seconds: u64) {
    if let Some(state) = app.try_state::<NoticeTtl>() {
        if let Ok(mut g) = state.0.lock() {
            *g = seconds;
        }
    }
}

/// 지금 설정된 표시 시간(초). 0 이면 시간으로 끊지 않는다.
pub fn notice_ttl_secs(app: &tauri::AppHandle) -> u64 {
    app.try_state::<NoticeTtl>()
        .and_then(|s| s.0.lock().ok().map(|g| *g))
        .unwrap_or(DEFAULT_NOTICE_SECS)
}

/// 펫을 눌렀을 때 메인 창을 띄우고 지정한 메뉴를 열게 한다.
///
/// 왜 Rust 를 거치나: 메뉴 탭을 여는 상태(`useOpenTabs`)는 메인 창에만 있으므로 펫 창이
/// 직접 열 수 없다. 창을 앞으로 가져오는 일도 어차피 Rust 몫이라 한 번에 처리한다 —
/// 메인 창의 App.tsx 가 `pet:open-menu` 를 듣고 그 메뉴 탭을 연다.
#[tauri::command]
pub fn pet_open_menu(app: tauri::AppHandle, menu_id: String) -> Result<(), String> {
    crate::present_main(&app);
    // 메인 창에만 보낸다 — 팝아웃 창까지 받으면 엉뚱한 창이 탭을 열려고 한다.
    app.emit_to("main", "pet:open-menu", menu_id)
        .map_err(|e| e.to_string())
}

/// 동작별 애니메이션 이미지의 최대 크기.
///
/// `pet_read_image`(512KB)보다 훨씬 큰 이유: 움직이는 GIF·WebP 는 프레임이 여러 장이라
/// 수 MB 가 흔하고, 이쪽은 내용을 설정에 저장하지 않고 **경로만** 두기 때문에
/// localStorage 한도와 무관하다(펫 창이 그때그때 읽어 메모리에 든다).
const MAX_ANIM_BYTES: usize = 8 * 1024 * 1024;

/// 동작별 애니메이션 이미지를 읽어 data URL 로 돌려준다(`species: "anim"` 용).
///
/// 움직임은 우리가 만들지 않는다 — GIF·APNG·애니메이션 WebP 는 웹뷰가 `<img>` 에서
/// 알아서 재생하므로, 프레임 계산도 타이머도 필요 없다.
#[tauri::command]
pub fn pet_read_anim(path: String) -> Result<String, String> {
    read_image_data_url(&expand_home(&path), MAX_ANIM_BYTES)
}

/*
 * ── Petdex / Codex 펫 패키지 ────────────────────────────────────────────────
 *
 * 손으로 그린 SVG 로는 일러스트 품질의 캐릭터가 안 나온다. 다행히 Codex 펫 생태계
 * (petdex.dev)가 공개 규격을 쓴다: 폴더 하나에 `pet.json` + 스프라이트시트,
 * 시트는 **8열 × 9행 = 72프레임**이고 행이 상태(idle·wave·run·failed·review·jump·…)다.
 * 그 규격을 그대로 읽어 쓰면 이미 만들어진 캐릭터를 그대로 쓸 수 있다.
 *
 * 내려받기는 하지 않는다 — 사용자가 `npx petdex install <slug>` 로 받으면
 * `~/.petdex/pets/<slug>/` 에 놓이고, 우리는 그 폴더를 읽기만 한다. 펫 그림은
 * 제출자들의 팬아트라 앱이 재배포에 끼어들 이유가 없다.
 */

/// petdex CLI 가 패키지를 설치하는 위치.
const PETDEX_DIR: &str = "~/.petdex/pets";

/// 스프라이트시트 최대 크기. 캐릭터 이미지(`custom`)와 달리 설정에 저장하지 않고
/// 펫 창이 메모리에 들고 있을 뿐이라 훨씬 넉넉하게 잡는다(실제 시트가 ~2MB).
const MAX_SHEET_BYTES: usize = 8 * 1024 * 1024;

/// 설치된 펫 패키지 하나. 설정에는 `dir` 를 저장한다(슬러그는 폴더명과 다를 수 있다).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetPackage {
    pub slug: String,
    pub name: String,
    pub description: String,
    pub dir: String,
}

/// 스프라이트시트를 실을 응답.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSheet {
    pub slug: String,
    pub name: String,
    /// 스프라이트시트 data URL.
    pub sheet: String,
}

/// `pet.json` 에서 우리가 쓰는 필드만 꺼낸다. 규격이 최소(id·displayName·description·
/// spritesheetPath)라서 없는 값은 폴더명·기본 파일명으로 메꾼다.
fn read_pet_json(dir: &std::path::Path) -> Option<(String, String, String, String)> {
    let raw = std::fs::read_to_string(dir.join("pet.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let folder = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("pet")
        .to_string();
    let slug = v
        .get("id")
        .or_else(|| v.get("slug"))
        .and_then(|x| x.as_str())
        .unwrap_or(&folder)
        .to_string();
    let name = v
        .get("displayName")
        .or_else(|| v.get("name"))
        .and_then(|x| x.as_str())
        .unwrap_or(&slug)
        .to_string();
    let description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let sheet = v
        .get("spritesheetPath")
        .and_then(|x| x.as_str())
        .unwrap_or("spritesheet.webp")
        .to_string();
    Some((slug, name, description, sheet))
}

/// 설치된 펫 패키지 목록. `~/.petdex/pets/*/pet.json` 을 훑는다.
/// 폴더가 없으면(=petdex 를 안 썼으면) 빈 목록 — 오류가 아니다.
#[tauri::command]
pub fn pet_list_packages() -> Vec<PetPackage> {
    let root = std::path::PathBuf::from(expand_home(PETDEX_DIR));
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out: Vec<PetPackage> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let dir = e.path();
            let (slug, name, description, _) = read_pet_json(&dir)?;
            Some(PetPackage {
                slug,
                name,
                description,
                dir: dir.to_string_lossy().to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// 패키지 폴더에서 스프라이트시트를 읽어 data URL 로 돌려준다.
///
/// 프레임 격자(열·행)는 여기서 계산하지 않는다 — 규격이 8×9 로 고정이고, 실제로 몇
/// 프레임이 채워져 있는지는 프론트엔드가 캔버스로 알파를 훑어 알아낸다(빈 프레임에서
/// 캐릭터가 사라지지 않도록). Rust 는 파일만 넘긴다.
#[tauri::command]
pub fn pet_read_package(dir: String) -> Result<PetSheet, String> {
    let dir_path = std::path::PathBuf::from(expand_home(&dir));
    let (slug, name, _, sheet_name) =
        read_pet_json(&dir_path).ok_or_else(|| format!("{dir}: pet.json 을 읽을 수 없습니다"))?;

    // pet.json 이 가리키는 파일이 없으면 폴더에서 이미지 하나를 찾아 쓴다
    // (규격은 spritesheet.webp 지만 .png 로 받은 패키지도 있다).
    let mut path = dir_path.join(&sheet_name);
    if !path.is_file() {
        path = std::fs::read_dir(&dir_path)
            .ok()
            .and_then(|entries| {
                entries.flatten().map(|e| e.path()).find(|p| {
                    p.is_file() && image_mime(&p.to_string_lossy()).is_ok()
                })
            })
            .ok_or_else(|| format!("{dir}: 스프라이트시트를 찾을 수 없습니다"))?;
    }

    let sheet = read_image_data_url(&path.to_string_lossy(), MAX_SHEET_BYTES)?;
    Ok(PetSheet { slug, name, sheet })
}
