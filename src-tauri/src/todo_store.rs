//! 할 일(포스트잇 보드)을 **폴더 안의 마크다운 파일**로 읽고 쓴다.
//!
//! 왜 마크다운 폴더 하나뿐인가: 처음 요구는 "Notion·Dropbox·Obsidian 에 저장"이었지만,
//! Obsidian 볼트는 그냥 마크다운 폴더이고 Dropbox·iCloud·Google Drive 도 로컬에서는
//! 폴더다. 그래서 **저장 폴더를 지정할 수 있게 만드는 것 하나**로 넷이 동시에 해결된다 —
//! 볼트를 가리키면 Obsidian 에서 편집이 되고, Dropbox 폴더를 가리키면 기기 간 동기화는
//! Dropbox 앱이 하고(API 를 직접 부르는 것보다 안정적이다), git 저장소를 가리키면 이력이
//! 남는다. Notion 만 진짜 API 작업으로 남는데 그건 여기 범위가 아니다.
//!
//! 파일 배치 — **카테고리가 폴더 하나, 포스트잇이 그 안의 파일 하나**다:
//!
//! ```text
//! <루트>/릴리스/.myspace-category.md   ← 카테고리 자신(숨은 파일)
//! <루트>/릴리스/릴리스 준비.md          ← 포스트잇
//! <루트>/릴리스/문서 정리.md
//! <루트>/.myspace-trash/지운 것.md      ← 휴지통(숨은 폴더)
//! ```
//!
//! ```markdown
//! ---
//! myspace-todo: 1
//! id: a1b2…
//! title: 릴리스 준비
//! color: yellow
//! order: 0
//! ---
//!
//! - [x] 버전 올리기
//! - [ ] latest.json 확인
//! ```
//!
//! 포스트잇을 헤딩(`##`)이 아니라 파일로 두는 것이 이 배치의 핵심이다. Obsidian 에서
//! 포스트잇 하나가 노트 하나가 되므로 링크(`[[릴리스 준비]]`)·백링크·검색·그래프가 모두
//! 동작하고, **파일을 다른 폴더로 끌면 카테고리가 바뀐다** — 카테고리 소속을 frontmatter
//! 가 아니라 파일의 위치가 정하기 때문이다(그래서 포스트잇 파일에는 카테고리 id 를 적지
//! 않는다. 적으면 파일을 옮겼을 때 위치와 내용이 서로 다른 말을 한다).
//!
//! 여덟 가지가 이 형식을 정한다:
//!
//! - **할 일 줄에는 주석이 없다.** 포스트잇의 `id`(라운드트립 매칭)와 `color`(마크다운으로
//!   표현할 수 없는, 앱에서만 고르는 값)는 frontmatter 에 두지만 — 본문에서는 보이지
//!   않는다 — 할 일 항목은 텍스트와 체크 상태가 전부이고 그 id 를 참조하는 곳이 없다.
//!   그래서 읽을 때마다 새로 만든다. 덕분에 사람이 편집하는 본문이 체크박스 목록뿐이다.
//! - **`myspace-todo` 표식이 있는 파일만 건드린다.** 지정한 루트가 Obsidian 볼트일 수도
//!   있는데, 표식 없이 파일명만 보고 관리하면 남의 노트를 지운다. 카테고리 폴더 안에
//!   사람이 만들어 둔 다른 노트도 읽지 않고 지우지 않으며, 그런 파일이 남아 있으면
//!   카테고리를 지워도 폴더는 남는다(빈 폴더만 치운다).
//! - **깊이는 딱 한 단계다.** 루트 → 카테고리 폴더 → 포스트잇 파일. 그 아래는 보지 않는다.
//! - **파일명이 곧 제목이고, 정체성은 `id:` 다.** 앱에서 제목을 바꾸면 파일이 옮겨 가지만
//!   같은 포스트잇으로 남는다. 반대로 **사람이 파일명을 바꾸면 그것이 새 제목이 된다** —
//!   `matches_stem` 이 "파일명이 여전히 이 제목에서 나온 것인지"를 보고 판단한다. 파일명을
//!   무조건 신뢰하면 `a/b` 처럼 파일명에 못 쓰는 글자가 든 제목이 조용히 `a_b` 로 바뀌고,
//!   frontmatter 를 무조건 신뢰하면 Obsidian 에서 한 이름 바꾸기가 매번 되돌려진다.
//! - **제목이 비면 파일명에 id 를 쓴다**(`무제-a1b2c3d4.md`). 새로 만든 포스트잇은 제목이
//!   비어 있는 게 정상인데, 그것들을 `무제`·`무제-2` 로 번호 매기면 포스트잇 순서를 바꿀
//!   때마다 번호가 밀려 파일이 통째로 지워지고 다시 만들어진다. 같은 이유로 제목이 겹칠
//!   때의 접미사도 순번이 아니라 id 다.
//! - **id 가 비면 채우지 않고 빈 문자열로 넘긴다.** 프론트엔드에 이미 `crypto.randomUUID`
//!   기반 `newId()` 가 있으니 거기서 채우고, 다음 저장 때 파일에 적힌다. 다만 **카테고리
//!   id 는 예외로 폴더명을 채워 보낸다** — 포스트잇의 소속이 그 값을 참조하므로 사람이
//!   만든 폴더 두 개가 나란히 빈 id 로 오면 어느 폴더의 포스트잇인지 구분할 수 없다.
//! - **체크박스가 아닌 줄은 버려진다.** 포스트잇 데이터 모델에 자유 본문이 없어서 다음
//!   저장 때 사라진다 — 설정 화면이 이 사실을 알린다.
//! - **예전 배치(카테고리 하나 = 파일 하나)도 읽는다.** 포스트잇이 `##` 헤딩이던 첫 구현의
//!   파일이 루트에 남아 있으면 그대로 읽어 들이고, 다음 저장에서 새 배치로 옮겨진 뒤
//!   옛 파일은 정리된다(우리 표식이 있는 파일이라 지워도 안전하다).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::cowork::expand_home;

