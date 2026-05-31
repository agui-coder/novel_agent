import { ApiError, invokeApi, bookRefToArgs, BookRef } from './client';
import { AgentKey, CoreSessionState } from '../types/store';

export type DeductionWriteScope = 'generic' | 'world_core' | 'active_file_strict';

export interface DeductionPayload {
    intent: string;
    active_file: string;
    file_type: CoreSessionState['activeFileType'];
    write_scope?: DeductionWriteScope;
    base_etag: string;
    thread_id?: string;
    conversation_id?: string;
    upstream_conversation_id?: string;
    rewrite_user_message_id?: string;
    target_draft_commit?: string;
    route_agent_key?: string;
    detached_job?: boolean;
    dify_user?: string;
    chapter_index: number;
}

export interface DeductionResponse {
    status: 'success';
    file_name: string;
    content: string;
    etag: string;
    branch: string;
    commit_id?: string;
    conversation_id?: string;
    answer?: string;
}

export interface DeductionStreamHandlers {
    onAck?: (payload: any) => void;
    onStage?: (payload: any) => void;
    onReasoning?: (payload: any) => void;
    onPreview?: (payload: any) => void;
    onDelta?: (delta: string, payload: any) => void;
    onDraftReady?: (payload: any) => void;
    onGitSyncSuccess?: (payload: any) => void;
    onDone?: (payload: any) => void;
    onError?: (payload: any) => void;
}

function looksLikeWorldInitIntent(intent: string): boolean {
    const normalized = intent.trim().toLowerCase();
    if (!normalized) return false;
    return ['初始化', 'init', 'bootstrap', '双写', '双核心', '双底座'].some((token) =>
        normalized.includes(token)
    );
}

export async function stopDeductionStream(
    _bookRef: CoreSessionState['bookRef'],
    _activeFile: string,
    taskId: string,
): Promise<{ status: 'success'; task_id: string; result: string }> {
    await invokeApi('stop_generation', { taskId });
    return { status: 'success', task_id: taskId, result: 'success' };
}

export async function runDeduction(
    intent: string,
    state: CoreSessionState,
    _options?: { rewriteUserMessageId?: string }
): Promise<{ draftContent: string; commitId: string | null; conversationId: string | null }> {
    const result = await invokeApi<{ taskId: string; answer: string }>('deduce_blocking', {
        ...bookRefToArgs(state.bookRef),
        activeFile: state.activeFile,
        intent,
        fileType: state.activeFileType,
    });
    return {
        draftContent: result.answer,
        commitId: null,
        conversationId: null,
    };
}

export async function runDeductionStream(
    intent: string,
    state: CoreSessionState,
    handlers: DeductionStreamHandlers,
    options?: {
        signal?: AbortSignal;
        rewriteUserMessageId?: string;
        routeAgentKey?: AgentKey;
        activeFile?: string;
        fileType?: CoreSessionState['activeFileType'];
        writeScope?: DeductionWriteScope;
        baseEtag?: string;
        detachedJob?: boolean;
        difyUser?: string;
        targetDraftCommit?: string | null;
    }
): Promise<void> {
    const routedAgent = options?.routeAgentKey || state.activeAgent;
    const routedThreadId = options?.detachedJob
        ? undefined
        : (state.conversationByAgent[routedAgent] || state.conversationId || undefined);
    const frontendToBackendAgentKey: Record<string, string> = {
        world_agent: 'world_model',
        outline_agent: 'outline',
        style_agent: 'style_guide',
        continuation_agent: 'continuation_agent',
        review_agent: 'review_agent',
    };
    const resolvedAgentKey = options?.routeAgentKey || state.activeAgent;
    const backendRouteKey = frontendToBackendAgentKey[resolvedAgentKey] || resolvedAgentKey;
    const payload: DeductionPayload = {
        intent,
        active_file: options?.activeFile || state.activeFile,
        file_type: options?.fileType || state.activeFileType,
        base_etag: options?.baseEtag ?? state.baseEtag,
        thread_id: routedThreadId,
        chapter_index: 0,
    };
    if (options?.detachedJob) {
        payload.detached_job = true;
    }
    if (options?.difyUser) {
        payload.dify_user = options.difyUser;
    }
    const payloadActiveFile = payload.active_file;
    const shouldUseWorldCoreScope =
        backendRouteKey === 'world_model' &&
        payloadActiveFile === 'world_model.md' &&
        looksLikeWorldInitIntent(intent);
    if (options?.writeScope) {
        payload.write_scope = options.writeScope;
    } else if (shouldUseWorldCoreScope) {
        payload.write_scope = 'world_core';
    } else if (options?.routeAgentKey !== 'review_agent') {
        payload.write_scope = 'active_file_strict';
    }
    payload.route_agent_key = backendRouteKey;
    const isolatedConversationId = options?.detachedJob
        ? null
        : (state.upstreamConversationByAgent[routedAgent] || state.upstreamConversationId);
    if (isolatedConversationId) {
        payload.upstream_conversation_id = isolatedConversationId;
        payload.conversation_id = isolatedConversationId;
    }
    if (options?.rewriteUserMessageId) {
        payload.rewrite_user_message_id = options.rewriteUserMessageId;
    }
    if (options?.targetDraftCommit) {
        payload.target_draft_commit = options.targetDraftCommit;
    }

    // Tauri: invoke returns immediately with taskId, events stream via listener
    const { listen } = await import('@tauri-apps/api/event');
    const { taskId } = await invokeApi<{ taskId: string }>('deduce_stream', {
        ...bookRefToArgs(state.bookRef),
        activeFile: payload.active_file,
        intent: payload.intent,
        fileType: payload.file_type,
    });

    await new Promise<void>((resolve, reject) => {
        const unlisten = listen<{ event: string; data?: any }>('deduce:event', (e) => {
            const d = e.payload.data || {};
            switch (e.payload.event) {
                case 'ack': handlers.onAck?.(d); break;
                case 'stage': handlers.onStage?.(d); break;
                case 'delta':
                    handlers.onDelta?.(typeof d.text === 'string' ? d.text : '', d);
                    break;
                case 'draft_ready': handlers.onDraftReady?.(d); break;
                case 'done':
                    handlers.onDone?.(d);
                    unlisten.then(fn => fn());
                    resolve();
                    break;
                case 'error':
                    handlers.onError?.(d);
                    unlisten.then(fn => fn());
                    reject(new ApiError(500, 'STREAM_ERROR', d.message || 'stream failed'));
                    break;
            }
        });
    });
}

