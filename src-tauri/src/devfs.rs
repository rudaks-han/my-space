//! IntelliJ Cowork 콘솔의 **일반 파일 백엔드** — 한 단계 목록·읽기·쓰기, 그리고 트리
//! 우클릭의 파일 조작(새로 만들기·이름 바꾸기·삭제·복사/이동).
//!
//! 왜 `http_file.rs` 를 쓰지 않는가: 그쪽 `resolve_http_path` 는 `.http`/`.rest` 가
//! 아니면 아예 거절하고 `http_write_file` 은 없는 파일에 쓰지 않는다. 개발 콘솔은
//! `.java`·`.yml`·`.sql`·`.md` 를 열고 새로 만들기까지 해야 하므로 관문이 다르다.
//! 대신 그쪽과 같은 판단은 그대로 가져왔다 — 산출물 폴더 건너뛰기, `expand_home`,
//! `#[serde(rename_all = "camelCase")]`, 오류는 사람이 읽을 한국어 문자열.
//!
//! **목록은 한 겹만 훑는다.** cowork 저장소는 크고, 이 화면은 IntelliJ 를 켜지 않으려고
//! 있는 것이라 마운트할 때마다 전체를 재귀 탐색하면 절약하려던 비용을 그대로 낸다.
//! 트리는 펼칠 때 그 폴더만 물어본다.
//!
//! **`root` 가 세 커맨드 모두의 인자인 이유는 보안 하나다.** 웹뷰가 주는 경로를 그대로
//! 열면 `../../../.ssh/id_rsa` 가 읽히고 쓰인다. `resolve_in_root` 가 루트와 대상을
//! 각각 canonicalize 해서 루트 밖으로 나가는 경로를 전부 거절한다(심볼릭 링크로
//! 빠져나가는 것도 canonicalize 가 같이 막는다).
//!
//! 모든 커맨드는 `async` + `spawn_blocking` 이다(`git.rs` 와 같은 이유). 동기 커맨드는
//! 메인 스레드에서 도는데, 느린 디스크나 네트워크 볼륨이면 그동안 창이 멈춘다.
//!
//! **파괴적 동작의 규칙 셋.** (1) 삭제는 **먼저 휴지통으로 옮긴다** — IntelliJ 는 로컬
//! 히스토리가 있어 영구 삭제해도 되돌릴 수 있지만 이 화면에는 그런 것이 없다. `~/.Trash`
//! 로의 이동이 실패하면(다른 볼륨, 휴지통이 없음) 영구 삭제로 내려가고 **어느 쪽이었는지
//! 돌려준다** — 사용자가 시킨 일을 못 하는 것보다 낫고, 어디로 갔는지는 알려야 한다.
//! (2) 덮어쓰기는 하지 않는다: 이름 바꾸기와 이동은 같은 이름이 있으면 거절하고, 붙여넣기만
//! 파인더처럼 `사본` 이름을 새로 만든다(그쪽은 "덮어쓸 뜻이 없다"가 명백하다).
//! (3) 폴더를 자기 안으로 옮기거나 복사하는 것은 거절한다 — 무한 재귀가 되거나 원본이
//! 사라진다.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::cowork::expand_home;

/// 트리에서 아예 보여 주지 않는 폴더 이름.
///
/// 전부 생성물이거나 거대하다. 특히 `target` 은 Maven 이 `src/test/resources` 를
/// 통째로 복사해 두는 자리라(`http_file.rs` 의 같은 판단), 보여 주면 같은 파일이 두 번
/// 보이고 그 사본을 편집하게 된다. 반대로 `.idea`·`.github`·`.cowork` 같은 점 폴더는
/// 이 저장소에서 실제 내용물이라 숨기지 않는다.
const SKIP_DIRS: [&str; 6] = [".git", "node_modules", "target", "build", "out", "dist"];

/// 편집기에 올리는 상한. 넘으면 앞부분만 읽고 `truncated` 를 세운다.
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// 바이너리 판정에 훑는 앞부분 길이 — NUL 하나면 텍스트가 아니다.
const NUL_SCAN_BYTES: usize = 8 * 1024;

/// 트리의 한 줄.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEntry {
    pub name: String,
    /// 절대 경로(읽기·쓰기에 그대로 되돌려 준다).
    pub path: String,
    /// 루트 기준 상대 경로, 구분자는 항상 `/`.
    pub rel: String,
    pub dir: bool,
}

/// 읽어 온 파일 하나.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevFileText {
    /// 바이너리면 빈 문자열이다(화면이 편집기 대신 안내를 띄운다).
    pub text: String,
    pub binary: bool,
    /// 상한에 걸려 앞부분만 읽었다 — 프론트가 저장을 막는다.
    pub truncated: bool,
    /// 잘리기 전 실제 파일 크기.
    pub size: u64,
}

