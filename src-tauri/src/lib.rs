mod auth;
mod cc_history;
mod claude_usage;
mod cowork;
mod es;
mod flex;
mod gcal;
mod gdrive;
mod gmail;
mod cmux;
mod herdr;
mod intellij;
mod jira;
mod kafka;
mod markdown;
mod mcp;
mod orca;
mod pet;
mod reminder;
mod screenshare;
mod slack;
mod standalone;

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

/// 메모리를 회수할 때 탭 웹뷰를 갈아치울 빈 페이지.
/// `browser_open` 이 "비워 둔 웹뷰"를 알아보는 표식이기도 하다.
const BLANK_URL: &str = "about:blank";

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
        // 위치를 먼저 잡은 뒤 보이게 한다(반대로 하면 이전 위치가 한 프레임 비친다).
        set_webview_hidden(&webview, false);
        // 메모리 회수로 비워 둔(`browser_discard`) 탭이면 원래 주소를 다시 불러온다.
        // 프론트엔드가 이를 기억할 필요가 없도록 여기서 판단한다.
        let was_discarded = discarded_labels()
            .lock()
            .map(|mut set| set.remove(&label))
            .unwrap_or(false);
        if was_discarded {
            log::info!("회수됐던 탭 되살리기 → {label} → {url}");
            let parsed: tauri::Url = url.parse().map_err(|_| "invalid url".to_string())?;
            webview.navigate(parsed).map_err(|e| e.to_string())?;
        }
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

