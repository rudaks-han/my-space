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
# ⚠️ 샌드박스(예: 에이전트 도구) 안에서는 .dmg 단계가 실패한다.
#    bundle_dmg.sh 가 /Volumes 에 마운트하는데 그게 막히기 때문이다
#    ("hdiutil: create failed - 작업이 허용되지 않음"). 일반 터미널에서 실행할 것.
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
