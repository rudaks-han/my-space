/**
 * 지원 엔진 카탈로그.
 *
 * 접속 폼은 이 표에서 만들어진다: 어떤 입력칸을 보여 줄지(`form`), 기본 포트, 드라이버
 * 클래스, 그리고 입력값 → JDBC URL 규칙.
 *
 * URL 은 폼에서 자동으로 만들어지지만 **사용자가 직접 고치면 그때부터 자동 생성이 멈춘다**
 * (IntelliJ 와 같은 동작). 그래야 여기서 모델링하지 않은 형태 — H2 서버 모드
 * (`jdbc:h2:tcp://…`), Oracle SID 표기(`…:@host:port:SID`), TNS 별칭, 각종 드라이버
 * 옵션 — 을 쓸 수 있다. 폼을 엔진마다 무한정 늘리는 대신 탈출구를 하나 두는 쪽이다.
 *
 * 드라이버 클래스를 굳이 박아 두는 이유: 브리지는 클래스명이 없으면 ServiceLoader 로
 * 찾는데, jar 를 여러 개 올린 경우 엉뚱한 드라이버가 먼저 잡힐 수 있다.
 */

/** 접속 폼의 모양. */
export type EngineForm = "server" | "file"

export interface EngineSpec {
  id: string
  label: string
  /** `server` = 호스트·포트·데이터베이스, `file` = 파일 경로. */
  form: EngineForm
  driverClass: string
  defaultPort: number
  /** 호스트/포트/DB 또는 파일 경로로 JDBC URL 을 만든다. */
  buildUrl: (f: {
    host: string
    port: string
    database: string
    file: string
  }) => string
  /** 접속 폼 아래에 뜨는 안내. */
  hint: string
  /** 드라이버 jar 를 못 찾았을 때 알려 줄 설치 방법. */
  driverHint: string
  /** `database` 입력칸의 라벨 — 엔진마다 부르는 이름이 다르다. */
  databaseLabel?: string
}

export const ENGINES: EngineSpec[] = [
  {
    id: "mysql",
    label: "MySQL",
    form: "server",
    driverClass: "com.mysql.cj.jdbc.Driver",
    defaultPort: 3306,
    buildUrl: (f) =>
      `jdbc:mysql://${f.host}:${f.port}/${f.database}` +
      `?useSSL=false&allowPublicKeyRetrieval=true&characterEncoding=UTF-8&serverTimezone=Asia/Seoul`,
    hint: "URL 뒤의 옵션은 사내 개발 DB(평문 접속) 기준입니다. 필요하면 직접 고치세요.",
    driverHint: "mysql:mysql-connector-j",
  },
  {
    id: "mariadb",
    label: "MariaDB",
    form: "server",
    driverClass: "org.mariadb.jdbc.Driver",
    defaultPort: 3306,
    buildUrl: (f) => `jdbc:mariadb://${f.host}:${f.port}/${f.database}`,
    hint: "MariaDB 전용 드라이버입니다. MySQL 드라이버로도 대개 붙습니다.",
    driverHint: "org.mariadb.jdbc:mariadb-java-client",
  },
  {
    id: "postgresql",
    label: "PostgreSQL",
    form: "server",
    driverClass: "org.postgresql.Driver",
    defaultPort: 5432,
    buildUrl: (f) => `jdbc:postgresql://${f.host}:${f.port}/${f.database}`,
    hint: "스키마는 접속 후 왼쪽에서 고릅니다(기본 public).",
    driverHint: "org.postgresql:postgresql",
  },
  {
    id: "oracle",
    label: "Oracle",
    form: "server",
    driverClass: "oracle.jdbc.OracleDriver",
    defaultPort: 1521,
    databaseLabel: "서비스명",
    buildUrl: (f) => `jdbc:oracle:thin:@//${f.host}:${f.port}/${f.database}`,
    hint: "서비스명(Service Name) 방식입니다. SID 로 붙으려면 URL 을 `…:@호스트:포트:SID` 로 고치세요.",
    driverHint: "com.oracle.database.jdbc:ojdbc17",
  },
  {
    id: "h2",
    label: "H2",
    form: "file",
    driverClass: "org.h2.Driver",
    defaultPort: 9092,
    buildUrl: (f) => `jdbc:h2:${f.file}`,
    hint: "파일 경로에서 `.mv.db` 는 뺍니다. 서버 모드는 URL 을 `jdbc:h2:tcp://호스트:9092/경로` 로 고치세요.",
    driverHint: "com.h2database:h2",
  },
  {
    id: "sqlite",
    label: "SQLite",
    form: "file",
    driverClass: "org.sqlite.JDBC",
    defaultPort: 0,
    buildUrl: (f) => `jdbc:sqlite:${f.file}`,
    hint: "파일 경로를 그대로 씁니다. 계정·비밀번호는 필요 없습니다.",
    driverHint: "org.xerial:sqlite-jdbc",
  },
]

export function engineById(id: string): EngineSpec {
  return ENGINES.find((e) => e.id === id) ?? ENGINES[0]
}

/** 저장되는 접속 정보. 비밀번호는 여기 없다 — Rust 가 기기 암호화해 따로 보관한다. */
export interface DbConnection {
  id: string
  name: string
  engine: string
  host: string
  port: string
  database: string
  /** 파일 기반 엔진(H2·SQLite)의 경로. */
  file: string
  user: string
  /** 비밀번호를 저장할지. 값 자체는 Rust 쪽 `~/.myspace/db-secrets.json` 에 있다. */
  savePassword: boolean
  /** 드라이버 jar 절대 경로들. */
  jars: string[]
  /**
   * 사용자가 직접 고친 URL. 비어 있으면 폼에서 자동 생성한다.
   * 한 번 고치면 폼을 바꿔도 덮어쓰지 않는다.
   */
  urlOverride: string
  /** 접속 직후 자동으로 붙을지. */
  autoConnect: boolean
}

export function newConnection(engine = "mysql"): DbConnection {
  const spec = engineById(engine)
  return {
    // crypto.randomUUID 는 웹뷰에서 secure context 로 취급돼 항상 쓸 수 있다.
    id: crypto.randomUUID(),
    name: "새 접속",
    engine,
    host: "localhost",
    port: String(spec.defaultPort),
    database: "",
    file: "",
    user: "",
    savePassword: true,
    jars: [],
    urlOverride: "",
    autoConnect: false,
  }
}

/** 이 접속으로 실제로 쓸 JDBC URL. */
export function resolveUrl(conn: DbConnection): string {
  if (conn.urlOverride.trim()) return conn.urlOverride.trim()
  return engineById(conn.engine).buildUrl({
    host: conn.host.trim(),
    port: conn.port.trim(),
    database: conn.database.trim(),
    file: conn.file.trim(),
  })
}