export interface BatchInitHandlers {
    onAck?: (payload: { total_batches: number; book_id: string; force_rebuild?: boolean }) => void;
    onProgress?: (payload: { batch_index: number; total: number; title: string; status: string }) => void;
    onBatchDone?: (payload: { batch_index: number; total: number; title: string }) => void;
    onBatchError?: (payload: { batch_index: number; title: string; error: string }) => void;
    onDone?: (payload: { completed: number; failed: number; skipped?: boolean; status_card_committed?: boolean; force_rebuild?: boolean }) => void;
    onError?: (payload: { message: string }) => void;
}

export async function runBatchInit(
    bookRef: CoreSessionState['bookRef'],
    handlers: BatchInitHandlers,
    options?: { signal?: AbortSignal; forceRebuild?: boolean }
): Promise<void> {
    const force = options?.forceRebuild === true;
    const { listen } = await import('@tauri-apps/api/event');
    let batchIdx = 0;
    let completed = 0;
    let failed = 0;

    const unlisten = await listen<{ event: string; data: any }>('pipeline:event', (e) => {
        const d = e.payload.data || {};
        switch (e.payload.event) {
            case 'ack':
                handlers.onAck?.({ total_batches: force ? 1 : 2, book_id: bookRef.value });
                break;
            case 'progress':
                handlers.onProgress?.({ batch_index: batchIdx, total: force ? 1 : 2, title: d.title || d.pipeline, status: 'running' });
                break;
            case 'done':
                completed++;
                handlers.onBatchDone?.({ batch_index: batchIdx, total: force ? 1 : 2, title: d.pipeline });
                batchIdx++;
                if (completed + failed >= (force ? 1 : 2)) {
                    handlers.onDone?.({ completed, failed });
                    unlisten();
                }
                break;
            case 'error':
                failed++;
                handlers.onBatchError?.({ batch_index: batchIdx, title: d.pipeline || '', error: d.message });
                batchIdx++;
                if (completed + failed >= (force ? 1 : 2)) {
                    handlers.onDone?.({ completed, failed });
                    unlisten();
                }
                break;
        }
    });

    // Fire pipeline requests in background
    await invokeApi('run_pipeline', { ...bookRefToArgs(bookRef), pipeline: 'summary' });
    if (!force) {
        await invokeApi('run_pipeline', { ...bookRefToArgs(bookRef), pipeline: 'world' });
    }
}

