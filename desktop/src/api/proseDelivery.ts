import { fetchApi } from './client';

export interface ProseChapterSpan {
    number: number;
    title: string;
    heading: string;
    heading_line: number;
    content_start_line: number;
    end_line: number;
    review_status: 'pending' | 'passed' | 'problem' | string;
    author_status: 'pending' | 'rewrite_requested' | string;
}

export interface ProseReviewFinding {
    id: string;
    chapter_number: number | null;
    severity: string;
    status: string;
    message: string;
    suggestion: string;
}

export interface ProseDeliveryState {
    schema_version: number;
    book_id: string;
    draft_branch: string;
    base_branch: string;
    base_commit: string;
    draft_commit: string;
    source_agent: string;
    created_by: string;
    status: string;
    created_at: string;
    updated_at: string;
    draft_package: {
        file: 'chapter_draft.md';
        chapter_count: number;
        chapter_spans: ProseChapterSpan[];
    };
    review_report: {
        status: string;
        decision?: string;
        stale: boolean;
        draft_commit: string;
        source_draft_commit?: string;
        findings: ProseReviewFinding[];
        summary?: string;
        updated_at?: string | null;
        review_is_author_approval?: boolean;
        stale_reason?: string;
    };
    rewrite_requests: Array<{
        id: string;
        finding_id: string;
        chapter_number: number | null;
        status: string;
        instruction: string;
        prior_draft_commit?: string;
        completed_draft_commit?: string;
        completed_at?: string;
        route_agent_key: 'continuation_agent';
    }>;
    manual_edit: {
        dirty: boolean;
        saved: boolean;
        edit_base_commit: string;
        saved_draft_commit: string;
        review_required: boolean;
        saved_at?: string;
    };
    archive_state: {
        eligible: boolean;
        status: string;
        archived_files: string[];
        error: string | null;
        blocked_reason?: string;
        review_gate?: string;
        post_confirm_bridge_status?: string;
    };
    handoff_state: Record<string, unknown>;
}

export interface ProseDeliveryPayload {
    status: 'success';
    book_id: string;
    state: ProseDeliveryState | null;
    staleness: {
        stale: boolean;
        reasons: string[];
        current?: Record<string, unknown> | null;
    };
    draft: {
        file: 'chapter_draft.md';
        branch: string;
        commit_id: string | null;
        content: string;
        etag: string;
    };
    rewrite_request?: {
        id: string;
        finding_id: string;
        chapter_number: number | null;
        status: string;
        instruction: string;
        route_agent_key: 'continuation_agent';
    };
}

export interface ProseReviewReportPayload {
    summary?: string;
    decision?: 'passed' | 'author_fix' | 'rewrite_required';
    source_draft_commit?: string;
    review_is_author_approval?: boolean;
    findings?: Array<Partial<ProseReviewFinding>>;
}

function getQueryParam(bookRef: { kind: 'book_name' | 'book_id'; value: string }): string {
    return bookRef.kind === 'book_name'
        ? `book_name=${encodeURIComponent(bookRef.value)}`
        : `book_id=${encodeURIComponent(bookRef.value)}`;
}

export async function fetchProseDeliveryState(
    bookRef: { kind: 'book_name' | 'book_id'; value: string },
): Promise<ProseDeliveryPayload> {
    return fetchApi<ProseDeliveryPayload>(`/api/prose_delivery/state?${getQueryParam(bookRef)}`);
}

export async function refreshProseDeliveryState(
    bookRef: { kind: 'book_name' | 'book_id'; value: string },
): Promise<ProseDeliveryPayload> {
    return fetchApi<ProseDeliveryPayload>(`/api/prose_delivery/refresh?${getQueryParam(bookRef)}`, {
        method: 'POST',
    });
}

export async function manualSaveProseDraft(
    bookRef: { kind: 'book_name' | 'book_id'; value: string },
    payload: { content: string; base_etag?: string },
): Promise<ProseDeliveryPayload> {
    return fetchApi<ProseDeliveryPayload>(`/api/prose_delivery/manual_save?${getQueryParam(bookRef)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function attachProseReviewReport(
    bookRef: { kind: 'book_name' | 'book_id'; value: string },
    payload: ProseReviewReportPayload,
): Promise<ProseDeliveryPayload> {
    return fetchApi<ProseDeliveryPayload>(`/api/prose_delivery/review_report?${getQueryParam(bookRef)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function requestProseRewrite(
    bookRef: { kind: 'book_name' | 'book_id'; value: string },
    payload: { finding_id: string; instruction?: string },
): Promise<ProseDeliveryPayload> {
    return fetchApi<ProseDeliveryPayload>(`/api/prose_delivery/rewrite_request?${getQueryParam(bookRef)}`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
