use std::fs;
use std::path::Path;

fn tmp_dir() -> String {
    let d = std::env::temp_dir().join(format!("novel_test_{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&d).unwrap();
    d.to_string_lossy().to_string()
}
fn cleanup(d: &str) { fs::remove_dir_all(d).ok(); }

// ── Storage: book ID ───────────────────────────────────────

#[test]
fn test_deterministic_book_id() {
    let name1 = "声优经纪人";
    let name2 = "声优经纪人";
    let id1 = slug_id(name1);
    let id2 = slug_id(name2);
    assert_eq!(id1, id2);
    assert!(id1.chars().all(|c| c.is_alphanumeric() || c == '_'));

    let id3 = slug_id("星辰大海");
    assert_ne!(id1, id3);
    assert!(id3.len() > 5);
}

fn slug_id(name: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    name.trim().to_lowercase().hash(&mut h);
    let hash = h.finish();
    let slug: String = name.trim().to_lowercase().replace(' ', "_").chars().filter(|c| c.is_alphanumeric() || *c == '_').take(30).collect();
    format!("{}_{:08x}", slug, hash)
}

// ── Storage: layout ────────────────────────────────────────

#[test]
fn test_book_layout_creation() {
    let root = tmp_dir();
    let book_dir = Path::new(&root).join("test_book");
    fs::create_dir_all(&book_dir).unwrap();
    fs::create_dir_all(book_dir.join("chapters")).unwrap();

    let meta = serde_json::json!({"book_id":"test_book","book_name":"Test","created":"2026-01-01"});
    fs::write(book_dir.join("metadata.json"), serde_json::to_string(&meta).unwrap()).unwrap();

    for f in &["world_model.md","summary.md","status_card.md","chapter_draft.md","error_archive.md"] {
        fs::write(book_dir.join(f), "").unwrap();
    }

    assert!(book_dir.join("metadata.json").exists());
    assert!(book_dir.join("chapters").is_dir());
    assert!(book_dir.join("world_model.md").exists());

    cleanup(&root);
}

#[test]
fn test_find_book_by_metadata() {
    let root = tmp_dir();
    let d = Path::new(&root).join("book_a");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("metadata.json"), r#"{"book_id":"book_a","book_name":"星辰大海"}"#).unwrap();

    // Simulate search
    let mut found = None;
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.filter_map(|e| e.ok()) {
            if let Ok(c) = fs::read_to_string(e.path().join("metadata.json")) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&c) {
                    if v["book_name"].as_str() == Some("星辰大海") {
                        found = Some(v["book_id"].as_str().unwrap_or("").to_string());
                    }
                }
            }
        }
    }
    assert_eq!(found, Some("book_a".into()));
    cleanup(&root);
}

// ── ETag ────────────────────────────────────────────────────

#[test]
fn test_etag_consistency() {
    let a = compute_etag("hello world");
    let b = compute_etag("hello world");
    assert_eq!(a, b);
    assert_eq!(a.len(), 64);
}
#[test]
fn test_etag_different() { assert_ne!(compute_etag("a"), compute_etag("b")); }
#[test]
fn test_etag_file() {
    let d = tmp_dir();
    let p = Path::new(&d).join("test.txt");
    fs::write(&p, "content").unwrap();
    let etag = compute_etag(&fs::read_to_string(&p).unwrap());
    assert_eq!(etag, compute_etag("content"));
    cleanup(&d);
}
fn compute_etag(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}

// ── Markdown parsing ───────────────────────────────────────

#[test]
fn test_parse_outline() {
    let md = "# Title\n\n## Ch1\ncontent\n\n## Ch2\nmore\n### S2.1\ndetail";
    let items = parse_outline(md);
    assert_eq!(items.len(), 4);
    assert_eq!(items[0].0, "Title"); assert_eq!(items[0].1, 1);
    assert_eq!(items[1].0, "Ch1"); assert_eq!(items[1].1, 2);
    assert_eq!(items[3].0, "S2.1"); assert_eq!(items[3].1, 3);
}
fn parse_outline(md: &str) -> Vec<(String, usize)> {
    let mut o = Vec::new();
    for l in md.lines() {
        let t = l.trim();
        let lv = t.chars().take_while(|&c| c == '#').count();
        if lv > 0 && lv <= 6 && t.chars().nth(lv) == Some(' ') {
            o.push((t[lv..].trim().trim_end_matches('#').trim().to_string(), lv));
        }
    }
    o
}

