#!/usr/bin/env bash
#
# install.sh
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
# ⚠️ "hdiutil: create failed - 작업이 허용되지 않음" 으로 .dmg 단계가 실패한다면
#    터미널 앱의 TCC 권한 문제다. bundle_dmg.sh 는 임시 볼륨을 /Volumes 에 마운트해
#    앱을 복사하는데, 이동식 볼륨 접근 권한이 없으면 그 쓰기가 EPERM 으로 막힌다
#    (읽기·목록은 되고 쓰기만 막혀서 원인이 잘 안 보인다).
#    시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한에 터미널 앱을
#    추가하고 그 앱을 재시작하면 된다. 아래 사전 점검이 빌드 전에 미리 걸러 준다.
#
# 사용:
#   ./install.sh              # 현재 아키텍처용 .dmg 생성
#   ./install.sh --universal  # Intel + Apple Silicon 겸용(universal) .dmg 생성
#   ./install.sh --open       # 생성 후 Finder 에서 산출물 폴더 열기
#   ./install.sh --install    # 생성 후 빌드된 .app 을 /Applications 에 설치
#   ./install.sh --help

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

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
      tail -n +2 "${BASH_SOURCE[0]}" | sed -n '/^#/!q;s/^# \{0,1\}//p'
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
echo "── My Space $VERSION 설치파일 빌드 ${TRIPLE:+($TRIPLE) }──"

# ── 사전 점검: 마운트된 볼륨에 쓸 수 있는가 ──────────────────────────────────
# tauri 의 bundle_dmg.sh 는 `hdiutil create -srcfolder` 로 임시 볼륨을 /Volumes 에
# 마운트한 뒤 앱을 그 안으로 복사한다. 터미널 앱에 "이동식 볼륨" 접근 권한(TCC)이
# 없으면 이 복사가 Operation not permitted 로 죽는다. 읽기·목록은 되고 쓰기만 막히며,
# 실패는 rust 빌드가 다 끝난 뒤에야 나오므로 1초짜리 탐침으로 먼저 걸러 낸다.
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

if [ "$PROBE_OK" = no ]; then
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
  cat >&2 <<MSG
✗ 마운트된 디스크 이미지에 쓸 수 없습니다 (Operation not permitted).
  이대로 빌드하면 몇 분 뒤 bundle_dmg.sh 단계에서 실패합니다. 먼저 권한을 주세요.

  시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한
    → 지금 쓰는 터미널 앱을 추가하고 켜기 → 그 앱을 완전히 종료 후 다시 실행
${TERM_APP:+"
  이 셸을 띄운 앱: $TERM_APP"}

  권한을 주기 싫다면 GitHub Actions 로 빌드하세요 — 태그를 밀면 릴리스에
  .dmg 가 올라옵니다(.github/workflows/release.yml). CI 러너에는 이 제약이 없습니다.
MSG
  exit 1
fi

# ── 의존성 ───────────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "→ bun install"
  bun install
fi

# ── 빌드 ─────────────────────────────────────────────────────────────────────
# 첫 실행이면 rdkafka 컴파일로 수 분 걸린다.
# 배열로 인자를 모으지 않는 이유: macOS 기본 bash 는 3.2 라 `set -u` 아래에서
# 빈 배열을 "${ARR[@]}" 로 펼치면 unbound variable 로 죽는다(4.4 부터 고쳐졌다).
if [ -n "$TRIPLE" ]; then
  bun run tauri build --target "$TRIPLE"
else
  bun run tauri build
fi

# ── 산출물 확인 ──────────────────────────────────────────────────────────────
# `|| true` 가 필요하다: 번들 디렉터리가 아예 없으면 find 가 실패하는데, pipefail 이
# 그 상태를 파이프라인 밖으로 올리고 set -e 가 아래 안내를 찍기도 전에 스크립트를
# 끝내 버린다 — 실패 원인이 화면에 한 줄도 남지 않는다.
DMG=$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' 2>/dev/null | head -1 || true)
APP=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' 2>/dev/null | head -1 || true)

echo
if [ -n "$DMG" ]; then
  echo "✓ 설치파일: $DMG"
  echo "  크기: $(du -h "$DMG" | cut -f1)"
else
  echo "✗ .dmg 를 찾지 못했습니다: $BUNDLE_DIR/dmg" >&2
  if [ -n "$APP" ]; then
    echo "  (.app 은 만들어졌습니다: $APP — 위 ⚠️ 샌드박스 항목 참고)" >&2
  fi
  exit 1
fi

echo
echo "  미서명(adhoc)이라 받은 사람은 설치 후 아래 한 줄을 실행해야 열립니다."
echo "  (macOS 15 부터 '우클릭 → 열기' 우회는 없어졌습니다 — 설치가이드.md 참고)"
echo
echo "    xattr -dr com.apple.quarantine \"/Applications/My Space.app\""

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
