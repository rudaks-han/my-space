//! IntelliJ 를 **띄우지 않고** 실행 설정을 그대로 기동한다.
//!
//! `src/intellij.rs` 는 IDE 의 MCP 서버에 실행을 시키는 쪽이고, 이 모듈은 같은 실행
//! 설정을 우리가 직접 `java` 로 띄우는 쪽이다. 둘은 같은 `.idea/runConfigurations/*.xml`
//! 을 읽으므로 프로필·VM 옵션·클래스패스 수정이 IDE 에서 누른 것과 같다.
//!
//! **클래스패스를 어디서 얻는가가 이 모듈의 전부다.** Maven/Gradle 로 의존성을 다시
//! 해석하면 IDE 와 어긋날 여지가 계속 생기고(모듈 590개짜리 리액터는 느리기도 하다),
//! 그렇다고 손으로 적을 수도 없다. 답은 **IntelliJ 가 이미 해석해서 디스크에 적어 둔
//! 프로젝트 모델을 그대로 읽는 것**이다. IDE 프로세스는 필요 없다 — 파일만 있으면 된다.
//!
//! - `~/Library/Caches/JetBrains/<IDE>/projects/<이름>.<해시>/external_build_system/`
//!   - `project/modules.xml`   — 모듈명 → `.iml` 경로(= 모듈 디렉터리)
//!   - `modules/<모듈>.xml`     — 출력 경로(`target/classes`), 모듈·라이브러리 의존성, scope
//!   - `project/libraries.xml` — `Maven: g:a:v` → `$MAVEN_REPOSITORY$/…jar` 실제 경로
//!   - `cache-state.xml`       — **어느 프로젝트의 캐시인지**. 같은 폴더명(cowork)이 여러 개
//!     있어서(`spectrakr/cowork` 와 `_ENOMIX_GIT/cowork`) 이 파일로 가려내지 않으면
//!     남의 프로젝트 클래스패스로 띄우게 된다.
//! - External storage 를 쓰지 않는 프로젝트는 같은 내용이 `.idea/modules.xml` +
//!   `<모듈>.iml` + `.idea/libraries/*.xml` 로 프로젝트 안에 있다. 형식이 같아 파서를 공유한다.
//! - JDK 는 `.idea/misc.xml` 의 `project-jdk-name` → `options/jdk.table.xml` 의 `homePath`.
//!
//! **컴파일(Make)은 하지 않는다.** IDE 의 Run 버튼은 실행 전에 Make 를 돌리지만 여기서는
//! `target/classes` 에 이미 있는 것을 그대로 띄운다. 서비스 스택을 올려 두고 그 위에서
//! 한 모듈만 개발하는 게 이 기능의 쓰임새라, 매번 590 모듈 리액터를 도는 건 손해다.
//! 대신 **클래스 출력이 없는 모듈은 시작 로그에 이름을 찍어** 준다 — 조용히 `NoClassDefFound`
//! 로 죽는 것보다 낫다.
//!
//! IDE 를 거치지 않으니 `intellij.rs` 가 감당하던 것들이 통째로 사라진다: 프로세스는
//! 우리 자식이라 pid 를 찾을 필요가 없고(메인 클래스로 `ps` 를 뒤지지 않는다), 콘솔은
//! 파이프로 직접 읽으므로 "Save console output to file" 을 켤 필요가 없으며, 중지는
//! 자식에게 SIGINT 를 보내면 끝이다.

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::intellij::{
    detect_failure, expand_macros, expected_port, home_dir, is_alive, is_started_line,
    leaf_configs, listening_ports, pick_any_port, pick_service_port, ps_list, read_metas,
    read_port_map, signal_tree, Meta, Service, Sig, LOG_BUFFER_MAX, POLL, PORT_FALLBACK_AFTER,
    STOP_GRACE, STOP_TIMEOUT,
};

/// 포트 감시를 포기하는 시각. 이때까지 LISTEN 이 없으면 포트 없이 그냥 실행 중으로 둔다.
const PORT_WATCH_LIMIT: Duration = Duration::from_secs(180);
/// 순차 실행에서 한 단계가 뜨기를 기다리는 최대 시간.
const STAGE_TIMEOUT: Duration = Duration::from_secs(300);
/// 흡수한 프로세스(= `wait` 할 수 없는 것)의 생존 확인 주기.
/// 우리 자식은 `wait` 로 즉시 알 수 있으니 이 폴링은 재기동 후에만 돌고, 그마저도
/// 서비스 몇 개뿐이라 `POLL`(500ms)까지 촘촘할 필요가 없다.
const ORPHAN_POLL: Duration = Duration::from_secs(1);

// ─────────────────────────────── 상태 ───────────────────────────────

/// 우리가 띄운 프로세스 하나.
#[derive(Clone, Copy)]
pub struct Run {
    pid: u32,
    port: Option<u16>,
}

/// 실행 중인 서비스: 설정 이름 → 우리가 띄운 JVM.
#[derive(Default)]
pub struct StandaloneState(pub Mutex<HashMap<String, Run>>);

/// 한 번의 실행에서 로그로 관찰한 신호(`intellij.rs` 의 같은 이름과 같은 역할).
#[derive(Default, Clone)]
struct Outcome {
    started: bool,
    fail_reason: Option<String>,
}

/// 실행 판정용 부가 상태.
#[derive(Default)]
pub struct StandaloneTracking {
    /// 사용자가 명시적으로 내리는 중인 이름(종료를 실패로 오판하지 않게).
    stopping: Mutex<HashSet<String>>,
    outcome: Mutex<HashMap<String, Outcome>>,
    /// 서비스별 로그 버퍼(오래된 줄부터 버린다). 뷰를 벗어나도 남는다.
    logs: Mutex<HashMap<String, VecDeque<String>>>,
    /// 직전 실행의 결과: 이름 → 실패 사유(정상 중지면 None). 순차 실행이 읽는다.
    exits: Mutex<HashMap<String, Option<String>>>,
}

/// 순차 실행 상태.
#[derive(Default)]
pub struct StandaloneSequence {
    running: Mutex<bool>,
    cancel: Mutex<bool>,
    last: Mutex<Option<SequencePayload>>,
}

// ─────────────────────────────── 이벤트 ───────────────────────────────

#[derive(Serialize, Clone)]
struct StatusPayload {
    name: String,
    running: bool,
    pid: Option<u32>,
    port: Option<u16>,
    failed: Option<String>,
}

#[derive(Serialize, Clone)]
struct LogPayload {
    name: String,
    line: String,
}

#[derive(Serialize, Clone)]
pub struct SequencePayload {
    stage: usize,
    total: usize,
    names: Vec<String>,
    phase: String,
    message: Option<String>,
}

#[derive(Serialize)]
pub struct SequenceStatus {
    running: bool,
    last: Option<SequencePayload>,
}

/// 화면 상단 배지용 — 프로젝트 모델을 읽을 수 있는지.
/// (`intellij.rs` 의 `McpStatus` 와 같은 모양이라 프론트가 같은 컴포넌트를 쓴다.)
#[derive(Serialize, Clone)]
pub struct ModelStatus {
    connected: bool,
    url: Option<String>,
    error: Option<String>,
}

/// 실행 중인 서비스 하나(목록 복원용).
#[derive(Serialize, Clone)]
pub struct Running {
    name: String,
    pid: u32,
    port: Option<u16>,
}

// ─────────────────────────── 로그 · 상태 방출 ───────────────────────────

fn emit_log(app: &tauri::AppHandle, name: &str, line: &str) {
    if let Some(t) = app.try_state::<StandaloneTracking>() {
        let mut map = t.logs.lock().unwrap();
        let buf = map.entry(name.to_string()).or_default();
        if buf.len() >= LOG_BUFFER_MAX {
            buf.pop_front();
        }
        buf.push_back(line.to_string());
    }
    let _ = app.emit(
        "standalone:log",
        LogPayload {
            name: name.to_string(),
            line: line.to_string(),
        },
    );
}

fn emit_status(app: &tauri::AppHandle, payload: StatusPayload) {
    let _ = app.emit("standalone:status", payload);
}

fn mark_running(app: &tauri::AppHandle, name: &str, pid: u32) {
    if let Some(s) = app.try_state::<StandaloneState>() {
        s.0.lock()
            .unwrap()
            .insert(name.to_string(), Run { pid, port: None });
    }
    emit_status(
        app,
        StatusPayload {
            name: name.to_string(),
            running: true,
            pid: Some(pid),
            port: None,
            failed: None,
        },
    );
}

fn update_port(app: &tauri::AppHandle, name: &str, pid: u32, port: u16) {
    if let Some(s) = app.try_state::<StandaloneState>() {
        let mut map = s.0.lock().unwrap();
        match map.get_mut(name) {
            // 그 사이 다른 실행으로 바뀌었으면(재시작) 늦은 포트를 덮어쓰지 않는다.
            Some(run) if run.pid == pid => run.port = Some(port),
            _ => return,
        }
    }
    emit_status(
        app,
        StatusPayload {
            name: name.to_string(),
            running: true,
            pid: Some(pid),
            port: Some(port),
            failed: None,
        },
    );
}

