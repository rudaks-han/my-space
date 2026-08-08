//! 데이터베이스 뷰어 — JDBC 사이드카를 띄우고 프론트의 명령을 그쪽으로 넘긴다.
//!
//! ES 뷰어(`es.rs`)는 HTTP 프록시 하나면 됐고 Kafka(`kafka.rs`)는 Rust 클라이언트가
//! 있었지만, 데이터베이스는 둘 다 아니다. MySQL·PostgreSQL 은 순수 Rust 드라이버가
//! 있어도 **Oracle 과 H2 는 없다** — Oracle 은 네이티브 Instant Client 를 요구하고
//! H2 는 Java 전용 프로토콜이다. 엔진마다 백엔드를 따로 두면 조회·수정·커밋 경로가
//! 엔진 수만큼 갈라지므로, 다섯 엔진 전부를 JDBC 한 경로로 처리한다.
//!
//! 그 JDBC 쪽이 `resources/MySpaceJdbcBridge.java` 다. 이 모듈은 그 파일을
//! `~/.myspace/jdbc-bridge/` 에 풀어 놓고 `java <파일>` 로 띄운 뒤(JEP 330 단일 파일
//! 소스 모드), JSON Lines 로 stdin/stdout 대화를 한다.
//!
//! 설계 메모
//! - 브리지는 **하나만** 띄우고 앱이 사는 동안 재사용한다. 접속 상태(열린 커넥션,
//!   진행 중인 트랜잭션)가 그 프로세스 안에 있어서, 요청마다 새로 띄우면 커밋이라는
//!   개념 자체가 성립하지 않는다.
//! - 응답은 id 로 짝을 맞춘다. 브리지가 요청을 스레드 풀에서 처리하므로 응답 순서가
//!   요청 순서와 다를 수 있다 — 순서에 기대면 안 된다.
//! - stderr 는 **반드시 계속 읽어야 한다**. 안 읽으면 파이프가 차서 브리지가 멈춘다
//!   (드라이버들이 경고를 꽤 뱉는다).
//! - 브리지가 죽으면(EOF) 대기 중인 요청을 전부 실패시키고 전역 핸들을 비운다.
//!   다음 호출이 알아서 새로 띄운다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use base64::Engine as _;
use pbkdf2::pbkdf2_hmac;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use tokio::sync::oneshot;

type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// 브리지 소스. 빌드 시점에 바이너리에 박아 두고 실행 시점에 디스크로 푼다.
/// 번들 리소스로 두지 않는 이유: dev 와 릴리스의 리소스 경로가 달라져서
/// 두 경로를 다 맞춰 줘야 하는데, 여기서는 그럴 이유가 없다.
const BRIDGE_SRC: &str = include_str!("../resources/MySpaceJdbcBridge.java");

/// 브리지가 응답하지 않을 때 포기하는 시간. 쿼리는 사용자가 취소할 수 있으므로
/// 넉넉하게 둔다(사내 Oracle 은 첫 접속에 10초 넘게 걸리기도 한다).
const CALL_TIMEOUT_SECS: u64 = 300;

/* ════════════════════════════ 브리지 프로세스 ════════════════════════════ */

struct Bridge {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    /// 종료(kill)용. 정상 경로에서는 stdin 을 닫으면 알아서 끝난다.
    child: Mutex<Child>,
}

impl Bridge {
    /// 대기 중인 요청을 전부 실패시킨다. 브리지가 죽었을 때 호출한다.
    fn fail_all(&self, why: &str) {
        let mut pending = self.pending.lock().unwrap();
        for (_, tx) in pending.drain() {
            let _ = tx.send(Err(why.to_string()));
        }
    }
}

static BRIDGE: OnceLock<Mutex<Option<Arc<Bridge>>>> = OnceLock::new();

fn slot() -> &'static Mutex<Option<Arc<Bridge>>> {
    BRIDGE.get_or_init(|| Mutex::new(None))
}

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME 환경변수를 읽을 수 없습니다.".to_string())
}