export interface StyleInitHandlers {
    onAck?: (payload: { total_steps: number; book_id: string; force_rebuild?: boolean; artifacts?: string[] }) => void;
    onProgress?: (payload: { step_index: number; total: number; title: string; status: string }) => void;
    onDone?: (payload: {
        completed: number;
        failed: number;
        skipped?: boolean;
        force_rebuild?: boolean;
        artifacts?: string[];
        updated_artifacts?: string[];
        commit_id?: string | null;
        warnings?: string[];
        source_files?: string[];
    }) => void;
    onError?: (payload: { message: string; artifact?: string }) => void;
}

export async function runStyleInit(
    bookRef: CoreSessionState['bookRef'],
    handlers: StyleInitHandlers,
    options?: { signal?: AbortSignal; forceRebuild?: boolean; sourceCount?: number }
): Promise<void> {
    const artifacts = ['style_fingerprint.md', 'style_review.md', 'style_constraints_for_continuation.md'];
    const { listen } = await import('@tauri-apps/api/event');

    const unlisten = await listen<{ event: string; data: any }>('style:event', (e) => {
        const d = e.payload.data || {};
        switch (e.payload.event) {
            case 'ack': handlers.onAck?.({ total_steps: d.total_steps || 5, book_id: d.book_id, artifacts: d.artifacts }); break;
            case 'progress': handlers.onProgress?.({ step_index: d.step_index || 0, total: d.total || 5, title: d.title || '', status: d.status }); break;
            case 'done': handlers.onDone?.({ completed: d.completed || 0, failed: d.failed || 0, skipped: d.skipped, artifacts: d.artifacts }); unlisten(); break;
            case 'error': handlers.onError?.({ message: d.message, artifact: d.artifact }); unlisten(); break;
        }
    });

    await invokeApi('style_init', {
        ...bookRefToArgs(bookRef),
        forceRebuild: options?.forceRebuild ?? false,
        sourceCount: options?.sourceCount ?? 12,
    });
}

export interface RollingWorkbenchState {
    status: 'ready';
    requiresPrompt: false;
    executionKind: 'direct_job';
    default_batch_size: number;
    batch_size: number;
    next_action: string;
    stop_reason: string;
    written_chapter_numbers: number[];
    pending_card_numbers: number[];
    selected_card_numbers: number[];
    blocked_card_numbers: number[];
    outline_card_states: Array<{
        number: number;
        title: string;
        status: 'selected' | 'pending' | 'blocked' | 'written' | 'ignored';
        executable: boolean;
        missing_fields: string[];
        heading_line: number;
        end_line: number;
    }>;
    outline_diagnostics: {
        outline_card_count: number;
        executable_card_count: number;
        detected_but_unparsed: boolean;
        message: string;
    };
    remaining_executable_after_selected: number[];
    full_batch_available: boolean;
    replenishment_needed_after_selected_batch: boolean;
    review_gate_open: boolean;
    quality_gate_locked: boolean;
    quality_gate_unlocked: boolean;
    source_files: {
        chapter_outline: { file_name: string; exists: boolean; size: number };
        chapter_draft: { file_name: string; exists: boolean; size: number };
    };
    no_prose_boundary: {
        state_contains_generated_prose: boolean;
        state_mutates_chapter_outline: boolean;
        state_writes_chapter_draft: boolean;
        continuation_agent_remains_only_chapter_draft_writer: boolean;
    };
}

export interface RollingStateResponse {
    status: 'success';
    book_id: string;
    generated_at: string;
    workbench_state: RollingWorkbenchState;
    plan: any;
}

export interface RollingAuthorWritingBrief {
    schema_version: number;
    brief_type: 'rolling_author_writing_brief';
    generated_at: string;
    book_id: string;
    target_file: 'chapter_draft.md';
    route_agent_key: 'continuation_agent';
    batch: {
        batch_size: number;
        selected_card_numbers: number[];
        full_batch_available: boolean;
        remaining_executable_after_selected: number[];
    };
    progress_cursor: {
        accepted_chapter_numbers: number[];
        pending_review_chapter_numbers: number[];
        pending_card_numbers: number[];
        next_action: string;
        stop_reason: string;
    };
    chapter_cards: Array<{
        number: number;
        title: string;
        goal: string;
        entry_scene: string;
        conflict: string;
        payoff: string;
        state_change: string;
        hook: string;
        constraint_refs: string;
        evidence_mode: string;
    }>;
    writing_contract: {
        what_to_write: string;
        where_to_write: string;
        what_not_to_do: string[];
    };
    truth_sources: Array<{
        name: string;
        path: string;
        role: string;
        exists: boolean;
        contains_prose: boolean;
    }>;
    quality_and_style: {
        quality_gate_locked: boolean;
        quality_gate_blocks_next_action: boolean;
        quality_gate_summary: Record<string, unknown>;
        style_advisory_active: boolean;
        style_is_reference_only: boolean;
        style_summary: Record<string, unknown>;
        repair_goals: Record<string, unknown>;
    };
    no_prose_boundary: {
        brief_contains_generated_prose: boolean;
        brief_reads_chapter_draft_text: boolean;
        brief_writes_files: boolean;
        continuation_agent_remains_only_chapter_draft_writer: boolean;
    };
}

