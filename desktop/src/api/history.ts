import { invokeApi, bookRefToArgs, BookRef } from './client';
import { GitGraphCommit } from '../types/store';

export async function fetchGitGraph(bookRef: BookRef): Promise<GitGraphCommit[]> {
    const response = await invokeApi<{
        status: string; book_id: string; commits: Array<{
            commit_id: string; parent_id?: string | null;
            timestamp: number; message: string; author: string;
        }>;
    }>('git_log', { ...bookRefToArgs(bookRef), maxCount: 50 });

    return response.commits.map((row) => ({
        commitId: row.commit_id,
        parentIds: row.parent_id ? [row.parent_id] : [],
        timestamp: new Date(row.timestamp * 1000).toISOString(),
        message: row.message,
        refs: [],
    }));
}
