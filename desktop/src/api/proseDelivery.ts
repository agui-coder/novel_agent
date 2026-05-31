import { invokeApi, bookRefToArgs, BookRef } from './client';

export interface ProseChapterSpan {
    number: number; title: string; heading: string; heading_line: number;
    content_start_line: number; end_line: number; review_status: string; author_status: string;
}
export interface ProseReviewFinding {
    id: string; chapter_number: number | null; severity: string; status: string; message: string; suggestion: string;
}
export interface ProseDeliveryState {
    [key: string]: any;
    schema_version: number; book_id: string; draft_branch: string; base_branch: string;
    base_commit: string; draft_commit: string; source_agent: string; created_by: string;
    status: string; created_at: string; updated_at: string;
    draft_package: { file: string; chapter_count: number; chapter_spans: ProseChapterSpan[] };
    review_report: { status: string; decision?: string; stale: boolean; draft_commit: string; source_draft_commit?: string; findings: ProseReviewFinding[]; summary?: string; updated_at?: string | null };
    rewrite_requests: Array<{ id: string; finding_id: string; chapter_number: number | null; status: string; instruction: string; prior_draft_commit?: string; completed_draft_commit?: string; completed_at?: string }>;
    manual_edit: { dirty: boolean; saved: boolean; edit_base_commit: string; saved_draft_commit: string; review_required: boolean; saved_at?: string };
    archive_state: { eligible: boolean; status: string; archived_files: string[]; error: string | null; blocked_reason?: string };
    handoff_state: Record<string, unknown>;
    state?: { status?: string; schema_version?: number; updated_at?: string };
    draft?: { status?: string; decision?: string; summary?: string; etag?: string; commit_id?: string; content?: string };
    staleness?: { state_seconds?: number; is_stale?: boolean; reason?: string; stale?: boolean };
}

const STATE_FILE = 'prose_delivery_state.json';

function emptyState(bookId: string): ProseDeliveryState {
    const now = new Date().toISOString();
    return {
        schema_version: 1, book_id: bookId, draft_branch: 'draft/sandbox', base_branch: 'main',
        base_commit: '', draft_commit: '', source_agent: 'continuation_agent', created_by: 'author',
        status: 'idle', created_at: now, updated_at: now,
        draft_package: { file: 'chapter_draft.md', chapter_count: 0, chapter_spans: [] },
        review_report: { status: 'idle', stale: false, draft_commit: '', findings: [] },
        rewrite_requests: [],
        manual_edit: { dirty: false, saved: false, edit_base_commit: '', saved_draft_commit: '', review_required: false },
        archive_state: { eligible: false, status: 'idle', archived_files: [], error: null },
        handoff_state: {},
    };
}

async function readState(bookRef: BookRef): Promise<ProseDeliveryState> {
    try {
        const data = await invokeApi<{ status: string; content: string; exists: boolean }>('get_file', {
            ...bookRefToArgs(bookRef), fileName: STATE_FILE,
        });
        if (data.exists && data.content) {
            return JSON.parse(data.content);
        }
    } catch { /* file doesn't exist, return empty */ }
    return emptyState(bookRef.value);
}

async function writeState(bookRef: BookRef, state: ProseDeliveryState): Promise<void> {
    state.updated_at = new Date().toISOString();
    // Read current etag first
    let etag = '';
    try {
        const current = await invokeApi<{ etag: string }>('get_file', { ...bookRefToArgs(bookRef), fileName: STATE_FILE });
        etag = current.etag || '';
    } catch { /* ignore */ }
    await invokeApi('update_file', {
        ...bookRefToArgs(bookRef), fileName: STATE_FILE,
        content: JSON.stringify(state, null, 2), baseEtag: etag, origin: 'user',
    });
}

export async function fetchProseDeliveryState(bookRef: BookRef): Promise<ProseDeliveryState> {
    return readState(bookRef);
}

export async function refreshProseDelivery(bookRef: BookRef): Promise<ProseDeliveryState> {
    return readState(bookRef);
}

export async function manualSaveProseDelivery(bookRef: BookRef, state: ProseDeliveryState): Promise<ProseDeliveryState> {
    await writeState(bookRef, state);
    return state;
}

export async function submitReviewReport(bookRef: BookRef, report: ProseDeliveryState['review_report']): Promise<ProseDeliveryState> {
    const state = await readState(bookRef);
    state.review_report = report;
    await writeState(bookRef, state);
    return state;
}

export async function submitRewriteRequest(bookRef: BookRef, requests: ProseDeliveryState['rewrite_requests']): Promise<ProseDeliveryState> {
    const state = await readState(bookRef);
    state.rewrite_requests = requests;
    await writeState(bookRef, state);
    return state;
}

// Backward compatibility aliases
export type ProseDeliveryPayload = ProseDeliveryState;
export const refreshProseDeliveryState = refreshProseDelivery;
export const manualSaveProseDraft = manualSaveProseDelivery;
export const requestProseRewrite = submitRewriteRequest;
export async function attachProseReviewReport(bookRef: BookRef, report: ProseDeliveryState['review_report']): Promise<ProseDeliveryState> {
    return submitReviewReport(bookRef, report);
}
