import { useCallback, useRef, useState } from "react";
import { useAppStore } from "../store";
import { fetchHotFiles, fetchMainlineFile } from "../api/checkout";
import { runDeductionStream, stopDeductionStream } from "../api/orchestration";
import { createConversation } from "../api/session";
import { ApiError } from "../api/client";
import { resolveFileType } from "../lib/fileType";
import { findLatestUserMessage } from "../lib/tailRewrite.js";
import { isTargetPathForbidden, extractReqIdFromErrorMessage, formatVisibleDeductionError } from "../lib/errorUtils";
import { mapConversationMessages, normalizeChangedFilesPayload } from "../lib/conversationUtils";
import { MAX_SUPPRESSED_DEBUG_LOGS, shouldSuppressBackendError, type SuppressedBackendErrorLog } from "../lib/errorSuppression";
import { isSameConversationScope } from "../lib/conversationScope";
import { REASONING_FLUSH_DELAY_MS } from "../lib/textCompact";
import { buildOutlineLandingIntent } from "../lib/outlineLanding";
import type { AgentKey, ChatMessage, HotFileItem, MessageScope, ReasoningTrace, RepoIntegrity } from "../types/store";
import type { OutlineLandingTargetFile } from "../components/ChatMessageBubble";
import type { MutableRefObject } from "react";

export interface ChatStreamLateDeps {
    loadReviewTargetMainline: (file: string) => Promise<void>;
    loadGitWorkbench: () => Promise<void>;
    loadConversationContext: (agentOverride?: AgentKey, conversationIdOverride?: string | null) => Promise<void>;
    hasPendingDraftDecision: boolean;
}

export interface UseChatStreamDeps {
    store: ReturnType<typeof useAppStore.getState>;
    repoIntegrity: RepoIntegrity | null;
    setRepoIntegrity: (v: RepoIntegrity | null) => void;
    loadMainline: (file?: string, opts?: { preserveDraftReview?: boolean }) => Promise<void>;
    setRewriteUserMessageId: (v: string | null) => void;
    setCommandInput: (v: string) => void;
    rewriteUserMessageId: string | null;
    commandInput: string;
    lateRef: MutableRefObject<ChatStreamLateDeps>;
}