/// 브리지 소스를 풀어 둘 위치. 내용이 바뀌었을 때만 다시 쓴다
/// (매번 쓰면 파일 mtime 이 바뀌어 java 가 캐시를 못 쓴다).
fn bridge_source_path() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".myspace").join("jdbc-bridge");
    std::fs::create_dir_all(&dir).map_err(|e| format!("브리지 폴더 생성 실패: {e}"))?;
    let path = dir.join("MySpaceJdbcBridge.java");
    let same = std::fs::read_to_string(&path)
        .map(|cur| cur == BRIDGE_SRC)
        .unwrap_or(false);
    if !same {
        std::fs::write(&path, BRIDGE_SRC).map_err(|e| format!("브리지 소스 저장 실패: {e}"))?;
    }
    Ok(path)
}

/// 실행에 쓸 `java`. JAVA_HOME → PATH → /usr/libexec/java_home 순.
///
/// `standalone.rs` 의 `java_binary` 와 같은 순서지만 그쪽은 IntelliJ 프로젝트 SDK 를
/// 먼저 본다. 여기는 프로젝트와 무관하므로 따로 둔다.
fn java_binary() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(home).join("bin").join("java");
        if p.is_file() {
            return Ok(p);
        }
    }
    if let Ok(out) = Command::new("/usr/bin/which").arg("java").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() && Path::new(&s).is_file() {
            return Ok(PathBuf::from(s));
        }
    }
    if let Ok(out) = Command::new("/usr/libexec/java_home").output() {
        if out.status.success() {
            let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let p = PathBuf::from(home).join("bin").join("java");
            if p.is_file() {
                return Ok(p);
            }
        }
    }
    Err("java 를 찾을 수 없습니다. JDK 11 이상을 설치하고 JAVA_HOME 을 설정하세요.\n\
         (데이터베이스 뷰어는 JDBC 드라이버로 붙기 때문에 Java 가 필요합니다.)"
        .into())
}

/// 살아 있는 브리지를 준다. 없으면 띄운다.
fn bridge() -> Result<Arc<Bridge>, String> {
    let mut guard = slot().lock().unwrap();
    if let Some(b) = guard.as_ref() {
        if b.alive.load(Ordering::SeqCst) {
            return Ok(b.clone());
        }
    }
    let b = spawn_bridge()?;
    *guard = Some(b.clone());
    Ok(b)
}

/// 브리지가 이미 떠 있는가. **띄우지 않는다** — 아무도 연결하지 않았는데 JVM 100여 MB 를
/// 올리는 것은 `db_bridge_info` 가 `java -version` 만 부르는 것과 같은 이유로 피한다.
fn bridge_running() -> bool {
    slot()
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|b| b.alive.load(Ordering::SeqCst))
}

fn spawn_bridge() -> Result<Arc<Bridge>, String> {
    let src = bridge_source_path()?;
    let java = java_binary()?;

    let mut child = Command::new(&java)
        .arg(&src)
        // 상대 경로 JDBC URL(예: H2 의 `jdbc:h2:./db`)이 예측 가능한 곳을 가리키도록.
        .current_dir(home_dir()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("JDBC 브리지 실행 실패({}): {e}", java.display()))?;

    let stdin = child.stdin.take().ok_or("브리지 stdin 을 열 수 없습니다.")?;
    let stdout = child.stdout.take().ok_or("브리지 stdout 을 열 수 없습니다.")?;
    let stderr = child.stderr.take().ok_or("브리지 stderr 을 열 수 없습니다.")?;

    let bridge = Arc::new(Bridge {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        child: Mutex::new(child),
    });

    // ── 응답 읽기 ──
    {
        let b = bridge.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(e) => {
                        log::warn!("JDBC 브리지 stdout 읽기 실패: {e}");
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        // 프로토콜 밖의 출력. 브리지가 System.out 을 stderr 로 돌려 두므로
                        // 여기 오면 안 되지만, 와도 대화가 끊기지는 않게 흘려 보낸다.
                        log::warn!("JDBC 브리지 응답 파싱 실패({e}): {}", truncate(&line, 300));
                        continue;
                    }
                };
                let id = msg.get("id").and_then(|v| v.as_u64());
                let Some(id) = id else { continue };
                let tx = b.pending.lock().unwrap().remove(&id);
                let Some(tx) = tx else { continue };
                let result = if msg.get("ok").and_then(|v| v.as_bool()) == Some(true) {
                    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    Err(msg
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("알 수 없는 오류")
                        .to_string())
                };
                let _ = tx.send(result);
            }
            // EOF = 브리지 종료.
            b.alive.store(false, Ordering::SeqCst);
            b.fail_all("JDBC 브리지가 종료됐습니다. 다시 시도하면 재시작합니다.");
            let mut guard = slot().lock().unwrap();
            // 이미 새 브리지로 교체됐을 수 있으므로 내 것일 때만 비운다.
            if guard.as_ref().map(|cur| Arc::ptr_eq(cur, &b)).unwrap_or(false) {
                *guard = None;
            }
        });
    }

    // ── stderr 배수 ──
    // 읽지 않으면 파이프가 차서 브리지가 멈춘다.
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                log::warn!("[jdbc-bridge] {}", truncate(&line, 500));
            }
        }
    });

    Ok(bridge)
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

