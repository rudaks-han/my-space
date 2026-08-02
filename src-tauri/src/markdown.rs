//! 마크다운 뷰어 — 임의 위치의 마크다운 파일 한 개를 읽어 프론트엔드에 넘긴다.
//!
//! `cowork.rs` 의 `cowork_read_spec_file` 과 나누어 둔 이유: 저쪽은 `.cowork/specs`
//! 아래만 읽도록 경로를 가두는 게 목적이라, 사용자가 직접 고른 파일에는 쓸 수 없다.
//! 여기서는 반대로 "사용자가 파일 선택 창이나 드래그로 지목한 파일"만 오므로 경로는
//! 제한하지 않고, 대신 **확장자와 크기**로 막는다(바이너리를 통째로 문자열로 읽어
//! 화면에 쏟아 붓지 않도록).
//!
//! 렌더링은 전부 프론트엔드 몫이다 — Cowork Spec 문서와 같은 파서·Typora css 를 그대로
//! 쓰기 위해서(`src/features/cowork-spec/markdown.ts`, `markdown-viewer.tsx`).

use serde::Serialize;
use std::path::Path;

use crate::cowork::expand_home;

/// 한 번에 읽어 들일 수 있는 최대 크기(8MB). 이보다 큰 문서는 마크다운이 아니라고 본다 —
/// 브라우저에 통째로 렌더링하면 어차피 멈춘다.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 열 수 있는 확장자. `.txt` 까지 받는 이유는 릴리스 노트·README 사본처럼 확장자만
/// 다른 마크다운이 흔하기 때문이다.
const EXTS: [&str; 6] = ["md", "markdown", "mdx", "mdown", "mkd", "txt"];

/// 읽어 온 문서 하나.
#[derive(Debug, Serialize)]
pub struct MarkdownFile {
    /// 파일명(확장자 포함) — 뷰 제목에 쓴다.
    pub name: String,
    /// 절대 경로(다시 읽기에 그대로 되돌려 준다).
    pub path: String,
    /// 본문.
    pub text: String,
}

/// 마크다운으로 열어 볼 수 있는 확장자인지.
fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| EXTS.contains(&e.as_str()))
}

/// 마크다운 파일 하나를 읽는다.
#[tauri::command]
pub fn markdown_read_file(path: String) -> Result<MarkdownFile, String> {
    let canon = expand_home(&path).canonicalize().map_err(|e| e.to_string())?;
    if !canon.is_file() {
        return Err("파일이 아닙니다.".into());
    }
    if !is_markdown(&canon) {
        return Err(format!(
            "마크다운 파일만 열 수 있습니다({}).",
            EXTS.iter()
                .map(|e| format!(".{e}"))
                .collect::<Vec<_>>()
                .join(" · ")
        ));
    }
    let size = canon.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err(format!(
            "파일이 너무 큽니다({:.1}MB). {}MB 까지 열 수 있습니다.",
            size as f64 / (1024.0 * 1024.0),
            MAX_BYTES / (1024 * 1024)
        ));
    }
    let text = std::fs::read_to_string(&canon).map_err(|e| e.to_string())?;
    Ok(MarkdownFile {
        name: canon
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| canon.to_string_lossy().to_string()),
        path: canon.to_string_lossy().to_string(),
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_markdown_extensions_only() {
        assert!(is_markdown(Path::new("/a/b/README.md")));
        assert!(is_markdown(Path::new("/a/b/spec.MARKDOWN")));
        assert!(is_markdown(Path::new("/a/b/notes.txt")));
        assert!(!is_markdown(Path::new("/a/b/photo.png")));
        assert!(!is_markdown(Path::new("/a/b/noext")));
    }

    #[test]
    fn rejects_non_markdown_file() {
        let dir = std::env::temp_dir().join("myspace-md-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.png");
        std::fs::write(&p, b"not markdown").unwrap();
        let err = markdown_read_file(p.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("마크다운"), "{err}");
        std::fs::remove_file(&p).ok();
    }
}