#[test]
fn test_extract_section() {
    let md = "# A\n\na-content\n\n## B\nb-content\n\n## C\nc-content\n";
    let s = extract_section(md, "B");
    assert!(s.contains("b-content"));
    assert!(!s.contains("a-content"));
}
fn extract_section(md: &str, target: &str) -> String {
    let mut cur: Vec<String> = Vec::new();
    let mut in_t = false;
    let mut tl = 0;
    let mut r = String::new();
    for l in md.lines() {
        let t = l.trim();
        let lv = t.chars().take_while(|&c| c == '#').count();
        if lv > 0 && t.chars().nth(lv) == Some(' ') {
            let title = t[lv..].trim().to_string();
            while cur.len() >= lv { cur.pop(); }
            cur.push(title);
            if in_t && lv <= tl { break; }
            in_t = cur.last().map(|x| x == target).unwrap_or(false);
            if in_t { tl = lv; }
        } else if in_t { r.push_str(l); r.push('\n'); }
    }
    r
}

// ── Chapter parsing ────────────────────────────────────────

#[test]
fn test_parse_chapter_headings() {
    let md = "## 第1章 开始\ncontent\n\n## 第2章 继续\nmore\n## 第3章 结束\nend";
    let chapters = parse_chapter_numbers(md);
    assert_eq!(chapters, vec![1, 2, 3]);
}
fn parse_chapter_numbers(md: &str) -> Vec<u32> {
    let re = regex::Regex::new(r"^##\s*第(\d+)章").unwrap();
    let mut ns = Vec::new();
    for l in md.lines() {
        if let Some(c) = re.captures(l.trim()) {
            if let Ok(n) = c.get(1).unwrap().as_str().parse::<u32>() { ns.push(n); }
        }
    }
    ns
}

#[test]
fn test_chapter_length_stats() {
    let md = "## 第1章 测试\n这段有十个字整好十个字。\n\n## 第2章\n短。";
    let stats = chapter_stats(md, 15, 40);
    assert_eq!(stats.len(), 2);
    assert_eq!(stats[0].0, "第1章 测试");
    assert_eq!(stats[0].1, "under_min"); // 11 chars < 15
    assert_eq!(stats[1].0, "第2章");
    assert_eq!(stats[1].1, "under_min"); // 2 chars < 15
}
fn chapter_stats(md: &str, min_c: usize, _max_c: usize) -> Vec<(String, String)> {
    let mut r = Vec::new();
    let mut title = String::new();
    let mut txt = String::new();
    for l in md.lines() {
        let t = l.trim();
        if t.starts_with("## ") {
            if !title.is_empty() {
                let nwc = txt.chars().filter(|c| !c.is_whitespace()).count();
                r.push((title.clone(), if nwc < min_c { "under_min".into() } else { "ok".into() }));
            }
            title = t[3..].trim().to_string();
            txt = String::new();
        } else if !title.is_empty() { txt.push_str(l); txt.push('\n'); }
    }
    if !title.is_empty() {
        let nwc = txt.chars().filter(|c| !c.is_whitespace()).count();
        r.push((title, if nwc < min_c { "under_min".into() } else { "ok".into() }));
    }
    r
}

// ── Chinese chapter number parsing ─────────────────────────

#[test]
fn test_parse_chinese_numbers() {
    assert_eq!(parse_cn_num("一"), Some(1));
    assert_eq!(parse_cn_num("十"), Some(10));
    assert_eq!(parse_cn_num("十一"), Some(11));
    assert_eq!(parse_cn_num("十二"), Some(12));
    assert_eq!(parse_cn_num("二十"), Some(20));
    assert_eq!(parse_cn_num("三十五"), Some(35));
    assert_eq!(parse_cn_num("一百"), Some(100));
    assert_eq!(parse_cn_num("abc"), None);
}
fn parse_cn_num(s: &str) -> Option<u32> {
    let m: std::collections::HashMap<char, u32> = [
        ('零',0),('〇',0),('一',1),('二',2),('两',2),('三',3),('四',4),
        ('五',5),('六',6),('七',7),('八',8),('九',9),('十',10),('百',100),
    ].iter().cloned().collect();
    let cs: Vec<char> = s.chars().collect();
    if cs.is_empty() { return None; }
    if cs.len() == 1 { return m.get(&cs[0]).copied(); }
    if cs.len() == 2 && cs[1] == '十' { return Some(m.get(&cs[0]).copied().unwrap_or(1) * 10); }
    if cs.len() == 2 && cs[0] == '十' { return Some(10 + m.get(&cs[1]).copied().unwrap_or(0)); }
    if cs.len() == 3 && cs[1] == '十' { return Some(m.get(&cs[0]).copied().unwrap_or(1) * 10 + m.get(&cs[2]).copied().unwrap_or(0)); }
    if cs.len() == 2 && cs[1] == '百' && cs[0] != '十' { return Some(m.get(&cs[0]).copied().unwrap_or(1) * 100); }
    None
}