/// 우리가 관리하는 파일임을 알리는 frontmatter 키.
const MARKER: &str = "myspace-todo";
/// 카테고리 폴더가 자기 정보(id·이름·순서)를 담는 숨은 파일.
const CATEGORY_FILE: &str = ".myspace-category.md";
/// 휴지통 폴더. 점으로 시작해 Obsidian 파일 목록에서 숨는다.
const TRASH_DIR: &str = ".myspace-trash";
/// 첫 구현이 쓰던 휴지통 파일(정리 대상).
const LEGACY_TRASH_FILE: &str = ".myspace-todo-trash.md";
/// 포스트잇 하나가 이보다 많은 할 일을 갖는 일은 없다고 본다(깨진 파일 방어).
const MAX_TODOS: usize = 10_000;
/// 마크다운 파일 하나의 최대 크기(2MB). 넘으면 할 일 파일이 아니라고 본다.
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 쓸 수 있는 포스트잇 색(프론트 `StickyColor` 와 같아야 한다).
const COLORS: [&str; 6] = ["yellow", "pink", "green", "blue", "purple", "gray"];
/// 알 수 없는 색이 적혀 있을 때 쓸 값.
const FALLBACK_COLOR: &str = "yellow";

/// 할 일 한 줄.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub text: String,
    pub done: bool,
}

/// 포스트잇 하나.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoNote {
    /// frontmatter 의 `id:`. 비어 있으면 프론트엔드가 채운다.
    pub id: String,
    pub title: String,
    pub color: String,
    /// 어느 카테고리의 것인지. **파일의 위치**가 정한다(파일에 적지 않는다).
    #[serde(rename = "categoryId")]
    pub category_id: String,
    pub todos: Vec<TodoItem>,
    /// 휴지통 항목만 값이 있다(밀리초 epoch).
    #[serde(rename = "deletedAt", skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

/// 카테고리(= 폴더) 하나.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoCategory {
    /// `.myspace-category.md` 의 `id:`(없으면 폴더명).
    pub id: String,
    pub name: String,
}

/// 폴더를 한 번 읽은 결과.
#[derive(Debug, Serialize)]
pub struct TodoSnapshot {
    pub categories: Vec<TodoCategory>,
    /// 모든 카테고리의 포스트잇을 카테고리 순서대로 이어 놓은 목록
    /// (프론트의 `notes` 는 전체 목록이고 화면에서 `categoryId` 로 걸러 쓴다).
    pub notes: Vec<TodoNote>,
    pub trash: Vec<TodoNote>,
    /// 파일들의 수정 시각 지문. 이 값이 그대로면 폴더가 변하지 않았다는 뜻이다.
    pub signature: String,
    /// 우리가 관리하는 파일이 하나라도 있었는지. 처음 폴더를 지정했을 때
    /// "내보낼지(비어 있음) 읽어올지(이미 있음)"를 프론트엔드가 이걸로 정한다.
    pub populated: bool,
}

// ── 이름과 파일명 ───────────────────────────────────────────────────

/// 이름을 파일·폴더 이름으로 쓸 수 있게 다듬는다.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    // 앞뒤 공백과 점을 떼어 낸다(`.` 로 시작하면 숨은 파일이 되고, `..` 는 경로가 된다).
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "무제".to_string()
    } else {
        // 파일 시스템 한계를 넉넉히 밑도는 길이로 자른다(문자 단위라 UTF-8 경계가 안전하다).
        trimmed.chars().take(60).collect()
    }
}

/// 접미사로 쓸 id 앞부분.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// 이 제목·id 를 가진 항목이 기본으로 갖는 파일명(확장자 제외).
///
/// 제목이 비면 id 를 쓴다 — 새로 만든 포스트잇은 제목이 비어 있는 게 정상이고, 그것들을
/// 순번(`무제-2`)으로 구분하면 순서를 바꿀 때마다 번호가 밀려 파일이 지워지고 다시 생긴다.
fn base_stem(title: &str, id: &str) -> String {
    let t = title.trim();
    if t.is_empty() {
        format!("무제-{}", short_id(id))
    } else {
        sanitize_filename(t)
    }
}

/// 이 파일명이 여전히 그 제목에서 나온 것인지. 이름이 겹쳤을 때 붙는 id 접미사까지 인정한다.
///
/// 이 판단이 "앱의 제목"과 "사람이 바꾼 파일명" 중 무엇을 쓸지를 가른다. 파일명을 무조건
/// 신뢰하면 파일명에 못 쓰는 글자가 든 제목이 조용히 변형되고, frontmatter 를 무조건
/// 신뢰하면 Obsidian 에서 한 이름 바꾸기가 매번 되돌려진다.
fn matches_stem(title: &str, id: &str, stem: &str) -> bool {
    let base = base_stem(title, id);
    stem == base || stem == format!("{base}-{}", short_id(id))
}

/// 파일명과 frontmatter 이름을 놓고 최종 이름을 정한다.
fn resolve_name(front: Option<&String>, id: &str, stem: &str) -> String {
    match front {
        Some(t) if matches_stem(t, id, stem) => t.clone(),
        // frontmatter 에 이름이 없거나, 파일명이 그 이름에서 나온 것이 아니면
        // (= 사람이 파일명을 바꿨다) 파일명이 새 이름이다.
        _ => stem.to_string(),
    }
}

// ── 파싱 ────────────────────────────────────────────────────────────

