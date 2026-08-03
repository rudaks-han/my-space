//! 앱 실행 상태를 Firebase Realtime Database 에 남긴다.
//!
//! 남기는 곳은 두 군데다.
//!  - `access-log/<YYYY-MM-DD>/<auto id>` — `login`/`logout` 한 줄. 날짜별로 묶어 두면
//!    "어느 날 몇 번 켰나"를 콘솔에서 접어 볼 수 있고, RTDB 는 키 순서대로 정렬되므로
//!    날짜 노드 안에서는 시간순이 저절로 지켜진다. auto id 는 POST(푸시)로 서버가 만들게
//!    둔다 — 같은 밀리초에 두 번 써도 덮이지 않는다.
//!  - `status/<LDAP 아이디>` — 그 사람이 지금 켜 놓았는지. 사람마다 노드가 하나이고
//!    PUT 으로 통째 교체한다(누적하지 않는다).
//!
//! **기록 단위는 "누가 켜 놓았는가"라서, 시작 시각이 아니라 로그인이 확정된 시점에 쓴다.**
//! `status` 를 사람별로 나누려면 LDAP 아이디가 있어야 하는데, Rust 가 켜지는 시점엔 그 값이
//! 아직 프론트의 localStorage 에만 있다. 그래서 실행하자마자 쓰지 않고 프론트가
//! `firebase_set_user` 로 알려줄 때까지 기다린다(자동 로그인이면 1~2초). 앱만 켜고 로그인하지
//! 않은 구간은 `status` 에 남지 않는데, `LoginGate` 가 막고 있어 어차피 앱을 쓸 수 없는
//! 구간이라 "아무도 켜 놓지 않았다"가 맞는 표현이다.
//!
//! 네 가지가 이 구현의 모양을 정한다.
//!
//! **① 종료 로그는 동기로 보내야 한다.** `RunEvent::Exit` 이후 프로세스는 바로 사라지므로
//! fire-and-forget 으로 띄운 요청은 전송 전에 죽는다. 그래서 `reqwest::blocking` 을
//! 별도 std 스레드에서 돌리고 채널로 기다린다. blocking 클라이언트는 자체 tokio 런타임을
//! 만들기 때문에 Tauri 의 런타임 스레드에서 직접 호출하면 패닉한다 — 스레드 분리는
//! 타임아웃을 걸기 위한 장치이자 그 패닉을 피하는 장치다. 대기는 `EXIT_WAIT` 로 끊는다.
//! 사내망·오프라인에서 종료가 몇 초씩 늦어지면 그게 더 큰 버그다.
//!
//! **② `kill -9` 나 강제 종료에는 `logout` 이 남지 않는다.** 그때 `online` 이 영원히
//! `true` 로 굳는 걸 막으려고 `lastSeen` 을 `HEARTBEAT` 마다 갱신한다. `online: true` 인데
//! `lastSeen` 이 한참 전이면 비정상 종료로 읽으면 된다.
//!
//! **③ 로그아웃도 종료로 친다.** 앱은 켜져 있어도 LDAP 로그아웃을 하면 그 사람은 더 이상
//! 쓰고 있지 않고, 다른 사람이 로그인할 수도 있다. 그대로 두면 앞사람 노드가 `online: true`
//! 로 남아 거짓말을 하므로, 사용자가 바뀌면 이전 사람을 먼저 닫고 새 사람을 연다.
//!
//! **④ 어떤 실패도 앱에 영향을 주지 않는다.** 사내망에서 Firebase 가 막혀 있거나
//! 오프라인이어도 로그 한 줄 남기고 지나간다 — 실행 기록 때문에 앱이 안 켜지면 안 된다.

use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use chrono::{Local, SecondsFormat};
use serde_json::{json, Value};

/// RTDB REST 엔드포인트. ⚠️ 리전이 URL 에 들어간다 — 이 DB 는 `asia-southeast1` 이라
/// 리전 없는 `*.firebaseio.com` 으로 부르면 404 + "Database lives in a different region" 이
/// 돌아온다(콘솔 URL 만 보고는 알 수 없어 한 번 밟은 자리다).
const DB_URL: &str = "https://my-space-44da3-default-rtdb.asia-southeast1.firebasedatabase.app";