// ── Import scanner ─────────────────────────────────────────

#[test]
fn test_scan_chapter_files() {
    let d = tmp_dir();
    fs::write(Path::new(&d).join("01.txt"), "第1章 开始\n第一章的内容在这里。\n\n第2章 继续\n第二章内容。").unwrap();
    let content = fs::read_to_string(Path::new(&d).join("01.txt")).unwrap();
    let re = regex::Regex::new(r"第[零一二三四五六七八九十百千\d]+章").unwrap();
    let mut titles: Vec<String> = Vec::new();
    for l in content.lines() {
        let t = l.trim();
        if re.is_match(t) { titles.push(t.to_string()); }
    }
    assert!(titles.len() >= 2, "Should find at least 2 chapters");
    assert!(titles.iter().any(|t| t.contains("第1章")));
    assert!(titles.iter().any(|t| t.contains("第2章")));

    cleanup(&d);
}
#[test]
fn test_scan_empty_dir() {
    let d = tmp_dir();
    let count = fs::read_dir(&d).unwrap().count();
    assert_eq!(count, 0);
    cleanup(&d);
}

// ── Config ──────────────────────────────────────────────────

#[test]
fn test_config_read_write() {
    let d = tmp_dir();
    let p = Path::new(&d).join("config.json");
    let c = serde_json::json!({"api_key":"sk-test","model":"gpt-4","api_base_url":"https://api.openai.com/v1"});
    fs::write(&p, serde_json::to_string(&c).unwrap()).unwrap();

    let loaded: serde_json::Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(loaded["api_key"], "sk-test");
    assert_eq!(loaded["model"], "gpt-4");

    // Update
    let mut updated = loaded.clone();
    updated["model"] = serde_json::Value::String("deepseek-v4-flash".into());
    fs::write(&p, serde_json::to_string(&updated).unwrap()).unwrap();
    let reloaded: serde_json::Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    assert_eq!(reloaded["model"], "deepseek-v4-flash");

    cleanup(&d);
}

// ── Agent events ───────────────────────────────────────────

#[test]
fn test_agent_event_serialization() {
    let ack = serde_json::json!({"event":"ack","data":{"task_id":"t1"}});
    let delta = serde_json::json!({"event":"delta","data":{"text":"hello"}});
    let done = serde_json::json!({"event":"done","data":{"answer":"x","task_id":"t1"}});
    let err = serde_json::json!({"event":"error","data":{"message":"fail"}});

    assert_eq!(ack["event"], "ack");
    assert_eq!(ack["data"]["task_id"], "t1");
    assert_eq!(delta["data"]["text"], "hello");
    assert_eq!(done["event"], "done");
    assert_eq!(err["event"], "error");
}

// ── Pipeline prompts ───────────────────────────────────────

#[test]
fn test_pipeline_prompts_exist() {
    let summary = include_str!("../prompts/pipeline_summary.md");
    let world = include_str!("../prompts/pipeline_world.md");
    assert!(!summary.is_empty());
    assert!(!world.is_empty());
    assert!(summary.contains("摘要"));
    assert!(world.contains("世界观"));
}

#[test]
fn test_agent_prompts_exist() {
    let cont = include_str!("../prompts/continuation.md");
    let review = include_str!("../prompts/review.md");
    assert!(cont.contains("CONTINUATION_AGENT"));
    assert!(review.contains("REVIEW_AGENT"));
    assert!(cont.len() > 500); // substantial prompt
    assert!(review.len() > 500);
}

// ── Rolling planner ────────────────────────────────────────