/// frontmatter(`---` 로 감싼 `key: value` 들)와 본문을 나눈다.
/// YAML 은 쓰지 않는다 — 우리가 쓰는 키는 스칼라 몇 개뿐이라 의존성을 더할 이유가 없다.
fn split_frontmatter(text: &str) -> (Vec<(String, String)>, &str) {
    let rest = match text.strip_prefix("---\n") {
        Some(r) => r,
        // `---\r\n` 도 받아 준다(다른 편집기가 CRLF 로 저장한 경우).
        None => match text.strip_prefix("---\r\n") {
            Some(r) => r,
            None => return (Vec::new(), text),
        },
    };
    let mut keys = Vec::new();
    let mut consumed = 0usize;
    let mut closed = false;
    for line in rest.split_inclusive('\n') {
        consumed += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']);
        if trimmed == "---" {
            closed = true;
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            keys.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    if !closed {
        // 닫히지 않은 frontmatter 는 frontmatter 가 아니다.
        return (Vec::new(), text);
    }
    (keys, &rest[consumed..])
}

/// frontmatter 목록에서 키 하나를 찾는다.
fn key_of(keys: &[(String, String)], name: &str) -> Option<String> {
    keys.iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
}

/// 체크박스 목록 줄이면 (완료여부, 본문)을 준다.
/// `- [ ]` / `- [x]` / `* [X]` / `+ [ ]` 를 모두 받고 들여쓰기는 무시한다 — 사람이 손으로
/// 고치는 파일이라 엄격하게 굴면 조용히 항목을 잃는다.
fn parse_checkbox(line: &str) -> Option<(bool, String)> {
    let t = line.trim_start();
    let rest = t
        .strip_prefix("- ")
        .or_else(|| t.strip_prefix("* "))
        .or_else(|| t.strip_prefix("+ "))?;
    let rest = rest.trim_start();
    let inner = rest.strip_prefix('[')?;
    let mark = inner.chars().next()?;
    let after = inner.get(mark.len_utf8()..)?.strip_prefix(']')?;
    let done = match mark {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };
    Some((done, after.trim().to_string()))
}

/// 색 이름을 검증한다(모르는 값은 기본색으로).
fn valid_color(raw: Option<String>) -> String {
    match raw {
        Some(c) if COLORS.contains(&c.as_str()) => c,
        _ => FALLBACK_COLOR.to_string(),
    }
}

/// 본문에서 체크박스 항목만 모은다. 그 밖의 줄은 담을 곳이 없어 버려진다.
fn parse_todos(body: &str) -> Vec<TodoItem> {
    let mut out = Vec::new();
    for line in body.lines() {
        if let Some((done, text)) = parse_checkbox(line) {
            if out.len() < MAX_TODOS && !text.is_empty() {
                out.push(TodoItem { text, done });
            }
        }
    }
    out
}

/// 포스트잇 파일 하나를 읽는다. 카테고리 소속은 **파일의 위치**가 정하므로 밖에서 받는다.
fn parse_note_file(path: &Path, text: &str, category_id: &str) -> TodoNote {
    let (keys, body) = split_frontmatter(text);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let id = key_of(&keys, "id").unwrap_or_default();
    TodoNote {
        title: resolve_name(key_of(&keys, "title").as_ref(), &id, &stem),
        color: valid_color(key_of(&keys, "color")),
        category_id: category_id.to_string(),
        todos: parse_todos(body),
        // 휴지통 항목은 원래 카테고리를 스스로 들고 있어야 한다(폴더가 위치를 못 알려 준다).
        deleted_at: key_of(&keys, "deleted").and_then(|v| v.parse().ok()),
        id,
    }
}

/// frontmatter 의 `order:`(없으면 맨 뒤).
fn order_of(keys: &[(String, String)]) -> usize {
    key_of(keys, "order")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(usize::MAX)
}

// ── 직렬화 ──────────────────────────────────────────────────────────

/// 포스트잇 파일 하나의 전체 내용. 카테고리 id 는 **적지 않는다** — 위치가 정한다.
fn render_note(note: &TodoNote, order: usize) -> String {
    let mut front = format!(
        "---\n{MARKER}: 1\nid: {}\ntitle: {}\ncolor: {}\norder: {}\n",
        note.id,
        note.title.trim(),
        note.color,
        order
    );
    if let Some(at) = note.deleted_at {
        // 휴지통 항목만 원래 카테고리를 들고 있다(복원할 곳을 알아야 한다).
        front.push_str(&format!("category: {}\ndeleted: {at}\n", note.category_id));
    }
    front.push_str("---\n\n");
    for t in &note.todos {
        front.push_str(&format!("- [{}] {}\n", if t.done { "x" } else { " " }, t.text));
    }
    front
}

/// 카테고리 폴더가 자기 정보를 담는 숨은 파일의 내용.
fn render_category(cat: &TodoCategory, order: usize) -> String {
    format!(
        "---\n{MARKER}: 1\ncategory: 1\nid: {}\nname: {}\norder: {}\n---\n\n<!-- My Space 의 할 일 카테고리입니다. 이 폴더의 노트가 포스트잇이 됩니다. -->\n",
        cat.id, cat.name, order
    )
}

// ── 폴더 훑기 ───────────────────────────────────────────────────────

/// 우리 표식이 있는 마크다운 파일 하나를 읽는다(아니면 `None`).
fn read_ours(path: &Path) -> Option<(Vec<(String, String)>, String)> {
    let is_md = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false);
    if !is_md {
        return None;
    }
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(true) {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let (keys, _) = split_frontmatter(&text);
    if key_of(&keys, MARKER).is_none() {
        return None;
    }
    Some((keys, text))
}

/// 한 폴더 안에서 우리 표식이 있는 md 파일들을 모은다(하위 폴더는 보지 않는다).
fn ours_in(dir: &Path) -> Vec<(PathBuf, Vec<(String, String)>, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some((keys, text)) = read_ours(&path) {
            out.push((path, keys, text));
        }
    }
    // read_dir 순서는 보장되지 않으므로 고정한다.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// 파일들의 수정 시각·크기로 지문을 만든다. 폴링으로 변화를 감지하는 데 쓴다.
///
/// `notify` 크레이트를 쓰지 않는 이유: 훑는 범위가 루트와 카테고리 폴더 한 겹뿐이라
/// `read_dir` 이 무시할 만큼 싸고, 이 코드베이스의 다른 감시들도 모두 폴링이다
/// (herdr 800ms, gcal 5분). 의존성을 늘리지 않고 같은 관례를 따른다.
///
/// 폴더 이름도 넣는다 — 카테고리 이름 변경은 폴더 이름만 바뀌는 일이라 파일 mtime 만
/// 보면 놓친다.
fn signature(dir: &Path) -> String {
    fn stamp(path: &Path, parts: &mut Vec<String>, label: &str) {
        let Ok(meta) = std::fs::metadata(path) else { return };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        parts.push(format!("{label}:{mtime}:{}", meta.len()));
    }

    let mut parts: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return String::new();
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if path.is_dir() {
            parts.push(format!("d:{name}"));
            if let Ok(inner) = std::fs::read_dir(&path) {
                for e in inner.flatten() {
                    let p = e.path();
                    if p.is_file() {
                        let n = p
                            .file_name()
                            .map(|x| x.to_string_lossy().to_string())
                            .unwrap_or_default();
                        stamp(&p, &mut parts, &format!("{name}/{n}"));
                    }
                }
            }
        } else {
            stamp(&path, &mut parts, &name);
        }
    }
    parts.sort();
    parts.join("|")
}

/// 읽는 동안 모은 카테고리 하나.
struct ScannedCategory {
    order: usize,
    category: TodoCategory,
    notes: Vec<(usize, TodoNote)>,
}

/// 카테고리 폴더 하나를 읽는다. 우리 것으로 볼 근거가 없으면 `None`.
///
/// 근거는 두 가지다: `.myspace-category.md` 가 있거나, 표식이 있는 포스트잇 파일이 하나라도
/// 있는 것. 후자를 인정하는 이유는 사람이 Obsidian 에서 폴더를 만들어 노트를 옮겨 넣는 일이
/// 자연스럽기 때문이다(그때 카테고리 id 는 폴더명이 된다).
fn scan_category(dir: &Path) -> Option<ScannedCategory> {
    let stem = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let meta_path = dir.join(CATEGORY_FILE);
    let meta = read_ours(&meta_path);

    let mut notes: Vec<(usize, TodoNote)> = Vec::new();
    let mut files = Vec::new();
    for (path, keys, text) in ours_in(dir) {
        if path == meta_path {
            continue;
        }
        files.push((path, keys, text));
    }
    if meta.is_none() && files.is_empty() {
        return None;
    }

    let (order, id, name) = match &meta {
        Some((keys, _)) => {
            // **카테고리 id 는 비워서 넘기지 않는다** — 포스트잇의 소속이 이 값을 참조하므로
            // 사람이 만든 폴더 두 개가 나란히 빈 id 로 오면 구분할 수 없게 된다. 폴더명은
            // 그 자리에서 고유하고 안정적이라 임시 id 로 알맞고, 다음 저장에서 정착한다.
            let id = key_of(keys, "id")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| stem.clone());
            let name = resolve_name(key_of(keys, "name").as_ref(), &id, &stem);
            (order_of(keys), id, name)
        }
        None => (usize::MAX, stem.clone(), stem.clone()),
    };

    for (path, keys, text) in files {
        notes.push((order_of(&keys), parse_note_file(&path, &text, &id)));
    }
    // `order` 로 정렬하고, 같으면 제목으로(순서가 없는 파일을 사람이 만들었을 때 안정적으로).
    notes.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.title.cmp(&b.1.title)));

    Some(ScannedCategory {
        order,
        category: TodoCategory { id, name },
        notes,
    })
}

