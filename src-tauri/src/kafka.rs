//! Kafka 뷰어 — 브로커와 직접 통신하는 백엔드 (kafka-ui 의 핵심 기능 부분집합).
//!
//! ES 뷰어(`es.rs`)는 HTTP 프록시 한 개면 됐지만, Kafka 는 HTTP 가 아니라 TCP
//! 바이너리 프로토콜이라 웹뷰에서 직접 붙을 수 없다. 그래서 librdkafka(rdkafka)
//! 클라이언트를 Rust 에 두고, 프론트(`kafka-client.ts`)는 명령만 호출한다.
//!
//! 접속 방식은 PLAINTEXT 고정(사내 브로커). 인증/TLS 는 쓰지 않으므로 rdkafka 도
//! ssl/gssapi 없이 빌드한다(Cargo.toml 주석 참고).
//!
//! 설계 메모
//! - librdkafka 호출은 전부 **블로킹**이라, 각 명령은 `spawn_blocking` 안에서 돈다.
//!   (async 런타임 스레드에서 그대로 부르면 앱 전체가 멈춘다.)
//! - 메타데이터용 컨슈머는 브로커 주소별로 캐시한다. 매 요청마다 새로 만들면
//!   TCP 연결·메타데이터 왕복이 반복돼 목록 갱신이 눈에 띄게 느려진다.
//! - 반대로 **메시지 조회용 컨슈머는 매번 새로 만든다.** assign/seek 위치가
//!   컨슈머의 상태라, 캐시한 하나를 여러 조회가 공유하면 서로의 위치를 덮어쓴다.
//! - 컨슈머 그룹에 실제로 join 하지 않는다(subscribe 없이 assign/committed 만 사용).
//!   그래서 뷰어를 열어 둬도 운영 중인 컨슈머의 리밸런싱을 유발하지 않는다.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use rdkafka::admin::{AdminClient, AdminOptions, ResourceSpecifier};
use rdkafka::client::DefaultClientContext;
use rdkafka::config::{ClientConfig, RDKafkaLogLevel};
use rdkafka::consumer::{BaseConsumer, Consumer};
use rdkafka::error::KafkaError;
use rdkafka::message::{Header, Headers, Message, OwnedHeaders};
use rdkafka::producer::{BaseProducer, BaseRecord, DeliveryResult, Producer, ProducerContext};
use rdkafka::{ClientContext, Offset, TopicPartitionList};
use serde::{Deserialize, Serialize};

/* ────────────────────────────── 공통 ────────────────────────────── */

/// 연결 정보. 프론트(localStorage)에서 요청마다 그대로 넘겨준다.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KafkaConfig {
    /// `host:port[,host:port…]` — bootstrap.servers 그대로.
    pub brokers: String,
    /// 브로커 응답 대기 한도(ms). 기본 8초.
    pub timeout_ms: Option<u64>,
}

impl KafkaConfig {
    fn key(&self) -> String {
        self.brokers.trim().to_string()
    }
    fn timeout(&self) -> Duration {
        Duration::from_millis(self.timeout_ms.unwrap_or(8_000))
    }
}

/// 모든 클라이언트가 공유하는 기본 설정.
fn base_config(cfg: &KafkaConfig) -> ClientConfig {
    let mut c = ClientConfig::new();
    c.set("bootstrap.servers", cfg.brokers.trim());
    c.set("security.protocol", "PLAINTEXT");
    c.set("client.id", "my-space-kafka-viewer");
    c.set("socket.timeout.ms", "10000");
    // 연결 끊김 로그(정상 동작에서도 자주 뜬다)는 앱 로그를 뒤덮으므로 끈다.
    c.set("log.connection.close", "false");
    c.set_log_level(RDKafkaLogLevel::Warning);
    c
}

/// rdkafka 에러를 사용자에게 보여 줄 한국어 메시지로.
fn fmt_err(e: KafkaError) -> String {
    let s = e.to_string();
    if s.contains("Timed out") || s.contains("timed out") {
        format!("브로커 응답이 없습니다. 주소와 방화벽을 확인하세요.\n({s})")
    } else {
        s
    }
}

/// 브로커 주소별 메타데이터 전용 컨슈머 캐시.
static META_CONSUMERS: OnceLock<Mutex<HashMap<String, Arc<BaseConsumer>>>> = OnceLock::new();

