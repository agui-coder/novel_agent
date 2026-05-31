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

#[derive(Debug, Serialize)]
pub struct GitWorkingTreeResult {
    pub status: String, pub book_id: String,
    pub is_dirty: bool, pub staged_count: usize, pub unstaged_count: usize, pub untracked_count: usize,
    pub entries: Vec<GitWorkingEntry>,
}
#[derive(Debug, Serialize)]
pub struct GitWorkingEntry { pub path: String, pub staged: bool, pub unstaged: bool, pub is_untracked: bool, pub index_status: String, pub worktree_status: String }

#[tauri::command]
pub fn git_working_tree(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>) -> Result<GitWorkingTreeResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let mut e = Vec::new(); let mut s=0; let mut u=0; let mut t=0;
    if let Ok(ss) = repo.statuses(None) { for st in ss.iter() {
        let p = st.path().unwrap_or("").to_string(); let ist = st.status();
        let sv = ist.contains(git2::Status::INDEX_NEW)|ist.contains(git2::Status::INDEX_MODIFIED);
        let uv = ist.contains(git2::Status::WT_MODIFIED)|ist.contains(git2::Status::WT_DELETED);
        let uu = ist.contains(git2::Status::WT_NEW);
        if sv {s+=1;} if uv {u+=1;} if uu {t+=1;}
        e.push(GitWorkingEntry{path:p,staged:sv,unstaged:uv,is_untracked:uu,index_status:String::new(),worktree_status:String::new()});
    }}
    Ok(GitWorkingTreeResult{status:"success".into(),book_id:id,is_dirty:s>0||u>0||t>0,staged_count:s,unstaged_count:u,untracked_count:t,entries:e})
}

#[tauri::command]
pub fn git_stage(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, path: String) -> Result<(), String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let mut idx = repo.index().map_err(|e| format!("Idx: {}", e))?;
    idx.add_path(std::path::Path::new(&path)).map_err(|e| format!("Add: {}", e))?;
    idx.write().map_err(|e| format!("Write: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_stage_all(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>) -> Result<(), String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let mut idx = repo.index().map_err(|e| format!("Idx: {}", e))?;
    if let Ok(ss) = repo.statuses(None) {
        for s in ss.iter() {
            if let Some(p) = s.path() {
                if !s.status().contains(git2::Status::IGNORED) { idx.add_path(std::path::Path::new(p)).ok(); }
            }
        }
    }
    idx.write().map_err(|e| format!("Write: {}", e))?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, path: String) -> Result<(), String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    if let Ok(head) = repo.head() {
        if let Ok(commit) = head.peel_to_commit() {
            if let Ok(tree) = commit.tree() {
                if tree.get_path(std::path::Path::new(&path)).is_ok() {
                    let mut idx = repo.index().map_err(|e| format!("Idx: {}", e))?;
                    idx.add_path(std::path::Path::new(&path)).map_err(|e| format!("Add: {}", e))?;
                    idx.write().map_err(|e| format!("Write: {}", e))?;
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct GitCommitStagedResult { pub status: String, pub commit_id: String, pub current_branch: String }

#[tauri::command]
pub fn git_commit_staged(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, message: String) -> Result<GitCommitStagedResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let sig = repo.signature().map_err(|e| format!("Sign: {}", e))?;
    let mut idx = repo.index().map_err(|e| format!("Idx: {}", e))?;
    let tid = idx.write_tree().map_err(|e| format!("Tree: {}", e))?;
    let tree = repo.find_tree(tid).map_err(|e| format!("Tree: {}", e))?;
    let cur = repo.head().ok().and_then(|h| h.shorthand().map(String::from)).unwrap_or_default();
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents).map_err(|e| format!("Commit: {}", e))?;
    Ok(GitCommitStagedResult { status: "success".into(), commit_id: oid.to_string(), current_branch: cur })
}

#[derive(Debug, Serialize)]
pub struct GitMergeResult { pub status: String, pub book_id: String, pub current_branch: String, pub source_branch: String, pub commit_id: String }

#[tauri::command]
pub fn git_merge(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, source_branch: String, message: Option<String>) -> Result<GitMergeResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let src_ref = repo.find_branch(&source_branch, git2::BranchType::Local).map_err(|e| format!("Branch not found: {}", e))?;
    let src_oid = src_ref.get().target().ok_or("No target")?;
    let src = repo.find_commit(src_oid).map_err(|e| format!("Commit: {}", e))?;
    let cur = repo.head().ok().and_then(|h| h.shorthand().map(String::from)).unwrap_or_default();
    let head_commit = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).ok_or("No HEAD")?;
    let annotated = repo.find_annotated_commit(src.id()).or_else(|_| repo.reference_to_annotated_commit(&src_ref.into_reference())).map_err(|e| format!("Annotated: {}", e))?;
    repo.merge(&[&annotated], None, None).map_err(|e| format!("Merge: {}", e))?;
    let sig = repo.signature().map_err(|e| format!("Sign: {}", e))?;
    let tree_id = repo.index().map_err(|e| format!("Idx: {}", e))?.write_tree().map_err(|e| format!("Tree: {}", e))?;
    let tree = repo.find_tree(tree_id).map_err(|e| format!("Tree: {}", e))?;
    let parents: Vec<&git2::Commit> = vec![&head_commit, &src];
    let msg = message.unwrap_or_else(|| format!("Merge branch '{}'", source_branch));
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parents).map_err(|e| format!("Commit: {}", e))?;
    repo.cleanup_state().ok();
    Ok(GitMergeResult { status: "success".into(), book_id: id, current_branch: cur, source_branch, commit_id: oid.to_string() })
}

