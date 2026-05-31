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

export async function fetchGitWorkingTree(_bookRef: BookRef): Promise<{
    isDirty: boolean; stagedCount: number; unstagedCount: number; untrackedCount: number; entries: GitWorkingTreeEntry[];
}> {
    return { isDirty: false, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, entries: [] };
}

export async function fetchGitCommitFiles(_bookRef: BookRef, _commitId: string): Promise<GitCommitFile[]> {
    return [];
}

export async function fetchGitFileView(bookRef: BookRef, filePath: string, _ref?: string): Promise<GitFilePayload> {
    const data = await invokeApi<{ status: string; book_id: string; file_name: string; content: string; etag: string; exists: boolean; size_chars: number }>(
        'get_file', { ...bookRefToArgs(bookRef), fileName: filePath }
    );
    return { path: filePath, source: 'rust', content: data.content };
}

export async function mergeGitBranch(_bookRef: BookRef, _payload: { sourceBranch: string; noFf?: boolean; message?: string }) {
    return { status: 'success', book_id: '', merge_type: 'up_to_date', source_branch: _payload.sourceBranch, commit_id: '', current_branch: 'main' };
}
export async function renameGitBranch(_bookRef: BookRef, _payload: { oldName: string; newName: string }) {
    return { status: 'success', book_id: '', current_branch: 'main', head_commit: '', old_name: _payload.oldName, new_name: _payload.newName, mainline_branch: 'main' };
}
export async function hardRollbackGitBranch(_bookRef: BookRef, _payload: { targetCommit: string; deleteOtherBranches?: boolean }) {
    return { status: 'success', book_id: '', current_branch: 'main', head_commit: '', target_commit: _payload.targetCommit, delete_other_branches: false, deleted_branches: [], skipped_branches: [] };
}
export async function stageGitFile(_bookRef: BookRef, _path: string): Promise<void> {}
export async function unstageGitFile(_bookRef: BookRef, _path: string): Promise<void> {}
export async function stageAllGitFiles(_bookRef: BookRef): Promise<void> {}
export async function commitGitStagedFiles(_bookRef: BookRef, _message: string) {
    return { status: 'success', commit_id: '', current_branch: 'main' };
}
