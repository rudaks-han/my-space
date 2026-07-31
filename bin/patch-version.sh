#!/usr/bin/env bash
#
# bin/patch-version.sh
#
# 릴리스 한 번을 끝까지 진행한다: 버전 올리기 → 커밋 → 태그 → 푸시 →
# GitHub Actions 감시 → 릴리스 초안 퍼블리시 → 업데이터 엔드포인트 확인.
#
# 왜 이 스크립트가 필요한가:
#   - 버전이 네 파일에 흩어져 있다(tauri.conf.json · Cargo.toml · Cargo.lock · package.json).
#     이 중 **업데이터가 실제로 비교하는 값은 tauri.conf.json 의 version** 이고, 나머지가
#     어긋나도 빌드는 되기 때문에 손으로 고치면 조용히 틀어진다.
#   - release.yml 은 **`v*` 태그 푸시**에만 돈다. 커밋만 푸시하면 아무 일도 일어나지 않는다.
#   - tauri-action 은 릴리스를 **초안(draft)** 으로 만든다. `releases/latest/download/` 는
#     초안을 서빙하지 않으므로, 퍼블리시하지 않으면 사용자 쪽 업데이트 확인은 계속 404 다
#     (그리고 앱은 조용히 실패하므로 아무도 눈치채지 못한다).
#
# 사용:
#   ./bin/patch-version.sh                 # 패치 올림 (0.0.1 → 0.0.2)
#   ./bin/patch-version.sh --minor         # 0.0.2 → 0.1.0
#   ./bin/patch-version.sh --major         # 0.1.0 → 1.0.0
#   ./bin/patch-version.sh --set 1.2.3     # 특정 버전으로
#   ./bin/patch-version.sh --dry-run       # 무엇을 할지만 출력하고 아무것도 바꾸지 않음
#   ./bin/patch-version.sh --include-dirty # 커밋 안 한 tracked 수정도 릴리스 커밋에 포함
#   ./bin/patch-version.sh --include-untracked # 추적 안 되는 새 파일까지 릴리스 커밋에 포함
#   ./bin/patch-version.sh --no-wait       # 푸시까지만 (CI 안 기다림 → 퍼블리시도 안 함)
#   ./bin/patch-version.sh --no-publish    # CI 는 기다리되 초안 퍼블리시는 직접 하기
#   ./bin/patch-version.sh --skip-check    # 사전 타입 검사(bun run typecheck) 생략
#   ./bin/patch-version.sh --help
#
# 초안 단계를 아예 없애고 CI 가 바로 공개하게 하고 싶으면 .github/workflows/release.yml 의
# `releaseDraft: true` 를 false 로 바꾸면 된다. 지금은 초안을 유지한다 — 자산 업로드가 끝난
# 뒤 한 번에 공개되므로, latest.json 만 먼저 보이고 .app.tar.gz 는 아직 없는 순간이 없다.

set -euo pipefail

# 스크립트는 bin/ 아래에 있고, 아래 경로들은 모두 저장소 루트 기준이다.
# --help 이 자기 파일을 다시 읽으므로, cd 로 상대경로가 깨지기 전에 절대경로로 붙잡아 둔다.
SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
cd "$(dirname "$SELF")/.."

BUMP=patch
SET_VERSION=""
DRY_RUN=false
INCLUDE_DIRTY=false
INCLUDE_UNTRACKED=false
WAIT_CI=true
PUBLISH=true
SKIP_CHECK=false

while [ $# -gt 0 ]; do
  case "$1" in
    --patch) BUMP=patch ;;
    --minor) BUMP=minor ;;
    --major) BUMP=major ;;
    --set)
      shift
      [ $# -gt 0 ] || {
        echo "--set 에는 버전이 필요합니다 (예: --set 1.2.3)" >&2
        exit 1
      }
      SET_VERSION="$1"
      ;;
    --dry-run) DRY_RUN=true ;;
    --include-dirty) INCLUDE_DIRTY=true ;;
    --include-untracked) INCLUDE_UNTRACKED=true ;;
    --no-wait) WAIT_CI=false ;;
    --no-publish) PUBLISH=false ;;
    --skip-check) SKIP_CHECK=true ;;
    --help | -h)
      # 파일 맨 위 주석 블록이 곧 도움말이다(install.sh 와 같은 방식).
      tail -n +2 "$SELF" | sed -n '/^#/!q;s/^# \{0,1\}//p'
      exit 0
      ;;
    *)
      echo "알 수 없는 옵션: $1 (--help 참고)" >&2
      exit 1
      ;;
  esac
  shift
done