/// 요청 하나의 제한 시간. 종료 경로에 걸리므로 짧게 잡는다.
const TIMEOUT: Duration = Duration::from_secs(5);

/// 종료 로그를 기다려 주는 최대 시간. 이 안에 못 보내면 포기하고 종료한다.
const EXIT_WAIT: Duration = Duration::from_secs(4);

/// `lastSeen` 갱신 주기(②).
const HEARTBEAT: Duration = Duration::from_secs(60);

/// 지금 기록 중인 사람. 로그인으로 채워지고 로그아웃·앱 종료로 비워진다.
static CURRENT: Mutex<Option<Session>> = Mutex::new(None);

/// 이번 실행이 로그인 항목(자동 실행)으로 켜졌는지. `app_started` 가 채운다.
static AUTOSTART: OnceLock<bool> = OnceLock::new();

/// 한 사람의 기록 구간(로그인 → 로그아웃/종료).
#[derive(Clone)]
struct Session {
    /// LDAP 아이디. `status` 노드의 키다.
    username: String,
    display_name: String,
    email: String,
    /// 로그인 시각(epoch millis). 종료 시 `uptimeSec` 을 여기서 잰다 —
    /// 앱 시작이 아니라 이 사람이 쓰기 시작한 시점 기준이라야 사람별 기록으로 말이 된다.
    since_ms: i64,
}

fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("firebase HTTP 클라이언트 생성 실패")
    })
}

/// 이번 실행을 구분하는 값. 같은 사람이 껐다 켠 기록을 이어 붙일 때 쓴다.
/// 시작 시각(밀리초) + pid 면 한 기기 안에서는 충돌하지 않는다.
fn session_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| format!("{}-{}", started_at(), std::process::id()))
}

/// 앱이 켜진 시각(epoch millis).
fn started_at() -> i64 {
    static AT: OnceLock<i64> = OnceLock::new();
    *AT.get_or_init(|| Local::now().timestamp_millis())
}

/// 기기 이름. `hostname` 한 번 호출이면 되고 실행 중 바뀌지 않으므로 캐시한다.
/// (`libc::gethostname` 은 macOS 전용 의존이라 cfg 를 늘리지 않으려고 명령을 쓴다.)
fn hostname() -> &'static str {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().trim_end_matches(".local").to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".to_string())
    })
}

/// OS 계정. 사람 식별은 LDAP 아이디로 하지만, 같은 계정이 어느 Mac 계정에서 돌았는지도
/// 남겨 두면 기기를 갈랐을 때 추적이 된다.
fn os_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "unknown".to_string())
}

/// LDAP 아이디를 RTDB 키로 쓸 수 있게 다듬는다.
///
/// RTDB 키에는 `.` `$` `#` `[` `]` `/` 와 제어문자를 넣을 수 없다. sAMAccountName 은 보통
/// 영숫자지만 `auth.rs` 는 사용자가 입력한 값을 그대로 돌려줄 수 있어서
/// (`kmhan@spectra.co.kr` 같은 UPN) `.` 이 섞여 들어올 수 있다 — 그대로 PUT 하면
/// 400 이 떨어진다. 원본은 노드 안 `user` 필드에 그대로 남으므로 여기서는 키만 다듬는다.
fn status_key(username: &str) -> String {
    let cleaned: String = username
        .chars()
        .map(|c| {
            if matches!(c, '.' | '$' | '#' | '[' | ']' | '/') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.trim().is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

fn status_url(username: &str) -> String {
    let key = urlencoding::encode(&status_key(username)).into_owned();
    format!("{DB_URL}/status/{key}.json")
}

/// 로그 한 줄과 status 가 공통으로 싣는 신원 정보.
fn identity(s: &Session) -> Value {
    json!({
        "user": s.username,
        "displayName": s.display_name,
        "email": s.email,
        "osUser": os_user(),
        "host": hostname(),
        "version": env!("CARGO_PKG_VERSION"),
        "session": session_id(),
        "autostart": AUTOSTART.get().copied().unwrap_or(false),
    })
}

/// `extra` 의 항목을 `base` 위에 얹는다(둘 다 JSON object 라 평평하게 합칠 수 있다).
fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    base
}

fn now_iso() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Secs, false)
}