fn mark_stopped(app: &tauri::AppHandle, name: &str, failed: Option<String>) {
    if let Some(s) = app.try_state::<StandaloneState>() {
        s.0.lock().unwrap().remove(name);
    }
    if let Some(t) = app.try_state::<StandaloneTracking>() {
        t.exits
            .lock()
            .unwrap()
            .insert(name.to_string(), failed.clone());
        t.stopping.lock().unwrap().remove(name);
    }
    emit_status(
        app,
        StatusPayload {
            name: name.to_string(),
            running: false,
            pid: None,
            port: None,
            failed,
        },
    );
}

/// 새 실행을 시작하기 전에 이전 판정 흔적을 지운다.
fn reset_tracking(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<StandaloneTracking>() {
        t.stopping.lock().unwrap().remove(name);
        t.outcome.lock().unwrap().remove(name);
        t.exits.lock().unwrap().remove(name);
    }
}

fn mark_stopping(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<StandaloneTracking>() {
        t.stopping.lock().unwrap().insert(name.to_string());
    }
}

fn is_stopping(app: &tauri::AppHandle, name: &str) -> bool {
    app.try_state::<StandaloneTracking>()
        .map(|t| t.stopping.lock().unwrap().contains(name))
        .unwrap_or(false)
}

/// 로그 한 줄에서 성공/실패 신호를 읽어 둔다(종료 시 판정에 쓴다).
fn note_log_signal(app: &tauri::AppHandle, name: &str, line: &str) {
    let Some(t) = app.try_state::<StandaloneTracking>() else {
        return;
    };
    if is_started_line(line) {
        t.outcome
            .lock()
            .unwrap()
            .entry(name.to_string())
            .or_default()
            .started = true;
    } else if let Some(reason) = detect_failure(line) {
        let mut map = t.outcome.lock().unwrap();
        let o = map.entry(name.to_string()).or_default();
        if o.fail_reason.is_none() {
            o.fail_reason = Some(reason);
        }
    }
}

fn tracked_pid(app: &tauri::AppHandle, name: &str) -> Option<u32> {
    app.try_state::<StandaloneState>()
        .and_then(|s| s.0.lock().unwrap().get(name).map(|r| r.pid))
}

// ─────────────────────────── 프로젝트 경로 ───────────────────────────

