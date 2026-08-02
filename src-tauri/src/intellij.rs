//! IntelliJ 실행 설정(run configuration) 연동 — **IntelliJ 를 직접 구동한다.**
//!
//! IntelliJ 내장 MCP 서버(`src/mcp.rs`)의 도구를 호출해 IDE 가 자기 실행 설정을
//! 그대로 실행하게 한다. 따라서 Make(컴파일), 클래스패스 수정, 프로필, VM 옵션,
//! 환경변수가 IDE 에서 누른 것과 100% 동일하다. Maven/Gradle 로 재현하는 방식은
//! 설정과 어긋날 여지가 계속 생기므로 쓰지 않는다.
//!
//! - 목록: `get_run_configurations` (프로젝트 파일로 저장되지 않은 설정까지 모두 보인다)
//! - 시작: `execute_run_configuration { waitForExit: false }`
//! - 로그: 위 호출이 돌려주는 `fullOutputPath` 파일을 tail 해서 이벤트로 흘린다
//! - 종료: **MCP 에 중지 도구가 없다.** 그래서 IDE 가 띄운 앱 JVM 트리를 찾아 SIGINT 한다
//!   (= IntelliJ 정지 버튼과 같은 신호. 강제 종료는 한 번 더 눌렀을 때만).
//!   대상 프로세스는 `.idea/runConfigurations/*.xml` 의 메인 클래스로 식별한다.
//! - 상태 동기화: IntelliJ 에서 직접 시작·중지한 실행도 그대로 따라간다. 시작은 MCP 가
//!   알려주지 않으므로 `intellij_watch_project` 가 띄운 스레드가 `adopt_external` 로
//!   주기적으로 찾아내고, 중지는 `watch_alive` 의 pid 생존 확인으로 즉시 잡힌다.
//! - 프로세스 식별: 메인 클래스 + 프로젝트 경로로 찾되, **클래스가 겹치는 설정**
//!   (cowork 의 ApiGatewayApplication agent/customer/mobile)은 활성 프로필로 가른다.
//!   서비스 포트는 프로젝트 규약 파일(`attic-port.yml`)에서 미리 알아 둔다.
//!
//! XML 파싱은 화면 표시용 메타데이터(모듈·프로필·VM 옵션)와 위 프로세스 식별에만 쓴다.
//! 실행 자체는 전부 IntelliJ 가 한다.

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::mcp;

/// 메인 클래스로 프로세스를 찾을 때까지 기다리는 최대 시간.
/// IntelliJ 가 Make(컴파일)를 먼저 하므로 첫 실행은 오래 걸릴 수 있다.
const PID_WAIT: Duration = Duration::from_secs(180);
/// 프로세스 탐색·생존 확인 폴링 주기.
pub(crate) const POLL: Duration = Duration::from_millis(500);
/// IntelliJ 에서 직접 띄운 실행을 찾아내는 폴링 주기(`intellij_watch_project`).
/// MCP 는 "실행이 시작됐다" 는 알림을 주지 않으므로 주기적으로 훑는 수밖에 없다.
const ADOPT_POLL: Duration = Duration::from_secs(3);
/// 창이 트레이로 내려가 있을 때의 폴링 주기. 아무도 보고 있지 않은 동안 `ps` 를
/// 3초마다 띄우는 건 낭비다 — 창을 다시 열면 즉시 원래 주기로 돌아온다.
const ADOPT_POLL_IDLE: Duration = Duration::from_secs(20);
/// 로그 파일 tail 폴링 주기.
const TAIL_POLL: Duration = Duration::from_millis(300);
/// 재시작 시 SIGINT 로 곱게 죽기를 기다리는 시간. 넘으면 SIGKILL.
pub(crate) const STOP_GRACE: Duration = Duration::from_secs(20);
/// 재시작 시 종료를 포기하는 시각(여기까지 살아 있으면 에러).
pub(crate) const STOP_TIMEOUT: Duration = Duration::from_secs(60);
/// 이전 실행의 감시 스레드가 상태를 정리하기를 기다리는 시간.
const WATCHER_CLEANUP: Duration = Duration::from_secs(5);
/// 임시 포트(ephemeral) 영역의 시작. 이 이상은 JMX·디버그용으로 JVM 이 잡는 포트라
/// 서비스 포트로 보지 않는다(macOS 기본 임시 포트 영역은 49152~65535 이지만,
/// 여유를 두어 32768 이상을 임시 포트로 취급한다).
pub(crate) const EPHEMERAL_FROM: u16 = 32768;
/// 고정 포트가 이 시간 안에 안 나타나면(고정 포트를 안 쓰는 서비스) 임시 포트라도 표시한다.
pub(crate) const PORT_FALLBACK_AFTER: Duration = Duration::from_secs(30);
/// 서비스별로 Rust 쪽에 보관하는 로그 줄 수 상한.
/// 화면(메뉴)을 벗어나면 프론트 상태가 사라지므로, 다시 들어왔을 때 복원할 수 있게
/// 여기에 쌓아 둔다.
pub(crate) const LOG_BUFFER_MAX: usize = 4000;
/// tail 한 번에 프론트로 흘려보낼 최대 바이트. 이보다 많이 밀려 있으면 **끝부분만** 읽고
/// 나머지는 건너뛴다.
///
/// IDE 로그 동기화를 켜 두면 실행이 이어지는 동안 파일이 수십 MB 로 자란다. 그 파일을
/// 처음부터 재생하면 화면에 남지도 않는 수십만 줄이 이벤트로 쏟아져, **프로세스가 죽은
/// 뒤에도 몇 분 동안 로그가 계속 흘러나온다**(프론트 이벤트 큐가 그만큼 밀린다).
/// 화면은 어차피 마지막 2000줄만 보여 주므로 최근 분량만 읽는 게 맞다.
const MAX_CATCHUP: u64 = 512 * 1024;

/// 추적 중인 프로세스 하나.
#[derive(Clone, Copy)]
pub struct Proc {
    pid: u32,
    /// LISTEN 중인 대표 포트. 뜬 직후에는 아직 바인딩 전이라 None 일 수 있다.
    port: Option<u16>,
}

/// 실행 중인 서비스 추적: 설정 이름 → IDE 가 띄운 앱 JVM 들.
/// Multirun 은 자식들의 프로세스를 모아 갖는다.
#[derive(Default)]
pub struct ServiceState(pub Mutex<HashMap<String, Vec<Proc>>>);

/// 한 번의 실행에 대해 로그로 관찰한 신호. 종료 시 실패/정상 판정에 쓴다.
#[derive(Default, Clone)]
struct Outcome {
    /// "Started XxxApplication" 성공 로그를 봤는지.
    started: bool,
    /// 로그에서 감지한 실패 사유(예: "APPLICATION FAILED TO START"). 있으면 실패로 확정.
    fail_reason: Option<String>,
}

/// 실행 판정용 부가 상태.
/// - `stopping`: 사용자가 stop/restart 로 **명시적으로** 내리는 중인 이름(종료를 실패로 오판하지 않게).
/// - `outcome`: 서비스별 로그 신호(위 Outcome). tail_log 가 채우고, 종료 시 finalize 가 읽어 판정.
#[derive(Default)]
pub struct RunTracking {
    stopping: Mutex<HashSet<String>>,
    outcome: Mutex<HashMap<String, Outcome>>,
    /// 지금 tail 중인 `설정이름\0로그경로` 키. 같은 파일을 두 스레드가 tail 하면
    /// 모든 줄이 두 번 표시되므로 하나만 허용한다.
    tails: Mutex<HashSet<String>>,
    /// 서비스별 로그 버퍼(오래된 줄부터 버린다).
    /// 프론트는 메뉴를 벗어나면 상태를 잃기 때문에, 다시 들어왔을 때 이걸 읽어 복원한다.
    logs: Mutex<HashMap<String, VecDeque<String>>>,
    /// 시작 요청을 보냈지만 아직 pid 를 잡지 못한 이름.
    /// 이 틈에 `adopt_external` 이 같은 프로세스를 "외부 실행" 으로 또 붙잡으면
    /// 감시 스레드와 tail 이 이중으로 돌아 로그가 두 번씩 보인다.
    starting: Mutex<HashSet<String>>,
    /// 직전 실행이 끝났으면 그 결과: 이름 → 실패 사유(정상 중지면 None).
    /// `note_exit` 가 채우고 다음 시작(`reset_tracking`)에서 지운다.
    exits: Mutex<HashMap<String, Option<String>>>,
}

/// 외부 실행 자동 감지(`watch_external`)의 대상 프로젝트.
#[derive(Default)]
pub struct WatchProject {
    /// 화면에서 고른 프로젝트 경로. None 이면 감시를 쉰다.
    path: Mutex<Option<String>>,
    /// 감시 스레드가 이미 돌고 있는지(중복 기동 방지). 스레드는 프로세스당 하나다.
    running: Mutex<bool>,
}

/// 실행 설정 하나. 프론트엔드의 Service 타입과 대응.
#[derive(Serialize, Clone)]
pub struct Service {
    /// 설정 이름(예: "UaaApplication").
    pub(crate) name: String,
    /// 정규화한 종류: "spring-boot" | "multirun" | "junit" | "java" | "http" | "other".
    #[serde(rename = "type")]
    pub(crate) kind: String,
    /// IntelliJ 가 준 설정 설명(예: "Spring Boot Application").
    pub(crate) description: Option<String>,
    /// IntelliJ 모듈명(XML 이 있을 때만).
    pub(crate) module: Option<String>,
    /// 메인 클래스. 종료 대상 프로세스를 찾는 열쇠다.
    pub(crate) main_class: Option<String>,
    /// 활성 스프링 프로필(예: "local,kmhan").
    pub(crate) profiles: Option<String>,
    /// VM 옵션(예: "-Xms128m -Xmx256m").
    pub(crate) vm_parameters: Option<String>,
    /// Multirun 이 참조하는 하위 설정 이름들.
    pub(crate) children: Vec<String>,
    /// 이 앱에서 **종료**까지 가능한지. 메인 클래스를 알아야 프로세스를 찾을 수 있다.
    pub(crate) stoppable: bool,
    /// 프로젝트 규약(`attic-port.yml`)에서 알아낸 예상 서비스 포트.
    /// 실행 전에도 어떤 포트로 뜰지 보여 주고, 여러 포트를 여는 서비스에서
    /// 대표 포트를 고르는 근거가 된다. 규약이 없는 프로젝트에서는 None.
    pub(crate) expected_port: Option<u16>,
    /// IDE 로그 동기화("Save console output to file") 상태.
    /// - `Some(true)`  — 켜져 있다. IntelliJ 의 Run 버튼으로 띄운 실행도 여기서 볼 수 있다.
    /// - `Some(false)` — 꺼져 있다. `intellij_enable_log_sync` 로 켤 수 있다.
    /// - `None`        — 실행 설정이 프로젝트 파일(`.idea/runConfigurations/*.xml`)로
    ///   저장돼 있지 않아 손댈 수 없다(임시 설정 등).
    pub(crate) log_sync: Option<bool>,
}

/// 최근 IntelliJ 프로젝트(프로젝트 선택 드롭다운용).
#[derive(Serialize, Clone)]
pub struct RecentProject {
    name: String,
    path: String,
}

/// 실행 중 서비스 정보(status 조회 응답).
#[derive(Serialize, Clone)]
pub struct Running {
    name: String,
    pid: u32,
    /// LISTEN 중인 대표 포트(IntelliJ Services 처럼 목록에 표시한다).
    port: Option<u16>,
}

/// MCP 연결 상태(화면 상단 안내용).
#[derive(Serialize, Clone)]
pub struct McpStatus {
    connected: bool,
    /// 연결된 주소(연결 성공 시).
    url: Option<String>,
    /// 실패 사유(연결 실패 시).
    error: Option<String>,
}

/// 서비스 상태 변화 이벤트(`intellij:status`).
#[derive(Serialize, Clone)]
struct StatusPayload {
    name: String,
    running: bool,
    /// 찾아낸 앱 JVM pid(있으면).
    pid: Option<u32>,
    /// LISTEN 포트. 기동 직후에는 없다가 나중에 채워져 다시 방출된다.
    port: Option<u16>,
    /// 시작 실패·실행 중 크래시로 종료됐으면 그 사유. 정상(실행/사용자 중지)이면 None.
    /// 프론트는 이 값이 있으면 빨간 "실패" 아이콘을 다음 시작까지 유지한다.
    failed: Option<String>,
}

/// 로그 한 줄 이벤트(`intellij:log`).
#[derive(Serialize, Clone)]
struct LogPayload {
    name: String,
    line: String,
}

// ─────────────────────────── 실행 설정 메타데이터(XML) ───────────────────────────

/// XML 에서 뽑아낸 설정 메타데이터.
#[derive(Default, Clone)]
pub(crate) struct Meta {
    pub(crate) kind: Option<String>,
    /// 이 설정이 나온 XML 파일. 로그 동기화를 켤 때 여기에 써 넣는다.
    /// 프로젝트 파일로 저장되지 않은 설정(MCP 목록에만 있는 것)은 None 이다.
    pub(crate) file: Option<PathBuf>,
    /// 실행 설정의 "콘솔 출력을 파일로 저장"(Logs 탭) 경로. IntelliJ XML 의
    /// `<output_file path="…" is_save="true"/>` 에서 읽는다. 매크로 미확장 원본.
    /// 이 옵션이 켜져 있으면 **IDE 의 Run 버튼으로 띄운 실행도** 콘솔이 파일로 남아
    /// my-space 에서 그대로 이어 볼 수 있다.
    pub(crate) output_file: Option<String>,
    pub(crate) module: Option<String>,
    pub(crate) main_class: Option<String>,
    pub(crate) profiles: Option<String>,
    pub(crate) vm_parameters: Option<String>,
    pub(crate) children: Vec<String>,
    /// 프로그램 인자(`PROGRAM_PARAMETERS`). IDE 없이 띄울 때 메인 클래스 뒤에 붙인다.
    pub(crate) program_parameters: Option<String>,
    /// 작업 디렉터리(`WORKING_DIRECTORY`). 매크로 미확장 원본.
    /// 비어 있거나 `$MODULE_WORKING_DIR$` 이면 모듈 디렉터리를 쓴다.
    pub(crate) working_directory: Option<String>,
    /// 실행 설정에 적어 둔 환경변수(`<envs><env name= value=/></envs>`).
    pub(crate) envs: Vec<(String, String)>,
    /// 클래스패스 수정(`<classpathModifications><entry path= exclude=/></…>`).
    /// cowork 의 mysql 커넥터처럼 모듈 의존성에는 없는 jar 를 IDE 가 덧붙이는 자리다.
    /// 매크로 미확장 원본 경로와 "제외인가" 플래그.
    pub(crate) classpath_mods: Vec<(String, bool)>,
}

/// IntelliJ 설정 type 속성을 우리 종류로 정규화한다.
fn kind_from_type(type_attr: &str) -> String {
    let lower = type_attr.to_lowercase();
    if lower.contains("springboot") || lower == "spring boot" {
        "spring-boot"
    } else if lower.contains("multirun") {
        "multirun"
    } else if lower.contains("junit") {
        "junit"
    } else if lower.contains("application") {
        "java"
    } else if lower.contains("http") {
        "http"
    } else {
        "other"
    }
    .to_string()
}

/// MCP 가 준 설명 문구로 종류를 추정한다(XML 이 없는 설정용).
fn kind_from_description(desc: &str) -> String {
    let lower = desc.to_lowercase();
    if lower.contains("spring boot") {
        "spring-boot"
    } else if lower.contains("multiple configurations") {
        "multirun"
    } else if lower.contains("junit") || lower.contains("test") {
        "junit"
    } else if lower.contains("http request") {
        "http"
    } else if lower.contains("java application") {
        "java"
    } else {
        "other"
    }
    .to_string()
}

/// 실행 설정 XML 파일 하나를 파싱해 (이름, 메타데이터)를 돌려준다.
fn parse_config_file(path: &Path) -> Option<(String, Meta)> {
    let text = fs::read_to_string(path).ok()?;
    let doc = roxmltree::Document::parse(&text).ok()?;
    let config = doc.descendants().find(|n| n.has_tag_name("configuration"))?;
    let name = config.attribute("name")?.to_string();

    let mut meta = Meta {
        kind: Some(kind_from_type(config.attribute("type").unwrap_or(""))),
        file: Some(path.to_path_buf()),
        ..Default::default()
    };

    for opt in config.children().filter(|n| n.has_tag_name("option")) {
        match opt.attribute("name") {
            Some("ACTIVE_PROFILES") => meta.profiles = opt.attribute("value").map(str::to_string),
            Some("SPRING_BOOT_MAIN_CLASS") | Some("MAIN_CLASS_NAME") => {
                meta.main_class = opt.attribute("value").map(str::to_string)
            }
            Some("VM_PARAMETERS") => {
                meta.vm_parameters = opt.attribute("value").map(str::to_string)
            }
            Some("PROGRAM_PARAMETERS") => {
                meta.program_parameters = opt.attribute("value").map(str::to_string)
            }
            Some("WORKING_DIRECTORY") => {
                meta.working_directory = opt.attribute("value").map(str::to_string)
            }
            _ => {}
        }
    }

    // <envs><env name="FOO" value="bar" /></envs>
    meta.envs = config
        .children()
        .filter(|n| n.has_tag_name("envs"))
        .flat_map(|n| n.children())
        .filter(|n| n.has_tag_name("env"))
        .filter_map(|n| Some((n.attribute("name")?.to_string(), n.attribute("value")?.to_string())))
        .collect();

    // <classpathModifications><entry path="…" exclude="true" /></classpathModifications>
    meta.classpath_mods = config
        .children()
        .filter(|n| n.has_tag_name("classpathModifications"))
        .flat_map(|n| n.children())
        .filter(|n| n.has_tag_name("entry"))
        .filter_map(|n| {
            let path = n.attribute("path")?;
            Some((path.to_string(), n.attribute("exclude") == Some("true")))
        })
        .collect();

    // <output_file path="$PROJECT_DIR$/logs/registry.log" is_save="true" />
    meta.output_file = config
        .children()
        .find(|n| n.has_tag_name("output_file") && n.attribute("is_save") == Some("true"))
        .and_then(|n| n.attribute("path"))
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    meta.module = config
        .children()
        .find(|n| n.has_tag_name("module"))
        .and_then(|m| m.attribute("name"))
        .map(str::to_string);

    meta.children = config
        .children()
        .filter(|n| n.has_tag_name("runConfiguration"))
        .filter_map(|n| n.attribute("name").map(str::to_string))
        .collect();

    Some((name, meta))
}