/// `access-log/<오늘>` 에 한 줄 추가(POST = 서버가 auto id 부여).
fn push_log(s: &Session, kind: &str, extra: Value) -> Result<(), String> {
    let date = Local::now().format("%Y-%m-%d");
    let url = format!("{DB_URL}/access-log/{date}.json");
    let body = merge(
        identity(s),
        merge(
            json!({
                "type": kind,
                "at": now_iso(),
                "ts": Local::now().timestamp_millis(),
            }),
            extra,
        ),
    );
    send("POST", &url, &body)
}

fn send(method: &str, url: &str, body: &Value) -> Result<(), String> {
    let req = match method {
        "POST" => client().post(url),
        "PUT" => client().put(url),
        "PATCH" => client().patch(url),
        _ => return Err(format!("지원하지 않는 메서드: {method}")),
    };
    let res = req.json(body).send().map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        let code = res.status();
        let text = res.text().unwrap_or_default();
        Err(format!("{code}: {text}"))
    }
}

/// 로그인 — `access-log` 에 한 줄 남기고 `status/<아이디>` 를 online 으로 세운다.
fn open_session(s: &Session) {
    if let Err(e) = push_log(s, "login", json!({})) {
        log::warn!("firebase access-log(login) 기록 실패: {e}");
    }
    let body = merge(
        identity(s),
        json!({
            "online": true,
            "since": now_iso(),
            "lastSeen": now_iso(),
        }),
    );
    if let Err(e) = send("PUT", &status_url(&s.username), &body) {
        log::warn!("firebase status(online) 기록 실패: {e}");
    } else {
        log::info!("firebase: {} online 기록", s.username);
    }
}

/// 로그아웃/종료 — `access-log` 에 한 줄 남기고 `status/<아이디>` 를 offline 으로 내린다.
fn close_session(s: &Session, reason: &str) {
    let uptime = (Local::now().timestamp_millis() - s.since_ms) / 1000;
    if let Err(e) = push_log(s, "logout", json!({ "uptimeSec": uptime, "reason": reason })) {
        log::warn!("firebase access-log(logout) 기록 실패: {e}");
    }
    let body = merge(
        identity(s),
        json!({
            "online": false,
            "endedAt": now_iso(),
            "lastSeen": now_iso(),
            "uptimeSec": uptime,
            "reason": reason,
        }),
    );
    if let Err(e) = send("PUT", &status_url(&s.username), &body) {
        log::warn!("firebase status(offline) 기록 실패: {e}");
    } else {
        log::info!("firebase: {} offline 기록 ({reason})", s.username);
    }
}

/// 앱 시작 시 한 번. 시작 시각을 고정하고 하트비트 루프만 띄운다 —
/// 실제 기록은 로그인이 확정돼야(=`firebase_set_user`) 시작된다.
pub fn app_started(at_login: bool) {
    let _ = started_at();
    let _ = AUTOSTART.set(at_login);
    std::thread::spawn(|| loop {
        std::thread::sleep(HEARTBEAT);
        // ② 강제 종료로 logout 이 안 남는 경우를 위해 살아 있다는 표시만 갱신한다.
        let who = CURRENT.lock().ok().and_then(|c| c.clone());
        if let Some(s) = who {
            let patch = json!({ "lastSeen": now_iso() });
            if let Err(e) = send("PATCH", &status_url(&s.username), &patch) {
                log::warn!("firebase status(lastSeen) 갱신 실패: {e}");
            }
        }
    });
}

