import { useState } from "react"
import {
  Loader2Icon,
  PlugIcon,
  PlugZapIcon,
  RotateCwIcon,
  Settings2Icon,
} from "lucide-react"

import { ElasticsearchBrandIcon } from "@/components/brand-icons"
import { Button } from "@/components/ui/button"
import { useEsConn } from "@/features/es-viewer/es-conn-store"
import { fmtNum, HEALTH_COLOR } from "@/features/es-viewer/es-utils"
import { getIndexFilter, setIndexFilter } from "@/features/es-viewer/persisted"
import { cn } from "@/lib/utils"
import {
  PanelEmpty,
  PanelFilter,
  PanelHeader,
  PanelNote,
  PanelRow,
  PanelValue,
} from "./panel-tree"
import { esIndexTabId } from "./types"
import { ES_SCOPE, type EsSession } from "./use-es-session"

/**
 * 오른쪽 인프라 패널의 Elasticsearch 장 — 데이터베이스 장과 같은 자리에 레일로 갈아 끼운다.
 *
 * 여기서 하는 일은 **고르는 것**뿐이다: 붙이고, 인덱스를 눌러 가운데 탭으로 보낸다.
 * 조회 화면(`IndexPane`)은 이 패널이 아니라 루트가 여는 가운데 탭이다 — 그쪽은 컬럼 선택
 * 팝오버가 `w-72` 이고 결과 격자가 가로로 넓어서 280px 칸에서는 아무것도 읽히지 않는다.
 *
 * **접속 정보 편집도 여기 두지 않는다.** 호스트·포트·계정·HTTPS 를 세로로 늘어놓으면
 * 정작 인덱스 목록이 안 보이는데, 주소를 고치는 일은 드물고 인덱스를 누르는 일은 잦다.
 * 그래서 `onManage()` 로 루트의 레이어를 부른다 — `db-panel.tsx` 가 이미 내린 판단이다.
 *
 * 세션(연결·인덱스 목록)은 `useEsSession` 이 주인이고 여기는 받아 쓰기만 한다. 목록을
 * 패널이 들면 가운데 탭이 `meta`(health·문서 수)를 못 받는다(그쪽 머리말 참고).
 */

export interface EsPanelProps {
  session: EsSession
  /** 가운데에 떠 있는 탭의 id — 어느 줄이 눌린 것인지를 정한다(데이터베이스 장과 같다). */
  activeId: string | null
  /** 인덱스 행 클릭 — 루트가 가운데 `index` 탭으로 연다. */
  onOpenIndex: (index: string) => void
  /** 접속 설정 대화상자를 연다(루트가 가지고 있다). */
  onManage: () => void
  className?: string
}

