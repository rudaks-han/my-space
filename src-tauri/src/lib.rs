mod cc_history;
mod chrome_cookies;
mod claude_usage;
mod cowork;
mod es;
mod flex;
mod gcal;
mod gdrive;
mod gmail;
mod herdr;
mod intellij;
mod jira;
mod kafka;
mod mcp;
mod pet;
mod reminder;
mod slack;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WindowEvent};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

/// 임베드 브라우저 탭 웹뷰의 라벨 접두사. 이 접두사로 만든 웹뷰는
/// external-navigation 플러그인이 시스템 브라우저로 가로채지 않고 내부에서 이동한다.
const BROWSER_PREFIX: &str = "browser-tab-";

/// 메뉴를 새 창으로 띄울 때 쓰는 창 라벨 접두사(`view-<메뉴 id>`).
/// 프론트엔드의 `src/lib/window-role.ts` VIEW_WINDOW_PREFIX 와 같아야 한다.
const VIEW_WINDOW_PREFIX: &str = "view-";

/// 로그인 항목(자동 실행)으로 켜졌을 때 붙는 실행 인자.
/// `tauri_plugin_autostart::init` 에 넘기는 값과 같아야 한다 — 이 인자가 있으면
/// 메인 창을 띄우지 않고 트레이에만 올린다(부팅할 때마다 창이 튀어나오지 않게).
const AUTOSTART_FLAG: &str = "--autostart";

/// 이번 실행이 로그인 항목에서 시작된 것인지. 인자는 실행 중 바뀌지 않으므로 한 번만 읽는다.
fn launched_at_login() -> bool {
    static AT_LOGIN: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AT_LOGIN.get_or_init(|| std::env::args().any(|a| a == AUTOSTART_FLAG))
}

/// 모든 브라우저 탭이 공유하는 영속 데이터 저장소 식별자(고정 UUID).
/// macOS(WKWebView)는 이 식별자가 있으면 `dataStoreForIdentifier` 로 안정된 위치에
/// 쿠키·localStorage·세션을 저장하므로, 앱을 재시작해도 로그인 상태가 유지된다
/// (식별자가 없으면 defaultDataStore 를 쓰는데, dev 실행 등에서 위치가 불안정해 세션이 날아간다).
/// 모든 탭이 같은 값을 써서 하나의 브라우저 프로필처럼 쿠키를 공유한다.
/// ⚠️ 이 값을 바꾸면 기존 저장 데이터(로그인 등)에 접근할 수 없게 되므로 변경 금지.
const BROWSER_DATA_STORE_ID: [u8; 16] = [
    0x9a, 0x1c, 0x7e, 0x42, 0x3b, 0x88, 0x4d, 0x5f, 0xa1, 0x02, 0xe6, 0x7c, 0x33, 0x9b, 0xd4, 0x10,
];

/// 브라우저 탭이 이동할 때 프론트엔드(주소창·탭 제목)에 알리는 이벤트 페이로드.
#[derive(Clone, Serialize)]
struct NavigatedPayload {
    label: String,
    url: String,
}

/// 각 탭 웹뷰에 주입하는 스크립트.
/// 외부 사이트에는 Tauri IPC 가 주입되지 않으므로, `window.open` 과 `target="_blank"` 클릭을
/// 가로채 숨은 iframe + 커스텀 스킴(`tauri-newtab://`)으로 URL 을 전달한다.
/// Rust 의 on_navigation 이 그 스킴을 잡아 프론트엔드에 새 탭 이벤트를 방출한다.
const NEW_TAB_SCRIPT: &str = r#"
(function () {
  function requestNewTab(url) {
    if (!url) return;
    var abs = url;
    try { abs = new URL(url, location.href).href; } catch (e) {}
    if (!/^https?:/i.test(abs)) return;
    try {
      var f = document.createElement('iframe');
      f.style.display = 'none';
      f.src = 'tauri-newtab://open/?url=' + encodeURIComponent(abs);
      (document.documentElement || document.body || document).appendChild(f);
      setTimeout(function () { try { f.parentNode.removeChild(f); } catch (e) {} }, 0);
    } catch (e) {}
  }
  window.open = function (url) {
    if (url) requestNewTab(url);
    // 페이지가 반환값(창 핸들)을 써도 에러 안 나도록 더미 객체 반환
    return {
      closed: false, close: function () {}, focus: function () {}, blur: function () {},
      postMessage: function () {}, location: {},
      document: { write: function () {}, writeln: function () {}, close: function () {} }
    };
  };
  document.addEventListener('click', function (e) {
    try {
      var t = e.target;
      var a = t && t.closest ? t.closest('a[target="_blank"], a[target="_new"]') : null;
      if (a && a.href) { e.preventDefault(); e.stopPropagation(); requestNewTab(a.href); }
    } catch (e2) {}
  }, true);
})();
"#;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 메인 창을 표시·포커스한다(트레이/커맨드 공용 헬퍼).
/// pet.rs 의 `pet_open_menu` 도 이걸 쓴다(펫을 눌러 특정 메뉴를 열 때).
pub(crate) fn present_main(app: &tauri::AppHandle) {
    // 메인 창은 브라우저 탭용 자식 웹뷰를 담는 멀티웹뷰 창이라
    // get_webview_window(1:1 웹뷰 창만 반환)에는 잡히지 않는다 → get_window 을 쓴다.
    if let Some(main) = app.get_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

/// 메인 창을 숨겨 트레이(메뉴바 아이콘)로 최소화한다. 트레이 아이콘은 항상 떠 있어
/// 언제든 다시 열 수 있다.
#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_window("main") {
        main.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 트레이/팝오버에서 메인 창을 다시 연다.
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    present_main(&app);
    Ok(())
}

