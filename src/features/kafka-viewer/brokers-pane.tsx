import { cn } from "@/lib/utils"
import type { ClusterInfo } from "./kafka-client"
import { fmtNum } from "./kafka-utils"

/**
 * 브로커 목록 패널.
 *
 * 원래 `kafka-viewer-view.tsx` 안의 지역 함수였는데, 두 번째 화면(IntelliJ Cowork)도 같은
 * 표를 띄우게 되면서 파일로 뺐다 — 뷰어를 통째로 import 하면 왼쪽 연결 패널과 토픽
 * 목록까지 따라온다. `GroupsPane`·`TopicPane` 이 이미 각자 파일인 것과 같은 배치다.
 *
 * 연결 정보를 스스로 읽지 않고 `cluster` 를 그대로 받는다: 브로커 목록은 `connect()` 가
 * 이미 받아 온 `ClusterInfo` 안에 들어 있어서 여기서 다시 물어볼 이유가 없다(그러면
 * 화면마다 메타데이터 호출이 한 번씩 더 늘어난다).
 *
 * 상위 뷰의 keep-alive 탭 더미에 겹쳐 놓이므로 `absolute inset-0` + `invisible` 이다.
 * `hidden`/`display:none` 으로 감추면 다시 열 때 스크롤 위치가 초기화된다.
 */
export function BrokersPane({
  cluster,
  active,
}: {
  cluster: ClusterInfo | null
  active: boolean
}) {
  return (
    <div
      className={cn("absolute inset-0 flex flex-col", !active && "invisible")}
      aria-hidden={!active}
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-[15px] font-bold">브로커</h2>
        <span className="text-[13px] text-muted-foreground">
          {fmtNum(cluster?.brokers.length ?? 0)}대 · 접속{" "}
          {cluster?.origin ?? "-"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-[13px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="w-24 px-3 py-2 font-semibold">ID</th>
              <th className="px-3 py-2 font-semibold">호스트</th>
              <th className="w-28 px-3 py-2 font-semibold">포트</th>
            </tr>
          </thead>
          <tbody>
            {cluster?.brokers.map((b) => (
              <tr key={b.id} className="border-b border-border/60">
                <td className="px-3 py-1.5 font-mono">{b.id}</td>
                <td className="px-3 py-1.5 font-mono">{b.host}</td>
                <td className="px-3 py-1.5 font-mono">{b.port}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