/// 프로젝트의 `.idea/runConfigurations/*.xml` 을 모두 파싱한 메타데이터 맵.
pub(crate) fn read_metas(project: &str) -> HashMap<String, Meta> {
    let dir = Path::new(project).join(".idea").join("runConfigurations");
    let mut out = HashMap::new();
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) == Some("xml") {
                if let Some((name, meta)) = parse_config_file(&p) {
                    out.insert(name, meta);
                }
            }
        }
    }
    out
}

// ─────────────────────────── IDE 로그 동기화(Logs 탭 자동 설정) ───────────────────────────

/// 동기화를 켤 때 콘솔 출력을 쌓을 폴더(프로젝트 기준 상대 경로).
///
/// `.idea` 아래에 두는 이유: 대부분의 프로젝트가 `.idea` 를 이미 VCS 에서 제외하고,
/// `$PROJECT_DIR$` 매크로로 적을 수 있어 XML 에 머신별 절대경로가 남지 않는다.
/// (`.idea` 를 커밋하는 프로젝트를 위해 폴더 안에 `*` 짜리 `.gitignore` 도 같이 만든다.)
const LOG_DIR_REL: &str = ".idea/my-space-logs";

/// 파일명으로 쓸 수 있게 특수문자를 `_` 로 바꾼다.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// Multirun 을 재귀적으로 펼쳐, XML 을 손댈 수 있는 말단 설정 이름들을 모은다.
/// Multirun 자체는 콘솔이 없으므로 로그 동기화는 언제나 말단 설정에 걸어야 한다.
pub(crate) fn leaf_configs(metas: &HashMap<String, Meta>, name: &str) -> Vec<String> {
    fn walk(
        metas: &HashMap<String, Meta>,
        name: &str,
        out: &mut Vec<String>,
        seen: &mut HashSet<String>,
    ) {
        if !seen.insert(name.to_string()) {
            return; // Multirun 이 서로를 참조하는 경우의 무한 재귀 방지
        }
        let Some(meta) = metas.get(name) else { return };
        if meta.kind.as_deref() == Some("multirun") {
            for child in &meta.children {
                walk(metas, child, out, seen);
            }
        } else if meta.file.is_some() {
            out.push(name.to_string());
        }
    }
    let mut out = Vec::new();
    walk(metas, name, &mut out, &mut HashSet::new());
    out
}

/// 화면에 표시할 로그 동기화 상태(`Service::log_sync` 참고).
/// Multirun 은 하위가 **모두** 켜져 있을 때만 켜진 것으로 본다.
fn log_sync_state(metas: &HashMap<String, Meta>, name: &str) -> Option<bool> {
    let meta = metas.get(name)?;
    if meta.kind.as_deref() == Some("multirun") {
        let leaves = leaf_configs(metas, name);
        if leaves.is_empty() {
            return None;
        }
        return Some(
            leaves
                .iter()
                .all(|n| metas.get(n).is_some_and(|m| m.output_file.is_some())),
        );
    }
    meta.file.as_ref()?;
    Some(meta.output_file.is_some())
}

/// XML 속성값에 그대로 넣을 수 있게 이스케이프한다.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `start` 위치의 여는 태그부터 그 요소가 끝나는 위치(배타적)를 찾는다.
/// 속성값 안의 `>` 에 속지 않도록 따옴표를 따라간다.
fn find_element_end(xml: &str, start: usize) -> Option<usize> {
    const CLOSE: &str = "</output_file>";
    let b = xml.as_bytes();
    let mut quote: Option<u8> = None;
    for i in start..b.len() {
        match (quote, b[i]) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, c @ (b'"' | b'\'')) => quote = Some(c),
            (None, b'>') => {
                return if b[i - 1] == b'/' {
                    Some(i + 1) // <output_file … />
                } else {
                    // 자기 종료가 아니면 닫는 태그까지가 이 요소다.
                    xml[i..].find(CLOSE).map(|off| i + off + CLOSE.len())
                };
            }
            (None, _) => {}
        }
    }
    None
}

/// 실행 설정 XML 에 `<output_file path="…" is_save="true"/>` 를 넣는다(이미 있으면 교체).
///
/// roxmltree 는 읽기 전용이라 문자열을 직접 손본다. 어차피 다른 줄은 건드리지 않는 편이
/// 좋다 — IntelliJ 가 나중에 이 파일을 다시 저장할 때 diff 가 최소로 남는다.
/// 속성 순서(`path` → `is_save`)도 IntelliJ 의 직렬화 순서에 맞췄다.
///
/// `<configuration>` 을 찾지 못하면 None.
fn patch_output_file_xml(xml: &str, path_value: &str) -> Option<String> {
    let element = format!(
        "<output_file path=\"{}\" is_save=\"true\" />",
        xml_escape(path_value)
    );

    // 1) 이미 있으면 그 자리를 통째로 바꾼다(`is_save="false"` 로 꺼 둔 경우 포함).
    if let Some(start) = xml.find("<output_file") {
        let end = find_element_end(xml, start)?;
        return Some(format!("{}{element}{}", &xml[..start], &xml[end..]));
    }

    // 2) 없으면 `<method>` 바로 앞에 — IntelliJ 도 그 자리에 쓴다.
    //    `<method>` 가 없는 설정이면 `</configuration>` 앞에 한 단 더 들여써서 넣는다.
    let (anchor, extra_indent) = match xml.find("<method") {
        Some(i) => (i, ""),
        None => (xml.find("</configuration>")?, "  "),
    };
    let line_start = xml[..anchor].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let indent = &xml[line_start..anchor];
    Some(format!(
        "{}{indent}{extra_indent}{element}\n{}",
        &xml[..line_start],
        &xml[line_start..]
    ))
}

/// 실행 설정의 "Save console output to file"(Logs 탭)을 켠다.
///
/// IDE 의 Run 버튼으로 띄운 프로세스의 stdout 은 IntelliJ 프로세스와 연결된 파이프라
/// 밖에서 읽을 수 없다. 유일한 우회로가 **IDE 가 콘솔을 파일로도 쓰게 만드는 것**이고,
/// 그 파일을 `adopt_external` → `configured_log` 가 찾아 tail 한다.
///
/// 켜는 방식은 `.idea/runConfigurations/<설정>.xml` 을 직접 고치는 것이다. IntelliJ 는
/// 프로젝트 파일이 밖에서 바뀌면 다시 읽으므로(`git pull` 과 같은 경로) IDE 를 다시
/// 켤 필요는 없다. 다만 **이미 떠 있는 프로세스에는 적용되지 않는다** — 다음 실행부터다.
///
/// Multirun 은 자기 콘솔이 없으므로 하위 설정을 재귀적으로 펼쳐 각각 켠다.
/// 돌려주는 값은 **실제로 바꾼** 설정 이름들이다(이미 켜져 있던 것은 빠진다).
#[tauri::command]
pub fn intellij_enable_log_sync(
    app: tauri::AppHandle,
    project: String,
    name: String,
) -> Result<Vec<String>, String> {
    let metas = read_metas(&project);
    let meta = metas.get(&name).ok_or_else(|| {
        format!("'{name}' 의 실행 설정 XML 을 찾을 수 없습니다 — 프로젝트 파일로 저장된 설정만 켤 수 있습니다")
    })?;

    let targets = if meta.kind.as_deref() == Some("multirun") {
        leaf_configs(&metas, &name)
    } else if meta.file.is_some() {
        vec![name.clone()]
    } else {
        Vec::new()
    };
    if targets.is_empty() {
        return Err(format!("'{name}' 은 로그 동기화를 켤 수 있는 설정이 없습니다"));
    }

    let dir = Path::new(&project).join(LOG_DIR_REL);
    fs::create_dir_all(&dir).map_err(|e| format!("로그 폴더를 만들지 못했습니다: {e}"))?;
    // `.idea` 를 커밋하는 프로젝트에서도 로그 파일이 VCS 에 잡히지 않게 한다.
    let _ = fs::write(dir.join(".gitignore"), "*\n");

    let mut changed = Vec::new();
    for target in targets {
        let Some(m) = metas.get(&target) else { continue };
        if m.output_file.is_some() {
            continue; // 이미 켜져 있다
        }
        let Some(file) = m.file.as_ref() else { continue };
        let xml = fs::read_to_string(file)
            .map_err(|e| format!("'{target}' 의 XML 을 읽지 못했습니다: {e}"))?;
        let value = format!("$PROJECT_DIR$/{LOG_DIR_REL}/{}.log", sanitize(&target));
        let patched = patch_output_file_xml(&xml, &value)
            .ok_or_else(|| format!("'{target}' 의 XML 형식을 알아보지 못했습니다"))?;
        fs::write(file, patched)
            .map_err(|e| format!("'{target}' 의 XML 을 저장하지 못했습니다: {e}"))?;
        changed.push(target);
    }

    // 결과를 해당 서비스 콘솔에도 남긴다 — 안내 문구를 보고 누른 자리에서 바로 확인된다.
    if changed.is_empty() {
        emit_log(&app, &name, "[my-space] 이미 IDE 로그 동기화가 켜져 있습니다.");
    } else {
        emit_log(
            &app,
            &name,
            &format!(
                "[my-space] IDE 로그 동기화를 켰습니다 ({}). 지금 떠 있는 프로세스에는 \
                 적용되지 않습니다 — 다음 실행부터 IntelliJ 콘솔 출력이 여기에 그대로 표시됩니다.",
                changed.join(", ")
            ),
        );
    }
    Ok(changed)
}

// ─────────────────────────── 서비스 포트 매핑(프로젝트 규약) ───────────────────────────

/// cowork 규약: 서비스 포트가 한 파일에 모여 있다.
/// 각 서비스의 config 는 `server.port: ${attic.port.${spring.application.name}:8080}` 로
/// 이 값을 참조한다(그래서 8080 은 기본값일 뿐이고, 실제 포트는 여기 적힌 값이다).
/// 이 파일이 없는 프로젝트에서는 그냥 예상 포트를 모르는 상태로 동작한다.
const PORT_MAP_REL: &str = "biz/dworks-common-resource/registry-config/attic-port.yml";

/// `attic.port.<이름>: <포트>` 를 읽어 맵으로 돌려준다(파일이 없으면 빈 맵).
///
/// yaml 파서를 새로 들이지 않고 이 2단 매핑만 훑는다 — 형식이 고정돼 있고,
/// 다른 키(`attic.xxx`)나 주석은 그냥 지나친다.
pub(crate) fn read_port_map(project: &str) -> HashMap<String, u16> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string(Path::new(project).join(PORT_MAP_REL)) else {
        return out;
    };

    // `attic:` → `port:` 아래에서, 그보다 깊게 들여쓴 `이름: 포트` 줄만 읽는다.
    let indent_of = |l: &str| l.len() - l.trim_start().len();
    let mut in_attic = false;
    let mut port_indent: Option<usize> = None;

    for line in text.lines() {
        let body = line.split('#').next().unwrap_or("").trim_end();
        if body.trim().is_empty() {
            continue;
        }
        let indent = indent_of(body);
        let trimmed = body.trim();

        if let Some(base) = port_indent {
            if indent <= base {
                port_indent = None; // port 블록이 끝났다.
                if indent == 0 {
                    in_attic = trimmed == "attic:";
                }
                continue;
            }
            if let Some((key, value)) = trimmed.split_once(':') {
                if let Ok(port) = value.trim().trim_matches(['"', '\'']).parse::<u16>() {
                    out.insert(key.trim().to_string(), port);
                }
            }
            continue;
        }
        if indent == 0 {
            in_attic = trimmed == "attic:";
        } else if in_attic && trimmed == "port:" {
            port_indent = Some(indent);
        }
    }
    out
}

/// 설정 하나의 예상 포트.
///
/// 키는 IntelliJ 모듈 이름에서 `-boot` 를 뗀 것이다(uaa-boot → uaa). 한 모듈을 프로필로
/// 나눠 쓰는 경우(apigateway 의 agent/customer/mobile → apigateway-agent …)가 있으므로
/// `<모듈>-<프로필>` 을 먼저 찾고, 없으면 `<모듈>` 로 떨어진다.
pub(crate) fn expected_port(ports: &HashMap<String, u16>, meta: &Meta) -> Option<u16> {
    let module = meta.module.as_deref()?;
    let base = module.strip_suffix("-boot").unwrap_or(module);
    if let Some(profiles) = meta.profiles.as_deref() {
        for p in profiles.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            if let Some(port) = ports.get(&format!("{base}-{p}")) {
                return Some(*port);
            }
        }
    }
    ports.get(base).copied()
}

// ─────────────────────────────── 커맨드: 목록 ───────────────────────────────