/// 브리지에 요청 하나를 보내고 응답을 기다린다.
async fn call(op: &str, mut args: Value) -> Result<Value, String> {
    // 죽은 브리지를 만나면 한 번은 다시 띄워 재시도한다 — 사용자가 "다시 시도"를
    // 눌러야만 살아나는 건 고장으로 보인다.
    match call_once(op, args.clone()).await {
        Err(e) if e.contains("브리지가 종료") || e.contains("전송 실패") => {
            if let Some(obj) = args.as_object_mut() {
                obj.remove("id");
            }
            call_once(op, args).await
        }
        other => other,
    }
}

async fn call_once(op: &str, args: Value) -> Result<Value, String> {
    let b = bridge()?;
    let id = b.next_id.fetch_add(1, Ordering::SeqCst);

    let mut req = match args {
        Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    req.insert("id".into(), json!(id));
    req.insert("op".into(), json!(op));
    let mut line = serde_json::to_string(&Value::Object(req))
        .map_err(|e| format!("요청 직렬화 실패: {e}"))?;
    line.push('\n');

    let (tx, rx) = oneshot::channel();
    b.pending.lock().unwrap().insert(id, tx);

    {
        let mut stdin = b.stdin.lock().unwrap();
        if let Err(e) = stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()) {
            b.pending.lock().unwrap().remove(&id);
            b.alive.store(false, Ordering::SeqCst);
            return Err(format!("JDBC 브리지 전송 실패: {e}"));
        }
    }

    match tokio::time::timeout(std::time::Duration::from_secs(CALL_TIMEOUT_SECS), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("JDBC 브리지 응답이 유실됐습니다.".into()),
        Err(_) => {
            b.pending.lock().unwrap().remove(&id);
            Err(format!(
                "응답이 {CALL_TIMEOUT_SECS}초 안에 오지 않았습니다. 쿼리를 취소하거나 다시 연결하세요."
            ))
        }
    }
}

/* ════════════════════════════ 자격증명 저장 ════════════════════════════ */
//
// 비밀번호는 프론트(localStorage)에 두지 않는다. 접속 정보의 나머지는 localStorage 가
// 갖고, 비밀번호만 여기서 기기에 묶인 키로 암호화해 0600 파일에 넣는다.
//
// ⚠️ flex.rs 에도 같은 모양의 암·복호화가 있지만 **일부러 공유하지 않는다.**
//    키 유도에 쓰는 네임스페이스를 공유하면 한쪽을 바꿀 때 다른 쪽의 저장값이
//    통째로 못 읽는 값이 된다. 여기 것은 여기서 끝난다.

fn secrets_path() -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".myspace");
    std::fs::create_dir_all(&dir).map_err(|e| format!("설정 폴더 생성 실패: {e}"))?;
    Ok(dir.join("db-secrets.json"))
}

/// 이 맥에 묶인 비밀 문자열. 하드웨어 UUID 를 쓰고, 못 읽으면 고정값으로 떨어진다.
fn machine_secret() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            if let Ok(text) = String::from_utf8(out.stdout) {
                if let Some(line) = text.lines().find(|l| l.contains("IOPlatformUUID")) {
                    if let Some(uuid) = line.split('"').nth(3) {
                        return format!("myspace-db:{uuid}");
                    }
                }
            }
        }
    }
    "myspace-db:fallback".to_string()
}

fn derive_key_iv() -> ([u8; 16], [u8; 16]) {
    let secret = machine_secret();
    let mut key = [0u8; 16];
    let mut iv = [0u8; 16];
    pbkdf2_hmac::<Sha1>(secret.as_bytes(), b"myspace-db-key", 4096, &mut key);
    pbkdf2_hmac::<Sha1>(secret.as_bytes(), b"myspace-db-iv", 4096, &mut iv);
    (key, iv)
}