fn meta_consumer(cfg: &KafkaConfig) -> Result<Arc<BaseConsumer>, String> {
    if cfg.brokers.trim().is_empty() {
        return Err("브로커 주소를 입력하세요. (예: 172.16.0.10:9092)".into());
    }
    let cache = META_CONSUMERS.get_or_init(|| Mutex::new(HashMap::new()));
    let key = cfg.key();
    if let Some(c) = cache.lock().unwrap().get(&key) {
        // 이 컨슈머는 앱이 살아 있는 동안 계속 캐시되므로, librdkafka 가 큐에 쌓아 둔
        // 이벤트를 비워 준다. 논블로킹(timeout 0) 이라 지연은 없다.
        for _ in 0..64 {
            if c.poll(Duration::ZERO).is_none() {
                break;
            }
        }
        return Ok(c.clone());
    }
    let consumer: BaseConsumer = base_config(cfg)
        // 컨슈머는 group.id 가 필수지만, subscribe 하지 않으므로 그룹에 join 하지 않는다.
        .set("group.id", "my-space-kafka-viewer")
        .set("enable.auto.commit", "false")
        .create()
        .map_err(fmt_err)?;
    let consumer = Arc::new(consumer);
    cache.lock().unwrap().insert(key, consumer.clone());
    Ok(consumer)
}

/// 바이트 → 표시용 문자열. UTF-8 이면 그대로, 아니면 base64(+binary 플래그).
fn decode(bytes: Option<&[u8]>) -> (Option<String>, bool) {
    match bytes {
        None => (None, false),
        Some(b) => match std::str::from_utf8(b) {
            Ok(s) => (Some(s.to_string()), false),
            Err(_) => (
                Some(base64::engine::general_purpose::STANDARD.encode(b)),
                true,
            ),
        },
    }
}

/// `topic` 의 파티션 id 목록(메타데이터 1회 조회).
fn partition_ids(
    consumer: &BaseConsumer,
    topic: &str,
    timeout: Duration,
) -> Result<Vec<i32>, String> {
    let md = consumer
        .fetch_metadata(Some(topic), timeout)
        .map_err(fmt_err)?;
    let t = md
        .topics()
        .first()
        .ok_or_else(|| format!("토픽을 찾을 수 없습니다: {topic}"))?;
    if let Some(err) = t.error() {
        return Err(format!("토픽 메타데이터 오류: {err:?}"));
    }
    let mut ids: Vec<i32> = t.partitions().iter().map(|p| p.id()).collect();
    ids.sort_unstable();
    if ids.is_empty() {
        return Err(format!("토픽에 파티션이 없습니다: {topic}"));
    }
    Ok(ids)
}

/// (topic, partition) 목록의 워터마크를 워커 스레드로 나눠 가져온다.
///
/// `fetch_watermarks` 는 파티션마다 왕복 1회라, 토픽이 수십 개면 순차 호출로는
/// 목록 한 번 여는 데 몇 초가 걸린다. librdkafka 클라이언트는 스레드 안전하므로
/// 하나를 여러 스레드가 함께 쓴다.
fn fetch_watermarks_parallel(
    consumer: &BaseConsumer,
    jobs: &[(String, i32)],
    timeout: Duration,
) -> HashMap<(String, i32), (i64, i64)> {
    let out: Mutex<HashMap<(String, i32), (i64, i64)>> = Mutex::new(HashMap::new());
    let next = AtomicUsize::new(0);
    let workers = jobs.len().clamp(1, 8);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some((topic, part)) = jobs.get(i) else { break };
                // 리더 없는 파티션 등 실패는 건너뛴다(해당 토픽만 건수가 비게 됨).
                if let Ok(w) = consumer.fetch_watermarks(topic, *part, timeout) {
                    out.lock().unwrap().insert((topic.clone(), *part), w);
                }
            });
        }
    });

    out.into_inner().unwrap()
}

/* ─────────────────────────── 연결 / 브로커 ─────────────────────────── */

