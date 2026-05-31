use crate::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct GitLogEntry {
    pub commit_id: String,
    pub parent_id: Option<String>,
    pub timestamp: i64,
    pub message: String,
    pub author: String,
}

#[derive(Debug, Serialize)]
pub struct GitLogResult {
    pub status: String,
    pub book_id: String,
    pub commits: Vec<GitLogEntry>,
}

#[tauri::command]
pub fn git_log(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    max_count: Option<usize>,
) -> Result<GitLogResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);

    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error opening {}: {}", book_dir.display(), e))?;
    let mut revwalk = repo.revwalk().map_err(|e| format!("Git revwalk error: {}", e))?;
    if repo.head().is_err() {
        // No HEAD yet (empty repo with no commits) — return empty log
        return Ok(GitLogResult { status: "success".into(), book_id: id, commits: vec![] });
    }
    revwalk.push_head().map_err(|e| format!("Git push head error for {}: {}", book_dir.display(), e))?;

    let limit = max_count.unwrap_or(50);
    let mut commits = Vec::new();

    for (i, oid) in revwalk.enumerate() {
        if i >= limit {
            break;
        }
        let oid = oid.map_err(|e| format!("Git oid error: {}", e))?;
        let commit = repo.find_commit(oid).map_err(|e| format!("Git find commit error: {}", e))?;

        commits.push(GitLogEntry {
            commit_id: oid.to_string(),
            parent_id: commit.parents().next().map(|p| p.id().to_string()),
            timestamp: commit.time().seconds(),
            message: commit.message().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("unknown").to_string(),
        });
    }

    Ok(GitLogResult {
        status: "success".into(),
        book_id: id,
        commits,
    })
}

#[derive(Debug, Serialize)]
pub struct GitDiffResult {
    pub status: String,
    pub book_id: String,
    pub diff: String,
}

#[tauri::command]
pub fn git_diff(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    commit_a: Option<String>,
    commit_b: Option<String>,
    file_name: Option<String>,
) -> Result<GitDiffResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;

    let a = commit_a.unwrap_or_else(|| "HEAD~1".into());
    let b = commit_b.unwrap_or_else(|| "HEAD".into());

    let obj_a = repo.revparse_single(&a).map_err(|e| format!("Git revparse {} error: {}", a, e))?;
    let obj_b = repo.revparse_single(&b).map_err(|e| format!("Git revparse {} error: {}", b, e))?;

    let tree_a = if let Ok(commit) = obj_a.peel_to_commit() {
        commit.tree().map_err(|e| format!("Git tree error: {}", e))?
    } else {
        repo.find_tree(obj_a.id()).map_err(|e| format!("Git tree error: {}", e))?
    };

    let tree_b = if let Ok(commit) = obj_b.peel_to_commit() {
        commit.tree().map_err(|e| format!("Git tree error: {}", e))?
    } else {
        repo.find_tree(obj_b.id()).map_err(|e| format!("Git tree error: {}", e))?
    };

    let diff = repo.diff_tree_to_tree(Some(&tree_a), Some(&tree_b), None)
        .map_err(|e| format!("Git diff error: {}", e))?;

    let mut diff_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if let Ok(content) = std::str::from_utf8(line.content()) {
            match line.origin() {
                '+' => diff_text.push_str(&format!("+{}", content)),
                '-' => diff_text.push_str(&format!("-{}", content)),
                _ => diff_text.push_str(&format!(" {}", content)),
            }
        }
        true
    }).map_err(|e| format!("Git diff print error: {}", e))?;

    Ok(GitDiffResult {
        status: "success".into(),
        book_id: id,
        diff: diff_text,
    })
}

#[derive(Debug, Serialize)]
pub struct GitBranchResult {
    pub status: String,
    pub book_id: String,
    pub branches: Vec<String>,
    pub current: String,
}

#[tauri::command]
pub fn git_branch_list(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
) -> Result<GitBranchResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;

    let branches = repo.branches(None).map_err(|e| format!("Git branches error: {}", e))?;
    let mut branch_names = Vec::new();
    let mut current = String::new();

    for branch in branches {
        let (branch, branch_type) = branch.map_err(|e| format!("Git branch error: {}", e))?;
        let name = branch.name().ok().flatten().unwrap_or("unknown").to_string();
        if branch_type == git2::BranchType::Local {
            if branch.is_head() {
                current = name.clone();
            }
            branch_names.push(name);
        }
    }

    Ok(GitBranchResult {
        status: "success".into(),
        book_id: id,
        branches: branch_names,
        current,
    })
}

#[tauri::command]
pub fn git_checkout_branch(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    branch_name: String,
    create: Option<bool>,
) -> Result<GitBranchResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;

    let head = repo.head().ok();
    let head_commit = head.as_ref().and_then(|h| h.peel_to_commit().ok());

    if create.unwrap_or(false) {
        let commit = head_commit.as_ref().ok_or("No HEAD commit")?;
        repo.branch(&branch_name, commit, false)
            .map_err(|e| format!("Git branch create error: {}", e))?;
    }

    let (object, reference) = repo.revparse_ext(&branch_name)
        .map_err(|e| format!("Git revparse error: {}", e))?;

    repo.checkout_tree(&object, None)
        .map_err(|e| format!("Git checkout error: {}", e))?;

    if let Some(gref) = reference {
        repo.set_head(gref.name().unwrap_or(""))
            .map_err(|e| format!("Git set head error: {}", e))?;
    } else {
        repo.set_head_detached(object.id())
            .map_err(|e| format!("Git set head detached error: {}", e))?;
    }

    git_branch_list(state, Some(id.clone()), None)
}
