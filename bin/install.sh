#!/usr/bin/env bash
#
# bin/install.sh
#
# My Space 설치파일(.dmg)을 만든다. `bun run tauri build` 를 감싼 것으로,
# PATH 준비 · 의존성 설치 · 산출물 위치 안내까지 한 번에 처리한다.
#
# 배경:
#   - bun 과 cargo 가 PATH 에 없는 셸에서 그냥 실행하면 엉뚱한 에러가 난다.
#     (CLAUDE.md 의 "Commands" 절과 같은 준비를 스크립트가 대신한다.)
#   - 첫 컴파일은 rdkafka 가 librdkafka(C)를 번들 소스에서 빌드해 수 분 걸린다.
#     이후에는 증분이라 훨씬 빠르다.
#   - 서명은 하지 않는다(adhoc). macOS 15 부터 "우클릭 → 열기" 우회가 사라져서,
#     받은 사람은 quarantine 속성을 직접 지워야 앱이 열린다(설치가이드.md).
#     제대로 서명하려면 Apple Developer Program 가입 후 APPLE_* 환경변수가
#     필요하다 — .github/workflows/release.yml 참고.
#
# ⚠️ "hdiutil: create failed - 작업이 허용되지 않음" 으로 .dmg 단계가 실패하는 환경이 있다.
#    tauri 의 bundle_dmg.sh 는 임시 볼륨을 /Volumes 에 마운트해 앱을 복사하는데, 그 쓰기가
#    EPERM 으로 막히는 것이다(읽기·목록은 되고 쓰기만 막혀 원인이 잘 안 보인다). 원인은 둘:
#      1) 터미널 앱의 TCC 권한 — 전체 디스크 접근 권한을 주고 앱을 재시작하면 풀린다.
#      2) 사내 보안(DLP)/EndpointSecurity 에이전트의 이동식 볼륨 쓰기 차단 — **권한을 줘도
#         안 풀린다.** 실측: 전체 디스크 접근 권한이 있는데도 /Volumes 쓰기는 EPERM 인데,
#         같은 이미지를 홈 아래에 마운트하면 쓰기가 된다(= /Volumes 경로 기준 차단).
#         `systemextensionsctl list` 의 Endpoint Security 확장 목록에서 확인할 수 있다.
#    그래서 아래 사전 점검은 빌드를 막지 않고, 막혀 있으면 .app 만 빌드한 뒤 마운트가
#    필요 없는 방식(hdiutil makehybrid)으로 .dmg 를 직접 굽는다 — 꾸밈(배경·아이콘 배치)만
#    빠지고 드래그 설치는 그대로다.
#
# 사용:
#   ./bin/install.sh              # 현재 아키텍처용 .dmg 생성
#   ./bin/install.sh --universal  # Intel + Apple Silicon 겸용(universal) .dmg 생성
#   ./bin/install.sh --open       # 생성 후 Finder 에서 산출물 폴더 열기
#   ./bin/install.sh --install    # 생성 후 빌드된 .app 을 /Applications 에 설치
#   ./bin/install.sh --help

set -euo pipefail

# 스크립트는 bin/ 아래에 있고, 아래 경로들은 모두 저장소 루트 기준이다.
# --help 이 자기 파일을 다시 읽으므로, cd 로 상대경로가 깨지기 전에 절대경로로 붙잡아 둔다.
SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
cd "$(dirname "$SELF")/.."

UNIVERSAL=false
OPEN_AFTER=false
INSTALL_AFTER=false

for arg in "$@"; do
  case "$arg" in
    --universal) UNIVERSAL=true ;;
    --open) OPEN_AFTER=true ;;
    --install) INSTALL_AFTER=true ;;
    --help | -h)
      # 파일 맨 위 주석 블록(shebang 다음 줄부터 첫 비주석 줄 전까지)이 곧 도움말이다.
      # 줄 번호를 박아두면 헤더를 고칠 때마다 어긋나므로 주석인 동안만 읽는다.
      tail -n +2 "$SELF" | sed -n '/^#/!q;s/^# \{0,1\}//p'
      exit 0
      ;;
    *)
      echo "알 수 없는 옵션: $arg (--help 참고)" >&2
      exit 1
      ;;
  esac