/// IntelliJ 가 아는 실행 설정 전체를 돌려준다. 목록은 MCP(=IDE)가 원본이고,
/// 화면 표시용 상세 정보는 XML 이 있으면 덧붙인다.
#[tauri::command]
pub async fn intellij_list_services(project: String) -> Result<Vec<Service>, String> {
    let conn = mcp::conn().await?;
    let res = conn
        .call_tool(
            "get_run_configurations",
            serde_json::json!({ "projectPath": project }),
        )
        .await?;

    let metas = read_metas(&project);
    let port_map = read_port_map(&project);
    let mut out = Vec::new();

    for c in res
        .get("configurations")
        .and_then(|v| v.as_array())
        .map(|v| v.as_slice())
        .unwrap_or_default()
    {
        let Some(name) = c.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        let description = c
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let meta = metas.get(name).cloned().unwrap_or_default();

        let kind = meta.kind.clone().unwrap_or_else(|| {
            description
                .as_deref()
                .map(kind_from_description)
                .unwrap_or_else(|| "other".to_string())
        });

        // 종료는 프로세스를 직접 찾아 죽이는 방식이라 메인 클래스를 알아야 한다.
        // Multirun 은 자식들 중 하나라도 찾을 수 있으면 종료 대상이 된다.
        let stoppable = match kind.as_str() {
            "multirun" => meta.children.iter().any(|ch| {
                metas
                    .get(ch)
                    .and_then(|m| m.main_class.as_ref())
                    .is_some_and(|s| !s.is_empty())
            }),
            _ => meta.main_class.as_deref().is_some_and(|s| !s.is_empty()),
        };

        // meta 를 옮기기 전에 계산한다(구조체 리터럴 안에서는 이미 부분 이동 상태다).
        let expected = expected_port(&port_map, &meta);
        let log_sync = log_sync_state(&metas, name);

        out.push(Service {
            name: name.to_string(),
            kind,
            description,
            module: meta.module,
            main_class: meta.main_class,
            profiles: meta.profiles,
            vm_parameters: meta.vm_parameters,
            expected_port: expected,
            children: meta.children,
            stoppable,
            log_sync,
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// `$HOME` 를 돌려준다(없으면 에러).
pub(crate) fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME 환경변수를 찾을 수 없습니다".to_string())
}

/// 최근 IntelliJ 프로젝트 목록. JetBrains 설정 폴더들의 recentProjects.xml 을
/// 모두 읽어 `.idea` 가 실제로 있는 프로젝트만 (중복 제거해) 돌려준다.
#[tauri::command]
pub fn intellij_recent_projects() -> Result<Vec<RecentProject>, String> {
    let home = home_dir()?;
    let jetbrains = home
        .join("Library")
        .join("Application Support")
        .join("JetBrains");

    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<RecentProject> = Vec::new();

    let ide_dirs = match fs::read_dir(&jetbrains) {
        Ok(r) => r,
        Err(_) => return Ok(out),
    };
    for ide in ide_dirs.flatten() {
        let recent = ide.path().join("options").join("recentProjects.xml");
        let text = match fs::read_to_string(&recent) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let doc = match roxmltree::Document::parse(&text) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for entry in doc.descendants().filter(|n| n.has_tag_name("entry")) {
            let Some(key) = entry.attribute("key") else {
                continue;
            };
            // recentProjects.xml 의 프로젝트 경로는 $USER_HOME$ 또는 절대경로로 시작한다.
            let expanded = if let Some(rest) = key.strip_prefix("$USER_HOME$") {
                home.join(rest.trim_start_matches('/'))
            } else if key.starts_with('/') {
                PathBuf::from(key)
            } else {
                continue;
            };
            if !expanded.join(".idea").is_dir() {
                continue;
            }
            let path = expanded.to_string_lossy().to_string();
            if !seen.insert(path.clone()) {
                continue;
            }
            let name = expanded
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            out.push(RecentProject { name, path });
        }
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 서비스의 보관된 로그를 돌려준다.
/// 프론트는 메뉴를 벗어나면 로그 상태를 잃으므로, 화면에 들어오거나 서비스를 고를 때
/// 이걸 읽어 콘솔을 복원한다. `clear` 로 지우면 버퍼도 함께 비운다.
#[tauri::command]
pub fn intellij_logs(app: tauri::AppHandle, name: String) -> Vec<String> {
    app.try_state::<RunTracking>()
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

/// 콘솔 지우기 — 프론트 상태와 Rust 버퍼를 함께 비운다.
/// (버퍼를 남겨 두면 화면을 다시 열 때 지웠던 로그가 되살아난다.)
#[tauri::command]
pub fn intellij_clear_logs(app: tauri::AppHandle, name: String) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.logs.lock().unwrap().remove(&name);
    }
}

/// MCP 연결 상태를 확인한다(화면에 안내를 띄우기 위한 용도).
#[tauri::command]
pub async fn intellij_mcp_status() -> McpStatus {
    match mcp::conn().await {
        Ok(c) => McpStatus {
            connected: true,
            url: Some(c.base.clone()),
            error: None,
        },
        Err(e) => McpStatus {
            connected: false,
            url: None,
            error: Some(e),
        },
    }
}

// ──────────────────────── 프로세스 식별 / 생존 확인 ────────────────────────

/// 실행 중인 프로세스 목록에서 (pid, 커맨드라인)을 읽는다.
pub(crate) fn ps_list() -> Vec<(u32, String)> {
    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let (pid, rest) = line.split_once(' ')?;
            Some((pid.parse::<u32>().ok()?, rest.trim().to_string()))
        })
        .collect()
}

/// 프로세스를 찾을 때 쓰는 설정 하나의 식별 정보.
#[derive(Clone, Debug, PartialEq)]
struct Target {
    main_class: String,
    /// 이 설정의 활성 프로필(예: "local,kmhan,agent").
    /// **메인 클래스가 같은 형제 설정을 구분하는 열쇠다** — cowork 의
    /// ApiGatewayApplication (agent/customer/mobile) 은 클래스가 모두 같고 프로필만 다르다.
    profiles: Option<String>,
}

/// 메인 클래스로 IDE 가 띄운 앱 JVM 을 찾는다(테스트용 단발 조회).
#[cfg(test)]
fn find_pid(main_class: &str, project: &str) -> Option<u32> {
    find_pid_in(
        &ps_list(),
        &Target {
            main_class: main_class.to_string(),
            profiles: None,
        },
        project,
    )
}

/// 이미 찍어 둔 프로세스 목록에서 이 설정의 앱 JVM 을 찾는다.
///
/// - 같은 클래스를 여러 프로젝트에서 띄울 수 있으므로 프로젝트 경로가
///   커맨드라인(클래스패스)에 있는지도 본다.
/// - 설정에 프로필이 있고 프로세스도 `-Dspring.profiles.active=` 를 달고 있으면
///   **정확히 일치할 때만** 그 설정의 것으로 인정한다. 이게 없으면 agent 를 찾을 때
///   customer 프로세스를 집어, 셋 다 같은 pid·포트로 보이고 종료도 엉뚱한 걸 내린다.
/// - `ps` 를 메인 클래스마다 새로 띄우지 않으려고 목록을 넘겨 받는다(3초 주기 폴링).
fn find_pid_in(procs: &[(u32, String)], target: &Target, project: &str) -> Option<u32> {
    procs
        .iter()
        .filter(|(_, cmd)| cmd.contains(&target.main_class) && cmd.contains(project))
        // maven/gradle 래퍼나 우리 자신이 아닌, 실제 java 프로세스만.
        .filter(|(_, cmd)| cmd.contains("/bin/java") || cmd.starts_with("java"))
        .filter(|(_, cmd)| profiles_match(target.profiles.as_deref(), cmd))
        .map(|(pid, _)| *pid)
        .next()
}

/// 커맨드라인에서 `-Dspring.profiles.active=…` 값을 뽑는다(없으면 None).
fn active_profiles_of(cmd: &str) -> Option<&str> {
    cmd.split("-Dspring.profiles.active=")
        .nth(1)
        .map(|rest| rest.split_whitespace().next().unwrap_or(""))
}

/// 설정의 프로필과 프로세스의 프로필이 어긋나지 않는지.
/// 어느 한쪽이라도 알 수 없으면(프로필 없는 설정, VM 옵션으로 안 넘기는 실행) 통과시킨다 —
/// 판단 근거가 없을 때 걸러 버리면 제어 자체를 잃는다.
fn profiles_match(want: Option<&str>, cmd: &str) -> bool {
    match (want, active_profiles_of(cmd)) {
        // 목록으로 견준다 — XML 에 "local, kmhan" 처럼 공백이 섞여 있어도 같은 값이다.
        (Some(want), Some(got)) => profile_list(want) == profile_list(got),
        _ => true,
    }
}

fn profile_list(value: &str) -> Vec<&str> {
    value
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect()
}

/// 프로세스가 LISTEN 중인 TCP 포트들을 읽는다.
/// `lsof -Fn` 은 `n*:8888` / `n127.0.0.1:8888` 형태의 줄을 준다.
pub(crate) fn listening_ports(pid: u32) -> Vec<u16> {
    let out = match std::process::Command::new("lsof")
        .args([
            "-nP",
            "-a",
            "-p",
            &pid.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fn",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let mut ports: Vec<u16> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix('n'))
        .filter_map(|addr| addr.rsplit_once(':'))
        .filter_map(|(_, port)| port.parse::<u16>().ok())
        .collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// 여러 포트 중 화면에 보여줄 대표 포트를 고른다.
/// JVM 은 JMX·디버그용으로 임시 포트(ephemeral, 32768 이상)도 여는데 그건 서비스 포트가
/// 아니다. 고정 포트가 있으면 그중 가장 작은 것을, 없으면 가장 작은 포트를 쓴다.
fn primary_port(pid: u32, expect: Option<u16>) -> Option<u16> {
    pick_service_port(&listening_ports(pid), expect)
}

/// 서비스 포트를 고른다 — **고정 포트(임시 포트 영역 밖)만** 인정한다.
///
/// JVM 은 JMX·디버그용 임시 포트를 서버 포트보다 **먼저** 열기 때문에, 아무 포트나
/// 받아들이면 8888 대신 62599 같은 값이 잡힌다. 고정 포트가 아직 없으면 None 을 주고
/// 계속 기다리는 게 맞다(잘못된 포트를 보여 주는 것보다 낫다).
///
/// `expect` (설정에서 알아낸 예상 포트)가 열려 있으면 그것을 쓴다. 고정 포트를 여럿
/// 여는 서비스에서 "가장 작은 것" 추측이 어긋나는 경우를 없애 준다.
pub(crate) fn pick_service_port(ports: &[u16], expect: Option<u16>) -> Option<u16> {
    if let Some(want) = expect {
        if ports.contains(&want) {
            return Some(want);
        }
    }
    ports.iter().copied().find(|p| *p < EPHEMERAL_FROM)
}

/// 고정 포트가 끝까지 안 나타날 때(고정 포트를 쓰지 않는 서비스) 마지막 수단.
/// 가장 작은 포트를 쓴다 — `listening_ports` 는 오름차순이다.
pub(crate) fn pick_any_port(ports: &[u16]) -> Option<u16> {
    ports.first().copied()
}

/// 종료에 쓰는 신호. Unix 가 아니면 아무 일도 하지 않는다.
#[derive(Clone, Copy)]
pub(crate) enum Sig {
    /// Ctrl+C 와 같은 신호. **IntelliJ 의 정지 버튼이 보내는 것과 같다** — JVM 종료 훅이
    /// 돌아 Spring Boot 가 graceful shutdown 을 하고 종료 코드 130 으로 끝난다.
    Int,
    /// 강제 종료. 종료 훅이 돌지 않는다(포트·락이 늦게 풀릴 수 있다).
    Kill,
}

/// (pid → ppid) 표. 프로세스 트리를 걸어 올라가는 데 쓴다.
fn ps_parents() -> HashMap<u32, u32> {
    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return HashMap::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .collect()
}

/// `roots` 와 그 자손 pid 들(루트가 앞).
///
/// IntelliJ 의 정지 버튼은 프로세스 **트리**에 신호를 보낸다
/// (`UnixProcessManager.sendSigIntToProcessTree`). 앱이 자식 프로세스를 띄워 뒀다면
/// 그것까지 같이 내려야 IDE 에서 누른 것과 같은 결과가 된다.
fn process_tree(roots: &[u32]) -> Vec<u32> {
    let parents = ps_parents();
    let mut out: Vec<u32> = roots.to_vec();
    let mut i = 0;
    while i < out.len() {
        let cur = out[i];
        for (&pid, &ppid) in &parents {
            if ppid == cur && !out.contains(&pid) {
                out.push(pid);
            }
        }
        i += 1;
    }
    // pid 0·1(커널·launchd)은 어떤 경우에도 건드리지 않는다.
    out.retain(|p| *p > 1);
    out
}

/// 프로세스 트리에 신호를 보낸다.
pub(crate) fn signal_tree(pids: &[u32], sig: Sig) {
    #[cfg(unix)]
    for pid in process_tree(pids) {
        let signum = match sig {
            Sig::Int => libc::SIGINT,
            Sig::Kill => libc::SIGKILL,
        };
        unsafe {
            libc::kill(pid as i32, signum);
        }
    }
    #[cfg(not(unix))]
    let _ = (pids, sig);
}

/// 프로세스가 살아 있는지 확인한다(시그널 0).
pub(crate) fn is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// 콘솔에 한 줄 흘려보낸다 — Rust 버퍼에 쌓고 프론트로 이벤트를 방출한다.
///
/// 버퍼에 쌓는 이유: 사용자가 다른 메뉴로 가면 뷰가 언마운트되어 프론트의 로그 상태가
/// 사라진다. 돌아왔을 때 `intellij_logs` 로 복원할 수 있어야 한다.
/// (뷰가 아직 이벤트를 구독하기 전에 방출된 줄도 이렇게 살아남는다.)
fn emit_log(app: &tauri::AppHandle, name: &str, line: &str) {
    if let Some(t) = app.try_state::<RunTracking>() {
        let mut map = t.logs.lock().unwrap();
        let buf = map.entry(name.to_string()).or_default();
        if buf.len() >= LOG_BUFFER_MAX {
            buf.pop_front();
        }
        buf.push_back(line.to_string());
    }
    let _ = app.emit(
        "intellij:log",
        LogPayload {
            name: name.to_string(),
            line: line.to_string(),
        },
    );
}

/// 바이트 수를 사람이 읽을 단위로(로그 안내 문구용).
fn human_bytes(bytes: u64) -> String {
    const MB: u64 = 1024 * 1024;
    const KB: u64 = 1024;
    if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{} KB", bytes / KB)
    } else {
        format!("{bytes} B")
    }
}

/// 서비스가 추적 중인 pid 들.
fn tracked_pids(app: &tauri::AppHandle, name: &str) -> Vec<u32> {
    app.try_state::<ServiceState>()
        .map(|s| {
            s.0.lock()
                .unwrap()
                .get(name)
                .map(|v| v.iter().map(|p| p.pid).collect())
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

/// 상태 맵에 pid 를 등록하고 `intellij:status` 를 방출한다.
fn mark_running(app: &tauri::AppHandle, name: &str, pid: u32) {
    if let Some(state) = app.try_state::<ServiceState>() {
        let mut map = state.0.lock().unwrap();
        let procs = map.entry(name.to_string()).or_default();
        if !procs.iter().any(|p| p.pid == pid) {
            procs.push(Proc { pid, port: None });
        }
    }
    let _ = app.emit(
        "intellij:status",
        StatusPayload {
            name: name.to_string(),
            running: true,
            pid: Some(pid),
            port: None,
            failed: None,
        },
    );
}

/// 포트를 알아냈으면 상태에 기록하고 다시 방출한다. 이미 같은 포트면 아무것도 하지 않는다.
fn update_port(app: &tauri::AppHandle, name: &str, pid: u32, port: u16) {
    let changed = app
        .try_state::<ServiceState>()
        .map(|s| {
            let mut map = s.0.lock().unwrap();
            match map
                .get_mut(name)
                .and_then(|v| v.iter_mut().find(|p| p.pid == pid))
            {
                Some(p) if p.port != Some(port) => {
                    p.port = Some(port);
                    true
                }
                _ => false,
            }
        })
        .unwrap_or(false);
    if !changed {
        return;
    }
    let _ = app.emit(
        "intellij:status",
        StatusPayload {
            name: name.to_string(),
            running: true,
            pid: Some(pid),
            port: Some(port),
            failed: None,
        },
    );
}

// ─────────────────────────── 실패/정상 종료 판정 ───────────────────────────

/// 종료 후 로그가 마저 도착하도록 잠깐 기다리는 시간(실패 배너·Started 로그 경합 흡수).
const OUTCOME_GRACE: Duration = Duration::from_millis(2500);

/// 사용자가 명시적으로 내리는 중임을 표시한다(stop/restart 진입 시).
fn mark_stopping(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.stopping.lock().unwrap().insert(name.to_string());
    }
}

/// 새 실행 시작 시 이전 판정 흔적(정지 요청·로그 신호)을 초기화한다.
fn reset_tracking(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.stopping.lock().unwrap().remove(name);
        t.outcome.lock().unwrap().remove(name);
        t.logs.lock().unwrap().remove(name);
        t.exits.lock().unwrap().remove(name);
    }
}

/// 시작 진행 중으로 표시한다(pid 를 잡기 전까지 외부 실행 흡수를 막는다).
fn mark_starting(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.starting.lock().unwrap().insert(name.to_string());
    }
}

/// 시작 진행 표시를 해제한다(pid 를 잡았거나 시작이 실패했을 때).
fn clear_starting(app: &tauri::AppHandle, name: &str) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.starting.lock().unwrap().remove(name);
    }
}

/// tail 소유권 키. 같은 (설정, 로그파일) 조합을 식별한다.
fn tail_key(name: &str, path: &Path) -> String {
    format!("{name}\u{0}{}", path.display())
}

/// 이 (설정, 로그파일) 을 tail 하겠다고 등록한다.
/// 이미 다른 스레드가 등록해 뒀으면 false — 그 경우 tail 을 시작하면 안 된다
/// (두 스레드가 같은 파일을 처음부터 읽어 모든 줄이 두 번 표시된다).
fn claim_tail(tracking: &RunTracking, key: &str) -> bool {
    tracking.tails.lock().unwrap().insert(key.to_string())
}

/// tail 종료 시 소유권을 놓는다(다음 실행이 같은 파일을 다시 tail 할 수 있게).
fn release_tail(tracking: &RunTracking, key: &str) {
    tracking.tails.lock().unwrap().remove(key);
}

/// 시작 진행 중인지.
fn is_starting(app: &tauri::AppHandle, name: &str) -> bool {
    app.try_state::<RunTracking>()
        .map(|t| t.starting.lock().unwrap().contains(name))
        .unwrap_or(false)
}

/// 로그 한 줄에서 성공(Started)·실패 신호를 뽑아 outcome 에 반영한다.
fn note_log_signal(app: &tauri::AppHandle, name: &str, line: &str) {
    let reason = detect_failure(line);
    let started = is_started_line(line);
    if reason.is_none() && !started {
        return;
    }
    if let Some(t) = app.try_state::<RunTracking>() {
        let mut map = t.outcome.lock().unwrap();
        let o = map.entry(name.to_string()).or_default();
        if started {
            o.started = true;
        }
        if o.fail_reason.is_none() {
            if let Some(r) = reason {
                o.fail_reason = Some(r);
            }
        }
    }
}

/// Spring Boot 성공 기동 로그인지("Started XxxApplication in 1.23 seconds").
pub(crate) fn is_started_line(line: &str) -> bool {
    line.contains("Started ") && line.contains(" in ") && line.contains("second")
}

/// 실행 실패를 뜻하는 로그면 사용자에게 보일 사유를 돌려준다.
pub(crate) fn detect_failure(line: &str) -> Option<String> {
    const MARKERS: &[(&str, &str)] = &[
        ("APPLICATION FAILED TO START", "APPLICATION FAILED TO START"),
        ("Error starting ApplicationContext", "ApplicationContext 시작 오류"),
        ("Web server failed to start", "웹 서버 시작 실패(포트 충돌 등)"),
        ("Port already in use", "포트가 이미 사용 중"),
        ("BUILD FAILED", "빌드 실패"),
        ("Compilation failed", "컴파일 실패"),
        ("compilation failed", "컴파일 실패"),
        ("Exception in thread \"main\"", "main 스레드 예외"),
    ];
    MARKERS
        .iter()
        .find(|(needle, _)| line.contains(needle))
        .map(|(_, reason)| reason.to_string())
}

/// 실패 상태 이벤트를 방출하고 상태 맵에서 지운다.
fn emit_failed(app: &tauri::AppHandle, name: &str, reason: String) {
    if let Some(state) = app.try_state::<ServiceState>() {
        state.0.lock().unwrap().remove(name);
    }
    note_exit(app, name, Some(reason.clone()));
    let _ = app.emit(
        "intellij:status",
        StatusPayload {
            name: name.to_string(),
            running: false,
            pid: None,
            port: None,
            failed: Some(reason),
        },
    );
}

/// 이 실행이 끝났음을 기록한다(실패면 사유). 다음 시작(`reset_tracking`)에서 지워진다.
/// 순차 실행이 "기동 대기" 중에 죽은 서비스를 알아채는 유일한 통로다 — 실패 사유는
/// `finalize` 가 `outcome` 에서 꺼내 가면서 지우므로 그것만 보고 있으면 놓친다.
fn note_exit(app: &tauri::AppHandle, name: &str, reason: Option<String>) {
    if let Some(t) = app.try_state::<RunTracking>() {
        t.exits.lock().unwrap().insert(name.to_string(), reason);
    }
}

/// 종료를 판정할 때의 문맥 — 이 실행이 어떻게 시작됐고 pid 를 잡았는지.
#[derive(Clone, Copy, PartialEq)]
enum Exit {
    /// 우리가 시작시켰고 앱 JVM pid 도 잡아 살아 있었다 → 예고 없는 종료는 크래시.
    Launched,
    /// 우리가 시작시켰지만 pid 를 못 잡았다 → 시작 실패이거나 추적만 실패한 것.
    LaunchedNoPid,
    /// IntelliJ 에서 직접 띄운 실행을 흡수했다. 시작·중지 모두 IDE 쪽에서 일어나므로
    /// 종료 이유를 우리가 알 수 없다 → 로그에 명시적 실패가 없으면 그냥 중지로 본다.
    Adopted,
}

/// 한 실행의 종료를 마무리하며 **정상 중지 / 실패**를 판정해 이벤트를 낸다.
fn finalize(app: &tauri::AppHandle, name: &str, exit: Exit) {
    // 사용자가 직접 내린 경우: 정상 중지로 처리하고 흔적을 지운다.
    let user_stop = app
        .try_state::<RunTracking>()
        .map(|t| t.stopping.lock().unwrap().remove(name))
        .unwrap_or(false);
    if user_stop {
        if let Some(t) = app.try_state::<RunTracking>() {
            t.outcome.lock().unwrap().remove(name);
        }
        mark_stopped(app, name);
        return;
    }

    // 실패 배너·Started 로그가 뒤늦게 도착할 수 있어 잠깐 기다렸다 판정한다.
    let deadline = Instant::now() + OUTCOME_GRACE;
    loop {
        let o = app
            .try_state::<RunTracking>()
            .map(|t| t.outcome.lock().unwrap().get(name).cloned().unwrap_or_default())
            .unwrap_or_default();
        if o.fail_reason.is_some() || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(POLL);
    }
    let o = app
        .try_state::<RunTracking>()
        .map(|t| t.outcome.lock().unwrap().remove(name).unwrap_or_default())
        .unwrap_or_default();

    match (o.fail_reason, o.started, exit) {
        // 로그에 명시적 실패가 있으면 그대로 실패.
        (Some(reason), _, _) => emit_failed(app, name, reason),
        // IntelliJ 에서 띄운 실행은 IDE 의 정지 버튼으로 내려가는 게 정상적인 종료다.
        // 우리는 그 조작을 볼 수 없으니(stop/restart 를 거치지 않으므로 user_stop 이 아니다)
        // 로그에 실패 근거가 없는 종료를 크래시로 단정하지 않는다 — 조용히 중지로 표시한다.
        (None, _, Exit::Adopted) => mark_stopped(app, name),
        // Started 를 봤는데 pid 추적은 실패 → 실제론 떠 있음. 실패 아님(제어만 불가).
        (None, true, Exit::LaunchedNoPid) => {
            emit_log(
                app,
                name,
                "[my-space] 실행 프로세스를 찾지 못해 종료·재시작 제어가 불가능합니다. \
                 IntelliJ 콘솔에서 직접 중지하세요.",
            );
            mark_stopped(app, name);
        }
        // pid 를 실제로 잡았었는데(=살아 있었는데) 사용자 중지 없이 죽음 → 실행 중 비정상 종료(크래시).
        (None, _, Exit::Launched) => emit_failed(app, name, "실행 중 비정상 종료".into()),
        // pid 도 못 잡고 Started 로그도 없이 종료 → 시작 실패(빌드 실패 또는 기동 오류).
        (None, false, Exit::LaunchedNoPid) => {
            emit_failed(app, name, "시작 전 종료 — 빌드 실패 또는 기동 오류".into())
        }
    }
}

/// 상태 맵에서 서비스를 지우고 종료 이벤트를 방출한다.
fn mark_stopped(app: &tauri::AppHandle, name: &str) {
    if let Some(state) = app.try_state::<ServiceState>() {
        state.0.lock().unwrap().remove(name);
    }
    note_exit(app, name, None);
    let _ = app.emit(
        "intellij:status",
        StatusPayload {
            name: name.to_string(),
            running: false,
            pid: None,
            port: None,
            failed: None,
        },
    );
}

/// 설정의 프로세스를 찾아 등록하고, 전부 죽을 때까지 지켜본다.
/// Multirun 이면 자식 설정들을 동시에 추적한다.
fn watch_processes(
    app: tauri::AppHandle,
    name: String,
    project: String,
    targets: Vec<Target>,
    expect_port: Option<u16>,
) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + PID_WAIT;
        let mut found: Vec<u32> = Vec::new();

        // 1) 뜨기를 기다린다(IntelliJ 의 Make 가 끝나야 JVM 이 생긴다).
        while Instant::now() < deadline {
            let procs = ps_list();
            for t in &targets {
                if let Some(pid) = find_pid_in(&procs, t, &project) {
                    if !found.contains(&pid) {
                        found.push(pid);
                        mark_running(&app, &name, pid);
                    }
                }
            }
            // 추적 대상을 다 찾았으면 대기를 끝낸다.
            if found.len() >= targets.len() {
                break;
            }
            std::thread::sleep(POLL);
        }

        // 여기서부터는 pid 가 상태 맵에 등록됐거나(=흡수가 알아서 비켜간다) 실패가 확정이다.
        clear_starting(&app, &name);

        if found.is_empty() {
            // 프로세스를 못 찾았다 = JVM 이 안 떴다(빌드/기동 실패) 또는 pid 추적 실패.
            // finalize 가 로그 신호(실패 배너/Started)로 실패·중지를 가려낸다.
            finalize(&app, &name, Exit::LaunchedNoPid);
            return;
        }

        // 2) 전부 죽을 때까지 생존 확인 + 포트 감지(기동 뒤에 바인딩되므로 계속 살펴본다).
        watch_alive(&app, &name, found, expect_port);
        finalize(&app, &name, Exit::Launched);
    });
}

