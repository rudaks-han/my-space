import { debug } from "@tauri-apps/plugin-log"

/**
 * ⚠️ **임시 계측입니다.** 한글이 음절 단위로 사라지는 문제를 확인하기 위해 `input` 이벤트와
 * **PTY 로 실제로 나간 순서**만 좁게 남긴다. 확인되면 이 파일과 호출부는 지운다.
 *
 * 로그: `~/Library/Logs/com.rudaks.myspace/My Space.log`
 * 읽기: `grep '\[IME\]' "$HOME/Library/Logs/com.rudaks.myspace/My Space.log"`
 */
export function imeTrace(line: string) {
  void debug(`[IME] ${line}`)
}
