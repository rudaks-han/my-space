import type { Terminal } from "@xterm/xterm"

import { imeTrace } from "./ime-trace" // ⚠️ 임시 계측

/** 터미널에서 한 글자 지우기(Backspace). xterm 도 Backspace 를 이 바이트로 보낸다. */
const DEL = "\x7f"

/** 우리가 글자로 다루는 `input` 타입. 나머지(붙여넣기·지우기·줄바꿈)는 xterm 이 처리한다. */
const TEXT_INPUT = new Set(["insertText", "insertReplacementText"])

/**
 * WKWebView 에서 글자 입력(특히 한글)을 제대로 전달한다.
 *
 * ## 관측된 사실 (앱에 계측을 넣어 실제 이벤트를 찍은 것)
 *
 * **WebKit 은 한글에 조합(composition) 이벤트를 쓰지 않는다.** `compositionstart` /
 * `compositionupdate` / `compositionend` 가 한 번도 오지 않고 `isComposing` 도 늘 `false` 다.
 * 대신 `input` 이벤트로 온다 — 음절의 첫 자모는 `insertText`, 그 뒤 다듬어지는 음절은 매번
 * `insertReplacementText` 이며, **`input` 이 `keydown` 보다 먼저** 온다(키는 `keyCode 229`).
 *
 * ```
 * input insertText            data="ㄷ"
 * input insertReplacementText data="도"    ← 앞 글자를 지우고 다시 쓰라는 뜻
 * input insertReplacementText data="되"
 * ```
 *
 * ## 왜 xterm 에 맡기면 안 되나 — 두 가지가 겹쳐 글자가 사라진다
 *
 * 1. xterm 의 `_inputEvent` 는 `inputType === 'insertText'` **만** 처리한다. 다듬어진 음절
 *    (`insertReplacementText`)은 조건에서 아예 빠져 전부 버려진다 → "한글" 이 "ㅎㄱ" 이 된다.
 * 2. 그 `insertText` 마저 **조용히 삼켜질 때가 있다.** 조건에 `!this._keyDownSeen` 가 있어서
 *    "keydown 이 이미 보냈겠지" 하고 거르는데, 한글은 `keyup` 이 늦게 도착해 **빠르게 치면**
 *    그 플래그가 켜진 채로 남는다. 실측 로그에서 `insertText "ㅈ"` 은 나갔는데
 *    `insertText "지"` 는 나가지 않았다. 이러면 우리 쪽 "직전에 보낸 조각" 기록이 어긋나,
 *    이어지는 지우기가 **엉뚱한(이미 확정된) 글자를 지운다** — "부탁해" 가 "탁해" 가 되는,
 *    음절이 통째로 사라지는 두 번째 원인이다. **빨리 칠 때만 나타나는 것이 이 경합의 증거다.**
 *
 * ## 그래서 글자 입력의 출처를 하나로 만든다
 *
 * **글자를 만드는 키는 xterm 에 넘기지 않고**(`producesText`), 글자는 전부 `input` 이벤트에서
 * 우리가 보낸다. 그러면 "xterm 이 보냈나 우리가 보냈나" 를 추측할 필요가 사라지고, 2번처럼
 * xterm 이 조용히 삼키는 경로도 없어진다. 키를 막으면 `preventDefault` 가 걸리지 않아 글자가
 * textarea 에 정상적으로 들어가므로 `input` 이벤트는 오히려 더 확실하게 온다.
 *
 * 제어 키(Enter·방향키·Backspace·Ctrl 조합)는 그대로 xterm 이 처리한다 — 그쪽은 `input`
 * 이벤트로 오지 않거나 우리가 다루지 않는 타입이라 겹치지 않는다.
 *
 * ⚠️ 한계: 후보창을 쓰는 입력기(일본어·중국어)는 조합 이벤트를 낼 수 있고, 그때는 xterm 의
 * `CompositionHelper` 가 따로 전송할 여지가 있다. 한국어에서는 그 이벤트가 오지 않는 것을
 * 확인했으므로 지금은 다루지 않는다.
 *
 * @returns 해제 함수.
 */
