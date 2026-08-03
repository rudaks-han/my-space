import { useMemo } from "react"

/** 화면에 그릴 diff 한 줄. */
interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "ctx"
  text: string
  /** 변경 전 파일에서의 줄 번호(추가된 줄에는 없다). */
  oldNo: number | null
  /** 변경 후 파일에서의 줄 번호(삭제된 줄에는 없다). */
  newNo: number | null
}

/** `@@ -12,7 +14,9 @@` 에서 양쪽 시작 줄 번호를 뽑는다. */
function parseHunk(line: string): { old: number; next: number } | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
  return m ? { old: Number(m[1]), next: Number(m[2]) } : null
}

/**
 * unified diff 를 줄 목록으로 바꾸면서 양쪽 줄 번호를 계산한다.
 *
 * 줄 번호는 hunk 헤더에서 시작해 컨텍스트 줄은 양쪽 모두, `-` 는 이전 쪽만,
 * `+` 는 이후 쪽만 증가시킨다 — IntelliJ diff 의 좌우 거터와 같은 규칙.
 */
function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of text.split("\n")) {
    // 마지막 개행 뒤의 빈 줄은 버린다(모든 diff 끝에 생긴다).
    if (raw === "" && out.length && out[out.length - 1].kind !== "meta")
      continue
    const hunk = parseHunk(raw)
    if (hunk) {
      oldNo = hunk.old
      newNo = hunk.next
      out.push({ kind: "hunk", text: raw, oldNo: null, newNo: null })
      continue
    }
    if (
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file") ||
      raw.startsWith("deleted file") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename from") ||
      raw.startsWith("rename to") ||
      raw.startsWith("Binary files")
    ) {
      out.push({ kind: "meta", text: raw, oldNo: null, newNo: null })
      continue
    }
    if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ })
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++, newNo: null })
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
      out.push({ kind: "meta", text: raw, oldNo: null, newNo: null })
    } else {
      out.push({
        kind: "ctx",
        text: raw.startsWith(" ") ? raw.slice(1) : raw,
        oldNo: oldNo++,
        newNo: newNo++,
      })
    }
  }
  return out
}

const ROW_STYLE: Record<DiffLine["kind"], string> = {
  meta: "text-muted-foreground",
  hunk: "bg-ui-info/10 text-ui-info",
  add: "bg-ui-success/10",
  del: "bg-ui-error/10",
  ctx: "",
}

/** 변경 줄 앞에 붙는 기호(추가 +, 삭제 −). */
const ROW_SIGN: Record<DiffLine["kind"], string> = {
  meta: " ",
  hunk: " ",
  add: "+",
  del: "−",
  ctx: " ",
}

/**
 * 파일 하나의 diff 를 보여 준다.
 *
 * 좌우 분할(side-by-side)이 아니라 unified 인 이유: 이 창의 오른쪽 절반에 들어가는데
 * 반으로 또 나누면 한 줄에 40자도 안 들어간다.
 */
export function DiffPane({
  title,
  subtitle,
  text,
  loading,
  error,
}: {
  /** 헤더에 굵게 쓸 파일명. 선택된 파일이 없으면 null. */
  title: string | null
  /** 헤더 오른쪽의 부가 설명(스테이지 여부 등). */
  subtitle?: string
  text: string
  loading: boolean
  error: string | null
}) {
  const lines = useMemo(() => (text ? parseDiff(text) : []), [text])

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        {title ? (
          <>
            <span className="truncate text-[13px] font-bold">{title}</span>
            {subtitle && (
              <span className="shrink-0 text-[13px] text-muted-foreground">
                {subtitle}
              </span>
            )}
          </>
        ) : (
          <span className="text-[13px] text-muted-foreground">
            파일을 선택하면 변경 내용을 보여 줍니다
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-[13px]">
            <div className="font-semibold text-ui-error">
              변경 내용을 읽지 못했습니다
            </div>
            <div className="mt-1 font-mono break-all text-muted-foreground">
              {error}
            </div>
          </div>
        ) : loading ? (
          <div className="p-4 text-[13px] text-muted-foreground">
            불러오는 중…
          </div>
        ) : !title ? null : lines.length === 0 ? (
          <div className="p-4 text-[13px] text-muted-foreground">
            표시할 변경이 없습니다.
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.6]">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i} className={ROW_STYLE[l.kind]}>
                  <td className="w-10 shrink-0 border-r border-border/60 px-1.5 text-right align-top text-muted-foreground/70 select-none">
                    {l.oldNo ?? ""}
                  </td>
                  <td className="w-10 shrink-0 border-r border-border/60 px-1.5 text-right align-top text-muted-foreground/70 select-none">
                    {l.newNo ?? ""}
                  </td>
                  <td className="w-4 pl-1.5 text-center align-top select-none">
                    {ROW_SIGN[l.kind]}
                  </td>
                  <td className="w-full py-px pr-3 pl-1 whitespace-pre-wrap">
                    {l.text || " "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