# --no-wait 면 CI 결과를 모르는데 퍼블리시할 수는 없다.
if ! $WAIT_CI; then
  PUBLISH=false
fi

CONF="src-tauri/tauri.conf.json"
CARGO_TOML="src-tauri/Cargo.toml"
CARGO_LOCK="src-tauri/Cargo.lock"
PKG_JSON="package.json"

read_json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }

# ── 현재 버전 · 네 파일 동기화 확인 ──────────────────────────────────────────
CUR=$(read_json_version "$CONF")
CUR_CARGO=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$CARGO_TOML" | head -1)
CUR_PKG=$(read_json_version "$PKG_JSON")
CUR_LOCK=$(awk '/^name = "my-space"$/ {f=1; next} f && /^version = / {gsub(/[^0-9.]/, ""); print; exit}' "$CARGO_LOCK")

if [ -z "$CUR" ]; then
  echo "✗ $CONF 에서 version 을 읽지 못했습니다." >&2
  exit 1
fi

MISMATCH=false
for pair in "Cargo.toml:$CUR_CARGO" "Cargo.lock:$CUR_LOCK" "package.json:$CUR_PKG"; do
  name=${pair%%:*}
  val=${pair#*:}
  if [ "$val" != "$CUR" ]; then
    echo "⚠️ 버전이 어긋나 있습니다: $CONF=$CUR, $name=$val" >&2
    MISMATCH=true
  fi
done
if $MISMATCH; then
  echo "  이 스크립트가 네 파일을 모두 새 버전으로 맞춥니다(계속 진행합니다)." >&2
fi

# ── 새 버전 계산 ─────────────────────────────────────────────────────────────
if [ -n "$SET_VERSION" ]; then
  case "$SET_VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
      echo "✗ 버전 형식이 아닙니다: $SET_VERSION (x.y.z)" >&2
      exit 1
      ;;
  esac
  NEW="$SET_VERSION"
else
  MAJOR=${CUR%%.*}
  REST=${CUR#*.}
  MINOR=${REST%%.*}
  PATCH=${REST#*.}
  # 0.0.1-beta 같은 접미사가 붙어 있으면 숫자만 남긴다.
  PATCH=${PATCH%%[^0-9]*}
  case "$BUMP" in
    patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
    minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
    major) NEW="$((MAJOR + 1)).0.0" ;;
  esac
fi
TAG="v$NEW"

# ── 사전 점검 ────────────────────────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "── 릴리스 $CUR → $NEW (태그 $TAG, 브랜치 $BRANCH) ──"

if [ "$BRANCH" != "main" ]; then
  echo "⚠️ main 이 아닌 브랜치입니다: $BRANCH" >&2
  echo "  태그만 밀면 CI 는 돌지만, 릴리스가 main 에 없는 커밋을 가리키게 됩니다." >&2
  if [ -t 0 ] && ! $DRY_RUN; then
    printf "  계속할까요? [y/N] "
    read -r ans
    case "$ans" in
      y | Y) ;;
      *)
        echo "중단했습니다."
        exit 1
        ;;
    esac
  fi
fi

# 태그가 이미 있으면(로컬·원격 어느 쪽이든) 중단한다. 같은 태그를 다시 밀 수는 없다.
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "✗ 로컬에 태그 $TAG 가 이미 있습니다. (지우려면: git tag -d $TAG)" >&2
  exit 1
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null)" ]; then
  echo "✗ 원격에 태그 $TAG 가 이미 있습니다. 다른 버전을 쓰세요." >&2
  exit 1
fi

# 커밋 안 한 변경: 그대로 두면 태그가 그 변경이 빠진 커밋을 가리켜, 방금 고친 코드가
# 릴리스에 안 들어간다. 가장 흔한 실수라 여기서 막는다.
DIRTY=$(git status --porcelain --untracked-files=no)
UNTRACKED=$(git ls-files --others --exclude-standard)
if [ -n "$DIRTY" ]; then
  echo
  echo "⚠️ 커밋하지 않은 변경이 있습니다:" >&2
  echo "$DIRTY" >&2
  if $INCLUDE_DIRTY; then
    echo "  → --include-dirty: 릴리스 커밋에 함께 담습니다." >&2
  elif [ -t 0 ] && ! $DRY_RUN; then
    printf "  이 변경들을 릴리스 커밋에 함께 담을까요? [y/N] "
    read -r ans
    case "$ans" in
      y | Y) INCLUDE_DIRTY=true ;;
      *)
        echo "중단했습니다. 먼저 커밋하거나 --include-dirty 로 실행하세요." >&2
        exit 1
        ;;
    esac
  else
    echo "  먼저 커밋하거나 --include-dirty 로 실행하세요." >&2
    exit 1
  fi