/// 프론트가 로그인 사용자를 알려줄 때 호출한다(자동 로그인 복원 포함).
///
/// 같은 사용자로 다시 불려도(창 여러 개, 리마운트) 아무 일도 하지 않는다 —
/// 그러지 않으면 `access-log` 에 같은 로그인이 여러 줄 쌓인다.
#[tauri::command]
pub fn firebase_set_user(username: String, display_name: String, email: String) {
    let next = Session {
        username,
        display_name,
        email,
        since_ms: Local::now().timestamp_millis(),
    };
    let prev = {
        let Ok(mut cur) = CURRENT.lock() else { return };
        if cur.as_ref().map(|s| s.username.as_str()) == Some(next.username.as_str()) {
            return;
        }
        cur.replace(next.clone())
    };
    std::thread::spawn(move || {
        // ③ 사용자가 바뀌었으면 앞사람을 먼저 닫는다.
        if let Some(prev) = prev {
            close_session(&prev, "switch-user");
        }
        open_session(&next);
    });
}

/// 프론트가 로그아웃했을 때 호출한다. 로그인한 적이 없으면 아무 일도 하지 않는다.
#[tauri::command]
pub fn firebase_clear_user() {
    let prev = {
        let Ok(mut cur) = CURRENT.lock() else { return };
        cur.take()
    };
    if let Some(prev) = prev {
        std::thread::spawn(move || close_session(&prev, "logout"));
    }
}

