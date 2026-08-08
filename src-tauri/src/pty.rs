//! 터미널 뷰의 PTY — 앱 안에서 **진짜 터미널**을 돌린다.
//!
//! 세션 목록은 pane 화면을 2초마다 읽어 글자로 보여 주는 화면이고, 그 위에 선택지 버튼을
//! 얹어 조작한다. 이 모듈은 다른 길이다: **우리가 PTY 를 만들고 그 안에서
//! `herdr session attach <세션>` 을 띄운다.** 그러면 herdr 자신의 클라이언트가 TUI 를 우리
//! PTY 에 그려 주므로, 우리는 바이트를 xterm.js 로 흘려보내기만 하면 된다 — 커서 위치, 색,
//! CJK IME, 리사이즈가 전부 herdr 와 xterm.js 사이에서 해결된다. 화면을 폴링해 터미널을
//! 흉내 내는 쪽은 커서를 그릴 수 없고(읽어 온 화면에 커서 위치 escape 가 없다) 로컬 에코가
//! 없어 한글 조합이 깨진다 — 그래서 그쪽을 택하지 않았다.
//!
//! 실측으로 확인한 herdr 의 성질 넷이 이 설계를 가능하게 한다. **(1) 여러 클라이언트가
//! 동시에 붙을 수 있고, 나중에 붙은 쪽이 먼저 붙은 쪽을 쫓아내지 않는다** — 바이너리에
//! `terminal attach taken over` 문자열이 있어 tmux 처럼 빼앗을까 걱정했지만, 실제로 두 번
//! 붙여 보니 첫 클라이언트는 그대로 남았다. **(2) 클라이언트마다 자기 크기로 렌더된다** —
//! 하나를 120×40, 다른 하나를 60×20 으로 붙였을 때 각각 그 크기로 그려졌다. tmux 라면 세션이
//! 가장 작은 클라이언트로 줄어들어 앱 안의 좁은 패널이 사용자의 실제 터미널을 망가뜨렸을
//! 것이다. **(3) 반면 "지금 보고 있는 워크스페이스" 는 서버 상태라 공유된다** —
//! `workspace focus` 를 부르면 두 클라이언트가 바이트 수까지 같은 프레임을 받는다. 그러니 이
//! 뷰는 "이 카드만 보는 터미널" 이 아니라 **herdr 창을 하나 더 띄운 것**이고, 앱에서 워크
//! 스페이스를 옮기면 실제 터미널도 따라 옮겨 간다(뷰가 그 사실을 화면에 적어 둔다).
//! **(4) `HERDR_*` 환경변수가 남아 있으면 중첩 거부에 걸린다** — `nested herdr is disabled by
//! default`. Finder·LaunchAgent 로 뜬 앱에는 그 변수가 없지만 herdr pane 안에서
//! `bun run tauri dev` 를 돌리면 그대로 상속되므로, 자식 환경에서 지우고 띄운다.
//!
//! cmux·Orca 는 이 길이 없다. cmux 의 `read-screen` 은 도움말에 "as plain text" 라고 적혀
//! 있고 attach 개념이 없는 앱이며, Orca 는 Electron IDE 다. 그래서 이 뷰는 herdr 전용이고,
//! 그 판단은 `pty_sessions` 가 빈 목록을 주는 것으로 화면에 드러난다.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// PTY 하나에서 한 번에 읽어 올리는 최대 바이트. herdr 는 전체 화면 프레임을 통째로 보내서
/// (실측 최초 프레임 ≈ 59KB) 작게 잡으면 한 프레임이 여러 이벤트로 쪼개진다.
const READ_CHUNK: usize = 128 * 1024;