fn encrypt(plain: &str) -> String {
    let (key, iv) = derive_key_iv();
    let ct = Aes128CbcEnc::new(GenericArray::from_slice(&key), GenericArray::from_slice(&iv))
        .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(ct)
}

fn decrypt(enc: &str) -> Option<String> {
    if enc.is_empty() {
        return None;
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(enc).ok()?;
    let (key, iv) = derive_key_iv();
    let pt = Aes128CbcDec::new(GenericArray::from_slice(&key), GenericArray::from_slice(&iv))
        .decrypt_padded_vec_mut::<Pkcs7>(&raw)
        .ok()?;
    String::from_utf8(pt).ok()
}

fn read_secrets() -> HashMap<String, String> {
    secrets_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

fn write_secrets(map: &HashMap<String, String>) -> Result<(), String> {
    let path = secrets_path()?;
    let body = serde_json::to_string(map).map_err(|e| format!("직렬화 실패: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("저장 실패: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn saved_password(conn_id: &str) -> Option<String> {
    read_secrets().get(conn_id).and_then(|e| decrypt(e))
}

fn save_password(conn_id: &str, password: &str) -> Result<(), String> {
    let mut map = read_secrets();
    map.insert(conn_id.to_string(), encrypt(password));
    write_secrets(&map)
}

fn forget_password(conn_id: &str) -> Result<(), String> {
    let mut map = read_secrets();
    map.remove(conn_id);
    write_secrets(&map)
}

/* ════════════════════════════ 드라이버 jar 탐색 ════════════════════════════ */

/// 엔진 하나가 쓸 수 있는 메이븐 좌표들. `(그룹 경로, 아티팩트)`.
///
/// ~/.m2 전체를 훑지 않고 이 좌표만 확인한다 — 메이븐 저장소는 디렉터리가 수만 개라
/// 전체 순회는 눈에 띄게 느리고, 좌표를 알면 그럴 이유가 없다.
fn artifacts_for(engine: &str) -> &'static [(&'static str, &'static str)] {
    match engine {
        "mysql" => &[
            ("com/mysql", "mysql-connector-j"),
            ("mysql", "mysql-connector-java"),
            ("org/mariadb/jdbc", "mariadb-java-client"),
        ],
        "mariadb" => &[
            ("org/mariadb/jdbc", "mariadb-java-client"),
            ("com/mysql", "mysql-connector-j"),
        ],
        "postgresql" => &[("org/postgresql", "postgresql")],
        "oracle" => &[
            ("com/oracle/database/jdbc", "ojdbc17"),
            ("com/oracle/database/jdbc", "ojdbc11"),
            ("com/oracle/database/jdbc", "ojdbc8"),
        ],
        "h2" => &[("com/h2database", "h2")],
        "sqlite" => &[("org/xerial", "sqlite-jdbc")],
        _ => &[],
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverJar {
    /// jar 절대 경로.
    pub path: String,
    /// 표시용 이름(파일명).
    pub name: String,
    /// 추정 버전(디렉터리 이름).
    pub version: String,
    /// 어디서 찾았는지 — "maven" | "gradle".
    pub source: String,
}

/// `-sources` / `-javadoc` 처럼 실행에 쓸 수 없는 jar 를 걸러낸다.
fn is_runnable_jar(name: &str) -> bool {
    name.ends_with(".jar")
        && !name.ends_with("-sources.jar")
        && !name.ends_with("-javadoc.jar")
        && !name.ends_with("-tests.jar")
}

fn scan_maven(group: &str, artifact: &str, out: &mut Vec<DriverJar>) {
    let Ok(home) = home_dir() else { return };
    let base = home.join(".m2").join("repository").join(group).join(artifact);
    let Ok(versions) = std::fs::read_dir(&base) else {
        return;
    };
    for v in versions.flatten() {
        let vdir = v.path();
        if !vdir.is_dir() {
            continue;
        }
        let version = v.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(&vdir) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if is_runnable_jar(&name) {
                out.push(DriverJar {
                    path: f.path().to_string_lossy().to_string(),
                    name,
                    version: version.clone(),
                    source: "maven".into(),
                });
            }
        }
    }
}

/// 그레이들 캐시는 `files-2.1/<그룹.점표기>/<아티팩트>/<버전>/<해시>/<파일>.jar` 구조라
/// 버전 아래에 해시 디렉터리가 한 겹 더 있다.
fn scan_gradle(group: &str, artifact: &str, out: &mut Vec<DriverJar>) {
    let Ok(home) = home_dir() else { return };
    let dotted = group.replace('/', ".");
    let base = home
        .join(".gradle/caches/modules-2/files-2.1")
        .join(dotted)
        .join(artifact);
    let Ok(versions) = std::fs::read_dir(&base) else {
        return;
    };
    for v in versions.flatten() {
        let vdir = v.path();
        if !vdir.is_dir() {
            continue;
        }
        let version = v.file_name().to_string_lossy().to_string();
        let Ok(hashes) = std::fs::read_dir(&vdir) else {
            continue;
        };
        for h in hashes.flatten() {
            let Ok(files) = std::fs::read_dir(h.path()) else {
                continue;
            };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if is_runnable_jar(&name) {
                    out.push(DriverJar {
                        path: f.path().to_string_lossy().to_string(),
                        name,
                        version: version.clone(),
                        source: "gradle".into(),
                    });
                }
            }
        }
    }
}

/// 버전 문자열 비교(숫자 구간은 수치로). 최신이 앞에 오도록 정렬할 때 쓴다.
fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

/* ════════════════════════════ Tauri 명령 ════════════════════════════ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInfo {
    pub java_path: Option<String>,
    pub java_version: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

/// Java 를 쓸 수 있는지 확인한다(뷰가 마운트될 때 한 번).
///
/// ⚠️ 여기서 브리지를 띄우면 안 된다. 이 명령은 데이터베이스 뷰어 탭을 **열기만 해도**
///    불리는데, 브리지는 100여 MB 짜리 JVM 이라 접속도 안 한 채로 상주시킬 이유가 없다
///    (트레이에 항상 떠 있는 앱이다). 그래서 `java -version` 만 물어보고 끝낸다 —
///    실제로 붙을 수 있는지는 연결할 때 확인되고, 실패하면 그 자리에서 사유가 나온다.
#[tauri::command]
pub async fn db_bridge_info() -> BridgeInfo {
    let java = match java_binary() {
        Ok(p) => p,
        Err(e) => {
            return BridgeInfo {
                java_path: None,
                java_version: None,
                ok: false,
                error: Some(e),
            }
        }
    };
    // `java -version` 은 stderr 로 나온다(예전부터 그렇다).
    let version = Command::new(&java)
        .arg("-version")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
        .and_then(|s| s.lines().next().map(str::to_string));

    BridgeInfo {
        java_path: Some(java.to_string_lossy().to_string()),
        java_version: version,
        ok: true,
        error: None,
    }
}

/// 엔진에 맞는 드라이버 jar 를 로컬 메이븐/그레이들 캐시에서 찾는다. 최신 버전이 앞.
#[tauri::command]
pub async fn db_find_drivers(engine: String) -> Vec<DriverJar> {
    let mut out = Vec::new();
    for (group, artifact) in artifacts_for(&engine) {
        scan_maven(group, artifact, &mut out);
        scan_gradle(group, artifact, &mut out);
    }
    // 같은 jar 가 메이븐·그레이들 양쪽에 있으면 파일명 기준으로 하나만 남긴다.
    out.sort_by(|a, b| {
        version_key(&b.version)
            .cmp(&version_key(&a.version))
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut seen = std::collections::HashSet::new();
    out.retain(|j| seen.insert(j.name.clone()));
    out
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub conn_id: String,
    pub url: String,
    #[serde(default)]
    pub user: Option<String>,
    /// 비어 있으면 저장해 둔 비밀번호를 쓴다.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub driver_class: Option<String>,
    #[serde(default)]
    pub jars: Vec<String>,
    /// 접속 성공 시 비밀번호를 기기 암호화해 저장할지.
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub props: Option<Value>,
}

/// 접속. 비밀번호가 비어 있으면 저장된 것을 쓰고, `savePassword` 면 성공 후 저장한다.
#[tauri::command]
pub async fn db_connect(req: ConnectRequest) -> Result<Value, String> {
    let password = match req.password.as_deref() {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => saved_password(&req.conn_id).unwrap_or_default(),
    };

    let result = call(
        "connect",
        json!({
            "connId": req.conn_id,
            "url": req.url,
            "user": req.user,
            "password": password,
            "driverClass": req.driver_class,
            "jars": req.jars,
            "props": req.props,
        }),
    )
    .await?;

    // 저장은 접속에 성공한 뒤에만 — 틀린 비밀번호를 남겨 두면 다음 자동 접속이 계속 실패한다.
    if req.save_password {
        if password.is_empty() {
            let _ = forget_password(&req.conn_id);
        } else if let Err(e) = save_password(&req.conn_id, &password) {
            log::warn!("DB 비밀번호 저장 실패: {e}");
        }
    }
    Ok(result)
}

/// 이미 열려 있는 접속의 정보. 없으면 `null`(오류가 아니다).
///
/// `connId` 는 브리지 접속 맵의 키이고 **화면 사이에 공유된다.** 그래서 화면 하나가
/// `db_connect` 를 다시 부르면 브리지가 앞의 `java.sql.Connection` 을 먼저 닫는데,
/// 그때 다른 화면이 열어 둔 트랜잭션이 조용히 롤백된다. 붙이기 전에 이걸 물어보고
/// 살아 있으면 그대로 쓰라는 뜻으로 만든 명령이다.
///
/// 브리지가 떠 있지 않으면 **띄우지 않고** 곧바로 `null` 이다 — 아무도 연결하지 않은
/// 상태에서 화면을 여는 것만으로 JVM 이 뜨면 안 된다.
#[tauri::command]
pub async fn db_conn_info(conn_id: String) -> Result<Value, String> {
    if !bridge_running() {
        return Ok(Value::Null);
    }
    call("connInfo", json!({ "connId": conn_id })).await
}

/// 접속 해제. **마지막 접속이 끊기면 브리지(JVM)도 내린다.**
///
/// 트레이 상주 앱이라 아무도 쓰지 않는 JVM 100여 MB 를 계속 물고 있을 이유가 없다.
/// 다음 연결이 알아서 다시 띄운다(첫 요청에 1~2초 — 소스 모드 컴파일 비용).
#[tauri::command]
pub async fn db_disconnect(conn_id: String) -> Result<Value, String> {
    let result = call("disconnect", json!({ "connId": conn_id })).await?;
    if result.get("remaining").and_then(|v| v.as_u64()) == Some(0) {
        shutdown_bridge();
    }
    Ok(result)
}

/// 브리지 프로세스를 내리고 전역 핸들을 비운다.
fn shutdown_bridge() {
    let taken = slot().lock().unwrap().take();
    let Some(b) = taken else { return };
    b.alive.store(false, Ordering::SeqCst);
    // stdin 을 닫으면 브리지가 스스로 정리하고 나간다(처리 중인 요청까지 마친 뒤).
    // 그래도 안 죽는 경우를 대비해 kill 까지 한다.
    if let Ok(mut child) = b.child.lock() {
        let _ = child.kill();
        let _ = child.wait();
    }
    b.fail_all("브리지를 내렸습니다.");
}

/// 저장해 둔 비밀번호가 있는지(비밀번호 자체는 절대 프론트로 넘기지 않는다).
#[tauri::command]
pub async fn db_has_password(conn_id: String) -> bool {
    saved_password(&conn_id).is_some_and(|p| !p.is_empty())
}

#[tauri::command]
pub async fn db_forget_password(conn_id: String) -> Result<(), String> {
    forget_password(&conn_id)
}

#[tauri::command]
pub async fn db_schemas(conn_id: String) -> Result<Value, String> {
    call("schemas", json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_tables(
    conn_id: String,
    catalog: Option<String>,
    schema: Option<String>,
) -> Result<Value, String> {
    call(
        "tables",
        json!({ "connId": conn_id, "catalog": catalog, "schema": schema }),
    )
    .await
}

#[tauri::command]
pub async fn db_table_meta(
    conn_id: String,
    catalog: Option<String>,
    schema: Option<String>,
    table: String,
) -> Result<Value, String> {
    call(
        "tableMeta",
        json!({ "connId": conn_id, "catalog": catalog, "schema": schema, "table": table }),
    )
    .await
}

#[tauri::command]
pub async fn db_query(
    conn_id: String,
    sql: String,
    limit: u32,
    token: Option<String>,
) -> Result<Value, String> {
    call(
        "query",
        json!({ "connId": conn_id, "sql": sql, "limit": limit, "token": token }),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn db_table_rows(
    conn_id: String,
    catalog: Option<String>,
    schema: Option<String>,
    table: String,
    limit: u32,
    offset: u32,
    order_by: Option<String>,
    where_clause: Option<String>,
    token: Option<String>,
) -> Result<Value, String> {
    call(
        "tableRows",
        json!({
            "connId": conn_id, "catalog": catalog, "schema": schema, "table": table,
            "limit": limit, "offset": offset, "orderBy": order_by,
            "where": where_clause, "token": token,
        }),
    )
    .await
}

#[tauri::command]
pub async fn db_count(
    conn_id: String,
    catalog: Option<String>,
    schema: Option<String>,
    table: String,
    where_clause: Option<String>,
) -> Result<Value, String> {
    call(
        "count",
        json!({
            "connId": conn_id, "catalog": catalog, "schema": schema,
            "table": table, "where": where_clause,
        }),
    )
    .await
}

/// 보류 중이던 편집을 적용한다. 자세한 트랜잭션 정책은 브리지의 `opApplyChanges` 주석 참고.
#[tauri::command]
pub async fn db_apply_changes(conn_id: String, changes: Value) -> Result<Value, String> {
    call("applyChanges", json!({ "connId": conn_id, "changes": changes })).await
}

#[tauri::command]
pub async fn db_set_auto_commit(conn_id: String, on: bool) -> Result<Value, String> {
    call("setAutoCommit", json!({ "connId": conn_id, "on": on })).await
}

#[tauri::command]
pub async fn db_commit(conn_id: String) -> Result<Value, String> {
    call("commit", json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_rollback(conn_id: String) -> Result<Value, String> {
    call("rollback", json!({ "connId": conn_id })).await
}

#[tauri::command]
pub async fn db_cancel(conn_id: String, token: String) -> Result<Value, String> {
    call("cancel", json!({ "connId": conn_id, "token": token })).await
}

/// 브리지를 강제로 내린다. 다음 호출이 새로 띄운다.
#[tauri::command]
pub async fn db_restart_bridge() -> Result<(), String> {
    shutdown_bridge();
    Ok(())
}

/* ════════════════════════════ 테스트 ════════════════════════════ */

#[cfg(test)]
mod tests {
    use super::*;

    /// 저장한 비밀번호가 그대로 복원돼야 한다(한글·기호 포함).
    #[test]
    fn encrypts_and_decrypts_a_password() {
        let enc = encrypt("p@ss워드!#$");
        assert_ne!(enc, "p@ss워드!#$", "평문이 그대로 남으면 안 된다");
        assert_eq!(decrypt(&enc).as_deref(), Some("p@ss워드!#$"));
    }

    /// 빈 문자열·깨진 base64 는 None (저장된 적 없는 접속과 구분되지 않아야 한다).
    #[test]
    fn rejects_garbage_ciphertext() {
        assert_eq!(decrypt(""), None);
        assert_eq!(decrypt("not-base64!!"), None);
    }

    /// `-sources` / `-javadoc` jar 는 클래스패스에 올리면 안 된다.
    #[test]
    fn filters_non_runnable_jars() {
        assert!(is_runnable_jar("ojdbc17-23.7.0.jar"));
        assert!(!is_runnable_jar("ojdbc17-23.7.0-sources.jar"));
        assert!(!is_runnable_jar("h2-2.3.232-javadoc.jar"));
        assert!(!is_runnable_jar("h2-2.3.232.pom"));
    }

    /// 버전 정렬이 문자열 비교가 아니라 수치 비교여야 한다 — 그렇지 않으면 9.7 이 10.2 보다 뒤에 온다.
    #[test]
    fn sorts_versions_numerically() {
        assert!(version_key("10.2.0") > version_key("9.7.0"));
        assert!(version_key("23.7.0.25.01") > version_key("23.6.0"));
    }

    /// 엔진마다 좌표가 붙어 있어야 한다(오타가 나면 드라이버가 조용히 안 잡힌다).
    #[test]
    fn every_supported_engine_has_artifacts() {
        for e in ["mysql", "mariadb", "postgresql", "oracle", "h2", "sqlite"] {
            assert!(!artifacts_for(e).is_empty(), "{e} 에 좌표가 없다");
        }
        assert!(artifacts_for("unknown").is_empty());
    }

    /// 소스를 풀고 브리지를 띄워 대화가 되는지. Java 설치가 필요해 기본에서는 건너뛴다.
    ///
    ///   cargo test --lib db::tests::talks_to_a_real_bridge -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "Java 설치 필요"]
    async fn talks_to_a_real_bridge() {
        let pong = call("ping", json!({})).await.expect("ping 실패");
        assert!(
            pong.get("javaVersion").and_then(|v| v.as_str()).is_some(),
            "javaVersion 이 없다: {pong}"
        );
    }

    /// H2 로 조회 → 수정 → 재조회까지 Rust 레이어를 통해 끝까지 돈다.
    /// H2 드라이버 jar 가 로컬 캐시에 있어야 하므로 기본에서는 건너뛴다.
    ///
    ///   cargo test --lib db::tests::round_trips_against_h2 -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "Java + H2 드라이버 jar 필요"]
    async fn round_trips_against_h2() {
        let jars = db_find_drivers("h2".into()).await;
        assert!(!jars.is_empty(), "H2 드라이버 jar 를 찾지 못했다");
        let jar = jars[0].path.clone();

        let dir = std::env::temp_dir().join("myspace-db-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("roundtrip");
        // 앞선 실행이 남긴 파일이 있으면 CREATE TABLE 이 실패한다.
        let _ = std::fs::remove_file(dir.join("roundtrip.mv.db"));

        let conn_id = "test-h2";
        call(
            "connect",
            json!({
                "connId": conn_id,
                "url": format!("jdbc:h2:{}", file.display()),
                "user": "sa",
                "password": "",
                "driverClass": "org.h2.Driver",
                "jars": [jar],
            }),
        )
        .await
        .expect("접속 실패");

        for sql in [
            "CREATE TABLE t(id INT PRIMARY KEY, name VARCHAR(30))",
            "INSERT INTO t VALUES (1,'before')",
        ] {
            call("query", json!({ "connId": conn_id, "sql": sql, "limit": 10 }))
                .await
                .unwrap_or_else(|e| panic!("{sql} 실패: {e}"));
        }

        // BIGINT/DECIMAL 정밀도 때문에 셀 값은 전부 문자열로 와야 한다.
        let rows = call(
            "tableRows",
            json!({ "connId": conn_id, "schema": "PUBLIC", "table": "T", "limit": 10, "offset": 0 }),
        )
        .await
        .expect("조회 실패");
        assert_eq!(rows["rows"][0][1], json!("before"));

        call(
            "applyChanges",
            json!({
                "connId": conn_id,
                "changes": [{
                    "op": "update", "schema": "PUBLIC", "table": "T",
                    "keys": {"ID": "1"}, "values": {"NAME": "after"},
                }],
            }),
        )
        .await
        .expect("수정 실패");

        let rows = call(
            "tableRows",
            json!({ "connId": conn_id, "schema": "PUBLIC", "table": "T", "limit": 10, "offset": 0 }),
        )
        .await
        .expect("재조회 실패");
        assert_eq!(rows["rows"][0][1], json!("after"), "수정이 반영되지 않았다");

        // 없는 행을 지우려 하면 0행이라 통째로 롤백돼야 한다.
        let err = call(
            "applyChanges",
            json!({
                "connId": conn_id,
                "changes": [{
                    "op": "delete", "schema": "PUBLIC", "table": "T", "keys": {"ID": "404"},
                }],
            }),
        )
        .await
        .expect_err("0행 삭제가 성공하면 안 된다");
        assert!(err.contains("찾지 못했"), "예상 밖 오류: {err}");

        let closed = db_disconnect(conn_id.into()).await.expect("해제 실패");
        assert_eq!(closed["remaining"], json!(0), "남은 접속 수가 틀렸다");
        // 마지막 접속이 끊기면 브리지가 내려가고, 다음 호출이 새로 띄워야 한다.
        assert!(
            slot().lock().unwrap().is_none(),
            "마지막 접속 해제 후에도 브리지가 남아 있다"
        );
        call("ping", json!({})).await.expect("브리지 재기동 실패");
        shutdown_bridge();
    }
}