/// 화면에서 넘어온 프로젝트 경로를 실제 경로로 확정한다.
///
/// 이 백엔드의 경로는 **설정 → Cowork 의 홈 디렉터리 하나**다(`settings.cowork.home`,
/// 스펙 문서 뷰와 같은 값이다). 최근 프로젝트 목록에서 고르는 IDE 백엔드와 달리 사용자가
/// 손으로 적은 문자열이 그대로 들어오므로, `~` 를 펼치고 무엇이 잘못됐는지 구체적으로
/// 알려 주는 일이 여기서 필요하다. "모델을 못 읽었다" 만 띄우면 경로 오타인지 임포트를
/// 안 한 것인지 구분할 수 없다.
fn resolve_project(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(
            "cowork 프로젝트 경로가 지정되지 않았습니다. 위 입력란이나 설정 → Cowork 에서 경로를 입력하세요."
                .to_string(),
        );
    }
    let path = crate::cowork::expand_home(trimmed);
    if !path.is_dir() {
        return Err(format!(
            "{} 폴더가 없습니다. cowork 프로젝트 경로를 확인하세요.",
            path.display()
        ));
    }
    if !path.join(".idea").is_dir() {
        return Err(format!(
            "{} 는 IntelliJ 프로젝트가 아닙니다(.idea 폴더가 없습니다). \
             cowork 를 클론한 폴더를 지정하세요.",
            path.display()
        ));
    }
    if !path.join(".idea").join("runConfigurations").is_dir() {
        return Err(format!(
            "{}/.idea/runConfigurations 가 없습니다. \
             IntelliJ 에서 실행 설정을 한 번 만들어(또는 저장소에서 받아) 주세요.",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().to_string())
}

// ─────────────────────────── 프로젝트 모델 ───────────────────────────

/// IntelliJ 가 디스크에 적어 둔 프로젝트 모델.
pub(crate) struct Model {
    project: PathBuf,
    /// 모델을 읽은 위치(화면 배지의 툴팁에 그대로 보여 준다).
    source: PathBuf,
    /// 모듈명 → (모듈 디렉터리, 모듈 정의 XML).
    modules: HashMap<String, (PathBuf, PathBuf)>,
    /// 라이브러리명 → jar 들.
    libraries: HashMap<String, Vec<PathBuf>>,
}

/// `~/Library/Caches/JetBrains`.
fn caches_root() -> Option<PathBuf> {
    Some(
        home_dir()
            .ok()?
            .join("Library")
            .join("Caches")
            .join("JetBrains"),
    )
}

/// `~/Library/Application Support/JetBrains`.
fn config_root() -> Option<PathBuf> {
    Some(
        home_dir()
            .ok()?
            .join("Library")
            .join("Application Support")
            .join("JetBrains"),
    )
}

/// 이 프로젝트의 external storage 폴더(`external_build_system`)를 찾는다.
///
/// 폴더 이름은 `<프로젝트 폴더명>.<해시>` 인데 해시는 재현할 수 없으므로, 같은 이름의
/// 후보를 모두 열어 `cache-state.xml` 에 **이 프로젝트의 절대경로가 들어 있는지**로
/// 가려낸다. 이 검사가 없으면 `spectrakr/cowork` 를 열고 `_ENOMIX_GIT/cowork` 의
/// 클래스패스로 띄우는 일이 실제로 생긴다(두 캐시가 이 머신에 함께 있다).
fn find_external_storage(project: &Path) -> Option<PathBuf> {
    let root = caches_root()?;
    let base = project.file_name()?.to_string_lossy().to_string();
    let needle = project.to_string_lossy().to_string();

    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for ide in fs::read_dir(&root).ok()?.flatten() {
        let projects = ide.path().join("projects");
        let Ok(entries) = fs::read_dir(&projects) else {
            continue;
        };
        for e in entries.flatten() {
            let dir = e.path();
            let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            // "<basename>.<hash>" 만 후보다(다른 프로젝트의 캐시를 열지 않게).
            if !name.starts_with(&format!("{base}.")) {
                continue;
            }
            let state = dir.join("cache-state.xml");
            match fs::read_to_string(&state) {
                Ok(text) if text.contains(&needle) => {}
                _ => continue,
            }
            let modules = dir
                .join("external_build_system")
                .join("project")
                .join("modules.xml");
            let Ok(meta) = fs::metadata(&modules) else {
                continue;
            };
            let stamp = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            // 같은 프로젝트를 여러 IDE 버전에서 연 적이 있으면 가장 최근에 갱신된 모델을 쓴다.
            if best.as_ref().is_none_or(|(t, _)| stamp > *t) {
                best = Some((stamp, dir.join("external_build_system")));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// `jar://$MAVEN_REPOSITORY$/…jar!/` 같은 IntelliJ URL 을 실제 경로로 편다.
fn expand_url(url: &str, project: &Path, m2: &Path) -> Option<PathBuf> {
    let s = url
        .trim_start_matches("jar://")
        .trim_start_matches("file://")
        .trim_end_matches("!/");
    let s = s
        .replace("$MAVEN_REPOSITORY$", &m2.to_string_lossy())
        .replace("$PROJECT_DIR$", &project.to_string_lossy());
    let s = if let Some(rest) = s.strip_prefix("$USER_HOME$") {
        home_dir().ok()?.join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(s)
    };
    // 소스/자바독 jar 는 실행에 필요 없다(라이브러리 정의에 CLASSES 로도 들어오지 않지만 방어).
    Some(s)
}

/// 로컬 Maven 저장소. `~/.m2/settings.xml` 의 `<localRepository>` 를 존중한다.
fn maven_repository() -> PathBuf {
    let home = home_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let default = home.join(".m2").join("repository");
    let settings = home.join(".m2").join("settings.xml");
    let Ok(text) = fs::read_to_string(&settings) else {
        return default;
    };
    let Ok(doc) = roxmltree::Document::parse(&text) else {
        return default;
    };
    doc.descendants()
        .find(|n| n.has_tag_name("localRepository"))
        .and_then(|n| n.text())
        .map(|t| t.trim())
        .filter(|t| !t.is_empty())
        .map(|t| {
            if let Some(rest) = t.strip_prefix("${user.home}") {
                home.join(rest.trim_start_matches('/'))
            } else {
                PathBuf::from(t)
            }
        })
        .unwrap_or(default)
}

/// `<library>` 요소 하나에서 CLASSES 항목만 뽑는다.
fn library_jars(node: roxmltree::Node, project: &Path, m2: &Path) -> Vec<PathBuf> {
    node.children()
        .filter(|n| n.has_tag_name("CLASSES"))
        .flat_map(|n| n.descendants())
        .filter(|n| n.has_tag_name("root"))
        .filter_map(|n| expand_url(n.attribute("url")?, project, m2))
        .collect()
}

impl Model {
    /// 프로젝트 모델을 읽는다. external storage 를 먼저 보고, 없으면 `.idea` 안을 본다.
    pub(crate) fn load(project: &str) -> Result<Self, String> {
        let project = PathBuf::from(project);
        let m2 = maven_repository();

        let external = find_external_storage(&project);
        let (source, modules_xml, external_mode) = match external {
            Some(ebs) => {
                let x = ebs.join("project").join("modules.xml");
                (ebs, x, true)
            }
            None => {
                let idea = project.join(".idea");
                let x = idea.join("modules.xml");
                if !x.is_file() {
                    return Err(format!(
                        "IntelliJ 프로젝트 모델을 찾지 못했습니다. \
                         {} 를 IntelliJ 에서 한 번 열어(Maven/Gradle 임포트 완료) 주세요.",
                        project.display()
                    ));
                }
                (idea, x, false)
            }
        };

        let text = fs::read_to_string(&modules_xml)
            .map_err(|e| format!("{} 를 읽지 못했습니다: {e}", modules_xml.display()))?;
        let doc = roxmltree::Document::parse(&text)
            .map_err(|e| format!("{} 파싱 실패: {e}", modules_xml.display()))?;

        let mut modules = HashMap::new();
        for m in doc.descendants().filter(|n| n.has_tag_name("module")) {
            let Some(fp) = m.attribute("filepath") else {
                continue;
            };
            let iml = PathBuf::from(
                fp.replace("$PROJECT_DIR$", &project.to_string_lossy())
                    .replace("$MODULE_DIR$", &project.to_string_lossy()),
            );
            let Some(name) = iml.file_stem().map(|s| s.to_string_lossy().to_string()) else {
                continue;
            };
            let dir = iml
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| project.clone());
            // external storage 는 모듈 정의를 캐시 폴더에 따로 두고, `.iml` 경로는
            // 모듈 디렉터리를 알려 주는 용도로만 쓴다.
            let file = if external_mode {
                source.join("modules").join(format!("{name}.xml"))
            } else {
                iml
            };
            modules.insert(name, (dir, file));
        }

        // 라이브러리: external 은 한 파일에 모여 있고, `.idea` 는 파일당 하나다.
        let mut libraries: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let lib_files: Vec<PathBuf> = if external_mode {
            vec![source.join("project").join("libraries.xml")]
        } else {
            fs::read_dir(source.join("libraries"))
                .map(|rd| {
                    rd.flatten()
                        .map(|e| e.path())
                        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("xml"))
                        .collect()
                })
                .unwrap_or_default()
        };
        for f in lib_files {
            let Ok(text) = fs::read_to_string(&f) else {
                continue;
            };
            let Ok(doc) = roxmltree::Document::parse(&text) else {
                continue;
            };
            for lib in doc.descendants().filter(|n| n.has_tag_name("library")) {
                let Some(name) = lib.attribute("name") else {
                    continue;
                };
                libraries.insert(name.to_string(), library_jars(lib, &project, &m2));
            }
        }

        if modules.is_empty() {
            return Err(format!(
                "{} 에서 모듈을 하나도 읽지 못했습니다.",
                modules_xml.display()
            ));
        }

        Ok(Model {
            project,
            source,
            modules,
            libraries,
        })
    }

    pub(crate) fn module_count(&self) -> usize {
        self.modules.len()
    }

    pub(crate) fn source(&self) -> &Path {
        &self.source
    }

    pub(crate) fn module_dir(&self, name: &str) -> Option<&Path> {
        self.modules.get(name).map(|(d, _)| d.as_path())
    }

    /// 모듈 하나의 **런타임 클래스패스**를 IntelliJ 와 같은 순서로 재구성한다.
    ///
    /// 모듈 의존성은 재귀로 따라가고(그 모듈의 출력 디렉터리가 들어간다), 라이브러리는
    /// `libraries.xml` 에서 jar 경로를 찾는다. `scope="TEST"` 는 뺀다 — 실행 클래스패스가
    /// 아니다. `PROVIDED` 는 **남긴다**: IntelliJ 의 Spring Boot 실행 설정도 기본으로
    /// provided 를 포함하며(그러지 않으면 톰캣이 없어 뜨지 않는다) 빼면 바로 티가 난다.
    ///
    /// 클래스 출력(`target/classes`)이 비어 있는 모듈은 **같은 폴더의 jar 로 대체한다**
    /// (`fallback_outputs`). 컴파일을 하지 않는 백엔드라 없는 디렉터리를 그대로 넣으면
    /// `NoClassDefFound` 로 죽는데, `mvn package` 까지 돌린 모듈은 클래스가 jar 안에
    /// 그대로 있다 — 실제로 cowork 의 `share-service`·`share-api-ui`·`share-log-monitor`
    /// 가 이 상태다. 대체한 것과 끝내 못 찾은 것은 둘 다 시작 로그에 찍는다.
    pub(crate) fn classpath(&self, module: &str) -> Result<Classpath, String> {
        if !self.modules.contains_key(module) {
            return Err(format!(
                "모듈 '{module}' 을 프로젝트 모델에서 찾지 못했습니다. \
                 IntelliJ 에서 프로젝트를 다시 임포트해 보세요."
            ));
        }
        let mut out: Vec<PathBuf> = Vec::new();
        let mut seen_paths: HashSet<PathBuf> = HashSet::new();
        let mut seen_modules: HashSet<String> = HashSet::new();
        let mut substituted: Vec<(String, PathBuf)> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let m2 = maven_repository();

        let push = |p: PathBuf, out: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>| {
            if seen.insert(p.clone()) {
                out.push(p);
            }
        };

        // 스택이 아니라 큐로 도는 이유: IntelliJ 의 클래스패스 순서는 "이 모듈의 항목들이
        // 먼저, 그다음 의존 모듈" 이다. 깊이 우선으로 돌면 순서가 뒤집힌다.
        let mut queue: VecDeque<String> = VecDeque::new();
        queue.push_back(module.to_string());
        seen_modules.insert(module.to_string());

        while let Some(name) = queue.pop_front() {
            let Some((dir, file)) = self.modules.get(&name) else {
                continue;
            };
            let Ok(text) = fs::read_to_string(file) else {
                continue;
            };
            let Ok(doc) = roxmltree::Document::parse(&text) else {
                continue;
            };
            let Some(root) = doc
                .descendants()
                .find(|n| n.attribute("name") == Some("NewModuleRootManager"))
            else {
                continue;
            };

            // 출력 디렉터리(= 컴파일된 클래스). 리소스도 IDE 가 여기로 복사한다.
            if let Some(url) = root
                .children()
                .find(|n| n.has_tag_name("output"))
                .and_then(|n| n.attribute("url"))
            {
                let p = PathBuf::from(
                    url.trim_start_matches("file://")
                        .replace("$MODULE_DIR$", &dir.to_string_lossy())
                        .replace("$PROJECT_DIR$", &self.project.to_string_lossy()),
                );
                if p.is_dir() {
                    push(p, &mut out, &mut seen_paths);
                } else {
                    let alt = fallback_outputs(dir);
                    if alt.is_empty() {
                        missing.push(name.clone());
                        // 없는 디렉터리도 그대로 넣어 둔다 — 나중에 컴파일하면 그대로 잡힌다.
                        push(p, &mut out, &mut seen_paths);
                    } else {
                        substituted.push((name.clone(), alt[0].clone()));
                        for a in alt {
                            push(a, &mut out, &mut seen_paths);
                        }
                    }
                }
            }

            for oe in root.children().filter(|n| n.has_tag_name("orderEntry")) {
                if oe.attribute("scope") == Some("TEST") {
                    continue;
                }
                match oe.attribute("type") {
                    Some("module") => {
                        if let Some(dep) = oe.attribute("module-name") {
                            if seen_modules.insert(dep.to_string()) {
                                queue.push_back(dep.to_string());
                            }
                        }
                    }
                    Some("library") => {
                        if let Some(lib) = oe.attribute("name") {
                            for jar in self.libraries.get(lib).into_iter().flatten() {
                                push(jar.clone(), &mut out, &mut seen_paths);
                            }
                        }
                    }
                    // 모듈 안에 인라인으로 적힌 라이브러리(`.idea` 방식에서 흔하다).
                    Some("module-library") => {
                        for lib in oe.children().filter(|n| n.has_tag_name("library")) {
                            for jar in library_jars(lib, &self.project, &m2) {
                                push(jar, &mut out, &mut seen_paths);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        Ok(Classpath {
            entries: out,
            substituted,
            missing,
        })
    }
}

/// 클래스패스 하나와, 그것을 만드는 동안 알게 된 것들.
pub(crate) struct Classpath {
    entries: Vec<PathBuf>,
    /// 클래스 출력이 없어 jar 등으로 대체한 모듈: (모듈, 실제로 쓴 첫 경로).
    substituted: Vec<(String, PathBuf)>,
    /// 클래스 출력도 대체물도 없는 모듈. 실행이 실패할 가장 흔한 이유다.
    missing: Vec<String>,
}

/// jar 파일 이름이 **일반 클래스 jar** 인지. 클래스패스에 넣으면 안 되는 것들을 걸러낸다.
///
/// - `-sources` / `-javadoc` / `-tests` — 실행 클래스가 아니다.
/// - `-exec` (Spring Boot `bootJar`) — 클래스가 `BOOT-INF/classes` 안에 있어 `-cp` 로는
///   읽히지 않는다. cowork 의 `*-boot` 모듈이 실제로 이 classifier 를 쓴다.
/// - `-all` (shaded/fat jar) — 의존성을 통째로 품고 있어 넣으면 클래스가 중복된다.
fn is_plain_class_jar(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    name.ends_with(".jar")
        && !["-sources", "-javadoc", "-tests", "-exec", "-all", "-plain"]
            .iter()
            .any(|suffix| name.ends_with(&format!("{suffix}.jar")))
}

/// 폴더에서 가장 최근에 만들어진 일반 클래스 jar.
fn newest_jar(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_plain_class_jar(p))
        .filter_map(|p| {
            let t = fs::metadata(&p).ok()?.modified().ok()?;
            Some((t, p))
        })
        .max_by_key(|(t, _)| *t)
        .map(|(_, p)| p)
}

/// `target/classes` 가 없는 모듈에서 클래스를 찾을 다음 후보들.
///
/// 순서가 곧 신뢰도다: Gradle 이 방금 컴파일해 둔 클래스 디렉터리가 가장 신선하고,
/// 그다음이 이 모듈이 직접 패키징한 jar 다. `~/.m2` 의 설치본은 **쓰지 않는다** —
/// 다른 브랜치에서 설치된 것일 수 있어 소스와 어긋난 채 조용히 도는 게 더 나쁘다.
fn fallback_outputs(dir: &Path) -> Vec<PathBuf> {
    // 1) Gradle 컴파일 출력(클래스 + 리소스는 따로 있다).
    let gradle_classes = dir.join("build").join("classes").join("java").join("main");
    if gradle_classes.is_dir() {
        let mut out = vec![gradle_classes];
        let res = dir.join("build").join("resources").join("main");
        if res.is_dir() {
            out.push(res);
        }
        return out;
    }
    // 2) 이 모듈이 패키징한 jar(Maven 먼저, 그다음 Gradle).
    for sub in ["target", "build/libs"] {
        let d = sub
            .split('/')
            .fold(dir.to_path_buf(), |acc, part| acc.join(part));
        if let Some(jar) = newest_jar(&d) {
            return vec![jar];
        }
    }
    Vec::new()
}

// ─────────────────────────────── JDK ───────────────────────────────

/// `.idea/misc.xml` 의 프로젝트 SDK 이름.
fn project_jdk_name(project: &Path) -> Option<String> {
    let text = fs::read_to_string(project.join(".idea").join("misc.xml")).ok()?;
    let doc = roxmltree::Document::parse(&text).ok()?;
    doc.descendants()
        .find(|n| n.attribute("name") == Some("ProjectRootManager"))
        .and_then(|n| n.attribute("project-jdk-name"))
        .map(str::to_string)
}

/// `options/jdk.table.xml` 에서 SDK 이름 → home 경로.
fn jdk_home(name: &str) -> Option<PathBuf> {
    let root = config_root()?;
    for ide in fs::read_dir(&root).ok()?.flatten() {
        let table = ide.path().join("options").join("jdk.table.xml");
        let Ok(text) = fs::read_to_string(&table) else {
            continue;
        };
        let Ok(doc) = roxmltree::Document::parse(&text) else {
            continue;
        };
        for jdk in doc.descendants().filter(|n| n.has_tag_name("jdk")) {
            let matches = jdk
                .children()
                .find(|n| n.has_tag_name("name"))
                .and_then(|n| n.attribute("value"))
                == Some(name);
            if !matches {
                continue;
            }
            let home = jdk
                .children()
                .find(|n| n.has_tag_name("homePath"))
                .and_then(|n| n.attribute("value"))?;
            let home = if let Some(rest) = home.strip_prefix("$USER_HOME$") {
                home_dir().ok()?.join(rest.trim_start_matches('/'))
            } else {
                PathBuf::from(home)
            };
            if home.join("bin").join("java").is_file() {
                return Some(home);
            }
        }
    }
    None
}

/// 실행에 쓸 `java` 바이너리.
/// 프로젝트 SDK → `JAVA_HOME` → `/usr/libexec/java_home` 순으로 찾는다.
fn java_binary(project: &Path) -> Result<PathBuf, String> {
    if let Some(home) = project_jdk_name(project).and_then(|n| jdk_home(&n)) {
        return Ok(home.join("bin").join("java"));
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let p = PathBuf::from(home).join("bin").join("java");
        if p.is_file() {
            return Ok(p);
        }
    }
    let out = Command::new("/usr/libexec/java_home")
        .output()
        .map_err(|e| format!("java_home 실행 실패: {e}"))?;
    let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let p = PathBuf::from(&home).join("bin").join("java");
    if !home.is_empty() && p.is_file() {
        return Ok(p);
    }
    Err(
        "JDK 를 찾지 못했습니다. IntelliJ 의 프로젝트 SDK 를 설정하거나 JAVA_HOME 을 지정하세요."
            .to_string(),
    )
}

// ─────────────────────────── 실행 커맨드 조립 ───────────────────────────

/// VM 옵션 문자열을 인자로 자른다. 따옴표 안의 공백은 유지한다.
pub(crate) fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut has = false;
    for c in s.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                has = true; // 빈 따옴표("")도 인자 하나다
            }
            None if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            None => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// java 인자 파일 한 줄로 쓸 수 있게 이스케이프한다(백슬래시와 따옴표).
fn argfile_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 조립이 끝난 실행 명세.
pub(crate) struct Launch {
    java: PathBuf,
    /// VM 옵션 → `@argfile`(클래스패스) → 메인 클래스 → 프로그램 인자.
    args: Vec<String>,
    workdir: PathBuf,
    envs: Vec<(String, String)>,
    /// 시작 직후 콘솔에 찍을 안내(클래스패스 규모, 미컴파일 모듈 등).
    notes: Vec<String>,
}

/// 설정 이름 → 인자 파일 경로.
///
/// 이 경로는 파일 이름이기만 한 게 아니라 **커맨드라인에 남는 표식**이다. `java` 는
/// `@<경로>` 인자를 그대로 들고 있으므로 `ps` 에서 이걸 찾으면 "my-space 가 띄운, 바로
/// 이 실행 설정" 을 정확히 짚을 수 있다(`adopt_orphans`). 메인 클래스로 찾는 방식과 달리
/// IDE 가 띄운 같은 서비스와 헷갈릴 일이 없다.
fn argfile_path(name: &str) -> Result<PathBuf, String> {
    let dir = home_dir()?.join(".myspace").join("standalone");
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    Ok(dir.join(format!("{safe}.args")))
}

/// 클래스패스를 인자 파일로 떨군다.
///
/// cowork 의 서비스 하나가 279개 엔트리라 커맨드라인이 수만 자가 된다. `ARG_MAX` 안에
/// 들어가긴 하지만 `ps` 출력이 못 볼 지경이 되고, IntelliJ 자신도 인자 파일을 쓴다.
fn write_argfile(name: &str, cp: &[PathBuf]) -> Result<PathBuf, String> {
    let path = argfile_path(name)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{} 생성 실패: {e}", dir.display()))?;
    }
    let joined = cp
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(":");
    fs::write(&path, format!("-classpath {}\n", argfile_quote(&joined)))
        .map_err(|e| format!("{} 쓰기 실패: {e}", path.display()))?;
    Ok(path)
}

/// 실행 설정 하나를 `java` 커맨드로 옮긴다.
pub(crate) fn build_launch(
    project: &str,
    name: &str,
    meta: &Meta,
    model: &Model,
) -> Result<Launch, String> {
    let main_class = meta
        .main_class
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("'{name}' 에 메인 클래스가 없어 직접 실행할 수 없습니다."))?;
    let module = meta
        .module
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("'{name}' 에 모듈 정보가 없어 클래스패스를 만들 수 없습니다."))?;

    let Classpath {
        entries: mut cp,
        substituted,
        missing,
    } = model.classpath(module)?;

    // 실행 설정의 클래스패스 수정(cowork 의 mysql 커넥터 등). 제외 항목도 존중한다.
    let mut notes = Vec::new();
    for (raw, exclude) in &meta.classpath_mods {
        let p = expand_macros(raw, project);
        if *exclude {
            cp.retain(|x| x != &p);
        } else if !cp.contains(&p) {
            // IDE 는 수정 항목을 앞에 놓는다(같은 클래스를 덮어쓰라고 넣는 것이므로).
            cp.insert(0, p);
        }
    }

    let java = java_binary(Path::new(project))?;
    let argfile = write_argfile(name, &cp)?;

    let mut args: Vec<String> = Vec::new();
    if let Some(vm) = meta.vm_parameters.as_deref() {
        args.extend(tokenize(vm));
    }
    // 프로필은 IDE 의 Spring Boot 실행 설정과 같은 방식으로 넘긴다.
    if let Some(profiles) = meta.profiles.as_deref().filter(|s| !s.is_empty()) {
        args.push(format!("-Dspring.profiles.active={profiles}"));
    }
    // IDE 가 항상 붙이는 것들. 없으면 한글 로그가 깨진다.
    if !args.iter().any(|a| a.starts_with("-Dfile.encoding=")) {
        args.push("-Dfile.encoding=UTF-8".into());
    }
    // 콘솔 색 — IntelliJ 가 Spring Boot 실행 설정에 붙이는 것과 같은 값이다.
    // Spring Boot 의 기본값 `detect` 는 stdout 이 터미널일 때만 색을 켜는데, 여기서는
    // 파이프로 읽으므로 색이 꺼진 채 나온다. 명시적으로 켜야 콘솔이 IDE 와 같은 구문
    // 강조로 보인다(프론트의 `console-highlight.ts` 가 그 ANSI 를 그대로 그린다).
    if !args
        .iter()
        .any(|a| a.starts_with("-Dspring.output.ansi.enabled="))
    {
        args.push("-Dspring.output.ansi.enabled=always".into());
    }
    args.push(format!("@{}", argfile.display()));
    args.push(main_class.to_string());
    if let Some(pp) = meta.program_parameters.as_deref() {
        args.extend(tokenize(pp));
    }

    // 작업 디렉터리: 설정에 있으면 그것, 없으면 모듈 디렉터리(IDE 기본값과 같다).
    let workdir = meta
        .working_directory
        .as_deref()
        .filter(|s| !s.is_empty() && !s.contains("$MODULE_WORKING_DIR$"))
        .map(|w| expand_macros(w, project))
        .or_else(|| model.module_dir(module).map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from(project));

    notes.push(format!(
        "[my-space] {} · 모듈 {module} · 클래스패스 {}개",
        java.display(),
        cp.len()
    ));
    if let Some(p) = meta.profiles.as_deref().filter(|s| !s.is_empty()) {
        notes.push(format!("[my-space] profile: {p}"));
    }
    if !substituted.is_empty() {
        notes.push(format!(
            "[my-space] 클래스 출력이 없어 jar 로 대체한 모듈 {}개: {}",
            substituted.len(),
            substituted
                .iter()
                .map(|(m, p)| format!(
                    "{m} → {}",
                    p.file_name().unwrap_or(p.as_os_str()).to_string_lossy()
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !missing.is_empty() {
        notes.push(format!(
            "[my-space] ⚠ 클래스를 찾지 못한 모듈 {}개: {} — IntelliJ 에서 Build 하거나 \
             해당 모듈을 컴파일한 뒤 실행하세요(이 기능은 컴파일을 하지 않습니다). \
             NoClassDefFoundError 가 나면 이것이 원인입니다.",
            missing.len(),
            missing.join(", ")
        ));
    }

    Ok(Launch {
        java,
        args,
        workdir,
        envs: meta.envs.clone(),
        notes,
    })
}

// ─────────────────────────────── 실행 ───────────────────────────────

/// 자식의 stdout/stderr 를 한 줄씩 콘솔로 흘린다.
fn pump<R: std::io::Read + Send + 'static>(
    app: tauri::AppHandle,
    name: String,
    reader: R,
    done: Arc<AtomicBool>,
) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut line = Vec::new();
        loop {
            line.clear();
            // read_until 로 읽는 이유: 로그에 유효하지 않은 UTF-8 이 섞여도 멈추지 않는다.
            match buf.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\n', '\r']);
            note_log_signal(&app, &name, text);
            emit_log(&app, &name, text);
        }
        done.store(true, Ordering::SeqCst);
    });
}

/// 서비스 포트가 열릴 때까지 지켜본다(뜨자마자 바인딩되지는 않는다).
fn watch_port(app: tauri::AppHandle, name: String, pid: u32, expect: Option<u16>) {
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < PORT_WATCH_LIMIT {
            if !is_alive(pid) {
                return;
            }
            // 우리가 띄운 그 실행이 아직 현재 실행인지(재시작으로 바뀌지 않았는지) 확인.
            if tracked_pid(&app, &name) != Some(pid) {
                return;
            }
            let ports = listening_ports(pid);
            let picked = pick_service_port(&ports, expect).or_else(|| {
                // 고정 포트를 안 쓰는 서비스는 끝까지 안 잡힌다 — 한동안 기다린 뒤 아무거나.
                (start.elapsed() > PORT_FALLBACK_AFTER)
                    .then(|| pick_any_port(&ports))
                    .flatten()
            });
            if let Some(port) = picked {
                update_port(&app, &name, pid, port);
                return;
            }
            std::thread::sleep(POLL);
        }
    });
}

/// 자식이 끝날 때까지 기다렸다가 성공/실패를 판정한다.
fn watch_exit(app: tauri::AppHandle, name: String, mut child: Child, pumps: Vec<Arc<AtomicBool>>) {
    std::thread::spawn(move || {
        let status = child.wait();

        // 파이프에 남은 줄이 콘솔에 다 도착한 뒤에 판정한다. 그러지 않으면 실패 사유가
        // 적힌 마지막 줄을 놓치고 "종료 코드 1" 만 남는다.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && pumps.iter().any(|d| !d.load(Ordering::SeqCst)) {
            std::thread::sleep(Duration::from_millis(50));
        }

        let stopping = is_stopping(&app, &name);
        let outcome = app
            .try_state::<StandaloneTracking>()
            .and_then(|t| t.outcome.lock().unwrap().get(&name).cloned())
            .unwrap_or_default();

        let code = status.as_ref().ok().and_then(|s| s.code());
        let failed = if stopping {
            None // 사용자가 내린 것
        } else if let Some(reason) = outcome.fail_reason {
            Some(reason)
        } else {
            match code {
                // SIGINT 로 끝난 정상 종료(130) 와 0 은 실패가 아니다.
                Some(0) | Some(130) | None => None,
                Some(c) if outcome.started => Some(format!("실행 중 종료(코드 {c})")),
                Some(c) => Some(format!("시작하지 못하고 종료(코드 {c})")),
            }
        };

        match &failed {
            Some(reason) => emit_log(&app, &name, &format!("[my-space] 실패 — {reason}")),
            None => emit_log(
                &app,
                &name,
                &format!(
                    "[my-space] 종료{}",
                    code.map(|c| format!(" (코드 {c})")).unwrap_or_default()
                ),
            ),
        }
        mark_stopped(&app, &name, failed);
    });
}

/// 실행 설정 하나를 띄운다.
fn spawn_one(app: &tauri::AppHandle, project: &str, name: &str) -> Result<(), String> {
    if tracked_pid(app, name).is_some_and(is_alive) {
        return Err(format!("'{name}' 은 이미 실행 중입니다."));
    }
    reset_tracking(app, name);

    let metas = read_metas(project);
    let meta = metas
        .get(name)
        .ok_or_else(|| format!("'{name}' 실행 설정을 프로젝트에서 찾지 못했습니다."))?;
    let model = Model::load(project)?;
    let launch = build_launch(project, name, meta, &model)?;

    for note in &launch.notes {
        emit_log(app, name, note);
    }

    let mut cmd = Command::new(&launch.java);
    cmd.args(&launch.args)
        .current_dir(&launch.workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &launch.envs {
        cmd.env(k, v);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("'{name}' 실행에 실패했습니다: {e}"))?;
    let pid = child.id();

    let mut pumps = Vec::new();
    if let Some(out) = child.stdout.take() {
        let done = Arc::new(AtomicBool::new(false));
        pumps.push(done.clone());
        pump(app.clone(), name.to_string(), out, done);
    }
    if let Some(err) = child.stderr.take() {
        let done = Arc::new(AtomicBool::new(false));
        pumps.push(done.clone());
        pump(app.clone(), name.to_string(), err, done);
    }

    mark_running(app, name, pid);
    emit_log(app, name, &format!("[my-space] 시작 — pid {pid}"));

    let port_map = read_port_map(project);
    watch_port(
        app.clone(),
        name.to_string(),
        pid,
        expected_port(&port_map, meta),
    );
    watch_exit(app.clone(), name.to_string(), child, pumps);
    Ok(())
}

/// `ps` 목록에서 이 실행 설정으로 띄운 프로세스를 찾는다.
///
/// 표식은 커맨드라인의 `@<인자 파일 경로>` 다. 경로 전체를 `@` 까지 붙여 비교하므로
/// 이름이 서로의 부분 문자열인 설정(`Registry` / `RegistryApplication`)도 섞이지 않고,
/// **IDE 가 띄운 같은 서비스는 이 표식이 없어 애초에 걸리지 않는다.**
fn find_orphan(procs: &[(u32, String)], name: &str) -> Option<u32> {
    let needle = format!("@{}", argfile_path(name).ok()?.display());
    procs
        .iter()
        .find(|(_, cmd)| cmd.contains(&needle))
        .map(|(pid, _)| *pid)
}

/// 앱을 재기동해도 살아 있는 프로세스를 다시 붙인다.
///
/// **자식 프로세스는 부모가 죽어도 살아남는다** — my-space 를 껐다 켜면 서비스는 그대로
/// 떠 있는데 `StandaloneState` 는 메모리에만 있어서 전부 "중지됨" 으로 보인다. 그 상태로
/// 다시 시작을 누르면 포트 충돌로 죽고, 내리려 해도 내릴 수 없다.
///
/// 찾는 방법은 `ps` 에서 **우리 인자 파일 경로**(`argfile_path`)를 갖고 있는 프로세스다.
/// 메인 클래스로 찾는 `intellij.rs` 의 `adopt_external` 과 달리 이 표식은 우리가 만든
/// 것에만 있어서, IDE 로 띄운 같은 서비스를 잘못 집어 오지 않는다. 프로필이 같은 형제
/// 설정(ApiGateway agent/customer/mobile)도 인자 파일 이름이 달라 저절로 갈린다.
///
/// 되찾을 수 없는 것이 하나 있다: **콘솔**. stdout 은 죽은 부모의 파이프에 연결돼 있어서
/// 이후 로그를 읽을 방법이 없다. 그래서 흡수한 자리에 그 사실을 한 줄 남긴다 — 빈 콘솔을
/// 보고 "로그가 안 나온다" 고 의심하는 것보다 낫다.
fn adopt_orphans(app: &tauri::AppHandle, project: &str) {
    let metas = read_metas(project);
    if metas.is_empty() {
        return;
    }
    let procs = ps_list();
    let port_map = read_port_map(project);

    for (name, meta) in &metas {
        if tracked_pid(app, name).is_some() {
            continue; // 이미 알고 있는 실행
        }
        let Some(pid) = find_orphan(&procs, name) else {
            continue;
        };

        mark_running(app, name, pid);
        emit_log(
            app,
            name,
            &format!(
                "[my-space] 앱을 다시 켜기 전부터 실행 중이던 프로세스를 다시 붙였습니다 \
                 (pid {pid}). 이 실행의 콘솔 출력은 이어 볼 수 없습니다 — 재시작하면 \
                 처음부터 다시 보입니다."
            ),
        );
        watch_port(
            app.clone(),
            name.clone(),
            pid,
            expected_port(&port_map, meta),
        );
        watch_alive(app.clone(), name.clone(), pid);
    }
}

/// 우리가 `wait` 할 수 없는 프로세스(흡수한 것)의 종료를 pid 생존 확인으로 잡는다.
///
/// `watch_exit` 와 달리 종료 코드를 알 수 없으므로 **실패 판정을 하지 않는다** — 코드를
/// 모르는 채 "실패" 라고 적으면 정상 종료를 실패로 뒤집을 수 있다.
fn watch_alive(app: tauri::AppHandle, name: String, pid: u32) {
    std::thread::spawn(move || {
        loop {
            // 재시작으로 다른 pid 가 이 이름을 차지했으면 이 감시는 할 일이 없다.
            if tracked_pid(&app, &name) != Some(pid) {
                return;
            }
            if !is_alive(pid) {
                break;
            }
            std::thread::sleep(ORPHAN_POLL);
        }
        if tracked_pid(&app, &name) == Some(pid) {
            emit_log(&app, &name, "[my-space] 프로세스가 종료되었습니다.");
            mark_stopped(&app, &name, None);
        }
    });
}

/// Multirun 이면 하위 설정을, 아니면 자기 자신을 돌려준다.
fn targets(project: &str, name: &str) -> Vec<String> {
    let metas = read_metas(project);
    match metas.get(name) {
        Some(m) if m.kind.as_deref() == Some("multirun") => leaf_configs(&metas, name),
        _ => vec![name.to_string()],
    }
}

// ─────────────────────────────── 커맨드 ───────────────────────────────

/// 프로젝트 모델을 읽을 수 있는지(화면 상단 배지).
#[tauri::command]
pub fn standalone_model_status(project: String) -> ModelStatus {
    // 경로 문제와 모델 문제를 같은 배지로 알린다 — 사용자에게는 "지금 쓸 수 있나" 하나다.
    let project = match resolve_project(&project) {
        Ok(p) => p,
        Err(e) => {
            return ModelStatus {
                connected: false,
                url: None,
                error: Some(e),
            }
        }
    };
    match Model::load(&project) {
        Ok(m) => ModelStatus {
            connected: true,
            url: Some(format!(
                "{} · 모듈 {}개",
                m.source().display(),
                m.module_count()
            )),
            error: None,
        },
        Err(e) => ModelStatus {
            connected: false,
            url: None,
            error: Some(e),
        },
    }
}

/// 실행 설정 목록. IDE 없이 `.idea/runConfigurations/*.xml` 만 읽는다.
///
/// `intellij_list_services` 와 달리 MCP 를 거치지 않으므로 **XML 로 저장된 설정만** 보인다.
/// IDE 안에만 있는 임시 설정은 애초에 직접 띄울 재료(메인 클래스·모듈)가 없으니 손해가 아니다.
#[tauri::command]
pub fn standalone_list_services(project: String) -> Result<Vec<Service>, String> {
    let project = resolve_project(&project)?;
    let metas = read_metas(&project);
    let port_map = read_port_map(&project);
    // 모델이 없어도 목록은 보여 준다(상단 배지가 이유를 말한다).
    let model = Model::load(&project).ok();

    let mut out: Vec<Service> = metas
        .iter()
        .map(|(name, meta)| {
            let kind = meta.kind.clone().unwrap_or_else(|| "other".to_string());
            // 직접 띄우려면 메인 클래스 + 모듈 + 모델이 모두 있어야 한다.
            let launchable = |m: &Meta| {
                m.main_class.as_deref().is_some_and(|s| !s.is_empty())
                    && m.module.as_deref().is_some_and(|s| !s.is_empty())
                    && model.as_ref().is_some_and(|md| {
                        m.module
                            .as_deref()
                            .is_some_and(|x| md.module_dir(x).is_some())
                    })
            };
            let stoppable = match kind.as_str() {
                "multirun" => leaf_configs(&metas, name)
                    .iter()
                    .any(|ch| metas.get(ch).is_some_and(launchable)),
                _ => launchable(meta),
            };
            Service {
                name: name.clone(),
                kind,
                description: None,
                module: meta.module.clone(),
                main_class: meta.main_class.clone(),
                profiles: meta.profiles.clone(),
                vm_parameters: meta.vm_parameters.clone(),
                expected_port: expected_port(&port_map, meta),
                children: meta.children.clone(),
                stoppable,
                // IDE 로그 동기화는 이 백엔드에 없는 개념이다 — 콘솔을 직접 읽는다.
                log_sync: None,
            }
        })
        .collect();

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn standalone_running(app: tauri::AppHandle, project: String) -> Vec<Running> {
    // 목록을 묻는 이 자리가 흡수 지점이다 — 화면에 들어올 때마다 불리므로, 앱을 재기동한
    // 뒤 처음 보는 순간 상태가 맞아 있다. 경로가 잘못돼 있으면 흡수만 건너뛴다(이미
    // 알고 있는 실행은 그대로 돌려줘야 한다).
    if let Ok(project) = resolve_project(&project) {
        adopt_orphans(&app, &project);
    }
    let Some(state) = app.try_state::<StandaloneState>() else {
        return Vec::new();
    };
    let mut map = state.0.lock().unwrap();
    // 앱이 모르는 사이 죽은 것(외부에서 kill)은 여기서 걸러낸다.
    map.retain(|_, r| is_alive(r.pid));
    map.iter()
        .map(|(name, r)| Running {
            name: name.clone(),
            pid: r.pid,
            port: r.port,
        })
        .collect()
}

#[tauri::command]
pub fn standalone_logs(app: tauri::AppHandle, name: String) -> Vec<String> {
    app.try_state::<StandaloneTracking>()
        .map(|t| {
            t.logs
                .lock()
                .unwrap()
                .get(&name)
                .map(|b| b.iter().cloned().collect())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn standalone_clear_logs(app: tauri::AppHandle, name: String) {
    if let Some(t) = app.try_state::<StandaloneTracking>() {
        t.logs.lock().unwrap().remove(&name);
    }
}

#[tauri::command]
pub fn standalone_start_service(
    app: tauri::AppHandle,
    project: String,
    name: String,
) -> Result<(), String> {
    let project = resolve_project(&project)?;
    let list = targets(&project, &name);
    if list.is_empty() {
        return Err(format!("'{name}' 에서 실행할 설정을 찾지 못했습니다."));
    }
    // Multirun 은 하위를 전부 띄운다. 하나가 실패해도 나머지는 계속한다 —
    // 여기서 멈추면 이미 뜬 것들만 남아 무엇이 실패했는지 알기 어렵다.
    let mut errors = Vec::new();
    for target in &list {
        if let Err(e) = spawn_one(&app, &project, target) {
            errors.push(e);
        }
    }
    if errors.len() == list.len() {
        return Err(errors.join(" / "));
    }
    Ok(())
}

/// SIGINT 을 보내고 사라질 때까지 기다린다. 늦으면 SIGKILL 로 올린다.
async fn stop_and_wait(app: &tauri::AppHandle, name: &str) -> Result<(), String> {
    let Some(pid) = tracked_pid(app, name) else {
        return Ok(());
    };
    mark_stopping(app, name);
    signal_tree(&[pid], Sig::Int);

    let start = Instant::now();
    let mut escalated = false;
    while is_alive(pid) {
        if start.elapsed() > STOP_TIMEOUT {
            return Err(format!(
                "'{name}' 종료가 {}초 안에 끝나지 않았습니다 (pid {pid})",
                STOP_TIMEOUT.as_secs()
            ));
        }
        if !escalated && start.elapsed() > STOP_GRACE {
            escalated = true;
            emit_log(
                app,
                name,
                "[my-space] 응답이 없어 강제 종료(SIGKILL)합니다.",
            );
            signal_tree(&[pid], Sig::Kill);
        }
        tokio::time::sleep(POLL).await;
    }

    // 종료 감시 스레드가 상태를 정리할 틈을 준다(정리 전에 다시 띄우면 늦은
    // "중지됨" 이벤트가 새 실행을 덮어쓴다).
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && tracked_pid(app, name).is_some() {
        tokio::time::sleep(POLL).await;
    }
    if tracked_pid(app, name).is_some() {
        mark_stopped(app, name, None);
    }
    Ok(())
}

#[tauri::command]
pub async fn standalone_stop_service(
    app: tauri::AppHandle,
    project: String,
    name: String,
) -> Result<(), String> {
    let project = resolve_project(&project)?;
    for target in targets(&project, &name) {
        stop_and_wait(&app, &target).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn standalone_restart_service(
    app: tauri::AppHandle,
    project: String,
    name: String,
) -> Result<(), String> {
    let project = resolve_project(&project)?;
    let list = targets(&project, &name);
    for target in &list {
        if tracked_pid(&app, target).is_some() {
            emit_log(&app, target, "[my-space] 재시작 — 종료를 기다립니다…");
            stop_and_wait(&app, target).await?;
        }
    }
    standalone_start_service(app, project, name)
}

// ─────────────────────────────── 순차 실행 ───────────────────────────────

fn emit_sequence(
    app: &tauri::AppHandle,
    stage: usize,
    total: usize,
    names: &[String],
    phase: &str,
    message: Option<String>,
) {
    let payload = SequencePayload {
        stage,
        total,
        names: names.to_vec(),
        phase: phase.to_string(),
        message,
    };
    if let Some(s) = app.try_state::<StandaloneSequence>() {
        *s.last.lock().unwrap() = Some(payload.clone());
    }
    let _ = app.emit("standalone:sequence", payload);
}

/// 이 서비스가 "떴다" 고 볼 수 있는지 — Spring Boot 의 Started 로그 또는 포트 LISTEN.
fn has_started(app: &tauri::AppHandle, name: &str) -> bool {
    let logged = app
        .try_state::<StandaloneTracking>()
        .map(|t| {
            t.outcome
                .lock()
                .unwrap()
                .get(name)
                .is_some_and(|o| o.started)
        })
        .unwrap_or(false);
    if logged {
        return true;
    }
    app.try_state::<StandaloneState>()
        .map(|s| {
            s.0.lock()
                .unwrap()
                .get(name)
                .is_some_and(|r| r.port.is_some())
        })
        .unwrap_or(false)
}

/// 이번 실행이 이미 끝났으면 그 결과(실패 사유 또는 정상 종료).
fn exit_of(app: &tauri::AppHandle, name: &str) -> Option<Option<String>> {
    app.try_state::<StandaloneTracking>()
        .and_then(|t| t.exits.lock().unwrap().get(name).cloned())
}

fn sequence_canceled(app: &tauri::AppHandle) -> bool {
    app.try_state::<StandaloneSequence>()
        .map(|s| *s.cancel.lock().unwrap())
        .unwrap_or(false)
}

/// 프리셋 단계대로 띄운다. 한 단계가 모두 뜬 뒤에 다음 단계로 넘어간다.
async fn run_sequence(app: tauri::AppHandle, project: String, stages: Vec<Vec<String>>) {
    let total = stages.len();
    for (i, names) in stages.iter().enumerate() {
        let stage = i + 1;
        if sequence_canceled(&app) {
            emit_sequence(&app, stage, total, names, "canceled", None);
            break;
        }
        emit_sequence(&app, stage, total, names, "starting", None);

        // 이미 떠 있는 것은 다시 띄우지 않는다(그것에 의존하는 서비스가 끊긴다).
        let pending: Vec<String> = names
            .iter()
            .filter(|n| tracked_pid(&app, n).is_none())
            .cloned()
            .collect();
        for n in &pending {
            if let Err(e) = standalone_start_service(app.clone(), project.clone(), n.clone()) {
                emit_log(&app, n, &format!("[my-space] 시작 실패 — {e}"));
            }
        }

        emit_sequence(&app, stage, total, names, "waiting", None);
        let deadline = Instant::now() + STAGE_TIMEOUT;
        let mut failure: Option<String> = None;
        loop {
            if sequence_canceled(&app) {
                emit_sequence(&app, stage, total, names, "canceled", None);
                finish_sequence(&app);
                return;
            }
            // 하나라도 실패로 끝났으면 다음 단계는 의미가 없다.
            if let Some((n, reason)) = names
                .iter()
                .find_map(|n| exit_of(&app, n).flatten().map(|r| (n.clone(), r)))
            {
                failure = Some(format!("{n}: {reason}"));
                break;
            }
            if names.iter().all(|n| has_started(&app, n)) {
                break;
            }
            if Instant::now() > deadline {
                failure = Some(format!(
                    "{}초 안에 기동이 끝나지 않았습니다",
                    STAGE_TIMEOUT.as_secs()
                ));
                break;
            }
            tokio::time::sleep(POLL).await;
        }

        if let Some(msg) = failure {
            emit_sequence(&app, stage, total, names, "failed", Some(msg));
            finish_sequence(&app);
            return;
        }
    }

    let last = stages.last().cloned().unwrap_or_default();
    emit_sequence(&app, total, total, &last, "done", None);
    finish_sequence(&app);
}

fn finish_sequence(app: &tauri::AppHandle) {
    if let Some(s) = app.try_state::<StandaloneSequence>() {
        *s.running.lock().unwrap() = false;
        *s.cancel.lock().unwrap() = false;
    }
}

#[tauri::command]
pub fn standalone_start_sequence(
    app: tauri::AppHandle,
    project: String,
    stages: Vec<Vec<String>>,
) -> Result<(), String> {
    let project = resolve_project(&project)?;
    let Some(state) = app.try_state::<StandaloneSequence>() else {
        return Err("순차 실행 상태를 찾을 수 없습니다.".into());
    };
    {
        let mut running = state.running.lock().unwrap();
        if *running {
            return Err("이미 순차 실행이 진행 중입니다.".into());
        }
        *running = true;
        *state.cancel.lock().unwrap() = false;
    }
    // 화면을 떠나도 계속 진행된다.
    tauri::async_runtime::spawn(run_sequence(app.clone(), project, stages));
    Ok(())
}

#[tauri::command]
pub fn standalone_cancel_sequence(app: tauri::AppHandle) {
    if let Some(s) = app.try_state::<StandaloneSequence>() {
        *s.cancel.lock().unwrap() = true;
    }
}

#[tauri::command]
pub fn standalone_sequence_status(app: tauri::AppHandle) -> SequenceStatus {
    match app.try_state::<StandaloneSequence>() {
        Some(s) => SequenceStatus {
            running: *s.running.lock().unwrap(),
            last: s.last.lock().unwrap().clone(),
        },
        None => SequenceStatus {
            running: false,
            last: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COWORK: &str = "/Users/rudaks/_WORK/_ENOMIX_GIT/spectrakr/cowork";

    #[test]
    fn tokenize_keeps_quoted_spaces() {
        assert_eq!(tokenize("-Xms64m -Xmx128m"), vec!["-Xms64m", "-Xmx128m"]);
        assert_eq!(
            tokenize("-Da=\"one two\" -Db=3"),
            vec!["-Da=one two", "-Db=3"]
        );
        assert_eq!(tokenize("   "), Vec::<String>::new());
        // 빈 따옴표도 인자 하나다(빈 값을 넘기는 설정이 실제로 있다).
        assert_eq!(tokenize("-Da= \"\""), vec!["-Da=", ""]);
    }

    #[test]
    fn argfile_escapes_quotes_and_backslashes() {
        assert_eq!(argfile_quote("/a/b"), "\"/a/b\"");
        assert_eq!(argfile_quote("/a\\b"), "\"/a\\\\b\"");
        assert_eq!(argfile_quote("/a\"b"), "\"/a\\\"b\"");
    }

    #[test]
    fn expands_intellij_urls() {
        let m2 = PathBuf::from("/m2");
        let p = PathBuf::from("/proj");
        assert_eq!(
            expand_url("jar://$MAVEN_REPOSITORY$/a/b.jar!/", &p, &m2).unwrap(),
            PathBuf::from("/m2/a/b.jar")
        );
        assert_eq!(
            expand_url("file://$PROJECT_DIR$/out", &p, &m2).unwrap(),
            PathBuf::from("/proj/out")
        );
    }

    /// 실제 cowork 모델을 읽어 클래스패스를 만들어 본다.
    /// **이 테스트가 이 기능의 전제 조건 전부다** — 모델을 못 읽거나 라이브러리 정의가
    /// 비면 실행은 `NoClassDefFound` 로 죽는다.
    #[test]
    fn builds_a_real_classpath_from_the_intellij_model() {
        if !Path::new(COWORK).is_dir() {
            return; // 이 머신에 cowork 가 없으면 건너뛴다.
        }
        let model = match Model::load(COWORK) {
            Ok(m) => m,
            Err(_) => return, // IntelliJ 로 한 번도 열지 않은 머신
        };
        assert!(model.module_count() > 100, "모듈이 너무 적다");

        let cp = model.classpath("registry-boot").expect("클래스패스 실패");
        assert!(
            cp.entries.len() > 100,
            "클래스패스가 너무 짧다: {}",
            cp.entries.len()
        );
        // 출력 디렉터리가 맨 앞이어야 한다(자기 클래스가 라이브러리보다 먼저).
        assert!(
            cp.entries[0].ends_with("registry-boot/target/classes"),
            "첫 항목이 모듈 출력이 아니다: {:?}",
            cp.entries[0]
        );
        // jar 는 전부 실제 파일이어야 한다 — 하나라도 없으면 라이브러리 해석이 틀린 것이다.
        let absent: Vec<_> = cp
            .entries
            .iter()
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("jar"))
            .filter(|p| !p.is_file())
            .collect();
        assert!(absent.is_empty(), "없는 jar: {absent:?}");
        // 클래스를 아예 못 찾은 모듈이 있으면 실행은 NoClassDefFound 로 죽는다.
        // (`target/classes` 가 비어 있어도 같은 폴더의 jar 로 대체돼야 한다.)
        assert!(
            cp.missing.is_empty(),
            "클래스를 찾지 못한 모듈: {:?}",
            cp.missing
        );
        // 대체분은 실제로 존재하는 경로여야 한다.
        for (m, p) in &cp.substituted {
            assert!(p.exists(), "{m} 의 대체 경로가 없다: {p:?}");
        }
    }

    /// 경로 설정은 사용자가 손으로 적는 값이라, 무엇이 틀렸는지 문장으로 구분돼야 한다.
    /// (전부 "모델을 못 읽었다" 로 뭉개면 오타인지 임포트를 안 한 것인지 알 수 없다.)
    #[test]
    fn tells_apart_the_ways_a_project_path_can_be_wrong() {
        let err = |raw: &str| resolve_project(raw).unwrap_err();

        assert!(err("").contains("지정되지 않았"));
        assert!(err("   ").contains("지정되지 않았"));
        assert!(err("/definitely/not/here").contains("폴더가 없습니다"));

        // 폴더는 있지만 IntelliJ 프로젝트가 아닌 경우.
        let tmp = std::env::temp_dir().join("myspace-standalone-path-test");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        assert!(err(&tmp.to_string_lossy()).contains(".idea"));

        // `.idea` 는 있지만 실행 설정이 없는 경우.
        fs::create_dir_all(tmp.join(".idea")).unwrap();
        assert!(err(&tmp.to_string_lossy()).contains("runConfigurations"));

        // 둘 다 갖추면 통과하고, 경로는 그대로 돌아온다.
        fs::create_dir_all(tmp.join(".idea").join("runConfigurations")).unwrap();
        assert_eq!(
            resolve_project(&tmp.to_string_lossy()).unwrap(),
            tmp.to_string_lossy()
        );
        // 앞뒤 공백은 다듬는다(입력란에서 붙여넣으면 흔히 섞인다).
        assert_eq!(
            resolve_project(&format!("  {}  ", tmp.to_string_lossy())).unwrap(),
            tmp.to_string_lossy()
        );

        let _ = fs::remove_dir_all(&tmp);
    }

    /// `~` 는 홈으로 펼쳐진다 — 설정 입력란에 `~/git/cowork` 로 적는 사람이 있다.
    #[test]
    fn expands_tilde_in_the_project_path() {
        let home = home_dir().unwrap();
        // 홈 자체는 존재하지만 IntelliJ 프로젝트가 아니므로 `.idea` 를 지적해야 한다.
        // (= `~` 가 펼쳐졌다는 증거다. 펼치지 못했다면 "폴더가 없습니다" 가 나온다.)
        let msg = resolve_project("~").unwrap_err();
        assert!(msg.contains(".idea"), "{msg}");
        assert!(msg.contains(&home.to_string_lossy().to_string()), "{msg}");
    }

    /// 재기동 후 프로세스를 되찾는 규칙. **IDE 가 띄운 같은 서비스를 집어 오면 안 된다** —
    /// 그것은 우리가 SIGINT 를 보낼 대상이 아니고, 콘솔도 우리 것이 아니다.
    #[test]
    fn finds_only_processes_we_launched_ourselves() {
        let dir = argfile_path("X").unwrap().parent().unwrap().to_path_buf();
        let d = dir.display();
        let procs = vec![
            (
                101,
                format!("/jdk/bin/java -Xms64m @{d}/RegistryApplication.args spectra.Registry"),
            ),
            (
                102,
                format!("/jdk/bin/java @{d}/ApiGatewayApplication__agent_.args spectra.ApiGateway"),
            ),
            (
                103,
                format!(
                    "/jdk/bin/java @{d}/ApiGatewayApplication__customer_.args spectra.ApiGateway"
                ),
            ),
            // IntelliJ 가 띄운 같은 서비스 — 인자 파일 표식이 없다.
            (
                104,
                "/jdk/bin/java -cp /long/idea/classpath spectra.attic.UaaApplication".to_string(),
            ),
        ];

        assert_eq!(find_orphan(&procs, "RegistryApplication"), Some(101));
        // 이름의 공백·괄호는 인자 파일 이름에서 `_` 가 되고, 형제 설정끼리 갈린다.
        assert_eq!(
            find_orphan(&procs, "ApiGatewayApplication (agent)"),
            Some(102)
        );
        assert_eq!(
            find_orphan(&procs, "ApiGatewayApplication (customer)"),
            Some(103)
        );
        // IDE 로 띄운 것은 우리 것이 아니다.
        assert_eq!(find_orphan(&procs, "UaaApplication"), None);
        // 이름이 서로의 부분 문자열이어도 섞이지 않는다.
        assert_eq!(find_orphan(&procs, "Registry"), None);
        assert_eq!(find_orphan(&procs, "MyRegistryApplication"), None);
    }

    /// 지금 이 머신에 떠 있는 것을 실제로 되찾을 수 있는지 — 살아 있을 때만 확인한다.
    #[test]
    fn finds_live_processes_on_this_machine() {
        let procs = ps_list();
        let marker = argfile_path("x")
            .unwrap()
            .parent()
            .unwrap()
            .display()
            .to_string();
        // 이 백엔드로 띄운 프로세스가 하나도 없으면 검증할 게 없다.
        if !procs.iter().any(|(_, cmd)| cmd.contains(&marker)) {
            return;
        }
        if !Path::new(COWORK).is_dir() {
            return;
        }
        let names: Vec<String> = read_metas(COWORK).into_keys().collect();
        let found: Vec<(String, u32)> = names
            .iter()
            .filter_map(|n| find_orphan(&procs, n).map(|p| (n.clone(), p)))
            .collect();
        assert!(
            !found.is_empty(),
            "인자 파일 표식을 가진 프로세스가 있는데 어느 실행 설정에도 매칭되지 않았다"
        );
        // 한 프로세스가 두 설정에 잡히면 상태가 서로를 덮어쓴다.
        let mut pids: Vec<u32> = found.iter().map(|(_, p)| *p).collect();
        pids.sort_unstable();
        let before = pids.len();
        pids.dedup();
        assert_eq!(
            before,
            pids.len(),
            "같은 pid 가 여러 설정에 매칭됐다: {found:?}"
        );
    }

    #[test]
    fn rejects_jars_that_must_not_be_on_the_classpath() {
        let plain = Path::new("/x/share-service-2.1.0.jar");
        assert!(is_plain_class_jar(plain));
        // bootJar(-exec) 는 클래스가 BOOT-INF/classes 안에 있어 -cp 로 읽히지 않는다.
        assert!(!is_plain_class_jar(Path::new(
            "/x/registry-boot-1.0-exec.jar"
        )));
        // fat jar 는 의존성을 품고 있어 넣으면 클래스가 중복된다.
        assert!(!is_plain_class_jar(Path::new(
            "/x/share-log-monitor-2.1.0-all.jar"
        )));
        assert!(!is_plain_class_jar(Path::new("/x/a-1.0-sources.jar")));
        assert!(!is_plain_class_jar(Path::new("/x/a-1.0-javadoc.jar")));
        assert!(!is_plain_class_jar(Path::new("/x/a-1.0-tests.jar")));
        assert!(!is_plain_class_jar(Path::new("/x/a.pom")));
    }

    /// 실행 설정 XML → java 커맨드. 프로필·VM 옵션·클래스패스 수정이 모두 반영돼야 한다.
    #[test]
    fn builds_the_java_command_for_a_real_run_config() {
        if !Path::new(COWORK).is_dir() {
            return;
        }
        let Ok(model) = Model::load(COWORK) else {
            return;
        };
        let metas = read_metas(COWORK);
        let Some(meta) = metas.get("RegistryApplication") else {
            return;
        };
        let launch = match build_launch(COWORK, "RegistryApplication", meta, &model) {
            Ok(l) => l,
            Err(e) => panic!("커맨드 조립 실패: {e}"),
        };

        assert!(launch.java.ends_with("bin/java"), "{:?}", launch.java);
        assert!(launch.args.contains(&"-Xms64m".to_string()));
        assert!(launch
            .args
            .contains(&"-Dspring.profiles.active=local,kmhan".to_string()));
        // 콘솔을 파이프로 읽으므로 Spring Boot 는 색을 스스로 끈다 — 켜 주지 않으면
        // 콘솔에 구문 강조가 사라진다.
        assert!(launch
            .args
            .contains(&"-Dspring.output.ansi.enabled=always".to_string()));
        // 메인 클래스는 @argfile 뒤에 와야 한다(그 앞은 전부 JVM 옵션이다).
        let main = "spectra.attic.coreasset.ecosystem.registry.RegistryApplication";
        let at = launch.args.iter().position(|a| a.starts_with('@')).unwrap();
        let mc = launch.args.iter().position(|a| a == main).unwrap();
        assert!(
            at < mc,
            "@argfile 이 메인 클래스 뒤에 있다: {:?}",
            launch.args
        );

        // classpathModifications 의 mysql 커넥터가 클래스패스에 들어갔는지.
        let argfile = launch.args[at].trim_start_matches('@');
        let text = fs::read_to_string(argfile).unwrap();
        assert!(
            text.contains("mysql-connector-j"),
            "classpathModifications 가 반영되지 않았다"
        );
    }
}
