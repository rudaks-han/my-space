//! 사내 LDAP 로그인.
//!
//! 흐름은 "서비스 계정 바인드 → 사용자 검색 → 사용자 DN 재바인드" 세 단계다.
//!  1. 고정 서비스 계정(BIND_DN)으로 바인드해 디렉터리를 검색할 권한을 얻는다.
//!  2. 사용자가 입력한 아이디로 base DN 아래에서 해당 사용자의 엔트리(DN)를 찾는다.
//!     사내는 AD 계열이라 아이디를 sAMAccountName·userPrincipalName·mail·cn·uid 중
//!     어디에 맞춰 입력해도 걸리도록 OR 필터로 찾는다.
//!  3. 찾은 사용자 DN + 사용자가 입력한 비밀번호로 다시 바인드한다. 이 바인드가 성공하면
//!     비밀번호가 맞는 것이므로 인증 성공이다(rc == 0).
//!
//! 로그인은 평문(389)으로 붙는다. 로그인 성공 여부와 표시용 사용자 정보(이름·이메일)만
//! 프론트로 돌려주고, "로그인 유지/자동 로그인"은 프론트가 localStorage 에서 관리한다
//! (자동 로그인이 켜져 있으면 다음 실행부터 LDAP 요청 없이 통과). 비밀번호는 어디에도
//! 저장하지 않는다.
//!
//! # 비밀번호 변경
//!
//! `ldap_change_password` 는 위 세 단계 뒤에 한 단계를 더 붙인 것이다 — 사용자 DN 으로
//! 바인드한 상태에서 자기 `unicodePwd` 를 `Delete(옛 값)` + `Add(새 값)` **한 번의 modify**
//! 로 바꾼다. 이 조합이 AD 의 "본인 비밀번호 변경"이고, 관리자 권한이 필요한 `Replace`
//! (= 관리자 리셋)와 달리 도메인 정책(길이·복잡도·히스토리·최소 사용 기간)이 그대로 적용된다.
//! 세 가지가 이 구현의 모양을 정한다:
//!
//! - **평문 389 로는 불가능하다.** AD 는 암호화되지 않은 연결에서 `unicodePwd` 수정을
//!   거부하므로(unwillingToPerform) 이 경로만 `ldaps://…:636` 을 쓴다. 로그인 경로를
//!   LDAPS 로 함께 올리지 않은 것은 의도다 — 지금 동작하는 로그인을 인증서 사정에
//!   묶지 않기 위해서다.
//! - **인증서 검증을 끈다.** 사내 DC 의 인증서(Sectigo 와일드카드)가 만료돼 있어 검증을
//!   켜면 연결 자체가 실패한다. 사내망 + 이미 서비스 계정 자격증명이 이 파일에 박혀 있는
//!   상황이라 실익보다 "기능이 아예 안 되는" 쪽이 크다는 판단이다. 인증서가 갱신되면
//!   `NO_TLS_VERIFY` 를 false 로 되돌릴 것.
//! - **값은 UTF-16LE 로 감싼 따옴표 포함 문자열이다.** `"newpass"` 를 그대로 UTF-16LE 로
//!   인코딩한 바이트가 `unicodePwd` 의 값이다. 따옴표를 빼면 AD 가 조용히 거부한다.

use std::collections::HashSet;

use ldap3::{Ldap, LdapConnAsync, LdapConnSettings, Mod, Scope, SearchEntry};
use serde::Serialize;

/// 사내 LDAP 서버(평문, 389). 로그인·조회용.
const LDAP_URL: &str = "ldap://211.63.24.1:389";
/// 같은 서버의 LDAPS(636). 비밀번호 변경은 이쪽으로만 가능하다.
const LDAPS_URL: &str = "ldaps://211.63.24.1:636";
/// 사내 DC 인증서가 만료 상태라 검증을 끈다(위 모듈 주석 참고).
const NO_TLS_VERIFY: bool = true;
/// 사용자를 찾을 검색 기준점.
const BASE_DN: &str = "ou=스펙트라,dc=spectra,dc=co,dc=kr";
/// 검색용 서비스 계정 DN 과 비밀번호(디렉터리 검색 권한만 가진 공용 계정).
const BIND_DN: &str = "rdmail@spectra.co.kr";
const BIND_PW: &str = "tmvprxmfk!@#";