/// 첫 구현의 배치(카테고리 하나 = 루트의 파일 하나, 포스트잇 = `##` 헤딩)를 읽는다.
/// 다음 저장에서 새 배치로 옮겨지고 옛 파일은 정리된다.
fn scan_legacy_file(path: &Path, keys: &[(String, String)], text: &str) -> ScannedCategory {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let id = key_of(keys, "id")
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| stem.clone());
    let name = key_of(keys, "name")
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| stem.clone());
    let (_, body) = split_frontmatter(text);

    // 옛 형식의 포스트잇: `## 제목 <!-- id:… color:… -->` 뒤에 체크박스들.
    let mut notes: Vec<(usize, TodoNote)> = Vec::new();
    for line in body.lines() {
        if let Some(head) = line.strip_prefix("##").filter(|r| {
            r.is_empty() || r.starts_with(' ')
        }) {
            let (title, meta) = split_legacy_comment(head);
            let nid = key_of(&meta, "id").unwrap_or_default();
            notes.push((
                notes.len(),
                TodoNote {
                    id: nid,
                    title: title.trim().to_string(),
                    color: valid_color(key_of(&meta, "color")),
                    category_id: id.clone(),
                    todos: Vec::new(),
                    deleted_at: key_of(&meta, "deleted").and_then(|v| v.parse().ok()),
                },
            ));
            continue;
        }
        if let Some((done, text)) = parse_checkbox(line) {
            if let Some((_, note)) = notes.last_mut() {
                if note.todos.len() < MAX_TODOS && !text.is_empty() {
                    note.todos.push(TodoItem { text, done });
                }
            }
        }
    }

    ScannedCategory {
        order: order_of(keys),
        category: TodoCategory { id, name },
        notes,
    }
}

