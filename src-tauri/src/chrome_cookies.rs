//! 로컬 Chrome 의 로그인 쿠키 재사용.
//!
//! macOS 의 Chrome 은 쿠키를 `~/Library/Application Support/Google/Chrome/<Profile>/Network/Cookies`
//! (SQLite)에 저장하고, 값은 AES-128-CBC 로 암호화한다. 복호화 키는 Keychain 의
//! `Chrome Safe Storage` 항목 비밀번호를 PBKDF2(HMAC-SHA1, salt="saltysalt", 1003회)로
//! 늘려서 만든 16바이트다.
//!
//! 지금 쓰는 곳은 `flex.rs` 하나다 — Chrome 에 flex.team 로그인 세션이 있으면 그 쿠키로
//! 바로 API 를 호출해, 앱에서 다시 로그인하지 않아도 되게 한다.
//!
//! 전부 best-effort 다 — Chrome 미설치·미로그인·Keychain 거부 등은 에러가 아니라
//! "쿠키 없음"으로 처리하고, 호출부가 원래의 로그인 경로로 넘어간다.

use std::path::PathBuf;
use std::process::Command;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use pbkdf2::pbkdf2_hmac;
use rusqlite::{Connection, OpenFlags};
use sha1::Sha1;

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// 복호화까지 끝난 하나의 쿠키.
pub struct ChromeCookie {
    pub name: String,
    pub value: String,
    /// 1970 기준 만료 시각(초). None 이면 세션 쿠키.
    pub expires_unix: Option<f64>,
}

/// Keychain 에서 Chrome 마스터 비밀번호를 읽는다.
/// (이 호출이 최초 1회 Keychain 접근 허용 프롬프트를 띄운다.)
fn chrome_safe_storage_password() -> Result<String, String> {
    let out = Command::new("security")
        .args([
            "find-generic-password",
            "-w",
            "-s",
            "Chrome Safe Storage",
            "-a",
            "Chrome",
        ])
        .output()
        .map_err(|e| format!("security 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err("Keychain 에서 Chrome Safe Storage 키를 찾지 못함".into());
    }
    let pw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if pw.is_empty() {
        return Err("Chrome Safe Storage 키가 비어 있음".into());
    }
    Ok(pw)
}

/// Chrome 비밀번호 → AES 키(16바이트).
fn derive_key(password: &str) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
    key
}

/// Chrome 이 암호화한 쿠키 값을 평문으로 되돌린다.
fn decrypt_value(enc: &[u8], key: &[u8; 16]) -> Option<String> {
    // "v10" 접두사가 없으면 암호화 안 된 평문(구버전/일부 항목).
    if enc.len() < 3 || &enc[0..3] != b"v10" {
        return String::from_utf8(enc.to_vec()).ok();
    }
    let iv = [0x20u8; 16]; // 공백(0x20) 16개
    let cipher = Aes128CbcDec::new(GenericArray::from_slice(key), GenericArray::from_slice(&iv));
    let pt = cipher.decrypt_padded_vec_mut::<Pkcs7>(&enc[3..]).ok()?;
    // 최신 Chrome 은 평문 앞에 32바이트 SHA256(domain) 해시를 붙인다.
    // 전체를 UTF-8 로 읽어 첫 글자가 제어문자가 아니면 접두사 없는 옛 형식,
    // 아니면 앞 32바이트를 떼고 다시 시도한다.
    if let Ok(s) = std::str::from_utf8(&pt) {
        if s.chars().next().map_or(true, |c| !c.is_control()) {
            return Some(s.to_string());
        }
    }
    if pt.len() > 32 {
        if let Ok(s) = String::from_utf8(pt[32..].to_vec()) {
            return Some(s);
        }
    }
    None
}

/// Chrome 쿠키 DB 경로를 찾는다(Default 우선, 없으면 다른 프로필).
fn find_cookies_db() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = PathBuf::from(home).join("Library/Application Support/Google/Chrome");

    // Chrome 96+ 는 <Profile>/Network/Cookies, 그 이전은 <Profile>/Cookies.
    let candidate = |profile: &str| -> Option<PathBuf> {
        for rel in ["Network/Cookies", "Cookies"] {
            let p = base.join(profile).join(rel);
            if p.is_file() {
                return Some(p);
            }
        }
        None
    };

    if let Some(p) = candidate("Default") {
        return Some(p);
    }
    // Default 가 없으면 Profile * 중 첫 번째.
    let entries = std::fs::read_dir(&base).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("Profile") {
            if let Some(p) = candidate(&name) {
                return Some(p);
            }
        }
    }
    None
}

/// 임시 디렉터리 경로(스크래치용). 잠긴 원본을 복사해 읽기 위해 사용.
fn temp_copy_path() -> PathBuf {
    std::env::temp_dir().join("myspace-chrome-cookies.sqlite")
}

/// Chrome 에서 `host`(서브도메인 포함) 쿠키를 읽어 복호화한다.
/// 예: `read_cookies_for_host("flex.team")` → `flex.team` + `*.flex.team`.
pub fn read_cookies_for_host(host: &str) -> Result<Vec<ChromeCookie>, String> {
    let db = find_cookies_db().ok_or_else(|| "Chrome 쿠키 DB 를 찾지 못함".to_string())?;

    // Chrome 이 실행 중이면 DB 가 잠겨 있을 수 있어 복사본을 읽는다.
    let tmp = temp_copy_path();
    std::fs::copy(&db, &tmp).map_err(|e| format!("쿠키 DB 복사 실패: {e}"))?;

    let password = chrome_safe_storage_password()?;
    let key = derive_key(&password);

    let conn = Connection::open_with_flags(&tmp, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("쿠키 DB 열기 실패: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT name, encrypted_value, expires_utc \
             FROM cookies WHERE host_key = ?1 OR host_key LIKE ?2",
        )
        .map_err(|e| format!("쿼리 준비 실패: {e}"))?;

    let rows = stmt
        .query_map(rusqlite::params![host, format!("%.{host}")], |row| {
            let name: String = row.get(0)?;
            let enc: Vec<u8> = row.get(1)?;
            let expires: i64 = row.get(2)?;
            Ok((name, enc, expires))
        })
        .map_err(|e| format!("쿼리 실행 실패: {e}"))?;

    let mut cookies = Vec::new();
    for row in rows.flatten() {
        let (name, enc, expires) = row;
        let Some(value) = decrypt_value(&enc, &key) else {
            continue;
        };
        // Chrome expires_utc 는 1601-01-01 기준 마이크로초. 0 이면 세션 쿠키.
        let expires_unix = if expires == 0 {
            None
        } else {
            Some((expires as f64) / 1_000_000.0 - 11_644_473_600.0)
        };
        cookies.push(ChromeCookie {
            name,
            value,
            expires_unix,
        });
    }

    // 복사본 정리(실패 무시).
    let _ = std::fs::remove_file(&tmp);

    Ok(cookies)
}