/// 로그인 성공 시 프론트로 돌려줄 표시용 사용자 정보.
#[derive(Serialize)]
pub struct LdapUser {
    /// 로그인 계정(sAMAccountName). 없으면 입력값을 그대로 쓴다.
    username: String,
    /// 찾은 사용자의 전체 DN.
    dn: String,
    /// 표시 이름(displayName → cn → 입력값 순).
    #[serde(rename = "displayName")]
    display_name: String,
    /// 이메일(mail → userPrincipalName).
    email: String,
}

/// RFC 4515 검색 필터 이스케이프 — 아이디에 `(`, `*`, `\` 등이 들어와도 필터가 깨지지 않게 한다.
fn escape_filter(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\\' => out.push_str("\\5c"),
            '\0' => out.push_str("\\00"),
            _ => out.push(c),
        }
    }
    out
}

/// LDAP 연결을 열고 구동기를 백그라운드 태스크로 돌린다(tauri 의 tokio 런타임 위에서 동작).
/// `secure` 면 LDAPS(636) — 비밀번호 변경 경로만 참을 쓴다.
async fn connect(secure: bool) -> Result<Ldap, String> {
    let url = if secure { LDAPS_URL } else { LDAP_URL };
    let settings = LdapConnSettings::new().set_no_tls_verify(NO_TLS_VERIFY);
    let (conn, ldap) = LdapConnAsync::with_settings(settings, url)
        .await
        .map_err(|e| format!("LDAP 서버에 연결하지 못했습니다: {e}"))?;
    ldap3::drive!(conn);
    Ok(ldap)
}

/// 서비스 계정으로 바인드해 디렉터리를 검색할 권한을 얻는다.
async fn bind_service(ldap: &mut Ldap) -> Result<(), String> {
    ldap.simple_bind(BIND_DN, BIND_PW)
        .await
        .map_err(|e| format!("LDAP 연결 오류: {e}"))?
        .success()
        .map_err(|_| "LDAP 서비스 계정 인증에 실패했습니다. 관리자에게 문의하세요.".to_string())?;
    Ok(())
}

/// 아이디로 사용자 엔트리를 찾는다 — 아이디를 sAMAccountName·UPN·mail·cn·uid 중
/// 어디에 맞춰 입력해도 걸리도록 OR 필터로 찾는다.
async fn find_user(
    ldap: &mut Ldap,
    username: &str,
    attrs: Vec<&str>,
) -> Result<SearchEntry, String> {
    let esc = escape_filter(username);
    let filter = format!(
        "(|(sAMAccountName={esc})(userPrincipalName={esc})(mail={esc})(cn={esc})(uid={esc}))"
    );
    let (entries, _res) = ldap
        .search(BASE_DN, Scope::Subtree, &filter, attrs)
        .await
        .map_err(|e| format!("사용자 검색 오류: {e}"))?
        .success()
        .map_err(|e| format!("사용자 검색 오류: {e}"))?;

    let entry = entries
        .into_iter()
        .next()
        .ok_or_else(|| "존재하지 않는 사용자입니다.".to_string())?;
    let se = SearchEntry::construct(entry);
    if se.dn.is_empty() {
        return Err("사용자 DN 을 확인하지 못했습니다.".into());
    }
    Ok(se)
}

/// 아이디·비밀번호로 LDAP 인증한다. 성공하면 표시용 사용자 정보를, 실패하면
/// 사용자에게 보여 줄 한국어 오류 메시지를 돌려준다.
#[tauri::command]
pub async fn ldap_login(username: String, password: String) -> Result<LdapUser, String> {
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("아이디와 비밀번호를 입력하세요.".into());
    }

    let mut ldap = connect(false).await?;
    bind_service(&mut ldap).await?;
    let se = find_user(
        &mut ldap,
        &username,
        vec![
            "displayName",
            "cn",
            "mail",
            "sAMAccountName",
            "userPrincipalName",
        ],
    )
    .await?;
    let user_dn = se.dn.clone();

    // 사용자 DN + 입력 비밀번호로 재바인드 → 실제 인증.
    let result = ldap
        .simple_bind(&user_dn, &password)
        .await
        .map_err(|e| format!("인증 오류: {e}"))?;
    let ok = result.rc == 0;
    let _ = ldap.unbind().await;
    if !ok {
        return Err("아이디 또는 비밀번호가 올바르지 않습니다.".into());
    }

    // 표시용 정보 추출(첫 값만).
    let attr1 = |k: &str| se.attrs.get(k).and_then(|v| v.first()).cloned();
    let display_name = attr1("displayName")
        .or_else(|| attr1("cn"))
        .unwrap_or_else(|| username.clone());
    let email = attr1("mail")
        .or_else(|| attr1("userPrincipalName"))
        .unwrap_or_default();
    let account = attr1("sAMAccountName").unwrap_or_else(|| username.clone());

    Ok(LdapUser {
        username: account,
        dn: user_dn,
        display_name,
        email,
    })
}

