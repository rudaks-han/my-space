//! 알림(reminder) — 프론트엔드가 특정 시간에 도달했다고 판단하면 이 커맨드를 호출해
//! 데스크톱 펫의 말풍선으로 알림을 띄운다.
//!
//! 알림 데이터·스케줄 판단은 프론트엔드(localStorage + 인터벌)가 담당하고,
//! Rust 는 "지금 이 내용을 보여줘/닫아"만 처리한다. 내용은 `reminder:*` 이벤트로 모든 창에
//! 방출되고(펫 창이 `use-pet-mood.ts` 에서 받는다), 펫이 꺼져 있을 수 있으므로
//! `pet::set_alert` 로 "알릴 게 있다"고 표시해 잠깐 나타나게 한다.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

use crate::pet;

/// 펫 말풍선에 표시할 알림 한 건.
#[derive(Clone, Serialize, Deserialize)]
pub struct ReminderPayload {
    /// 프론트엔드 알림 id(중복 발생 방지·닫기 매칭용).
    pub id: String,
    pub title: String,
    /// 부제(예: 예정 시각 문구). 없으면 빈 문자열.
    pub body: String,
}

/// 지금 떠 있는 알림. 펫 창이 마운트 시 조회하므로(콜드 로드로 이벤트를 놓쳐도)
/// 여기서 내용을 채운다.
#[derive(Default)]
pub struct PendingReminder(pub Mutex<Option<ReminderPayload>>);

/// 알림을 펫 말풍선으로 띄운다(프론트 스케줄러가 예정 시각에 호출).
#[tauri::command]
pub fn reminder_fire(app: tauri::AppHandle, id: String, title: String, body: String) {
    let payload = ReminderPayload { id, title, body };
    if let Ok(mut g) = app.state::<PendingReminder>().0.lock() {
        *g = Some(payload.clone());
    }
    // 펫을 꺼 뒀어도 알림은 보여야 한다 — 확인·스누즈로 정리될 때까지 띄운다.
    pet::set_alert(&app, pet::AlertSource::Reminder, true);
    let _ = app.emit("reminder:fire", payload);
}

/// 현재 대기 중인 알림(펫 창이 마운트 시 조회).
#[tauri::command]
pub fn reminder_current(app: tauri::AppHandle) -> Option<ReminderPayload> {
    app.state::<PendingReminder>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone())
}

/// 알림을 닫는다(펫 말풍선의 "확인" 클릭 시 호출).
#[tauri::command]
pub fn reminder_dismiss(app: tauri::AppHandle) {
    if let Ok(mut g) = app.state::<PendingReminder>().0.lock() {
        *g = None;
    }
    pet::set_alert(&app, pet::AlertSource::Reminder, false);
    let _ = app.emit("reminder:dismiss", ());
}

/// 다시 알림 요청을 메인 창(스케줄러)에 전달하는 페이로드.
#[derive(Clone, Serialize)]
struct SnoozePayload {
    id: String,
    minutes: u64,
}

/// 현재 알림을 잠시 미룬다(다시 알림). 팝오버를 닫고, 실제 재발생은 메인 창의
/// 스케줄러(reminder-store)가 처리하도록 이벤트만 보낸다 — 그 사이 사용자가 알림을
/// 삭제/비활성화했다면 다시 뜨지 않도록(원본 상태를 존중) 하기 위함.
#[tauri::command]
pub fn reminder_snooze(app: tauri::AppHandle, minutes: u64) {
    // 닫기 전에 현재 알림 id 를 확보한다(reminder_dismiss 가 None 으로 비우기 때문).
    let id = app
        .state::<PendingReminder>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.id.clone()));

    reminder_dismiss(app.clone());

    if let Some(id) = id {
        let _ = app.emit("reminder:snooze", SnoozePayload { id, minutes });
    }
}