#[tauri::command]
pub fn git_rename_branch(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, old_name: String, new_name: String) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let mut branch = repo.find_branch(&old_name, git2::BranchType::Local).map_err(|e| format!("Branch not found: {}", e))?;
    branch.rename(&new_name, false).map_err(|e| format!("Rename: {}", e))?;
    Ok(serde_json::json!({"status":"success","book_id":id,"old_name":old_name,"new_name":new_name}))
}

#[tauri::command]
pub fn git_hard_rollback(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, target_commit: String) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let oid = git2::Oid::from_str(&target_commit).map_err(|e| format!("Invalid OID: {}", e))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("Commit not found: {}", e))?;
    repo.reset(commit.as_object(), git2::ResetType::Hard, None).map_err(|e| format!("Reset: {}", e))?;
    Ok(serde_json::json!({"status":"success","book_id":id,"target_commit":target_commit}))
}

#[derive(Debug, Serialize)]
pub struct GitCommitFilesResult { pub status: String, pub book_id: String, pub commit_id: String, pub files: Vec<GitCommitFile> }
#[derive(Debug, Serialize)]
pub struct GitCommitFile { pub path: String, pub status: String }

#[tauri::command]
pub fn git_commit_files(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, commit_id: String) -> Result<GitCommitFilesResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let oid = git2::Oid::from_str(&commit_id).map_err(|e| format!("Invalid OID: {}", e))?;
    let commit = repo.find_commit(oid).map_err(|e| format!("Commit not found: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Tree: {}", e))?;
    let parent = if commit.parent_count() > 0 { commit.parent(0).ok().and_then(|p| p.tree().ok()) } else { None };
    let mut files = Vec::new();
    if let Some(ref pt) = parent {
        let diff = repo.diff_tree_to_tree(Some(pt), Some(&tree), None).map_err(|e| format!("Diff: {}", e))?;
        diff.foreach(&mut |d, _| {
            let p = d.new_file().path().unwrap_or(std::path::Path::new("")).to_string_lossy().to_string();
            files.push(GitCommitFile { path: p, status: format!("{:?}", d.status()) });
            true
        }, None, None, None).ok();
    }
    Ok(GitCommitFilesResult { status: "success".into(), book_id: id, commit_id, files })
}
