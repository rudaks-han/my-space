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
//! 서버가 평문(389)이라 TLS 없이 `ldap://` 로 붙는다. 로그인 성공 여부와 표시용
//! 사용자 정보(이름·이메일)만 프론트로 돌려주고, "로그인 유지/자동 로그인"은 프론트가
//! localStorage 에서 관리한다(자동 로그인이 켜져 있으면 다음 실행부터 LDAP 요청 없이 통과).

use ldap3::{LdapConnAsync, Scope, SearchEntry};
use serde::Serialize;

/// 사내 LDAP 서버(평문, 389).
const LDAP_URL: &str = "ldap://211.63.24.1:389";
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

/// 아이디·비밀번호로 LDAP 인증한다. 성공하면 표시용 사용자 정보를, 실패하면
/// 사용자에게 보여 줄 한국어 오류 메시지를 돌려준다.
#[tauri::command]
pub async fn ldap_login(username: String, password: String) -> Result<LdapUser, String> {
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("아이디와 비밀번호를 입력하세요.".into());
    }

    let (conn, mut ldap) = LdapConnAsync::new(LDAP_URL)
        .await
        .map_err(|e| format!("LDAP 서버에 연결하지 못했습니다: {e}"))?;
    // 연결 구동기를 백그라운드 태스크로 돌린다(tauri 의 tokio 런타임 위에서 동작).
    ldap3::drive!(conn);

    // 1) 서비스 계정으로 바인드 — 사용자 검색 권한 확보.
    ldap.simple_bind(BIND_DN, BIND_PW)
        .await
        .map_err(|e| format!("LDAP 연결 오류: {e}"))?
        .success()
        .map_err(|_| "LDAP 서비스 계정 인증에 실패했습니다. 관리자에게 문의하세요.".to_string())?;

    // 2) 사용자 검색 — 아이디를 여러 속성 중 하나에 맞춰도 찾도록 OR 필터.
    let esc = escape_filter(&username);
    let filter = format!(
        "(|(sAMAccountName={esc})(userPrincipalName={esc})(mail={esc})(cn={esc})(uid={esc}))"
    );
    let (entries, _res) = ldap
        .search(
            BASE_DN,
            Scope::Subtree,
            &filter,
            vec![
                "displayName",
                "cn",
                "mail",
                "sAMAccountName",
                "userPrincipalName",
            ],
        )
        .await
        .map_err(|e| format!("사용자 검색 오류: {e}"))?
        .success()
        .map_err(|e| format!("사용자 검색 오류: {e}"))?;

    let entry = entries
        .into_iter()
        .next()
        .ok_or_else(|| "존재하지 않는 사용자입니다.".to_string())?;
    let se = SearchEntry::construct(entry);
    let user_dn = se.dn.clone();
    if user_dn.is_empty() {
        return Err("사용자 DN 을 확인하지 못했습니다.".into());
    }

    // 3) 사용자 DN + 입력 비밀번호로 재바인드 → 실제 인증.
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