// ─────────────────────────── 비밀번호 변경 ───────────────────────────

/// 도메인 정책이 걸려 있는 노드. `BASE_DN`(조직 OU)이 아니라 도메인 루트에 있다.
const DOMAIN_DN: &str = "dc=spectra,dc=co,dc=kr";

/// AD 시각(FILETIME, 1601-01-01 부터 100ns 단위)을 Unix epoch 밀리초로.
fn filetime_to_epoch_ms(ft: i64) -> i64 {
    ft / 10_000 - 11_644_473_600_000
}

/// AD 의 기간 값(음수 FILETIME 간격)을 일 단위로. 0 이거나 "영원"이면 None.
fn interval_to_days(v: i64) -> Option<f64> {
    // -864_000_000_000 = 1일. i64::MIN 은 "만료 없음"의 관용 표현이다.
    if v == 0 || v == i64::MIN {
        return None;
    }
    Some(-v as f64 / 864_000_000_000.0)
}

/// 비밀번호 변경 화면이 규칙과 만료일을 안내하는 데 쓰는 값. 정책을 하드코딩하지 않고
/// 매번 읽는 이유는, 관리자가 정책을 바꾸면 화면이 조용히 거짓말을 하게 되기 때문이다.
#[derive(Serialize, Default)]
pub struct PasswordPolicy {
    /// 최소 길이(minPwdLength).
    #[serde(rename = "minLength")]
    min_length: u32,
    /// 복잡도 요구 여부(pwdProperties 의 DOMAIN_PASSWORD_COMPLEX 비트).
    complexity: bool,
    /// 재사용 금지 개수(pwdHistoryLength).
    #[serde(rename = "historyLength")]
    history_length: u32,
    /// 만료 주기(일). 만료 없음이면 null.
    #[serde(rename = "maxAgeDays")]
    max_age_days: Option<f64>,
    /// 변경 후 재변경까지 기다려야 하는 기간(일). 없으면 null.
    #[serde(rename = "minAgeDays")]
    min_age_days: Option<f64>,
    /// 마지막 변경 시각(epoch ms). 0(다음 로그온 시 변경)이면 null.
    #[serde(rename = "lastSetAt")]
    last_set_at: Option<i64>,
    /// 만료 예정 시각(epoch ms). 만료 없는 계정이거나 계산할 수 없으면 null.
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    /// 계정에 "비밀번호 사용 기간 제한 없음"이 걸려 있는지(userAccountControl).
    #[serde(rename = "neverExpires")]
    never_expires: bool,
}

/// 엔트리에서 정수 속성 하나를 읽는다.
fn attr_i64(se: &SearchEntry, key: &str) -> Option<i64> {
    se.attrs.get(key)?.first()?.parse().ok()
}

