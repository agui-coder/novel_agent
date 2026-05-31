import { useCallback, useEffect, useRef, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { useMemo } from 'react';
import { useAppStore } from './store';
import { useHumanEditMode } from './hooks/useHumanEditMode';
import { useDraftReview } from './hooks/useDraftReview';
import { useGitWorkbench } from './hooks/useGitWorkbench';
import { useAgentSession } from './hooks/useAgentSession';
import { useWorkbenchActions } from './hooks/useWorkbenchActions';
import { AppLayout } from './layouts/AppLayout';
import { OutlineLandingTargetFile } from './components/ChatMessageBubble';
import { ConflictBanner } from './components/ConflictBanner';
import { ToastNotice } from './components/ToastNotice';
import { WorkbenchModeLayer } from './components/WorkbenchModeLayer';
import { GitCenterPanel } from './components/GitCenterPanel';
import { GitWorkingTreePanel } from './components/GitWorkingTreePanel';
import { GitDiffFullscreen } from './components/GitDiffFullscreen';
import { ReviewCanvasPanel } from './components/ReviewCanvasPanel';
import { ReviewDiffFullscreen } from './components/ReviewDiffFullscreen';
import { ReviewInspectorPanel } from './components/ReviewInspectorPanel';
import { ProseDeliveryWorkbench } from './components/ProseDeliveryWorkbench';
import { ReviewReadyNotice } from './components/ReviewReadyNotice';
import { WorkbenchActionDock } from './components/WorkbenchActionDock';

import { fetchHotFiles, fetchMainlineFile, fetchRepoIntegrity, repairBookLayout, updateMainlineFile } from './api/checkout';

import { runDeductionStream, stopDeductionStream } from './api/orchestration';
import { type ProseReviewFinding } from './api/proseDelivery';
import { createConversation } from './api/session';
import { ApiError } from './api/client';
import { DEFAULT_HOT_FILES } from './config/hotFiles';
import { resolveFileType } from './lib/fileType';
import { findLatestUserMessage } from './lib/tailRewrite.js';
import { getAgentLabel, getFileTypeLabel, getFsmStateLabel, getUiCopy } from './i18n/ui';
import { DEFAULT_WORKBENCH_THEME_ID } from './lib/themePresets';
import { AgentKey, ChatMessage, HotFileItem, MessageScope, ReasoningTrace, RepoIntegrity, WorkbenchMode } from './types/store';
import { isTargetPathForbidden, getErrorMessage, isLayoutRepairRequired, extractIntegrityFromError, extractReqIdFromErrorMessage, formatVisibleDeductionError, formatSuppressedBackendErrorTitle } from './lib/errorUtils';
import { mapConversationMessages, normalizeChangedFilesPayload } from './lib/conversationUtils';
import { MAX_SUPPRESSED_DEBUG_LOGS, shouldSuppressBackendError, type SuppressedBackendErrorLog } from './lib/errorSuppression';
import { buildWorkbenchActions } from './lib/workbenchActions';
import { isSameConversationScope } from './lib/conversationScope';
import { REASONING_FLUSH_DELAY_MS } from './lib/textCompact';
import { buildOutlineLandingIntent } from './lib/outlineLanding';
import { TopBar } from './components/TopBar';
import { ActivityBar } from './components/ActivityBar';
import { EditorCenterPanel } from './components/EditorCenterPanel';
import { WorkbenchLeftPanel } from './components/WorkbenchLeftPanel';
import { EditorRightPanel } from './components/EditorRightPanel';
import { GitLockedPanel } from './components/GitLockedPanel';

export default function App() {
    const store = useAppStore();
    const copy = getUiCopy(store.uiLanguage);
    const [editorContent, setEditorContent] = useState('');
    const [editorSaveState, setEditorSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
    // ── Human edit mode (extracted to useHumanEditMode) ──
    const [suppressedBackendErrors, setSuppressedBackendErrors] = useState<SuppressedBackendErrorLog[]>([]);
    const [suppressedDebugOpen, setSuppressedDebugOpen] = useState(false);
    const [bootstrapState, setBootstrapState] = useState<'bootstrapping' | 'loaded'>('bootstrapping');
    const [repoIntegrity, setRepoIntegrity] = useState<RepoIntegrity | null>(null);
    const [mainlineFileState, setMainlineFileState] = useState<{ exists: boolean; virtual: boolean } | null>(null);
    const [repairPending, setRepairPending] = useState(false);
    const [commandInput, setCommandInput] = useState('');
    const [rewriteUserMessageId, setRewriteUserMessageId] = useState<string | null>(null);
    const [reviewTargetLoading, setReviewTargetLoading] = useState(false);
    const saveTicketRef = useRef(0);
    const streamAbortControllerRef = useRef<AbortController | null>(null);
    const streamStableUpstreamConversationIdRef = useRef<string | null>(null);
    const streamTaskIdRef = useRef<string | null>(null);

    useEffect(() => {
        document.documentElement.dataset.workbenchTheme = DEFAULT_WORKBENCH_THEME_ID;
        return () => {
            delete document.documentElement.dataset.workbenchTheme;
        };
    }, []);

    useEffect(() => {
        document.documentElement.lang = store.uiLanguage;
    }, [store.uiLanguage]);

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

    const loadRepoIntegrity = useCallback(async (bookRefOverride?: { kind: 'book_name' | 'book_id'; value: string }) => {
        const bookRef = bookRefOverride ?? { kind: store.bookRef.kind, value: store.bookRef.value };
        if (!bookRef.value) return null;
        try {
            const integrity = await fetchRepoIntegrity(bookRef);
            setRepoIntegrity(integrity);
            return integrity;
        } catch (err) {
            const fallbackIntegrity = extractIntegrityFromError(err);
            if (fallbackIntegrity) {
                setRepoIntegrity(fallbackIntegrity);
                return fallbackIntegrity;
            }
            console.error('Failed to load repo integrity:', err);
            return null;
        }
    }, [store.bookRef.kind, store.bookRef.value]);

    useEffect(() => {
        let cancelled = false;

        const bootstrap = async () => {
            const params = new URLSearchParams(window.location.search);
            const bookId = params.get('book_id');
            const initialFile = params.get('file') || 'world_model.md';
            if (!bookId) {
                window.location.href = '/bookshelf.html';
                return;
            }

            const bookRef = { kind: 'book_id' as const, value: bookId };
            store.setAddressingContext(bookRef, initialFile, resolveFileType(initialFile));
            setIsEditing(false);
            setEditDraft('');
            setEditBaseEtag('');
            setSaveConflict(null);
            setEditorContent('');
            setEditorSaveState('idle');
            setMainlineFileState(null);

            try {
                const integrity = await loadRepoIntegrity(bookRef);
                if (cancelled) return;
                if (integrity?.exists === false) {
                    setBootstrapState('loaded');
                    return;
                }

                try {
                    const { files, integrity: hotIntegrity } = await fetchHotFiles(bookRef);
                    setRepoIntegrity(hotIntegrity);
                    store.setHotFiles(files.length > 0 ? files : DEFAULT_HOT_FILES);
                } catch {
                    store.setHotFiles(DEFAULT_HOT_FILES);
                }

                try {
                    const mainline = await fetchMainlineFile(bookRef, initialFile);
                    setRepoIntegrity(mainline.integrity);
                    setMainlineFileState({ exists: mainline.exists, virtual: mainline.virtual });
                    store.setMainlineFact(mainline.content, mainline.etag);
                    setEditorContent(mainline.content);
                } catch {
                    // non-fatal
                }

                setBootstrapState('loaded');
            } catch (err) {
                console.error('Failed to load book:', err);
                setBootstrapState('loaded');
            }
        };

        void bootstrap();
        return () => { cancelled = true; };
    }, [loadRepoIntegrity]);

    const handleBackToBookshelf = useCallback(() => {
        window.location.href = '/bookshelf.html';
    }, []);

    const loadMainline = useCallback(async (
        targetFile?: string,
        options?: { preserveDraftReview?: boolean }
    ) => {
        if (!store.bookRef.value) return;
        try {
            const fileName = targetFile || store.activeFile;
            const { content, etag, exists, virtual, integrity } = await fetchMainlineFile(store.bookRef, fileName);
            setRepoIntegrity(integrity);
            setMainlineFileState({ exists, virtual });
            store.setMainlineFact(content, etag);
            const runtimeState = useAppStore.getState();
            const shouldPreserveReview = Boolean(
                options?.preserveDraftReview
                && (runtimeState.draftCommitId || runtimeState.reviewTargetFile || runtimeState.reviewReadyNotice)
                && (runtimeState.fsmState === 'REVIEW' || runtimeState.fsmState === 'CONFLICT')
            );
            if (!shouldPreserveReview) {
                store.setFsmState('IDLE');
            }
        } catch (err) {
            const integrity = extractIntegrityFromError(err);
            if (integrity) {
                setRepoIntegrity(integrity);
            }
            setMainlineFileState(null);
            store.setMainlineFact('', '');
            const runtimeState = useAppStore.getState();
            const shouldPreserveReview = Boolean(
                options?.preserveDraftReview
                && (runtimeState.draftCommitId || runtimeState.reviewTargetFile || runtimeState.reviewReadyNotice)
                && (runtimeState.fsmState === 'REVIEW' || runtimeState.fsmState === 'CONFLICT')
            );
            if (!shouldPreserveReview) {
                store.setFsmState('IDLE');
            }
            if (!isLayoutRepairRequired(err)) {
                console.error('Failed to load mainline fact:', err);
            }
        }
    }, [store.bookRef.kind, store.bookRef.value, store.activeFile]);

    const {
        isEditing, setIsEditing,
        setEditBaseEtag,
        editDraft, setEditDraft,
        isSaving,
        saveConflict, setSaveConflict,
        handleEnterEdit, handleCancelEdit, handleSaveEdit,
    } = useHumanEditMode({
        store,
        editorContent,
        setEditorContent,
        repoIntegrity,
        setRepoIntegrity,
        getErrorMessage,
        loadMainline,
    });

    // Ref for late-bound values that useDraftReview provides
    const draftReviewLateRef = useRef<{ hasPendingDraftDecision: boolean; loadReviewTargetMainline: (file: string) => Promise<void> }>({
        hasPendingDraftDecision: false,
        loadReviewTargetMainline: async () => {},
    });

    const {
        worldInitActionState,
        styleInitActionState,
        rollingActionState,
        postConfirmHandoffState,
        handleRunWorldInitAction,
        handleRunStyleInitAction,
        handleRefreshRollingState,
        handleRunRollingContinuation,
        handleRunRollingOutlineHandoff,
        runPostConfirmWorldDistill,
        runPostConfirmWorldDistillFromResult,
        handleRunPostConfirmHandoff,
        refreshRollingStateRef,
    } = useWorkbenchActions({
        store,
        repoIntegrity,
        setRepoIntegrity,
        loadMainline,
        lateRef: draftReviewLateRef,
    });

    const {
        reviewDiffFullscreenOpen,
        setReviewDiffFullscreenOpen,
        loadReviewTargetMainline,
        loadReviewTargetFromDraftBranch,
        handleConfirm,
        handleRollback,
        handleRefreshLock,
        pendingReviewTargetFile,
        hasPendingDraftDecision,
        hasReviewWorkspace,
    } = useDraftReview({
        store,
        repoIntegrity,
        setRepoIntegrity,
        loadMainline,
        onPostConfirm: runPostConfirmWorldDistillFromResult,
        onAfterRollback: () => refreshRollingStateRef.current(),
    });

    // Update late-bound deps that useWorkbenchActions handlers need
    draftReviewLateRef.current = {
        hasPendingDraftDecision,
        loadReviewTargetMainline,
    };

    const reviewChangedFiles = useMemo(() => {
        const seen = new Set<string>();
        const files = [
            ...store.reviewChangedFiles,
            ...(store.reviewReadyNotice?.changedFiles || []),
            ...(store.reviewTargetFile ? [store.reviewTargetFile] : []),
        ];
        return files.filter((fileName) => {
            if (!fileName || seen.has(fileName)) return false;
            seen.add(fileName);
            return true;
        });
    }, [
        store.reviewChangedFiles,
        store.reviewReadyNotice?.changedFiles,
        store.reviewTargetFile,
    ]);

    const handleSelectReviewTargetFile = useCallback(async (fileName: string) => {
        if (!fileName || fileName === useAppStore.getState().reviewTargetFile) return;
        setReviewTargetLoading(true);
        try {
            const loaded = await loadReviewTargetFromDraftBranch(fileName, reviewChangedFiles);
            if (!loaded) {
                store.setUiNotice({
                    type: 'error',
                    message: `无法加载 ${fileName} 的草稿差异`,
                    ts: Date.now(),
                });
            }
        } finally {
            setReviewTargetLoading(false);
        }
    }, [loadReviewTargetFromDraftBranch, reviewChangedFiles, store]);

    const {
        loadGitWorkbench,
        handleGitCheckout,
        handleGitSelectBranch,
        handleGitCreateBranch,
        handleGitRenameBranch,
        handleGitMerge,
        handleGitHardRollback,
        handleGitOpenCommitDiff,
        handleGitStage,
        handleGitUnstage,
        handleGitStageAll,
        handleGitCommit,
    } = useGitWorkbench({
        store,
        repoIntegrity,
        setRepoIntegrity,
        hasPendingDraftDecision,
        loadMainline,
        loadRepoIntegrity,
    });


    useEffect(() => {
        void loadMainline();
    }, [loadMainline]);

    useEffect(() => {
        setEditorContent(store.mainlineContent);
    }, [store.mainlineContent, store.activeFile]);

    useEffect(() => {
        if (store.workbenchMode !== 'editor') return;
        if (isEditing) return;          // Human edit mode: skip autosave
        if (editorContent === store.mainlineContent) return;
        if (!store.bookRef.value || !store.activeFile) return;

        const snapshotContent = editorContent;
        const snapshotEtag = store.baseEtag;
        const snapshotFile = store.activeFile;
        const snapshotBookRef = { kind: store.bookRef.kind, value: store.bookRef.value } as const;
        const ticket = saveTicketRef.current + 1;
        saveTicketRef.current = ticket;

        const timer = window.setTimeout(async () => {
            setEditorSaveState('saving');
            try {
                const response = await updateMainlineFile(
                    snapshotBookRef,
                    snapshotFile,
                    snapshotContent,
                    snapshotEtag
                );
                if (saveTicketRef.current !== ticket) return;
                store.setMainlineFact(snapshotContent, response.etag);
                setEditorSaveState('idle');
            } catch (err) {
                if (saveTicketRef.current !== ticket) return;
                setEditorSaveState('error');
                const message = getErrorMessage(err, '未知异常');
                store.setUiNotice({
                    type: 'error',
                    message: `主编辑区保存失败：${message}`,
                    ts: Date.now(),
                });
            }
        }, 600);

        return () => {
            window.clearTimeout(timer);
        };
    }, [
        editorContent,
        isEditing,
        store.mainlineContent,
        store.baseEtag,
        store.activeFile,
        store.workbenchMode,
        store.bookRef.kind,
        store.bookRef.value,
    ]);

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
                        void loadReviewTargetMainline(reviewSurfaceFile);
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
                        void loadConversationContext(scopedAgent, conversationId);
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
                            void loadReviewTargetMainline(reviewTargetFile);
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
                    await loadReviewTargetMainline(reviewTargetFile);
                }
                if (shouldReloadGit) {
                    await loadGitWorkbench();
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
        if (store.fsmState === 'REVIEW' || store.fsmState === 'CONFLICT' || hasPendingDraftDecision) {
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
    }, [hasPendingDraftDecision, store]);

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


    const prepareFileContextSwitch = (nextFile: string) => {
        if (!isEditing) return true;

        if (editDraft !== editorContent) {
            store.setUiNotice({
                type: 'info',
                message: `当前文件 ${store.activeFile} 有未保存人工编辑，请先保存或收起编辑栏，再切换到 ${nextFile}。`,
                ts: Date.now(),
            });
            return false;
        }

        setEditDraft('');
        setEditBaseEtag('');
        setSaveConflict(null);
        setIsEditing(false);
        return true;
    };

    const {
        conversationPanelAgent,
        setConversationPanelAgent,
        loadConversationContext,
        handleConversationSelect,
        handleSwitchConversationAgent,
        handleCreateConversation,
        handleRenameConversation,
        handleArchiveConversation,
        handleDeleteConversation,
    } = useAgentSession({
        store,
        loadMainline,
        prepareFileContextSwitch,
        hasPendingDraftDecision,
        pendingReviewTargetFile,
        isEditing,
        editDraft,
        editorContent,
        setIsEditing,
        setEditDraft,
        setEditBaseEtag,
        setSaveConflict,
    });

    const handleFileSelect = async (file: HotFileItem) => {
        if (file.fileName === store.activeFile) return;
        if (hasPendingDraftDecision) {
            const reviewFile = pendingReviewTargetFile();
            store.setUiNotice({
                type: 'info',
                message: `当前被审阅文件 ${reviewFile} 已进入差异审阅态，请先归档/确权或湮灭回滚，再切换文件。`,
                ts: Date.now(),
            });
            return;
        }
        if (!prepareFileContextSwitch(file.fileName)) return;
        store.setActiveFile(file.fileName, file.fileType);
        await loadMainline(file.fileName);
    };

    const handleWorkbenchModeChange = (nextMode: WorkbenchMode) => {
        if (nextMode === store.workbenchMode) return;
        if (nextMode === 'review' && !hasReviewWorkspace) {
            return;
        }
        if (nextMode === 'git' && hasPendingDraftDecision) {
            store.setUiNotice({
                type: 'info',
                message: `当前文件 ${store.activeFile} 正处于差异审阅态；剧情分支可查看，切换、合并、回退会在确权或回滚前保持禁用。`,
                ts: Date.now(),
            });
        }
        store.setWorkbenchMode(nextMode);
        if (nextMode === 'editor') {
            store.setGitCenterMode('commit_list');
            store.setGitDiffPayload(null);
            store.setGitFilePayload(null);
            store.setGitDiffFullscreen(false);
        }
    };

    const handleRepairLayout = useCallback(async () => {
        if (!store.bookRef.value || repairPending) return;
        const bookRef = { kind: store.bookRef.kind, value: store.bookRef.value } as const;
        setRepairPending(true);
        try {
            const result = await repairBookLayout(bookRef);
            setRepoIntegrity(result.integrity);
            const { files, integrity } = await fetchHotFiles(bookRef);
            setRepoIntegrity(integrity);
            if (files.length > 0) {
                store.setHotFiles(files);
            }
            await loadMainline();
            if (!integrity.needsRepair && store.workbenchMode === 'git') {
                await loadGitWorkbench();
            }
            const shortCommit = (result.headCommit || '').slice(0, 8);
            store.setUiNotice({
                type: 'success',
                message: shortCommit ? `仓库布局已修复：${shortCommit}` : '仓库布局已修复。',
                ts: Date.now(),
            });
        } catch (err) {
            const integrity = extractIntegrityFromError(err);
            if (integrity) {
                setRepoIntegrity(integrity);
            }
            store.setUiNotice({
                type: 'error',
                message: `修复布局失败：${getErrorMessage(err, '未知异常')}`,
                ts: Date.now(),
            });
        } finally {
            setRepairPending(false);
        }
    }, [repairPending, store.bookRef.kind, store.bookRef.value, store.workbenchMode, loadGitWorkbench, loadMainline]);

    const isReviewMode = store.workbenchMode === 'review';
    const isGitMode = store.workbenchMode === 'git';
    const outlineSourceContent = isEditing
        ? editDraft
        : (isReviewMode && store.draftContent ? store.draftContent : editorContent);
    const leftRailVerticalLayout = useDefaultLayout({
        id: 'novel-agent-left-rail-stack',
        panelIds: ['left-files-panel', 'left-outline-panel'],
    });
    const leftPanelTitle = isGitMode ? copy.workbench.gitConsole : copy.workbench.projectFiles;
    const editorRailActive = store.workbenchMode !== 'git';
    const explorerFiles = store.hotFiles.length > 0 ? store.hotFiles : DEFAULT_HOT_FILES;
    const explorerFileKey = explorerFiles.map((file) => `${file.fileType}:${file.fileName}`).join('|');
    const topBar = (
        <TopBar
            bookName={store.bookRef.value}
            activeFile={store.activeFile}
            workbenchMode={store.workbenchMode}
            isGitMode={isGitMode}
            isReviewMode={isReviewMode}
            uiLanguage={store.uiLanguage}
            onBackToBookshelf={handleBackToBookshelf}
        />
    );
    const activityBar = (
        <ActivityBar
            workbenchMode={store.workbenchMode}
            isGitMode={isGitMode}
            editorRailActive={editorRailActive}
            uiLanguage={store.uiLanguage}
            onModeChange={handleWorkbenchModeChange}
        />
    );
    const workbenchLeftPanel = (
        <WorkbenchLeftPanel
            bookName={store.bookRef.value}
            activeFile={store.activeFile}
            activeFileType={store.activeFileType}
            uiLanguage={store.uiLanguage}
            workbenchMode={store.workbenchMode}
            isGitMode={isGitMode}
            isReviewMode={isReviewMode}
            leftPanelTitle={leftPanelTitle}
            repoIntegrity={repoIntegrity}
            bootstrapState={bootstrapState}
            repairPending={repairPending}
            outlineSourceContent={outlineSourceContent}
            explorerFiles={explorerFiles}
            explorerFileKey={explorerFileKey}
            hasPendingDraftDecision={hasPendingDraftDecision}
            leftRailVerticalLayout={leftRailVerticalLayout}
            draftContent={store.draftContent}
            mainlineContent={store.mainlineContent}
            gitStatus={store.gitStatus}
            gitBranches={store.gitBranches}
            selectedGitBranchName={store.selectedGitBranchName}
            selectedGitCommitId={store.selectedGitCommitId}
            gitActionPending={store.gitActionPending}
            onChangeLanguage={store.setUiLanguage}
            onRepairLayout={() => { void handleRepairLayout(); }}
            onFileSelect={handleFileSelect}
            onGitRefresh={() => { void loadGitWorkbench(); }}
            onGitSelectBranch={(branchName: string) => { void handleGitSelectBranch(branchName); }}
            onGitCheckout={(branchName: string) => { void handleGitCheckout(branchName); }}
            onGitMerge={(payload: any) => { void handleGitMerge(payload); }}
            onGitCreateBranch={(payload: any) => { void handleGitCreateBranch(payload); }}
            onGitRenameBranch={(payload: any) => { void handleGitRenameBranch(payload); }}
            onGitHardRollback={(targetCommit: string) => { void handleGitHardRollback(targetCommit); }}
        />
    );



    const editorCenterPanel = (
        <EditorCenterPanel
            activeFile={store.activeFile}
            baseEtag={store.baseEtag}
            editorContent={editorContent}
            editorSaveState={editorSaveState}
            isEditing={isEditing}
            editDraft={editDraft}
            isSaving={isSaving}
            saveConflict={saveConflict}
            repoIntegrity={repoIntegrity}
            mainlineFileState={mainlineFileState}
            bootstrapState={bootstrapState}
            repairPending={repairPending}
            fsmState={store.fsmState}
            uiLanguage={store.uiLanguage}
            onRepairLayout={() => { void handleRepairLayout(); }}
            onDismissConflict={() => setSaveConflict(null)}
            onPullLatest={() => { setSaveConflict(null); setIsEditing(false); void loadMainline(); }}
            onEnterEdit={handleEnterEdit}
            onCancelEdit={handleCancelEdit}
            onSaveEdit={() => void handleSaveEdit()}
            onEditDraftChange={(next) => { if (isEditing) setEditDraft(next); }}
        />
    );

    const gitCenterPanel = repoIntegrity?.needsRepair ? (
        <GitLockedPanel repairPending={repairPending} onRepairLayout={() => { void handleRepairLayout(); }} />
    ) : (
        <GitCenterPanel
            commits={store.gitHistoryCommits}
            selectedBranchName={store.selectedGitBranchName}
            selectedCommitId={store.selectedGitCommitId}
            loading={store.gitLoading}
            error={store.gitError}
            onSelectCommit={(commitId) => {
                store.setSelectedGitCommit(commitId);
                store.setSelectedGitPath(null);
                store.setGitDiffPayload(null);
            }}
        />
    );

    const draftAttachmentMessages = store.chatMessages.filter((message) => {
        if (!message.activeFile) return true;
        return isSameConversationScope(
            message.activeFile,
            resolveFileType(message.activeFile),
            store.activeFile,
            store.activeFileType,
            store.activeAgent,
        );
    });
    const latestDraftAttachment = useMemo(() => (
        [...draftAttachmentMessages]
            .reverse()
            .find((message) => message.diffAttachment)?.diffAttachment || null
    ), [draftAttachmentMessages]);
    const reviewTargetFile = useMemo(() => (
        store.reviewTargetFile
        || store.reviewReadyNotice?.fileName
        || latestDraftAttachment?.fileName
        || store.activeFile
    ), [latestDraftAttachment?.fileName, store.activeFile, store.reviewReadyNotice?.fileName, store.reviewTargetFile]);
    const reviewMainlineContent = useMemo(() => (
        reviewTargetFile === store.activeFile
            ? (store.reviewMainlineContent || store.mainlineContent)
            : store.reviewMainlineContent
    ), [reviewTargetFile, store.activeFile, store.reviewMainlineContent, store.mainlineContent]);
    const currentReviewDraftAttachment = latestDraftAttachment?.fileName === reviewTargetFile
        ? latestDraftAttachment
        : null;
    const isProseReviewSurface = isReviewMode && reviewTargetFile === 'chapter_draft.md';
    useEffect(() => {
        if (isProseReviewSurface && conversationPanelAgent !== 'review_agent' && conversationPanelAgent !== 'continuation_agent') {
            setConversationPanelAgent('review_agent');
        }
    }, [conversationPanelAgent, isProseReviewSurface, setConversationPanelAgent]);
    const rightPanelAgent: AgentKey = isProseReviewSurface
        ? (
            conversationPanelAgent === 'review_agent' || conversationPanelAgent === 'continuation_agent'
                ? conversationPanelAgent
                : 'review_agent'
        )
        : conversationPanelAgent;
    const rightPanelActiveFile = isProseReviewSurface ? 'chapter_draft.md' : store.activeFile;
    const rightPanelFileType = resolveFileType(rightPanelActiveFile);
    const rightPanelConversationActionScope = isProseReviewSurface
        ? { agent: rightPanelAgent, activeFile: rightPanelActiveFile, switchActiveFile: false }
        : undefined;
    const rightPanelAgentOptions: AgentKey[] | undefined = isProseReviewSurface
        ? ['review_agent', 'continuation_agent']
        : undefined;
    const rightPanelMessages = rightPanelAgent === store.activeAgent
        ? store.chatMessages
        : (store.chatMessagesByAgent[rightPanelAgent] ?? []);
    const rightPanelVisibleChatMessages = useMemo(() => (
        rightPanelMessages.filter((message) => {
            if (!message.activeFile) return true;
            return isSameConversationScope(
                message.activeFile,
                resolveFileType(message.activeFile),
                rightPanelActiveFile,
                rightPanelFileType,
                rightPanelAgent,
            );
        })
    ), [rightPanelActiveFile, rightPanelAgent, rightPanelFileType, rightPanelMessages]);
    const latestProseReviewMessage = useMemo(() => {
        if (!isProseReviewSurface) return null;
        const reviewMessages = store.chatMessagesByAgent.review_agent ?? [];
        const latest = [...reviewMessages].reverse().find((message) => (
            message.role === 'assistant'
            && message.status === 'done'
            && (!message.activeFile || isSameConversationScope(
                message.activeFile,
                resolveFileType(message.activeFile),
                'chapter_draft.md',
                'chapter',
                'review_agent',
            ))
            && message.text.trim()
        ));
        return latest ?? null;
    }, [isProseReviewSurface, store.chatMessagesByAgent]);
    const latestProseRewriteMessage = useMemo(() => {
        if (!isProseReviewSurface) return null;
        const rewriteMessages = store.chatMessagesByAgent.continuation_agent ?? [];
        return [...rewriteMessages].reverse().find((message) => (
            message.role === 'assistant'
            && (!message.activeFile || isSameConversationScope(
                message.activeFile,
                resolveFileType(message.activeFile),
                'chapter_draft.md',
                'chapter',
                'continuation_agent',
            ))
        )) ?? null;
    }, [isProseReviewSurface, store.chatMessagesByAgent]);
    const rightPanelLatestUserMessageId = getLatestUserMessage(rightPanelAgent, rightPanelActiveFile)?.id ?? null;
    useEffect(() => {
        if (isProseReviewSurface) {
            void loadConversationContext(rightPanelAgent);
        }
    }, [isProseReviewSurface, loadConversationContext, rightPanelAgent]);
    const handleEnterReviewFromNotice = () => {
        store.setWorkbenchMode('review');
        store.clearReviewReadyNotice();
    };
    const handleRunReviewAgent = () => {
        const targetFile = pendingReviewTargetFile();
        if (targetFile !== 'chapter_draft.md') return;
        void handleIntentSubmit(
            `请审核当前续写草稿 ${targetFile}。你必须读取 chapter_draft.md，并结合 chapter_outline.md、summary.md、status_card.md、world_model.md、style_guide.md、error_archive.md 判断：1）是否越过本章大纲边界；2）是否违反世界观、状态卡、文风或错误档案；3）是否存在情节水位、占比、手法失衡。若发现真实问题，请只把可复用的硬约束写入 error_archive.md；若没有问题，请用一句话说明通过，不要写文件。`,
            {
                routeAgentKey: 'review_agent',
                activeFile: 'chapter_draft.md',
                fileType: 'chapter',
                baseEtag: '',
                targetDraftCommit: store.draftCommitId,
            },
        );
    };
    const handleRewriteWithReview = async (finding?: ProseReviewFinding) => {
        const targetFile = pendingReviewTargetFile();
        if (targetFile !== 'chapter_draft.md') return;
        const findingAdvice = finding
            ? `\n\n【本次打回问题】\n${finding.message || finding.suggestion}\n\n【修复建议】\n${finding.suggestion || finding.message}`
            : '';
        await handleIntentSubmit(
            `【正文草稿打回重写请求】

请由续写 Agent 接手修复 ${targetFile}。这不是让后端或前端改正文，必须由你读取事实源并重写草稿。

必须读取：
1. chapter_draft.md：上一版草稿全文，保留可用内容，只修复审核命中的真实问题。
2. error_archive.md：长期错误档案，本轮新增问题也要作为写作禁令参考。
3. chapter_outline.md：本轮章节边界，不要越过逐章大纲。
4. summary.md、status_card.md、world_model.md：最新剧情事实、角色状态和设定约束。
5. style_guide.md：只作为文风模仿提示，不要为了格式牺牲剧情推进。

输出要求：
1. 直接更新 chapter_draft.md，不要写入正式正文，不要修改其他文件。
2. 如果问题跨越当前三章，允许一起修复；如果只命中单章，只重写必要片段。
3. 先保证剧情逻辑、状态连续、章节边界和错误档案约束，再考虑语言润色。
4. 不要在回复里长篇解释正文内容，完成后简短说明修复了哪些问题。${findingAdvice}`,
            { routeAgentKey: 'continuation_agent', activeFile: 'chapter_draft.md', fileType: 'chapter', baseEtag: '' },
        );
    };

    const editorRightPanel = (
        <EditorRightPanel
            chatAgent={rightPanelAgent}
            chatActiveFile={rightPanelActiveFile}
            visibleMessages={rightPanelVisibleChatMessages}
            latestUserMessageId={rightPanelLatestUserMessageId}
            agentOptions={rightPanelAgentOptions}
            fsmState={store.fsmState}
            isProseReviewSurface={isProseReviewSurface}
            isReviewMode={isReviewMode}
            editingMessageId={rewriteUserMessageId}
            editDraftValue={commandInput}
            uiLanguage={store.uiLanguage}
            activeAgent={store.activeAgent}
            conversationByAgent={store.conversationByAgent}
            conversationIndexByAgent={store.conversationIndexByAgent}
            suppressedErrors={suppressedBackendErrors}
            debugOpen={suppressedDebugOpen}
            onSwitchAgent={(agent: AgentKey) => {
                if (isProseReviewSurface) { setConversationPanelAgent(agent); void loadConversationContext(agent); }
                else { void handleSwitchConversationAgent(agent); }
            }}
            onCreateConversation={() => { void handleCreateConversation(rightPanelConversationActionScope); }}
            onSelectConversation={(conversationId: string) => { void handleConversationSelect(conversationId, rightPanelConversationActionScope); }}
            onRenameConversation={(conversationId: string) => { void handleRenameConversation(conversationId, rightPanelConversationActionScope); }}
            onArchiveConversation={(conversationId: string) => { void handleArchiveConversation(conversationId, rightPanelConversationActionScope); }}
            onDeleteConversation={(conversationId: string) => { void handleDeleteConversation(conversationId, rightPanelConversationActionScope); }}
            onConfirmDraft={handleConfirm}
            onRollbackDraft={handleRollback}
            onRequestEdit={beginRewriteFromMessage}
            onEditDraftChange={setCommandInput}
            onSubmitEdit={handleInlineRewriteSubmit}
            onCancelEdit={handleCancelRewrite}
            onLandOutlineMessage={handleOutlineLandingFromMessage}
            onCommandSubmit={handleCommandSubmit}
            onStopStream={handleStopStream}
            onToggleDebug={setSuppressedDebugOpen}
            onClearErrors={setSuppressedBackendErrors}
        />
    );

    const reviewCenterPanel = (
        <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
            {store.fsmState === 'CONFLICT' && (
                <ConflictBanner isVisible={true} onRefreshLock={handleRefreshLock} />
            )}
            <div className={store.fsmState === 'CONFLICT' ? 'min-h-0 flex-1 pt-16' : 'min-h-0 flex-1'}>
                {isProseReviewSurface ? (
                    <ProseDeliveryWorkbench
                        bookRef={store.bookRef}
                        draftContent={store.draftContent}
                        draftCommitId={store.draftCommitId}
                        draftActionPending={store.draftActionPending}
                        onDraftLoaded={(content, commitId, etag) => {
                            store.setSandboxDraft(content, commitId);
                            store.setReviewMainlineFact(store.mainlineContent, etag);
                            store.setReviewTarget('chapter_draft.md', reviewChangedFiles.includes('chapter_draft.md') ? reviewChangedFiles : ['chapter_draft.md', ...reviewChangedFiles]);
                        }}
                        onConfirm={handleConfirm}
                        onRollback={handleRollback}
                        onRunReviewAgent={handleRunReviewAgent}
                        onRewriteWithReview={handleRewriteWithReview}
                        onNotice={store.setUiNotice}
                        latestReviewMessageText={latestProseReviewMessage?.text.trim() ?? ''}
                        latestReviewTargetDraftCommit={latestProseReviewMessage?.targetDraftCommit ?? null}
                        latestRewriteMessage={latestProseRewriteMessage}
                    />
                ) : (
                    <ReviewCanvasPanel
                        fileName={reviewTargetFile}
                        changedFiles={reviewChangedFiles}
                        mainlineContent={reviewMainlineContent}
                        draftContent={store.draftContent}
                        draftCommitId={store.draftCommitId}
                        fsmState={store.fsmState}
                        isLoadingTarget={reviewTargetLoading}
                        onSelectFile={handleSelectReviewTargetFile}
                        onOpenFullscreen={() => setReviewDiffFullscreenOpen(true)}
                    />
                )}
            </div>
        </div>
    );

    const gitRightPanel = repoIntegrity?.needsRepair ? (
        <div className="flex h-full min-h-0 items-center justify-center bg-[#0b1119] px-6 text-sm text-[#d9bf95]">
            修复仓库布局后，这里才会恢复工作区状态、提交文件与 Diff 预览。
        </div>
    ) : (
        <GitWorkingTreePanel
            status={store.gitStatus}
            workingTree={store.gitWorkingTree}
            commitFiles={store.gitCommitFiles}
            selectedCommit={
                store.gitHistoryCommits.find((row) => row.commitId === store.selectedGitCommitId) || null
            }
            selectedPath={store.selectedGitPath}
            commitDiffPayload={store.gitDiffPayload}
            pending={store.gitActionPending}
            onSelectPath={store.setSelectedGitPath}
            onOpenCommitDiff={(path, commitId) => {
                void handleGitOpenCommitDiff(path, commitId);
            }}
            onStage={(path) => {
                void handleGitStage(path);
            }}
            onUnstage={(path) => {
                void handleGitUnstage(path);
            }}
            onStageAll={() => {
                void handleGitStageAll();
            }}
            onCommit={(message) => {
                void handleGitCommit(message);
            }}
            onOpenFullscreenDiff={() => {
                store.setGitDiffFullscreen(true);
            }}
        />
    );
    const reviewRightPanel = isProseReviewSurface ? (
        editorRightPanel
    ) : (
        <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-[220px] flex-[0_0_42%] border-b border-[rgba(255,255,255,0.04)]">
                <ReviewInspectorPanel
                    fileName={reviewTargetFile}
                    changedFiles={reviewChangedFiles}
                    branch={currentReviewDraftAttachment?.branch || store.draftBranch}
                    draftCommitId={store.draftCommitId}
                    draftContent={store.draftContent}
                    mainlineContent={reviewMainlineContent}
                    draftAttachment={currentReviewDraftAttachment}
                    fsmState={store.fsmState}
                    draftActionPending={store.draftActionPending}
                    isLoadingTarget={reviewTargetLoading}
                    onSelectFile={handleSelectReviewTargetFile}
                    onConfirm={handleConfirm}
                    onRollback={handleRollback}
                    onRunReviewAgent={undefined}
                    onRewriteWithReview={undefined}
                    onOpenFullscreen={() => setReviewDiffFullscreenOpen(true)}
                    onBackToEditor={() => store.setWorkbenchMode('editor')}
                    onRefreshLock={handleRefreshLock}
                />
            </div>
            <div className="min-h-0 flex-1">
                {editorRightPanel}
            </div>
        </div>
    );

    const workbenchCenterPanel = (
        <WorkbenchModeLayer
            activeMode={store.workbenchMode}
            editorView={editorCenterPanel}
            reviewView={hasReviewWorkspace ? reviewCenterPanel : null}
            gitView={gitCenterPanel}
        />
    );

    const workbenchRightPanel = (
        <WorkbenchModeLayer
            activeMode={store.workbenchMode}
            editorView={editorRightPanel}
            reviewView={hasReviewWorkspace ? reviewRightPanel : null}
            gitView={gitRightPanel}
        />
    );
    const workbenchActions = buildWorkbenchActions(
        {
            activeFile: store.activeFile,
            activeFileType: store.activeFileType,
            fsmState: store.fsmState,
            workbenchMode: store.workbenchMode,
            repoNeedsRepair: Boolean(repoIntegrity?.needsRepair),
            hasReviewWorkspace,
            worldInitRunState: worldInitActionState.runState,
            worldInitProgress: worldInitActionState.progress,
            styleInitRunState: styleInitActionState.runState,
            styleInitProgress: styleInitActionState.progress,
            rollingRunState: rollingActionState.runState,
            rollingState: rollingActionState.state,
            rollingProgress: rollingActionState.progress,
            postConfirmRunState: postConfirmHandoffState.runState,
            postConfirmProgress: postConfirmHandoffState.progress,
            hasPostConfirmPayload: Boolean(postConfirmHandoffState.payload),
        },
        {
            onRunWorldInit: handleRunWorldInitAction,
            onRunStyleInit: handleRunStyleInitAction,
            onRefreshRollingState: handleRefreshRollingState,
            onRunRollingContinuation: handleRunRollingContinuation,
            onRunRollingOutlineHandoff: handleRunRollingOutlineHandoff,
            onRunPostConfirmHandoff: handleRunPostConfirmHandoff,
        },
    );

    return (
        <>
            <AppLayout
                activityBar={activityBar}
                topBar={topBar}
                leftPanel={workbenchLeftPanel}
                centerPanel={workbenchCenterPanel}
                rightPanel={workbenchRightPanel}
            />
            <GitDiffFullscreen />
            <ReviewDiffFullscreen
                isOpen={hasReviewWorkspace && reviewDiffFullscreenOpen}
                fileName={reviewTargetFile}
                changedFiles={reviewChangedFiles}
                branch={currentReviewDraftAttachment?.branch || store.draftBranch}
                draftCommitId={store.draftCommitId}
                mainlineContent={reviewMainlineContent}
                draftContent={store.draftContent}
                fsmState={store.fsmState}
                draftActionPending={store.draftActionPending}
                isLoadingTarget={reviewTargetLoading}
                onSelectFile={handleSelectReviewTargetFile}
                onConfirm={handleConfirm}
                onRollback={handleRollback}
                onClose={() => setReviewDiffFullscreenOpen(false)}
            />
            <ReviewReadyNotice
                notice={store.reviewReadyNotice}
                uiLanguage={store.uiLanguage}
                onEnterReview={handleEnterReviewFromNotice}
                onClose={store.clearReviewReadyNotice}
            />
            <WorkbenchActionDock
                activeFile={store.activeFile}
                activeFileType={store.activeFileType}
                fsmState={store.fsmState}
                workbenchMode={store.workbenchMode}
                repoNeedsRepair={Boolean(repoIntegrity?.needsRepair)}
                actions={workbenchActions}
            />
            <ToastNotice notice={store.uiNotice} onClose={store.clearUiNotice} />
        </>
    );
}
