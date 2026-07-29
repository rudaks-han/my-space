#!/usr/bin/env bash
#
# enable-space-switch.sh
#
# My Space 작업목록에서 "이동"을 눌렀을 때, 대상 터미널 창이 "다른 Space(가상 데스크탑)"에
# 있어도 macOS 가 그 Space 로 전환해 창을 앞으로 가져오게 하는 설정.
#
# 배경:
#   - Slack "이동"은 slack:// 딥링크(=OS 앱 활성화)라 macOS 가 알아서 Space 를 전환한다.
#   - 터미널 "이동"도 코드에서 `open -a`(OS 앱 활성화)로 앱을 활성화하지만,
#     아래 설정이 꺼져 있으면 macOS 는 다른 Space 의 창을 따라가지 않는다.
#   - 이 설정을 켜면 "앱으로 전환할 때, 그 앱의 열린 윈도우가 있는 Space 로 전환"이 활성화된다.
#     (시스템 설정 → 데스크탑 및 Dock → Mission Control 의 동일 항목)
#
# ⚠️ 이 값은 보통 재로그인(로그아웃 → 로그인) 후에 적용된다.
#
# 사용:
#   bash scripts/enable-space-switch.sh          # 켜기
#   bash scripts/enable-space-switch.sh --off     # 되돌리기(끄기)
#   bash scripts/enable-space-switch.sh --status   # 현재 값 확인

set -euo pipefail

KEY="AppleSpacesSwitchOnActivate"

case "${1:-}" in
  --off)
    defaults write NSGlobalDomain "$KEY" -bool false
    echo "꺼짐: NSGlobalDomain $KEY = false (재로그인 후 적용)"
    ;;
  --status)
    if val=$(defaults read NSGlobalDomain "$KEY" 2>/dev/null); then
      echo "현재 값: $KEY = $val"
    else
      echo "현재 값: $KEY (미설정 = 기본값)"
    fi
    ;;
  *)
    defaults write NSGlobalDomain "$KEY" -bool true
    echo "켜짐: NSGlobalDomain $KEY = true"
    echo "→ 로그아웃 후 다시 로그인해야 적용됩니다."
    ;;
esac