/// 탭 웹뷰의 `WebContent` 프로세스를 끝내 그 페이지가 쥐고 있던 메모리를 통째로 돌려받는다.
/// 웹뷰 껍데기는 그대로 남아 다시 로드하면 되살아난다(크롬의 탭 메모리 해제와 같은 동작).
///
/// **프로세스를 끝내는 것 말고는 메모리를 되찾는 방법이 없다.** 실측으로 다음이 전부 실패했다
/// (daum.net 기준 RSS 370~380MB): `about:blank` 로 이동해도 그대로, `location.replace` 로
/// bfcache 를 남기지 않아도 그대로, WKWebView 를 완전히 해제(`removeFromSuperview` + nil)해도
/// 프로세스가 살아남아 그대로였다. WebKit 이 `WebContent` 를 프로세스 캐시에 붙들고, 그
/// 프로세스는 한 번 잡은 메모리를 OS 에 반환하지 않기 때문이다.
///
/// **`_killWebContentProcessAndResetState` 로는 안 된다 — 시도했고 실패했다.** macOS 26
/// (Darwin 25) 실측에서 그 비공개 셀렉터는 `respondsToSelector:` 가 `true` 를 주고 전송도
/// 되는데 프로세스가 멀쩡히 살아 있었다(RSS 무변화, wry 의 "web content process terminated"
/// 로그도 없음). 런루프 타이머(`performSelector:…afterDelay:`)로 미루는 방법은 그보다 더
/// 확실하게 안 되는데, 그 API 는 *호출한 스레드의* 런루프에 타이머를 얹고 이 함수는 런루프가
/// 없는 Tauri 커맨드 스레드에서 불리기 때문이다 — 예약만 성공하고 셀렉터는 영영 실행되지
/// 않는다. GCD 메인 큐로 넘기는 방법도 블록 자체가 실행되지 않았다.
///
/// 그래서 셀렉터를 쓰지 않고 **`_webProcessIdentifier` 로 렌더러 pid 를 읽어 직접 끝낸다.**
/// 읽기 전용 getter 라 중첩 런루프도, 데드락도 없다. 렌더러 프로세스가 죽는 것은 WebKit 이
/// 정상 처리하는 상황이라(Safari 의 "이 웹페이지를 다시 불러옵니다"와 같다) 앱은 영향받지
/// 않고, 다시 열 때 `browser_open` 이 저장된 주소로 새 프로세스를 띄운다.
///
/// 이것도 비공개 API 이므로 `respondsToSelector:` 로 확인하고 쓴다 — 없으면 아무 일도 하지
/// 않는다(메모리를 못 돌려받을 뿐 동작은 그대로).
#[allow(unexpected_cfgs)]
fn kill_web_content<R: tauri::Runtime>(webview: &tauri::webview::Webview<R>) {
    #[cfg(target_os = "macos")]
    {
        let label = webview.label().to_string();
        let res = webview.with_webview(move |platform_webview| {
            use objc::{msg_send, sel, sel_impl};
            let wk = platform_webview.inner() as *mut objc::runtime::Object;
            unsafe {
                let selector = sel!(_webProcessIdentifier);
                let responds: bool = msg_send![wk, respondsToSelector: selector];
                if !responds {
                    log::warn!("_webProcessIdentifier 없음 — 메모리 회수를 건너뜁니다");
                    return;
                }
                let pid: i32 = msg_send![wk, _webProcessIdentifier];
                if pid <= 0 {
                    // 이미 회수된 탭(프로세스 없음)에 다시 회수가 온 경우다.
                    log::info!("WebContent 프로세스가 이미 없음 — 건너뜁니다");
                    return;
                }
                // **SIGKILL 을 보내기 전에** 표식을 남긴다. 순서가 뒤집히면 종료 훅이 먼저
                // 돌아 페이지를 자동 새로고침해 버려(`with_process_terminate_hook` 참고)
                // 회수한 메모리가 그대로 되살아난다.
                if let Ok(mut set) = killed_labels().lock() {
                    set.insert(label);
                }
                // 이 클로저는 tao 이벤트 루프 콜백 안에서 돌기 때문에 여기서 기다리지 않는다.
                std::thread::spawn(move || {
                    if libc::kill(pid, libc::SIGKILL) == 0 {
                        log::info!("WebContent 프로세스 종료 pid={pid}");
                    } else {
                        log::warn!("WebContent 프로세스 종료 실패 pid={pid}");
                    }
                });
            }
        });
        if let Err(e) = res {
            log::warn!("with_webview 실패 — 메모리 회수 못 함: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
    }
}

/// 프로세스를 죽여 비워 둔 탭들(`browser_discard`). `browser_open` 이 이 목록을 보고
/// 원래 주소를 다시 불러온다 — 프로세스를 죽이면 웹뷰의 URL 도 초기화되므로, 무엇을 되살려야
/// 하는지 웹뷰에게 물어볼 수 없어 따로 기억한다.
fn discarded_labels() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static DISCARDED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    DISCARDED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// 우리가 **일부러** `WebContent` 프로세스를 죽인 웹뷰들. 종료 훅
/// (`with_process_terminate_hook`)이 이 표식을 보고 자동 새로고침을 건너뛴다 —
/// 확인하면서 지우므로 한 번만 쓰인다(다음 번 진짜 크래시는 정상적으로 되살아난다).
fn killed_labels() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static KILLED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    KILLED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// `WebContent` 프로세스가 끝났을 때 무엇을 할지 앱 차원에서 정한다.
///
/// **이 훅을 달지 않으면 회수가 통째로 무효가 된다.** tauri-runtime-wry 는 훅이 없을 때
/// 기본 핸들러를 심는데, 그 핸들러가 하는 일이 `webview.reload()` 다. 그래서
/// `kill_web_content` 로 프로세스를 끝내는 순간 tauri 가 같은 페이지를 새 프로세스로 다시
/// 실었다 — 실측 로그가 `WebContent 프로세스 종료 pid=…` 바로 다음 줄에 wry 의
/// `webview reloaded` 와 원래 URL 재로드를 남겼고, 메모리는 제자리로 돌아왔다.
///
/// 그래서 훅을 직접 단다. 일부러 죽인 웹뷰(`killed_labels`)는 되살리지 않고 — 다시 볼 때
/// `browser_open` 이 저장된 주소로 띄운다 — 진짜 크래시만 예전 기본 동작대로 새로고침한다.
///
/// macOS/iOS 전용 API 라 다른 OS 에서는 빌더를 그대로 돌려준다.
fn with_process_terminate_hook<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        builder.on_web_content_process_terminate(|webview| {
            let label = webview.label().to_string();
            let intended = killed_labels()
                .lock()
                .map(|mut set| set.remove(&label))
                .unwrap_or(false);
            if intended {
                log::info!("메모리 회수로 끝낸 프로세스 — 자동 새로고침하지 않음 → {label}");
                return;
            }
            log::warn!("WebContent 프로세스가 예기치 않게 종료됨 — 다시 불러옵니다 → {label}");
            if let Err(e) = webview.reload() {
                log::error!("웹뷰 재로드 실패 → {label}: {e}");
            }
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        builder
    }
}

/// 자식 웹뷰를 네이티브 레벨에서 숨기거나 다시 보이게 한다.
///
/// **좌표를 화면 밖으로 옮기는 것만으로는 메모리가 줄지 않는다.** WKWebView 는 여전히
/// 창에 붙어 있는 뷰이므로 WebKit 은 그 페이지를 "보이는 상태"로 보고 렌더 백킹스토어·
/// GPU 리소스를 들고 있고, 타이머·애니메이션도 전속력으로 돈다. `setHidden:YES` 를 주면
/// WebKit 이 활동 상태를 백그라운드로 내려(`ActivityState::IsVisible` 해제) 백킹스토어를
/// 버리고 타이머를 throttle 한다 — 탭당 수십 MB 와 유휴 CPU 가 여기서 빠진다.
///
/// Tauri 가 노출하지 않는 동작이라 `enable_back_forward_gestures` 와 같은 방식으로
/// 네이티브 핸들(WKWebView 는 NSView 하위)에 직접 보낸다.
#[allow(unexpected_cfgs)]
fn set_webview_hidden<R: tauri::Runtime>(webview: &tauri::webview::Webview<R>, hidden: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = webview.with_webview(move |platform_webview| {
            use objc::{msg_send, sel, sel_impl};
            let wk = platform_webview.inner() as *mut objc::runtime::Object;
            unsafe {
                let _: () = msg_send![wk, setHidden: hidden];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, hidden);
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

/// 탭을 숨긴다. 다른 메뉴로 전환하거나 비활성 탭일 때 쓴다 — 웹뷰 자체는 살아 있어
/// 상태(스크롤·입력·로그인)가 유지된다.
///
/// 두 가지를 같이 한다: (1) `setHidden:YES` 로 WebKit 을 백그라운드로 내려 메모리·CPU 를
/// 돌려받고, (2) 창 영역 밖으로 옮긴다. 둘째는 macOS 밖(또는 네이티브 핸들 접근이 실패할 때)의
/// 안전망이다 — 숨김이 먹지 않아도 화면은 가려져야 한다.
#[tauri::command]
fn browser_hide(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        set_webview_hidden(&webview, true);
        webview
            .set_position(LogicalPosition::new(0.0, 1_000_000.0))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 오래 안 본 탭의 메모리를 되돌려받는다 — 숨긴 뒤 `WebContent` 프로세스를 죽인다.
/// 껍데기는 남으므로 다시 볼 때 `browser_open` 이 원래 주소로 되살린다.
///
/// **웹뷰를 닫아서는 안 된다.** 닫아도 메모리는 돌아오지 않으면서(위 `kill_web_content`
/// 참고) wry 0.55 가 네이티브 WKWebView 를 일부러 `retain()` 하기 때문에
/// (`wkwebview/mod.rs` 의 `impl Drop for InnerWebView` — `removeFromSuperview()` 직후
/// `self.webview.retain()`) 객체가 해제되지 않는다. Tauri 레지스트리에서만 사라지므로 그
/// 탭을 다시 열면 **웹뷰가 하나 더 생기고 프로세스는 두 개가 된다** — 회수하려던 것이 도리어
/// 누적된다.
#[tauri::command]
fn browser_discard(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        log::info!("메모리 회수 → {label}");
        set_webview_hidden(&webview, true);
        webview
            .set_position(LogicalPosition::new(0.0, 1_000_000.0))
            .map_err(|e| e.to_string())?;
        kill_web_content(&webview);
        if let Ok(mut set) = discarded_labels().lock() {
            set.insert(label);
        }
    } else {
        log::warn!("메모리 회수 대상 웹뷰가 없음 → {label}");
    }
    Ok(())
}

/// 탭을 닫는다(사용자가 탭의 X 를 눌렀을 때). 라벨은 탭 id 라 다시 쓰이지 않으므로
/// 여기서는 정말로 닫는다.
///
/// 닫기 **전에** 프로세스를 죽이는 것이 중요하다: wry 가 WKWebView 를 놓아 주지 않아 껍데기는
/// 어차피 남는데(위 `browser_discard` 참고), 그냥 닫으면 무거운 페이지를 실은 채로 남는다.
#[tauri::command]
fn browser_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Ok(mut set) = discarded_labels().lock() {
        set.remove(&label);
    }
    if let Some(webview) = app.get_webview(&label) {
        // 세 동작을 **서로 다른 런루프 틱으로 떼어 놓는다.** 한 틱에 몰면 프로세스를 죽이는
        // 중첩 런루프와 웹뷰를 파기하는 이벤트 루프가 맞물려 앱이 멈춘다.
        //  ① 지금: 화면에서 치운다 — 닫기는 비동기라 숨기지 않으면 닫힌 탭이 그 자리에 남는다.
        set_webview_hidden(&webview, true);
        let _ = webview.set_position(LogicalPosition::new(0.0, 1_000_000.0));
        //  ② 다음 틱: 프로세스를 죽여 메모리를 돌려받는다.
        kill_web_content(&webview);
        //  ③ 넉넉히 뒤: 웹뷰를 닫아 Tauri 레지스트리를 정리한다. ②가 끝난 뒤여야 한다.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if let Some(w) = app.get_webview(&label) {
                let _ = w.close();
            }
        });
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
    with_process_terminate_hook(tauri::Builder::default())
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
        .manage(pet::AppNotices::default())
        .manage(pet::NoticeTtl::default())
        .manage(intellij::ServiceState::default())
        .manage(intellij::RunTracking::default())
        .manage(intellij::WatchProject::default())
        .manage(intellij::SequenceState::default())
        .manage(standalone::StandaloneState::default())
        .manage(standalone::StandaloneTracking::default())
        .manage(standalone::StandaloneSequence::default())
        .manage(screenshare::ShareState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            auth::ldap_login,
            minimize_to_tray,
            show_main_window,
            quit_app,
            pet::pet_show,
            pet::pet_hide,
            pet::pet_alert,
            pet::pet_set_claude_alert,
            pet::pet_notify,
            pet::pet_dismiss_notice,
            pet::pet_notices,
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
            browser_discard,
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
            flex::flex_me,
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
            herdr::herdr_set_backend,
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
            standalone::standalone_model_status,
            standalone::standalone_list_services,
            standalone::standalone_start_service,
            standalone::standalone_stop_service,
            standalone::standalone_restart_service,
            standalone::standalone_running,
            standalone::standalone_logs,
            standalone::standalone_clear_logs,
            standalone::standalone_start_sequence,
            standalone::standalone_cancel_sequence,
            standalone::standalone_sequence_status,
            cowork::cowork_list_specs,
            cowork::cowork_read_spec_file,
            cowork::cowork_search_specs,
            cowork::cowork_read_css,
            markdown::markdown_read_file,
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
            cc_history::cc_history_messages,
            screenshare::screenshare_start,
            screenshare::screenshare_stop,
            screenshare::screenshare_status,
            screenshare::screenshare_tunnel_available,
            screenshare::screenshare_reopen_sender
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
                // 빈 페이지는 알리지 않는다. 메모리 회수(`browser_discard`)로 프로세스를
                // 죽이면 웹뷰가 `about:blank` 로 초기화되는데, 그걸 알리면 프론트엔드가 탭의
                // URL 을 덮어써(=저장된 주소를 잃어) 다시 열었을 때 원래 페이지로 못 돌아간다.
                if payload.url().as_str() == BLANK_URL {
                    return;
                }
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
