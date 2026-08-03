//! Git — 설정한 cowork 홈 디렉터리의 변경사항을 IntelliJ 의 Git 툴윈도우처럼 다룬다.
//!
//! **libgit2(git2 크레이트)가 아니라 `git` CLI 를 그대로 부른다.** 이유가 셋 있다:
//! (1) 자격증명 — push 는 회사 저장소를 상대로 하고, macOS 는 `osxkeychain` 헬퍼와
//! `~/.ssh/config` 로 인증한다. libgit2 는 그 둘 다 직접 구현해야 하며 SSH 는
//! 별도 백엔드(libssh2)를 링크해야 한다. (2) 사용자의 `.gitconfig`(hooks, gpg 서명,
//! `core.autocrlf`, `include` 등)가 그대로 먹는다 — CLI 가 아니면 커밋 하나가
//! 터미널에서 한 것과 다르게 남는다. (3) 빌드가 무거워지지 않는다(rdkafka 로 이미
//! 첫 컴파일이 몇 분이다).
//!
//! 대신 **출력 파싱**이 우리 몫이라, 사람이 읽는 출력 대신 기계용 포맷만 쓴다:
//! 상태는 `--porcelain=v1 -z`(NUL 구분 — 공백·한글·따옴표 이스케이프 문제를 피한다),
//! stash 는 `--format=%gd%x00%gs%x00%cr`.
//!
//! 모든 커맨드는 `async` + `spawn_blocking` 이다. 동기 커맨드는 메인 스레드에서 도는데,
//! push/pull 은 네트워크라 그동안 창 전체가 멈춘다.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::OnceLock;

use crate::cowork::expand_home;

/// untracked 파일을 diff 로 만들어 줄 때의 크기 상한(1 MB). 이 이상은 본문 대신 안내만 준다.
const MAX_UNTRACKED_DIFF: u64 = 1024 * 1024;

/* ────────────────────────────── 실행 헬퍼 ────────────────────────────── */

/// 쓸 `git` 실행 파일. Finder/LaunchAgent 로 뜬 앱은 PATH 가 최소라 `git` 만으로는
/// 못 찾을 수 있어 흔한 위치를 먼저 훑는다. Homebrew 를 앞에 두는 이유는
/// `/usr/bin/git` 이 Command Line Tools 가 없을 때 설치 팝업을 띄우는 shim 이기 때문.
fn git_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for c in ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"] {
            if Path::new(c).is_file() {
                return c.to_string();
            }
        }
        "git".to_string()
    })
}

/// `git <args>` 를 `root` 에서 실행한다(성공 여부는 호출 쪽이 판단).
///
/// `GIT_TERMINAL_PROMPT=0`: 자격증명이 없을 때 git 이 tty 를 기다리면 앱에서는
/// 아무도 답할 수 없어 push 가 영원히 매달린다. 즉시 실패시켜 에러로 보여 준다.
/// `GIT_OPTIONAL_LOCKS=0`: status 를 주기적으로 읽으므로, 그때마다 인덱스를 다시 써서
/// 다른 git 작업(터미널·IDE)과 `index.lock` 을 두고 다투지 않게 한다.
fn exec(root: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new(git_bin())
        .current_dir(root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))
}

/// 실패한 git 출력에서 사람에게 보여 줄 메시지를 뽑는다(stderr → stdout → 종료 코드 순).
fn err_text(out: &Output, args: &[&str]) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    format!("git {} 실패 ({})", args.join(" "), out.status)
}