/// 이미 살아 있는 pid 들을 그대로 지켜보다가, 전부 사라지면 종료 처리한다.
/// (IntelliJ 에서 직접 띄운 프로세스를 흡수했을 때 쓴다 — 뜨기를 기다릴 필요가 없다.)
fn watch_existing(
    app: tauri::AppHandle,
    name: String,
    pids: Vec<u32>,
    expect_port: Option<u16>,
) {
    std::thread::spawn(move || {
        watch_alive(&app, &name, pids, expect_port);
        finalize(&app, &name, Exit::Adopted);
    });
}

/// pid 들이 전부 사라질 때까지 지켜보면서, 아직 모르는 포트를 발견하면 기록한다.
/// 서버 포트는 JVM 이 뜬 뒤 몇 초 지나 바인딩되므로 생존 확인과 같은 루프에서 살핀다.
/// `expect_port` (설정에서 알아낸 예상 포트)가 있으면 그 포트를 우선한다.
fn watch_alive(app: &tauri::AppHandle, name: &str, pids: Vec<u32>, expect_port: Option<u16>) {
    let mut alive = pids;
    // 고정 포트를 확정한 pid. 확정 전에는 계속 다시 살펴본다 —
    // 서버 포트는 JMX 용 임시 포트보다 **늦게** 열리므로, 한 번 찾고 멈추면
    // 임시 포트(예: 62599)에 붙어 8888 로 갱신되지 않는다.
    let mut settled: HashSet<u32> = HashSet::new();
    let started = Instant::now();

    loop {
        alive.retain(|p| is_alive(*p));
        if alive.is_empty() {
            return;
        }
        for pid in &alive {
            if settled.contains(pid) {
                continue;
            }
            let ports = listening_ports(*pid);
            if let Some(port) = pick_service_port(&ports, expect_port) {
                update_port(app, name, *pid, port);
                settled.insert(*pid);
            } else if started.elapsed() > PORT_FALLBACK_AFTER {
                // 고정 포트를 쓰지 않는 서비스일 수 있다. 그때는 임시 포트라도 보여 준다.
                // (확정하지는 않으므로 나중에 고정 포트가 열리면 그것으로 바뀐다.)
                if let Some(port) = pick_any_port(&ports) {
                    update_port(app, name, *pid, port);
                }
            }
        }
        std::thread::sleep(POLL);
    }
}

/// 설정 하나가 실행 중이라면 어떤 프로세스들을 봐야 하는지 계산한다.
/// Multirun 은 자식 설정들을 모은다(자식마다 프로필이 다를 수 있어 그대로 들고 간다).
///
/// 프로필 비교는 **메인 클래스가 겹치는 설정에만** 켠다. 프로필로 거르는 건 XML 과 실제
/// 실행이 어긋나면 프로세스를 아예 못 찾게 되는 위험이 있어서, 클래스만으로 유일하게
/// 정해지는 대다수 설정은 지금까지처럼 관대하게 둔다.
fn tracked_targets(metas: &HashMap<String, Meta>, name: &str) -> Vec<Target> {
    let mut per_class: HashMap<&str, usize> = HashMap::new();
    for m in metas.values() {
        if let Some(mc) = m.main_class.as_deref() {
            *per_class.entry(mc).or_default() += 1;
        }
    }
    let target_of = |m: &Meta| {
        m.main_class.clone().map(|main_class| {
            let shared = per_class.get(main_class.as_str()).copied().unwrap_or(0) > 1;
            Target {
                profiles: shared.then(|| m.profiles.clone()).flatten(),
                main_class,
            }
        })
    };
    match metas.get(name) {
        Some(m) if !m.children.is_empty() => m
            .children
            .iter()
            .filter_map(|ch| metas.get(ch).and_then(target_of))
            .collect(),
        Some(m) => target_of(m).into_iter().collect(),
        None => Vec::new(),
    }
}

/// 프로세스가 시작된 지 몇 초 지났는지(`ps -o etime=` 파싱).
/// 형식은 `MM:SS`, `HH:MM:SS`, `D-HH:MM:SS`.
fn process_age_secs(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "etime="])
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let (days, hms) = match raw.split_once('-') {
        Some((d, rest)) => (d.parse::<u64>().ok()?, rest),
        None => (0, raw.as_str()),
    };
    let parts: Vec<u64> = hms
        .split(':')
        .map(|p| p.trim().parse::<u64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let hms_secs = match parts.as_slice() {
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(days * 86_400 + hms_secs)
}

/// IntelliJ 설정 파일의 경로 매크로를 실제 경로로 펼친다.
pub(crate) fn expand_macros(raw: &str, project: &str) -> PathBuf {
    let mut s = raw.replace("$PROJECT_DIR$", project);
    if let Ok(home) = home_dir() {
        s = s.replace("$USER_HOME$", &home.to_string_lossy());
    }
    let p = PathBuf::from(s);
    // 상대 경로는 프로젝트 루트 기준으로 본다.
    if p.is_absolute() {
        p
    } else {
        Path::new(project).join(p)
    }
}

/// 이 파일을 지금 열고 있는 프로세스가 있는지.
///
/// IntelliJ 는 실행이 살아 있는 동안 콘솔 출력 파일을 열어 둔다. 반대로 **끝난 실행의
/// 로그 파일은 아무도 열고 있지 않다**(실측 확인). 그래서 이 검사로 "죽은 실행의 로그를
/// 현재 로그인 것처럼 붙이는" 오류를 막는다 — 틀린 로그를 보여 주는 것이 아무것도
/// 안 보여 주는 것보다 나쁘다.
fn file_is_open(path: &Path) -> bool {
    std::process::Command::new("lsof")
        .arg("-t")
        .arg("--")
        .arg(path)
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false)
}

/// 프로세스가 뜬 시각(여유 포함) 이후에 쓰인 파일인지. 이전 실행의 로그를 집지 않기 위해.
fn modified_after_start(path: &Path, pid: u32) -> bool {
    let Some(age) = process_age_secs(pid) else {
        return false;
    };
    let Some(started) = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(age))
        .and_then(|t| t.checked_sub(Duration::from_secs(30)))
    else {
        return false;
    };
    fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|m| m >= started)
        .unwrap_or(false)
}

/// 실행 설정에 "콘솔 출력을 파일로 저장" 이 켜져 있으면 그 파일 경로를 준다.
/// IDE 의 Run 버튼으로 띄운 실행도 이 경로에는 콘솔이 그대로 쌓인다.
fn configured_log(project: &str, meta: &Meta, pid: u32) -> Option<PathBuf> {
    let path = expand_macros(meta.output_file.as_deref()?, project);
    let usable = path.is_file() && file_is_open(&path) && modified_after_start(&path, pid);
    usable.then_some(path)
}

/// 이 실행에 해당하는 IntelliJ 실행 출력 로그 파일을 찾는다.
///
/// 이 파일은 **MCP 로 실행했을 때만** 만들어진다(`execute_run_configuration` 이 출력을
/// 임시 파일로 빼 준다). 그래서 IDE 의 Run 버튼으로 띄운 프로세스는 찾을 수 없고,
/// my-space 가 이전에 띄워 둔 것은 앱을 다시 켜도 로그를 이어서 볼 수 있다.
///
/// 파일명은 `ij_run__<설정명>_<숫자>.log` 이고 설정명의 특수문자는 `_` 로 치환된다.
/// 오래된 실행의 로그를 잘못 붙이지 않도록 **프로세스 시작 시각 이후에 수정된** 파일만 쓴다.
fn find_run_log(name: &str, pid: u32) -> Option<PathBuf> {
    let sanitized = sanitize(name);
    let age = process_age_secs(pid)?;
    // 프로세스가 뜬 시각. 로그 파일이 이보다 나중에 쓰였어야 이 실행의 것이다.
    let started = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(age))?
        .checked_sub(Duration::from_secs(30))?; // Make 시간 등 여유

    let caches = home_dir().ok()?.join("Library").join("Caches").join("JetBrains");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;

    for ide in fs::read_dir(&caches).ok()?.flatten() {
        let tmp = ide.path().join("tmp");
        let Ok(rd) = fs::read_dir(&tmp) else { continue };
        for e in rd.flatten() {
            let file = e.file_name().to_string_lossy().to_string();
            let Some(mid) = file
                .strip_prefix("ij_run__")
                .and_then(|r| r.strip_suffix(".log"))
                .and_then(|r| r.rsplit_once('_').map(|(head, _digits)| head))
            else {
                continue;
            };
            if mid != name && mid != sanitized {
                continue;
            }
            let Ok(modified) = e.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            if modified < started {
                continue; // 이전 실행의 로그
            }
            // 살아 있는 실행의 로그만 — IntelliJ 가 열고 있어야 한다.
            if !file_is_open(&e.path()) {
                continue;
            }
            if best.as_ref().is_none_or(|(bm, _)| modified > *bm) {
                best = Some((modified, e.path()));
            }
        }
    }
    best.map(|(_, p)| p)
}

/// IntelliJ 에서 직접 띄운(이 앱을 거치지 않은) 프로세스를 찾아 실행 중으로 흡수한다.
/// 앱을 켜거나 화면을 열었을 때 이미 돌고 있는 서비스가 "중지됨" 으로 보이지 않게 한다.
fn adopt_external(app: &tauri::AppHandle, state: &ServiceState, project: &str) {
    let metas = read_metas(project);

    // 흡수 후보를 먼저 고른다: 아직 추적 중이 아니고, 우리가 시작시킨 것도 아니며,
    // 찾을 메인 클래스가 있는 설정. 후보가 없으면 `ps` 를 아예 띄우지 않는다
    // (3초마다 도는 폴링이라 평소에는 이 경로로 빠져나가는 게 정상이다).
    let candidates: Vec<(&String, Vec<Target>)> = metas
        .keys()
        .filter(|name| !state.0.lock().unwrap().contains_key(*name))
        // 우리가 방금 시작시킨 실행이라면 곧 감시 스레드가 pid 를 등록한다.
        // 여기서 먼저 붙잡으면 감시·tail 이 이중으로 돌아 로그가 두 번씩 보인다.
        .filter(|name| !is_starting(app, name))
        .map(|name| (name, tracked_targets(&metas, name)))
        .filter(|(_, targets)| !targets.is_empty())
        .collect();
    if candidates.is_empty() {
        return;
    }

    // 프로세스 목록은 한 번만 찍어 모든 후보가 공유한다.
    let procs = ps_list();
    let port_map = read_port_map(project);

    for (name, targets) in candidates {
        let found: Vec<u32> = targets
            .iter()
            .filter_map(|t| find_pid_in(&procs, t, project))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        if found.is_empty() {
            continue;
        }
        let expect = metas.get(name).and_then(|m| expected_port(&port_map, m));
        for pid in &found {
            mark_running(app, name, *pid);
            // 이미 떠 있는 프로세스는 서버 포트도 이미 열려 있다. 감시 스레드를 기다리지 않고
            // 바로 채워, 새로고침 응답에서부터 포트가 보이게 한다.
            if let Some(port) = primary_port(*pid, expect) {
                update_port(app, name, *pid, port);
            }
        }
        let pid_list = found
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(", ");

        // 읽을 수 있는 콘솔 출력 파일을 찾는다. 우선순위:
        //  1) 실행 설정의 "콘솔 출력을 파일로 저장"(Logs 탭) — IDE 의 Run 버튼으로 띄운
        //     실행도 여기에 쌓이므로 IntelliJ 콘솔과 같은 내용을 볼 수 있다.
        //  2) MCP 실행이 남긴 ij_run__*.log — my-space 로 띄운 실행에만 존재한다.
        let meta = metas.get(name);
        let log = found.iter().find_map(|pid| {
            meta.and_then(|m| configured_log(project, m, *pid))
                .or_else(|| find_run_log(name, *pid))
        });

        match log {
            Some(log) => {
                emit_log(
                    app,
                    name,
                    &format!(
                        "[my-space] 이미 실행 중인 프로세스를 인식했습니다 (pid {pid_list}). \
                         콘솔 출력을 이어서 표시합니다 — {}",
                        log.display()
                    ),
                );
                tail_log(app.clone(), name.clone(), log);
            }
            None => {
                emit_log(
                    app,
                    name,
                    &format!(
                        "[my-space] IntelliJ 에서 실행 중인 프로세스를 인식했습니다 \
                         (pid {pid_list}). IDE 의 Run 버튼으로 띄운 실행은 콘솔 출력이 \
                         IntelliJ 안에만 남아 여기에서는 읽을 수 없습니다."
                    ),
                );
                emit_log(
                    app,
                    name,
                    "[my-space] 방법 1 — 위 ⟳ 로 재시작하면 이후 출력이 여기에 표시됩니다.",
                );
                emit_log(
                    app,
                    name,
                    "[my-space] 방법 2 — 위의 [IDE 로그 동기화] 를 켜 두면 IntelliJ 에서 \
                     띄운 실행도 항상 여기에 표시됩니다(다음 실행부터 적용).",
                );
            }
        }

        watch_existing(app.clone(), name.clone(), found, expect);
    }
}