export interface RollingContinuationPayloadResponse {
    status: 'success';
    book_id: string;
    generated_at: string;
    chapter_number: number;
    target_file: 'chapter_draft.md';
    route_agent_key: 'continuation_agent';
    file_type: 'chapter';
    write_scope: 'active_file_strict';
    dify_user: string;
    intent: string;
    workbench_state: RollingWorkbenchState;
    chapter_context_pack: any;
    author_writing_brief: RollingAuthorWritingBrief;
    no_prose_boundary: {
        payload_contains_generated_prose: boolean;
        payload_writes_chapter_draft: boolean;
        continuation_agent_remains_only_chapter_draft_writer: boolean;
    };
    plan: any;
}

export interface RollingOutlineHandoffPayloadResponse {
    status: 'success';
    book_id: string;
    generated_at: string;
    mode: 'replenish';
    target_file: 'chapter_outline.md';
    route_agent_key: 'outline_agent';
    file_type: 'outline';
    write_scope: 'active_file_strict';
    dify_user: string;
    intent: string;
    workbench_state: RollingWorkbenchState;
    outline_handoff_brief: any;
    no_prose_boundary: {
        payload_contains_generated_prose: boolean;
        payload_mutates_chapter_outline: boolean;
        payload_writes_chapter_draft: boolean;
        outline_agent_owns_reviewable_outline_edits: boolean;
        continuation_agent_remains_only_chapter_draft_writer: boolean;
    };
    plan: any;
}

export async function fetchRollingWorkbenchState(
    _bookRef: CoreSessionState['bookRef'],
    _options?: { batchSize?: number; reviewGate?: 'open' | 'closed' }
): Promise<RollingStateResponse> {
    return {
        status: 'success', book_id: '', generated_at: '',
        workbench_state: {
            status: 'ready', requiresPrompt: false, executionKind: 'direct_job',
            default_batch_size: 3, batch_size: 3, next_action: 'read_chapter_outline',
            stop_reason: 'no_state',
            written_chapter_numbers: [], pending_card_numbers: [], selected_card_numbers: [],
            blocked_card_numbers: [],
            outline_card_states: [], outline_diagnostics: { outline_card_count: 0, executable_card_count: 0, detected_but_unparsed: false, message: '' },
            remaining_executable_after_selected: [], full_batch_available: false, replenishment_needed_after_selected_batch: false,
            review_gate_open: true, quality_gate_locked: false, quality_gate_unlocked: true,
            source_files: { chapter_outline: { file_name: 'chapter_outline.md', exists: true, size: 0 }, chapter_draft: { file_name: 'chapter_draft.md', exists: true, size: 0 } },
            no_prose_boundary: { state_contains_generated_prose: false, state_mutates_chapter_outline: false, state_writes_chapter_draft: false, continuation_agent_remains_only_chapter_draft_writer: true },
        },
        plan: {},
    };
}

export async function buildRollingContinuationPayload(
    _bookRef: CoreSessionState['bookRef'],
    _options?: { batchSize?: number; reviewGate?: 'open' | 'closed' }
): Promise<RollingContinuationPayloadResponse> {
    return {
        status: 'success', book_id: '', generated_at: '', chapter_number: 1,
        target_file: 'chapter_draft.md', route_agent_key: 'continuation_agent',
        file_type: 'chapter', write_scope: 'active_file_strict', dify_user: '',
        intent: '续写下一章', workbench_state: {} as any, chapter_context_pack: {},
        author_writing_brief: {} as any, no_prose_boundary: {} as any, plan: {},
    };
}

export async function buildRollingOutlineHandoffPayload(
    _bookRef: CoreSessionState['bookRef'],
    _options?: { batchSize?: number; reviewGate?: 'open' | 'closed' }
): Promise<RollingOutlineHandoffPayloadResponse> {
    return {
        status: 'success', book_id: '', generated_at: '', mode: 'replenish',
        target_file: 'chapter_outline.md', route_agent_key: 'outline_agent',
        file_type: 'outline', write_scope: 'active_file_strict', dify_user: '',
        intent: '补充下一批章节卡', workbench_state: {} as any,
        outline_handoff_brief: {}, no_prose_boundary: {} as any, plan: {},
    };
}