/// 성공을 요구하는 실행 — stdout 을 문자열로 준다.
fn run(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = exec(root, args)?;
    if !out.status.success() {
        return Err(err_text(&out, args));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// stdout + stderr 를 합쳐 돌려주는 실행(push/pull 처럼 진행 로그가 stderr 로 나오는 명령용).
fn run_log(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = exec(root, args)?;
    let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    if !out.status.success() {
        return Err(if text.is_empty() {
            format!("git {} 실패 ({})", args.join(" "), out.status)
        } else {
            text
        });
    }
    Ok(text)
}

/// 설정의 cowork 홈에서 저장소 루트를 찾는다. 홈이 하위 폴더여도 `--show-toplevel` 이
/// 루트로 올려 주므로, 모든 경로를 저장소 루트 상대로 통일할 수 있다.
fn repo_root(home: &str) -> Result<PathBuf, String> {
    let dir = expand_home(home);
    if home.trim().is_empty() {
        return Err("cowork 홈 디렉터리가 설정되지 않았습니다. 설정 → Cowork 에서 지정하세요.".into());
    }
    if !dir.is_dir() {
        return Err(format!("폴더를 찾을 수 없습니다: {}", dir.to_string_lossy()));
    }
    let out = exec(&dir, &["rev-parse", "--show-toplevel"])?;
    if !out.status.success() {
        return Err(format!(
            "git 저장소가 아닙니다: {}",
            dir.to_string_lossy()
        ));
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if top.is_empty() {
        return Err(format!("git 저장소가 아닙니다: {}", dir.to_string_lossy()));
    }
    Ok(PathBuf::from(top))
}

/* ────────────────────────────── 상태 ────────────────────────────── */

/// 변경된 파일 하나.
#[derive(Serialize, Clone)]
pub struct GitChange {
    /// 저장소 루트 기준 상대 경로(이름이 바뀐 파일이면 **새** 경로).
    pub path: String,
    /// 이름이 바뀐 파일의 원래 경로. 아니면 null.
    pub orig: Option<String>,
    /// porcelain 의 X(인덱스 상태) 한 글자. 없으면 " ".
    pub index: String,
    /// porcelain 의 Y(작업 트리 상태) 한 글자. 없으면 " ".
    pub worktree: String,
    /// 스테이지에 올라가 있는가.
    pub staged: bool,
    /// 스테이지에 없는 변경이 남아 있는가.
    pub unstaged: bool,
    /// 아직 버전 관리에 들어오지 않은 파일인가.
    pub untracked: bool,
    /// 병합 충돌 상태인가(양쪽이 모두 수정 등).
    pub conflict: bool,
}

/// `git stash list` 한 줄.
#[derive(Serialize, Clone)]
pub struct GitStash {
    /// 목록에서의 위치(0 이 가장 최근) — 액션은 이 값으로 `stash@{n}` 을 만든다.
    pub index: usize,
    /// `stash@{0}` 같은 참조 이름(표시용).
    pub name: String,
    /// 보관 메시지.
    pub message: String,
    /// "2 hours ago" 같은 상대 시각.
    pub date: String,
}

/// 뷰가 한 번에 받아 가는 저장소 스냅샷.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 저장소 루트 절대 경로.
    pub root: String,
    /// 현재 브랜치명. detached 면 짧은 커밋 해시.
    pub branch: String,
    /// 추적 중인 원격 브랜치(`origin/main`). 없으면 null → push 는 `-u` 로 붙인다.
    pub upstream: Option<String>,
    /// upstream 보다 앞선 커밋 수.
    pub ahead: u32,
    /// upstream 보다 뒤진 커밋 수.
    pub behind: u32,
    /// 브랜치가 아닌 커밋에 붙어 있는 상태인가.
    pub detached: bool,
    /// 아직 커밋이 하나도 없는 저장소인가(첫 커밋 전).
    pub no_commits: bool,
    /// 추적 중인 파일의 변경 목록(IntelliJ 의 Changes).
    pub changes: Vec<GitChange>,
    /// 추적되지 않는 파일 목록(IntelliJ 의 Unversioned Files).
    pub untracked: Vec<GitChange>,
    /// 보관해 둔 변경(Stashes).
    pub stashes: Vec<GitStash>,
}

/// `## main...origin/main [ahead 1, behind 2]` 형태의 브랜치 헤더를 푼다.
fn parse_branch(line: &str, st: &mut GitStatus) {
    // 대괄호 부분(ahead/behind)을 먼저 떼어 낸다.
    let (head, track) = match line.find(" [") {
        Some(i) => (&line[..i], line[i + 2..].trim_end_matches(']')),
        None => (line, ""),
    };
    for part in track.split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            st.ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            st.behind = n.parse().unwrap_or(0);
        }
    }
    // 첫 커밋 전에는 `## No commits yet on main` 이 온다.
    if let Some(rest) = head.strip_prefix("No commits yet on ") {
        st.no_commits = true;
        st.branch = rest.to_string();
        return;
    }
    if head == "HEAD (no branch)" {
        st.detached = true;
        st.branch = "HEAD".into();
        return;
    }
    match head.split_once("...") {
        Some((local, up)) => {
            st.branch = local.to_string();
            st.upstream = Some(up.to_string());
        }
        None => st.branch = head.to_string(),
    }
}