/// 웹뷰가 준 경로를 루트 안의 절대 경로로 바꾼다. **세 커맨드의 유일한 관문이다.**
///
/// 아직 없는 파일은 canonicalize 가 실패하므로 상위 폴더만 canonicalize 하고 파일명을
/// 다시 붙인다 — 그래서 "상위 폴더가 없으면 실패" 가 공짜로 따라오고, 오타 하나로
/// 폴더가 흩뿌려지지 않는다.
fn resolve_in_root(root: &str, path_or_rel: &str) -> Result<PathBuf, String> {
    let root_abs = expand_home(root)
        .canonicalize()
        .map_err(|e| format!("프로젝트 폴더를 찾을 수 없습니다: {root}\n({e})"))?;
    if !root_abs.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", root_abs.to_string_lossy()));
    }

    let raw = expand_home(path_or_rel);
    // 상대 경로("" 는 루트 자신)는 루트에 붙이고, 절대 경로는 그대로 검사만 한다.
    let target = if raw.as_os_str().is_empty() {
        root_abs.clone()
    } else if raw.is_absolute() {
        raw
    } else {
        root_abs.join(raw)
    };

    let resolved = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let parent = target
                .parent()
                .ok_or_else(|| format!("경로가 올바르지 않습니다: {path_or_rel}"))?;
            let name = target
                .file_name()
                .ok_or_else(|| format!("파일 이름이 없습니다: {path_or_rel}"))?;
            let parent = parent.canonicalize().map_err(|e| {
                format!("상위 폴더가 없습니다: {}\n({e})", parent.to_string_lossy())
            })?;
            parent.join(name)
        }
    };

    if !resolved.starts_with(&root_abs) {
        return Err(format!(
            "프로젝트 폴더 밖은 다룰 수 없습니다: {}",
            resolved.to_string_lossy()
        ));
    }
    Ok(resolved)
}

/// 만들어진/옮겨진 항목을 트리의 한 줄과 **같은 모양**으로 돌려준다.
///
/// 프론트가 절대 경로에서 `rel` 을 계산하지 않게 하려는 것이 요점이다: 화면이 들고 있는
/// 루트는 설정에 적힌 문자열(`~/…` 일 수 있다)이고 여기서 쓰는 것은 canonicalize 된
/// 경로라, 그쪽에서 접두사를 떼면 어긋난다.
fn entry_of(root_abs: &Path, p: &Path) -> DevEntry {
    DevEntry {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        rel: rel_of(root_abs, p),
        path: p.to_string_lossy().to_string(),
        dir: p.is_dir(),
    }
}

/// 루트 기준 상대 경로를 `/` 구분자로.
fn rel_of(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn list_dir(root: &str, rel: &str) -> Result<Vec<DevEntry>, String> {
    let root_abs = expand_home(root)
        .canonicalize()
        .map_err(|e| format!("프로젝트 폴더를 찾을 수 없습니다: {root}\n({e})"))?;
    let dir = resolve_in_root(root, rel)?;
    if !dir.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", dir.to_string_lossy()));
    }

    let mut out: Vec<DevEntry> = Vec::new();
    for e in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let name = e.file_name().to_string_lossy().to_string();
        // `is_dir()` 은 심볼릭 링크에 false 다 — 링크된 폴더는 펼칠 수 없는 항목이 되고,
        // 그래서 순환 참조와 프로젝트 밖으로 새는 것을 둘 다 자연히 막는다.
        let is_dir = ft.is_dir();
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = e.path();
        out.push(DevEntry {
            rel: rel_of(&root_abs, &path),
            path: path.to_string_lossy().to_string(),
            name,
            dir: is_dir,
        });
    }
    // 폴더 먼저, 그 안에서 이름순(대소문자 무시) — 파인더·IntelliJ 와 같은 순서다.
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

fn read_file(root: &str, path: &str) -> Result<DevFileText, String> {
    let p = resolve_in_root(root, path)?;
    let meta = p
        .metadata()
        .map_err(|e| format!("{}: {e}", p.to_string_lossy()))?;
    if !meta.is_file() {
        return Err(format!("파일이 아닙니다: {}", p.to_string_lossy()));
    }
    let size = meta.len();
    let truncated = size > MAX_TEXT_BYTES;

    let mut buf: Vec<u8> = Vec::new();
    fs::File::open(&p)
        .map_err(|e| e.to_string())?
        .take(MAX_TEXT_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;

    let binary = buf.iter().take(NUL_SCAN_BYTES).any(|b| *b == 0);
    Ok(DevFileText {
        // 잘린 자리에서 멀티바이트 글자가 반토막 날 수 있고, latin-1 이 섞인 로그·
        // 리소스 파일도 흔하다 — 그것 때문에 열리지 않으면 안 되므로 lossy 로 읽는다.
        text: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&buf).to_string()
        },
        binary,
        truncated,
        size,
    })
}