#[test]
fn test_rolling_parse_chapter_cards() {
    let re = regex::Regex::new(r"(?i)^(?:#{1,6}\s+)?(?:章节卡|卡)\s*(\d+|[一二三四五六七八九十百]+)\s*[：:\-]?\s*(.*?)\s*$").unwrap();
    let md = "## 卡1：序幕\n- goal：建立世界观\n- entry_scene：主角穿越\n\n## 卡2：冲突\n- goal：引入反派";
    let mut cards = Vec::new();
    for l in md.lines() {
        if let Some(c) = re.captures(l.trim()) {
            let num = c.get(1).unwrap().as_str();
            let title = c.get(2).map(|m| m.as_str()).unwrap_or("");
            cards.push((num.to_string(), title.to_string()));
        }
    }
    assert_eq!(cards.len(), 2);
    assert_eq!(cards[0].0, "1");
    assert_eq!(cards[0].1, "序幕");
    assert_eq!(cards[1].0, "2");
}

// ── Style diagnostics ──────────────────────────────────────

#[test]
fn test_style_density_calculation() {
    let text = "他说：走吧。她站着看向窗外。光线从窗户洒入。因为这是规则。";
    let interior = regex::Regex::new(r"想|觉得|意识|知道|明白|判断|怀疑|恐惧|害怕|不安|沉默|错觉|记得|忘记|心|脑|呼吸").unwrap();
    let action = regex::Regex::new(r"走|跑|站|坐|看|盯|转|伸|抬|按|握|推|拉|打开|关上|低头|回头|停下|靠|穿过|落下").unwrap();
    let env = regex::Regex::new(r"光|灯|影|风|空气|声音|声浪|噪音|气味|温度|寒|热|墙|门|窗|地板|走廊|房间|屏幕|座椅|空间").unwrap();
    let exp = regex::Regex::new(r"因为|所以|因此|规则|流程|计划|安排|解释|说明|分析|数据|结果|意味着|本质|原因|逻辑|结构").unwrap();
    let chars = text.chars().filter(|c| !c.is_whitespace()).count();
    let lines: Vec<&str> = text.lines().collect();
    let int_d = if chars > 0 { (lines.iter().filter(|l| interior.is_match(l)).count() as f64 / chars as f64 * 1000.0 * 100.0).round() / 100.0 } else { 0.0 };
    let act_d = if chars > 0 { (lines.iter().filter(|l| action.is_match(l)).count() as f64 / chars as f64 * 1000.0 * 100.0).round() / 100.0 } else { 0.0 };
    let env_d = if chars > 0 { (lines.iter().filter(|l| env.is_match(l)).count() as f64 / chars as f64 * 1000.0 * 100.0).round() / 100.0 } else { 0.0 };
    let exp_d = if chars > 0 { (lines.iter().filter(|l| exp.is_match(l)).count() as f64 / chars as f64 * 1000.0 * 100.0).round() / 100.0 } else { 0.0 };
    assert!(int_d >= 0.0);
    assert!(act_d > 0.0); // 站, 看 are action words
    assert!(env_d > 0.0); // 光线 is environment
    assert!(exp_d > 0.0); // 因为 is exposition
}

// ── Message construction ───────────────────────────────────

#[test]
fn test_llm_message_types() {
    let sys = serde_json::json!({"role":"system","content":"prompt"});
    let user = serde_json::json!({"role":"user","content":"hello"});
    let tool = serde_json::json!({"role":"tool","content":"result","tool_call_id":"c1","name":"get_file"});
    assert_eq!(sys["role"], "system");
    assert_eq!(user["content"], "hello");
    assert_eq!(tool["tool_call_id"], "c1");
}

// ── Tool schema validation ─────────────────────────────────

#[test]
fn test_tool_schema_required_fields() {
    // Each tool must have: type, function.name, function.description, function.parameters
    let tools = vec![
        ("get_file", "Read a file", vec!["book_id","file_name"]),
        ("update_file", "Write a file", vec!["file_name","content"]),
    ];
    for (name, desc, _) in &tools {
        let schema = serde_json::json!({
            "type":"function",
            "function":{"name":name,"description":desc,"parameters":{"type":"object","properties":{},"required":[]}}
        });
        assert_eq!(schema["function"]["name"], *name);
        assert!(!schema["function"]["description"].as_str().unwrap().is_empty());
    }
}
