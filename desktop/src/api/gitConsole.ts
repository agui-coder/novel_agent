import { invokeApi, bookRefToArgs, BookRef } from './client';

export type GitDiffScope = 'unstaged' | 'staged' | 'commit';

export interface GitStatusSummary {
    currentBranch: string; mainlineBranch: string; headCommit: string;
    isDirty: boolean; stagedCount: number; unstagedCount: number; untrackedCount: number;
}
export interface GitBranchRow {
    name: string; headCommit: string; updatedAt: string; headMessage: string;
    isCurrent: boolean; isMainline: boolean;
}
export interface GitHistoryCommit {
    commitId: string; shortId: string; parentIds: string[];
    timestamp: string; authorName: string; authorEmail: string; message: string; refs: string[];
}
export interface GitWorkingTreeEntry {
    path: string; previousPath: string | null; indexStatus: string; worktreeStatus: string;
    staged: boolean; unstaged: boolean; isUntracked: boolean;
}
export interface GitCommitFile { path: string; previousPath: string | null; status: string; }
export interface GitDiffPayload {
    scope: GitDiffScope; path: string; oldLabel: string; newLabel: string;
    oldText: string; newText: string; changed: boolean; commitId?: string;
}
export interface GitFilePayload { path: string; source: string; content: string; }

// ── Mapped to Rust commands ────────────────────────────────

export async function fetchGitBranches(bookRef: BookRef): Promise<{
    currentBranch: string; mainlineBranch: string; branches: GitBranchRow[];
}> {
    const r = await invokeApi<{ status: string; book_id: string; branches: string[]; current: string }>(
        'git_branch_list', bookRefToArgs(bookRef)
    );
    return {
        currentBranch: r.current,
        mainlineBranch: 'main',
        branches: r.branches.map((name) => ({
            name, headCommit: '', updatedAt: '', headMessage: '',
            isCurrent: name === r.current, isMainline: name === 'main',
        })),
    };
}

export async function fetchGitHistoryList(bookRef: BookRef, limit = 150, _ref?: string | null): Promise<GitHistoryCommit[]> {
    const r = await invokeApi<{
        status: string; book_id: string; commits: Array<{
            commit_id: string; parent_id?: string | null; timestamp: number;
            message: string; author: string;
        }>;
    }>('git_log', { ...bookRefToArgs(bookRef), maxCount: limit });

    return r.commits.map((row) => ({
        commitId: row.commit_id,
        shortId: row.commit_id.slice(0, 7),
        parentIds: row.parent_id ? [row.parent_id] : [],
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        authorName: row.author, authorEmail: '',
        message: row.message, refs: [],
    }));
}

export async function checkoutGitBranch(bookRef: BookRef, branchName: string, _force = false): Promise<{
    status: string; book_id: string; branches: string[]; current: string;
}> {
    return invokeApi('git_checkout_branch', {
        ...bookRefToArgs(bookRef), branchName: branchName, create: false,
    });
}

export async function createGitBranch(bookRef: BookRef, payload: { branchName: string; fromRef?: string | null; checkout?: boolean }): Promise<{
    status: string; book_id: string; branches: string[]; current: string;
}> {
    return invokeApi('git_checkout_branch', {
        ...bookRefToArgs(bookRef), branchName: payload.branchName, create: true,
    });
}

export async function fetchGitDiffView(bookRef: BookRef, payload: {
    scope: GitDiffScope; path: string; commitId?: string;
}): Promise<GitDiffPayload> {
    const r = await invokeApi<{ status: string; book_id: string; diff: string }>('git_diff', {
        ...bookRefToArgs(bookRef),
        commitA: payload.commitId ? `${payload.commitId}~1` : 'HEAD~1',
        commitB: payload.commitId || 'HEAD',
    });
    return {
        scope: payload.scope, path: payload.path,
        oldLabel: 'old', newLabel: 'new',
        oldText: '', newText: r.diff, changed: r.diff.length > 0,
        commitId: payload.commitId,
    };
}

// ── Temporary HTTP fallbacks (Rust commands not yet implemented) ──

