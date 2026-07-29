//! CC History Viewer 백엔드 — `~/.claude/projects` 아래의 Claude Code 세션 기록을 읽는다.
//!
//! 원본은 npx 로 돌리는 로컬 Hono 서버(cc-history-viewer)였고, 이 모듈은 그 서버의
//! Project History 화면에 필요한 3개 엔드포인트를 Tauri 커맨드로 포팅한 것이다.
//!   - `cc_history_projects`  : 프로젝트 목록
//!   - `cc_history_sessions`  : 프로젝트별 세션 목록(페이징)
//!   - `cc_history_messages`  : 세션의 메시지 + 서브에이전트 + 워크플로우
//!
//! 메시지 본문은 JSONL 항목을 그대로 통과시켜야 하므로 `serde_json::Value` 로 다룬다.
//! FS 접근은 블로킹이지만 Tauri 는 동기 커맨드를 별도 스레드풀에서 실행하므로 그대로 둔다.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use chrono::{SecondsFormat, TimeZone, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};

/// `~/.claude/projects` 경로.
fn projects_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join(".claude").join("projects"))
}

/// 파일 수정시각을 epoch 밀리초(f64)로. 실패 시 0.
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// epoch(ms) → ISO8601(`...Z`) 문자열. JS `new Date(ms).toISOString()` 과 호환.
fn iso(ms: f64) -> String {
    Utc.timestamp_millis_opt(ms as i64)
        .single()
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// 디렉터리 트리(주어진 depth 까지)의 최대 수정시각(ms).
fn max_mtime_in_dir(dir: &Path, depth: i32) -> f64 {
    let mut max = 0.0f64;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return max,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let m = mtime_ms(&meta);
        if m > max {
            max = m;
        }
        if meta.is_dir() && depth > 0 {
            let sub = max_mtime_in_dir(&path, depth - 1);
            if sub > max {
                max = sub;
            }
        }
    }
    max
}

/// 세션 파일 자신 + `subagents/`(중첩 workflows 포함, depth 2) 의 최대 수정시각.
fn get_session_max_mtime(project_dir: &Path, session_id: &str, session_mtime_ms: f64) -> f64 {
    let subagents_dir = project_dir.join(session_id).join("subagents");
    let sub = max_mtime_in_dir(&subagents_dir, 2);
    session_mtime_ms.max(sub)
}

/// JSONL 파일을 파싱한다. 한 항목이 여러 줄에 걸친 경우 버퍼링으로 이어붙인다.
fn parse_jsonl(path: &Path) -> Vec<Value> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut results = Vec::new();
    let mut buffer = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if buffer.is_empty() {
            match serde_json::from_str::<Value>(trimmed) {
                Ok(v) => results.push(v),
                Err(_) => buffer = trimmed.to_string(),
            }
        } else {
            buffer.push('\n');
            buffer.push_str(trimmed);
            if let Ok(v) = serde_json::from_str::<Value>(&buffer) {
                results.push(v);
                buffer.clear();
            }
        }
    }
    results
}

/// 세션 파일 앞부분(최대 20줄)에서 첫 `cwd` 를 찾는다(프로젝트 실제 경로 추정용).
fn first_cwd(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(20) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(cwd) = v.get("cwd").and_then(|x| x.as_str()) {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// 경로에서 마지막 세그먼트(폴더/파일명)만.
fn base_name(p: &str) -> String {
    p.rsplit(|c| c == '/' || c == '\\')
        .find(|s| !s.is_empty())
        .unwrap_or(p)
        .to_string()
}

// ── 프로젝트 목록 ────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    path: String,
    session_count: usize,
    last_session_timestamp: String,
}

#[tauri::command]
pub fn cc_history_projects() -> Result<Vec<Project>, String> {
    let dir = projects_dir().ok_or("no home dir")?;
    let mut projects = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(projects), // ~/.claude/projects 가 아직 없으면 빈 목록.
    };
    for entry in entries.flatten() {
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if entry_name.ends_with(".db") {
            continue;
        }
        let full = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_dir() {
            continue;
        }

        let mut sessions: Vec<String> = Vec::new();
        if let Ok(files) = fs::read_dir(&full) {
            for f in files.flatten() {
                let fname = f.file_name().to_string_lossy().to_string();
                if fname.ends_with(".jsonl") {
                    sessions.push(fname);
                }
            }
        }

        let mut real_path = entry_name.clone();
        if let Some(first) = sessions.first() {
            if let Some(cwd) = first_cwd(&full.join(first)) {
                real_path = cwd;
            }
        }

        let mut last_ts = String::new();
        if !sessions.is_empty() {
            let mut max_mtime = 0.0f64;
            for sf in &sessions {
                let session_id = sf.trim_end_matches(".jsonl");
                let file_mtime = fs::metadata(full.join(sf))
                    .map(|m| mtime_ms(&m))
                    .unwrap_or(0.0);
                let session_max = get_session_max_mtime(&full, session_id, file_mtime);
                if session_max > max_mtime {
                    max_mtime = session_max;
                }
            }
            if max_mtime > 0.0 {
                last_ts = iso(max_mtime);
            }
        }

        let name = base_name(&real_path);
        projects.push(Project {
            id: entry_name,
            name,
            path: real_path,
            session_count: sessions.len(),
            last_session_timestamp: last_ts,
        });
    }
    Ok(projects)
}

