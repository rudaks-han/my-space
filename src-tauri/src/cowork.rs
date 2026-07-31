//! Cowork spec 문서 — cowork 홈 디렉터리의 `.cowork/specs` 아래에 있는 스펙 문서(md)를
//! 목록으로 훑고, 개별 파일 내용을 읽어 마크다운 뷰어에 넘긴다.
//!
//! 저장·편집은 하지 않는다(읽기 전용). 파일 IO 는 Rust 가 직접 하고(std::fs),
//! 프론트엔드는 목록·본문·스타일(css)만 받아 화면에 그린다.
//!
//! 기본 스타일은 프론트엔드에 번들돼 있다(`src/assets/typora/rudaks.css`, 뷰어가
//! 섀도 DOM 에 주입) — Typora 가 깔려 있지 않은 사람도 첫 실행부터 같은 화면을 본다.
//! 여기의 `cowork_read_css` 는 그걸 **덮어쓰고 싶을 때만** 쓰이는 통로로, 사용자의
//! Typora 테마 css(예: `~/Library/Application Support/abnerworks.Typora/themes/
//! rudaks.css`)를 읽어 설정에 저장한다.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// 스펙 폴더 안의 문서 파일 하나.
#[derive(Serialize)]
pub struct SpecFile {
    /// 파일명(확장자 포함).
    pub name: String,
    /// 절대 경로(본문을 읽을 때 그대로 되돌려 준다).
    pub path: String,
    /// 스펙 폴더 기준 상대 경로(하위 폴더의 파일을 구분해 보여 주기 위함).
    pub rel: String,
}

/// `.cowork/specs` 아래의 스펙 폴더 하나(예: `COWORK-1274`).
#[derive(Serialize)]
pub struct SpecDir {
    /// 폴더명.
    pub name: String,
    /// 절대 경로.
    pub path: String,
    /// 폴더 안의 마크다운 문서들.
    pub files: Vec<SpecFile>,
}

/// `~` 를 HOME 으로 펼친다.
fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    if path == "~" {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home);
        }
    }
    PathBuf::from(path)
}

/// 마크다운으로 볼 수 있는 텍스트 문서인지.
fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("md") | Some("markdown") | Some("mdx")
    )
}

/// 한 스펙 폴더를 재귀로 훑어 마크다운 파일을 모은다(하위 폴더 포함).
fn collect_files(root: &Path, dir: &Path, out: &mut Vec<SpecFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        // 숨김 파일·폴더는 건너뛴다(.claude, .DS_Store 등).
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            collect_files(root, &p, out);
        } else if is_markdown(&p) {
            let rel = p
                .strip_prefix(root)
                .unwrap_or(&p)
                .to_string_lossy()
                .to_string();
            out.push(SpecFile {
                name,
                path: p.to_string_lossy().to_string(),
                rel,
            });
        }
    }
}

/// cowork 홈(`home`) 아래 `.cowork/specs` 의 스펙 폴더와 각 폴더의 마크다운 문서를 훑는다.
///
/// 폴더는 이름 내림차순(예: COWORK-1897 이 위로 — 최근 번호가 먼저 보이도록),
/// 파일은 이름 오름차순으로 정렬한다.
#[tauri::command]
pub fn cowork_list_specs(home: String) -> Result<Vec<SpecDir>, String> {
    let specs = expand_home(&home).join(".cowork").join("specs");
    if !specs.is_dir() {
        return Err(format!(
            "스펙 폴더를 찾을 수 없습니다: {}",
            specs.to_string_lossy()
        ));
    }

    let mut dirs: Vec<SpecDir> = Vec::new();
    let entries = std::fs::read_dir(&specs).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !p.is_dir() || name.starts_with('.') {
            continue;
        }
        let mut files = Vec::new();
        collect_files(&p, &p, &mut files);
        if files.is_empty() {
            continue;
        }
        files.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        dirs.push(SpecDir {
            name,
            path: p.to_string_lossy().to_string(),
            files,
        });
    }
    dirs.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()));
    Ok(dirs)
}

/// 스펙 문서 한 개의 본문을 읽는다.
///
/// 아무 경로나 읽지 않도록, 반드시 어떤 `.cowork/specs` 아래에 있는 마크다운 파일이어야
/// 한다(경로 정규화 후 확인). 스펙 폴더는 여러 프로젝트에 있을 수 있어 홈은 고정하지 않고,
/// 경로에 `/.cowork/specs/` 가 들어 있는지로만 판정한다.
#[tauri::command]
pub fn cowork_read_spec_file(path: String) -> Result<String, String> {
    let p = expand_home(&path);
    let canon = p.canonicalize().map_err(|e| e.to_string())?;
    if !is_markdown(&canon) {
        return Err("마크다운(.md) 파일만 열 수 있습니다.".into());
    }
    let s = canon.to_string_lossy().replace('\\', "/");
    if !s.contains("/.cowork/specs/") {
        return Err("`.cowork/specs` 아래의 문서만 열 수 있습니다.".into());
    }
    std::fs::read_to_string(&canon).map_err(|e| e.to_string())
}

/// 본문 검색 결과 한 건.
#[derive(Serialize)]
pub struct SearchHit {
    /// 일치한 파일의 절대 경로.
    pub path: String,
    /// 처음 일치한 줄(앞뒤 공백 제거 후 최대 160자) — 목록에 미리보기로 보여 준다.
    pub snippet: String,
    /// 문서 안에서 검색어가 나온 총 횟수.
    pub count: usize,
}

/// `.cowork/specs` 아래 모든 마크다운 문서의 **본문**에서 `query` 를 찾는다(대소문자 무시).
/// 파일명이 아니라 내용 검색이며, 일치한 파일마다 첫 일치 줄과 횟수를 돌려준다.
#[tauri::command]
pub fn cowork_search_specs(home: String, query: String) -> Result<Vec<SearchHit>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let specs = expand_home(&home).join(".cowork").join("specs");
    if !specs.is_dir() {
        return Err(format!(
            "스펙 폴더를 찾을 수 없습니다: {}",
            specs.to_string_lossy()
        ));
    }

    let mut hits: Vec<SearchHit> = Vec::new();
    let entries = std::fs::read_dir(&specs).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !p.is_dir() || name.starts_with('.') {
            continue;
        }
        let mut files = Vec::new();
        collect_files(&p, &p, &mut files);
        for f in files {
            let Ok(content) = std::fs::read_to_string(&f.path) else {
                continue;
            };
            let lower = content.to_lowercase();
            if !lower.contains(&q) {
                continue;
            }
            let count = lower.matches(&q).count();
            // 줄 단위로 찾아 바이트 경계 문제 없이 안전하게 미리보기를 만든다(한글 포함).
            let snippet = content
                .lines()
                .find(|line| line.to_lowercase().contains(&q))
                .unwrap_or("")
                .trim()
                .chars()
                .take(160)
                .collect::<String>();
            hits.push(SearchHit {
                path: f.path,
                snippet,
                count,
            });
        }
    }
    Ok(hits)
}

/// Typora 테마 css 파일 내용을 읽어 온다(설정에서 "스타일 가져오기" 버튼이 호출).
/// `~` 는 HOME 으로 펼친다.
#[tauri::command]
pub fn cowork_read_css(path: String) -> Result<String, String> {
    let p = expand_home(&path);
    if p.extension().and_then(|e| e.to_str()) != Some("css") {
        return Err("css 파일만 가져올 수 있습니다.".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}