export function EsPanel({
  session,
  activeId,
  onOpenIndex,
  onManage,
  className,
}: EsPanelProps) {
  // 주소 한 줄을 위해 접속 정보를 읽는다. 프로바이더가 창마다 하나 걸려 있어 세션 훅과
  // 같은 값을 본다 — `useLocalStorage` 를 직접 부르면 같은 창 안의 두 벌이 갈라진다.
  const { conn } = useEsConn()
  const { client, cluster, connecting, connError } = session

  const [filter, setFilter] = useState(() => getIndexFilter(ES_SCOPE))

  const address = conn.host.trim()
    ? `${conn.https ? "https" : "http"}://${conn.host.trim()}${conn.port ? `:${conn.port}` : ""}`
    : ""

  const needle = filter.trim().toLowerCase()
  // 정렬은 세션이 이미 `sortIndices` 로 해 두었다(뷰어와 같은 순서여야 한다).
  const visible = session.indices.filter(
    (i) => !needle || i.index.toLowerCase().includes(needle)
  )

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <PanelHeader label="Elasticsearch">
        {/* 접속이 하나뿐이라 고르는 `<select>` 가 없다 — 그 자리에 지금 보고 있는 주소를
            칩으로 둔다. 주소가 없으면 아예 그리지 않는다(빈 칩은 고장처럼 읽힌다). */}
        {address && (
          <span
            className="min-w-0 flex-1 truncate rounded-lg bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={cluster ? `${address}\n${cluster}` : address}
          >
            {address}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            title={client ? `연결 해제 · ${cluster ?? ""}` : "연결"}
            disabled={connecting}
            onClick={() => {
              if (client) session.disconnect()
              else void session.connect()
            }}
          >
            {client ? (
              <PlugZapIcon className="text-ui-success" />
            ) : (
              <PlugIcon />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="인덱스 목록 새로고침"
            disabled={!client}
            onClick={() => void session.reloadIndices()}
          >
            <RotateCwIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="접속 설정"
            onClick={onManage}
          >
            <Settings2Icon />
          </Button>
        </div>
      </PanelHeader>

      {/* ── 본문: 상태마다 다른 몸통을 그린다 ──
          바쁜 표시를 낡은 목록 위에 덧씌우지 않는다 — 끊긴 채 남아 있는 인덱스 이름을
          누르면 열리지 않는 탭이 생기고, 그게 왜인지 알 길이 없다. */}
      {address === "" ? (
        <PanelEmpty
          icon={ElasticsearchBrandIcon}
          title="클러스터 주소가 없습니다"
          desc="접속 설정에서 호스트를 넣으세요."
          action={
            <Button variant="outline" size="xs" onClick={onManage}>
              <Settings2Icon />
              접속 설정
            </Button>
          }
        />
      ) : connecting ? (
        <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <Loader2Icon className="size-3.5 animate-spin" />
          연결 중…
        </div>
      ) : !client ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
          <Button size="sm" onClick={() => void session.connect()}>
            <PlugIcon />
            연결
          </Button>
          <p className="text-[11px] text-muted-foreground">
            접속 설정의 <b>자동 연결</b>을 켜 두면 화면을 열 때 바로 붙습니다.
          </p>
          {connError && (
            <div className="rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error">
              {connError}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="shrink-0 px-2 pt-1.5">
            <PanelFilter
              value={filter}
              placeholder="인덱스 검색…"
              onChange={(v) => {
                setFilter(v)
                setIndexFilter(v, ES_SCOPE)
              }}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {visible.length === 0 ? (
              <PanelNote depth={0}>
                {needle
                  ? "검색과 일치하는 인덱스가 없습니다."
                  : "인덱스가 없습니다."}
              </PanelNote>
            ) : (
              visible.map((idx) => (
                <PanelRow
                  key={idx.index}
                  depth={0}
                  // health 는 아이콘이 아니라 점이라 `leading` 으로 넣는다. 색 클래스는
                  // `HEALTH_COLOR` 표에서 **글자 그대로** 온다(조립하면 규칙이 안 생긴다).
                  leading={
                    // 점을 아이콘과 같은 폭(14px)의 칸에 넣는다 — 그냥 8px 점을 두면
                    // 데이터베이스 장으로 갈아 끼울 때 글자 시작 위치가 6px 어긋난다.
                    <span className="flex size-3.5 shrink-0 items-center justify-center">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          HEALTH_COLOR[idx.health ?? "green"] ??
                            "bg-muted-foreground"
                        )}
                      />
                    </span>
                  }
                  label={idx.index}
                  title={`${idx.index} · ${idx.health ?? "?"} · 문서 ${fmtNum(idx["docs.count"])}건`}
                  right={<PanelValue>{fmtNum(idx["docs.count"])}</PanelValue>}
                  selected={esIndexTabId(idx.index) === activeId}
                  onClick={() => onOpenIndex(idx.index)}
                />
              ))
            )}
          </div>

          {/* 목록을 읽다 실패한 경우에도 목록은 남겨 두고 아래에 이유만 붙인다. */}
          {connError && (
            <div className="shrink-0 border-t border-border px-2 py-1.5 text-[11px] whitespace-pre-wrap text-ui-error">
              {connError}
            </div>
          )}
        </>
      )}
    </div>
  )
}