fi
# 추적하지 않는 파일은 경고만 하고 넘어가면 안 된다. v0.0.3 이 정확히 이렇게 깨졌다:
# 새로 만든 소스가 untracked 인 채로 태그가 나가서, 그 파일을 import 하는 커밋된 코드가
# CI 에서만 TS2307 로 죽었다. 로컬엔 파일이 있으니 위의 타입 검사는 통과한다 —
# 그래서 이 검사 말고는 잡아 줄 것이 없다. dirty 와 똑같이 막는다.
if [ -n "$UNTRACKED" ]; then
  echo
  echo "⚠️ git 이 추적하지 않는 파일이 있습니다 — 이대로는 릴리스에 **포함되지 않습니다**:" >&2
  echo "$UNTRACKED" | sed 's/^/    /' >&2
  echo "  새로 만든 소스 파일이 여기 있으면 CI 빌드만 깨집니다(로컬엔 파일이 있으니" >&2
  echo "  타입 검사는 통과합니다)." >&2
  if $INCLUDE_UNTRACKED; then
    echo "  → --include-untracked: 릴리스 커밋에 함께 담습니다." >&2
  elif [ -t 0 ] && ! $DRY_RUN; then
    printf "  이 파일들을 릴리스 커밋에 함께 담을까요? [y/N] "
    read -r ans
    case "$ans" in
      y | Y) INCLUDE_UNTRACKED=true ;;
      *)
        echo "중단했습니다. 필요한 파일은 git add, 나머지는 .gitignore 에 넣고 다시 실행하세요." >&2
        exit 1
        ;;
    esac
  else
    echo "  git add 하거나 .gitignore 에 넣은 뒤 다시 실행하세요 (--include-untracked 로 무시 가능)." >&2
    exit 1
  fi
fi

# ── 계획 출력 ────────────────────────────────────────────────────────────────
echo
echo "할 일:"
echo "  1) 버전 $NEW 로 수정: $CONF · $CARGO_TOML · $CARGO_LOCK · $PKG_JSON"
if $INCLUDE_UNTRACKED; then
  echo "  2) 커밋: chore: 버전 $NEW (커밋 안 한 변경 + 새 파일 포함)"
elif $INCLUDE_DIRTY; then
  echo "  2) 커밋: chore: 버전 $NEW (커밋 안 한 변경 포함)"
else
  echo "  2) 커밋: chore: 버전 $NEW"
fi
# 변수 뒤에 바로 한글·기호가 붙으면 bash 3.2 는 그 바이트까지 변수명으로 읽는다({} 필수).
echo "  3) 태그 $TAG 생성 후 ${BRANCH}·${TAG} 푸시"
if $WAIT_CI; then
  echo "  4) GitHub Actions(Release) 완료까지 대기 (~6분)"
else
  echo "  4) (생략) CI 대기"
fi
if $PUBLISH; then
  echo "  5) 릴리스 초안 $TAG 퍼블리시 + 업데이터 엔드포인트 확인"
else
  echo "  5) (생략) 초안 퍼블리시 — 직접 Publish 해야 사용자에게 갑니다"
fi

if $DRY_RUN; then
  echo
  echo "--dry-run 이라 아무것도 바꾸지 않았습니다."
  exit 0
fi

# ── 사전 타입 검사 ───────────────────────────────────────────────────────────
# CI 가 실패하면 이미 밀어 버린 태그를 지워야 해서 뒷정리가 번거롭다. 몇 초짜리
# 타입 검사로 흔한 깨짐은 먼저 걸러 낸다(전체 빌드는 CI 가 한다).
if ! $SKIP_CHECK; then
  echo
  echo "→ 타입 검사(bun run typecheck)"
  export PATH="$HOME/.bun/bin:$PATH"
  if command -v bun >/dev/null 2>&1; then
    bun run typecheck
  else
    echo "  bun 이 없어 건너뜁니다."
  fi
fi

# ── 버전 수정 ────────────────────────────────────────────────────────────────
echo
echo "→ 버전 $CUR → $NEW"

# tauri.conf.json · package.json: 첫 "version" 키 한 줄만 바꾼다(각 파일에 하나뿐).
for f in "$CONF" "$PKG_JSON"; do
  awk -v new="$NEW" '
    !done && /"version": *"/ { sub(/"version": *"[^"]*"/, "\"version\": \"" new "\""); done=1 }
    { print }
  ' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
done

# Cargo.toml: [package] 의 `version = "..."` (줄 시작이라 의존성 인라인 표기와 안 겹친다).
awk -v new="$NEW" '
  !done && /^version = "/ { print "version = \"" new "\""; done=1; next }
  { print }
