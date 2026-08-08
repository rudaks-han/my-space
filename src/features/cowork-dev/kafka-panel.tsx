import { useState } from "react"
import {
  LayersIcon,
  Loader2Icon,
  PlugIcon,
  PlugZapIcon,
  RotateCwIcon,
  ServerIcon,
  Settings2Icon,
  UsersIcon,
} from "lucide-react"

import { KafkaBrandIcon } from "@/components/brand-icons"
import { Button } from "@/components/ui/button"
import { fmtNum } from "@/features/kafka-viewer/kafka-utils"
import { useKafkaConn } from "@/features/kafka-viewer/kafka-conn-store"
import {
  getShowInternal,
  getTopicFilter,
  setShowInternal,
  setTopicFilter,
} from "@/features/kafka-viewer/persisted"
import { cn } from "@/lib/utils"
import {
  PanelEmpty,
  PanelFilter,
  PanelHeader,
  PanelNote,
  PanelRow,
  PanelValue,
} from "./panel-tree"
import { kafkaTopicTabId } from "./types"
import { KAFKA_SCOPE, type KafkaSession } from "./use-kafka-session"

/**
 * 오른쪽 인프라 패널의 Kafka 장 — `es-panel.tsx` 와 같은 모양이고, 이유도 같다:
 * 여기서는 고르기만 하고 조회 화면은 루트가 여는 가운데 탭이다(`TopicPane` 의 메시지 표는
 * `table-fixed` 로 620px 남짓, `GroupsPane` 은 목록이 `w-72` — 둘 다 280px 칸에 안 든다).
 *
 * 접속 정보 편집도 `onManage()` 로 루트 레이어에 맡긴다. 브로커 주소는 드물게 고치고
 * 토픽은 늘 누른다.
 */

export interface KafkaPanelProps {
  session: KafkaSession
  /** 가운데에 떠 있는 탭의 id — 어느 줄이 눌린 것인지를 정한다(데이터베이스 장과 같다). */
  activeId: string | null
  /** 토픽 행 클릭 — 루트가 가운데 `topic` 탭으로 연다. */
  onOpenTopic: (topic: string) => void
  /** 컨슈머 그룹 탭을 연다. */
  onOpenGroups: () => void
  /** 브로커 탭을 연다. */
  onOpenBrokers: () => void
  /** 접속 설정 대화상자를 연다(루트가 가지고 있다). */
  onManage: () => void
  className?: string
}

export function KafkaPanel({
  session,
  activeId,
  onOpenTopic,
  onOpenGroups,
  onOpenBrokers,
  onManage,
  className,
}: KafkaPanelProps) {
  // 주소 한 줄을 위해 접속 정보를 읽는다. 프로바이더가 창마다 하나 걸려 있어 세션 훅과
  // 같은 값을 본다 — `useLocalStorage` 를 직접 부르면 같은 창 안의 두 벌이 갈라진다.
  const { conn } = useKafkaConn()
  const { client, cluster, connecting, reloading, connError } = session

  const [filter, setFilter] = useState(() => getTopicFilter(KAFKA_SCOPE))
  const [showInternal, setShowInternalState] = useState(() =>
    getShowInternal(KAFKA_SCOPE)
  )

  const address = conn.brokers.trim()

  const needle = filter.trim().toLowerCase()
  const visible = session.topics.filter(
    (t) =>
      (showInternal || !t.internal) &&
      (!needle || t.name.toLowerCase().includes(needle))
  )

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-card", className)}>
      <PanelHeader label="Kafka">
        {/* 접속이 하나뿐이라 고르는 `<select>` 가 없다 — 그 자리에 브로커 주소를 칩으로
            둔다(여러 대면 쉼표로 이어진 한 줄이라 잘림이 필수다). */}
        {address && (
          <span
            className="min-w-0 flex-1 truncate rounded-lg bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={
              cluster
                ? `${address}\n브로커 ${cluster.brokers.length}대 · 토픽 ${fmtNum(cluster.topicCount)}개`
                : address
            }
          >
            {address}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            title={client ? "연결 해제" : "연결"}
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
            title="토픽 목록 새로고침"
            disabled={!client || reloading}
            onClick={() => void session.reloadTopics(session.withCounts)}
          >
            <RotateCwIcon className={cn(reloading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="컨슈머 그룹 열기"
            disabled={!client}
            onClick={onOpenGroups}
          >
            <UsersIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="브로커 열기"
            disabled={!client}
            onClick={onOpenBrokers}
          >
            <ServerIcon />
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
          바쁜 표시를 낡은 목록 위에 덧씌우지 않는다 — 끊긴 채 남아 있는 토픽 이름을
          누르면 열리지 않는 탭이 생기고, 그게 왜인지 알 길이 없다. */}
      {address === "" ? (
        <PanelEmpty
          icon={KafkaBrandIcon}
          title="브로커 주소가 없습니다"
          desc="접속 설정에서 브로커를 넣으세요. (예: 172.16.0.10:9092)"
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
            PLAINTEXT 전용입니다. 접속 설정의 <b>자동 연결</b>을 켜 두면 화면을
            열 때 바로 붙습니다.
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
              placeholder="토픽 검색…"
              onChange={(v) => {
                setFilter(v)
                setTopicFilter(v, KAFKA_SCOPE)
              }}
            />
            <label className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={showInternal}
                onChange={(e) => {
                  setShowInternalState(e.target.checked)
                  setShowInternal(e.target.checked, KAFKA_SCOPE)
                }}
              />
              내부 토픽(__) 표시
            </label>
            {/* 건수 계산은 **저장하지 않는다** — 켜진 채로 시작하면 파티션마다 워터마크를
                왕복해서 화면 여는 데만 몇 초가 들고, 목록에는 `p3` 만 있는데 체크박스는
                켜져 있는 상태가 된다(`use-kafka-session.ts` 의 (b)·(b′) 참고). */}
            <label
              className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground"
              title="파티션마다 오프셋을 읽어야 해서 토픽이 많으면 느려집니다. 이 화면에서는 켤 때만 계산합니다."
            >
              <input
                type="checkbox"
                checked={session.withCounts}
                onChange={(e) => {
                  session.setWithCounts(e.target.checked)
                  void session.reloadTopics(e.target.checked)
                }}
              />
              메시지 건수 계산
            </label>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-1">
            {visible.length === 0 ? (
              <PanelNote depth={0}>
                {needle
                  ? "검색과 일치하는 토픽이 없습니다."
                  : "토픽이 없습니다."}
              </PanelNote>
            ) : (
              visible.map((t) => (
                <PanelRow
                  key={t.name}
                  depth={0}
                  icon={LayersIcon}
                  label={t.name}
                  title={`${t.name} · 파티션 ${t.partitions}개 · 복제 ${t.replication}`}
                  right={
                    // 건수 계산을 끄면 `messages` 가 null 이므로 파티션 수를 대신 보여
                    // 준다 — 좁은 줄에서는 그 편이 "-" 보다 훨씬 쓸 만하다.
                    <PanelValue title={`파티션 ${t.partitions}개`}>
                      {t.messages === null
                        ? `p${t.partitions}`
                        : fmtNum(t.messages)}
                    </PanelValue>
                  }
                  selected={kafkaTopicTabId(t.name) === activeId}
                  onClick={() => onOpenTopic(t.name)}
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