done

# ── PATH 준비 ────────────────────────────────────────────────────────────────
export PATH="$HOME/.bun/bin:$PATH"
if [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi

for cmd in bun cargo; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "✗ '$cmd' 를 찾을 수 없습니다." >&2
    case "$cmd" in
      bun) echo "  설치: curl -fsSL https://bun.sh/install | bash" >&2 ;;
      cargo) echo "  설치: https://rustup.rs" >&2 ;;
    esac
    exit 1
  fi
done

# ── 빌드 대상 결정 ───────────────────────────────────────────────────────────
# tauri 는 --target 을 주면 산출물을 target/<triple>/release/ 밑에 놓고,
# 안 주면 target/release/ 밑에 놓는다. 나중에 .dmg 를 찾으려면 이 차이를 알아야 한다.
if $UNIVERSAL; then
  TRIPLE="universal-apple-darwin"
  for t in x86_64-apple-darwin aarch64-apple-darwin; do
    if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
      echo "→ rust 타겟 설치: $t"
      rustup target add "$t"
    fi
  done
else
  TRIPLE=""
fi

BUNDLE_DIR="src-tauri/target${TRIPLE:+/$TRIPLE}/release/bundle"

VERSION=$(grep -m1 '"version"' src-tauri/tauri.conf.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')
PRODUCT=$(grep -m1 '"productName"' src-tauri/tauri.conf.json | sed 's/.*"productName": *"\([^"]*\)".*/\1/')
# tauri 가 .dmg 이름에 쓰는 아키텍처 표기(우리가 직접 구울 때도 같은 규칙을 쓴다).
if $UNIVERSAL; then
  ARCH_TAG="universal"
else
  case "$(uname -m)" in
    arm64) ARCH_TAG="aarch64" ;;
    x86_64) ARCH_TAG="x64" ;;
    *) ARCH_TAG=$(uname -m) ;;
  esac
fi
echo "── $PRODUCT $VERSION 설치파일 빌드 ${TRIPLE:+($TRIPLE) }──"

# ── 사전 점검: 마운트된 볼륨에 쓸 수 있는가 ──────────────────────────────────
# tauri 의 bundle_dmg.sh 는 임시 볼륨을 /Volumes 에 마운트한 뒤 앱을 그 안으로 복사한다.
# 그 쓰기가 막히는 환경이 있고(위 ⚠️ 참고), 실패는 rust 빌드가 다 끝난 뒤에야 나오므로
# 1초짜리 탐침으로 먼저 판별해 빌드 방식을 고른다.
VOL="MySpaceBuildCheck"
PROBE_DIR=$(mktemp -d)
PROBE_OK=unknown
if hdiutil create -size 1m -fs HFS+ -volname "$VOL" "$PROBE_DIR/probe.dmg" >/dev/null 2>&1 &&
  hdiutil attach "$PROBE_DIR/probe.dmg" -nobrowse >/dev/null 2>&1; then
  if touch "/Volumes/$VOL/probe" 2>/dev/null; then
    PROBE_OK=yes
  else
    PROBE_OK=no
  fi
  hdiutil detach "/Volumes/$VOL" -quiet >/dev/null 2>&1 || true
fi
rm -rf "$PROBE_DIR"