fn write_file(root: &str, path: &str, text: &str) -> Result<(), String> {
    // 없는 파일은 만들지만 **상위 폴더는 만들지 않는다** — 경로 오타 하나에
    // 저장소 곳곳으로 빈 폴더가 흩뿌려지는 쪽이 저장 실패보다 나쁘다.
    // (`resolve_in_root` 이 상위 폴더를 canonicalize 하므로 그 판정은 거기서 끝난다.)
    let p = resolve_in_root(root, path)?;
    if p.is_dir() {
        return Err(format!("폴더입니다: {}", p.to_string_lossy()));
    }
    fs::write(&p, text).map_err(|e| format!("{}: {e}", p.to_string_lossy()))
}

/* ─────────────────────────── 파일 조작 ───────────────────────────
 *
 * 트리 우클릭 메뉴가 쓰는 다섯 가지. 전부 `resolve_in_root` 를 지나가므로 루트 밖은
 * 애초에 닿지 않고, 그 위에 각 동작마다 자기 관문을 하나씩 더 둔다(머리말의 규칙 셋).
 */

/// 새로 만들 이름 / 바꿀 이름의 공통 검사.
///
/// `nested` 는 `New File` 에만 허용한다 — IntelliJ 처럼 `a/b/C.java` 로 중간 폴더까지
/// 만들 수 있어야 하지만, 이름 바꾸기에서 `/` 를 받으면 그건 이름 바꾸기가 아니라 이동이라
/// 대화창의 뜻과 결과가 달라진다.
fn check_name(name: &str, nested: bool) -> Result<(), String> {
    if name.is_empty() {
        return Err("이름을 입력하세요.".into());
    }
    if name.starts_with('/') || name.starts_with('~') {
        return Err("이름에 절대 경로를 쓸 수 없습니다.".into());
    }
    if !nested && (name.contains('/') || name.contains('\\')) {
        return Err("이름에 경로 구분자를 쓸 수 없습니다.".into());
    }
    // `..` 는 `resolve_in_root` 가 루트 밖으로 나갈 때만 막는다 — 루트 안에서라도
    // "새 파일"의 이름으로 상위를 거슬러 올라가는 것은 오타이거나 함정이다.
    use std::path::Component;
    if Path::new(name)
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(format!("이름에 쓸 수 없는 경로입니다: {name}"));
    }
    Ok(())
}

/// `resolve_in_root` 을 지나온 경로가 루트 자신이면 거절한다.
///
/// 프로젝트 루트를 지우거나 이름을 바꾸는 것은 이 화면이 대신 해 줄 일이 아니다(그
/// 경로는 설정 → Cowork 가 들고 있어서, 여기서 없애면 화면 전체가 빈다).
fn refuse_root(root_abs: &Path, target: &Path) -> Result<(), String> {
    if target == root_abs {
        return Err("프로젝트 루트 자신은 대상이 될 수 없습니다.".into());
    }
    Ok(())
}

fn root_abs_of(root: &str) -> Result<PathBuf, String> {
    expand_home(root)
        .canonicalize()
        .map_err(|e| format!("프로젝트 폴더를 찾을 수 없습니다: {root}\n({e})"))
}

/// `name` 을 `parent` 아래의 절대 경로로. 이름에 `..` 가 없음을 이미 확인했으므로
/// 단순 `join` 으로도 루트를 벗어나지 않지만, 마지막에 한 번 더 확인한다.
fn join_in_root(root_abs: &Path, parent: &Path, name: &str) -> Result<PathBuf, String> {
    let target = parent.join(name);
    if !target.starts_with(root_abs) {
        return Err(format!(
            "프로젝트 폴더 밖은 다룰 수 없습니다: {}",
            target.to_string_lossy()
        ));
    }
    Ok(target)
}

fn create_entry(root: &str, parent: &str, name: &str, dir: bool) -> Result<DevEntry, String> {
    let name = name.trim();
    check_name(name, true)?;
    let root_abs = root_abs_of(root)?;
    let parent_abs = resolve_in_root(root, parent)?;
    if !parent_abs.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", parent_abs.to_string_lossy()));
    }
    let target = join_in_root(&root_abs, &parent_abs, name)?;
    // `exists()` 는 심볼릭 링크의 대상까지 따라가므로 끊어진 링크를 놓친다 —
    // 그걸 "없다"로 보고 만들면 `create_dir_all` 이 실패하거나 링크 대상을 덮어쓴다.
    if target.symlink_metadata().is_ok() {
        return Err(format!("이미 있습니다: {name}"));
    }

    if dir {
        fs::create_dir_all(&target).map_err(|e| format!("{}: {e}", target.to_string_lossy()))?;
    } else {
        // 여러 겹 이름(`a/b/C.java`)의 중간 폴더는 만들어 준다 — 그것이 이 커맨드를
        // 부른 뜻이다(`dev_write_file` 이 상위 폴더를 만들지 않는 것과는 상황이 다르다:
        // 그쪽은 저장 경로의 오타를 걸러야 하고, 여기는 사람이 방금 적어 넣은 이름이다).
        if let Some(p) = target.parent() {
            fs::create_dir_all(p).map_err(|e| format!("{}: {e}", p.to_string_lossy()))?;
        }
        fs::write(&target, "").map_err(|e| format!("{}: {e}", target.to_string_lossy()))?;
    }
    Ok(entry_of(&root_abs, &target))
}