/// 앱을 완전히 종료한다(트레이 메뉴의 종료에서 호출).
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 메뉴 하나를 독립 창으로 띄운다(뷰 헤더의 "새 창으로 열기").
///
/// 창 라벨은 `view-<메뉴 id>` 이고, 프론트엔드는 `?view=<메뉴 id>` 로 어떤 화면을 그릴지 안다
/// (main.tsx → ViewWindowRoot). 이미 열려 있으면 새로 만들지 않고 앞으로 가져온다.
/// 라벨 접두사는 capabilities/default.json 의 `view-*` 와 window-role.ts 의
/// VIEW_WINDOW_PREFIX 와 맞물려 있으므로 함께 바꿔야 한다.
#[tauri::command]
fn open_view_window(app: tauri::AppHandle, id: String, title: String) -> Result<(), String> {
    // 창 라벨에는 영숫자·`-`·`_` 만 쓴다(Tauri 제약). 메뉴 id 는 케밥케이스지만 방어적으로 치환한다.
    let slug: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let label = format!("{VIEW_WINDOW_PREFIX}{slug}");

    if let Some(existing) = app.get_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = WebviewUrl::App(format!("index.html?view={slug}").into());
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, url)
        .title(format!("{title} — My Space"))
        .inner_size(1100.0, 820.0)
        .min_inner_size(520.0, 400.0)
        // 첫 프레임의 흰 깜빡임을 피해 페이지 로드가 끝난 뒤(on_page_load) 보여 준다.
        .visible(false);
    // 메인 창과 같은 오버레이 타이틀바 — 뷰 헤더가 창 맨 위까지 올라가고 좌측 78px 는 신호등 자리.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// 브라우저 탭 웹뷰를 열거나(없으면 생성) 지정한 위치·크기로 이동시킨다(있으면 재배치=표시).