/// 옛 형식 헤딩의 `<!-- id:a1b2 color:yellow -->` 를 뜯는다.
fn split_legacy_comment(line: &str) -> (&str, Vec<(String, String)>) {
    let Some(open) = line.find("<!--") else {
        return (line, Vec::new());
    };
    let after = &line[open + 4..];
    let Some(close) = after.find("-->") else {
        return (line, Vec::new());
    };
    let pairs = after[..close]
        .split_whitespace()
        .filter_map(|tok| tok.split_once(':'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    (&line[..open], pairs)
}

// ── 명령 ────────────────────────────────────────────────────────────

/// 폴더를 읽어 보드 전체를 돌려준다. 폴더가 없으면 빈 스냅샷(오류가 아니다) —
/// 아직 한 번도 저장하지 않은 상태가 정상이다.
#[tauri::command]
pub fn todo_folder_read(folder: String) -> Result<TodoSnapshot, String> {
    let dir = expand_home(&folder);
    if !dir.is_dir() {
        return Ok(TodoSnapshot {
            categories: Vec::new(),
            notes: Vec::new(),
            trash: Vec::new(),
            signature: String::new(),
            populated: false,
        });
    }

    let mut scanned: Vec<ScannedCategory> = Vec::new();
    let mut trash: Vec<TodoNote> = Vec::new();
    let mut populated = false;

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        if path.is_dir() {
            if name == TRASH_DIR {
                for (p, keys, text) in ours_in(&path) {
                    populated = true;
                    let mut note = parse_note_file(&p, &text, "");
                    // 휴지통 항목의 원래 카테고리는 위치가 아니라 자기 frontmatter 에 있다.
                    note.category_id = key_of(&keys, "category").unwrap_or_default();
                    trash.push(note);
                }
                continue;
            }
            if let Some(cat) = scan_category(&path) {
                populated = true;
                scanned.push(cat);
            }
            continue;
        }

        // 루트에 남은 옛 배치의 파일.
        if name == LEGACY_TRASH_FILE {
            if let Some((_, text)) = read_ours(&path) {
                populated = true;
                let legacy = scan_legacy_file(&path, &[], &text);
                trash.extend(legacy.notes.into_iter().map(|(_, n)| n));
            }
            continue;
        }
        if let Some((keys, text)) = read_ours(&path) {
            populated = true;
            scanned.push(scan_legacy_file(&path, &keys, &text));
        }
    }

    // `order` 로 정렬하고, 같으면 이름으로.
    scanned.sort_by(|a, b| {
        a.order
            .cmp(&b.order)
            .then_with(|| a.category.name.cmp(&b.category.name))
    });

    let categories: Vec<TodoCategory> = scanned.iter().map(|s| s.category.clone()).collect();
    let notes: Vec<TodoNote> = scanned
        .into_iter()
        .flat_map(|s| s.notes.into_iter().map(|(_, n)| n))
        .collect();

    Ok(TodoSnapshot {
        categories,
        notes,
        trash,
        signature: signature(&dir),
        populated,
    })
}

/// 한 폴더에 포스트잇 파일들을 쓰고, 쓴 경로를 `written` 에 남긴다.
fn write_notes(
    dir: &Path,
    notes: &[&TodoNote],
    written: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    for (order, note) in notes.iter().enumerate() {
        let base = base_stem(&note.title, &note.id);
        let mut path = dir.join(format!("{base}.md"));
        if written.contains(&path) {
            // 제목이 겹치면 순번이 아니라 id 를 붙인다 — 순번은 순서를 바꿀 때마다 밀린다.
            path = dir.join(format!("{base}-{}.md", short_id(&note.id)));
        }
        std::fs::write(&path, render_note(note, order))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        written.insert(path);
    }
    Ok(())
}

/// 보드 전체를 폴더에 쓴다. 카테고리마다 폴더 하나, 포스트잇마다 파일 하나를 쓰고,
/// 사라진 것들의 파일은 지운다 — **우리 표식이 있는 파일만** 지우므로 볼트의 다른 노트는
/// 안전하다. 돌려주는 값은 쓴 직후의 지문이다(프론트엔드가 이걸 기억해 자기 변경을
/// 되읽지 않는다).
#[tauri::command]
pub fn todo_folder_write(
    folder: String,
    categories: Vec<TodoCategory>,
    notes: Vec<TodoNote>,
    trash: Vec<TodoNote>,
) -> Result<String, String> {
    if folder.trim().is_empty() {
        return Err("저장 폴더가 지정되지 않았습니다.".into());
    }
    let dir = expand_home(&folder);
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;

    // 쓰기 전에 우리 것이 어디에 있었는지 기록해 둔다(뒤에서 남은 것을 정리한다).
    let mut old_files: Vec<PathBuf> = Vec::new();
    let mut old_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let ours = ours_in(&path);
                if !ours.is_empty() {
                    old_dirs.push(path.clone());
                    old_files.extend(ours.into_iter().map(|(p, _, _)| p));
                }
            } else if read_ours(&path).is_some() {
                old_files.push(path);
            }
        }
    }

    let mut written: HashSet<PathBuf> = HashSet::new();
    let mut used_dirs: HashSet<PathBuf> = HashSet::new();

    for (order, cat) in categories.iter().enumerate() {
        let base = base_stem(&cat.name, &cat.id);
        let mut path = dir.join(&base);
        if used_dirs.contains(&path) {
            path = dir.join(format!("{base}-{}", short_id(&cat.id)));
        }
        std::fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        used_dirs.insert(path.clone());

        let meta_path = path.join(CATEGORY_FILE);
        std::fs::write(&meta_path, render_category(cat, order))
            .map_err(|e| format!("{}: {e}", meta_path.display()))?;
        written.insert(meta_path);

        let mine: Vec<&TodoNote> = notes.iter().filter(|n| n.category_id == cat.id).collect();
        write_notes(&path, &mine, &mut written)?;
    }

    let trash_dir = dir.join(TRASH_DIR);
    if trash.is_empty() {
        // 빈 휴지통 폴더를 남겨 두면 볼트에 쓸모없는 폴더가 쌓인다.
        if trash_dir.is_dir() {
            for (p, _, _) in ours_in(&trash_dir) {
                std::fs::remove_file(&p).ok();
            }
            std::fs::remove_dir(&trash_dir).ok();
        }
    } else {
        std::fs::create_dir_all(&trash_dir)
            .map_err(|e| format!("{}: {e}", trash_dir.display()))?;
        used_dirs.insert(trash_dir.clone());
        let refs: Vec<&TodoNote> = trash.iter().collect();
        write_notes(&trash_dir, &refs, &mut written)?;
    }

    // 더는 쓰이지 않는 우리 파일을 지운다(카테고리·포스트잇 삭제, 이름 변경, 옛 배치 이관).
    for old in old_files {
        if !written.contains(&old) {
            std::fs::remove_file(&old).ok();
        }
    }
    // 비게 된 카테고리 폴더도 치운다. `remove_dir` 는 폴더가 비었을 때만 성공하므로
    // 사람이 넣어 둔 다른 노트가 남아 있으면 폴더는 그대로 남는다 — 그것이 맞다.
    for old in old_dirs {
        if !used_dirs.contains(&old) {
            std::fs::remove_dir(&old).ok();
        }
    }

    Ok(signature(&dir))
}