// ── 세션 목록 ────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    id: String,
    title: String,
    message_count: usize,
    model: String,
    cwd: String,
    first_timestamp: String,
    last_timestamp: String,
    modified_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsResponse {
    sessions: Vec<Session>,
    total: usize,
    offset: usize,
    limit: usize,
}

#[tauri::command]
pub fn cc_history_sessions(
    project_id: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<SessionsResponse, String> {
    let dir = projects_dir().ok_or("no home dir")?;
    let project_dir = dir.join(&project_id);
    let limit = limit.unwrap_or(0);
    let offset = offset.unwrap_or(0);

    // (session_id, path, mtime_ms) 를 모아 mtime 내림차순 정렬.
    let mut file_entries: Vec<(String, PathBuf, f64)> = Vec::new();
    if let Ok(files) = fs::read_dir(&project_dir) {
        for f in files.flatten() {
            let fname = f.file_name().to_string_lossy().to_string();
            if !fname.ends_with(".jsonl") {
                continue;
            }
            let session_id = fname.trim_end_matches(".jsonl").to_string();
            let file_path = f.path();
            let file_mtime = f.metadata().map(|m| mtime_ms(&m)).unwrap_or(0.0);
            let max_mtime = get_session_max_mtime(&project_dir, &session_id, file_mtime);
            file_entries.push((session_id, file_path, max_mtime));
        }
    }
    file_entries.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

    let total = file_entries.len();
    let sliced: Vec<&(String, PathBuf, f64)> = if limit > 0 {
        file_entries.iter().skip(offset).take(limit).collect()
    } else {
        file_entries.iter().collect()
    };

    let mut sessions: Vec<Session> = Vec::new();
    for (session_id, file_path, mtime) in sliced {
        let mut title = String::new();
        let mut message_count = 0usize;
        let mut first_timestamp = String::new();
        let mut last_timestamp = String::new();
        let mut model = String::new();
        let mut cwd = String::new();

        for data in parse_jsonl(file_path) {
            message_count += 1;
            if let Some(ts) = data.get("timestamp").and_then(|v| v.as_str()) {
                if first_timestamp.is_empty() {
                    first_timestamp = ts.to_string();
                }
                last_timestamp = ts.to_string();
            }
            if cwd.is_empty() {
                if let Some(c) = data.get("cwd").and_then(|v| v.as_str()) {
                    cwd = c.to_string();
                }
            }
            let is_meta = data.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false);
            if title.is_empty()
                && data.get("type").and_then(|v| v.as_str()) == Some("user")
                && !is_meta
            {
                if let Some(content) = data.get("message").and_then(|m| m.get("content")) {
                    let text = match content {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    title = text.chars().take(200).collect();
                }
            }
            if model.is_empty()
                && data.get("type").and_then(|v| v.as_str()) == Some("assistant")
            {
                if let Some(m) = data.get("message").and_then(|m| m.get("model")).and_then(|v| v.as_str()) {
                    model = m.to_string();
                }
            }
        }

        sessions.push(Session {
            id: session_id.clone(),
            title: if title.is_empty() { "(no title)".to_string() } else { title },
            message_count,
            model,
            cwd,
            first_timestamp,
            last_timestamp,
            modified_at: iso(*mtime),
        });
    }

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(SessionsResponse {
        sessions,
        total,
        offset,
        limit: if limit > 0 { limit } else { total },
    })
}

// ── 세션 메시지(+ 서브에이전트 + 워크플로우) ──────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagesResponse {
    messages: Vec<Value>,
    total_messages: usize,
    subagents: Map<String, Value>,
    workflows: Map<String, Value>,
}

#[derive(Default)]
struct WorkflowPhase {
    title: String,
    detail: Option<String>,
}

#[derive(Default)]
struct WorkflowMeta {
    name: String,
    description: String,
    phases: Vec<WorkflowPhase>,
}

