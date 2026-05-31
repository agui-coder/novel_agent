import { invokeApi, bookRefToArgs, BookRef } from './client';

export interface DraftResponse { status: string; message?: string; }

export interface MaterializedChapter {
    number: number; title: string; file_name: string; status: string;
    heading_line?: number; end_line?: number;
}

export interface PostConfirmArchiveBridge {
    status: string; stage?: string; error?: string;
    steps?: Array<{ name: string; status?: string; commit_id?: string | null;
        updated_files?: string[]; chapter_count?: number; total_batches?: number;
        latest_batch_label?: string; }>;
    summary_result?: { status?: string; commit_id?: string | null;
        updated_files?: string[]; chapter_count?: number; total_batches?: number; };
    status_projection?: { status?: string; commit_id?: string | null;
        updated_files?: string[]; latest_batch_label?: string; };
}

export interface DraftConfirmResponse extends DraftResponse {
    book_id: string; message: string;
    post_confirm_payload?: PostConfirmWorldPayload | null;
    mainline_branch?: string; merged_branch?: string; commit_id?: string;
    draft_branch_deleted?: boolean; materialized_chapters?: MaterializedChapter[];
    post_confirm_archive_bridge?: PostConfirmArchiveBridge | null;
}

export type DraftWriteScope = 'generic' | 'world_core' | 'active_file_strict';

export interface DraftSyncWrite {
    file_name: string; op: 'update' | 'append' | 'prepend';
    content: string; base_etag?: string;
}

export interface DraftSyncAllPayload {
    write_scope?: DraftWriteScope; active_file?: string;
    message?: string; origin?: string; writes: DraftSyncWrite[];
}

export interface PostConfirmWorldPayload {
    status: 'pending'; action: 'post_confirm_world_distill'; route_agent_key: 'world_model';
    active_file: 'status_card.md'; file_type: 'world_core'; write_scope: 'world_core';
    dify_user: string; intent: string; materialized_chapters: Array<{
        number: number; title: string; file_name: string; status: string;
    }>;
    archive_bridge?: PostConfirmArchiveBridge | null;
    required_writes: string[]; optional_writes: string[]; forbidden_writes: string[];
    no_prose_boundary: {
        payload_contains_chapter_prose: boolean;
        world_model_route_must_not_rewrite_prose: boolean;
        review_agent_is_not_responsible: boolean;
        status_card_already_refreshed_by_backend?: boolean;
    };
}

export async function confirmDraft(bookRef: BookRef): Promise<DraftConfirmResponse & { post_confirm_payload?: PostConfirmWorldPayload | null }> {
    const result = await invokeApi<DraftConfirmResponse>('draft_confirm', {
        ...bookRefToArgs(bookRef), fileName: 'chapter_draft.md',
    });
    return result;
}

export async function rollbackDraft(bookRef: BookRef, _commitHash: string): Promise<void> {
    await invokeApi<DraftResponse>('draft_rollback', {
        ...bookRefToArgs(bookRef), fileName: 'chapter_draft.md',
    });
}