/// 이미 존재하면 재이동만 하므로(navigate 안 함) 탭 전환·리사이즈 시 페이지가 다시 로드되지 않는다.
///
/// 자식 웹뷰는 **호출한 창**에 붙인다 — 메뉴를 새 창으로 띄우면(`view-*`) 그 창에 붙어야
/// 좌표가 맞는다. 라벨은 프론트엔드가 창별로 구분해 넘긴다(window-role.ts 의 browserLabel).
#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    window: tauri::Window,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let parsed: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
    // window.open / target="_blank" 로 새 창을 요청하면(예: daum 메일에서 메일 클릭)
    // 별도 OS 창을 만들지 않고 새 탭으로 열도록:
    //  1) on_new_window: 임베드 자식 웹뷰에선 안 불릴 수 있으나 폴백으로 둔다.
    //  2) NEW_TAB_SCRIPT 주입: window.open/target=_blank 를 가로채 tauri-newtab:// 로 전달 (주 경로).
    let app_for_new_window = app.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        // 고정 식별자의 영속 저장소를 써서 재시작 후에도 쿠키·로그인 세션을 유지한다(macOS 14+/iOS 17+).
        .data_store_identifier(BROWSER_DATA_STORE_ID)
        .initialization_script(NEW_TAB_SCRIPT)
        .on_new_window(move |target_url, _features| {
            log::info!("on_new_window → new tab: {}", target_url);
            let _ = app_for_new_window.emit("browser:new-tab", target_url.to_string());
            tauri::webview::NewWindowResponse::Deny
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;
    enable_back_forward_gestures(&webview);
    Ok(())
}

/// 크롬처럼 트랙패드 두 손가락 좌우 스와이프로 뒤로/앞으로 가기를 켠다.
/// Tauri 는 이 옵션을 노출하지 않으므로 네이티브 WKWebView 핸들에 직접 호출한다.
// `objc` 크레이트의 msg_send! 매크로가 최신 Rust 의 unexpected_cfgs 린트를 건드려
// 무해한 경고를 내므로 이 함수에 한해 억제한다.
#[allow(unexpected_cfgs)]
fn enable_back_forward_gestures<R: tauri::Runtime>(webview: &tauri::webview::Webview<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = webview.with_webview(|platform_webview| {
            use objc::{msg_send, sel, sel_impl};
            let wk = platform_webview.inner() as *mut objc::runtime::Object;
            unsafe {
                let _: () = msg_send![wk, setAllowsBackForwardNavigationGestures: true];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
    }
}

/// 주소창 입력 등 명시적 이동. 존재하는 탭 웹뷰를 해당 URL로 이동시킨다.
#[tauri::command]
fn browser_navigate(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    let parsed: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
    webview.navigate(parsed).map_err(|e| e.to_string())?;
    Ok(())
}

/// 리사이즈·사이드바 토글 등으로 표시 영역이 바뀌었을 때 위치·크기만 갱신한다.
#[tauri::command]
fn browser_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 탭을 숨긴다. 임베드 웹뷰는 창 영역 밖으로 이동시켜 화면에서 가린다
/// (다른 메뉴로 전환하거나 비활성 탭일 때 사용 — 웹뷰 자체는 살아 있어 상태가 유지된다).
#[tauri::command]
fn browser_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(LogicalPosition::new(0.0, 1_000_000.0))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 탭을 닫고 웹뷰를 파기한다.
#[tauri::command]
fn browser_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 뒤로 가기.
#[tauri::command]
fn browser_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    webview
        .eval("window.history.back()")
        .map_err(|e| e.to_string())
}

/// 앞으로 가기.
#[tauri::command]
fn browser_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    webview
        .eval("window.history.forward()")
        .map_err(|e| e.to_string())
}

/// 새로고침.
#[tauri::command]
fn browser_reload(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    webview
        .eval("window.location.reload()")
        .map_err(|e| e.to_string())
}

/// 활성 탭 웹뷰의 개발자도구를 토글한다.
/// (Cargo.toml 에서 tauri 의 `devtools` 기능을 켜두어 릴리스에서도 사용 가능)
#[tauri::command]
fn browser_devtools(app: tauri::AppHandle, label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "webview not found".to_string())?;
    if webview.is_devtools_open() {
        webview.close_devtools();
    } else {
        webview.open_devtools();
    }
    Ok(())
}