/// `key : "..."` 형태에서 첫 따옴표 문자열 값을 뽑는다(', ", ` 지원).
fn quoted_value_after(s: &str, key: &str) -> Option<String> {
    let mut search_start = 0;
    while let Some(rel) = s[search_start..].find(key) {
        let idx = search_start + rel;
        let after = &s[idx + key.len()..];
        let trimmed = after.trim_start();
        if let Some(rest) = trimmed.strip_prefix(':') {
            let val_area = rest.trim_start();
            if let Some(q) = val_area.chars().next() {
                if q == '\'' || q == '"' || q == '`' {
                    let body = &val_area[q.len_utf8()..];
                    if let Some(end) = body.find(q) {
                        return Some(body[..end].to_string());
                    }
                }
            }
        }
        search_start = idx + key.len();
    }
    None
}

/// `phases: [ ... ]` 안에서 title/detail 쌍들을 뽑는다.
fn extract_phases(s: &str) -> Vec<WorkflowPhase> {
    let mut out = Vec::new();
    let idx = match s.find("phases") {
        Some(i) => i,
        None => return out,
    };
    let after = &s[idx + "phases".len()..];
    let lb = match after.find('[') {
        Some(i) => i,
        None => return out,
    };
    let region = &after[lb + 1..];
    let rb = match region.find(']') {
        Some(i) => i,
        None => return out,
    };
    let body = &region[..rb];

    let mut start = 0;
    while let Some(rel) = body[start..].find("title") {
        let ti = start + rel;
        if let Some(title) = quoted_value_after(&body[ti..], "title") {
            let rest = &body[ti + "title".len()..];
            let search_area = match rest.find("title") {
                Some(n) => &rest[..n],
                None => rest,
            };
            let detail = quoted_value_after(search_area, "detail");
            out.push(WorkflowPhase { title, detail });
        }
        start = ti + "title".len();
    }
    out
}

/// 워크플로우 스크립트에서 `export const meta = {...}` 를 경량 스캔으로 뽑는다.
fn parse_workflow_meta(script: &str) -> WorkflowMeta {
    let scope = match script.find("export const meta") {
        Some(i) => {
            // 4000바이트로 제한하되, 한글 등 멀티바이트 문자 중간에서 자르면
            // 슬라이싱이 패닉하므로 char 경계까지 내린다.
            let mut end = (i + 4000).min(script.len());
            while end > i && !script.is_char_boundary(end) {
                end -= 1;
            }
            &script[i..end]
        }
        None => script,
    };
    WorkflowMeta {
        name: quoted_value_after(scope, "name").unwrap_or_default(),
        description: quoted_value_after(scope, "description").unwrap_or_default(),
        phases: extract_phases(scope),
    }
}

/// 한 디렉터리에서 `agent-*.meta.json` + `agent-*.jsonl` 쌍을 읽어 `out` 에 채운다.
/// 반환값은 이 디렉터리에서 찾은 agentId 목록.
fn load_agents_from_dir(
    dir: &Path,
    subagent_offsets: &HashMap<String, usize>,
    workflow_id: Option<&str>,
    results: Option<&HashMap<String, Value>>,
    out: &mut Map<String, Value>,
) -> Vec<String> {
    let mut agent_ids = Vec::new();
    let files = match fs::read_dir(dir) {
        Ok(f) => f,
        Err(_) => return agent_ids,
    };
    let meta_files: Vec<String> = files
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            if n.ends_with(".meta.json") {
                Some(n)
            } else {
                None
            }
        })
        .collect();

    for mf in meta_files {
        let agent_id = mf.trim_end_matches(".meta.json").to_string();
        let meta_val: Value = fs::read_to_string(dir.join(&mf))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let mut obj = match meta_val {
            Value::Object(m) => m,
            _ => Map::new(),
        };

        let agent_messages = parse_jsonl(&dir.join(format!("{agent_id}.jsonl")));
        let total = agent_messages.len();
        let offset = *subagent_offsets.get(&agent_id).unwrap_or(&0);
        let delta: Vec<Value> = if offset == 0 {
            agent_messages
        } else if offset >= total {
            Vec::new()
        } else {
            agent_messages[offset..].to_vec()
        };

        obj.entry("agentType".to_string())
            .or_insert_with(|| Value::String(String::new()));
        obj.entry("description".to_string())
            .or_insert_with(|| Value::String(String::new()));
        obj.insert("messages".to_string(), Value::Array(delta));
        obj.insert("totalMessages".to_string(), json!(total));
        if let Some(wf) = workflow_id {
            obj.insert("workflowId".to_string(), json!(wf));
        }
        if let Some(res) = results {
            let bare = agent_id.strip_prefix("agent-").unwrap_or(&agent_id);
            if let Some(r) = res.get(&agent_id).or_else(|| res.get(bare)) {
                obj.insert("result".to_string(), r.clone());
            }
        }

        out.insert(agent_id.clone(), Value::Object(obj));
        agent_ids.push(agent_id);
    }
    agent_ids
}

