/** JSON.stringify 결과에 토큰 span(jkey/jstr/jnum/jbool/jnull)을 입혀 HTML 문자열로. */
export function highlightJson(
  obj: unknown,
  indent: number | string = 2
): string {
  return highlightJsonText(JSON.stringify(obj, null, indent))
}

/** 이미 문자열로 만들어 둔 JSON 에 같은 토큰 span 을 입힌다. */
export function highlightJsonText(text: string): string {
  const json = (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "jnum"
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "jkey" : "jstr"
      } else if (/true|false/.test(match)) {
        cls = "jbool"
      } else if (/null/.test(match)) {
        cls = "jnull"
      }
      return `<span class="${cls}">${match}</span>`
    }
  )
}