fn rename_entry(root: &str, path: &str, name: &str) -> Result<DevEntry, String> {
    let name = name.trim();
    check_name(name, false)?;
    let root_abs = root_abs_of(root)?;
    let src = resolve_in_root(root, path)?;
    refuse_root(&root_abs, &src)?;
    if src.symlink_metadata().is_err() {
        return Err(format!("없는 항목입니다: {}", src.to_string_lossy()));
    }
    let parent = src
        .parent()
        .ok_or_else(|| format!("상위 폴더가 없습니다: {}", src.to_string_lossy()))?;
    let dest = join_in_root(&root_abs, parent, name)?;
    if dest == src {
        return Ok(entry_of(&root_abs, &src));
    }
    // macOS 의 APFS 는 기본이 **대소문자 구분 없음**이라 `Foo.java` → `foo.java` 는
    // "이미 있다"로 보인다. 그 하나만 통과시키기 위해 canonicalize 로 같은 파일인지
    // 확인한다 — 이걸 놓치면 대소문자만 바꾸는 이름 변경이 영원히 거절된다.
    if dest.symlink_metadata().is_ok() {
        let same = dest
            .canonicalize()
            .ok()
            .zip(src.canonicalize().ok())
            .is_some_and(|(a, b)| a == b);
        if !same {
            return Err(format!("같은 이름이 이미 있습니다: {name}"));
        }
    }
    fs::rename(&src, &dest).map_err(|e| format!("{}: {e}", dest.to_string_lossy()))?;
    Ok(entry_of(&root_abs, &dest))
}

/// `~/.Trash` 로 옮긴다. 실패하면 `Ok(false)` 가 아니라 `Err` 로 올려 호출부가 영구
/// 삭제로 내려갈지 정한다.
fn move_to_trash(target: &Path) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let trash = PathBuf::from(home).join(".Trash");
    if !trash.is_dir() {
        return Err("휴지통 폴더가 없습니다.".into());
    }
    let name = target
        .file_name()
        .ok_or_else(|| "이름이 없는 경로입니다.".to_string())?;
    let mut dest = trash.join(name);
    // 파인더와 같은 방식으로 번호를 붙인다 — 같은 이름을 두 번 지웠을 때 먼저 지운
    // 것을 덮어쓰면 휴지통이 복구 수단이 아니게 된다.
    let mut n = 2;
    while dest.symlink_metadata().is_ok() {
        let base = name.to_string_lossy();
        dest = trash.join(format!("{base} {n}"));
        n += 1;
        if n > 1000 {
            return Err("휴지통에 같은 이름이 너무 많습니다.".into());
        }
    }
    fs::rename(target, &dest).map_err(|e| e.to_string())
}

/// 삭제. 돌려주는 `true` 는 "휴지통으로 옮겼다", `false` 는 "영구 삭제했다"다.
fn delete_entry(root: &str, path: &str) -> Result<bool, String> {
    let root_abs = root_abs_of(root)?;
    let target = resolve_in_root(root, path)?;
    refuse_root(&root_abs, &target)?;
    let meta = target
        .symlink_metadata()
        .map_err(|e| format!("{}: {e}", target.to_string_lossy()))?;

    if move_to_trash(&target).is_ok() {
        return Ok(true);
    }
    // 링크는 대상을 따라가지 않고 링크 자신만 지운다(`is_dir()` 이 링크에 false 인 것과
    // 같은 판단 — `list_dir` 참고).
    let r = if meta.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        fs::remove_file(&target)
    };
    r.map_err(|e| format!("{}: {e}", target.to_string_lossy()))?;
    Ok(false)
}

/// 폴더를 통째로 복사한다(`fs` 에 재귀 복사가 없다).
fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest).map_err(|e| format!("{}: {e}", dest.to_string_lossy()))?;
        for e in fs::read_dir(src)
            .map_err(|e| format!("{}: {e}", src.to_string_lossy()))?
            .flatten()
        {
            copy_tree(&e.path(), &dest.join(e.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dest)
            .map(|_| ())
            .map_err(|e| format!("{}: {e}", dest.to_string_lossy()))
    }
}