/// 도메인 비밀번호 정책과 이 사용자의 만료 예정일을 읽는다. 조회만 하므로 평문 389 로 붙는다.
#[tauri::command]
pub async fn ldap_password_policy(username: String) -> Result<PasswordPolicy, String> {
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("아이디가 비어 있습니다.".into());
    }

    let mut ldap = connect(false).await?;
    bind_service(&mut ldap).await?;

    // 1) 도메인 정책.
    let (entries, _res) = ldap
        .search(
            DOMAIN_DN,
            Scope::Base,
            "(objectClass=*)",
            vec![
                "minPwdLength",
                "pwdProperties",
                "pwdHistoryLength",
                "maxPwdAge",
                "minPwdAge",
            ],
        )
        .await
        .map_err(|e| format!("정책 조회 오류: {e}"))?
        .success()
        .map_err(|e| format!("정책 조회 오류: {e}"))?;
    let domain = entries
        .into_iter()
        .next()
        .map(SearchEntry::construct)
        .ok_or_else(|| "도메인 정책을 읽지 못했습니다.".to_string())?;

    let mut policy = PasswordPolicy {
        min_length: attr_i64(&domain, "minPwdLength").unwrap_or(0) as u32,
        // pwdProperties 의 1번 비트가 DOMAIN_PASSWORD_COMPLEX.
        complexity: attr_i64(&domain, "pwdProperties").unwrap_or(0) & 1 != 0,
        history_length: attr_i64(&domain, "pwdHistoryLength").unwrap_or(0) as u32,
        max_age_days: attr_i64(&domain, "maxPwdAge").and_then(interval_to_days),
        min_age_days: attr_i64(&domain, "minPwdAge").and_then(interval_to_days),
        ..Default::default()
    };

    // 2) 이 사용자의 마지막 변경 시각 → 만료 예정일.
    let se = find_user(
        &mut ldap,
        &username,
        vec!["pwdLastSet", "userAccountControl"],
    )
    .await?;
    let _ = ldap.unbind().await;

    // userAccountControl 의 DONT_EXPIRE_PASSWORD(0x10000).
    policy.never_expires = attr_i64(&se, "userAccountControl").unwrap_or(0) & 0x1_0000 != 0;
    // pwdLastSet 0 은 "다음 로그온 시 반드시 변경" — 시각이 아니므로 만료일도 없다.
    let last_set = attr_i64(&se, "pwdLastSet").filter(|v| *v > 0);
    policy.last_set_at = last_set.map(filetime_to_epoch_ms);
    if !policy.never_expires {
        if let (Some(ms), Some(days)) = (policy.last_set_at, policy.max_age_days) {
            policy.expires_at = Some(ms + (days * 86_400_000.0) as i64);
        }
    }

    Ok(policy)
}

/// `unicodePwd` 에 넣을 값 — 따옴표로 감싼 뒤 UTF-16LE 로 인코딩한 바이트.
/// 따옴표를 빼면 AD 가 값을 받아들이지 않는다.
fn encode_unicode_pwd(password: &str) -> Vec<u8> {
    format!("\"{password}\"")
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect()
}

/// AD 가 modify 실패로 돌려주는 진단 문자열을 사용자용 한국어 메시지로 옮긴다.
/// AD 는 실패 사유를 rc 가 아니라 메시지 앞머리의 16진 코드로 구분하므로 그쪽을 먼저 본다.
fn change_error(rc: u32, text: &str) -> String {
    if text.contains("0000052D") {
        return "새 비밀번호가 도메인 정책에 맞지 않습니다. 길이·복잡도 규칙을 지켰는지, \
                최근에 썼던 비밀번호는 아닌지, 마지막 변경 후 최소 사용 기간이 지났는지 확인하세요."
            .into();
    }
    if text.contains("00000056") {
        return "현재 비밀번호가 올바르지 않습니다.".into();
    }
    match rc {
        50 => "비밀번호를 변경할 권한이 없습니다. 관리자에게 문의하세요.".into(),
        53 => format!("서버가 비밀번호 변경을 거부했습니다. ({text})"),
        _ => format!("비밀번호 변경에 실패했습니다. (코드 {rc}: {text})"),
    }
}