export function useChatStream(deps: UseChatStreamDeps) {
    const { store, repoIntegrity, setRepoIntegrity, loadMainline, setRewriteUserMessageId, setCommandInput, rewriteUserMessageId, commandInput, lateRef } = deps;

    const [suppressedBackendErrors, setSuppressedBackendErrors] = useState<SuppressedBackendErrorLog[]>([]);
    const [suppressedDebugOpen, setSuppressedDebugOpen] = useState(false);

    const streamAbortControllerRef = useRef<AbortController | null>(null);
    const streamStableUpstreamConversationIdRef = useRef<string | null>(null);
    const streamTaskIdRef = useRef<string | null>(null);

    const appendSuppressedBackendError = useCallback((code: string, message: string) => {
        const reqId = extractReqIdFromErrorMessage(message);
        setSuppressedBackendErrors((prev) => {
            const isDuplicate = prev.some((item) =>
                reqId
                    ? (item.reqId === reqId && item.code === code)
                    : (item.code === code && item.message === message)
            );
            if (isDuplicate) return prev;
            const nextEntry: SuppressedBackendErrorLog = {
                id: `supp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                ts: Date.now(),
                code,
                message,
                reqId,
            };
            return [...prev, nextEntry].slice(-MAX_SUPPRESSED_DEBUG_LOGS);
        });
    }, []);

    const getLatestUserMessage = useCallback((agent?: AgentKey, activeFile?: string) => {
        const targetAgent = agent || store.activeAgent;
        const targetFile = activeFile || store.activeFile;
        const messages = targetAgent === store.activeAgent
            ? store.chatMessages
            : (store.chatMessagesByAgent[targetAgent] ?? []);
        return findLatestUserMessage(messages.filter((message) => {
            if (!message.activeFile) return true;
            return isSameConversationScope(
                message.activeFile,
                resolveFileType(message.activeFile),
                targetFile,
                resolveFileType(targetFile),
                targetAgent,
            );
        }));
    }, [store.activeAgent, store.activeFile, store.chatMessages, store.chatMessagesByAgent]);

    const handleStopStream = useCallback(async () => {
        const taskId = streamTaskIdRef.current;
        streamAbortControllerRef.current?.abort();
        if (taskId) {
            void stopDeductionStream(store.bookRef, store.activeFile, taskId).catch((err) => {
                console.warn('Native stop failed after local abort fallback:', err);
            });
        }
    }, [store.activeFile, store.bookRef]);

    const handleIntentSubmit = async (
        intent: string,
        options?: {
            rewriteUserMessageId?: string;
            routeAgentKey?: AgentKey;
            activeFile?: string;
            fileType?: HotFileItem['fileType'];
            baseEtag?: string;
            onAccepted?: () => void;
            targetDraftCommit?: string | null;
        }
    ) => {
        const batchInitKeywords = ['初始化', '批量初始化', '全量初始化', '重建', '重跑', '完整重跑', 'batch init', 'rebuild'];
        const isBatchInit = batchInitKeywords.some(kw => intent.includes(kw));
        const isWorldInitSurface = store.activeFile === 'world_model.md'
            || store.activeFile === 'status_card.md'
            || store.activeFile === 'domain_rules.md'
            || store.activeFileType === 'world_core';
        const isStyleInitSurface = store.activeFile === 'style_guide.md'
            || store.activeFile === 'style_fingerprint.md'
            || store.activeFile === 'style_review.md'
            || store.activeFile === 'style_constraints_for_continuation.md'
            || store.activeFileType === 'style';
        if (isBatchInit && (isWorldInitSurface || isStyleInitSurface) && !options?.rewriteUserMessageId) {
            const targetLabel = isWorldInitSurface ? '世界模型' : '文风档案';
            options?.onAccepted?.();
            store.setUiNotice({
                type: 'info',
                message: `${targetLabel}初始化/重建属于右下角「动作」面板；聊天助手用于读取、解释、联网核查和按作者讨论做局部修订。`,
                ts: Date.now(),
            });
            return;
        }

        if (repoIntegrity?.needsRepair) {
            store.setUiNotice({
                type: "error",
                message: "仓库核心布局不完整，修复后才能继续 AI 推演。",
                ts: Date.now(),
            });
            return;
        }
        const routeAgentKey = options?.routeAgentKey;
        const scopedAgent = routeAgentKey || store.activeAgent;
        const scopedActiveFile = options?.activeFile || store.activeFile;
        const suppressReviewReadyNotice = scopedActiveFile === 'chapter_draft.md'
            && (scopedAgent === 'continuation_agent' || scopedAgent === 'review_agent');
        const scopedConversationId = store.conversationByAgent[scopedAgent] || (
            scopedAgent === store.activeAgent ? store.conversationId : null
        );
        const scopedUpstreamConversationId = store.upstreamConversationByAgent[scopedAgent] || (
            scopedAgent === store.activeAgent ? store.upstreamConversationId : null
        );
        const messageScope: MessageScope = {
            agent: scopedAgent,
            activeFile: scopedActiveFile,
            conversationId: scopedConversationId,
            upstreamConversationId: scopedUpstreamConversationId,
            targetDraftCommit: options?.targetDraftCommit ?? null,
        };
        const shouldBindConversationToActiveAgent = scopedAgent === store.activeAgent;
        if (!scopedConversationId) {
            try {
                const payload = await createConversation(
                    { kind: store.bookRef.kind, value: store.bookRef.value },
                    scopedAgent,
                    scopedActiveFile,
                );
                store.hydrateAgentConversation(
                    scopedAgent,
                    payload.active_conversation_id || payload.conversation_id || null,
                    payload.upstream_conversation_id || null,
                    mapConversationMessages(payload.messages || []),
                    payload.conversations || [],
                );
                messageScope.conversationId = payload.active_conversation_id || payload.conversation_id || null;
                messageScope.upstreamConversationId = payload.upstream_conversation_id || null;
            } catch (err) {
                console.error('Failed to create implicit conversation before send:', err);
                store.setUiNotice({
                    type: 'error',
                    message: '初始化会话失败',
                    ts: Date.now(),
                });
                return;
            }
        }
        if (options?.rewriteUserMessageId) {
            store.rewriteTailFromUserMessage(options.rewriteUserMessageId, intent, messageScope);
        } else {
            store.pushUserMessage(intent, messageScope);
        }
        setSuppressedBackendErrors([]);
        setSuppressedDebugOpen(false);
        setRewriteUserMessageId(null);
        if (options?.rewriteUserMessageId) {
            setCommandInput('');
        } else {
            options?.onAccepted?.();
        }
        const assistantMessageId = store.startAssistantMessage(messageScope);
        streamStableUpstreamConversationIdRef.current = messageScope.upstreamConversationId ?? null;
        streamTaskIdRef.current = null;
        const abortController = new AbortController();
        streamAbortControllerRef.current = abortController;
        store.setFsmState('THINKING');
        const draftWriteState: {
            writeConfirmed: boolean;
            commitId: string | null;
            syncStatus: string;
            syncMessage: string;
            compatibilityPayloadDetected: boolean;
            reviewTargetFile: string | null;
            changedFiles: string[];
        } = {
            writeConfirmed: false,
            commitId: null,
            syncStatus: '',
            syncMessage: '',
            compatibilityPayloadDetected: false,
            reviewTargetFile: null,
            changedFiles: [],
        };
        let defenseToastShown = false;
        let streamErrorHandled = false;
        const deductionErrorToastKeys = new Set<string>();
        type ReasoningBufferKey = string;
        const reasoningBuffers = new Map<ReasoningBufferKey, {
            trace: ReasoningTrace;
            timer: number | null;
        }>();
        const getReasoningBufferKey = (trace: Pick<ReasoningTrace, 'label' | 'sourceEvent'>): ReasoningBufferKey =>
            `${trace.sourceEvent || ''}\u0000${trace.label}`;
        const flushReasoningBuffer = (key: ReasoningBufferKey) => {
            const buffered = reasoningBuffers.get(key);
            if (!buffered) return;
            if (buffered.timer !== null) {
                window.clearTimeout(buffered.timer);
            }
            reasoningBuffers.delete(key);
            store.appendAssistantReasoning(assistantMessageId, buffered.trace, messageScope);
        };
        const flushReasoningBuffers = () => {
            Array.from(reasoningBuffers.keys()).forEach(flushReasoningBuffer);
        };
        const enqueueReasoningTrace = (trace: ReasoningTrace) => {
            if (!trace.append || trace.status === 'done') {
                flushReasoningBuffers();
                store.appendAssistantReasoning(assistantMessageId, trace, messageScope);
                return;
            }
            const key = getReasoningBufferKey(trace);
            const buffered = reasoningBuffers.get(key);
            if (buffered) {
                buffered.trace = {
                    ...trace,
                    text: `${buffered.trace.text}${trace.text}`,
                    append: true,
                    status: trace.status || buffered.trace.status,
                };
                return;
            }
            const nextBuffered = {
                trace,
                timer: null as number | null,
            };
            nextBuffered.timer = window.setTimeout(() => {
                flushReasoningBuffer(key);
            }, REASONING_FLUSH_DELAY_MS);
            reasoningBuffers.set(key, nextBuffered);
        };
        const maybeShowDefenseToast = (code: string, message: string) => {
            if (defenseToastShown || !isTargetPathForbidden(code, message)) return;
            defenseToastShown = true;
            store.setUiNotice({
                type: 'error',
                message: '系统拦截：AI 试图非法越权修改只读档案（TARGET_PATH_FORBIDDEN）',
                ts: Date.now(),
            });
        };
        const maybeShowDeductionErrorToast = (code: string, message: string) => {
            const reqId = extractReqIdFromErrorMessage(message);
            const dedupeKey = reqId ? `req:${reqId}` : `sig:${code}:${message}`;
            if (deductionErrorToastKeys.has(dedupeKey)) return;
            deductionErrorToastKeys.add(dedupeKey);
            const visibleMessage = formatVisibleDeductionError(code, message);
            store.setUiNotice({
                type: 'error',
                message: `[${code}] ${visibleMessage}`,
                ts: Date.now(),
            });
        };
        try {
            await runDeductionStream(intent, useAppStore.getState(), {
                onAck: (payload) => {
                    const localThreadId = typeof payload?.thread_id === 'string' ? payload.thread_id : null;
                    if (localThreadId && shouldBindConversationToActiveAgent) {
                        store.setConversationId(localThreadId);
                    }
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                },
                onStage: (payload) => {
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    const stageCode = typeof payload?.stage_code === 'string' ? payload.stage_code : 'progress';
                    const stageText = typeof payload?.stage_text === 'string' ? payload.stage_text : '';
                    if (!stageText) return;
                    const sourceEvent = typeof payload?.source_event === 'string' ? payload.source_event : undefined;
                    const nodeTitle = typeof payload?.node_title === 'string' ? payload.node_title : undefined;
                    const nodeType = typeof payload?.node_type === 'string' ? payload.node_type : undefined;
                    store.setAssistantStageProgress(assistantMessageId, {
                        stageCode,
                        stageText,
                        sourceEvent,
                        nodeTitle,
                        nodeType,
                    }, messageScope);
                },
                onReasoning: (payload) => {
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    const text = typeof payload?.text === 'string' ? payload.text : '';
                    if (!text) return;
                    const label = typeof payload?.label === 'string' && payload.label
                        ? payload.label
                        : '已深度思考';
                    const sourceEvent = typeof payload?.source_event === 'string' ? payload.source_event : undefined;
                    const status = payload?.status === 'done' ? 'done' : 'streaming';
                    const append = status === 'streaming' && sourceEvent !== 'scratchpad_compacted';
                    enqueueReasoningTrace({
                        label,
                        text,
                        append,
                        sourceEvent,
                        status,
                    });
                },
                onPreview: (payload) => {
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    const text = typeof payload?.text === 'string' ? payload.text : '';
                    if (!text) return;
                    const label = typeof payload?.label === 'string' && payload.label
                        ? payload.label
                        : '中间预览';
                    const sourceEvent = typeof payload?.source_event === 'string' ? payload.source_event : undefined;
                    store.appendAssistantPreview(assistantMessageId, {
                        label,
                        text,
                        sourceEvent,
                    }, messageScope);
                },
                onDelta: (delta, payload) => {
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    flushReasoningBuffers();
                    store.appendAssistantDelta(assistantMessageId, delta, payload?.upstream_conversation_id || null, messageScope);
                },
                onDraftReady: (payload) => {
                    const draftContent = typeof payload?.content === 'string' ? payload.content : '';
                    const commitId = typeof payload?.commit_id === 'string' ? payload.commit_id : '';
                    const etag = typeof payload?.etag === 'string' ? payload.etag : '';
                    const fileName = typeof payload?.file_name === 'string' ? payload.file_name : store.activeFile;
                    const reviewSurfaceFile = routeAgentKey === 'review_agent' && options?.activeFile === 'chapter_draft.md'
                        ? options.activeFile
                        : fileName;
                    const branch = typeof payload?.branch === 'string' ? payload.branch : store.draftBranch;
                    const diffPreview = typeof payload?.diff_preview === 'string' ? payload.diff_preview : '';
                    const changedFiles = normalizeChangedFilesPayload(payload?.changed_files);
                    const reviewChangedFiles = changedFiles.includes(reviewSurfaceFile)
                        ? changedFiles
                        : [reviewSurfaceFile, ...changedFiles];
                    const draftChanged = payload?.draft_changed === true || changedFiles.length > 0;
                    if (!draftChanged) return;
                    draftWriteState.reviewTargetFile = reviewSurfaceFile;
                    draftWriteState.changedFiles = reviewChangedFiles;
                    store.setSandboxDraft(
                        reviewSurfaceFile === fileName ? draftContent : useAppStore.getState().draftContent,
                        commitId,
                    );
                    store.setReviewTarget(reviewSurfaceFile, reviewChangedFiles);
                    if (reviewSurfaceFile === store.activeFile) {
                        store.setReviewMainlineFact(store.mainlineContent, store.baseEtag);
                    } else {
                        void lateRef.current.loadReviewTargetMainline(reviewSurfaceFile);
                    }
                    store.attachDiffToAssistantMessage(assistantMessageId, {
                        fileName,
                        branch,
                        commitId,
                        etag,
                        content: draftContent,
                        diffPreview,
                    }, messageScope);
                    if (suppressReviewReadyNotice) {
                        store.clearReviewReadyNotice();
                    } else {
                        store.setReviewReadyNotice({
                            fileName: reviewSurfaceFile,
                            branch,
                            commitId: commitId || null,
                            diffPreview,
                            changedFiles: reviewChangedFiles,
                            ts: Date.now(),
                        });
                    }
                    store.setFsmState('REVIEW');
                    store.setWorkbenchMode('review');
                },
                onGitSyncSuccess: (payload) => {
                    draftWriteState.writeConfirmed = true;
                    draftWriteState.commitId = typeof payload?.commit_id === 'string' ? payload.commit_id : null;
                },
                onDone: (payload) => {
                    flushReasoningBuffers();
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    const conversationId = typeof payload?.thread_id === 'string'
                        ? payload.thread_id
                        : (typeof payload?.conversation_id === 'string' ? payload.conversation_id : null);
                    const upstreamConversationId = typeof payload?.upstream_conversation_id === 'string'
                        ? payload.upstream_conversation_id
                        : null;
                    const finalAnswer = typeof payload?.answer === 'string' ? payload.answer : '';
                    const draftChanged = Boolean(payload?.draft_changed);
                    const writeConfirmed = Boolean(payload?.write_confirmed || payload?.git_sync_applied);
                    const syncStatus = typeof payload?.sync_status === 'string' ? payload.sync_status : '';
                    const syncMessage = typeof payload?.sync_message === 'string' ? payload.sync_message : '';
                    const syncCommitId = typeof payload?.sync_commit_id === 'string' ? payload.sync_commit_id : '';
                    const compatibilityPayloadDetected = Boolean(payload?.hidden_payload_detected);
                    const changedFiles = normalizeChangedFilesPayload(payload?.changed_files);
                    const shouldKeepReviewDecisionSurface = routeAgentKey === 'review_agent' && options?.activeFile === 'chapter_draft.md';
                    const shouldEnterReview = draftChanged || changedFiles.length > 0 || shouldKeepReviewDecisionSurface;
                    const forcedReviewTargetFile = routeAgentKey === 'review_agent' && options?.activeFile === 'chapter_draft.md'
                        ? options.activeFile
                        : null;
                    const payloadReviewTargetFile = typeof payload?.review_target_file === 'string' && payload.review_target_file
                        ? payload.review_target_file
                        : null;
                    const reviewTargetFile = shouldEnterReview
                        ? (forcedReviewTargetFile || payloadReviewTargetFile || changedFiles[0] || store.activeFile)
                        : null;
                    const reviewChangedFiles = reviewTargetFile && !changedFiles.includes(reviewTargetFile)
                        ? [reviewTargetFile, ...changedFiles]
                        : changedFiles;
                    const hadDraftReadyEvent = Boolean(draftWriteState.reviewTargetFile);
                    store.finishAssistantMessage(assistantMessageId, conversationId, upstreamConversationId, finalAnswer, messageScope);
                    if (conversationId && shouldBindConversationToActiveAgent) {
                        store.setConversationId(conversationId);
                        store.setUpstreamConversationId(upstreamConversationId);
                        void lateRef.current.loadConversationContext(scopedAgent, conversationId);
                    }
                    draftWriteState.compatibilityPayloadDetected = compatibilityPayloadDetected;
                    draftWriteState.syncStatus = syncStatus;
                    draftWriteState.syncMessage = syncMessage;
                    if (syncCommitId) {
                        draftWriteState.commitId = syncCommitId;
                    }
                    draftWriteState.reviewTargetFile = reviewTargetFile;
                    draftWriteState.changedFiles = shouldEnterReview ? reviewChangedFiles : [];
                    if (writeConfirmed) {
                        draftWriteState.writeConfirmed = true;
                    }
                    if (shouldEnterReview && reviewTargetFile) {
                        store.setReviewTarget(reviewTargetFile, reviewChangedFiles);
                        if (reviewTargetFile === store.activeFile) {
                            store.setReviewMainlineFact(store.mainlineContent, store.baseEtag);
                        } else {
                            void lateRef.current.loadReviewTargetMainline(reviewTargetFile);
                        }
                        if (suppressReviewReadyNotice) {
                            store.clearReviewReadyNotice();
                        } else if (!hadDraftReadyEvent) {
                            store.setReviewReadyNotice({
                                fileName: reviewTargetFile,
                                branch: store.draftBranch,
                                commitId: syncCommitId || draftWriteState.commitId || null,
                                diffPreview: '',
                                changedFiles: reviewChangedFiles,
                                ts: Date.now(),
                            });
                        }
                        store.setFsmState('REVIEW');
                        store.setWorkbenchMode('review');
                    } else {
                        store.setSandboxDraft('', null);
                        store.setReviewTarget(null, []);
                        store.setReviewMainlineFact('', '');
                        store.clearReviewReadyNotice();
                        store.setFsmState('IDLE');
                        store.setWorkbenchMode('editor');
                    }
                },
                onError: (payload) => {
                    flushReasoningBuffers();
                    if (typeof payload?.task_id === 'string' && payload.task_id) {
                        streamTaskIdRef.current = payload.task_id;
                    }
                    const code = typeof payload?.code === 'string' ? payload.code : 'STREAM_ERROR';
                    const message = typeof payload?.message === 'string' ? payload.message : '推演流异常中断';
                    const visibleMessage = formatVisibleDeductionError(code, message);
                    if (shouldSuppressBackendError(code, message)) {
                        appendSuppressedBackendError(code, message);
                        console.warn('[world_deduce] suppressed backend error:', code, message);
                        return;
                    }
                    maybeShowDefenseToast(code, message);
                    maybeShowDeductionErrorToast(code, message);
                    store.failAssistantMessage(assistantMessageId, code, visibleMessage, messageScope);
                    streamErrorHandled = true;
                },
            }, {
                signal: abortController.signal,
                rewriteUserMessageId: options?.rewriteUserMessageId,
                routeAgentKey,
                activeFile: options?.activeFile,
                fileType: options?.fileType,
                baseEtag: options?.baseEtag,
                targetDraftCommit: options?.targetDraftCommit,
            });
            if (draftWriteState.writeConfirmed) {
                const bookRef = { kind: store.bookRef.kind, value: store.bookRef.value };
                const currentFile = store.activeFile;
                const reviewTargetFile = draftWriteState.reviewTargetFile || useAppStore.getState().reviewTargetFile || currentFile;
                const shouldReloadGit = store.workbenchMode === 'git';
                try {
                    const { files, integrity } = await fetchHotFiles(bookRef);
                    setRepoIntegrity(integrity);
                    if (files.length > 0) {
                        store.setHotFiles(files);
                    }
                } catch (err) {
                    console.warn('Failed to refresh hot files after draft write sync:', err);
                }
                await loadMainline(currentFile, { preserveDraftReview: true });
                if (reviewTargetFile === currentFile) {
                    const runtimeState = useAppStore.getState();
                    store.setReviewMainlineFact(runtimeState.mainlineContent, runtimeState.baseEtag);
                } else {
                    await lateRef.current.loadReviewTargetMainline(reviewTargetFile);
                }
                if (shouldReloadGit) {
                    await lateRef.current.loadGitWorkbench();
                }
                const shortCommitId = typeof draftWriteState.commitId === 'string' ? draftWriteState.commitId.slice(0, 8) : '';
                store.setUiNotice({
                    type: 'success',
                    message: shortCommitId
                        ? `草稿写入完成：${shortCommitId}`
                        : '草稿写入完成，审阅工作台已同步。',
                    ts: Date.now(),
                });
            } else if (draftWriteState.compatibilityPayloadDetected && draftWriteState.syncStatus && draftWriteState.syncStatus !== 'success') {
                const syncErrorMessage = draftWriteState.syncMessage || `兼容写入链失败（${draftWriteState.syncStatus}）`;
                maybeShowDeductionErrorToast('DRAFT_SYNC_FAILED', syncErrorMessage);
            }
        } catch (err) {
            flushReasoningBuffers();
            if (err instanceof ApiError && err.code === 'REQUEST_ABORTED') {
                store.interruptAssistantMessage(assistantMessageId, messageScope);
                if (shouldBindConversationToActiveAgent) {
                    store.setUpstreamConversationId(streamStableUpstreamConversationIdRef.current);
                }
                const latestUserMessage = getLatestUserMessage(scopedAgent, scopedActiveFile);
                if (latestUserMessage) {
                    beginRewriteFromMessage(latestUserMessage.id, latestUserMessage.text);
                }
                store.setUiNotice({
                    type: 'info',
                    message: '输出已中止，可直接修改最后一问后重发。',
                    ts: Date.now(),
                });
                store.setFsmState('IDLE');
                return;
            }
            if (err instanceof ApiError && shouldSuppressBackendError(err.code, err.message)) {
                appendSuppressedBackendError(err.code, err.message);
                console.warn('[world_deduce] ignored ApiError after successful write path:', err.code, err.message);
                store.finishAssistantMessage(
                    assistantMessageId,
                    messageScope.conversationId,
                    messageScope.upstreamConversationId,
                    undefined,
                    messageScope,
                );
                store.setFsmState('IDLE');
                return;
            }
            if (err instanceof ApiError && streamErrorHandled) {
                if ([409, 428].includes(err.status) || ['WRITE_CONFLICT', 'PRECONDITION_REQUIRED'].includes(err.code)) {
                    store.setFsmState('CONFLICT');
                } else {
                    store.setFsmState('IDLE');
                }
                return;
            }
            if (err instanceof ApiError && ([409, 428].includes(err.status) || ['WRITE_CONFLICT', 'PRECONDITION_REQUIRED'].includes(err.code))) {
                store.setFsmState('CONFLICT');
                maybeShowDeductionErrorToast(err.code, err.message);
                store.failAssistantMessage(assistantMessageId, err.code, formatVisibleDeductionError(err.code, err.message), messageScope);
            } else {
                console.error('Deduction failed:', err);
                if (err instanceof ApiError) {
                    maybeShowDefenseToast(err.code, err.message);
                    maybeShowDeductionErrorToast(err.code, err.message);
                    store.failAssistantMessage(assistantMessageId, err.code, formatVisibleDeductionError(err.code, err.message), messageScope);
                } else {
                    maybeShowDeductionErrorToast('UNKNOWN_ERROR', '推演失败');
                    store.failAssistantMessage(assistantMessageId, 'UNKNOWN_ERROR', '推演失败', messageScope);
                }
                store.setFsmState('IDLE');
            }
        } finally {
            flushReasoningBuffers();
            streamTaskIdRef.current = null;
            if (streamAbortControllerRef.current === abortController) {
                streamAbortControllerRef.current = null;
            }
        }
    };

    const handleCommandSubmit = async (intent: string, clearComposer?: () => void) => {
        await handleIntentSubmit(
            intent,
            rewriteUserMessageId
                ? { rewriteUserMessageId }
                : clearComposer
                    ? { onAccepted: clearComposer }
                    : undefined,
        );
    };

    const handleOutlineLandingFromMessage = useCallback((message: ChatMessage, targetFile: OutlineLandingTargetFile) => {
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({
                type: 'info',
                message: '大纲助手正在输出，等这一轮结束后再落档。',
                ts: Date.now(),
            });
            return;
        }
        if (store.fsmState === 'REVIEW' || store.fsmState === 'CONFLICT' || lateRef.current.hasPendingDraftDecision) {
            store.setWorkbenchMode('review');
            store.setUiNotice({
                type: 'info',
                message: '当前已有待审草稿，请先确权或回滚，再把新的大纲想法落档。',
                ts: Date.now(),
            });
            return;
        }
        const intent = buildOutlineLandingIntent(message, targetFile);
        void handleIntentSubmit(intent, {
            routeAgentKey: 'outline_agent',
            activeFile: targetFile,
            fileType: 'outline',
            baseEtag: '',
        });
    }, [lateRef.current.hasPendingDraftDecision, store]);

    const beginRewriteFromMessage = useCallback((messageId: string, text: string) => {
        setRewriteUserMessageId(messageId);
        setCommandInput(text);
    }, []);

    const handleCancelRewrite = useCallback(() => {
        setRewriteUserMessageId(null);
        setCommandInput('');
    }, []);

    const handleInlineRewriteSubmit = useCallback(async () => {
        if (!commandInput.trim()) return;
        await handleCommandSubmit(commandInput);
    }, [commandInput]);

    return {
        suppressedBackendErrors,
        setSuppressedBackendErrors,
        suppressedDebugOpen,
        setSuppressedDebugOpen,
        appendSuppressedBackendError,
        getLatestUserMessage,
        handleStopStream,
        handleIntentSubmit,
        handleCommandSubmit,
        handleOutlineLandingFromMessage,
        beginRewriteFromMessage,
        handleCancelRewrite,
        handleInlineRewriteSubmit,
        streamAbortControllerRef,
        streamTaskIdRef,
        streamStableUpstreamConversationIdRef,
    };
}