DMG_FALLBACK=false
if [ "$PROBE_OK" = no ]; then
  DMG_FALLBACK=true
  # 권한을 받아야 하는 것은 셸이 아니라 그 셸을 띄운 터미널 *앱* 이다(TCC 는 앱 단위).
  # 조상을 거슬러 올라가며 .app 번들 안의 실행 파일을 처음 만나는 지점을 찾는다.
  TERM_APP=""
  probe_pid=$$
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    probe_pid=$(ps -o ppid= -p "$probe_pid" 2>/dev/null | tr -d ' ')
    [ -z "$probe_pid" ] && break
    [ "$probe_pid" -le 1 ] 2>/dev/null && break
    probe_cmd=$(ps -o comm= -p "$probe_pid" 2>/dev/null || true)
    case "$probe_cmd" in
      */*.app/Contents/MacOS/*)
        TERM_APP=${probe_cmd%%.app/Contents/MacOS/*}.app
        break
        ;;
    esac
  done
  # 이동식 볼륨 쓰기를 막을 만한 EndpointSecurity 확장이 떠 있으면 이름을 함께 보여 준다
  # (있으면 터미널 권한을 줘도 안 풀리므로, 헛수고를 미리 막아 준다).
  ES_EXTS=$(systemextensionsctl list 2>/dev/null |
    sed -n '/endpoint_security/,$p' | awk '/^[*[:space:]]+[*]/ {print $4}' | paste -sd' ' - || true)
  cat >&2 <<MSG
⚠️ 마운트된 디스크 이미지(/Volumes)에 쓸 수 없습니다 (Operation not permitted).
  tauri 의 bundle_dmg.sh 가 이 쓰기를 필요로 하므로, .app 만 빌드한 뒤 마운트 없이
  .dmg 를 직접 굽습니다(hdiutil makehybrid). 배경·아이콘 배치 같은 꾸밈만 빠지고,
  Applications 로 드래그해 설치하는 동작은 그대로입니다.

  꾸밈까지 갖춘 .dmg 를 원하면 아래 중 하나를 해결해야 합니다.
   1) 터미널 앱 권한: 시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한
      → 지금 쓰는 터미널 앱 추가·켜기 → 그 앱을 완전히 종료 후 다시 실행${TERM_APP:+"
      (이 셸을 띄운 앱: $TERM_APP)"}
   2) 보안 에이전트의 이동식 볼륨 차단: 이건 위 권한을 줘도 풀리지 않습니다.${ES_EXTS:+"
      떠 있는 Endpoint Security 확장: $ES_EXTS"}
      사내 정책이라면 GitHub Actions 로 빌드하세요 — 태그를 밀면 릴리스 초안에
      꾸밈까지 갖춘 .dmg 가 올라옵니다(.github/workflows/release.yml).
MSG
fi

# 마운트 없이 .dmg 를 굽는다. `hdiutil makehybrid` 는 폴더를 그대로 HFS+ 이미지로 만들어
# (임시 볼륨을 마운트해 복사하는 단계가 없어) /Volumes 쓰기가 막힌 환경에서도 통한다.
# 실행 권한·심볼릭 링크는 보존되고, /Applications 링크를 같이 담아 드래그 설치도 된다.
make_dmg_without_mount() {
  src_app=$1
  out_dmg=$2
  stage=$(mktemp -d)
  raw_dir=$(mktemp -d)
  # mktemp -d 는 700 이라 그대로 구우면 볼륨 루트도 700 이 된다. 받은 사람 쪽에서
  # 열리기는 하지만(마운트 시 소유자가 그 사용자로 보인다) 굳이 좁힐 이유가 없다.
  chmod 755 "$stage"
  cp -R "$src_app" "$stage/"
  ln -s /Applications "$stage/Applications"
  mkdir -p "$(dirname "$out_dmg")"
  rm -f "$out_dmg"
  hdiutil makehybrid -hfs -hfs-volume-name "$PRODUCT" -o "$raw_dir/raw.dmg" "$stage" >/dev/null
  hdiutil convert "$raw_dir/raw.dmg" -format UDZO -o "$out_dmg" >/dev/null
  rm -rf "$stage" "$raw_dir"
}

# ── 업데이터 서명 키 ─────────────────────────────────────────────────────────
# tauri.conf.json 에 업데이터 공개키가 박혀 있고 createUpdaterArtifacts 가 켜져 있어서,
# 개인키 없이 빌드하면 마지막에 "A public key has been found, but no private key" 로 죽는다.
# .app 은 이미 만들어진 뒤라 더 헷갈린다 — 빌드는 다 됐는데 스크립트는 실패로 끝난다.
# 키가 있으면 넘겨주고, 없으면 이번 빌드만 업데이터 산출물을 끈다(로컬 설치엔 .sig 가 필요 없다).
UPDATER_KEY="$HOME/.tauri/myspace-updater.key"
NO_UPDATER=false
if [ -f "$UPDATER_KEY" ]; then
  TAURI_SIGNING_PRIVATE_KEY=$(cat "$UPDATER_KEY")
  export TAURI_SIGNING_PRIVATE_KEY
  # 현재 키는 암호가 없다. 이 변수를 안 주면 tauri 가 대화형으로 암호를 묻고 멈춘다.
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
else
  NO_UPDATER=true
  echo "→ 업데이터 서명 키가 없어 업데이터 산출물(.sig)은 만들지 않습니다."
  echo "  (키 위치: $UPDATER_KEY — 배포용은 GitHub Actions 가 서명해 만듭니다)"
fi

# ── 의존성 ───────────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "→ bun install"
  bun install
fi

# ── 빌드 ─────────────────────────────────────────────────────────────────────
# 첫 실행이면 rdkafka 컴파일로 수 분 걸린다.
# 인자는 위치 매개변수($@)로 모은다. 배열을 쓰지 않는 이유: macOS 기본 bash 는 3.2 라
# `set -u` 아래에서 빈 배열을 "${ARR[@]}" 로 펼치면 unbound variable 로 죽는다(4.4 에서 고쳐졌다).
# "$@" 는 비어 있어도 안전하다. 옵션 파싱은 이미 끝났으므로 여기서 새로 채운다.
set --
if [ -n "$TRIPLE" ]; then
  set -- "$@" --target "$TRIPLE"
fi
# .dmg 를 우리가 굽는 경우엔 tauri 에게 .app 만 만들게 한다 — 그대로 두면 어차피 실패할
# bundle_dmg.sh 단계까지 갔다가 죽어, 빌드를 다 기다린 뒤 아무 산출물도 못 얻는다.
if $DMG_FALLBACK; then
  set -- "$@" --bundles app
fi
if $NO_UPDATER; then
  set -- "$@" --config '{"bundle":{"createUpdaterArtifacts":false}}'
fi
bun run tauri build "$@"

# ── 산출물 확인 ──────────────────────────────────────────────────────────────
# `|| true` 가 필요하다: 번들 디렉터리가 아예 없으면 find 가 실패하는데, pipefail 이
# 그 상태를 파이프라인 밖으로 올리고 set -e 가 아래 안내를 찍기도 전에 스크립트를
# 끝내 버린다 — 실패 원인이 화면에 한 줄도 남지 않는다.
APP=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1 || true)

# 마운트가 막힌 환경: 방금 만든 .app 을 tauri 와 같은 이름 규칙으로 직접 .dmg 로 굽는다.
if $DMG_FALLBACK && [ -n "$APP" ]; then
  echo
  echo "→ .dmg 굽기(마운트 없이): hdiutil makehybrid"
  make_dmg_without_mount "$APP" "$BUNDLE_DIR/dmg/${PRODUCT}_${VERSION}_${ARCH_TAG}.dmg"
fi

DMG=$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' 2>/dev/null | head -1 || true)

echo
if [ -n "$DMG" ]; then
  echo "✓ 설치파일: $DMG"
  echo "  크기: $(du -h "$DMG" | cut -f1)"
else
  echo "✗ .dmg 를 찾지 못했습니다: $BUNDLE_DIR/dmg" >&2
  if [ -n "$APP" ]; then
    echo "  (.app 은 만들어졌습니다: $APP — 이것만 /Applications 에 복사해도 씁니다)" >&2
    echo "   ./bin/install.sh --install 로 바로 설치할 수 있습니다." >&2
  fi
  exit 1
fi

echo
echo "  미서명(adhoc)이라 받은 사람은 설치 후 아래 한 줄을 실행해야 열립니다."
echo "  (macOS 15 부터 '우클릭 → 열기' 우회는 없어졌습니다 — 설치가이드.md 참고)"
echo
echo "    xattr -dr com.apple.quarantine \"/Applications/$PRODUCT.app\""

if $INSTALL_AFTER && [ -n "$APP" ]; then
  echo
  echo "→ /Applications 에 설치"
  rm -rf "/Applications/$(basename "$APP")"
  cp -R "$APP" /Applications/
  echo "✓ 설치 완료: /Applications/$(basename "$APP")"
fi

if $OPEN_AFTER; then
  open -R "$DMG"
fi