/// IntelliJ 가 만든 실행 출력 로그 파일을 tail 해서 `intellij:log` 로 흘려보낸다.
/// 서비스가 상태 맵에서 사라지고(=종료) 잔여 출력까지 읽은 뒤 멈춘다.
///
/// 같은 (설정, 파일) 조합은 **한 스레드만** tail 한다. 시작 경로와 외부 실행 흡수 경로가
/// 같은 파일을 각각 붙잡으면 모든 줄이 두 번씩 표시되기 때문이다.
fn tail_log(app: tauri::AppHandle, name: String, path: PathBuf) {
    let key = tail_key(&name, &path);
    if let Some(t) = app.try_state::<RunTracking>() {
        if !claim_tail(&t, &key) {
            return; // 이미 이 파일을 tail 하는 스레드가 있다.
        }
    }

    std::thread::spawn(move || {
        let mut pos: u64 = 0;
        let mut carry = String::new();
        let mut idle_after_exit = 0u32;

        loop {
            let mut grew = false;
            if let Ok(mut f) = fs::File::open(&path) {
                let len = f.metadata().map(|m| m.len()).unwrap_or(0);
                // 파일이 새로 만들어졌으면(길이가 줄었으면) 처음부터 다시 읽는다.
                if len < pos {
                    pos = 0;
                    carry.clear();
                }
                // 밀린 양이 상한을 넘으면 끝부분으로 건너뛴다(MAX_CATCHUP 참고).
                // 이미 실행 중인 프로세스를 흡수해 커진 파일을 처음 붙잡을 때, 그리고
                // 앱이 초당 수 MB 를 토할 때(예: OOM 루프) 둘 다 여기로 걸린다.
                let mut skipped = 0u64;
                if len > pos + MAX_CATCHUP {
                    skipped = len - pos - MAX_CATCHUP;
                    pos = len - MAX_CATCHUP;
                    carry.clear();
                }
                if len > pos && f.seek(SeekFrom::Start(pos)).is_ok() {
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).is_ok() {
                        pos += buf.len() as u64;
                        grew = !buf.is_empty();
                        carry.push_str(&String::from_utf8_lossy(&buf));
                        if skipped > 0 {
                            // 건너뛴 지점은 줄 중간일 수 있다 — 잘린 첫 줄은 버린다.
                            if let Some(idx) = carry.find('\n') {
                                carry.drain(..=idx);
                            }
                            emit_log(
                                &app,
                                &name,
                                &format!(
                                    "[my-space] 이전 로그 {} 는 건너뛰고 최근 출력만 표시합니다 \
                                     (전체는 {} 에서 볼 수 있습니다).",
                                    human_bytes(skipped),
                                    path.display()
                                ),
                            );
                        }
                        // 마지막 줄이 아직 안 끝났을 수 있으니 남겨 둔다.
                        while let Some(idx) = carry.find('\n') {
                            let line: String = carry.drain(..=idx).collect();
                            let clean = line.trim_end_matches(['\r', '\n']).to_string();
                            // 성공(Started)·실패(배너) 신호를 수집해 종료 시 판정에 쓴다.
                            note_log_signal(&app, &name, &clean);
                            emit_log(&app, &name, &clean);
                        }
                    }
                }
            }

            let still_running = app
                .try_state::<ServiceState>()
                .map(|s| s.0.lock().unwrap().contains_key(&name))
                .unwrap_or(false);

            if !still_running && !grew {
                // 종료 후 잔여 출력을 조금 더 기다렸다가 멈춘다.
                idle_after_exit += 1;
                if idle_after_exit > 10 {
                    break;
                }
            } else {
                idle_after_exit = 0;
            }

            std::thread::sleep(TAIL_POLL);
        }

        // 다음 실행이 같은 파일을 다시 tail 할 수 있도록 표시를 지운다.
        if let Some(t) = app.try_state::<RunTracking>() {
            release_tail(&t, &key);
        }
    });
}

// ─────────────────────────── 커맨드: 시작 / 종료 ───────────────────────────

/// 설정 이름으로 서비스를 시작한다. 실행은 IntelliJ 가 자기 설정 그대로 수행한다.
#[tauri::command]
pub async fn intellij_start_service(
    app: tauri::AppHandle,
    project: String,
    name: String,
    kind: Option<String>,
) -> Result<(), String> {
    launch(app, project, name, kind).await
}

/// 실행 중인 서비스를 내렸다가 다시 띄운다.
///
/// 포트를 놓기 전에 다시 실행하면 "Port already in use" 로 죽으므로, 이전 프로세스가
/// **완전히 사라진 것을 확인한 뒤** 실행한다. 실행 중이 아니면 그냥 시작한다.
#[tauri::command]
pub async fn intellij_restart_service(
    app: tauri::AppHandle,
    project: String,
    name: String,
    kind: Option<String>,
) -> Result<(), String> {
    let pids = tracked_pids(&app, &name);

    if !pids.is_empty() {
        mark_stopping(&app, &name); // 재시작을 위한 종료 = 사용자 의도(실패로 오판 금지)
        emit_log(&app, &name, "[my-space] 재시작 — 종료를 기다립니다…");
        terminate_and_wait(&app, &name, &pids).await?;
        emit_log(&app, &name, "[my-space] 종료 완료. 다시 실행합니다.");
    }

    launch(app, project, name, kind).await
}

/// 프로세스 트리에 SIGINT 을 보내고 전부 사라질 때까지 기다린다.
/// STOP_GRACE 안에 안 죽으면 SIGKILL 로 올리고, STOP_TIMEOUT 까지도 남아 있으면 에러.
/// (재시작은 다음 실행이 포트를 잡아야 해서 자동 승격이 필요하다 — 단순 중지는 하지 않는다.)
async fn terminate_and_wait(
    app: &tauri::AppHandle,
    name: &str,
    pids: &[u32],
) -> Result<(), String> {
    let n = name.to_string();
    let a = app.clone();
    kill_and_wait(pids, move || {
        emit_log(&a, &n, "[my-space] 응답이 없어 강제 종료(SIGKILL)합니다.")
    })
    .await
    .map_err(|alive| {
        format!(
            "'{name}' 종료가 {}초 안에 끝나지 않았습니다 (pid {alive:?})",
            STOP_TIMEOUT.as_secs()
        )
    })?;

    // 이전 실행의 감시 스레드가 상태 맵을 정리하고 종료 이벤트를 내보낼 때까지 기다린다.
    // 그러지 않으면 새로 띄운 뒤에 뒤늦은 "중지됨" 이벤트가 날아와 화면이 뒤집힌다.
    let deadline = Instant::now() + WATCHER_CLEANUP;
    while Instant::now() < deadline {
        let tracked = app
            .try_state::<ServiceState>()
            .map(|s| s.0.lock().unwrap().contains_key(name))
            .unwrap_or(false);
        if !tracked {
            return Ok(());
        }
        tokio::time::sleep(POLL).await;
    }
    // 감시 스레드가 늦으면 우리가 직접 정리한다.
    mark_stopped(app, name);
    Ok(())
}

/// 프로세스 트리에 SIGINT(= IntelliJ 정지 버튼과 같은 신호)를 보내고 전부 사라질
/// 때까지 기다리는 순수 로직.
/// STOP_GRACE 를 넘기면 `on_escalate` 를 한 번 호출하고 SIGKILL 로 올린다.
/// STOP_TIMEOUT 까지 남아 있으면 살아남은 pid 들을 Err 로 돌려준다.
async fn kill_and_wait(pids: &[u32], on_escalate: impl FnOnce()) -> Result<(), Vec<u32>> {
    signal_tree(pids, Sig::Int);

    let start = Instant::now();
    let mut escalate = Some(on_escalate);
    let mut alive: Vec<u32> = pids.to_vec();

    loop {
        alive.retain(|p| is_alive(*p));
        if alive.is_empty() {
            return Ok(());
        }
        if start.elapsed() > STOP_TIMEOUT {
            return Err(alive);
        }
        if start.elapsed() > STOP_GRACE {
            if let Some(f) = escalate.take() {
                f();
                signal_tree(&alive, Sig::Kill);
            }
        }
        tokio::time::sleep(POLL).await;
    }
}

/// 실제 실행 로직. 시작과 재시작이 함께 쓴다.
async fn launch(
    app: tauri::AppHandle,
    project: String,
    name: String,
    kind: Option<String>,
) -> Result<(), String> {
    // 새 실행이므로 이전 판정 흔적(정지 요청·성공/실패 로그 신호)을 지운다.
    // → 프론트의 "실패" 표시도 이 시작으로 초기화된다.
    reset_tracking(&app, &name);
    // pid 를 잡기 전까지는 외부 실행 흡수가 끼어들지 못하게 막는다(이중 감시·이중 로그 방지).
    mark_starting(&app, &name);
    let conn = match mcp::conn().await {
        Ok(c) => c,
        Err(e) => {
            clear_starting(&app, &name);
            return Err(e);
        }
    };

    // 종료 제어를 위해 추적할 프로세스 식별 정보(메인 클래스 + 프로필)를 미리 모아 둔다.
    let metas = read_metas(&project);

    // HTTP Request 설정은 장기 서비스가 아니라 한 번 실행 → 응답 표시다. 프론트가 넘긴 kind
    // 또는 XML 메타로 판별해 전용 경로로 보낸다(waitForExit=true 로 완료를 기다려 응답을 받음).
    let is_http = kind.as_deref() == Some("http")
        || metas.get(&name).and_then(|m| m.kind.as_deref()) == Some("http");
    if is_http {
        return launch_http(app, project, name, conn).await;
    }

    let targets = tracked_targets(&metas, &name);
    // 프로젝트 규약에서 알아낸 예상 포트 — 대표 포트를 고를 때 근거로 쓴다.
    let expect = metas
        .get(&name)
        .and_then(|m| expected_port(&read_port_map(&project), m));

    // waitForExit=false → 프로세스가 뜨는 것만 확인하고 바로 돌아온다.
    let res = match conn
        .call_tool(
            "execute_run_configuration",
            serde_json::json!({
                "projectPath": project,
                "configurationName": name,
                "waitForExit": false,
            }),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            clear_starting(&app, &name);
            return Err(e);
        }
    };

    let log_path = res.get("fullOutputPath").and_then(|v| v.as_str());

    // 초기 출력 스냅샷은 로그 파일에도 같이 들어 있다. 파일을 tail 할 수 있으면
    // 그쪽만 쓰고(중복 방지), 파일이 없을 때만 스냅샷을 흘려준다.
    if log_path.is_none() {
        if let Some(out) = res.get("output").and_then(|v| v.as_str()) {
            for line in out.lines() {
                emit_log(&app, &name, line);
            }
        }
    }

    if !targets.is_empty() {
        watch_processes(app.clone(), name.clone(), project.clone(), targets, expect);
    } else {
        // 메인 클래스를 모르면(테스트·HTTP 요청 등) 실행만 하고 상태는 추적하지 않는다.
        clear_starting(&app, &name);
        emit_log(
            &app,
            &name,
            "[my-space] 이 설정은 상태 추적/종료/재시작을 지원하지 않습니다 \
             (메인 클래스를 알 수 없음).",
        );
    }

    // IntelliJ 가 알려준 출력 파일을 tail 한다.
    if let Some(p) = log_path {
        tail_log(app, name, PathBuf::from(p));
    }

    Ok(())
}

/// HTTP Request 실행 설정 전용 경로.
///
/// 서비스와 달리 HTTP 요청은 짧게 끝나고 그 **응답이 실행 콘솔 출력에 담긴다.** 그래서
/// `waitForExit=true` 로 요청 완료까지 기다린 뒤(그렇지 않으면 응답이 오기 전에 리턴해
/// 출력이 비어 버린다 — 사용자가 겪던 "출력 없음"의 원인), `output`(없으면 `fullOutputPath`
/// 파일)을 그대로 로그 패널에 흘려 IntelliJ HTTP Client 처럼 응답을 보여 준다.
/// pid 추적·tail·재시작 machinery 는 태우지 않는다(추적할 장기 프로세스가 없다).
async fn launch_http(
    app: tauri::AppHandle,
    project: String,
    name: String,
    conn: std::sync::Arc<mcp::Conn>,
) -> Result<(), String> {
    clear_starting(&app, &name);
    emit_log(&app, &name, "[my-space] HTTP 요청 실행 중…");

    let res = match conn
        .call_tool(
            "execute_run_configuration",
            serde_json::json!({
                "projectPath": project,
                "configurationName": name,
                "waitForExit": true,
                // 응답 대기 상한(느린 요청 대비). 초과하면 IntelliJ 는 백그라운드로 계속 두고
                // 현재까지의 출력 스냅샷을 돌려준다.
                "timeout": 60000,
            }),
        )
        .await
    {
        Ok(r) => r,
        Err(e) => {
            emit_log(&app, &name, &format!("[my-space] 실행 실패: {e}"));
            return Err(e);
        }
    };

    // output(콘솔 스냅샷)을 우선 쓰고, 비어 있으면 fullOutputPath 파일을 읽어 보완한다.
    let mut shown = false;
    if let Some(out) = res.get("output").and_then(|v| v.as_str()) {
        if !out.trim().is_empty() {
            for line in out.lines() {
                emit_log(&app, &name, line);
            }
            shown = true;
        }
    }
    if !shown {
        if let Some(p) = res.get("fullOutputPath").and_then(|v| v.as_str()) {
            if let Ok(text) = fs::read_to_string(p) {
                if !text.trim().is_empty() {
                    for line in text.lines() {
                        emit_log(&app, &name, line);
                    }
                    shown = true;
                }
            }
        }
    }
    if !shown {
        emit_log(
            &app,
            &name,
            "[my-space] 응답 출력이 비어 있습니다(요청은 실행됨).",
        );
    }

    Ok(())
}

/// 실행 중인 서비스를 종료한다. MCP 에 중지 도구가 없어 IDE 가 띄운 앱 JVM 트리에
/// 직접 신호를 보낸다.
///
/// **IntelliJ 의 정지 버튼과 같은 방식이다.** 첫 요청은 SIGINT(Ctrl+C 와 동일)를
/// 프로세스 트리에 보내 JVM 종료 훅을 태운다 — Spring Boot 가 graceful shutdown 으로
/// 포트를 놓고 종료 코드 130 으로 끝난다. **여기서 강제 종료하지 않는다.** 아직 살아
/// 있는데 사용자가 한 번 더 누르면 그때 SIGKILL 로 올린다(IntelliJ 도 두 번째 정지가
/// Kill 이다). 재시작(`intellij_restart_service`)만은 다음 실행이 포트를 잡아야 하므로
/// STOP_GRACE(20초)를 넘기면 자동으로 SIGKILL 까지 간다.
#[tauri::command]
pub fn intellij_stop_service(
    app: tauri::AppHandle,
    state: tauri::State<ServiceState>,
    name: String,
) -> Result<(), String> {
    let pids: Vec<u32> = state
        .0
        .lock()
        .unwrap()
        .get(&name)
        .map(|v| v.iter().map(|p| p.pid).collect())
        .unwrap_or_default();
    if pids.is_empty() {
        return Err(format!("'{name}' 은(는) 실행 중이 아닙니다"));
    }

    #[cfg(not(unix))]
    return Err("이 플랫폼에서는 종료가 지원되지 않습니다".into());

    #[cfg(unix)]
    {
        // 이미 한 번 요청했는데 아직 살아 있다 = 두 번째 누름 → 강제 종료.
        // (`stopping` 은 프로세스가 실제로 사라질 때 finalize 가 지운다.)
        let again = app
            .try_state::<RunTracking>()
            .map(|t| t.stopping.lock().unwrap().contains(&name))
            .unwrap_or(false);
        if again {
            emit_log(&app, &name, "[my-space] 강제 종료(SIGKILL)합니다.");
            signal_tree(&pids, Sig::Kill);
            return Ok(());
        }

        mark_stopping(&app, &name); // 사용자 의도 종료 → 감시 스레드가 실패로 오판하지 않게 표시
        emit_log(
            &app,
            &name,
            "[my-space] 중지 요청(SIGINT — IntelliJ 정지 버튼과 동일). \
             응답이 없으면 한 번 더 눌러 강제 종료할 수 있습니다.",
        );
        signal_tree(&pids, Sig::Int);
        Ok(())
    }
}