' "$CARGO_TOML" >"$CARGO_TOML.tmp" && mv "$CARGO_TOML.tmp" "$CARGO_TOML"

# Cargo.lock: my-space 패키지 블록의 version 만. 안 고치면 cargo 가 빌드 중에 고쳐서
# CI 작업 트리가 더러워지고, 커밋된 lock 과 태그가 어긋난다.
awk -v new="$NEW" '
  /^name = "my-space"$/ { print; inpkg=1; next }
  inpkg && /^version = / { print "version = \"" new "\""; inpkg=0; next }
  { print }
' "$CARGO_LOCK" >"$CARGO_LOCK.tmp" && mv "$CARGO_LOCK.tmp" "$CARGO_LOCK"

# 정말 네 파일이 다 같은 값이 됐는지 확인한다(치환이 조용히 실패하는 걸 막는다).
FAIL=false
for pair in "$CONF:$(read_json_version "$CONF")" \
  "$PKG_JSON:$(read_json_version "$PKG_JSON")" \
  "$CARGO_TOML:$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$CARGO_TOML" | head -1)" \
  "$CARGO_LOCK:$(awk '/^name = "my-space"$/ {f=1; next} f && /^version = / {gsub(/[^0-9.]/, ""); print; exit}' "$CARGO_LOCK")"; do
  name=${pair%%:*}
  val=${pair#*:}
  if [ "$val" = "$NEW" ]; then
    echo "  ✓ $name = $val"
  else
    echo "  ✗ $name = $val (기대: $NEW)" >&2
    FAIL=true
  fi
done
if $FAIL; then
  echo "✗ 버전 치환에 실패했습니다. 변경을 되돌리세요: git checkout -- $CONF $CARGO_TOML $CARGO_LOCK $PKG_JSON" >&2
  exit 1
fi

# ── 커밋 · 태그 · 푸시 ───────────────────────────────────────────────────────
echo
echo "→ 커밋 · 태그 · 푸시"
if $INCLUDE_UNTRACKED; then
  git add -A
elif $INCLUDE_DIRTY; then
  git add -u
else
  git add "$CONF" "$CARGO_TOML" "$CARGO_LOCK" "$PKG_JSON"
fi
git commit -q -m "chore: 버전 $NEW"
git tag "$TAG"

# 푸시가 실패하면(권한·네트워크·rejected) 로컬에 커밋과 태그만 남는다. 되돌리는 법을 알려 준다.
if ! git push origin "$BRANCH"; then
  echo "✗ 브랜치 푸시 실패. 되돌리려면: git tag -d $TAG && git reset --soft HEAD~1" >&2
  exit 1
fi
if ! git push origin "$TAG"; then
  echo "✗ 태그 푸시 실패. 되돌리려면: git tag -d $TAG (커밋은 이미 푸시됨)" >&2
  exit 1
fi
echo "✓ $TAG 푸시 완료 — GitHub Actions 가 빌드를 시작합니다."

if ! command -v gh >/dev/null 2>&1; then
  echo
  echo "ℹ️ gh CLI 가 없어 여기서 멈춥니다. 빌드가 끝나면 릴리스 초안을 직접 Publish 하세요:"
  echo "   https://github.com/rudaks-han/my-space/releases"
  exit 0
fi

if ! $WAIT_CI; then
  echo
  echo "ℹ️ CI 를 기다리지 않습니다. 빌드 후 초안을 직접 Publish 하세요:"
  echo "   gh release edit $TAG --draft=false --latest"
  exit 0
fi

# ── CI 대기 ──────────────────────────────────────────────────────────────────
# 태그 푸시로 생긴 실행은 headBranch 가 태그 이름이다. 등록까지 몇 초 걸리므로 잠깐 찾는다.
# headSha 까지 봐야 한다: 같은 태그를 지우고 다시 밀면(실패한 릴리스를 고칠 때가 그렇다)
# 옛 실행도 headBranch 가 같아서, 태그 이름만으로 고르면 **이미 실패한 옛 실행**을 집어
# 방금 시작한 빌드를 실패로 보고한다. 태그는 방금 만든 HEAD 를 가리키므로 sha 로 구분한다.
HEAD_SHA=$(git rev-parse HEAD)
echo
echo "→ Actions 실행을 찾는 중…"
RUN_ID=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  RUN_ID=$(gh run list --workflow=Release --limit 20 \
    --json databaseId,headBranch,headSha \
    --jq "[.[] | select(.headBranch == \"$TAG\" and .headSha == \"$HEAD_SHA\")] | first | .databaseId" 2>/dev/null || true)
  case "$RUN_ID" in
    "" | null) RUN_ID="" ;;
    *) break ;;
  esac
  sleep 5