export function installImeFix(term: Terminal, host: HTMLElement): () => void {
  const ime = new ImeInput()

  imeTrace(`installImeFix v3 (keypress 무조건 차단)`) // ⚠️ 임시 계측: 어느 판이 살아 있는지 표식

  term.attachCustomKeyEventHandler((ev) => {
    /*
     * **`keypress` 는 조건 없이 막는다.** 이 이벤트는 정의상 "글자를 만드는 키" 에서만
     * 발생하고, 글자는 전부 우리가 `input` 에서 보내므로 xterm 이 손댈 일이 없다.
     *
     * 왜 조건을 걸지 않는가: 평소에는 xterm 이 `keydown` 끝에서 `preventDefault` 를 걸어
     * `keypress` 가 아예 발생하지 않는데, 우리가 `keydown` 을 먼저 막으면 그 취소도 사라져
     * `keypress` 가 살아난다. 그러면 xterm 의 `_keyPress` 가 같은 글자를 한 번 더 보내
     * **ASCII 가 두 번 입력된다**(실측: 스페이스 한 번에 두 칸, 로그에도 `write " "` 가 두 번).
     * 여기에 `producesText` 같은 판정을 끼우면 `keypress` 의 `key`·`keyCode` 가 엔진마다
     * 다른 값을 주는 순간 조용히 새어 나간다 — 이 이벤트에는 판정이 필요 없다.
     */
    if (ev.type === "keypress") return false
    // `keyup` 은 그대로 넘긴다 — xterm 이 `_keyDownSeen` 을 되돌려야 한다.
    if (ev.type === "keyup") return true
    // 글자 키는 우리가 `input` 에서 보낸다 → xterm 에 넘기지 않는다.
    if (producesText(ev)) return false
    // 그 밖의 키는 xterm 이 보낸다. 원격 커서가 움직일 수 있으므로 되돌릴 조각은 무효다 —
    // 남겨 두면 다음 지우기가 엉뚱한 글자를 지운다.
    ime.reset()
    imeTrace(
      `key ${ev.type} key=${JSON.stringify(ev.key)} keyCode=${ev.keyCode} → xterm`
    )
    return true
  })

  const onInput = (e: Event) => {
    const ie = e as InputEvent
    if (!TEXT_INPUT.has(ie.inputType)) {
      // 붙여넣기·지우기 등은 xterm 의 경로가 처리한다. 되돌릴 조각은 무효가 된다.
      ime.reset()
      return
    }
    // 글자는 전부 우리가 보낸다 — xterm 이 같은 이벤트를 또 처리하지 않도록 막는다.
    e.stopPropagation()
    const send = ime.handleInput(ie.inputType, ie.data)
    imeTrace(
      `input ${ie.inputType} data=${JSON.stringify(ie.data)} → send=${JSON.stringify(send)}`
    )
    if (send) term.input(send, true)
  }
  // `input` 의 타깃은 textarea 이고 xterm 도 거기에 리스너를 달아 둔다. 같은 요소에 붙이면
  // 타깃 단계에서 등록 순서에 밀리므로 **조상에서 캡처로** 받는다.
  host.addEventListener("input", onInput, true)

  return () => {
    host.removeEventListener("input", onInput, true)
  }
}

/**
 * 이 keydown 이 글자를 만들어 내는가(= `input` 이벤트로 이어지는가).
 *
 * - `keyCode 229` / `isComposing`: 입력기(IME)가 처리 중인 키.
 * - 한 글자짜리 `key` 에 Ctrl·Cmd 가 없으면 글자다. Enter·방향키 등은 `key` 가 여러 글자라
 *   여기 걸리지 않고, Ctrl·Cmd 조합은 글자가 아니라 명령이라 xterm 이 처리해야 한다.
 *   Option(alt)은 macOS 에서 글자를 만들므로(예: `¡`) 제외하지 않는다.
 */
export function producesText(ev: KeyboardEvent): boolean {
  if (ev.keyCode === 229 || ev.isComposing) return true
  return ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey
}

/**
 * `input` 이벤트를 터미널로 보낼 바이트로 옮긴다. 상태는 "직전에 보낸 조각" 하나뿐이라
 * DOM 없이 그대로 테스트할 수 있다(`bin/ime-harness.sh` 가 실측 순서로 돌린다).
 */
export class ImeInput {
  /** 직전에 **우리가 실제로 보낸** 조각. `insertReplacementText` 는 이만큼 지우고 새로 쓴다. */
  private _pending = ""

  /** 테스트·진단용. */
  public get pending(): string {
    return this._pending
  }

  /** 되돌릴 조각을 잊는다(원격 커서가 움직였을 때). */
  public reset(): void {
    this._pending = ""
  }

  /** @returns 터미널로 보낼 문자열(빈 문자열이면 보내지 않는다). */
  public handleInput(inputType: string, data: string | null): string {
    if (!data) {
      if (inputType === "insertText") this._pending = ""
      return ""
    }
    if (inputType === "insertText") {
      // 새 조각의 시작. 우리가 보내므로 기록도 정확하다(xterm 이 삼킬 여지가 없다).
      this._pending = data
      return data
    }
    // insertReplacementText — 직전 조각을 지우고 새 값으로 바꾼다.
    if (data === this._pending) return "" // 같은 값 재통지(확정 시 한 번 더 온다).
    const out = DEL.repeat(this._pending.length) + data
    this._pending = data
    return out
  }
}