/// 살아 있는 PTY 하나.
struct Pty {
    /// 자식에게 입력을 쓰는 쪽. 읽기 스레드와 커맨드가 함께 쓰므로 Mutex.
    writer: Mutex<Box<dyn Write + Send>>,
    /// 창 크기 변경용 핸들(마스터). `Drop` 시 PTY 가 닫힌다.
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    /// 자식 프로세스. 닫을 때 죽인다.
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

/// 열려 있는 PTY 들. 키는 `pty_open` 이 돌려준 id.
#[derive(Default)]
pub struct PtyState(Mutex<HashMap<u64, Arc<Pty>>>);

/// id 발급기. 창을 여러 개 열어도 겹치지 않게 프로세스 전역으로 센다.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// `pty:data` 이벤트 payload. 바이트는 base64 로 싣는다 — 읽기 경계가 UTF-8 문자
/// 중간에 떨어질 수 있어서 문자열로 옮기면 그 문자가 깨진다(한글이 곧바로 깨진다).
#[derive(Clone, Serialize)]
struct PtyData {
    id: u64,
    /// base64(raw bytes). 프론트에서 Uint8Array 로 되돌려 `term.write` 에 넘긴다.
    b64: String,
}

/// `pty:exit` 이벤트 payload. 자식이 죽었다는 사실만 알린다(코드는 알 수 없을 수 있다).
#[derive(Clone, Serialize)]
struct PtyExit {
    id: u64,
}

/// `spawn_attach` 가 돌려주는 조각들. 읽기 스레드로 넘길 reader 만 따로 뺀다.
struct Spawned {
    reader: Box<dyn Read + Send>,
    pty: Pty,
}

/// PTY 를 열고 그 안에서 `herdr session attach <session>` 을 띄운다.
///
/// `pty_open` 에서 갈라 둔 이유는 테스트다 — 이 부분만 있으면 Tauri 없이도 "붙어서 프레임이
/// 오고, 우리가 쓴 키가 herdr 에 닿는지"를 살아 있는 세션에 대고 확인할 수 있다
/// (`attaches_and_detaches_on_a_live_session`).
fn spawn_attach(session: &str, cols: u16, rows: u16) -> Result<Spawned, String> {
    let size = PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = NativePtySystem::default()
        .openpty(size)
        .map_err(|e| format!("PTY 열기 실패: {e}"))?;

    let mut cmd = CommandBuilder::new(crate::herdr::herdr_bin_path());
    cmd.args(["session", "attach", session]);
    // 앱이 herdr pane 안에서 떴다면(개발 중 `bun run tauri dev`) 이 변수들이 상속돼
    // "nested herdr is disabled by default" 로 거부된다. 실측으로 확인한 함정이다.
    for key in herdr_env_keys() {
        cmd.env_remove(key);
    }
    // TUI 가 색과 대체 화면 버퍼를 쓰도록. xterm.js 는 이 값으로 잘 동작한다.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("herdr attach 실행 실패: {e}"))?;
    // slave 는 자식이 가져갔으므로 부모 쪽 fd 는 닫는다 — 열어 두면 자식이 종료해도
    // 읽기 쪽에 EOF 가 오지 않아 스레드가 영원히 남는다.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY 읽기 핸들 실패: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY 쓰기 핸들 실패: {e}"))?;

    Ok(Spawned {
        reader,
        pty: Pty {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
        },
    })
}

/// PTY 를 열고 그 안에서 `herdr session attach <session>` 을 띄운다. 반환값은 PTY id.
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let Spawned { mut reader, pty } = spawn_attach(&session, cols, rows)?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let pty = Arc::new(pty);
    if let Ok(mut map) = app.state::<PtyState>().0.lock() {
        map.insert(id, pty);
    }

    // 읽기 전용 스레드. blocking read 라 async 로 두면 런타임 스레드를 잡는다.
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    if app2.emit("pty:data", PtyData { id, b64 }).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    // EOF 를 에러로 주는 플랫폼도 있어 조용히 끝낸다.
                    log::debug!("PTY {id} 읽기 종료: {e}");
                    break;
                }
            }
        }
        let _ = app2.emit("pty:exit", PtyExit { id });
        log::info!("PTY {id} 종료");
    });

    log::info!("PTY {id} 열림: herdr session attach {session} ({cols}x{rows})");
    Ok(id)
}

/// PTY 에 입력을 쓴다(키 입력·붙여넣기). 프론트가 base64 로 싣는 이유는 읽기와 같다.
#[tauri::command]
pub fn pty_write(app: AppHandle, id: u64, b64: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("입력 디코딩 실패: {e}"))?;
    let pty = get(&app, id)?;
    let mut w = pty.writer.lock().map_err(|_| "PTY 쓰기 잠금 실패")?;
    w.write_all(&bytes).map_err(|e| format!("PTY 쓰기 실패: {e}"))?;
    w.flush().map_err(|e| format!("PTY flush 실패: {e}"))
}