done

if [ -z "$RUN_ID" ]; then
  echo "⚠️ 실행을 찾지 못했습니다. 직접 확인하세요: gh run list --workflow=Release" >&2
  exit 1
fi

echo "→ 빌드 감시 (run $RUN_ID, 보통 6분쯤)"
if ! gh run watch "$RUN_ID" --exit-status --interval 15; then
  echo "✗ 빌드가 실패했습니다. 로그: gh run view $RUN_ID --log-failed" >&2
  echo "  고친 뒤 다시 릴리스하려면 태그를 지우고 다시 실행하세요:" >&2
  echo "    git push origin :refs/tags/$TAG && git tag -d $TAG" >&2
  exit 1
fi
echo "✓ 빌드 성공"

if ! $PUBLISH; then
  echo
  echo "ℹ️ 초안은 그대로 두었습니다. 사용자에게 보내려면:"
  echo "   gh release edit $TAG --draft=false --latest"
  exit 0
fi

# ── 초안 퍼블리시 ────────────────────────────────────────────────────────────
# 이걸 해야 releases/latest/download/latest.json 이 살아난다(초안은 서빙되지 않는다).
#
# gh 는 **자기가 로그인한 계정**으로 동작하는데, 이 기계에서는 그 계정이 저장소
# 협업자가 아니다(권한이 pull 뿐 — `gh api repos/rudaks-han/my-space --jq .permissions`
# 로 확인된다). 반면 git push 는 credential helper 에 저장된 다른 자격증명으로
# 되기 때문에, "푸시는 되는데 릴리스만 403" 인 헷갈리는 상태가 된다. 초안은 태그가
# 아직 없어 `untagged-…` 로 만들어지고 gh release list 에도 안 보이므로 더 헷갈린다.
# 그래서 실패하면 push 에 쓰는 그 자격증명으로 한 번 더 시도한다.
git_credential_token() {
  printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null |
    sed -n 's/^password=//p'
}

echo
echo "→ 릴리스 $TAG 퍼블리시"
PUBLISHED=false
if gh release edit "$TAG" --draft=false --latest; then
  PUBLISHED=true
else
  TOKEN=$(git_credential_token || true)
  if [ -n "$TOKEN" ]; then
    echo "  gh 계정으로는 거부됐습니다 — git push 에 쓰는 자격증명으로 다시 시도합니다." >&2
    if GH_TOKEN="$TOKEN" gh release edit "$TAG" --draft=false --latest; then
      PUBLISHED=true
    fi
  fi
fi
if ! $PUBLISHED; then
  cat >&2 <<MSG
✗ 퍼블리시하지 못했습니다. gh 로그인 계정에 이 저장소 write 권한이 없을 수 있습니다.
  확인:  gh api repos/rudaks-han/my-space --jq .permissions   # push 가 false 면 이 경우다
  → 권한 있는 계정으로 로그인(gh auth login)하거나, 웹에서 직접 Publish 하세요.
     초안은 태그가 없어 'Draft untagged-…' 로 보입니다:
     https://github.com/rudaks-han/my-space/releases
MSG
  exit 1
fi

# ── 업데이터 엔드포인트 확인 ─────────────────────────────────────────────────
# 여기까지 와야 "사용자가 받을 수 있다"가 사실이 된다. GitHub CDN 반영에 몇 초 걸린다.
ENDPOINT="https://github.com/rudaks-han/my-space/releases/latest/download/latest.json"
echo
echo "→ 업데이터 엔드포인트 확인"
for _ in 1 2 3 4 5 6; do
  SERVED=$(curl -sSL "$ENDPOINT" 2>/dev/null | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1 || true)
  [ -n "$SERVED" ] && break
  sleep 5
done

echo
if [ "$SERVED" = "$NEW" ]; then
  echo "✓ 완료 — latest.json 이 $SERVED 를 알리고 있습니다."
  echo "  사용자는 **앱을 다시 시작할 때** 업데이트 알림을 받습니다(시작 시 1회만 확인)."
  echo "  누르면 .app.tar.gz 를 받아 스스로 교체·재시작합니다 — .dmg 재설치나"
  echo "  xattr 명령은 필요 없습니다(첫 설치 때만 필요)."
else
  echo "⚠️ latest.json 응답이 기대와 다릅니다(받은 값: ${SERVED:-없음}, 기대: $NEW)."
  echo "  릴리스가 'Latest' 로 표시됐는지 확인하세요: gh release view $TAG"
fi
