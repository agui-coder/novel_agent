use crate::AppState;
use serde_json::json;
use std::fs;
use std::path::Path;
use tauri::{Emitter, State};

const STYLE_FILES: &[&str] = &[
    "style_fingerprint.md",
    "style_review.md",
    "style_constraints_for_continuation.md",
];

fn is_placeholder(path: &Path, file_name: &str) -> bool {
    if !path.exists() { return true; }
    let content = fs::read_to_string(path).unwrap_or_default();
    let stripped = content.trim();
    if stripped.is_empty() { return true; }
    let lines: Vec<&str> = stripped.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() <= 1 && lines[0].starts_with('#') { return true; }
    let markers = [
        ("style_fingerprint.md", "# 原文近段手感证据"),
        ("style_review.md", "# 草稿文风偏差提示"),
        ("style_constraints_for_continuation.md", "# 续写文风参考卡"),
    ];
    for (f, m) in markers {
        if file_name == f && stripped == m { return true; }
    }
    false
}

fn needs_generation(book_dir: &Path) -> bool {
    STYLE_FILES.iter().any(|f| is_placeholder(&book_dir.join(f), f))
}

fn run_diagnostics(book_dir: &Path, source_count: usize) -> Result<Vec<(String, String)>, String> {
    let chapters_dir = book_dir.join("chapters");
    let mut source_text = String::new();
    let mut source_files: Vec<String> = Vec::new();
    if chapters_dir.exists() {
        let mut files: Vec<_> = fs::read_dir(&chapters_dir).map(|d| d.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default();
        files.sort_by_key(|e| e.file_name());
        for f in files.iter().rev().take(source_count) {
            let path = f.path();
            if let Ok(c) = fs::read_to_string(&path) { source_text.push_str(&c); source_text.push_str("\n\n"); }
            source_files.push(path.file_name().unwrap_or_default().to_string_lossy().to_string());
        }
    }

    let draft_path = book_dir.join("chapter_draft.md");
    let draft_text = if draft_path.exists() { fs::read_to_string(&draft_path).unwrap_or_default() } else { String::new() };

    fn density(pat: &regex::Regex, text: &str, chars: usize) -> f64 {
        let hits = text.lines().filter(|l| pat.is_match(l)).count();
        if chars > 0 { (hits as f64 / chars as f64 * 1000.0 * 100.0).round() / 100.0 } else { 0.0 }
    }
    fn count_non_ws(s: &str) -> usize { s.chars().filter(|c| !c.is_whitespace()).count() }
    fn split_sentences(s: &str) -> Vec<&str> { s.split(|c: char| c == '。' || c == '！' || c == '？' || c == '!' || c == '?').filter(|x| !x.trim().is_empty()).collect() }
    fn split_paras(s: &str) -> Vec<&str> { s.split("\n\n").filter(|p| !p.trim().is_empty()).collect() }

    let src_chars = count_non_ws(&source_text);
    let draft_chars = count_non_ws(&draft_text);
    let src_paras = split_paras(&source_text);
    let draft_paras = split_paras(&draft_text);
    let src_sents = split_sentences(&source_text);
    let draft_sents = split_sentences(&draft_text);
    let src_pc = src_paras.len();
    let draft_pc = draft_paras.len();

    let dlg = regex::Regex::new(r#"[“"「『]|：.*\S"#).unwrap();
    let interior = regex::Regex::new(r"想|觉得|意识|知道|明白|判断|怀疑|恐惧|害怕|不安|沉默|错觉|记得|忘记|心|脑|呼吸").unwrap();
    let action = regex::Regex::new(r"走|跑|站|坐|看|盯|转|伸|抬|按|握|推|拉|打开|关上|低头|回头|停下|靠|穿过|落下").unwrap();
    let env = regex::Regex::new(r"光|灯|影|风|空气|声音|声浪|噪音|气味|温度|寒|热|墙|门|窗|地板|走廊|房间|屏幕|座椅|空间").unwrap();
    let expo = regex::Regex::new(r"因为|所以|因此|规则|流程|计划|安排|解释|说明|分析|数据|结果|意味着|本质|原因|逻辑|结构").unwrap();
    let susp = regex::Regex::new(r"但|可是|然而|忽然|突然|没有|不对|异常|奇怪|裂缝|空白|问题|为什么|仿佛|像是").unwrap();

    let src_metrics = vec![
        ("avg_sentence", if src_sents.is_empty() { 0.0 } else { (src_chars as f64 / src_sents.len() as f64 * 10.0).round() / 10.0 }),
        ("avg_para", if src_pc > 0 { (src_chars / src_pc) as f64 } else { 0.0 }),
        ("dialogue_ratio", if src_pc > 0 { (src_paras.iter().filter(|p| dlg.is_match(p)).count() as f64 / src_pc as f64 * 10000.0).round() / 100.0 } else { 0.0 }),
        ("interior_density", density(&interior, &source_text, src_chars)),
        ("action_density", density(&action, &source_text, src_chars)),
        ("environment_density", density(&env, &source_text, src_chars)),
        ("exposition_density", density(&expo, &source_text, src_chars)),
        ("suspense_density", density(&susp, &source_text, src_chars)),
    ];
    let draft_metrics = vec![
        ("avg_sentence", if draft_sents.is_empty() { 0.0 } else { (draft_chars as f64 / draft_sents.len() as f64 * 10.0).round() / 10.0 }),
        ("avg_para", if draft_pc > 0 { (draft_chars / draft_pc) as f64 } else { 0.0 }),
        ("dialogue_ratio", if draft_pc > 0 { (draft_paras.iter().filter(|p| dlg.is_match(p)).count() as f64 / draft_pc as f64 * 10000.0).round() / 100.0 } else { 0.0 }),
        ("interior_density", density(&interior, &draft_text, draft_chars)),
        ("action_density", density(&action, &draft_text, draft_chars)),
        ("environment_density", density(&env, &draft_text, draft_chars)),
        ("exposition_density", density(&expo, &draft_text, draft_chars)),
        ("suspense_density", density(&susp, &draft_text, draft_chars)),
    ];

    let labels: std::collections::HashMap<&str, &str> = [
        ("avg_sentence","句式呼吸"),("avg_para","段落节拍"),("dialogue_ratio","对白推进度"),
        ("interior_density","内心贴近度"),("action_density","动作驱动度"),("environment_density","环境压迫感"),
        ("exposition_density","设定解释度"),("suspense_density","悬念留白度"),
    ].iter().cloned().collect();
    let tolerances: std::collections::HashMap<&str, f64> = [
        ("avg_sentence",0.15),("avg_para",0.20),("dialogue_ratio",0.25),("interior_density",0.30),
        ("action_density",0.35),("environment_density",0.35),("exposition_density",0.35),("suspense_density",0.35),
    ].iter().cloned().collect();

    let mut table_rows = String::new();
    let mut warnings = Vec::new();
    for i in 0..src_metrics.len() {
        let (name, sv) = src_metrics[i];
        let (_, dv) = draft_metrics[i];
        let label = labels.get(name).unwrap_or(&name);
        let tol = tolerances.get(name).unwrap_or(&0.3);
        let dev = if sv > 0.0 { ((dv - sv).abs() / sv * 10000.0).round() / 100.0 } else { 0.0 };
        let flag = if dev > *tol * 100.0 { " ⚠" } else { "" };
        table_rows.push_str(&format!("| {} | {:.1} | {:.1} | {:.1}%{} |\n", label, sv, dv, dev, flag));
        if dev > *tol * 200.0 { warnings.push(format!("{} 严重偏离 (原 {:.1} → 稿 {:.1})", label, sv, dv)); }
    }

    let fingerprint = format!(
        "# 原文近段手感证据\n\n> 从最近 {} 章原文样本（{} 字符）提取。仅作续写参考，非硬门禁。\n\n## 原文完整指标\n\n| 指标 | 数值 |\n|------|------|\n{}\n## 与最新草稿对比\n\n| 指标 | 原文 | 草稿 | 偏差 |\n|------|------|------|------|\n{}",
        source_files.len(), src_chars,
        src_metrics.iter().map(|(n,v)| format!("| {} | {:.1} |", labels.get(n).unwrap_or(n), v)).collect::<Vec<_>>().join("\n"),
        table_rows,
    );
    let review = format!(
        "# 草稿文风偏差提示\n\n> 建议性分析，不作为调度锁。\n\n{}\n\n## 建议\n- 对白不足：增加对话和互动推进剧情\n- 解释过多：把规则说明改为可观察后果\n- 环境过多：只保留改变选择或阻碍行动的环境提示\n- 内心过多：用行动和对话替代内心独白\n",
        if warnings.is_empty() { "暂无显著偏差（所有指标在容忍范围内）".to_string() } else { warnings.iter().enumerate().map(|(i,w)| format!("{}. ⚠️ {}", i+1, w)).collect::<Vec<_>>().join("\n") }
    );
    let constraints = format!(
        "# 续写文风参考卡\n\n> 续写 Agent 生成新章节时的文风约束。\n\n## 目标区间\n{}\n\n## 避免\n- 大段解释（目标 < {:.1}）\n- 过度环境（目标 < {:.1}）\n- 过度内心（目标 < {:.1}）\n\n## 推荐\n- 用行动和对话传递信息\n- 环境描写服务角色决策\n",
        src_metrics.iter().map(|(n,v)| format!("- {}：{:.1} ± {}%", labels.get(n).unwrap_or(n), v, (tolerances.get(n).unwrap_or(&0.3)*100.0) as i32)).collect::<Vec<_>>().join("\n"),
        density(&expo, &source_text, src_chars) * 1.2, density(&env, &source_text, src_chars) * 1.2, density(&interior, &source_text, src_chars) * 1.2,
    );

    Ok(vec![
        ("style_fingerprint.md".to_string(), fingerprint),
        ("style_review.md".to_string(), review),
        ("style_constraints_for_continuation.md".to_string(), constraints),
    ])
}

#[tauri::command]
pub fn style_init(
    app: tauri::AppHandle, state: State<'_, AppState>,
    book_id: Option<String>, book_name: Option<String>,
    force_rebuild: Option<bool>, source_count: Option<usize>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = Path::new(&state.storage_root).join(&id);
    let force = force_rebuild.unwrap_or(false);
    let sc = source_count.unwrap_or(12).min(30).max(1);
    let result_tid = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();

    if !force && !needs_generation(&book_dir) {
        app.emit("style:event", &json!({"event":"done","data":{"completed":0,"failed":0,"skipped":true,"artifacts":STYLE_FILES}})).ok();
        return Ok(json!({"task_id": result_tid, "status": "skipped"}));
    }

    let storage = state.storage_root.clone();
    std::thread::spawn(move || {
        app.emit("style:event", &json!({"event":"ack","data":{"book_id":&id,"total_steps":5,"artifacts":STYLE_FILES}})).ok();
        app.emit("style:event", &json!({"event":"progress","data":{"step_index":0,"total":5,"title":"diagnostics","status":"processing"}})).ok();

        match run_diagnostics(&book_dir, sc) {
            Ok(artifacts) => {
                let mut updated: Vec<String> = Vec::new();
                for (i, (file_name, content)) in artifacts.iter().enumerate() {
                    app.emit("style:event", &json!({"event":"progress","data":{"step_index":i+1,"total":5,"title":file_name,"status":"writing"}})).ok();
                    let path = book_dir.join(file_name);
                    let next = content.trim_end().to_string() + "\n";
                    let existing = if path.exists() { fs::read_to_string(&path).unwrap_or_default() } else { String::new() };
                    if existing != next {
                        if let Err(e) = fs::write(&path, &next) {
                            app.emit("style:event", &json!({"event":"error","data":{"message":format!("Write {}: {}", file_name, e),"artifact":file_name}})).ok();
                            return;
                        }
                        updated.push(file_name.clone());
                    }
                }
                app.emit("style:event", &json!({"event":"progress","data":{"step_index":4,"total":5,"title":"git commit","status":"processing"}})).ok();
                let book_dir2 = Path::new(&storage).join(&id);
                crate::commands::archive::git_commit(&book_dir2, "style_fingerprint.md", "[AI_Update] style init: regenerate diagnostics artifacts").ok();
                crate::commands::archive::git_commit(&book_dir2, "style_review.md", "[AI_Update] style init: regenerate diagnostics artifacts").ok();
                crate::commands::archive::git_commit(&book_dir2, "style_constraints_for_continuation.md", "[AI_Update] style init: regenerate diagnostics artifacts").ok();
                app.emit("style:event", &json!({"event":"done","data":{"completed":3,"failed":0,"skipped":false,"artifacts":STYLE_FILES,"updated_artifacts":updated}})).ok();
            }
            Err(e) => {
                app.emit("style:event", &json!({"event":"error","data":{"message":e}})).ok();
            }
        }
    });

    Ok(json!({"task_id": result_tid, "status": "started"}))
}