/// 폴더의 지문만 싸게 확인한다(폴링용 — 내용을 파싱하지 않는다).
#[tauri::command]
pub fn todo_folder_signature(folder: String) -> Result<String, String> {
    let dir = expand_home(&folder);
    if !dir.is_dir() {
        return Ok(String::new());
    }
    Ok(signature(&dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("myspace-todo-{name}"));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn note(id: &str, title: &str, cat: &str, todos: &[(&str, bool)]) -> TodoNote {
        TodoNote {
            id: id.into(),
            title: title.into(),
            color: "yellow".into(),
            category_id: cat.into(),
            todos: todos
                .iter()
                .map(|(t, d)| TodoItem { text: (*t).into(), done: *d })
                .collect(),
            deleted_at: None,
        }
    }

    fn cat(id: &str, name: &str) -> TodoCategory {
        TodoCategory { id: id.into(), name: name.into() }
    }

    #[test]
    fn parses_checkbox_forms() {
        assert_eq!(parse_checkbox("- [ ] 할 일"), Some((false, "할 일".into())));
        assert_eq!(parse_checkbox("- [x] 완료"), Some((true, "완료".into())));
        assert_eq!(parse_checkbox("* [X] 별표"), Some((true, "별표".into())));
        assert_eq!(parse_checkbox("   - [ ] 들여쓰기"), Some((false, "들여쓰기".into())));
        assert_eq!(parse_checkbox("- 그냥 목록"), None);
        assert_eq!(parse_checkbox("본문"), None);
        assert_eq!(parse_checkbox("- [?] 알 수 없는 표시"), None);
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("a/b:c"), "a_b_c");
        assert_eq!(sanitize_filename("  ..hidden  "), "hidden");
        assert_eq!(sanitize_filename(""), "무제");
        assert_eq!(sanitize_filename("   "), "무제");
        // 한글이 잘려도 UTF-8 경계를 깨지 않는다.
        assert!(sanitize_filename(&"가".repeat(100)).chars().count() <= 60);
    }

    #[test]
    fn empty_title_uses_id_not_a_running_number() {
        // 새로 만든 포스트잇은 제목이 비어 있는 게 정상이다. 순번을 쓰면 순서를 바꿀 때마다
        // 파일명이 밀려 전부 지워지고 다시 생긴다.
        assert_eq!(base_stem("", "a1b2c3d4e5"), "무제-a1b2c3d4");
        assert_eq!(base_stem("제목", "a1b2c3d4e5"), "제목");
    }

    #[test]
    fn resolves_name_between_file_and_frontmatter() {
        // 파일명이 그 제목에서 나온 것이면 제목이 이긴다(파일명에 못 쓰는 글자 보존).
        assert_eq!(resolve_name(Some(&"a/b".to_string()), "id1", "a_b"), "a/b");
        // 사람이 파일명을 바꿨으면 그것이 새 제목이다.
        assert_eq!(
            resolve_name(Some(&"옛 제목".to_string()), "id1", "새 제목"),
            "새 제목"
        );
        // frontmatter 에 이름이 없으면 파일명.
        assert_eq!(resolve_name(None, "id1", "파일명"), "파일명");
        // 이름이 겹쳐 id 접미사가 붙은 경우도 그 제목에서 나온 것으로 인정한다.
        assert_eq!(
            resolve_name(Some(&"제목".to_string()), "a1b2c3d4e5", "제목-a1b2c3d4"),
            "제목"
        );
        // 빈 제목 + id 파일명.
        assert_eq!(resolve_name(Some(&String::new()), "a1b2c3d4e5", "무제-a1b2c3d4"), "");
    }

    #[test]
    fn writes_a_folder_per_category_and_a_file_per_note() {
        let dir = tmp("layout");
        let folder = dir.to_string_lossy().to_string();
        let sig = todo_folder_write(
            folder.clone(),
            vec![cat("c1", "릴리스"), cat("c2", "문서")],
            vec![
                note("n1", "릴리스 준비", "c1", &[("버전 올리기", true), ("확인", false)]),
                note("n2", "회고", "c1", &[("정리", false)]),
                note("n3", "문서 정리", "c2", &[("CLAUDE.md", false)]),
            ],
            vec![],
        )
        .unwrap();
        assert!(!sig.is_empty());

        // 카테고리는 폴더, 포스트잇은 그 안의 파일.
        assert!(dir.join("릴리스").is_dir());
        assert!(dir.join("릴리스").join(CATEGORY_FILE).is_file());
        assert!(dir.join("릴리스/릴리스 준비.md").is_file());
        assert!(dir.join("릴리스/회고.md").is_file());
        assert!(dir.join("문서/문서 정리.md").is_file());

        // 본문은 체크박스만, 카테고리 id 는 파일에 적히지 않는다(위치가 정한다).
        let text = std::fs::read_to_string(dir.join("릴리스/릴리스 준비.md")).unwrap();
        assert!(text.contains("- [x] 버전 올리기"), "{text}");
        assert!(text.contains("title: 릴리스 준비"), "{text}");
        assert!(!text.contains("c1"), "카테고리 id 가 파일에 새어 나왔다: {text}");

        let snap = todo_folder_read(folder).unwrap();
        assert!(snap.populated);
        assert_eq!(
            snap.categories.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["릴리스", "문서"]
        );
        assert_eq!(snap.notes.len(), 3);
        // 카테고리 안 순서(order)가 보존된다.
        assert_eq!(snap.notes[0].title, "릴리스 준비");
        assert_eq!(snap.notes[0].category_id, "c1");
        assert_eq!(snap.notes[1].title, "회고");
        assert_eq!(snap.notes[2].category_id, "c2");
        assert!(snap.notes[0].todos[0].done);
        assert_eq!(snap.signature, sig);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn moving_a_file_between_folders_changes_its_category() {
        // Obsidian 에서 노트를 다른 폴더로 끄는 것이 카테고리 이동이 되어야 한다.
        let dir = tmp("move");
        let folder = dir.to_string_lossy().to_string();
        todo_folder_write(
            folder.clone(),
            vec![cat("c1", "가"), cat("c2", "나")],
            vec![note("n1", "옮길 것", "c1", &[("항목", false)])],
            vec![],
        )
        .unwrap();

        std::fs::rename(dir.join("가/옮길 것.md"), dir.join("나/옮길 것.md")).unwrap();

        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.notes.len(), 1);
        assert_eq!(snap.notes[0].category_id, "c2");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renaming_a_file_renames_the_note() {
        let dir = tmp("filerename");
        let folder = dir.to_string_lossy().to_string();
        todo_folder_write(
            folder.clone(),
            vec![cat("c1", "가")],
            vec![note("n1", "옛 제목", "c1", &[("항목", false)])],
            vec![],
        )
        .unwrap();

        std::fs::rename(dir.join("가/옛 제목.md"), dir.join("가/손으로 바꾼 제목.md")).unwrap();

        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.notes[0].title, "손으로 바꾼 제목");
        // id 는 유지되므로 같은 포스트잇이다.
        assert_eq!(snap.notes[0].id, "n1");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn renaming_a_category_moves_its_folder() {
        let dir = tmp("catrename");
        let folder = dir.to_string_lossy().to_string();
        let notes = vec![note("n1", "제목", "c1", &[("항목", false)])];
        todo_folder_write(folder.clone(), vec![cat("c1", "옛 이름")], notes.clone(), vec![])
            .unwrap();
        todo_folder_write(folder.clone(), vec![cat("c1", "새 이름")], notes, vec![]).unwrap();

        assert!(!dir.join("옛 이름").exists());
        assert!(dir.join("새 이름/제목.md").is_file());
        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.categories.len(), 1);
        assert_eq!(snap.categories[0].id, "c1");
        assert_eq!(snap.categories[0].name, "새 이름");
        assert_eq!(snap.notes.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn never_touches_files_without_our_marker() {
        let dir = tmp("foreign");
        let folder = dir.to_string_lossy().to_string();
        // 볼트에 이미 있던 남의 노트(루트와 카테고리 폴더 안 양쪽).
        let root_note = dir.join("남의 노트.md");
        std::fs::write(&root_note, "# 내 일기\n\n- [ ] 지우면 안 되는 항목\n").unwrap();
        todo_folder_write(
            folder.clone(),
            vec![cat("c1", "할 일")],
            vec![note("n1", "제목", "c1", &[("항목", false)])],
            vec![],
        )
        .unwrap();
        let inside = dir.join("할 일/남의 메모.md");
        std::fs::write(&inside, "그냥 메모\n").unwrap();

        // 카테고리를 지워도 남의 파일이 있으면 폴더는 남는다.
        todo_folder_write(folder.clone(), vec![], vec![], vec![]).unwrap();
        assert!(root_note.exists());
        assert!(inside.exists());
        assert!(dir.join("할 일").is_dir());
        assert!(!dir.join("할 일/제목.md").exists());
        assert!(!dir.join("할 일").join(CATEGORY_FILE).exists());

        // 표식이 없으므로 읽히지도 않는다.
        let snap = todo_folder_read(folder).unwrap();
        assert!(snap.categories.is_empty());
        assert!(snap.notes.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn removes_folders_of_deleted_categories() {
        let dir = tmp("cleanup");
        let folder = dir.to_string_lossy().to_string();
        todo_folder_write(folder.clone(), vec![cat("c1", "가"), cat("c2", "나")], vec![], vec![])
            .unwrap();
        assert!(dir.join("가").is_dir());
        assert!(dir.join("나").is_dir());

        todo_folder_write(folder.clone(), vec![cat("c1", "가")], vec![], vec![]).unwrap();
        assert!(dir.join("가").is_dir());
        assert!(!dir.join("나").exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trash_lives_in_a_hidden_folder_and_keeps_its_category() {
        let dir = tmp("trash");
        let folder = dir.to_string_lossy().to_string();
        let mut gone = note("n9", "지운 것", "c1", &[("옛 항목", true)]);
        gone.deleted_at = Some(1_780_000_000_000);
        todo_folder_write(folder.clone(), vec![cat("c1", "가")], vec![], vec![gone]).unwrap();

        assert!(dir.join(TRASH_DIR).join("지운 것.md").is_file());
        let snap = todo_folder_read(folder.clone()).unwrap();
        assert_eq!(snap.trash.len(), 1);
        assert_eq!(snap.trash[0].category_id, "c1");
        assert_eq!(snap.trash[0].deleted_at, Some(1_780_000_000_000));
        assert!(snap.trash[0].todos[0].done);
        // 휴지통 항목이 포스트잇 목록에 섞이지 않는다.
        assert!(snap.notes.is_empty());

        // 비우면 폴더까지 사라진다.
        todo_folder_write(folder, vec![cat("c1", "가")], vec![], vec![]).unwrap();
        assert!(!dir.join(TRASH_DIR).exists());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn duplicate_titles_get_id_suffixes() {
        let dir = tmp("dup");
        let folder = dir.to_string_lossy().to_string();
        todo_folder_write(
            folder.clone(),
            vec![cat("c1", "가")],
            vec![
                note("aaaaaaaa11", "같은 제목", "c1", &[("첫째", false)]),
                note("bbbbbbbb22", "같은 제목", "c1", &[("둘째", false)]),
            ],
            vec![],
        )
        .unwrap();

        assert!(dir.join("가/같은 제목.md").is_file());
        assert!(dir.join("가/같은 제목-bbbbbbbb.md").is_file());
        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.notes.len(), 2);
        // 두 포스트잇 모두 제목이 보존된다(파일명 접미사가 제목에 새지 않는다).
        assert!(snap.notes.iter().all(|n| n.title == "같은 제목"), "{:?}", snap.notes);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn empty_titles_survive_reordering() {
        // 제목 없는 포스트잇 두 개의 순서를 바꿔도 파일명이 그대로여서 파일이 재생성되지 않는다.
        let dir = tmp("reorder");
        let folder = dir.to_string_lossy().to_string();
        let a = note("aaaaaaaa11", "", "c1", &[("첫째", false)]);
        let b = note("bbbbbbbb22", "", "c1", &[("둘째", false)]);
        todo_folder_write(
            folder.clone(),
            vec![cat("c1", "가")],
            vec![a.clone(), b.clone()],
            vec![],
        )
        .unwrap();
        assert!(dir.join("가/무제-aaaaaaaa.md").is_file());
        assert!(dir.join("가/무제-bbbbbbbb.md").is_file());

        todo_folder_write(folder.clone(), vec![cat("c1", "가")], vec![b, a], vec![]).unwrap();
        assert!(dir.join("가/무제-aaaaaaaa.md").is_file());
        assert!(dir.join("가/무제-bbbbbbbb.md").is_file());

        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.notes.len(), 2);
        assert!(snap.notes.iter().all(|n| n.title.is_empty()));
        // 바뀐 순서가 반영된다.
        assert_eq!(snap.notes[0].id, "bbbbbbbb22");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hand_made_folder_gets_its_name_as_category_id() {
        // 사람이 Obsidian 에서 폴더를 만들고 노트를 넣은 경우 — `.myspace-category.md` 가 없다.
        let dir = tmp("handmade");
        let folder = dir.to_string_lossy().to_string();
        for (folder_name, note_name) in [("장보기", "마트"), ("독서", "이번 달")] {
            std::fs::create_dir_all(dir.join(folder_name)).unwrap();
            std::fs::write(
                dir.join(folder_name).join(format!("{note_name}.md")),
                format!("---\n{MARKER}: 1\n---\n\n- [ ] 항목\n"),
            )
            .unwrap();
        }

        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.categories.len(), 2);
        // id 가 폴더명으로 채워지고 서로 다르다.
        let ids: Vec<&str> = snap.categories.iter().map(|c| c.id.as_str()).collect();
        assert!(ids.contains(&"장보기") && ids.contains(&"독서"), "{ids:?}");
        for note in &snap.notes {
            assert!(!note.category_id.is_empty());
        }
        let shopping: Vec<&TodoNote> =
            snap.notes.iter().filter(|n| n.category_id == "장보기").collect();
        assert_eq!(shopping.len(), 1);
        assert_eq!(shopping[0].title, "마트");
        // 제목·id 가 없는 파일이라 id 는 프론트엔드가 채운다.
        assert_eq!(shopping[0].id, "");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrates_the_first_layout_where_a_category_was_one_file() {
        let dir = tmp("legacy");
        let folder = dir.to_string_lossy().to_string();
        // 첫 구현이 남긴 파일들.
        std::fs::write(
            dir.join("릴리스.md"),
            format!(
                "---\n{MARKER}: 1\nid: c1\nname: 릴리스\norder: 0\n---\n\n\
                 ## 릴리스 준비 <!-- id:n1 color:pink -->\n\n- [x] 버전 올리기\n- [ ] 확인\n\n\
                 ## <!-- id:n2 color:blue -->\n\n- [ ] 제목 없는 포스트잇\n"
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join(LEGACY_TRASH_FILE),
            format!(
                "---\n{MARKER}: 1\ntrash: 1\n---\n\n\
                 ## 지운 것 <!-- id:n9 color:gray category:c1 deleted:1780000000000 -->\n- [ ] 옛 항목\n"
            ),
        )
        .unwrap();

        // 읽기: 옛 배치가 그대로 이해된다.
        let snap = todo_folder_read(folder.clone()).unwrap();
        assert_eq!(snap.categories.len(), 1);
        assert_eq!(snap.categories[0].name, "릴리스");
        assert_eq!(snap.notes.len(), 2);
        assert_eq!(snap.notes[0].title, "릴리스 준비");
        assert_eq!(snap.notes[0].color, "pink");
        assert!(snap.notes[0].todos[0].done);
        assert_eq!(snap.notes[1].title, "");
        assert_eq!(snap.trash.len(), 1);
        assert_eq!(snap.trash[0].deleted_at, Some(1_780_000_000_000));

        // 쓰기: 새 배치로 옮겨지고 옛 파일은 정리된다.
        todo_folder_write(folder.clone(), snap.categories, snap.notes, snap.trash).unwrap();
        assert!(!dir.join("릴리스.md").exists());
        assert!(!dir.join(LEGACY_TRASH_FILE).exists());
        assert!(dir.join("릴리스/릴리스 준비.md").is_file());
        assert!(dir.join("릴리스/무제-n2.md").is_file());
        assert!(dir.join(TRASH_DIR).join("지운 것.md").is_file());

        // 옮긴 뒤에도 내용이 같다.
        let after = todo_folder_read(folder).unwrap();
        assert_eq!(after.categories.len(), 1);
        assert_eq!(after.notes.len(), 2);
        assert_eq!(after.notes[0].title, "릴리스 준비");
        assert_eq!(after.notes[0].color, "pink");
        assert_eq!(after.trash.len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_folder_reads_as_empty_not_error() {
        let snap = todo_folder_read("/nonexistent/myspace-todo-xyz".into()).unwrap();
        assert!(!snap.populated);
        assert!(snap.categories.is_empty());
        assert!(snap.signature.is_empty());
    }

    #[test]
    fn signature_changes_on_edit_and_on_category_rename() {
        let dir = tmp("sig");
        let folder = dir.to_string_lossy().to_string();
        let notes = vec![note("n1", "제목", "c1", &[("항목", false)])];
        todo_folder_write(folder.clone(), vec![cat("c1", "가")], notes.clone(), vec![]).unwrap();

        // 외부(Obsidian)에서 체크박스를 눌렀다.
        let before = todo_folder_signature(folder.clone()).unwrap();
        let p = dir.join("가/제목.md");
        let text = std::fs::read_to_string(&p).unwrap().replace("- [ ]", "- [x]");
        std::fs::write(&p, text).unwrap();
        let after = todo_folder_signature(folder.clone()).unwrap();
        assert_ne!(before, after);
        assert!(todo_folder_read(folder.clone()).unwrap().notes[0].todos[0].done);

        // 폴더 이름만 바뀌어도(카테고리 이름 변경) 감지되어야 한다 — 파일 mtime 은 그대로다.
        std::fs::rename(dir.join("가"), dir.join("다")).unwrap();
        assert_ne!(after, todo_folder_signature(folder).unwrap());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn frontmatter_without_closing_marker_is_not_frontmatter() {
        let (keys, body) = split_frontmatter("---\nmyspace-todo: 1\n- [ ] 항목\n");
        assert!(keys.is_empty());
        assert!(body.starts_with("---"));
    }

    #[test]
    fn unknown_color_falls_back() {
        let dir = tmp("color");
        let folder = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join("가")).unwrap();
        std::fs::write(
            dir.join("가/x.md"),
            format!("---\n{MARKER}: 1\nid: n1\ntitle: x\ncolor: neon\n---\n\n- [ ] a\n"),
        )
        .unwrap();
        let snap = todo_folder_read(folder).unwrap();
        assert_eq!(snap.notes[0].color, FALLBACK_COLOR);
        std::fs::remove_dir_all(&dir).ok();
    }
}
