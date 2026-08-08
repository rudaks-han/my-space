import { useEffect, useState } from "react"
import { PlugIcon, PlugZapIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import * as db from "./db-client"
import type { ConnInfo, DriverJar } from "./db-client"
import { ENGINES, engineById, resolveUrl, type DbConnection } from "./engines"

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-background px-2 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-solid focus-visible:outline-ring"

const labelClass = "text-[11px] font-semibold text-muted-foreground"

export interface ConnectionFormProps {
  conn: DbConnection
  onChange: (patch: Partial<DbConnection>) => void
  onDelete: () => void
  onConnect: (password: string) => void
  onDisconnect: () => void
  connecting: boolean
  info: ConnInfo | null
  error: string | null
}

/**
 * 접속 정보 편집 + 연결.
 *
 * 비밀번호는 이 컴포넌트의 로컬 state 로만 들고, 저장은 Rust 가 기기 암호화해서 한다
 * (`db_connect` 의 `savePassword`). 프론트의 localStorage 에는 절대 넣지 않는다 —
 * 웹뷰의 localStorage 는 평문 파일이라 접속 정보 파일 하나가 곧 사내 DB 비밀번호가 된다.
 *
 * URL 은 폼에서 자동으로 만들어지지만, 사용자가 URL 칸을 직접 고치면 그때부터
 * 자동 생성을 멈춘다(`urlOverride`). "재생성"으로 다시 폼을 따르게 되돌린다.
 */
export function ConnectionForm({
  conn,
  onChange,
  onDelete,
  onConnect,
  onDisconnect,
  connecting,
  info,
  error,
}: ConnectionFormProps) {
  const spec = engineById(conn.engine)
  const [password, setPassword] = useState("")
  const [hasSaved, setHasSaved] = useState(false)
  const [drivers, setDrivers] = useState<DriverJar[]>([])

  // 저장된 비밀번호가 있는지 — 있으면 칸을 비워 둬도 그걸 쓴다는 걸 알려 준다.
  // 접속을 바꾸면 부모가 `key={conn.id}` 로 이 컴포넌트를 새로 마운트하므로
  // 비밀번호 칸은 여기서 비울 필요 없이 처음부터 비어 있다.
  useEffect(() => {
    let cancelled = false
    void db
      .hasSavedPassword(conn.id)
      .then((v) => !cancelled && setHasSaved(v))
      .catch(() => !cancelled && setHasSaved(false))
    return () => {
      cancelled = true
    }
  }, [conn.id])

  // 엔진이 바뀌면 드라이버 후보를 다시 찾는다.
  useEffect(() => {
    let cancelled = false
    void db
      .findDrivers(conn.engine)
      .then((list) => {
        if (cancelled) return
        setDrivers(list)
        // 아직 고른 jar 가 없으면 가장 최신 것을 기본으로 잡아 준다.
        if (conn.jars.length === 0 && list.length > 0) {
          onChange({ jars: [list[0].path] })
        }
      })
      .catch(() => !cancelled && setDrivers([]))
    return () => {
      cancelled = true
    }
    // conn.jars / onChange 를 의존성에 넣으면 기본값을 잡는 순간 다시 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.engine, conn.id])

  const url = resolveUrl(conn)
  const connected = info !== null

  return (
    <div className="flex flex-col gap-2">
      {/* 이름 · 엔진 */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>이름</label>
          <Input
            value={conn.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="h-8"
          />
        </div>
        <div className="w-28">
          <label className={labelClass}>엔진</label>
          <select
            value={conn.engine}
            onChange={(e) => {
              const next = engineById(e.target.value)
              onChange({
                engine: e.target.value,
                port: String(next.defaultPort),
                // 엔진이 바뀌면 이전 엔진용 jar 와 직접 고친 URL 은 의미가 없다.
                jars: [],
                urlOverride: "",
              })
            }}
            className={selectClass}
          >
            {ENGINES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 접속 대상 */}
      {spec.form === "server" ? (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelClass}>호스트</label>
              <Input
                value={conn.host}
                onChange={(e) => onChange({ host: e.target.value })}
                className="h-8"
              />
            </div>
            <div className="w-20">
              <label className={labelClass}>포트</label>
              <Input
                value={conn.port}
                onChange={(e) => onChange({ port: e.target.value })}
                className="h-8"
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>
              {spec.databaseLabel ?? "데이터베이스"}
            </label>
            <Input
              value={conn.database}
              onChange={(e) => onChange({ database: e.target.value })}
              className="h-8"
            />
          </div>
        </>
      ) : (
        <div>
          <label className={labelClass}>파일 경로</label>
          <Input
            value={conn.file}
            placeholder="/Users/…/data/mydb"
            onChange={(e) => onChange({ file: e.target.value })}
            className="h-8"
          />
        </div>
      )}

      {/* 계정 */}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className={labelClass}>사용자</label>
          <Input
            value={conn.user}
            onChange={(e) => onChange({ user: e.target.value })}
            className="h-8"
          />
        </div>
        <div className="flex-1">
          <label className={labelClass}>비밀번호</label>
          <Input
            type="password"
            value={password}
            placeholder={hasSaved ? "저장된 값 사용" : ""}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onConnect(password)}
            className="h-8"
          />
        </div>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={conn.savePassword}
          onChange={(e) => onChange({ savePassword: e.target.checked })}
        />
        비밀번호 저장 (이 맥에 묶인 키로 암호화해 보관)
      </label>

      {/* 드라이버 */}
      <div>
        <label className={labelClass}>드라이버 jar</label>
        {drivers.length === 0 ? (
          <p className="rounded-lg bg-ui-warning/10 px-2 py-1.5 text-[11px] text-foreground">
            드라이버를 찾지 못했습니다. 메이븐/그레이들로 한 번 받아 두면
            자동으로 잡힙니다:
            <br />
            <code className="font-mono">{spec.driverHint}</code>
          </p>
        ) : (
          <select
            value={conn.jars[0] ?? ""}
            onChange={(e) =>
              onChange({ jars: e.target.value ? [e.target.value] : [] })
            }
            className={selectClass}
          >
            <option value="">(선택 안 함)</option>
            {drivers.map((d) => (
              <option key={d.path} value={d.path} title={d.path}>
                {d.name} · {d.source}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* URL */}
      <div>
        <div className="flex items-center justify-between">
          <label className={labelClass}>JDBC URL</label>
          {conn.urlOverride.trim() && (
            <button
              onClick={() => onChange({ urlOverride: "" })}
              title="폼 값으로 다시 만들기"
              className="flex items-center gap-1 text-[11px] text-ui-link hover:underline"
            >
              <RefreshCwIcon className="size-3" />
              재생성
            </button>
          )}
        </div>
        <Input
          value={url}
          onChange={(e) => onChange({ urlOverride: e.target.value })}
          spellCheck={false}
          className="h-8 font-mono text-[12px]"
        />
      </div>

      <p className="text-[11px] text-muted-foreground">{spec.hint}</p>

      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={conn.autoConnect}
          onChange={(e) => onChange({ autoConnect: e.target.checked })}
        />
        자동 연결 (다음 실행 시 자동 접속)
      </label>

      {/* 동작 */}
      <div className="flex gap-1.5">
        {connected ? (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={onDisconnect}
          >
            <PlugZapIcon />
            해제
          </Button>
        ) : (
          <Button
            size="sm"
            className="flex-1"
            disabled={connecting}
            onClick={() => onConnect(password)}
          >
            <PlugIcon />
            {connecting ? "연결 중…" : "연결"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          title="이 접속 삭제"
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>

      {info && (
        <div className="rounded-lg bg-ui-success/10 px-2.5 py-1.5 text-[12px] text-ui-success">
          ✓ {info.product} {info.productVersion.split(" ")[0]}
          <span className="block text-[11px] opacity-80">
            {info.driverName} {info.driverVersion.split(" ")[0]}
          </span>
        </div>
      )}
      {error && (
        <div
          className={cn(
            "rounded-lg bg-ui-error/10 px-2.5 py-1.5 text-[12px] whitespace-pre-wrap text-ui-error",
            "max-h-40 overflow-auto"
          )}
        >
          {error}
        </div>
      )}
    </div>
  )
}