export async function fetchGitStatus(bookRef: BookRef): Promise<GitStatusSummary> {
    const r = await invokeApi<{ status: string; book_id: string; branches: string[]; current: string }>(
        'git_branch_list', bookRefToArgs(bookRef)
    );
    return { currentBranch: r.current, mainlineBranch: 'main', headCommit: '', isDirty: false, stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
}

export async function fetchGitWorkingTree(bookRef: BookRef): Promise<{
    isDirty: boolean; stagedCount: number; unstagedCount: number; untrackedCount: number; entries: GitWorkingTreeEntry[];
}> {
    const r = await invokeApi<{
        status: string; book_id: string; is_dirty: boolean; staged_count: number; unstaged_count: number; untracked_count: number; entries: Array<{ path: string; staged: boolean; unstaged: boolean; is_untracked: boolean; index_status: string; worktree_status: string }>;
    }>('git_working_tree', bookRefToArgs(bookRef));
    return { isDirty: r.is_dirty, stagedCount: r.staged_count, unstagedCount: r.unstaged_count, untrackedCount: r.untracked_count, entries: r.entries.map(e => ({ path: e.path, previousPath: null, indexStatus: e.index_status, worktreeStatus: e.worktree_status, staged: e.staged, unstaged: e.unstaged, isUntracked: e.is_untracked })) };
}

export async function fetchGitCommitFiles(bookRef: BookRef, commitId: string): Promise<GitCommitFile[]> {
    const r = await invokeApi<{ status: string; book_id: string; commit_id: string; files: Array<{ path: string; status: string }> }>(
        'git_commit_files', { ...bookRefToArgs(bookRef), commitId }
    );
    return r.files.map(f => ({ path: f.path, previousPath: null, status: f.status }));
}

export async function fetchGitFileView(bookRef: BookRef, filePath: string, _ref?: string): Promise<GitFilePayload> {
    const data = await invokeApi<{ status: string; book_id: string; file_name: string; content: string; etag: string; exists: boolean; size_chars: number }>(
        'get_file', { ...bookRefToArgs(bookRef), fileName: filePath }
    );
    return { path: filePath, source: 'rust', content: data.content };
}

export async function mergeGitBranch(bookRef: BookRef, payload: { sourceBranch: string; noFf?: boolean; message?: string }) {
    const r = await invokeApi<{ status: string; book_id: string; current_branch: string; source_branch: string; commit_id: string }>(
        'git_merge', { ...bookRefToArgs(bookRef), sourceBranch: payload.sourceBranch, message: payload.message }
    );
    return { status: 'success', book_id: r.book_id, merge_type: 'merge_commit', source_branch: r.source_branch, commit_id: r.commit_id, current_branch: r.current_branch };
}
export async function renameGitBranch(bookRef: BookRef, payload: { oldName: string; newName: string }) {
    const r = await invokeApi<{ status: string; book_id: string; old_name: string; new_name: string }>(
        'git_rename_branch', { ...bookRefToArgs(bookRef), oldName: payload.oldName, newName: payload.newName }
    );
    return { status: 'success', book_id: r.book_id, current_branch: 'main', head_commit: '', old_name: r.old_name, new_name: r.new_name, mainline_branch: 'main' };
}
export async function hardRollbackGitBranch(bookRef: BookRef, payload: { targetCommit: string; deleteOtherBranches?: boolean }) {
    const r = await invokeApi<{ status: string; book_id: string; target_commit: string }>(
        'git_hard_rollback', { ...bookRefToArgs(bookRef), targetCommit: payload.targetCommit }
    );
    return { status: 'success', book_id: r.book_id, current_branch: 'main', head_commit: '', target_commit: r.target_commit, delete_other_branches: false, deleted_branches: [], skipped_branches: [] };
}
export async function stageGitFile(bookRef: BookRef, path: string): Promise<void> {
    await invokeApi('git_stage', { ...bookRefToArgs(bookRef), path });
}
export async function unstageGitFile(bookRef: BookRef, path: string): Promise<void> {
    await invokeApi('git_unstage', { ...bookRefToArgs(bookRef), path });
}
export async function stageAllGitFiles(bookRef: BookRef): Promise<void> {
    await invokeApi('git_stage_all', bookRefToArgs(bookRef));
}
export async function commitGitStagedFiles(bookRef: BookRef, message: string) {
    const r = await invokeApi<{ status: string; commit_id: string; current_branch: string }>(
        'git_commit_staged', { ...bookRefToArgs(bookRef), message });
    return { status: 'success', commit_id: r.commit_id, current_branch: r.current_branch, files: [] as string[] };
}
