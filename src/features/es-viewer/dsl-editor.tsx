import { useLayoutEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import { DSL_KEYWORDS, type FieldInfoMap } from "./es-utils"

interface AcItem {
  value: string
  tag: string
  kw: boolean
}

/**
 * Query DSL 입력기 — Kibana Dev Tools 를 본뜬 편의 기능을 갖춘 textarea.
 *  - 괄호/따옴표 자동 닫기·오버타이프·빈 쌍 Backspace·Enter 들여쓰기 확장
 *  - 매핑 필드명 + ES 키워드 자동완성(↑↓ 이동, Enter/Tab 선택, Esc 닫기)
 *  - Ctrl/Cmd+Enter 로 실행
 *
 * 값은 부모가 소유(controlled)한다. 프로그램적으로 값을 바꿀 때는 caret 위치를 ref 에
 * 담아 두었다가 value 반영 직후 layout effect 에서 복원한다.
 */
export function DslEditor({
  value,
  onChange,
  onRun,
  fields,
  fieldInfo,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  onRun: () => void
  fields: string[]
  fieldInfo: FieldInfoMap
  disabled?: boolean
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const caretRef = useRef<number | null>(null)
  const acRange = useRef({ start: 0, end: 0 })

  const [acItems, setAcItems] = useState<AcItem[]>([])
  const [acActive, setAcActive] = useState(0)
  const [acPos, setAcPos] = useState<{ left: number; top: number } | null>(null)
  const acOpen = acPos !== null && acItems.length > 0

  // 프로그램적으로 바꾼 값이 반영된 뒤 caret 복원.
  useLayoutEffect(() => {
    if (caretRef.current != null && taRef.current) {
      taRef.current.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
  }, [value])

  /** 값과 caret 을 함께 바꾼다(프로그램적 편집). */
  const setValueCaret = (v: string, caret: number) => {
    caretRef.current = caret
    onChange(v)
    // 값 반영 후 자동완성 갱신(다음 tick).
    requestAnimationFrame(() => updateAutocomplete())
  }

  const hideAc = () => {
    setAcPos(null)
    setAcItems([])
  }

  /* ── 자동완성 ── */
  function updateAutocomplete() {
    const ta = taRef.current
    if (!ta) return
    const val = ta.value
    const caret = ta.selectionStart
    const before = val.slice(0, caret)
    const m = before.match(/[\w.]+$/)
    if (!m) {
      hideAc()
      return
    }
    const token = m[0]
    const lower = token.toLowerCase()
    const cands: AcItem[] = []
    fields.forEach((f) => {
      if (f.toLowerCase().includes(lower))
        cands.push({ value: f, tag: fieldInfo[f]?.type || "field", kw: false })
    })
    DSL_KEYWORDS.forEach((k) => {
      if (k.toLowerCase().includes(lower))
        cands.push({ value: k, tag: "DSL", kw: true })
    })
    // startsWith 를 먼저.
    cands.sort((a, b) => {
      const as = a.value.toLowerCase().startsWith(lower) ? 0 : 1
      const bs = b.value.toLowerCase().startsWith(lower) ? 0 : 1
      return as - bs
    })
    const items = cands.slice(0, 12)
    if (items.length === 0) {
      hideAc()
      return
    }
    acRange.current = { start: caret - token.length, end: caret }
    setAcItems(items)
    setAcActive(0)
    setAcPos(caretCoords(ta, acRange.current.start))
  }

  /** 캐럿(토큰 시작) 위치를 textarea 미러 div 로 계산. */
  function caretCoords(ta: HTMLTextAreaElement, pos: number) {
    if (!mirrorRef.current) {
      const d = document.createElement("div")
      wrapRef.current?.appendChild(d)
      mirrorRef.current = d
    }
    const div = mirrorRef.current!
    const cs = getComputedStyle(ta)
    const props = [
      "boxSizing",
      "width",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "lineHeight",
      "letterSpacing",
      "whiteSpace",
      "wordWrap",
      "tabSize",
      "textIndent",
    ] as const
    props.forEach((p) => {
      div.style[p as never] = cs[p as never]
    })
    div.style.position = "absolute"
    div.style.top = "0"
    div.style.left = "0"
    div.style.visibility = "hidden"
    div.style.overflow = "hidden"
    div.style.pointerEvents = "none"
    div.style.height = "auto"

    div.textContent = ta.value.slice(0, pos)
    const span = document.createElement("span")
    span.textContent = ta.value.slice(pos) || "."
    div.appendChild(span)
    let lh = parseFloat(cs.lineHeight)
    if (!lh) lh = parseFloat(cs.fontSize) * 1.4
    const coords = {
      left: Math.max(0, span.offsetLeft - ta.scrollLeft),
      top: span.offsetTop - ta.scrollTop + lh + 2,
    }
    div.removeChild(span)
    return coords
  }

  function acceptActive(idx = acActive) {
    const it = acItems[idx]
    const ta = taRef.current
    if (!it || !ta) {
      hideAc()
      return
    }
    const val = ta.value
    const before = val.slice(0, acRange.current.start)
    const after = val.slice(acRange.current.end)
    const prevChar = before.slice(-1)
    const nextChar = after.slice(0, 1)
    // 따옴표 안이 아니면 "..." 로 감싸 JSON 키/값 편의 제공.
    let ins: string
    if (prevChar !== '"') ins = `"${it.value}"`
    else if (nextChar === '"') ins = it.value
    else ins = `${it.value}"`
    const newVal = before + ins + after
    const pos = before.length + ins.length
    hideAc()
    caretRef.current = pos
    onChange(newVal)
    requestAnimationFrame(() => taRef.current?.focus())
  }

  /* ── 괄호/따옴표 자동완성 ── */
  function handleBracketKeys(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    const ta = taRef.current!
    const val = ta.value
    const s = ta.selectionStart
    const eSel = ta.selectionEnd
    const OPEN: Record<string, string> = { "{": "}", "[": "]", "(": ")" }
    const CLOSE: Record<string, number> = { "}": 1, "]": 1, ")": 1 }

    if (OPEN[e.key]) {
      e.preventDefault()
      const sel = val.slice(s, eSel)
      const ins = e.key + sel + OPEN[e.key]
      setValueCaret(
        val.slice(0, s) + ins + val.slice(eSel),
        sel ? s + ins.length : s + 1
      )
      return true
    }
    if (e.key === '"') {
      e.preventDefault()
      const sel = val.slice(s, eSel)
      if (!sel && val[s] === '"') {
        caretRef.current = s + 1
        onChange(val) // 값은 그대로, caret 만 오버타이프 이동
      } else {
        const ins = '"' + sel + '"'
        setValueCaret(
          val.slice(0, s) + ins + val.slice(eSel),
          sel ? s + ins.length : s + 1
        )
      }
      return true
    }
    if (CLOSE[e.key] && s === eSel && val[s] === e.key) {
      e.preventDefault()
      caretRef.current = s + 1
      onChange(val)
      return true
    }
    if (e.key === "Backspace" && s === eSel && s > 0) {
      const p = val[s - 1]
      const n = val[s]
      if (
        (p === "{" && n === "}") ||
        (p === "[" && n === "]") ||
        (p === "(" && n === ")") ||
        (p === '"' && n === '"')
      ) {
        e.preventDefault()
        setValueCaret(val.slice(0, s - 1) + val.slice(s + 1), s - 1)
        return true
      }
    }
    if (e.key === "Enter" && s === eSel) {
      const lineStart = val.lastIndexOf("\n", s - 1) + 1
      const indent = (val.slice(lineStart, s).match(/^[ \t]*/) || [""])[0]
      const p = val[s - 1]
      const n = val[s]
      const inPair = (p === "{" && n === "}") || (p === "[" && n === "]")
      e.preventDefault()
      if (inPair) {
        const inner = indent + "  "
        const ins = "\n" + inner + "\n" + indent
        setValueCaret(
          val.slice(0, s) + ins + val.slice(s),
          s + 1 + inner.length
        )
      } else {
        const ins = "\n" + indent
        setValueCaret(val.slice(0, s) + ins + val.slice(s), s + ins.length)
      }
      return true
    }
    return false
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (acOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setAcActive((a) => (a + 1) % acItems.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setAcActive((a) => (a - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        acceptActive()
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        hideAc()
        return
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      hideAc()
      onRun()
      return
    }
    if (!e.nativeEvent.isComposing) handleBracketKeys(e)
  }

  return (
    <div ref={wrapRef} className="relative w-full">
      <textarea
        ref={taRef}
        value={value}
        disabled={disabled}
        spellCheck={false}
        placeholder={
          'Query DSL (예: { "match": { "필드명": "값" } })   ·   Ctrl+Enter 로 실행'
        }
        onChange={(e) => {
          onChange(e.target.value)
          updateAutocomplete()
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(hideAc, 150)}
        className="h-24 w-full resize-y rounded-lg border border-input bg-background p-2.5 font-mono text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 focus-visible:outline-solid disabled:pointer-events-none disabled:opacity-50"
      />
      {acOpen && acPos && (
        <div
          className="absolute z-20 max-h-56 w-64 overflow-auto rounded-lg border border-border bg-popover py-1 shadow-[0_4px_16px_rgba(0,0,0,0.16)]"
          style={{ left: acPos.left, top: acPos.top }}
        >
          {acItems.map((it, i) => (
            <div
              key={it.value + i}
              onMouseDown={(e) => {
                e.preventDefault()
                acceptActive(i)
              }}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-2 px-2.5 py-1 text-[13px]",
                i === acActive
                  ? "bg-ui-selection text-ui-selection-fg"
                  : "hover:bg-ui-list-hover"
              )}
            >
              <span className="truncate font-mono">{it.value}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full px-1.5 text-[10px] font-bold",
                  it.kw
                    ? "bg-ui-mention text-ui-mention-fg"
                    : i === acActive
                      ? "bg-white/20"
                      : "bg-muted text-muted-foreground"
                )}
              >
                {it.tag}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