#[tauri::command]
pub fn cc_history_messages(
    project_id: String,
    session_id: String,
    message_offset: Option<usize>,
    subagent_offsets: Option<HashMap<String, usize>>,
) -> Result<MessagesResponse, String> {
    let dir = projects_dir().ok_or("no home dir")?;
    let file_path = dir.join(&project_id).join(format!("{session_id}.jsonl"));
    let all_messages = parse_jsonl(&file_path);
    let total_messages = all_messages.len();

    let moff = message_offset.unwrap_or(0);
    let messages: Vec<Value> = if moff == 0 {
        all_messages.clone()
    } else if moff >= all_messages.len() {
        Vec::new()
    } else {
        all_messages[moff..].to_vec()
    };

    let sub_offsets = subagent_offsets.unwrap_or_default();
    let session_dir = dir.join(&project_id).join(&session_id);
    let subagents_dir = session_dir.join("subagents");

    let mut subagent_meta: Map<String, Value> = Map::new();
    load_agents_from_dir(&subagents_dir, &sub_offsets, None, None, &mut subagent_meta);

    // 워크플로우 실행: subagents/workflows/<wfId>/ 에 에이전트 + journal.jsonl 이 있고,
    // 스크립트(meta name/description/phases)는 <sessionDir>/workflows/scripts/*-<wfId>.js.
    let mut workflows: Map<String, Value> = Map::new();
    let workflows_subagents_dir = subagents_dir.join("workflows");
    let scripts_dir = session_dir.join("workflows").join("scripts");
    let script_files: Vec<String> = fs::read_dir(&scripts_dir)
        .ok()
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let n = e.file_name().to_string_lossy().to_string();
                    if n.ends_with(".js") {
                        Some(n)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    if let Ok(rd) = fs::read_dir(&workflows_subagents_dir) {
        for e in rd.flatten() {
            if !e.metadata().map(|m| m.is_dir()).unwrap_or(false) {
                continue;
            }
            let wf_id = e.file_name().to_string_lossy().to_string();
            let run_dir = e.path();

            // journal.jsonl → agentId 별 결과 매핑.
            let mut results: HashMap<String, Value> = HashMap::new();
            for entry in parse_jsonl(&run_dir.join("journal.jsonl")) {
                if entry.get("type").and_then(|v| v.as_str()) == Some("result") {
                    if let Some(aid) = entry.get("agentId").and_then(|v| v.as_str()) {
                        if let Some(r) = entry.get("result") {
                            results.insert(aid.to_string(), r.clone());
                        }
                    }
                }
            }

            let agent_ids = load_agents_from_dir(
                &run_dir,
                &sub_offsets,
                Some(&wf_id),
                Some(&results),
                &mut subagent_meta,
            );

            let mut meta = WorkflowMeta::default();
            if let Some(sf) = script_files.iter().find(|f| f.contains(&wf_id)) {
                if let Ok(script) = fs::read_to_string(scripts_dir.join(sf)) {
                    meta = parse_workflow_meta(&script);
                }
            }
            let name = if meta.name.is_empty() {
                wf_id.clone()
            } else {
                meta.name.clone()
            };
            let phases: Vec<Value> = meta
                .phases
                .iter()
                .map(|p| {
                    let mut m = Map::new();
                    m.insert("title".to_string(), json!(p.title));
                    if let Some(d) = &p.detail {
                        m.insert("detail".to_string(), json!(d));
                    }
                    Value::Object(m)
                })
                .collect();

            workflows.insert(
                wf_id.clone(),
                json!({
                    "id": wf_id,
                    "name": name,
                    "description": meta.description,
                    "phases": phases,
                    "agentIds": agent_ids,
                }),
            );
        }
    }

    // 각 워크플로우 실행을 그것을 띄운 Workflow tool_use 와 연결(tool_result 안에서 run id 를 스캔).
    if !workflows.is_empty() {
        let wf_ids: Vec<String> = workflows.keys().cloned().collect();
        for m in &all_messages {
            let content = m.get("message").and_then(|x| x.get("content"));
            let arr = match content.and_then(|c| c.as_array()) {
                Some(a) => a,
                None => continue,
            };
            for block in arr {
                if block.get("type").and_then(|v| v.as_str()) != Some("tool_result") {
                    continue;
                }
                let raw = match block.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                    None => String::new(),
                };
                let tool_use_id = block.get("tool_use_id").cloned();
                for wf_id in &wf_ids {
                    let already = workflows
                        .get(wf_id)
                        .and_then(|w| w.get("toolUseId"))
                        .map(|v| !v.is_null())
                        .unwrap_or(false);
                    if !already && raw.contains(wf_id) {
                        if let (Some(w), Some(tid)) = (
                            workflows.get_mut(wf_id).and_then(|w| w.as_object_mut()),
                            &tool_use_id,
                        ) {
                            w.insert("toolUseId".to_string(), tid.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(MessagesResponse {
        messages,
        total_messages,
        subagents: subagent_meta,
        workflows,
    })
}