fn external_navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("external-navigation")
        .on_navigation(|webview, url| {
            // 임베드 브라우저 탭은 앱 내부에서 이동해야 하므로 가로채지 않고 그대로 허용한다.
            // 주소창 동기화는 여기서 하지 않는다 — on_navigation 은 iframe/서브프레임 이동까지
            // 모두 불려서 daum 처럼 iframe 많은 페이지에선 about:blank 등이 섞여 들어온다.
            // 대신 메인 프레임 전용인 on_page_load 에서 최종 URL 을 방출한다.
            if webview.label().starts_with(BROWSER_PREFIX) {
                // 주입 스크립트가 새 탭 요청을 이 커스텀 스킴으로 보낸다. 잡아서 새 탭 이벤트 방출 후 취소.
                if url.scheme() == "tauri-newtab" {
                    if let Some((_, target)) = url.query_pairs().find(|(k, _)| k == "url") {
                        log::info!("new tab requested via script: {}", target);
                        let _ = webview
                            .app_handle()
                            .emit("browser:new-tab", target.to_string());
                    }
                    return false;
                }
                return true;
            }

            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );

            let is_internal = url.scheme() == "tauri" || is_internal_host;

            if is_internal {
                return true;
            }

            let is_external_link = matches!(url.scheme(), "http" | "https" | "mailto" | "tel");

            if is_external_link {
                log::info!("opening external link in system browser: {}", url);
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }

            true
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                // HTTP 스택(reqwest/hyper 등)의 DEBUG·TRACE 노이즈("starting new
                // connection", "shouldn't retry!" 등)를 걸러 Slack 폴링 로그가 넘치지 않게 한다.
                .level_for("reqwest", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("hyper_util", log::LevelFilter::Warn)
                .level_for("h2", log::LevelFilter::Warn)
                .level_for("rustls", log::LevelFilter::Warn)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        // 로그인 시 자동 실행. macOS 는 LaunchAgent(플리스트) 방식을 쓴다 — AppleScript 방식은
        // "System Events 제어" 권한 프롬프트를 띄우므로 쓰지 않는다.
        // 등록되는 실행 인자에 AUTOSTART_FLAG 를 넣어, 부팅으로 켜졌는지 프로세스가 알 수 있게 한다.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_FLAG]),
        ))
        .plugin(external_navigation_plugin())
        .manage(herdr::WatchState::default())
        .manage(herdr::PendingQuestions::default())
        .manage(herdr::Notices::default())
        .manage(reminder::PendingReminder::default())
        .manage(pet::PetFeed::default())
        .manage(pet::PetAlert::default())
        .manage(pet::NoticeTtl::default())
        .manage(intellij::ServiceState::default())
        .manage(intellij::RunTracking::default())
        .manage(intellij::WatchProject::default())
        .manage(intellij::SequenceState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            minimize_to_tray,
            show_main_window,
            quit_app,
            pet::pet_show,
            pet::pet_hide,
            pet::pet_alert,
            pet::pet_resize,
            pet::pet_set_click_through,
            pet::pet_anchor,
            pet::pet_read_image,
            pet::pet_read_anim,
            pet::pet_open_menu,
            pet::pet_set_notice_ttl,
            pet::pet_set_feed,
            pet::pet_feed,
            pet::pet_list_packages,
            pet::pet_read_package,
            open_view_window,
            browser_open,
            browser_navigate,
            browser_set_bounds,
            browser_hide,
            browser_close,
            browser_back,
            browser_forward,
            browser_reload,
            browser_devtools,
            slack::slack_save_token,
            slack::slack_status,
            slack::slack_disconnect,
            slack::slack_channels,
            slack::slack_get_selected,
            slack::slack_set_selected,
            slack::slack_unreads,
            slack::slack_open_message,
            gcal::gcal_status,
            gcal::gcal_disconnect,
            gcal::gcal_start_auth,
            gcal::gcal_today,
            gcal::gcal_upcoming,
            gcal::gcal_calendars,
            gcal::gcal_calendar_events,
            gcal::gcal_book_room,
            gcal::gcal_people,
            gcal::gcal_person_events,
            flex::flex_coworkers,
            flex::flex_primary,
            flex::flex_events,
            flex::flex_status,
            flex::flex_save_account,
            flex::flex_clear_account,
            flex::flex_login_now,
            flex::flex_open_time_off,
            gdrive::gdrive_status,
            gdrive::gdrive_disconnect,
            gdrive::gdrive_start_auth,
            gdrive::gdrive_recent,
            gdrive::gdrive_folders,
            gdrive::gdrive_list,
            gmail::gmail_status,
            gmail::gmail_disconnect,
            gmail::gmail_start_auth,
            gmail::gmail_messages,
            gmail::gmail_message_body,
            gmail::gmail_mark_read,
            gmail::gmail_unread_count,
            jira::jira_save_config,
            jira::jira_status,
            jira::jira_disconnect,
            jira::jira_my_issues,
            jira::jira_issue_detail,
            jira::jira_open_issue,
            herdr::herdr_list_agents,
            herdr::herdr_list_workspaces,
            herdr::herdr_focus_workspace,
            herdr::herdr_send_prompt,
            herdr::herdr_read_pane,
            herdr::herdr_read_question,
            herdr::herdr_focus_pane,
            herdr::herdr_current_questions,
            herdr::herdr_notify,
            herdr::herdr_current_notices,
            herdr::herdr_dismiss_notice,
            herdr::herdr_start_watch,
            herdr::herdr_stop_watch,
            reminder::reminder_fire,
            reminder::reminder_current,
            reminder::reminder_dismiss,
            reminder::reminder_snooze,
            intellij::intellij_list_services,
            intellij::intellij_recent_projects,
            intellij::intellij_start_service,
            intellij::intellij_stop_service,
            intellij::intellij_restart_service,
            intellij::intellij_running,
            intellij::intellij_watch_project,
            intellij::intellij_start_sequence,
            intellij::intellij_cancel_sequence,
            intellij::intellij_sequence_status,
            intellij::intellij_mcp_status,
            intellij::intellij_logs,
            intellij::intellij_clear_logs,
            intellij::intellij_enable_log_sync,
            cowork::cowork_list_specs,
            cowork::cowork_read_spec_file,
            cowork::cowork_search_specs,
            cowork::cowork_read_css,
            es::es_request,
            kafka::kafka_connect,
            kafka::kafka_disconnect,
            kafka::kafka_topics,
            kafka::kafka_partitions,
            kafka::kafka_topic_configs,
            kafka::kafka_fetch,
            kafka::kafka_groups,
            kafka::kafka_group_offsets,
            kafka::kafka_produce,
            claude_usage::claude_usage,
            cc_history::cc_history_projects,
            cc_history::cc_history_sessions,
            cc_history::cc_history_messages
        ])
        .setup(|app| {
            // 메뉴바(작업표시줄) 트레이 아이콘. 클릭하면 바로 앱을 열지 않고 메뉴를 띄운다:
            //   - My Space 열기: 메인 창 표시
            //   - 펫 표시/숨기기: 알림 창구인 데스크톱 펫을 켜고 끈다(설정의 "상시 표시"를 뒤집는다)
            //   - 종료
            let open_i = MenuItemBuilder::with_id("open", "My Space 열기").build(app)?;
            let pet_i = MenuItemBuilder::with_id("pet", "펫 표시/숨기기").build(app)?;
            let quit_i = MenuItemBuilder::with_id("quit", "종료").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open_i, &pet_i, &quit_i])
                .build()?;
            let mut builder = TrayIconBuilder::with_id("main-tray")
                .tooltip("My Space")
                .menu(&menu)
                // 좌클릭에도 메뉴를 띄운다(바로 앱 열지 않음).
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => present_main(app),
                    "pet" => pet::request_toggle(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                builder = builder.icon(icon.clone());
            }
            builder.build(app)?;

            // herdr blocked 감시를 부팅 시 시작한다(펫이 메인 창 없이도
            // 질문·알림을 띄울 수 있도록). 단, 설정에서 껐으면(~/.myspace/watch-disabled 존재)
            // 자동 시작하지 않아 "꺼짐"이 재시작 후에도 유지된다.
            if !herdr::watch_disabled() {
                herdr::herdr_start_watch(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 메인 창의 닫기(빨간 X)는 앱을 종료하지 않고 트레이로 최소화한다.
            // 완전 종료는 ⌘Q 또는 트레이 메뉴의 종료(quit_app)로만 이뤄진다.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .on_page_load(|webview, payload| {
            let label = webview.label();

            // 메인 창과 "새 창으로 열기"로 띄운 뷰 창은 숨긴 채로 만들고(흰 깜빡임 방지)
            // 페이지 로드가 끝나면 보여 준다.
            if (label == "main" || label.starts_with(VIEW_WINDOW_PREFIX))
                && matches!(payload.event(), PageLoadEvent::Finished)
            {
                log::info!("{label} webview finished loading");
                // 로그인 항목으로 켜진 첫 실행에서는 메인 창을 띄우지 않고 트레이에만 올린다.
                // 웹뷰는 (숨은 채로) 이미 로드됐으므로 감시·알림·펫은 그대로 돌고,
                // 트레이 메뉴의 "My Space 열기"(present_main)로 언제든 꺼낼 수 있다.
                if label == "main" && launched_at_login() {
                    log::info!("자동 실행(--autostart)이라 메인 창을 숨긴 채로 시작합니다");
                    return;
                }
                let _ = webview.window().show();
                return;
            }

            // 브라우저 탭: 메인 프레임 로드 시작/완료 시 최종 URL 을 주소창·탭 제목에 반영.
            // on_page_load 는 메인 프레임(WKNavigationDelegate)만 트리거되므로 iframe 노이즈가 없다.
            if label.starts_with(BROWSER_PREFIX) {
                // 임베드 웹뷰가 실제로 어디로 갔는지 남긴다 — 로그인 리다이렉트처럼
                // "왜 이 화면이 뜨지" 하는 상황을 로그만 보고 판별할 수 있게.
                log::info!("{label} → {}", payload.url());
                let _ = webview.app_handle().emit(
                    "browser:navigated",
                    NavigatedPayload {
                        label: label.to_string(),
                        url: payload.url().to_string(),
                    },
                );
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