/// 사내 LDAP 비밀번호를 바꾼다. 현재 비밀번호로 본인 확인(바인드)을 한 뒤, 그 세션에서
/// 자기 `unicodePwd` 를 Delete(옛)+Add(새) 로 수정한다 — AD 의 "본인 변경" 방식이라
/// 관리자 권한 없이 되고 도메인 정책도 그대로 걸린다.
#[tauri::command]
pub async fn ldap_change_password(
    username: String,
    current_password: String,
    new_password: String,
) -> Result<(), String> {
    let username = username.trim().to_string();
    let current = current_password;
    let new = new_password;
    if username.is_empty() || current.is_empty() || new.is_empty() {
        return Err("현재 비밀번호와 새 비밀번호를 모두 입력하세요.".into());
    }
    if current == new {
        return Err("새 비밀번호가 현재 비밀번호와 같습니다.".into());
    }

    // 사용자 DN 은 서비스 계정으로 찾는다(로그인과 같은 경로).
    let mut ldap = connect(true).await?;
    bind_service(&mut ldap).await?;
    let se = find_user(&mut ldap, &username, vec!["sAMAccountName"]).await?;
    let user_dn = se.dn.clone();

    // 본인 확인 — 이 바인드가 성공해야 이후 modify 가 "자기 비밀번호 변경"으로 취급된다.
    // 실패는 잠금 카운터를 올리므로(도메인 정책상 5회) 메시지로 그 사실을 알린다.
    let bound = ldap
        .simple_bind(&user_dn, &current)
        .await
        .map_err(|e| format!("인증 오류: {e}"))?;
    if bound.rc != 0 {
        let _ = ldap.unbind().await;
        return Err(
            "현재 비밀번호가 올바르지 않습니다. 여러 번 틀리면 계정이 잠길 수 있습니다.".into(),
        );
    }

    let mods = vec![
        Mod::Delete(
            b"unicodePwd".to_vec(),
            HashSet::from([encode_unicode_pwd(&current)]),
        ),
        Mod::Add(
            b"unicodePwd".to_vec(),
            HashSet::from([encode_unicode_pwd(&new)]),
        ),
    ];
    let res = ldap
        .modify(&user_dn, mods)
        .await
        .map_err(|e| format!("비밀번호 변경 요청 오류: {e}"))?;
    let _ = ldap.unbind().await;

    if res.rc != 0 {
        return Err(change_error(res.rc, &res.text));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AD 가 요구하는 형식 — 따옴표로 감싼 UTF-16LE. 여기가 틀리면 서버는 이유를
    /// 알려 주지 않고 거부만 하므로 형식을 테스트로 붙든다.
    #[test]
    fn encodes_unicode_pwd_as_quoted_utf16le() {
        assert_eq!(
            encode_unicode_pwd("ab"),
            vec![b'"', 0, b'a', 0, b'b', 0, b'"', 0]
        );
        // 비ASCII 도 UTF-16 코드 유닛으로 나간다(한글 '가' = U+AC00).
        assert_eq!(encode_unicode_pwd("가"), vec![b'"', 0, 0x00, 0xAC, b'"', 0]);
    }

    /// 실제 도메인에서 읽은 값으로 환산을 확인한다(maxPwdAge 31일, minPwdAge 1일).
    #[test]
    fn converts_ad_intervals_to_days() {
        assert_eq!(interval_to_days(-26_784_000_000_000), Some(31.0));
        assert_eq!(interval_to_days(-864_000_000_000), Some(1.0));
        assert_eq!(interval_to_days(0), None);
        assert_eq!(interval_to_days(i64::MIN), None);
    }

    #[test]
    fn converts_filetime_to_epoch() {
        // 1970-01-01T00:00:00Z 의 FILETIME.
        assert_eq!(filetime_to_epoch_ms(116_444_736_000_000_000), 0);
    }

    /// 사내망에서만 도는 통합 테스트 — 비밀번호 변경이 실제로 쓰는 LDAPS(636) 경로가
    /// 열리는지 확인한다. 이 경로는 평문 389 를 쓰는 로그인·정책 조회로는 검증되지 않고,
    /// 사내 DC 인증서가 만료돼 있어 `NO_TLS_VERIFY` 가 실제로 먹히는지도 여기서만 드러난다.
    /// **비밀번호는 바꾸지 않는다** — 연결과 서비스 계정 바인드까지만 한다.
    ///
    /// `cargo test --lib auth::tests::connects_over_ldaps -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "사내망 + 실제 LDAP 서버가 필요하다"]
    async fn connects_over_ldaps() {
        let mut ldap = connect(true).await.expect("LDAPS 연결 실패");
        bind_service(&mut ldap).await.expect("서비스 계정 바인드 실패");
        let se = find_user(&mut ldap, "kmhan", vec!["sAMAccountName"])
            .await
            .expect("사용자 검색 실패");
        assert!(se.dn.contains("DC=spectra"), "예상 밖의 DN: {}", se.dn);
        let _ = ldap.unbind().await;
    }

    /// 정책 위반은 rc 가 아니라 메시지의 16진 코드로 구분된다.
    #[test]
    fn maps_ad_diagnostics_to_korean() {
        let msg = change_error(19, "0000052D: AtrErr: DSID-03191083");
        assert!(msg.contains("도메인 정책"));
        assert!(change_error(19, "00000056: AtrErr").contains("현재 비밀번호"));
        assert!(change_error(50, "").contains("권한"));
    }
}