/// porcelain 한 항목(`XY path`)을 `GitChange` 로 바꾼다.
fn make_change(x: char, y: char, path: String, orig: Option<String>) -> GitChange {
    let untracked = x == '?';
    // 충돌은 DD/AU/UD/UA/DU/AA/UU 조합 — 한쪽이라도 U 이거나 AA/DD 면 충돌이다.
    let conflict = x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D');
    GitChange {
        path,
        orig,
        index: x.to_string(),
        worktree: y.to_string(),
        staged: !untracked && !conflict && x != ' ',
        unstaged: untracked || conflict || y != ' ',
        untracked,
        conflict,
    }
}

/// `git status --porcelain=v1 -z` 를 읽어 변경 목록을 만든다.
///
/// `-z` 는 항목을 NUL 로 끊고 경로를 이스케이프하지 않는다(따옴표·한글 경로가 그대로 온다).
/// 이름이 바뀐 항목(R/C)은 **두 칸**을 쓴다 — `XY new\0old\0` — 그래서 이터레이터를
/// 손으로 돌리며 다음 칸을 한 번 더 당겨 온다.
fn collect_status(root: &Path) -> Result<GitStatus, String> {
    let raw = run(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--branch",
        ],
    )?;
    let mut st = GitStatus {
        root: root.to_string_lossy().to_string(),
        ..Default::default()
    };
    let mut it = raw.split('\0');
    while let Some(entry) = it.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(b) = entry.strip_prefix("## ") {
            parse_branch(b, &mut st);
            continue;
        }
        let mut chars = entry.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
            continue;
        };
        // "XY " 다음이 경로. 바이트가 아니라 문자 기준으로 잘라야 한글 경로가 깨지지 않는다.
        let path: String = chars.skip(1).collect();
        if path.is_empty() {
            continue;
        }
        let orig = if x == 'R' || x == 'C' {
            it.next().map(|s| s.to_string())
        } else {
            None
        };
        let change = make_change(x, y, path, orig);
        if change.untracked {
            st.untracked.push(change);
        } else {
            st.changes.push(change);
        }
    }
    st.changes.sort_by(|a, b| a.path.cmp(&b.path));
    st.untracked.sort_by(|a, b| a.path.cmp(&b.path));
    st.stashes = collect_stashes(root);
    Ok(st)
}