// ─────────────────────────── 커맨드: 순차 실행 ───────────────────────────

/// 순차 실행 상태. 한 번에 하나만 돌린다(두 벌이 같은 서비스를 겹쳐 띄우면 안 된다).
#[derive(Default)]
pub struct SequenceState {
    running: Mutex<bool>,
    canceled: Mutex<bool>,
    /// 마지막으로 방출한 진행 정보. 화면을 떠났다 돌아왔을 때 진행 표시를 복원하는 데 쓴다
    /// (이벤트는 단계가 바뀔 때만 오므로 몇 분 동안 아무것도 못 받을 수 있다).
    last: Mutex<Option<SequencePayload>>,
}

/// 순차 실행 현재 상태(`intellij_sequence_status`).
#[derive(Serialize, Clone)]
pub struct SequenceStatus {
    running: bool,
    last: Option<SequencePayload>,
}

/// 순차 실행 진행 이벤트(`intellij:sequence`).
#[derive(Serialize, Clone)]
struct SequencePayload {
    /// 진행 중인 단계(1부터). 완료·실패 시에는 마지막으로 다룬 단계.
    stage: usize,
    /// 전체 단계 수.
    total: usize,
    /// 이 단계에서 띄우는 설정 이름들.
    names: Vec<String>,
    /// "starting"(실행 요청) | "waiting"(기동 대기) | "done"(전체 완료)
    /// | "failed"(중단) | "canceled"(사용자 취소).
    phase: &'static str,
    /// 실패·취소 사유(있을 때만).
    message: Option<String>,
}

/// 한 단계가 기동을 마칠 때까지 기다리는 최대 시간.
/// IntelliJ 의 Make(컴파일)가 포함되므로 넉넉히 잡는다.
const SEQUENCE_STAGE_TIMEOUT: Duration = Duration::from_secs(300);
/// 순차 실행의 기동 확인 주기.
const SEQUENCE_POLL: Duration = Duration::from_secs(1);

fn emit_sequence(
    app: &tauri::AppHandle,
    stage: usize,
    total: usize,
    names: &[String],
    phase: &'static str,
    message: Option<String>,
) {
    let payload = SequencePayload {
        stage,
        total,
        names: names.to_vec(),
        phase,
        message,
    };
    if let Some(state) = app.try_state::<SequenceState>() {
        *state.last.lock().unwrap() = Some(payload.clone());
    }
    let _ = app.emit("intellij:sequence", payload);
}

/// 한 단계를 기다린 결과.
enum Wait {
    /// 이 단계의 서비스가 모두 기동을 마쳤다.
    Started,
    /// 사용자가 중단했다.
    Canceled,
    /// 기동 실패·조기 종료·시간 초과.
    Failed(String),
}

/// 기동을 마쳤는지. Spring Boot 의 "Started ... in N seconds" 로그가 첫 근거이고,
/// 로그를 읽을 수 없는 실행이라도 **고정 포트**를 열었으면 떴다고 본다
/// (임시 포트는 JVM 이 기동 중에도 잡으므로 근거가 못 된다).
fn has_started(tracking: &RunTracking, state: &ServiceState, name: &str) -> bool {
    let logged = tracking
        .outcome
        .lock()
        .unwrap()
        .get(name)
        .is_some_and(|o| o.started);
    if logged {
        return true;
    }
    state.0.lock().unwrap().get(name).is_some_and(|procs| {
        procs
            .iter()
            .any(|p| p.port.is_some_and(|port| port < EPHEMERAL_FROM))
    })
}

/// 이 실행이 이미 끝났으면 그 결과(`Some(Some(사유))` = 실패, `Some(None)` = 중지).
fn exit_of(tracking: &RunTracking, name: &str) -> Option<Option<String>> {
    tracking.exits.lock().unwrap().get(name).cloned()
}

fn sequence_canceled(app: &tauri::AppHandle) -> bool {
    app.try_state::<SequenceState>()
        .map(|s| *s.canceled.lock().unwrap())
        .unwrap_or(true)
}

/// 이 단계의 서비스들이 모두 기동을 마칠 때까지 기다린다.
/// 하나라도 죽거나 실패하면 곧바로 중단한다 — 어차피 다음 단계가 그 서비스에 의존한다.
async fn wait_stage(app: &tauri::AppHandle, names: &[String]) -> Wait {
    let deadline = Instant::now() + SEQUENCE_STAGE_TIMEOUT;
    let mut pending: Vec<String> = names.to_vec();

    loop {
        if sequence_canceled(app) {
            return Wait::Canceled;
        }
        // 상태 확인은 await 없이 한 호흡에 끝낸다(State·락을 await 넘어 들고 있지 않게).
        let died = {
            match (
                app.try_state::<RunTracking>(),
                app.try_state::<ServiceState>(),
            ) {
                (Some(tracking), Some(state)) => {
                    pending.retain(|name| !has_started(&tracking, &state, name));
                    pending.iter().find_map(|name| {
                        exit_of(&tracking, name).map(|exit| match exit {
                            Some(reason) => format!("'{name}' 기동 실패 — {reason}"),
                            None => {
                                format!("'{name}' 이(가) 기동을 마치기 전에 종료되었습니다")
                            }
                        })
                    })
                }
                _ => Some("앱 상태를 찾을 수 없습니다".to_string()),
            }
        };
        if let Some(reason) = died {
            return Wait::Failed(reason);
        }
        if pending.is_empty() {
            return Wait::Started;
        }
        if Instant::now() >= deadline {
            return Wait::Failed(format!(
                "{}초 안에 기동을 마치지 못했습니다 — {}",
                SEQUENCE_STAGE_TIMEOUT.as_secs(),
                pending.join(", ")
            ));
        }
        tokio::time::sleep(SEQUENCE_POLL).await;
    }
}

/// 단계 목록을 순서대로 실행한다. 한 단계의 설정들은 동시에 띄우고,
/// 그 단계가 전부 기동을 마친 뒤에 다음 단계로 넘어간다.
async fn run_sequence(app: &tauri::AppHandle, project: &str, stages: &[Vec<String>]) {
    let total = stages.len();

    for (i, names) in stages.iter().enumerate() {
        let stage = i + 1;
        if names.is_empty() {
            continue;
        }
        if sequence_canceled(app) {
            emit_sequence(app, stage, total, names, "canceled", None);
            return;
        }
        emit_sequence(app, stage, total, names, "starting", None);

        // 이미 실행 중인 서비스는 건드리지 않는다(재시작하면 그것에 의존하는 것들이 끊긴다).
        // 우리가 추적 중인 것만 보면 안 된다 — IntelliJ 에서 방금 띄운 실행은 흡수(3초 주기)
        // 전이라 추적 목록에 없고, 그 상태로 또 실행하면 두 벌이 뜨거나 IDE 가 기존 실행을
        // 재시작해 버린다. 그래서 지금 살아 있는 프로세스까지 확인한다(단계마다 `ps` 1회).
        let metas = read_metas(project);
        let procs = ps_list();
        let mut waiting: Vec<String> = Vec::new();
        for name in names {
            let alive = !tracked_pids(app, name).is_empty()
                || tracked_targets(&metas, name)
                    .iter()
                    .any(|t| find_pid_in(&procs, t, project).is_some());
            if alive {
                emit_log(
                    app,
                    name,
                    &format!("[my-space] 순차 실행 {stage}/{total} — 이미 실행 중이라 건너뜁니다."),
                );
                continue;
            }
            let kind = metas.get(name).and_then(|m| m.kind.clone());
            if let Err(e) = launch(app.clone(), project.to_string(), name.clone(), kind).await {
                emit_sequence(
                    app,
                    stage,
                    total,
                    names,
                    "failed",
                    Some(format!("'{name}' 시작 실패 — {e}")),
                );
                return;
            }
            emit_log(
                app,
                name,
                &format!("[my-space] 순차 실행 {stage}/{total} — 시작했습니다."),
            );
            waiting.push(name.clone());
        }
        if waiting.is_empty() {
            continue;
        }

        emit_sequence(app, stage, total, names, "waiting", None);
        match wait_stage(app, &waiting).await {
            Wait::Started => {
                for name in &waiting {
                    emit_log(
                        app,
                        name,
                        &format!("[my-space] 순차 실행 {stage}/{total} — 기동 완료."),
                    );
                }
            }
            Wait::Canceled => {
                emit_sequence(app, stage, total, names, "canceled", None);
                return;
            }
            Wait::Failed(reason) => {
                emit_sequence(app, stage, total, names, "failed", Some(reason));
                return;
            }
        }
    }

    let last = stages.last().cloned().unwrap_or_default();
    emit_sequence(app, total, total, &last, "done", None);
}

/// 설정들을 **단계별로** 띄운다(예: cowork 의 Registry → Uaa → Messaging → 나머지).
/// 한 단계 안의 설정들은 동시에 시작하고, 그 단계가 모두 기동을 마친 뒤 다음으로 넘어간다.
///
/// 단계마다 Make + 기동을 기다려 몇 분이 걸리므로 요청은 바로 돌려주고, 진행 상황은
/// `intellij:sequence` 이벤트로 알린다. 화면을 떠나도 계속 진행된다.
/// 이미 실행 중인 설정은 건너뛰므로 중단된 지점부터 다시 눌러도 된다.
#[tauri::command]
pub fn intellij_start_sequence(
    app: tauri::AppHandle,
    project: String,
    stages: Vec<Vec<String>>,
) -> Result<(), String> {
    if stages.iter().all(|s| s.is_empty()) {
        return Err("실행할 설정이 없습니다".into());
    }
    {
        let Some(state) = app.try_state::<SequenceState>() else {
            return Err("순차 실행 상태를 찾을 수 없습니다".into());
        };
        let mut running = state.running.lock().unwrap();
        if *running {
            return Err("이미 순차 실행이 진행 중입니다".into());
        }
        *running = true;
        *state.canceled.lock().unwrap() = false;
    }

    tauri::async_runtime::spawn(async move {
        run_sequence(&app, &project, &stages).await;
        if let Some(state) = app.try_state::<SequenceState>() {
            *state.running.lock().unwrap() = false;
        }
    });
    Ok(())
}

/// 진행 중인 순차 실행을 중단한다. **이미 뜬 서비스는 내리지 않는다** —
/// 어디까지 올라갔는지 확인하고 손으로 이어 가는 편이 낫다.
#[tauri::command]
pub fn intellij_cancel_sequence(app: tauri::AppHandle) {
    if let Some(state) = app.try_state::<SequenceState>() {
        *state.canceled.lock().unwrap() = true;
    }
}

