use crate::AppState;
use serde::Serialize;
use std::fs;
use std::path::Path;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct RollingPlan {
    pub book_id: String,
    pub next_action: String,
    pub stop_reason: String,
    pub batch_size: usize,
    pub written_chapter_numbers: Vec<u32>,
    pub pending_card_numbers: Vec<u32>,
    pub selected_card_numbers: Vec<u32>,
    pub blocked_card_numbers: Vec<u32>,
    pub card_count: usize,
    pub draft_chapter_count: usize,
    pub archive_chapter_count: usize,
    pub outline_cards: Vec<ChapterCardInfo>,
}

#[derive(Debug, Serialize)]
pub struct ChapterCardInfo {
    pub number: u32,
    pub title: String,
    pub status: String,
    pub executable: bool,
    pub missing_fields: Vec<String>,
}

#[derive(Debug)]
struct ChapterCard {
    number: u32,
    title: String,
    heading_line: usize,
    end_line: usize,
    fields: std::collections::HashMap<String, String>,
    executable: bool,
    missing_fields: Vec<String>,
}

fn parse_chapter_number(raw: &str) -> Option<u32> {
    let s = raw.trim();
    if s.is_empty() { return None; }
    // Try Arabic digits
    if let Ok(n) = s.parse::<u32>() { return Some(n); }
    // Try Chinese digits
    let chinese: std::collections::HashMap<char, u32> = [
        ('零',0),('〇',0),('一',1),('二',2),('两',2),('三',3),('四',4),
        ('五',5),('六',6),('七',7),('八',8),('九',9),('十',10),
        ('百',100),
    ].iter().cloned().collect();
    let chars: Vec<char> = s.chars().collect();
    if chars.len() == 1 {
        return chinese.get(&chars[0]).copied();
    }
    if chars.len() == 2 && chars[1] == '十' {
        return Some(chinese.get(&chars[0]).copied().unwrap_or(1) * 10);
    }
    if chars.len() == 3 && chars[1] == '十' {
        return Some(chinese.get(&chars[0]).copied().unwrap_or(1) * 10 + chinese.get(&chars[2]).copied().unwrap_or(0));
    }
    None
}

fn parse_chapter_cards(markdown: &str) -> Vec<ChapterCard> {
    let heading_re = regex::Regex::new(r"(?i)^(?:#{1,6}\s+)?(?:CH|ch)?\s*(?:章节卡|卡)\s*(\S+)\s*[：:\-]?\s*(.*?)\s*$").unwrap();
    let field_re = regex::Regex::new(r"^[ \t]*[-*][ \t]*([A-Za-z_]+|[一-鿿]+)[：:][ \t]*(.*)$").unwrap();
    let lines: Vec<&str> = markdown.lines().collect();
    let mut cards = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        if let Some(caps) = heading_re.captures(lines[i].trim()) {
            let num_str = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if let Some(num) = parse_chapter_number(num_str) {
                let title = caps.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                let start = i;
                let mut fields = std::collections::HashMap::new();
                i += 1;
                // Parse fields until next heading or empty
                while i < lines.len() {
                    let trimmed = lines[i].trim();
                    if heading_re.is_match(trimmed) { break; }
                    if let Some(fc) = field_re.captures(trimmed) {
                        let key = fc.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
                        let val = fc.get(2).map(|m| m.as_str()).unwrap_or("").to_string();
                        fields.insert(key, val);
                    }
                    i += 1;
                }
                let end = i;
                let required = ["goal","entry_scene","conflict","payoff","hook"];
                let missing: Vec<String> = required.iter().filter(|k| !fields.keys().any(|fk| fk.to_lowercase().contains(&k.to_lowercase()))).map(|s| s.to_string()).collect();
                cards.push(ChapterCard { number: num, title, heading_line: start, end_line: end, fields, executable: missing.is_empty(), missing_fields: missing });
                continue;
            }
        }
        i += 1;
    }
    cards
}

fn parse_written_chapters(markdown: &str) -> Vec<u32> {
    let heading_re = regex::Regex::new(r"^##\s*第(\d+)章").unwrap();
    let mut numbers = Vec::new();
    for line in markdown.lines() {
        if let Some(caps) = heading_re.captures(line.trim()) {
            if let Ok(n) = caps.get(1).unwrap().as_str().parse::<u32>() {
                numbers.push(n);
            }
        }
    }
    numbers
}

fn parse_archived_chapter_numbers(book_dir: &Path) -> Vec<u32> {
    let chapters_dir = book_dir.join("chapters");
    if !chapters_dir.exists() { return vec![]; }
    let mut numbers = Vec::new();
    if let Ok(entries) = fs::read_dir(&chapters_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".md") {
                if let Some(num_str) = name.split('_').next() {
                    if let Ok(n) = num_str.parse::<u32>() { numbers.push(n); }
                }
            }
        }
    }
    numbers.sort();
    numbers
}

#[tauri::command]
pub fn rolling_state(
    state: State<'_, AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    batch_size: Option<usize>,
) -> Result<RollingPlan, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = Path::new(&state.storage_root).join(&id);
    let bs = batch_size.unwrap_or(3).max(1).min(10);

    let outline_path = book_dir.join("chapter_outline.md");
    let draft_path = book_dir.join("chapter_draft.md");
    let outline_md = if outline_path.exists() { fs::read_to_string(&outline_path).unwrap_or_default() } else { String::new() };
    let draft_md = if draft_path.exists() { fs::read_to_string(&draft_path).unwrap_or_default() } else { String::new() };

    let cards = parse_chapter_cards(&outline_md);
    let draft_numbers = parse_written_chapters(&draft_md);
    let archive_numbers = parse_archived_chapter_numbers(&book_dir);
    let consumed: std::collections::HashSet<u32> = archive_numbers.iter().chain(draft_numbers.iter()).copied().collect();
    let pending: Vec<u32> = cards.iter().map(|c| c.number).filter(|n| !consumed.contains(n)).collect();
    let selected: Vec<u32> = pending.iter().take(bs).copied().collect();
    let blocked: Vec<u32> = Vec::new();
    let written = draft_numbers.clone();
    let sel = selected.clone();

    let (next_action, stop_reason) = if selected.is_empty() {
        ("replenish_outline", "no_executable_pending_cards")
    } else {
        ("continue_existing_cards", "")
    };


    Ok(RollingPlan {
        book_id: id,
        next_action: next_action.into(), stop_reason: stop_reason.into(), batch_size: bs,
        written_chapter_numbers: written,
        pending_card_numbers: pending,
        selected_card_numbers: sel,
        blocked_card_numbers: blocked,
        card_count: cards.len(),///
        draft_chapter_count: draft_numbers.len(),
        archive_chapter_count: archive_numbers.len(),
        outline_cards: cards.into_iter().map(|c| ChapterCardInfo {
            number: c.number, title: c.title,
            status: if consumed.contains(&c.number) { "written".into() } else if selected.contains(&c.number) { "selected".into() } else { "pending".into() },
            executable: c.executable, missing_fields: c.missing_fields,
        }).collect(),
    })
}
