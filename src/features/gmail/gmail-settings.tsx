import { useEffect, useState } from "react"

import { useSettings } from "@/features/settings/settings-context"

import { GmailConnectionPanel } from "./gmail-connection"

/** 패널 머리말: 18px 굵은 제목 + 13px 설명. (settings-view 의 PanelHeader 와 같은 톤) */
function PanelHeader({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="border-b border-border pb-3">
      <h2 className="text-[18px] font-bold tracking-[-0.01em]">{title}</h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
    </div>
  )
}

/** 한 줄에 하나씩 입력하는 목록 편집기(빈 줄은 무시). */
function ListField({
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  label: string
  hint: string
  placeholder: string
  value: string[]
  onChange: (next: string[]) => void
}) {
  // 편집 중에는 원문(줄바꿈 포함)을 로컬로 들고, 커밋 시 배열로 정규화한다.
  const [text, setText] = useState(value.join("\n"))

  // 외부(설정) 값이 바뀌면(다른 창에서 수정 등) 편집 상자에 반영한다.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(value.join("\n"))
  }, [value])

  function commit(raw: string) {
    const next = raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[15px] font-semibold">{label}</div>
      <p className="text-[13px] text-muted-foreground">{hint}</p>
      <textarea
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        rows={5}
        className="ui-selectable min-h-24 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-[15px] leading-6 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:outline-solid"
      />
    </div>
  )
}

/**
 * Gmail 카테고리 설정 화면 — 계정 연결/해제 + "관심 대상" 메일 필터.
 *
 * 필터(발신자·키워드)는 받은편지함 목록에는 영향을 주지 않는다(전체 메일이 그대로
 * 보인다). 사이드바 안 읽음 배지가 "관심 대상 중 안 읽은 메일" 수만 세는 데 쓰인다.
 */
export function GmailSettingsPanel() {
  const { settings, setGmail } = useSettings()
  const { senders, keywords } = settings.gmail

  return (
    <div className="flex flex-col">
      <PanelHeader
        title="Gmail"
        description="받은편지함·보낸편지함을 보려면 Google 계정을 연결해야 합니다. 연결을 해제하면 저장된 토큰과 클라이언트 정보가 삭제됩니다."
      />

      {/* 연결 관리(연결 · 연결 해제) */}
      <div className="mt-4">
        <GmailConnectionPanel />
      </div>

      {/* 관심 대상 필터 */}
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-[15px] font-semibold">관심 대상 메일</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          아래 조건에 해당하는 메일을 "관심 대상"으로 봅니다. 목록에는 전체
          메일이 그대로 보이고, 사이드바의 안 읽음 배지는 관심 대상 중 안 읽은
          메일 수만 표시합니다. 발신자·키워드가 하나라도 맞으면 관심 대상입니다.
        </p>

        <div className="mt-4 flex flex-col gap-5">
          <ListField
            label="관심 발신자"
            hint="보낸사람 주소에 이 문자열이 포함되면 관심 대상. 전체 주소(boss@company.com)나 도메인 조각(@company.com)을 한 줄에 하나씩."
            placeholder={"boss@company.com\n@team.company.com"}
            value={senders}
            onChange={(next) => setGmail({ senders: next })}
          />
          <ListField
            label="관심 키워드"
            hint="제목·미리보기에 이 문자열이 포함되면 관심 대상. 한 줄에 하나씩."
            placeholder={"배포\n긴급\n승인 요청"}
            value={keywords}
            onChange={(next) => setGmail({ keywords: next })}
          />
        </div>
      </div>
    </div>
  )
}