/// 앱이 꺼짐을 남긴다. `RunEvent::Exit` 에서 호출하며, 전송될 때까지 잠깐 기다린다(①).
pub fn app_exiting() {
    let Some(prev) = CURRENT.lock().ok().and_then(|mut c| c.take()) else {
        // 로그인 전에 껐다면 남길 세션이 없다.
        return;
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        close_session(&prev, "app-exit");
        let _ = tx.send(());
    });
    if rx.recv_timeout(EXIT_WAIT).is_err() {
        log::warn!("firebase 종료 기록이 {EXIT_WAIT:?} 안에 끝나지 않아 그대로 종료합니다");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Session {
        Session {
            username: "kmhan".to_string(),
            display_name: "한경만".to_string(),
            email: "kmhan@spectra.co.kr".to_string(),
            since_ms: Local::now().timestamp_millis(),
        }
    }

    /// 로그 한 줄은 신원·종류·추가 항목이 **한 평면**에 모두 있어야 한다 —
    /// 콘솔에서 노드를 펼치지 않고도 한 줄로 읽히는 게 이 구조를 고른 이유다.
    #[test]
    fn a_log_entry_carries_identity_kind_and_extras() {
        let body = merge(
            identity(&sample()),
            merge(
                json!({ "type": "logout", "at": now_iso(), "ts": 1_i64 }),
                json!({ "uptimeSec": 42 }),
            ),
        );
        for key in [
            "type",
            "at",
            "ts",
            "user",
            "displayName",
            "email",
            "osUser",
            "host",
            "version",
            "session",
            "uptimeSec",
        ] {
            assert!(body.get(key).is_some(), "{key} 가 빠졌다: {body}");
        }
        assert_eq!(body["type"], "logout");
        assert_eq!(body["user"], "kmhan");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    }

    /// `merge` 는 양쪽을 합치되 겹치는 키는 `extra` 가 이긴다.
    #[test]
    fn merge_lets_the_extra_side_win() {
        let out = merge(json!({ "a": 1, "b": 2 }), json!({ "b": 3, "c": 4 }));
        assert_eq!(out, json!({ "a": 1, "b": 3, "c": 4 }));
    }

    /// UPN(`kmhan@spectra.co.kr`)으로 로그인해도 키가 만들어져야 한다 —
    /// `.` 이 그대로 들어가면 RTDB 가 400 을 돌려준다.
    #[test]
    fn status_keys_drop_characters_rtdb_forbids() {
        assert_eq!(status_key("kmhan"), "kmhan");
        assert_eq!(status_key("kmhan@spectra.co.kr"), "kmhan@spectra_co_kr");
        assert_eq!(status_key("a/b#c$d[e]f"), "a_b_c_d_e_f");
        assert_eq!(status_key(""), "unknown");
        // 사람별로 노드가 갈리는 게 이 기능의 핵심이라 서로 섞이면 안 된다.
        assert_ne!(status_key("kmhan"), status_key("hgd100"));
    }

    /// 사람이 바뀌면 URL 도 바뀌어야 한다(같은 노드를 덮어쓰면 사람별 구분이 무의미해진다).
    #[test]
    fn each_user_gets_their_own_status_node() {
        assert!(status_url("kmhan").ends_with("/status/kmhan.json"));
        assert_ne!(status_url("kmhan"), status_url("hgd100"));
    }

    /// 로그인 → 로그아웃 한 바퀴를 실제 RTDB 에 대고 돌린다(네트워크 필요).
    ///
    /// 두 사람으로 돌려서 **노드가 서로 섞이지 않는지**를 본다 — 이게 사람별로 나눈 이유다.
    /// `access-log` 에는 `_test-` 사용자로 흔적이 남으므로(POST auto id 라 테스트가 되짚어
    /// 지울 수 없다) 실행한 날짜 노드를 눈으로 확인할 것. `status` 는 테스트가 지운다.
    #[test]
    #[ignore]
    fn two_users_get_independent_status_nodes() {
        let a = Session {
            username: "_test-alice".to_string(),
            display_name: "앨리스".to_string(),
            email: "alice@example.com".to_string(),
            since_ms: Local::now().timestamp_millis() - 5_000,
        };
        let b = Session {
            username: "_test-bob".to_string(),
            display_name: "밥".to_string(),
            email: "bob@example.com".to_string(),
            since_ms: Local::now().timestamp_millis() - 5_000,
        };

        open_session(&a);
        open_session(&b);
        let read = |u: &str| -> Value {
            client()
                .get(status_url(u))
                .send()
                .expect("GET 실패")
                .json()
                .expect("JSON 파싱 실패")
        };
        assert_eq!(read(&a.username)["online"], true);
        assert_eq!(read(&b.username)["online"], true);
        assert_eq!(read(&a.username)["displayName"], "앨리스");
        assert_eq!(read(&b.username)["displayName"], "밥");

        // 한 사람이 나가도 다른 사람 노드는 그대로여야 한다.
        close_session(&a, "logout");
        assert_eq!(read(&a.username)["online"], false);
        assert!(read(&a.username)["uptimeSec"].as_i64().unwrap() >= 5);
        assert_eq!(
            read(&b.username)["online"],
            true,
            "다른 사용자 노드가 함께 내려갔다"
        );

        close_session(&b, "app-exit");
        assert_eq!(read(&b.username)["reason"], "app-exit");

        for u in [&a.username, &b.username] {
            client().delete(status_url(u)).send().expect("DELETE 실패");
        }
    }

    /// 실제 RTDB 왕복(네트워크 필요):
    /// `cargo test firebase -- --ignored --nocapture`
    ///
    /// 실행 기록을 더럽히지 않도록 `_test` 노드에만 쓰고 지운다. 확인하는 건
    /// 리전이 들어간 `DB_URL` 이 맞는지, blocking 클라이언트로 쓰기/읽기/삭제가
    /// 되는지, 성공 판정(`send`)이 옳은지 — 즉 실행/종료 경로가 공유하는 배관 전부다.
    #[test]
    #[ignore]
    fn round_trips_against_the_real_database() {
        let url = format!("{DB_URL}/_test/{}.json", session_id());
        send("PUT", &url, &json!({ "hello": "world" })).expect("PUT 실패");

        let got: Value = client()
            .get(&url)
            .send()
            .expect("GET 실패")
            .json()
            .expect("JSON 파싱 실패");
        assert_eq!(got["hello"], "world");

        send("PATCH", &url, &json!({ "hello": "again" })).expect("PATCH 실패");
        let got: Value = client().get(&url).send().unwrap().json().unwrap();
        assert_eq!(got["hello"], "again");

        client().delete(&url).send().expect("DELETE 실패");
        let after = client().get(&url).send().unwrap().text().unwrap();
        assert_eq!(after.trim(), "null", "테스트 노드가 지워지지 않았다");
    }
}