/// 보관 목록. 실패해도(예: 저장소가 막 만들어져 reflog 가 없음) 상태 전체를 죽이지 않는다.
fn collect_stashes(root: &Path) -> Vec<GitStash> {
    let Ok(raw) = run(root, &["stash", "list", "--format=%gd%x00%gs%x00%cr"]) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .enumerate()
        .map(|(index, line)| {
            let mut parts = line.split('\0');
            GitStash {
                index,
                name: parts.next().unwrap_or("").to_string(),
                message: parts.next().unwrap_or("").to_string(),
                date: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect()
}

/// 저장소 스냅샷(브랜치·변경·보관)을 한 번에 읽는다. 뷰가 주기적으로 부른다.
#[tauri::command]
pub async fn git_status(home: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        collect_status(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── diff ────────────────────────────── */

/// 추적되지 않는 파일을 "전부 추가된 것"처럼 보이는 unified diff 로 만든다.
///
/// `git diff --no-index /dev/null <file>` 로도 되지만 그 경로는 종료 코드 1 을 성공으로
/// 취급해야 하고 `/dev/null` 이 Unix 전용이라, 파일을 직접 읽어 만든다.
fn untracked_diff(root: &Path, rel: &str) -> Result<String, String> {
    let abs = root.join(rel);
    let meta = std::fs::metadata(&abs).map_err(|e| format!("{rel}: {e}"))?;
    if meta.is_dir() {
        return Ok(format!("{rel} 는 폴더입니다."));
    }
    if meta.len() > MAX_UNTRACKED_DIFF {
        return Ok(format!(
            "파일이 커서 미리보기를 생략합니다 ({} bytes).",
            meta.len()
        ));
    }
    let bytes = std::fs::read(&abs).map_err(|e| format!("{rel}: {e}"))?;
    if bytes.contains(&0) {
        return Ok(format!("바이너리 파일입니다 ({} bytes).", bytes.len()));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let mut out = format!("--- /dev/null\n+++ b/{rel}\n@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
}

/// 파일 하나의 diff 텍스트.
///
/// `staged` 면 인덱스와 HEAD 의 차이(`--cached`), 아니면 작업 트리와 인덱스의 차이를 준다.
/// 이름이 바뀐 파일은 원래 경로도 pathspec 에 넣어야 diff 가 나온다.
#[tauri::command]
pub async fn git_diff(
    home: String,
    path: String,
    orig: Option<String>,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        if untracked {
            return untracked_diff(&root, &path);
        }
        let mut args: Vec<String> = vec!["diff".into(), "--no-color".into()];
        if staged {
            args.push("--cached".into());
        }
        args.push("--".into());
        args.push(path);
        if let Some(o) = orig {
            args.push(o);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run(&root, &refs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── 스테이지 ────────────────────────────── */

/// `git <cmd> -- <paths>` 형태의 명령을 만든다(경로가 `-` 로 시작해도 옵션으로 안 읽히게 `--`).
fn with_paths(base: &[&str], paths: &[String]) -> Vec<String> {
    let mut args: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    args.push("--".into());
    args.extend(paths.iter().cloned());
    args
}

fn run_with_paths(root: &Path, base: &[&str], paths: &[String]) -> Result<String, String> {
    let args = with_paths(base, paths);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(root, &refs)
}

/// 스테이지에 올린다. 추적되지 않던 파일에 대해서는 이게 곧 "Add to VCS" 다.
#[tauri::command]
pub async fn git_stage(home: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Ok(());
        }
        let root = repo_root(&home)?;
        run_with_paths(&root, &["add", "-A"], &paths)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 스테이지에서 내린다(파일 내용은 그대로).
///
/// 첫 커밋 전에는 HEAD 가 없어 `git reset` 이 실패하므로 `git rm --cached` 로 물러선다.
#[tauri::command]
pub async fn git_unstage(home: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Ok(());
        }
        let root = repo_root(&home)?;
        if run_with_paths(&root, &["reset", "-q"], &paths).is_err() {
            run_with_paths(&root, &["rm", "-q", "--cached", "-r"], &paths)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── 롤백 ────────────────────────────── */

/// 선택한 파일의 로컬 변경을 되돌린다(IntelliJ 의 Rollback).
///
/// 되돌리는 방법이 파일 상태마다 다르므로 **경로만 받고 상태는 여기서 다시 읽는다**
/// (프론트가 들고 있던 상태는 그새 낡았을 수 있고, 잘못 고르면 파일을 지운다):
/// - 추적되지 않는 파일 → 파일을 지운다(그 외에 "되돌린다"가 뜻할 게 없다).
/// - 새로 추가돼 스테이지에만 있는 파일 → 인덱스에서만 빼서 unversioned 로 돌린다.
///   IntelliJ 도 이 경우 로컬 파일을 지우지 않는다.
/// - 그 외(수정·삭제·이름변경·충돌) → `checkout HEAD --` 로 인덱스와 작업 트리를 함께 원복.
#[tauri::command]
pub async fn git_rollback(home: String, paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            return Ok(());
        }
        let root = repo_root(&home)?;
        let want: HashSet<String> = paths.into_iter().collect();
        let st = collect_status(&root)?;

        let mut delete: Vec<String> = Vec::new();
        let mut uncache: Vec<String> = Vec::new();
        let mut restore: Vec<String> = Vec::new();
        for c in st.changes.iter().chain(st.untracked.iter()) {
            if !want.contains(&c.path) {
                continue;
            }
            if c.untracked {
                delete.push(c.path.clone());
            } else if c.index == "A" && !c.conflict {
                uncache.push(c.path.clone());
            } else {
                restore.push(c.path.clone());
                if let Some(o) = &c.orig {
                    // 이름이 바뀐 파일은 원래 경로도 되살려야 원상태가 된다.
                    restore.push(o.clone());
                }
            }
        }

        for rel in &delete {
            let abs = root.join(rel);
            std::fs::remove_file(&abs).map_err(|e| format!("{rel} 삭제 실패: {e}"))?;
        }
        if !uncache.is_empty() {
            run_with_paths(&root, &["rm", "-q", "--cached", "-r"], &uncache)?;
        }
        if !restore.is_empty() {
            run_with_paths(&root, &["checkout", "-q", "HEAD"], &restore)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── 커밋 ────────────────────────────── */

/// 선택한 파일만 커밋한다.
///
/// IntelliJ 와 같은 규칙 — 화면에서 **체크한 것만** 커밋에 들어간다. 그래서 커밋 직전에
/// 인덱스를 화면과 맞춘다: 체크되지 않았는데 스테이지에 올라와 있는 파일은 내리고,
/// 체크된 파일은 올린 뒤 커밋한다(그래야 다른 도구가 올려 둔 변경이 딸려 들어가지 않는다).
#[tauri::command]
pub async fn git_commit(
    home: String,
    message: String,
    paths: Vec<String>,
    amend: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let msg = message.trim().to_string();
        if msg.is_empty() {
            return Err("커밋 메시지를 입력하세요.".to_string());
        }
        if paths.is_empty() {
            return Err("커밋할 파일을 선택하세요.".to_string());
        }
        let root = repo_root(&home)?;
        let want: HashSet<String> = paths.into_iter().collect();
        let st = collect_status(&root)?;

        let mut add: Vec<String> = Vec::new();
        let mut drop: Vec<String> = Vec::new();
        for c in st.changes.iter().chain(st.untracked.iter()) {
            let target = if want.contains(&c.path) {
                &mut add
            } else if c.staged {
                &mut drop
            } else {
                continue;
            };
            target.push(c.path.clone());
            if let Some(o) = &c.orig {
                target.push(o.clone());
            }
        }
        if add.is_empty() {
            return Err("선택한 파일에 커밋할 변경이 없습니다.".to_string());
        }
        if !drop.is_empty() && run_with_paths(&root, &["reset", "-q"], &drop).is_err() {
            // 첫 커밋 전이면 reset 이 실패한다 — 그때는 인덱스에서 빼는 것으로 갈음한다.
            let _ = run_with_paths(&root, &["rm", "-q", "--cached", "-r"], &drop);
        }
        run_with_paths(&root, &["add", "-A"], &add)?;

        let mut args: Vec<&str> = vec!["commit", "-m", &msg];
        if amend {
            args.push("--amend");
        }
        run_log(&root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── 원격 ────────────────────────────── */

/// 현재 브랜치를 push 한다. upstream 이 없으면 `-u origin HEAD` 로 붙이면서 올린다.
/// `force` 는 `--force-with-lease`(남의 커밋을 덮어쓰지 않는 강제 푸시)만 허용한다.
#[tauri::command]
pub async fn git_push(home: String, force: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        let st = collect_status(&root)?;
        let mut args: Vec<&str> = vec!["push"];
        if force {
            args.push("--force-with-lease");
        }
        if st.upstream.is_none() {
            args.extend_from_slice(&["-u", "origin", "HEAD"]);
        }
        run_log(&root, &args)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 원격 상태만 갱신한다(가져오되 합치지 않음) — ahead/behind 숫자를 최신으로 만든다.
#[tauri::command]
pub async fn git_fetch(home: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        run_log(&root, &["fetch", "--prune"])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 원격 변경을 받아 합친다(IntelliJ 의 Update Project). 사용자의 `pull.rebase` 설정을 그대로 따른다.
#[tauri::command]
pub async fn git_pull(home: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        run_log(&root, &["pull"])
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── stash ────────────────────────────── */

/// 변경을 보관한다(Stash Changes). `paths` 가 비어 있으면 전체를 보관한다.
///
/// `include_untracked` 는 추적되지 않는 파일까지 담는다 — 끄면 새로 만든 파일은 그대로 남는다.
#[tauri::command]
pub async fn git_stash_push(
    home: String,
    message: String,
    include_untracked: bool,
    paths: Vec<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        let msg = message.trim().to_string();
        let mut args: Vec<String> = vec!["stash".into(), "push".into()];
        if include_untracked {
            args.push("--include-untracked".into());
        }
        if !msg.is_empty() {
            args.push("-m".into());
            args.push(msg);
        }
        if !paths.is_empty() {
            args.push("--".into());
            args.extend(paths);
        }
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_log(&root, &refs)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 보관해 둔 변경을 되살린다(Unstash Changes). `pop` 이면 되살린 뒤 목록에서 지운다.
#[tauri::command]
pub async fn git_stash_apply(home: String, index: usize, pop: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        let name = format!("stash@{{{index}}}");
        run_log(&root, &["stash", if pop { "pop" } else { "apply" }, &name])
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 보관 항목을 버린다(되살리지 않고 삭제).
#[tauri::command]
pub async fn git_stash_drop(home: String, index: usize) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = repo_root(&home)?;
        let name = format!("stash@{{{index}}}");
        run_log(&root, &["stash", "drop", &name])
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_with_tracking() {
        let mut st = GitStatus::default();
        parse_branch("main...origin/main [ahead 2, behind 3]", &mut st);
        assert_eq!(st.branch, "main");
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!((st.ahead, st.behind), (2, 3));
    }

    #[test]
    fn parses_branch_without_upstream() {
        let mut st = GitStatus::default();
        parse_branch("feature/x", &mut st);
        assert_eq!(st.branch, "feature/x");
        assert!(st.upstream.is_none());
    }

    /// 첫 커밋 전과 detached 는 브랜치명이 아니라 상태 문구가 온다 — 그걸 브랜치명으로
    /// 잘못 읽으면 push 가 이상한 이름으로 나간다.
    #[test]
    fn parses_special_heads() {
        let mut fresh = GitStatus::default();
        parse_branch("No commits yet on main", &mut fresh);
        assert!(fresh.no_commits);
        assert_eq!(fresh.branch, "main");

        let mut det = GitStatus::default();
        parse_branch("HEAD (no branch)", &mut det);
        assert!(det.detached);
    }

    /// 충돌(UU)은 staged 로 잡히면 안 된다 — 커밋 화면에서 해결 전에 딸려 들어간다.
    #[test]
    fn conflict_is_not_staged() {
        let c = make_change('U', 'U', "a.txt".into(), None);
        assert!(c.conflict && !c.staged && c.unstaged);
    }

    #[test]
    fn untracked_is_flagged() {
        let c = make_change('?', '?', "new.txt".into(), None);
        assert!(c.untracked && !c.staged);
    }

    /// 경로 인자 앞에는 항상 `--` 가 붙어야 한다(`-` 로 시작하는 파일명이 옵션이 되지 않게).
    #[test]
    fn paths_are_separated_by_double_dash() {
        let args = with_paths(&["add", "-A"], &["-weird.txt".to_string()]);
        assert_eq!(args, vec!["add", "-A", "--", "-weird.txt"]);
    }

    /// 진짜 저장소를 하나 만들어 `--porcelain=v1 -z` 를 파싱해 본다.
    ///
    /// 이 테스트가 지키는 것은 **이름이 바뀐 항목이 칸을 두 개 쓴다**는 점이다
    /// (`R  new\0old\0`). 두 번째 칸을 당겨 오지 않으면 그 뒤의 모든 파일이 한 칸씩
    /// 밀려 상태가 통째로 어긋나는데, 목록은 그럴듯하게 채워져서 눈에 띄지 않는다.
    #[test]
    fn collects_status_from_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("myspace-git-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let git = |args: &[&str]| {
            let out = exec(&dir, args).unwrap();
            assert!(out.status.success(), "git {args:?}: {}", err_text(&out, args));
        };
        // 커밋에는 신원이 필요하고, 브랜치명은 사용자의 init.defaultBranch 에 좌우되지 않게 고정한다.
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.email", "test@example.com"]);
        git(&["config", "user.name", "test"]);

        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "init"]);

        // 이름 변경(스테이지) + 수정(작업 트리) + 새 파일(untracked) 세 종류를 함께 만든다.
        git(&["mv", "a.txt", "b.txt"]);
        std::fs::write(dir.join("keep.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("zz-new.txt"), "new\n").unwrap();

        let st = collect_status(&dir).unwrap();
        assert_eq!(st.branch, "main");
        assert!(!st.no_commits && !st.detached);

        let renamed = st
            .changes
            .iter()
            .find(|c| c.path == "b.txt")
            .expect("이름이 바뀐 파일이 목록에 있어야 한다");
        assert_eq!(renamed.orig.as_deref(), Some("a.txt"));
        assert!(renamed.staged);

        let modified = st
            .changes
            .iter()
            .find(|c| c.path == "keep.txt")
            .expect("수정된 파일이 목록에 있어야 한다");
        assert!(modified.unstaged && !modified.staged);

        assert_eq!(st.untracked.len(), 1);
        assert_eq!(st.untracked[0].path, "zz-new.txt");
        // 이름 변경의 원래 경로(a.txt)가 별도 항목으로 새어 나오면 안 된다.
        assert!(!st.changes.iter().any(|c| c.path == "a.txt"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