/// `Foo.java` → `Foo 사본.java` → `Foo 사본 2.java`. 확장자 앞에 넣는 것이 요점이다 —
/// 뒤에 붙이면 `Foo.java 사본` 이 되어 편집기도 컴파일러도 자바 파일로 보지 않는다.
fn unique_copy_name(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        // 앞이 비어 있으면 확장자가 아니라 숨은 파일 이름이다(`.gitignore`).
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut candidate = dir.join(format!("{stem} 사본{ext}"));
    let mut n = 2;
    while candidate.symlink_metadata().is_ok() {
        candidate = dir.join(format!("{stem} 사본 {n}{ext}"));
        n += 1;
        if n > 1000 {
            break;
        }
    }
    candidate
}

/// 붙여넣기의 공통 관문 — 대상 폴더를 확인하고 "폴더를 자기 안으로" 를 막는다.
fn paste_target(
    root: &str,
    src: &str,
    dest_dir: &str,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root_abs = root_abs_of(root)?;
    let src_abs = resolve_in_root(root, src)?;
    refuse_root(&root_abs, &src_abs)?;
    if src_abs.symlink_metadata().is_err() {
        return Err(format!("없는 항목입니다: {}", src_abs.to_string_lossy()));
    }
    let dir_abs = resolve_in_root(root, dest_dir)?;
    if !dir_abs.is_dir() {
        return Err(format!("폴더가 아닙니다: {}", dir_abs.to_string_lossy()));
    }
    // `dir_abs == src_abs` 도 이 검사에 걸린다(자기 안에 자기를 넣는 것).
    if dir_abs.starts_with(&src_abs) {
        return Err("폴더를 자기 자신 안으로 옮기거나 복사할 수 없습니다.".into());
    }
    Ok((src_abs, dir_abs, root_abs))
}

fn copy_into(root: &str, src: &str, dest_dir: &str) -> Result<DevEntry, String> {
    let (src_abs, dir_abs, root_abs) = paste_target(root, src, dest_dir)?;
    let name = src_abs
        .file_name()
        .ok_or_else(|| "이름이 없는 경로입니다.".to_string())?
        .to_string_lossy()
        .to_string();
    let mut dest = dir_abs.join(&name);
    if dest.symlink_metadata().is_ok() {
        dest = unique_copy_name(&dir_abs, &name);
    }
    copy_tree(&src_abs, &dest)?;
    Ok(entry_of(&root_abs, &dest))
}

fn move_into(root: &str, src: &str, dest_dir: &str) -> Result<DevEntry, String> {
    let (src_abs, dir_abs, root_abs) = paste_target(root, src, dest_dir)?;
    let name = src_abs
        .file_name()
        .ok_or_else(|| "이름이 없는 경로입니다.".to_string())?
        .to_owned();
    let dest = dir_abs.join(&name);
    if dest == src_abs {
        // 있던 자리에 그대로 붙여넣었다 — 실패가 아니므로 조용히 지금 경로를 돌려준다.
        return Ok(entry_of(&root_abs, &src_abs));
    }
    if dest.symlink_metadata().is_ok() {
        return Err(format!(
            "같은 이름이 이미 있습니다: {}",
            name.to_string_lossy()
        ));
    }
    // 볼륨이 하나면 `rename` 으로 끝난다. 프로젝트 안에서의 이동이라 다른 볼륨일 수는
    // 없지만(루트 밖은 애초에 막혀 있다), 마운트된 하위 폴더가 있을 수 있어 복사 후
    // 삭제로 내려간다.
    if fs::rename(&src_abs, &dest).is_err() {
        copy_tree(&src_abs, &dest)?;
        let r = if src_abs.is_dir() {
            fs::remove_dir_all(&src_abs)
        } else {
            fs::remove_file(&src_abs)
        };
        r.map_err(|e| format!("옮긴 뒤 원본을 지우지 못했습니다: {e}"))?;
    }
    Ok(entry_of(&root_abs, &dest))
}

/// 폴더 한 겹을 읽는다(`rel` 이 "" 면 루트 자신).
#[tauri::command]
pub async fn dev_list_dir(root: String, rel: String) -> Result<Vec<DevEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&root, &rel))
        .await
        .map_err(|e| e.to_string())?
}

