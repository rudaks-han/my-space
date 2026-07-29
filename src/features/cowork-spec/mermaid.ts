/*
 * mermaid 코드펜스를 다이어그램(SVG)으로 그린다.
 *
 * mermaid 는 무거우므로(수백 KB) 이 모듈에서 **동적 import** 해, 실제로 mermaid 블록이
 * 있는 문서를 열었을 때만 로드한다. 렌더 결과 SVG 는 섀도 DOM 안의 컨테이너에 그대로
 * 넣는다(mermaid.render 는 문서 어디에 있든 SVG 문자열을 돌려주므로 섀도 DOM 과 무관).
 *
 * 문서는 Typora 처럼 흰 배경이므로 mermaid 도 라이트 테마(default)로 그린다.
 */

let counter = 0
let initialized = false

/**
 * 주어진 `.mermaid-diagram` 컨테이너들을 다이어그램으로 렌더링한다.
 * 각 컨테이너의 textContent 가 mermaid 원문이다(markdown.ts 가 넣어 둔다).
 * 이미 처리한(성공/실패) 컨테이너는 건너뛴다.
 */
export async function renderMermaid(
  blocks: NodeListOf<HTMLElement> | HTMLElement[]
): Promise<void> {
  const targets = Array.from(blocks).filter((el) => !el.dataset.mermaidDone)
  if (targets.length === 0) return

  const mermaid = (await import("mermaid")).default
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "default",
      securityLevel: "loose",
    })
    initialized = true
  }

  for (const el of targets) {
    el.dataset.mermaidDone = "1"
    const source = (el.textContent ?? "").trim()
    if (!source) {
      el.classList.add("is-error")
      continue
    }
    try {
      const { svg } = await mermaid.render(`mmd-${(counter += 1)}`, source)
      el.innerHTML = svg
      el.classList.add("is-rendered")
    } catch {
      // 문법 오류 등으로 실패하면 원문을 그대로 보여 준다(내용을 잃지 않도록).
      el.textContent = source
      el.classList.add("is-error")
    }
  }
}