/// 순차 실행의 현재 상태. 화면을 다시 열었을 때 버튼·진행 표시를 복원하는 데 쓴다.
#[tauri::command]
pub fn intellij_sequence_status(app: tauri::AppHandle) -> SequenceStatus {
    match app.try_state::<SequenceState>() {
        Some(state) => SequenceStatus {
            running: *state.running.lock().unwrap(),
            last: state.last.lock().unwrap().clone(),
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

    /// IntelliJ 의 "Save console output to file"(Logs 탭) 설정을 읽어야 한다.
    /// 이게 켜져 있으면 IDE 의 Run 버튼으로 띄운 실행도 콘솔을 파일로 남기므로
    /// my-space 에서 IntelliJ 와 같은 로그를 볼 수 있다.
    #[test]
    fn parses_console_output_file_setting() {
        let dir = std::env::temp_dir().join("myspace-intellij-test");
        fs::create_dir_all(&dir).unwrap();

        let write = |file: &str, body: &str| {
            let p = dir.join(file);
            fs::write(&p, body).unwrap();
            p
        };

        // is_save="true" → 경로를 읽는다.
        let on = write(
            "on.xml",
            r#"<component name="ProjectRunConfigurationManager">
  <configuration name="RegistryApplication" type="SpringBootApplicationConfigurationType">
    <output_file path="$PROJECT_DIR$/logs/registry.log" is_save="true" />
    <module name="registry-boot" />
  </configuration>
</component>"#,
        );
        let (name, meta) = parse_config_file(&on).expect("파싱");
        assert_eq!(name, "RegistryApplication");
        assert_eq!(
            meta.output_file.as_deref(),
            Some("$PROJECT_DIR$/logs/registry.log")
        );

        // is_save="false" → 저장하지 않는 설정이므로 무시한다.
        let off = write(
            "off.xml",
            r#"<component name="ProjectRunConfigurationManager">
  <configuration name="X" type="SpringBootApplicationConfigurationType">
    <output_file path="$PROJECT_DIR$/logs/x.log" is_save="false" />
  </configuration>
</component>"#,
        );
        assert_eq!(parse_config_file(&off).unwrap().1.output_file, None);

        // 설정이 아예 없으면 None.
        let none = write(
            "none.xml",
            r#"<component name="ProjectRunConfigurationManager">
  <configuration name="Y" type="SpringBootApplicationConfigurationType" />
</component>"#,
        );
        assert_eq!(parse_config_file(&none).unwrap().1.output_file, None);

        // 매크로 확장: $PROJECT_DIR$ 과 상대 경로 모두 프로젝트 기준 절대 경로가 된다.
        assert_eq!(
            expand_macros("$PROJECT_DIR$/logs/a.log", "/tmp/proj"),
            PathBuf::from("/tmp/proj/logs/a.log")
        );
        assert_eq!(
            expand_macros("logs/b.log", "/tmp/proj"),
            PathBuf::from("/tmp/proj/logs/b.log")
        );
        assert_eq!(
            expand_macros("/var/log/c.log", "/tmp/proj"),
            PathBuf::from("/var/log/c.log")
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 로그 동기화를 켜는 XML 패치. 실제 cowork 설정과 같은 모양을 다룬다.
    #[test]
    fn patches_output_file_into_run_config() {
        const VALUE: &str = "$PROJECT_DIR$/.idea/my-space-logs/RegistryApplication.log";

        // 1) 없던 설정은 <method> 바로 앞에, 같은 들여쓰기로 들어간다.
        let src = r#"<component name="ProjectRunConfigurationManager">
  <configuration name="RegistryApplication" type="SpringBootApplicationConfigurationType">
    <option name="ACTIVE_PROFILES" value="local,kmhan" />
    <module name="registry-boot" />
    <method v="2">
      <option name="Make" enabled="true" />
    </method>
  </configuration>
</component>"#;
        let out = patch_output_file_xml(src, VALUE).expect("패치");
        assert!(out.contains(&format!(
            "    <output_file path=\"{VALUE}\" is_save=\"true\" />\n    <method v=\"2\">"
        )));
        // 원본의 다른 줄은 그대로여야 한다.
        assert!(out.contains(r#"<option name="ACTIVE_PROFILES" value="local,kmhan" />"#));
        // 패치 결과를 다시 파싱하면 켜진 것으로 읽혀야 한다(왕복 확인).
        let dir = std::env::temp_dir().join("myspace-intellij-patch-test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("patched.xml");
        fs::write(&p, &out).unwrap();
        assert_eq!(
            parse_config_file(&p).unwrap().1.output_file.as_deref(),
            Some(VALUE)
        );

        // 2) 꺼 둔 설정(is_save="false")이 있으면 그 자리를 교체한다 — 중복 생성 금지.
        let off = r#"<component name="ProjectRunConfigurationManager">
  <configuration name="X" type="SpringBootApplicationConfigurationType">
    <output_file path="$PROJECT_DIR$/logs/old.log" is_save="false" />
    <method v="2" />
  </configuration>
</component>"#;
        let out = patch_output_file_xml(off, VALUE).expect("패치");
        assert_eq!(out.matches("<output_file").count(), 1);
        assert!(!out.contains("old.log"));

        // 3) <method> 가 없는 설정은 </configuration> 앞에 한 단 들여써서 넣는다.
        let bare = r#"<component name="ProjectRunConfigurationManager">
  <configuration name="Y" type="SpringBootApplicationConfigurationType">
    <module name="m" />
  </configuration>
</component>"#;
        let out = patch_output_file_xml(bare, VALUE).expect("패치");
        assert!(out.contains(&format!(
            "    <output_file path=\"{VALUE}\" is_save=\"true\" />\n  </configuration>"
        )));

        // 4) 자기 종료가 아닌 <output_file>…</output_file> 도 통째로 바뀐다.
        let paired = r#"<configuration name="Z">
    <output_file path="a" is_save="false"></output_file>
    <method v="2" />
  </configuration>"#;
        let out = patch_output_file_xml(paired, VALUE).expect("패치");
        assert!(!out.contains("</output_file>"));
        assert_eq!(out.matches("<output_file").count(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    /// Multirun 은 자기 콘솔이 없다 — 로그 동기화 대상은 재귀적으로 펼친 말단 설정이고,
    /// 표시 상태는 그 말단이 **모두** 켜져 있을 때만 "켜짐" 이다.
    #[test]
    fn log_sync_state_follows_multirun_children() {
        let leaf = |output: Option<&str>| Meta {
            kind: Some("spring-boot".into()),
            file: Some(PathBuf::from("/tmp/x.xml")),
            output_file: output.map(str::to_string),
            ..Default::default()
        };
        let multirun = |children: &[&str]| Meta {
            kind: Some("multirun".into()),
            file: Some(PathBuf::from("/tmp/m.xml")),
            children: children.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        };

        let mut metas = HashMap::new();
        metas.insert("A".to_string(), leaf(Some("$PROJECT_DIR$/a.log")));
        metas.insert("B".to_string(), leaf(None));
        // Multirun 이 Multirun 을 품는 실제 구조(Cowork Start → Cowork Phase2).
        metas.insert("Phase2".to_string(), multirun(&["B"]));
        metas.insert("Start".to_string(), multirun(&["A", "Phase2"]));
        // XML 이 없는 설정(임시 설정) — 손댈 수 없다.
        metas.insert("Temp".to_string(), Meta::default());

        assert_eq!(leaf_configs(&metas, "Start"), vec!["A", "B"]);
        assert_eq!(log_sync_state(&metas, "A"), Some(true));
        assert_eq!(log_sync_state(&metas, "B"), Some(false));
        assert_eq!(log_sync_state(&metas, "Start"), Some(false)); // B 가 꺼져 있다
        assert_eq!(log_sync_state(&metas, "Temp"), None);
        assert_eq!(log_sync_state(&metas, "없는설정"), None);

        // B 까지 켜면 Multirun 도 켜진 것으로 본다.
        metas.insert("B".to_string(), leaf(Some("$PROJECT_DIR$/b.log")));
        assert_eq!(log_sync_state(&metas, "Start"), Some(true));

        // 서로를 참조하는 Multirun 이 있어도 무한 재귀에 빠지지 않는다.
        metas.insert("Loop".to_string(), multirun(&["Loop", "A"]));
        assert_eq!(leaf_configs(&metas, "Loop"), vec!["A"]);
    }

    /// 프로필 없는 대상의 판별 규칙: 메인 클래스와 프로젝트 경로가 **둘 다**
    /// 커맨드라인에 있고, 래퍼가 아닌 실제 java 프로세스여야 한다.
    #[test]
    fn finds_pid_from_a_ps_snapshot() {
        const MAIN: &str = "spectra.attic.coreasset.ecosystem.registry.RegistryApplication";
        let target = |main: &str| Target {
            main_class: main.to_string(),
            profiles: None,
        };
        let procs = vec![
            // 다른 프로젝트에서 띄운 같은 메인 클래스 — 프로젝트 경로가 달라 제외.
            (100, format!("/usr/bin/java -cp /other/proj/classes {MAIN}")),
            // maven 래퍼는 java 프로세스가 아니므로 제외.
            (101, format!("/bin/sh {COWORK}/mvnw spring-boot:run -Dmain={MAIN}")),
            // 정답.
            (
                102,
                format!("/usr/bin/java -cp {COWORK}/registry-boot/target/classes {MAIN}"),
            ),
        ];
        assert_eq!(find_pid_in(&procs, &target(MAIN), COWORK), Some(102));

        // 이름만 비슷한 다른 설정을 집으면 안 된다.
        assert_eq!(
            find_pid_in(&procs, &target("other.OtherApplication"), COWORK),
            None
        );
        // `java` 로 시작하는 커맨드(PATH 로 실행)도 받아들인다.
        let bare = vec![(200, format!("java -cp {COWORK}/x {MAIN}"))];
        assert_eq!(find_pid_in(&bare, &target(MAIN), COWORK), Some(200));
    }

    /// 메인 클래스가 같은 형제 설정(cowork 의 ApiGateway agent/customer/mobile)은
    /// **프로필로** 갈라야 한다. 이 구분이 없으면 셋이 한 pid 를 공유하는 것처럼 보여
    /// 포트도 하나로 보이고, agent 를 내리면 customer 가 죽는다.
    #[test]
    fn same_main_class_configs_are_split_by_profile() {
        const MAIN: &str = "spectra.attic.coreasset.ecosystem.apigateway.ApiGatewayApplication";
        let gw = |profile: &str| Target {
            main_class: MAIN.to_string(),
            profiles: Some(format!("local,kmhan,{profile}")),
        };
        let procs = vec![
            (
                301,
                format!(
                    "/usr/bin/java -Dspring.profiles.active=local,kmhan,customer \
                     -cp {COWORK}/apigateway/target/classes {MAIN}"
                ),
            ),
            (
                302,
                format!(
                    "/usr/bin/java -Dspring.profiles.active=local,kmhan,agent \
                     -cp {COWORK}/apigateway/target/classes {MAIN}"
                ),
            ),
        ];

        assert_eq!(find_pid_in(&procs, &gw("agent"), COWORK), Some(302));
        assert_eq!(find_pid_in(&procs, &gw("customer"), COWORK), Some(301));
        // 안 뜬 변종은 없는 것으로 나와야 한다(형제 pid 를 빌려오면 안 된다).
        assert_eq!(find_pid_in(&procs, &gw("mobile"), COWORK), None);

        // 접두사가 겹치는 프로필을 부분 일치로 처리하면 안 된다:
        // "local,kmhan" 은 "local,kmhan,agent" 와 다른 값이다.
        let plain = Target {
            main_class: MAIN.to_string(),
            profiles: Some("local,kmhan".to_string()),
        };
        assert_eq!(find_pid_in(&procs, &plain, COWORK), None);

        // 판단 근거가 없을 때(프로세스가 프로필을 안 달고 있음)는 걸러내지 않는다 —
        // 걸러 버리면 종료·재시작 제어를 잃는다.
        let no_flag = vec![(
            303,
            format!("/usr/bin/java -cp {COWORK}/apigateway/target/classes {MAIN}"),
        )];
        assert_eq!(find_pid_in(&no_flag, &gw("agent"), COWORK), Some(303));

        // XML 에 공백이 섞여 있어도 같은 프로필로 본다.
        let spaced = Target {
            main_class: MAIN.to_string(),
            profiles: Some("local, kmhan, agent".to_string()),
        };
        assert_eq!(find_pid_in(&procs, &spaced, COWORK), Some(302));
    }

    /// 프로필 비교는 **메인 클래스가 겹치는 설정에만** 적용해야 한다.
    /// 유일한 클래스까지 프로필로 거르면, IDE 에서 프로필을 바꿔 띄운 실행을
    /// 못 찾아 종료·재시작 제어를 잃는다.
    #[test]
    fn profile_filter_applies_only_to_shared_main_classes() {
        if !Path::new(COWORK).join(".idea").is_dir() {
            return; // 이 머신에 cowork 가 없으면 건너뛴다.
        }
        let metas = read_metas(COWORK);

        // RegistryApplication 은 클래스가 유일하다 → 프로필 비교를 켜지 않는다.
        if let Some(t) = tracked_targets(&metas, "RegistryApplication").first() {
            assert_eq!(
                t.profiles, None,
                "유일한 메인 클래스에 프로필 필터가 켜졌다 ({t:?})"
            );
        }
        // ApiGateway 변종은 클래스를 공유한다 → 프로필 비교가 켜져야 한다.
        if let Some(t) = tracked_targets(&metas, "ApiGatewayApplication (agent)").first() {
            assert!(
                t.profiles.as_deref().is_some_and(|p| p.contains("agent")),
                "형제 설정과 갈라 줄 프로필이 없다 ({t:?})"
            );
        }
    }

    /// cowork 의 `attic-port.yml` 을 읽어 설정별 예상 포트를 알아낸다.
    /// 서비스 config 가 `${attic.port.${spring.application.name}:8080}` 로 참조하는 값이라,
    /// ApiGateway 세 변종의 실제 포트(8080/8081/8082)가 여기서 갈린다.
    #[test]
    fn resolves_expected_port_from_project_convention() {
        let dir = std::env::temp_dir().join("myspace-intellij-test-ports");
        let conf = dir.join("biz/dworks-common-resource/registry-config");
        fs::create_dir_all(&conf).unwrap();
        fs::write(
            conf.join("attic-port.yml"),
            "attic:\n  \
             port:\n    \
             uaa: 8000            # 주석은 무시한다\n    \
             bff: 9010\n    \
             apigateway-agent: 8080\n    \
             apigateway-customer: 8081\n    \
             apigateway-mobile: 8082\n\
             other:\n  \
             port:\n    \
             uaa: 1\n",
        )
        .unwrap();

        let project = dir.to_string_lossy().to_string();
        let ports = read_port_map(&project);
        assert_eq!(ports.get("uaa"), Some(&8000), "attic.port 를 못 읽었다");
        assert_eq!(ports.get("apigateway-mobile"), Some(&8082));
        assert_eq!(ports.len(), 5, "attic.port 밖의 키까지 주워왔다 ({ports:?})");

        let meta = |module: &str, profiles: Option<&str>| Meta {
            module: Some(module.to_string()),
            profiles: profiles.map(str::to_string),
            ..Meta::default()
        };
        // 모듈 이름의 `-boot` 를 떼면 키가 된다.
        assert_eq!(
            expected_port(&ports, &meta("uaa-boot", Some("local,kmhan"))),
            Some(8000)
        );
        // 한 모듈을 프로필로 나눠 쓰는 경우는 `<모듈>-<프로필>` 이 먼저다.
        assert_eq!(
            expected_port(&ports, &meta("apigateway", Some("local,kmhan,customer"))),
            Some(8081)
        );
        assert_eq!(
            expected_port(&ports, &meta("apigateway", Some("local,kmhan,mobile"))),
            Some(8082)
        );
        // 매핑에 없는 서비스는 모르는 채로 둔다(추측하지 않는다).
        assert_eq!(expected_port(&ports, &meta("docs-boot", None)), None);
        assert_eq!(expected_port(&ports, &Meta::default()), None);

        // 규약 파일이 없는 프로젝트는 빈 맵.
        assert!(read_port_map("/tmp/no-such-project-here").is_empty());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 실제 cowork 의 실행 설정 XML 을 그대로 패치해 보고, 다시 파싱해 켜진 것으로
    /// 읽히는지 확인한다(원본은 건드리지 않고 사본으로만 검증한다).
    #[test]
    fn patches_every_real_cowork_run_config() {
        let dir = Path::new(COWORK).join(".idea").join("runConfigurations");
        if !dir.is_dir() {
            return; // 이 머신에 cowork 가 없으면 건너뛴다.
        }
        let tmp = std::env::temp_dir().join("myspace-intellij-cowork-patch");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        let metas = read_metas(COWORK);
        assert!(!metas.is_empty(), "실행 설정을 하나도 읽지 못했다");

        for (name, meta) in &metas {
            let src = fs::read_to_string(meta.file.as_ref().unwrap()).unwrap();
            let value = format!("$PROJECT_DIR$/{LOG_DIR_REL}/{}.log", sanitize(name));
            let patched = patch_output_file_xml(&src, &value)
                .unwrap_or_else(|| panic!("'{name}' 패치 실패"));

            let copy = tmp.join(format!("{}.xml", sanitize(name)));
            fs::write(&copy, &patched).unwrap();
            let (parsed_name, parsed) =
                parse_config_file(&copy).unwrap_or_else(|| panic!("'{name}' 재파싱 실패"));
            assert_eq!(&parsed_name, name, "이름이 바뀌면 안 된다");
            assert_eq!(parsed.output_file.as_deref(), Some(value.as_str()));
            // 나머지 메타데이터는 그대로여야 한다 — 다른 줄을 건드리지 않았다는 확인.
            assert_eq!(parsed.main_class, meta.main_class, "{name}");
            assert_eq!(parsed.profiles, meta.profiles, "{name}");
            assert_eq!(parsed.children, meta.children, "{name}");
            assert_eq!(parsed.module, meta.module, "{name}");
        }

        let _ = fs::remove_dir_all(&tmp);
    }

    /// 위 규칙이 **실제** cowork 파일에도 맞는지 확인한다(모듈 이름 규약이 어긋나면 여기서 걸린다).
    #[test]
    fn expected_ports_match_the_real_cowork_project() {
        if !Path::new(COWORK).join(PORT_MAP_REL).is_file() {
            return; // 이 머신에 cowork 가 없으면 건너뛴다.
        }
        let ports = read_port_map(COWORK);
        let metas = read_metas(COWORK);
        assert!(!ports.is_empty(), "attic-port.yml 을 읽지 못했다");

        // ApiGateway 세 변종은 프로필로 갈려 서로 다른 포트여야 한다.
        let of = |name: &str| metas.get(name).and_then(|m| expected_port(&ports, m));
        let gateways: Vec<Option<u16>> = ["agent", "customer", "mobile"]
            .iter()
            .map(|p| of(&format!("ApiGatewayApplication ({p})")))
            .collect();
        if metas.contains_key("ApiGatewayApplication (agent)") {
            println!("ApiGateway agent/customer/mobile → {gateways:?}");
            assert!(
                gateways.iter().all(Option::is_some),
                "변종의 포트를 해석하지 못했다 ({gateways:?})"
            );
            assert_eq!(
                gateways.iter().collect::<HashSet<_>>().len(),
                3,
                "세 변종이 같은 포트로 해석됐다 ({gateways:?})"
            );
        }
        for (name, want) in [("UaaApplication", "uaa"), ("BffApplication", "bff")] {
            if let (Some(got), Some(expect)) = (of(name), ports.get(want)) {
                assert_eq!(got, *expect, "{name} 의 포트를 {want} 로 못 이었다");
            }
        }
    }

    /// 순차 실행의 "기동 완료" 판정. Spring Boot 의 Started 로그가 첫 근거이고,
    /// 로그를 읽을 수 없어도 **고정** 포트를 열었으면 떴다고 본다.
    /// 임시 포트(JMX 등)는 기동 중에도 열리므로 근거가 되면 안 된다 —
    /// 그걸 믿으면 아직 안 뜬 서비스 위에 다음 단계를 올린다.
    #[test]
    fn started_signal_uses_log_or_fixed_port() {
        const NAME: &str = "RegistryApplication";
        let t = RunTracking::default();
        let s = ServiceState::default();

        assert!(
            !has_started(&t, &s, NAME),
            "아무 근거도 없는데 기동 완료로 봤다"
        );

        let set_port = |port: u16| {
            s.0.lock()
                .unwrap()
                .insert(NAME.to_string(), vec![Proc { pid: 1, port: Some(port) }]);
        };

        set_port(62599); // 임시 포트 — 아직 기동 중일 수 있다.
        assert!(!has_started(&t, &s, NAME), "임시 포트를 기동 완료로 봤다");

        set_port(8761); // eureka 같은 고정 포트 — 서버가 떴다.
        assert!(has_started(&t, &s, NAME), "고정 포트를 못 알아봤다");

        // 포트를 쓰지 않는 서비스라도 Started 로그를 봤으면 완료다.
        let empty = ServiceState::default();
        t.outcome.lock().unwrap().insert(
            NAME.to_string(),
            Outcome {
                started: true,
                fail_reason: None,
            },
        );
        assert!(has_started(&t, &empty, NAME), "Started 로그를 못 알아봤다");
    }

    /// 기동을 기다리는 동안 서비스가 죽으면 순차 실행은 즉시 중단해야 한다.
    /// `finalize` 가 `outcome` 을 꺼내 가며 지우므로, 그 판단은 `exits` 기록으로만 가능하다.
    #[test]
    fn exit_is_recorded_for_the_sequence_to_see() {
        const NAME: &str = "UaaApplication";
        let t = RunTracking::default();
        assert_eq!(exit_of(&t, NAME), None, "끝나지도 않았는데 결과가 있다");

        t.exits
            .lock()
            .unwrap()
            .insert(NAME.to_string(), Some("포트가 이미 사용 중".to_string()));
        assert_eq!(
            exit_of(&t, NAME),
            Some(Some("포트가 이미 사용 중".to_string())),
            "실패 사유를 잃었다"
        );

        // 정상 중지도 기록된다 — 기동 전에 내려갔다면 다음 단계를 올릴 수 없다.
        t.exits.lock().unwrap().insert(NAME.to_string(), None);
        assert_eq!(exit_of(&t, NAME), Some(None));
    }

    /// 끝난 실행의 로그 파일은 아무도 열고 있지 않으므로 후보에서 빠져야 한다.
    /// (이 검사가 없으면 죽은 실행의 로그가 현재 로그처럼 붙는다.)
    #[test]
    fn closed_file_is_not_treated_as_live_log() {
        let dir = std::env::temp_dir().join("myspace-intellij-test-open");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("ij_run__Dead_1.log");
        fs::write(&p, "old run output\n").unwrap();

        assert!(!file_is_open(&p), "닫힌 파일을 열려 있다고 판단했다");
        assert!(
            !file_is_open(&dir.join("does-not-exist.log")),
            "없는 파일은 열려 있지 않다"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 서비스 포트 선택 — 임시 포트를 서버 포트로 착각하면 안 된다.
    ///
    /// 회귀 방지: JVM 이 JMX 용 임시 포트(62599)를 서버 포트(8888)보다 **먼저** 열기 때문에,
    /// 아무 포트나 받아들이면 트리에 `:62599` 가 표시됐다.
    #[test]
    fn picks_fixed_service_port_not_ephemeral() {
        // 기동 직후: 임시 포트만 열려 있다 → 아직 고를 수 없다(기다려야 한다).
        assert_eq!(pick_service_port(&[62599], None), None);
        assert_eq!(pick_service_port(&[49152, 60156, 62599], None), None);

        // 서버 포트가 열린 뒤: 고정 포트를 골라야 한다(오름차순 입력).
        assert_eq!(pick_service_port(&[8888, 62599], None), Some(8888));
        assert_eq!(pick_service_port(&[8888, 60156], None), Some(8888));
        assert_eq!(pick_service_port(&[8888], None), Some(8888));

        // 고정 포트가 여러 개면 가장 작은 것(관리 포트보다 서비스 포트가 보통 작다).
        assert_eq!(pick_service_port(&[8888, 9999, 62599], None), Some(8888));

        // 예상 포트를 알면 추측하지 않고 그것을 고른다(가장 작은 것이 아니라).
        assert_eq!(pick_service_port(&[8080, 8888], Some(8888)), Some(8888));
        // 예상 포트가 아직 안 열렸으면 기존 규칙대로 고정 포트를 쓴다.
        assert_eq!(pick_service_port(&[8888], Some(8081)), Some(8888));
        assert_eq!(pick_service_port(&[62599], Some(8081)), None);

        // 아무 포트도 없으면 None.
        assert_eq!(pick_service_port(&[], None), None);

        // 마지막 수단(고정 포트를 안 쓰는 서비스)은 가장 작은 포트.
        assert_eq!(pick_any_port(&[60156, 62599]), Some(60156));
        assert_eq!(pick_any_port(&[]), None);
    }

    /// 같은 로그 파일을 두 번 tail 하려 하면 두 번째는 거부되어야 한다.
    ///
    /// 회귀 방지: 시작 경로(`launch`)와 외부 실행 흡수 경로(`adopt_external`)가 **같은**
    /// `ij_run__*.log` 를 각각 붙잡아, 파일에는 한 번만 있는 줄이 화면에 두 번씩 찍혔다.
    #[test]
    fn tail_is_claimed_only_once_per_log_file() {
        let t = RunTracking::default();
        let log = PathBuf::from("/tmp/ij_run__RegistryApplication_123.log");
        let key = tail_key("RegistryApplication", &log);

        assert!(claim_tail(&t, &key), "첫 tail 은 시작할 수 있어야 한다");
        assert!(!claim_tail(&t, &key), "같은 파일의 두 번째 tail 은 거부되어야 한다");

        // 다른 실행(= 다른 로그 파일)은 막히지 않는다.
        let other = tail_key(
            "RegistryApplication",
            Path::new("/tmp/ij_run__RegistryApplication_456.log"),
        );
        assert!(claim_tail(&t, &other), "다른 로그 파일은 tail 할 수 있어야 한다");

        // 다른 설정이 같은 파일을 보는 경우도 별개로 취급한다.
        let other_name = tail_key("Cowork Start", &log);
        assert!(claim_tail(&t, &other_name));

        // 끝난 tail 은 소유권을 놓아, 재시작 후 같은 파일을 다시 볼 수 있다.
        release_tail(&t, &key);
        assert!(claim_tail(&t, &key), "해제 후에는 다시 tail 할 수 있어야 한다");
    }

    /// 시작 진행 표시가 켜져 있는 동안에는 외부 실행 흡수가 끼어들지 않아야 한다.
    /// (흡수가 끼어들면 감시 스레드와 tail 이 이중으로 돌아 로그가 두 번 보였다.)
    #[test]
    fn starting_flag_blocks_adoption_window() {
        let t = RunTracking::default();
        assert!(!t.starting.lock().unwrap().contains("RegistryApplication"));

        t.starting
            .lock()
            .unwrap()
            .insert("RegistryApplication".to_string());
        assert!(t.starting.lock().unwrap().contains("RegistryApplication"));

        t.starting.lock().unwrap().remove("RegistryApplication");
        assert!(!t.starting.lock().unwrap().contains("RegistryApplication"));
    }

    /// IntelliJ 에서 이미 실행 중인 서비스를 찾을 때 쓰는 추적 대상 계산.
    /// Multirun 은 자식 설정들로 펼쳐져야 하고(그래야 흡수가 가능하다),
    /// 각 대상은 프로필까지 들고 있어야 한다(형제 설정과 구분하는 열쇠).
    #[test]
    fn tracked_targets_expands_multirun() {
        if !Path::new(COWORK).join(".idea").is_dir() {
            return; // 이 머신에 cowork 가 없으면 건너뛴다.
        }
        let metas = read_metas(COWORK);

        let single = tracked_targets(&metas, "RegistryApplication");
        assert_eq!(single.len(), 1, "{single:?}");
        assert!(
            single[0].main_class.ends_with("RegistryApplication"),
            "{single:?}"
        );

        // ApiGateway 세 변종은 메인 클래스가 같고 프로필만 다르다 — 그 프로필이 실려야 한다.
        for profile in ["agent", "customer", "mobile"] {
            let name = format!("ApiGatewayApplication ({profile})");
            let Some(t) = tracked_targets(&metas, &name).into_iter().next() else {
                continue; // 이 프로젝트에 해당 설정이 없으면 넘어간다.
            };
            let profiles = t.profiles.unwrap_or_default();
            assert!(
                profiles.split(',').any(|p| p.trim() == profile),
                "{name} 의 프로필이 실리지 않았다 ({profiles})"
            );
        }

        // Cowork Start 는 Spring Boot 자식 3개 + Multirun 자식 1개를 참조한다.
        // 중첩 Multirun 은 여기서 펼치지 않으므로 직속 Spring Boot 자식만 잡힌다.
        let multi = tracked_targets(&metas, "Cowork Start");
        assert!(multi.len() >= 3, "{multi:?}");

        // XML 이 없는 설정은 추적 대상이 없다(= 종료/재시작 불가).
        assert!(tracked_targets(&metas, "존재하지 않는 설정").is_empty());
    }

    /// 실제 IntelliJ 로 RegistryApplication 을 띄우고, 메인 클래스로 프로세스를 찾아
    /// SIGINT 으로 내리는 전체 경로를 확인한다. IDE 가 떠 있어야 하고 포트 8888 이
    /// 비어 있어야 하므로 기본 실행에서는 제외한다:
    ///   cargo test --lib intellij -- --ignored --nocapture
    #[test]
    #[ignore = "실행 중인 IntelliJ 와 비어 있는 포트가 필요하다"]
    fn starts_and_stops_via_intellij() {
        const PROJECT: &str = "/Users/rudaks/_WORK/_ENOMIX_GIT/spectrakr/cowork";
        const NAME: &str = "RegistryApplication";

        let metas = read_metas(PROJECT);
        let main_class = metas
            .get(NAME)
            .and_then(|m| m.main_class.clone())
            .expect("XML 에서 메인 클래스를 찾아야 한다");
        assert!(find_pid(&main_class, PROJECT).is_none(), "이미 실행 중이다");

        let out = tauri::async_runtime::block_on(async {
            let c = mcp::conn().await.expect("MCP 연결 실패");
            c.call_tool(
                "execute_run_configuration",
                serde_json::json!({
                    "projectPath": PROJECT,
                    "configurationName": NAME,
                    "waitForExit": false,
                }),
            )
            .await
            .expect("실행 실패")
        });
        // 로그 tail 대상 경로를 IDE 가 알려주는지 확인.
        let log_path = out["fullOutputPath"].as_str().expect("fullOutputPath 없음");
        println!("log: {log_path}");

        // Make(컴파일) 후 JVM 이 뜨기를 기다린다.
        let deadline = Instant::now() + PID_WAIT;
        let mut pid = None;
        while Instant::now() < deadline {
            if let Some(p) = find_pid(&main_class, PROJECT) {
                pid = Some(p);
                break;
            }
            std::thread::sleep(POLL);
        }
        let pid = pid.expect("앱 JVM 을 찾지 못했다");
        println!("pid: {pid}");
        assert!(is_alive(pid));

        // 기동 완료까지 기다렸다가(로그로 확인) 종료.
        let started = {
            let deadline = Instant::now() + Duration::from_secs(120);
            let mut ok = false;
            while Instant::now() < deadline {
                if fs::read_to_string(log_path)
                    .map(|t| t.contains("Started RegistryApplication"))
                    .unwrap_or(false)
                {
                    ok = true;
                    break;
                }
                if !is_alive(pid) {
                    break;
                }
                std::thread::sleep(POLL);
            }
            ok
        };
        assert!(started, "앱이 기동을 완료하지 못했다");

        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGINT);
        }
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline && is_alive(pid) {
            std::thread::sleep(POLL);
        }
        assert!(!is_alive(pid), "SIGINT 후에도 살아 있다");
        println!("stopped");
    }

    /// 로그에 기동 완료가 찍힐 때까지 기다린다.
    fn wait_started(log: &str, pid: u32, label: &str) {
        let deadline = Instant::now() + Duration::from_secs(180);
        while Instant::now() < deadline {
            if fs::read_to_string(log)
                .map(|t| t.contains("Started RegistryApplication"))
                .unwrap_or(false)
            {
                return;
            }
            assert!(is_alive(pid), "{label}: 기동 중 프로세스가 죽었다");
            std::thread::sleep(POLL);
        }
        panic!("{label}: 기동이 끝나지 않았다");
    }

    /// 실행 중인 서비스를 재시작하면, 이전 프로세스가 죽고 **새 pid** 로 포트 충돌 없이
    /// 다시 기동하는지 확인한다. 종료 대기는 커맨드가 쓰는 `kill_and_wait` 를 그대로 쓴다.
    ///   cargo test --lib intellij::tests::restarts -- --ignored --nocapture
    #[test]
    #[ignore = "실행 중인 IntelliJ 와 비어 있는 포트가 필요하다"]
    fn restarts_running_service() {
        const PROJECT: &str = "/Users/rudaks/_WORK/_ENOMIX_GIT/spectrakr/cowork";
        const NAME: &str = "RegistryApplication";

        let main_class = read_metas(PROJECT)
            .get(NAME)
            .and_then(|m| m.main_class.clone())
            .expect("메인 클래스");
        assert!(find_pid(&main_class, PROJECT).is_none(), "이미 실행 중이다");

        /// MCP 로 실행하고 (pid, 로그경로) 를 돌려준다.
        fn run(project: &str, name: &str, main_class: &str, label: &str) -> (u32, String) {
            let out = tauri::async_runtime::block_on(async {
                let c = mcp::conn().await.expect("MCP 연결 실패");
                c.call_tool(
                    "execute_run_configuration",
                    serde_json::json!({
                        "projectPath": project,
                        "configurationName": name,
                        "waitForExit": false,
                    }),
                )
                .await
                .expect("실행 실패")
            });
            let log = out["fullOutputPath"]
                .as_str()
                .expect("fullOutputPath")
                .to_string();

            let deadline = Instant::now() + PID_WAIT;
            while Instant::now() < deadline {
                if let Some(p) = find_pid(main_class, project) {
                    return (p, log);
                }
                std::thread::sleep(POLL);
            }
            panic!("{label}: 프로세스를 찾지 못했다");
        }

        // 1) 최초 실행
        let (pid1, log1) = run(PROJECT, NAME, &main_class, "1차");
        wait_started(&log1, pid1, "1차");
        println!("1차 pid: {pid1}");

        // 2) 재시작의 종료 단계 — 커맨드와 동일한 경로.
        tauri::async_runtime::block_on(kill_and_wait(&[pid1], || {
            println!("SIGKILL 로 승격")
        }))
        .expect("종료 실패");
        assert!(!is_alive(pid1), "이전 프로세스가 살아 있다");

        // 3) 재시작의 실행 단계 — 포트가 반납됐으므로 충돌 없이 떠야 한다.
        let (pid2, log2) = run(PROJECT, NAME, &main_class, "2차");
        assert_ne!(pid1, pid2, "같은 pid 가 재사용됐다");
        println!("2차 pid: {pid2}");
        wait_started(&log2, pid2, "2차");

        // 정리
        tauri::async_runtime::block_on(kill_and_wait(&[pid2], || {})).expect("정리 실패");
        println!("restart ok");
    }

    /// 실행 중인 서비스의 **LISTEN 포트**와 **출력 로그 파일**을 찾아내는지 확인한다.
    /// (트리에 `:8888` 을 표시하고, 이미 떠 있는 서비스의 로그를 이어 붙이는 근거)
    ///   cargo test --lib intellij::tests::detects -- --ignored --nocapture
    #[test]
    #[ignore = "실행 중인 IntelliJ 와 비어 있는 포트가 필요하다"]
    fn detects_port_and_log_of_running_service() {
        const NAME: &str = "RegistryApplication";

        let main_class = read_metas(COWORK)
            .get(NAME)
            .and_then(|m| m.main_class.clone())
            .expect("메인 클래스");
        assert!(find_pid(&main_class, COWORK).is_none(), "이미 실행 중이다");

        let out = tauri::async_runtime::block_on(async {
            let c = mcp::conn().await.expect("MCP 연결 실패");
            c.call_tool(
                "execute_run_configuration",
                serde_json::json!({
                    "projectPath": COWORK,
                    "configurationName": NAME,
                    "waitForExit": false,
                }),
            )
            .await
            .expect("실행 실패")
        });
        let log = out["fullOutputPath"].as_str().expect("fullOutputPath");

        let deadline = Instant::now() + PID_WAIT;
        let mut pid = None;
        while Instant::now() < deadline {
            if let Some(p) = find_pid(&main_class, COWORK) {
                pid = Some(p);
                break;
            }
            std::thread::sleep(POLL);
        }
        let pid = pid.expect("프로세스를 찾지 못했다");
        wait_started(log, pid, "기동");

        // 포트: JMX 용 임시 포트가 아니라 서비스 포트(8888)를 골라야 한다.
        let all = listening_ports(pid);
        let port = primary_port(pid, None);
        println!("ports={all:?} → primary={port:?}");
        assert_eq!(port, Some(8888), "대표 포트를 잘못 골랐다 (전체 {all:?})");

        // 로그 파일: MCP 가 알려준 경로와 같은 파일을 찾아야 한다.
        let found = find_run_log(NAME, pid).expect("실행 로그를 찾지 못했다");
        assert_eq!(found, PathBuf::from(log), "다른 실행의 로그를 집었다");
        println!("log matched: {}", found.display());

        tauri::async_runtime::block_on(kill_and_wait(&[pid], || {})).expect("정리 실패");
        assert!(primary_port(pid, None).is_none(), "종료 후에도 포트가 잡힌다");
        println!("detect ok");
    }
}

/// 현재 실행 중인 서비스 목록(이름 + pid).
///
/// 죽은 pid 를 정리하고, **IntelliJ 에서 직접 띄운 프로세스도 찾아 실행 중으로 흡수**한다.
/// 그래서 앱을 켰을 때 이미 돌고 있는 서비스가 실행 중으로 표시된다.
#[tauri::command]
pub fn intellij_running(
    app: tauri::AppHandle,
    state: tauri::State<ServiceState>,
    project: String,
) -> Vec<Running> {
    state.0.lock().unwrap().retain(|_, procs| {
        procs.retain(|p| is_alive(p.pid));
        !procs.is_empty()
    });

    adopt_external(&app, &state, &project);

    let map = state.0.lock().unwrap();
    map.iter()
        .flat_map(|(name, procs)| {
            procs.iter().map(move |p| Running {
                name: name.clone(),
                pid: p.pid,
                port: p.port,
            })
        })
        .collect()
}

/// 메인 창이 화면에 떠 있는지(트레이로 내려가 있으면 false). 폴링 주기를 정하는 데 쓴다.
fn window_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(true)
}

/// IntelliJ 에서 직접 시작한 실행을 자동으로 따라잡는 감시를 (재)설정한다.
/// 프론트가 프로젝트를 고를 때마다(=바뀔 때마다) 호출한다. `None` 이면 감시를 쉰다.
///
/// **중지는 이미 실시간이다** — 흡수된 프로세스는 `watch_alive` 가 500ms 마다 생존을
/// 확인해 죽는 즉시 `intellij:status` 를 낸다. 반대로 **시작**은 알림이 없어서
/// `adopt_external` 을 주기적으로 불러 주는 쪽밖에 없고, 그게 이 스레드의 일이다.
/// 그래서 이제 IDE 에서 Run 을 눌러도 수동 새로고침 없이 목록이 실행 중으로 바뀐다.
///
/// 스레드는 프로세스당 하나이고 화면을 떠나도 계속 돈다(다시 들어왔을 때 이미 정확한
/// 상태이고, 홈 대시보드처럼 뷰 밖에서 상태를 쓰는 곳도 맞는 값을 본다).
#[tauri::command]
pub fn intellij_watch_project(app: tauri::AppHandle, project: Option<String>) {
    let Some(watch) = app.try_state::<WatchProject>() else {
        return;
    };
    *watch.path.lock().unwrap() = project;

    {
        let mut running = watch.running.lock().unwrap();
        if *running {
            return; // 이미 돌고 있다 — 위에서 바꾼 경로를 다음 틱부터 본다.
        }
        *running = true;
    }

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(if window_visible(&app) {
                ADOPT_POLL
            } else {
                ADOPT_POLL_IDLE
            });
            let (Some(watch), Some(state)) = (
                app.try_state::<WatchProject>(),
                app.try_state::<ServiceState>(),
            ) else {
                return; // 종료 중.
            };
            let Some(project) = watch.path.lock().unwrap().clone() else {
                continue;
            };
            // 죽은 pid 정리는 각 감시 스레드(`finalize`)가 맡는다. 여기서 먼저 지우면
            // 종료 판정(실패/정상)을 기다리는 중인 항목을 가로채게 된다.
            adopt_external(&app, &state, &project);
        }
    });
}