/// 창 크기를 알린다. herdr 는 클라이언트마다 자기 크기로 렌더하므로(실측) 이 값이
/// 사용자의 실제 터미널을 건드리지 않는다.
#[tauri::command]
pub fn pty_resize(app: AppHandle, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let pty = get(&app, id)?;
    let m = pty.master.lock().map_err(|_| "PTY 잠금 실패")?;
    m.resize(PtySize {
        rows: rows.max(4),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| format!("PTY 크기 변경 실패: {e}"))
}

/// PTY 를 닫는다. **herdr 세션은 그대로 살아 있다** — 우리 클라이언트만 떨어진다.
#[tauri::command]
pub fn pty_close(app: AppHandle, id: u64) -> Result<(), String> {
    let Some(pty) = app
        .state::<PtyState>()
        .0
        .lock()
        .ok()
        .and_then(|mut m| m.remove(&id))
    else {
        return Ok(()); // 이미 닫혔다(자식 종료 → 프론트가 정리).
    };
    if let Ok(mut c) = pty.child.lock() {
        let _ = c.kill();
        let _ = c.wait();
    }
    log::info!("PTY {id} 닫음");
    Ok(())
}

/// 앱이 herdr 안에서 떴을 때 상속되는 변수들. 자식에서 지워야 중첩 거부를 피한다.
/// `env_remove` 는 이름을 하나씩 받으므로 목록을 둔다(prefix 지정 API 가 없다).
fn herdr_env_keys() -> Vec<String> {
    std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| k.starts_with("HERDR_"))
        .collect()
}

fn get(app: &AppHandle, id: u64) -> Result<Arc<Pty>, String> {
    app.state::<PtyState>()
        .0
        .lock()
        .map_err(|_| "PTY 목록 잠금 실패".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "이미 닫힌 터미널입니다.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `HERDR_*` 만 골라야 한다. 하나라도 남으면 자식 herdr 가 중첩으로 보고 거부하고
    /// (`nested herdr is disabled by default`) 터미널이 빈 화면으로 뜬다.
    #[test]
    fn picks_only_herdr_env_keys() {
        // 실제 환경에 심어 두고 고르는지 본다(다른 변수는 건드리지 않는다).
        std::env::set_var("HERDR_TEST_PANE", "w9:p9");
        std::env::set_var("MYSPACE_NOT_HERDR", "1");
        let keys = herdr_env_keys();
        assert!(keys.iter().any(|k| k == "HERDR_TEST_PANE"));
        assert!(!keys.iter().any(|k| k == "MYSPACE_NOT_HERDR"));
        assert!(keys.iter().all(|k| k.starts_with("HERDR_")));
        std::env::remove_var("HERDR_TEST_PANE");
        std::env::remove_var("MYSPACE_NOT_HERDR");
    }

    /// 살아 있는 herdr 세션에 붙어 **양방향**을 확인한다: 프레임이 오는지(읽기), 그리고 우리가
    /// 쓴 키가 herdr 에 닿는지(쓰기 — `ctrl+b` `q` 는 herdr 의 분리 키라 자식이 스스로 끝난다).
    /// 분리는 그 클라이언트만 떼어 내므로 **세션과 사용자의 실제 터미널은 건드리지 않는다.**
    ///
    /// 자동으로 돌 수 없어 `#[ignore]` 다 — 실행 중인 herdr 세션이 필요하다.
    /// ```sh
    /// PTY_SESSION=my-space cargo test --lib attaches_and_detaches -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore]
    fn attaches_and_detaches_on_a_live_session() {
        use std::time::{Duration, Instant};

        let session = std::env::var("PTY_SESSION").unwrap_or_else(|_| "default".into());
        let Spawned { mut reader, pty } =
            spawn_attach(&session, 100, 30).expect("attach 가 떠야 한다");

        // 읽기: 첫 프레임이 오는가. herdr 는 전체 화면을 통째로 보내므로 곧바로 크게 온다.
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        let mut got = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline && got.len() < 2000 {
            if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
                got.extend_from_slice(&chunk);
            }
        }
        println!("첫 프레임 {} bytes", got.len());
        assert!(got.len() > 1000, "프레임이 와야 한다(받은 {}B)", got.len());
        assert!(got.contains(&0x1b), "ANSI escape 가 있어야 한다");

        // 쓰기: herdr 의 분리 키(prefix ctrl+b 다음 q). 닿았다면 자식이 스스로 끝난다.
        {
            let mut w = pty.writer.lock().unwrap();
            w.write_all(b"\x02").unwrap();
            w.flush().unwrap();
            std::thread::sleep(Duration::from_millis(400));
            w.write_all(b"q").unwrap();
            w.flush().unwrap();
        }

        let deadline = Instant::now() + Duration::from_secs(8);
        let mut exited = false;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = pty.child.lock().unwrap().try_wait() {
                println!("자식 종료: {status:?}");
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        if !exited {
            let _ = pty.child.lock().unwrap().kill();
        }
        assert!(exited, "ctrl+b q 가 닿아 자식이 끝나야 한다(쓰기 경로)");
    }
}
