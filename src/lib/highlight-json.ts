/** JSON.stringify 결과에 토큰 span(jkey/jstr/jnum/jbool/jnull)을 입혀 HTML 문자열로. */
export function highlightJson(obj: unknown): string {
  const json = JSON.stringify(obj, null, 2)
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
