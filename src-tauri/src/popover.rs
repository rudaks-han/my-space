//! 트레이(메뉴바) 아이콘 아래에 뜨는 팝오버 창(`widget`) 공용 로직.
//! herdr 질문 팝오버와 알림(reminder) 팝오버가 같은 `widget` 창을 공유하므로,
//! 위치 계산·표시·숨김을 여기 한 곳에 모아 두 기능이 함께 쓴다.

use tauri::{LogicalPosition, LogicalSize, Manager};

/// 트레이 아이콘 바로 아래(중앙 정렬)에 `widget` 창을 지정한 크기로 띄운다.
/// Rust 가 직접 창을 띄워 위젯 웹뷰 로드를 유발한다(웹뷰가 스스로 자신을 띄울 수 없는
/// 닭-달걀 문제 회피). 화면 밖으로 넘치지 않도록 모니터 경계 안으로 보정한다.
pub fn present_popover(app: &tauri::AppHandle, width: f64, height: f64) {
    present_popover_ex(app, width, height, true);
}

/// present_popover 와 같되 focus 를 뺏을지 선택한다. 수동 응답이 필요한 질문은 focus(true),
/// 지나가는 알림(작업 완료 등)은 focus 를 뺏지 않도록 false 로 띄운다.
pub fn present_popover_ex(app: &tauri::AppHandle, width: f64, height: f64, focus: bool) {
    let Some(widget) = app.get_window("widget") else {
        return;
    };
    let _ = widget.set_size(LogicalSize::new(width, height));
    let scale = widget.scale_factor().unwrap_or(1.0);

    // 트레이 아이콘 실제 위치 → 중앙 아래로 앵커.
    let anchored = app
        .tray_by_id("main-tray")
        .and_then(|t| t.rect().ok().flatten())
        .map(|rect| {
            let p = rect.position.to_logical::<f64>(scale);
            let s = rect.size.to_logical::<f64>(scale);
            (p.x + s.width / 2.0 - width / 2.0, p.y + s.height)
        });

    if let Some(m) = widget
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| widget.current_monitor().ok().flatten())
    {
        let msize = m.size().to_logical::<f64>(m.scale_factor());
        let mpos = m.position().to_logical::<f64>(m.scale_factor());
        const MARGIN: f64 = 8.0;
        const MENU_BAR: f64 = 28.0;
        let (mut x, mut y) = anchored.unwrap_or((
            mpos.x + msize.width - width - MARGIN,
            mpos.y + MENU_BAR,
        ));
        x = x.min(mpos.x + msize.width - width - MARGIN).max(mpos.x + MARGIN);
        y = y.min(mpos.y + msize.height - height - MARGIN).max(mpos.y);
        let _ = widget.set_position(LogicalPosition::new(x, y));
    } else if let Some((x, y)) = anchored {
        let _ = widget.set_position(LogicalPosition::new(x, y));
    }

    let _ = widget.show();
    let _ = widget.set_always_on_top(true);
    let _ = widget.set_visible_on_all_workspaces(true);
    if focus {
        let _ = widget.set_focus();
    }
}

/// 팝오버 창을 숨긴다.
pub fn hide_popover(app: &tauri::AppHandle) {
    if let Some(widget) = app.get_window("widget") {
        let _ = widget.hide();
    }
}