#[derive(Serialize)]
pub struct BrokerInfo {
    pub id: i32,
    pub host: String,
    pub port: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterInfo {
    pub brokers: Vec<BrokerInfo>,
    pub topic_count: usize,
    /// 메타데이터를 응답한 브로커(= 실제로 붙은 곳).
    pub origin: String,
}

/// 연결 확인 + 클러스터 개요. "연결" 버튼이 호출한다.
#[tauri::command]
pub async fn kafka_connect(config: KafkaConfig) -> Result<ClusterInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let consumer = meta_consumer(&config)?;
        let md = consumer
            .fetch_metadata(None, config.timeout())
            .map_err(fmt_err)?;
        Ok(ClusterInfo {
            brokers: md
                .brokers()
                .iter()
                .map(|b| BrokerInfo {
                    id: b.id(),
                    host: b.host().to_string(),
                    port: b.port(),
                })
                .collect(),
            topic_count: md.topics().len(),
            origin: md.orig_broker_name().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 캐시된 연결을 버린다(주소 변경·재연결 시).
#[tauri::command]
pub async fn kafka_disconnect(config: KafkaConfig) -> Result<(), String> {
    if let Some(cache) = META_CONSUMERS.get() {
        cache.lock().unwrap().remove(&config.key());
    }
    Ok(())
}

/* ────────────────────────────── 토픽 ────────────────────────────── */

#[derive(Serialize)]
pub struct TopicInfo {
    pub name: String,
    pub partitions: usize,
    pub replication: usize,
    /// `__` 로 시작하는 Kafka 내부 토픽(__consumer_offsets 등).
    pub internal: bool,
    /// 워터마크 합계(high-low). `with_counts=false` 면 null.
    pub messages: Option<i64>,
}

/// 토픽 목록. `with_counts` 면 파티션별 워터마크까지 읽어 메시지 건수를 채운다.
#[tauri::command]
pub async fn kafka_topics(
    config: KafkaConfig,
    with_counts: bool,
) -> Result<Vec<TopicInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let consumer = meta_consumer(&config)?;
        let timeout = config.timeout();
        let md = consumer.fetch_metadata(None, timeout).map_err(fmt_err)?;

        let mut topics: Vec<TopicInfo> = md
            .topics()
            .iter()
            .map(|t| TopicInfo {
                name: t.name().to_string(),
                partitions: t.partitions().len(),
                replication: t
                    .partitions()
                    .first()
                    .map(|p| p.replicas().len())
                    .unwrap_or(0),
                internal: t.name().starts_with("__"),
                messages: None,
            })
            .collect();

        if with_counts {
            let jobs: Vec<(String, i32)> = md
                .topics()
                .iter()
                .flat_map(|t| {
                    t.partitions()
                        .iter()
                        .map(move |p| (t.name().to_string(), p.id()))
                })
                .collect();
            let marks = fetch_watermarks_parallel(&consumer, &jobs, timeout);
            for t in &mut topics {
                let sum: i64 = marks
                    .iter()
                    .filter(|((name, _), _)| name == &t.name)
                    .map(|(_, (low, high))| high - low)
                    .sum();
                t.messages = Some(sum);
            }
        }

        topics.sort_by(|a, b| {
            // 내부 토픽은 뒤로, 나머지는 이름순.
            a.internal
                .cmp(&b.internal)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(topics)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct PartitionInfo {
    pub id: i32,
    pub leader: i32,
    pub replicas: Vec<i32>,
    pub isr: Vec<i32>,
    pub low: i64,
    pub high: i64,
}

/// 토픽 상세 — 파티션별 리더/복제/ISR/오프셋.
#[tauri::command]
pub async fn kafka_partitions(
    config: KafkaConfig,
    topic: String,
) -> Result<Vec<PartitionInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let consumer = meta_consumer(&config)?;
        let timeout = config.timeout();
        let md = consumer
            .fetch_metadata(Some(&topic), timeout)
            .map_err(fmt_err)?;
        let t = md
            .topics()
            .first()
            .ok_or_else(|| format!("토픽을 찾을 수 없습니다: {topic}"))?;

        let jobs: Vec<(String, i32)> = t
            .partitions()
            .iter()
            .map(|p| (topic.clone(), p.id()))
            .collect();
        let marks = fetch_watermarks_parallel(&consumer, &jobs, timeout);

        let mut parts: Vec<PartitionInfo> = t
            .partitions()
            .iter()
            .map(|p| {
                let (low, high) = marks.get(&(topic.clone(), p.id())).copied().unwrap_or((0, 0));
                PartitionInfo {
                    id: p.id(),
                    leader: p.leader(),
                    replicas: p.replicas().to_vec(),
                    isr: p.isr().to_vec(),
                    low,
                    high,
                }
            })
            .collect();
        parts.sort_by_key(|p| p.id);
        Ok(parts)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntryDto {
    pub name: String,
    pub value: Option<String>,
    pub source: String,
    pub is_default: bool,
    pub is_read_only: bool,
    pub is_sensitive: bool,
}

/// 토픽 설정(retention.ms, cleanup.policy …).
///
/// AdminClient 는 자체 이벤트 스레드에서 결과를 밀어 주는 async API 라
/// 여기서는 `spawn_blocking` 없이 그대로 await 한다.
#[tauri::command]
pub async fn kafka_topic_configs(
    config: KafkaConfig,
    topic: String,
) -> Result<Vec<ConfigEntryDto>, String> {
    let admin: AdminClient<DefaultClientContext> =
        base_config(&config).create().map_err(fmt_err)?;
    let opts = AdminOptions::new().request_timeout(Some(config.timeout()));
    let results = admin
        .describe_configs(&[ResourceSpecifier::Topic(&topic)], &opts)
        .await
        .map_err(fmt_err)?;

    let resource = results
        .into_iter()
        .next()
        .ok_or_else(|| "설정 응답이 비어 있습니다.".to_string())?
        .map_err(|e| format!("설정 조회 실패: {e:?}"))?;

    let mut entries: Vec<ConfigEntryDto> = resource
        .entries
        .into_iter()
        .map(|e| ConfigEntryDto {
            name: e.name,
            value: e.value,
            source: format!("{:?}", e.source),
            is_default: e.is_default,
            is_read_only: e.is_read_only,
            is_sensitive: e.is_sensitive,
        })
        .collect();
    // 기본값이 아닌(= 이 토픽에서 실제로 지정한) 설정을 위로.
    entries.sort_by(|a, b| a.is_default.cmp(&b.is_default).then(a.name.cmp(&b.name)));
    Ok(entries)
}

/* ───────────────────────────── 메시지 조회 ───────────────────────────── */

/// 조회 시작 위치.
#[derive(Deserialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SeekMode {
    /// 가장 최신 메시지부터 거슬러 올라가며 limit 개.
    Latest,
    /// 파티션 처음(low watermark)부터.
    Earliest,
    /// 지정한 오프셋부터.
    Offset,
    /// 지정한 시각(ms) 이후 첫 메시지부터.
    Timestamp,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub topic: String,
    /// null 이면 전체 파티션.
    pub partition: Option<i32>,
    pub mode: SeekMode,
    /// mode=offset 일 때 시작 오프셋.
    pub offset: Option<i64>,
    /// mode=timestamp 일 때 epoch millis.
    pub timestamp: Option<i64>,
    /// 최대 건수(1~5000).
    pub limit: usize,
    /// 키/값/헤더에 이 문자열이 들어간 메시지만(대소문자 무시). 브로커가 아니라
    /// 읽어 온 뒤 Rust 에서 거른다 — 걸러진 건 프론트로 보내지 않는다.
    pub search: Option<String>,
    /// 폴링 한도(ms). 기본 10초.
    pub poll_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KafkaRecord {
    pub partition: i32,
    pub offset: i64,
    /// epoch millis (브로커가 안 주면 null).
    pub timestamp: Option<i64>,
    pub key: Option<String>,
    pub key_binary: bool,
    pub value: Option<String>,
    pub value_binary: bool,
    /// key+value 바이트 수.
    pub size: usize,
    pub headers: Vec<(String, Option<String>)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub records: Vec<KafkaRecord>,
    /// 실제로 읽어 본 건수(검색 필터 적용 전).
    pub scanned: usize,
    /// 파티션별 (low, high) 워터마크.
    pub watermarks: Vec<(i32, i64, i64)>,
    /// limit 에 걸려 더 남았는지.
    pub truncated: bool,
    /// 폴링 시간이 다 돼서 끊겼는지(EOF 도달 전).
    pub timed_out: bool,
}

fn to_record(m: &rdkafka::message::BorrowedMessage<'_>) -> KafkaRecord {
    let (key, key_binary) = decode(m.key());
    let (value, value_binary) = decode(m.payload());
    let headers = m
        .headers()
        .map(|hs| {
            hs.iter()
                .map(|h| (h.key.to_string(), decode(h.value).0))
                .collect()
        })
        .unwrap_or_default();
    KafkaRecord {
        partition: m.partition(),
        offset: m.offset(),
        timestamp: m.timestamp().to_millis(),
        key,
        key_binary,
        value,
        value_binary,
        size: m.key().map_or(0, |k| k.len()) + m.payload().map_or(0, |p| p.len()),
        headers,
    }
}

fn matches(rec: &KafkaRecord, needle: &str) -> bool {
    let hit = |s: &Option<String>| {
        s.as_ref()
            .is_some_and(|v| v.to_lowercase().contains(needle))
    };
    hit(&rec.key)
        || hit(&rec.value)
        || rec
            .headers
            .iter()
            .any(|(k, v)| k.to_lowercase().contains(needle) || hit(v))
}

/// 메시지 조회. 매번 새 컨슈머를 만들어 assign → poll → drop 한다.
#[tauri::command]
pub async fn kafka_fetch(config: KafkaConfig, req: FetchRequest) -> Result<FetchResult, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_blocking(&config, &req))
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_blocking(config: &KafkaConfig, req: &FetchRequest) -> Result<FetchResult, String> {
    let timeout = config.timeout();
    let limit = req.limit.clamp(1, 5_000);

    // 조회 전용 컨슈머. enable.partition.eof 로 "이 파티션 끝" 신호를 받아,
    // 남은 게 없는데도 폴링 한도까지 기다리는 일을 없앤다.
    let consumer: BaseConsumer = base_config(config)
        .set("group.id", "my-space-kafka-viewer")
        .set("enable.auto.commit", "false")
        .set("enable.partition.eof", "true")
        .set("auto.offset.reset", "earliest")
        .create()
        .map_err(fmt_err)?;

    let all_parts = partition_ids(&consumer, &req.topic, timeout)?;
    let parts: Vec<i32> = match req.partition {
        Some(p) if all_parts.contains(&p) => vec![p],
        Some(p) => return Err(format!("파티션 {p} 이(가) 없습니다.")),
        None => all_parts,
    };

    // 워터마크로 범위를 먼저 잡는다(비어 있는 파티션은 아예 assign 하지 않는다).
    let jobs: Vec<(String, i32)> = parts.iter().map(|p| (req.topic.clone(), *p)).collect();
    let marks = fetch_watermarks_parallel(&consumer, &jobs, timeout);
    let watermarks: Vec<(i32, i64, i64)> = parts
        .iter()
        .map(|p| {
            let (low, high) = marks.get(&(req.topic.clone(), *p)).copied().unwrap_or((0, 0));
            (*p, low, high)
        })
        .collect();

    let live: Vec<&(i32, i64, i64)> = watermarks.iter().filter(|(_, l, h)| h > l).collect();
    if live.is_empty() {
        return Ok(FetchResult {
            records: vec![],
            scanned: 0,
            watermarks,
            truncated: false,
            timed_out: false,
        });
    }

    // mode=timestamp 는 브로커에 "이 시각 이후 첫 오프셋"을 물어봐야 한다.
    let by_time: Option<TopicPartitionList> = if req.mode == SeekMode::Timestamp {
        let ts = req
            .timestamp
            .ok_or_else(|| "시각을 입력하세요.".to_string())?;
        let mut tpl = TopicPartitionList::new();
        for (p, _, _) in &live {
            tpl.add_partition_offset(&req.topic, *p, Offset::Offset(ts))
                .map_err(fmt_err)?;
        }
        Some(consumer.offsets_for_times(tpl, timeout).map_err(fmt_err)?)
    } else {
        None
    };

    // 파티션 수로 limit 을 나눠 각 파티션에서 그만큼만 읽는다.
    let live_count = live.len() as i64;
    let per = (limit as i64 + live_count - 1) / live_count;

    let mut tpl = TopicPartitionList::new();
    for (p, low, high) in &live {
        let start = match req.mode {
            SeekMode::Earliest => *low,
            SeekMode::Latest => (*high - per).max(*low),
            SeekMode::Offset => req.offset.unwrap_or(*low).clamp(*low, *high),
            SeekMode::Timestamp => by_time
                .as_ref()
                .and_then(|t| t.find_partition(&req.topic, *p))
                .and_then(|e| match e.offset() {
                    Offset::Offset(o) if o >= 0 => Some(o),
                    // 그 시각 이후 메시지가 없으면 End(=high) 로 돌아온다.
                    _ => None,
                })
                .unwrap_or(*high),
        };
        tpl.add_partition_offset(&req.topic, *p, Offset::Offset(start))
            .map_err(fmt_err)?;
    }
    consumer.assign(&tpl).map_err(fmt_err)?;

    let ends: HashMap<i32, i64> = live.iter().map(|(p, _, h)| (*p, *h)).collect();
    let deadline = Instant::now() + Duration::from_millis(req.poll_ms.unwrap_or(10_000));
    let needle = req
        .search
        .as_ref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());

    let mut records: Vec<KafkaRecord> = Vec::new();
    let mut scanned = 0usize;
    let mut done: HashSet<i32> = HashSet::new();
    let mut timed_out = false;

    while records.len() < limit && done.len() < live.len() {
        if Instant::now() >= deadline {
            timed_out = true;
            break;
        }
        match consumer.poll(Duration::from_millis(250)) {
            None => continue,
            Some(Err(KafkaError::PartitionEOF(p))) => {
                done.insert(p);
            }
            Some(Err(e)) => return Err(fmt_err(e)),
            Some(Ok(m)) => {
                scanned += 1;
                let part = m.partition();
                let offset = m.offset();
                let rec = to_record(&m);
                match &needle {
                    Some(n) if !matches(&rec, n) => {}
                    _ => records.push(rec),
                }
                // 이 파티션에서 잡아 둔 범위 끝에 닿았으면 더 안 읽는다.
                if ends.get(&part).is_some_and(|h| offset + 1 >= *h) {
                    done.insert(part);
                }
            }
        }
    }

    // 최신 우선 모드는 새 메시지가 위로, 나머지는 시간순.
    if req.mode == SeekMode::Latest {
        records.sort_by(|a, b| {
            b.timestamp
                .cmp(&a.timestamp)
                .then_with(|| b.offset.cmp(&a.offset))
        });
    } else {
        records.sort_by(|a, b| {
            a.timestamp
                .cmp(&b.timestamp)
                .then_with(|| a.offset.cmp(&b.offset))
        });
    }
    let truncated = records.len() > limit || (records.len() == limit && done.len() < live.len());
    records.truncate(limit);

    Ok(FetchResult {
        records,
        scanned,
        watermarks,
        truncated,
        timed_out,
    })
}

/* ─────────────────────────── 컨슈머 그룹 ─────────────────────────── */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub id: String,
    pub client_id: String,
    pub client_host: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfoDto {
    pub name: String,
    /// Stable / Empty / PreparingRebalance …
    pub state: String,
    pub protocol: String,
    pub protocol_type: String,
    pub members: Vec<MemberInfo>,
}

/// 컨슈머 그룹 목록.
#[tauri::command]
pub async fn kafka_groups(config: KafkaConfig) -> Result<Vec<GroupInfoDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let consumer = meta_consumer(&config)?;
        let list = consumer
            .fetch_group_list(None, config.timeout())
            .map_err(fmt_err)?;
        let mut groups: Vec<GroupInfoDto> = list
            .groups()
            .iter()
            .map(|g| GroupInfoDto {
                name: g.name().to_string(),
                state: g.state().to_string(),
                protocol: g.protocol().to_string(),
                protocol_type: g.protocol_type().to_string(),
                members: g
                    .members()
                    .iter()
                    .map(|m| MemberInfo {
                        id: m.id().to_string(),
                        client_id: m.client_id().to_string(),
                        client_host: m.client_host().to_string(),
                    })
                    .collect(),
            })
            .collect();
        groups.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(groups)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct GroupOffset {
    pub topic: String,
    pub partition: i32,
    pub committed: i64,
    pub high: i64,
    pub lag: i64,
}

/// 그룹의 커밋 오프셋과 lag.
///
/// `topics` 를 비우면 내부 토픽을 뺀 전체를 대상으로 조회한다(토픽이 많으면 느리다).
/// subscribe 하지 않고 OffsetFetch 만 보내므로 운영 컨슈머에 영향을 주지 않는다.
#[tauri::command]
pub async fn kafka_group_offsets(
    config: KafkaConfig,
    group: String,
    topics: Vec<String>,
) -> Result<Vec<GroupOffset>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let timeout = config.timeout();
        let meta = meta_consumer(&config)?;
        let md = meta.fetch_metadata(None, timeout).map_err(fmt_err)?;

        let wanted: Option<HashSet<&str>> = if topics.is_empty() {
            None
        } else {
            Some(topics.iter().map(|s| s.as_str()).collect())
        };

        let mut tpl = TopicPartitionList::new();
        for t in md.topics() {
            let keep = match &wanted {
                Some(w) => w.contains(t.name()),
                None => !t.name().starts_with("__"),
            };
            if !keep {
                continue;
            }
            for p in t.partitions() {
                tpl.add_partition(t.name(), p.id());
            }
        }
        if tpl.count() == 0 {
            return Ok(vec![]);
        }

        // group.id 를 그룹 이름으로 둔 컨슈머로 OffsetFetch 만 보낸다.
        let probe: BaseConsumer = base_config(&config)
            .set("group.id", &group)
            .set("enable.auto.commit", "false")
            .create()
            .map_err(fmt_err)?;
        let committed = probe.committed_offsets(tpl, timeout).map_err(fmt_err)?;

        // 실제로 커밋된 파티션만 남기고, 그 파티션들만 워터마크를 읽는다.
        let mut pending: Vec<(String, i32, i64)> = Vec::new();
        for e in committed.elements() {
            if let Offset::Offset(o) = e.offset() {
                if o >= 0 {
                    pending.push((e.topic().to_string(), e.partition(), o));
                }
            }
        }
        if pending.is_empty() {
            return Ok(vec![]);
        }

        let jobs: Vec<(String, i32)> = pending.iter().map(|(t, p, _)| (t.clone(), *p)).collect();
        let marks = fetch_watermarks_parallel(&meta, &jobs, timeout);

        let mut out: Vec<GroupOffset> = pending
            .into_iter()
            .map(|(topic, partition, committed)| {
                let high = marks
                    .get(&(topic.clone(), partition))
                    .map(|(_, h)| *h)
                    .unwrap_or(committed);
                GroupOffset {
                    topic,
                    partition,
                    committed,
                    high,
                    lag: (high - committed).max(0),
                }
            })
            .collect();
        out.sort_by(|a, b| a.topic.cmp(&b.topic).then(a.partition.cmp(&b.partition)));
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/* ────────────────────────────── 프로듀스 ────────────────────────────── */

/// 전송 결과를 받아 오기 위한 컨텍스트. librdkafka 는 전송 완료를 콜백으로만
/// 알려 주므로, 채널로 밖으로 넘긴다.
struct DeliveryCtx {
    tx: std::sync::mpsc::Sender<Result<(i32, i64), String>>,
}

impl ClientContext for DeliveryCtx {}

impl ProducerContext for DeliveryCtx {
    type DeliveryOpaque = ();

    fn delivery(&self, result: &DeliveryResult<'_>, _: Self::DeliveryOpaque) {
        let msg = match result {
            Ok(m) => Ok((m.partition(), m.offset())),
            Err((e, _)) => Err(e.to_string()),
        };
        let _ = self.tx.send(msg);
    }
}

#[derive(Deserialize)]
pub struct ProduceRequest {
    pub topic: String,
    /// null 이면 파티셔너(키 해시 또는 라운드로빈)에 맡긴다.
    pub partition: Option<i32>,
    pub key: Option<String>,
    pub value: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

#[derive(Serialize)]
pub struct ProduceResult {
    pub partition: i32,
    pub offset: i64,
}

/// 메시지 전송.
#[tauri::command]
pub async fn kafka_produce(
    config: KafkaConfig,
    req: ProduceRequest,
) -> Result<ProduceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let producer: BaseProducer<DeliveryCtx> = base_config(&config)
            .set("message.timeout.ms", "10000")
            .create_with_context(DeliveryCtx { tx })
            .map_err(fmt_err)?;

        let mut headers = OwnedHeaders::new();
        for (k, v) in &req.headers {
            headers = headers.insert(Header {
                key: k,
                value: Some(v.as_str()),
            });
        }

        let mut record: BaseRecord<'_, String, String, ()> =
            BaseRecord::with_opaque_to(&req.topic, ()).payload(&req.value);
        if let Some(k) = &req.key {
            record = record.key(k);
        }
        if let Some(p) = req.partition {
            record = record.partition(p);
        }
        if !req.headers.is_empty() {
            record = record.headers(headers);
        }

        producer
            .send(record)
            .map_err(|(e, _)| format!("전송 실패: {e}"))?;
        // flush 가 내부적으로 poll 을 돌려 위 delivery 콜백을 실행시킨다.
        producer
            .flush(Duration::from_secs(12))
            .map_err(|e| format!("전송 대기 실패: {e}"))?;

        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(Ok((partition, offset))) => Ok(ProduceResult { partition, offset }),
            Ok(Err(e)) => Err(format!("전송 실패: {e}")),
            Err(_) => Err("전송 결과를 받지 못했습니다(타임아웃).".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