/// 파일 하나를 텍스트로 읽는다.
#[tauri::command]
pub async fn dev_read_file(root: String, path: String) -> Result<DevFileText, String> {
    tauri::async_runtime::spawn_blocking(move || read_file(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// 편집한 내용을 저장한다(없으면 만든다).
#[tauri::command]
pub async fn dev_write_file(root: String, path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file(&root, &path, &text))
        .await
        .map_err(|e| e.to_string())?
}

/// 새 파일 또는 새 폴더. `name` 은 `a/b/C.java` 처럼 여러 겹일 수 있고, 만들어진
/// **절대 경로**를 돌려준다(프론트가 그 파일을 바로 탭으로 연다).
#[tauri::command]
pub async fn dev_create_entry(
    root: String,
    parent: String,
    name: String,
    dir: bool,
) -> Result<DevEntry, String> {
    tauri::async_runtime::spawn_blocking(move || create_entry(&root, &parent, &name, dir))
        .await
        .map_err(|e| e.to_string())?
}

/// 같은 폴더 안에서 이름만 바꾼다. 새 절대 경로를 돌려준다.
#[tauri::command]
pub async fn dev_rename_entry(
    root: String,
    path: String,
    name: String,
) -> Result<DevEntry, String> {
    tauri::async_runtime::spawn_blocking(move || rename_entry(&root, &path, &name))
        .await
        .map_err(|e| e.to_string())?
}

/// 삭제. `true` 면 휴지통으로 옮긴 것, `false` 면 영구 삭제한 것이다(프론트가 그대로 알린다).
#[tauri::command]
pub async fn dev_delete_entry(root: String, path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || delete_entry(&root, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// 복사 붙여넣기. 같은 이름이 있으면 `사본` 이름을 새로 만들고, 만들어진 경로를 돌려준다.
#[tauri::command]
pub async fn dev_copy_entry(
    root: String,
    src: String,
    dest_dir: String,
) -> Result<DevEntry, String> {
    tauri::async_runtime::spawn_blocking(move || copy_into(&root, &src, &dest_dir))
        .await
        .map_err(|e| e.to_string())?
}

/// 잘라내기 붙여넣기(= 이동). 같은 이름이 있으면 거절한다.
#[tauri::command]
pub async fn dev_move_entry(
    root: String,
    src: String,
    dest_dir: String,
) -> Result<DevEntry, String> {
    tauri::async_runtime::spawn_blocking(move || move_into(&root, &src, &dest_dir))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `tempfile` 은 dev-dependency 가 아니라 `http_file.rs` 테스트와 같은 방식으로
    /// 임시 폴더를 직접 만든다.
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myspace-devfs-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        // macOS 의 `/tmp` 는 `/private/tmp` 심볼릭 링크라, 비교 대상이 되는 경로는
        // 미리 canonicalize 해 두어야 테스트가 실제 동작과 같은 값을 본다.
        d.canonicalize().unwrap()
    }

    /// 루트 밖으로 나가는 경로는 읽기도 쓰기도 거절해야 한다 — 이걸 놓치면
    /// 웹뷰에서 `~/.ssh/id_rsa` 가 그대로 읽히고 덮어써진다.
    #[test]
    fn rejects_escaping_the_root() {
        let base = tmp("escape");
        let root = base.join("proj");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.txt"), "top secret").unwrap();
        let root_s = root.to_string_lossy().to_string();

        let read_err = read_file(&root_s, "../secret.txt").unwrap_err();
        assert!(read_err.contains("프로젝트 폴더 밖"), "{read_err}");

        let write_err = write_file(&root_s, "../secret.txt", "덮어쓰기").unwrap_err();
        assert!(write_err.contains("프로젝트 폴더 밖"), "{write_err}");
        assert_eq!(
            fs::read_to_string(base.join("secret.txt")).unwrap(),
            "top secret"
        );

        // 절대 경로로 우회하는 것도 같은 관문에서 막힌다.
        let abs = base.join("secret.txt").to_string_lossy().to_string();
        assert!(read_file(&root_s, &abs).is_err());

        // 반대로 루트 안이면 없는 파일도 만들어 준다(상위 폴더가 있는 한).
        write_file(&root_s, "a.txt", "안녕").unwrap();
        assert_eq!(read_file(&root_s, "a.txt").unwrap().text, "안녕");

        // 상위 폴더까지 만들어 주지는 않는다.
        let err = write_file(&root_s, "없는폴더/a.txt", "x").unwrap_err();
        assert!(err.contains("상위 폴더가 없습니다"), "{err}");
        let _ = fs::remove_dir_all(&base);
    }

    /// 폴더가 먼저, 그 안에서 이름순. 산출물 폴더는 아예 보이지 않는다.
    #[test]
    fn lists_one_level_dirs_first_and_skips_build_output() {
        let root = tmp("list");
        for d in ["src", "Docs", "target", "node_modules", ".idea"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("target/copy.http"), "GET /").unwrap();
        for f in ["pom.xml", "README.md", "build.gradle"] {
            fs::write(root.join(f), "x").unwrap();
        }
        let root_s = root.to_string_lossy().to_string();

        let names: Vec<String> = list_dir(&root_s, "")
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        // `.idea` 는 실제 내용물이라 남고, `build.gradle` 은 폴더가 아니므로
        // 이름이 `build` 로 시작한다고 걸러지면 안 된다.
        assert_eq!(
            names,
            vec![".idea", "Docs", "src", "build.gradle", "pom.xml", "README.md"]
        );

        // 한 겹만 본다 — 루트 목록에 하위 파일이 섞여 들어오지 않는다.
        fs::write(root.join("src/App.java"), "class App {}").unwrap();
        let sub = list_dir(&root_s, "src").unwrap();
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].rel, "src/App.java");
        assert!(!sub[0].dir);
        let _ = fs::remove_dir_all(&root);
    }

    /// 파일 조작도 같은 관문을 지난다 — 루트 밖과 루트 자신은 어느 동작도 건드릴 수 없다.
    #[test]
    fn file_ops_never_leave_the_root() {
        let base = tmp("ops-escape");
        let root = base.join("proj");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(base.join("secret.txt"), "top secret").unwrap();
        let root_s = root.to_string_lossy().to_string();

        // 새로 만들기: 이름으로 상위를 거슬러 올라가는 것은 루트 안이어도 거절한다.
        assert!(create_entry(&root_s, "", "../secret.txt", false).is_err());
        assert!(create_entry(&root_s, "", "src/../../x.txt", false).is_err());
        // 이름 바꾸기·복사·이동은 루트 밖 경로 자체가 관문에서 걸린다.
        let outside = base.join("secret.txt").to_string_lossy().to_string();
        assert!(rename_entry(&root_s, &outside, "x.txt").is_err());
        assert!(copy_into(&root_s, &outside, "src").is_err());
        assert!(move_into(&root_s, &outside, "src").is_err());
        assert_eq!(
            fs::read_to_string(base.join("secret.txt")).unwrap(),
            "top secret"
        );

        // 루트 자신은 지우거나 이름을 바꿀 수 없다(화면 전체의 기준 경로다).
        assert!(delete_entry(&root_s, "").is_err());
        assert!(rename_entry(&root_s, "", "other").is_err());
        assert!(root.is_dir());
        let _ = fs::remove_dir_all(&base);
    }

    /// 새로 만들기는 여러 겹 이름의 중간 폴더까지 만들고, 이미 있으면 거절한다.
    #[test]
    fn creates_nested_names_but_never_overwrites() {
        let root = tmp("ops-create");
        let root_s = root.to_string_lossy().to_string();

        let made = create_entry(&root_s, "", "a/b/C.java", false).unwrap();
        assert_eq!(PathBuf::from(&made.path), root.join("a/b/C.java"));
        assert_eq!(made.rel, "a/b/C.java");
        assert_eq!(made.name, "C.java");
        assert!(!made.dir);
        assert_eq!(fs::read_to_string(root.join("a/b/C.java")).unwrap(), "");

        create_entry(&root_s, "", "docs", true).unwrap();
        assert!(root.join("docs").is_dir());

        // 있는 파일을 같은 이름으로 만들면 내용이 날아가므로 반드시 거절해야 한다.
        fs::write(root.join("a/b/C.java"), "class C {}").unwrap();
        let err = create_entry(&root_s, "a/b", "C.java", false).unwrap_err();
        assert!(err.contains("이미 있습니다"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join("a/b/C.java")).unwrap(),
            "class C {}"
        );

        // 빈 이름과 절대 경로도 관문에서 끝난다.
        assert!(create_entry(&root_s, "", "  ", false).is_err());
        assert!(create_entry(&root_s, "", "/etc/hosts", false).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// 이름 바꾸기는 덮어쓰지 않지만, **대소문자만 바꾸는 것은 통과해야 한다**
    /// (APFS 는 대소문자를 구분하지 않아 "이미 있다"로 보인다).
    #[test]
    fn renames_including_case_only_changes() {
        let root = tmp("ops-rename");
        let root_s = root.to_string_lossy().to_string();
        fs::write(root.join("Foo.java"), "class Foo {}").unwrap();
        fs::write(root.join("Bar.java"), "class Bar {}").unwrap();

        let moved = rename_entry(&root_s, "Foo.java", "foo.java").unwrap();
        assert_eq!(moved.rel, "foo.java");
        assert_eq!(
            fs::read_to_string(&moved.path).unwrap(),
            "class Foo {}",
            "대소문자만 바꾼 이름 변경이 내용을 잃지 않는다"
        );

        let err = rename_entry(&root_s, "Bar.java", "foo.java").unwrap_err();
        assert!(err.contains("이미 있습니다"), "{err}");
        assert_eq!(
            fs::read_to_string(root.join("Bar.java")).unwrap(),
            "class Bar {}"
        );

        // `/` 가 든 이름은 이동이 되어 버리므로 이름 바꾸기에서는 거절한다.
        assert!(rename_entry(&root_s, "Bar.java", "sub/Bar.java").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// 붙여넣기: 복사는 `사본` 이름을 만들고, 이동은 겹치면 거절하며, 폴더를 자기 안으로
    /// 넣는 것은 둘 다 막는다(막지 않으면 원본이 사라지거나 무한 재귀가 된다).
    #[test]
    fn pastes_without_overwriting_or_recursing() {
        let root = tmp("ops-paste");
        let root_s = root.to_string_lossy().to_string();
        fs::create_dir_all(root.join("src/deep")).unwrap();
        fs::create_dir_all(root.join("dest")).unwrap();
        fs::write(root.join("src/A.java"), "A").unwrap();
        fs::write(root.join("src/deep/B.java"), "B").unwrap();

        // 폴더 복사는 안까지 통째로 간다.
        let copied = copy_into(&root_s, "src", "dest").unwrap();
        assert_eq!(PathBuf::from(&copied.path), root.join("dest/src"));
        assert!(copied.dir, "폴더를 복사했으면 폴더로 돌려준다");
        assert_eq!(copied.rel, "dest/src");
        assert_eq!(
            fs::read_to_string(root.join("dest/src/deep/B.java")).unwrap(),
            "B"
        );

        // 같은 자리에 한 번 더 = `사본`, 원본은 그대로.
        let again = copy_into(&root_s, "src", "dest").unwrap();
        assert_eq!(PathBuf::from(&again.path), root.join("dest/src 사본"));
        assert!(root.join("dest/src/A.java").is_file());

        // 확장자 앞에 붙는지 — `A.java 사본` 이면 자바 파일이 아니게 된다.
        let f = copy_into(&root_s, "src/A.java", "src").unwrap();
        assert_eq!(PathBuf::from(&f.path), root.join("src/A 사본.java"));

        // 이동은 겹치면 거절한다(복사와 달리 원본이 사라지는 동작이라 이름을 지어내면 안 된다).
        let err = move_into(&root_s, "src", "dest").unwrap_err();
        assert!(err.contains("같은 이름이 이미 있습니다"), "{err}");
        assert!(root.join("src/A.java").is_file());

        // 폴더를 자기 안으로.
        assert!(copy_into(&root_s, "src", "src/deep").is_err());
        assert!(move_into(&root_s, "src", "src/deep").is_err());
        assert!(move_into(&root_s, "src", "src").is_err());

        // 실제 이동은 원본을 남기지 않는다.
        let moved = move_into(&root_s, "src/deep", "dest").unwrap();
        assert_eq!(PathBuf::from(&moved.path), root.join("dest/deep"));
        assert!(!root.join("src/deep").exists());
        assert_eq!(
            fs::read_to_string(root.join("dest/deep/B.java")).unwrap(),
            "B"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 삭제는 휴지통으로 옮기고, 그럴 수 없으면 영구 삭제하며 **어느 쪽이었는지 알려 준다**.
    #[test]
    fn deletes_via_trash_and_reports_which() {
        let root = tmp("ops-delete");
        let root_s = root.to_string_lossy().to_string();
        fs::create_dir_all(root.join("gone/inner")).unwrap();
        fs::write(root.join("gone/inner/x.txt"), "x").unwrap();
        fs::write(root.join("a.txt"), "a").unwrap();

        let trashed = delete_entry(&root_s, "a.txt").unwrap();
        assert!(!root.join("a.txt").exists());
        // 폴더는 안에 든 것까지 사라진다.
        let dir_trashed = delete_entry(&root_s, "gone").unwrap();
        assert!(!root.join("gone").exists());

        // CI 처럼 `~/.Trash` 가 없는 환경에서는 영구 삭제로 내려간다 — 두 경우 모두
        // 동작 자체는 성공해야 하고, 돌려준 값이 어디로 갔는지를 말한다.
        let trash_exists = std::env::var("HOME")
            .map(|h| PathBuf::from(h).join(".Trash").is_dir())
            .unwrap_or(false);
        assert_eq!(trashed, trash_exists);
        assert_eq!(dir_trashed, trash_exists);
        if trashed {
            // 테스트가 남긴 것은 치운다(휴지통에 쌓이면 사람이 지우게 된다).
            let trash = PathBuf::from(std::env::var("HOME").unwrap()).join(".Trash");
            let _ = fs::remove_file(trash.join("a.txt"));
            let _ = fs::remove_dir_all(trash.join("gone"));
        }
        assert!(delete_entry(&root_s, "없는파일.txt").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    /// NUL 이 섞인 파일은 편집기에 올리지 않는다(올리면 저장할 때 파일이 깨진다).
    #[test]
    fn detects_binary_by_nul_byte() {
        let root = tmp("binary");
        fs::write(root.join("logo.png"), b"\x89PNG\r\n\x1a\n\x00\x00\x00").unwrap();
        fs::write(root.join("a.md"), "# 제목\n").unwrap();
        let root_s = root.to_string_lossy().to_string();

        let bin = read_file(&root_s, "logo.png").unwrap();
        assert!(bin.binary);
        assert!(bin.text.is_empty());
        assert_eq!(bin.size, 11);

        let txt = read_file(&root_s, "a.md").unwrap();
        assert!(!txt.binary && !txt.truncated);
        assert_eq!(txt.text, "# 제목\n");
        let _ = fs::remove_dir_all(&root);
    }
}
