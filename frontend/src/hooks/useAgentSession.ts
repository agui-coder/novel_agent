import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { AppStore, AgentKey } from '../types/store';
import { activateConversation, archiveConversation, createConversation, deleteConversation, fetchConversationContext, renameConversation } from '../api/session';
import { resolveFileType } from '../lib/fileType';
import { mapConversationMessages, mergeHydratedMessagesWithLocalUiState } from '../lib/conversationUtils';
import { isSameConversationScope } from '../lib/conversationScope';

export function useAgentSession(deps: {
    store: AppStore;
    loadMainline: (file?: string, opts?: { preserveDraftReview?: boolean }) => Promise<void>;
    prepareFileContextSwitch: (nextFile: string) => boolean;
    hasPendingDraftDecision: boolean;
    pendingReviewTargetFile: () => string | null;
    isEditing: boolean;
    editDraft: string;
    editorContent: string;
    setIsEditing: (v: boolean) => void;
    setEditDraft: (v: string) => void;
    setEditBaseEtag: (v: string) => void;
    setSaveConflict: (v: any) => void;
}) {
    const {
        store,
        loadMainline,
        prepareFileContextSwitch,
        hasPendingDraftDecision,
        pendingReviewTargetFile,
    } = deps;

    const [conversationPanelAgent, setConversationPanelAgent] = useState<AgentKey>(store.activeAgent);

    type ConversationActionScope = {
        agent?: AgentKey;
        activeFile?: string;
        switchActiveFile?: boolean;
    };

    const loadConversationContext = useCallback(async (agentOverride?: AgentKey, conversationIdOverride?: string | null) => {
        if (!store.bookRef.value) return;
        const agent = agentOverride ?? store.activeAgent;
        try {
            const payload = await fetchConversationContext(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                agent,
                conversationIdOverride ?? undefined,
            );
            let normalizedPayload = payload;
            if (!conversationIdOverride && agent === store.activeAgent) {
                const currentConversationId = payload.active_conversation_id || payload.conversation_id || null;
                const currentConversation = (payload.conversations || []).find(
                    (item) => item.conversation_id === currentConversationId
                );
                const currentConversationInScope = currentConversation && isSameConversationScope(
                    currentConversation.last_active_file,
                    resolveFileType(currentConversation.last_active_file),
                    store.activeFile,
                    store.activeFileType,
                    agent,
                );
                const matchedConversation = currentConversationInScope ? currentConversation : (payload.conversations || []).find(
                    (item) => isSameConversationScope(
                        item.last_active_file,
                        resolveFileType(item.last_active_file),
                        store.activeFile,
                        store.activeFileType,
                        agent,
                    )
                );
                if (
                    matchedConversation
                    && matchedConversation.conversation_id
                    && matchedConversation.conversation_id !== currentConversationId
                ) {
                    normalizedPayload = await fetchConversationContext(
                        { kind: store.bookRef.kind, value: store.bookRef.value },
                        agent,
                        matchedConversation.conversation_id,
                    );
                }
            }
            const latestState = useAppStore.getState();
            const localMessages = agent === latestState.activeAgent
                ? latestState.chatMessages
                : (latestState.chatMessagesByAgent[agent] ?? []);
            const hydratedMessages = mergeHydratedMessagesWithLocalUiState(
                mapConversationMessages(normalizedPayload.messages || []),
                localMessages,
            );
            store.hydrateAgentConversation(
                agent,
                (normalizedPayload.active_conversation_id || normalizedPayload.conversation_id || null),
                normalizedPayload.upstream_conversation_id || null,
                hydratedMessages,
                normalizedPayload.conversations || [],
            );
        } catch (err) {
            console.warn('Failed to load conversation context:', err);
            store.hydrateAgentConversation(agent, null, null, [], []);
        }
    }, [store.bookRef.kind, store.bookRef.value, store.activeAgent, store.activeFile, store.activeFileType]);

    useEffect(() => {
        void loadConversationContext();
    }, [loadConversationContext]);

    useEffect(() => {
        setConversationPanelAgent(store.activeAgent);
    }, [store.activeAgent]);

    const handleConversationSelect = async (conversationId: string, scope?: ConversationActionScope) => {
        if (!store.bookRef.value) return;
        const scopedAgent = scope?.agent ?? conversationPanelAgent;
        const allowFileSwitch = scope?.switchActiveFile !== false;
        if (hasPendingDraftDecision) {
            const reviewFile = pendingReviewTargetFile();
            store.setUiNotice({
                type: 'info',
                message: `当前被审阅文件 ${reviewFile} 正在审阅 AI 草稿，请先确权或回滚，再切换会话。`,
                ts: Date.now(),
            });
            return;
        }
        const meta = (store.conversationIndexByAgent[scopedAgent] ?? [])
            .find((row) => row.conversation_id === conversationId);
        const nextFile = meta?.last_active_file;
        const nextFileType = nextFile ? resolveFileType(nextFile) : undefined;
        if (
            allowFileSwitch
            && nextFile
            && nextFile !== store.activeFile
            && !isSameConversationScope(
                nextFile,
                nextFileType,
                store.activeFile,
                store.activeFileType,
                scopedAgent,
            )
        ) {
            if (!prepareFileContextSwitch(nextFile)) return;
            store.setActiveFile(nextFile, nextFileType!);
            await loadMainline(nextFile);
        }
        try {
            const payload = await activateConversation(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                scopedAgent,
                conversationId,
            );
            store.hydrateAgentConversation(
                scopedAgent,
                payload.active_conversation_id || payload.conversation_id || null,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
        } catch (err) {
            console.error('Failed to activate conversation:', err);
            store.setUiNotice({
                type: 'error',
                message: '切换会话失败',
                ts: Date.now(),
            });
        }
    };

    const defaultFileForAgent = (agent: AgentKey): string => {
        if (agent === 'style_agent') return 'style_guide.md';
        if (agent === 'outline_agent') return 'brainstorm.md';
        if (agent === 'continuation_agent' || agent === 'review_agent') return 'chapter_draft.md';
        return 'world_model.md';
    };

    const handleSwitchConversationAgent = async (agent: AgentKey, options?: { switchActiveFile?: boolean }) => {
        setConversationPanelAgent(agent);
        const allowFileSwitch = options?.switchActiveFile !== false;
        try {
            const payload = await fetchConversationContext(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                agent,
            );
            const nextConversationId = payload.active_conversation_id || payload.conversation_id || null;
            const activeMeta = (payload.conversations || []).find(
                (row) => row.conversation_id === nextConversationId
            ) || payload.conversations?.[0];
            const nextFile = activeMeta?.last_active_file;
            const nextFileType = nextFile ? resolveFileType(nextFile) : undefined;
            if (
                allowFileSwitch
                && nextFile
                && nextFile !== store.activeFile
                && !isSameConversationScope(
                    nextFile,
                    nextFileType,
                    store.activeFile,
                    store.activeFileType,
                    agent,
                )
            ) {
                if (!prepareFileContextSwitch(nextFile)) return;
                store.setActiveFile(nextFile, nextFileType!);
                await loadMainline(nextFile);
            }
            store.hydrateAgentConversation(
                agent,
                nextConversationId,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
        } catch (err) {
            console.error('Failed to switch conversation agent:', err);
            store.setUiNotice({
                type: 'error',
                message: '切换 Agent 会话失败',
                ts: Date.now(),
            });
        }
    };

    const handleCreateConversation = async (scope?: ConversationActionScope) => {
        if (!store.bookRef.value) return;
        const scopedAgent = scope?.agent ?? conversationPanelAgent;
        const allowFileSwitch = scope?.switchActiveFile !== false;
        if (hasPendingDraftDecision) {
            store.setUiNotice({
                type: 'info',
                message: `当前文件 ${store.activeFile} 的草稿尚未裁决，请先完成审阅，再新建会话。`,
                ts: Date.now(),
            });
            return;
        }
        const targetFile = scope?.activeFile || (scopedAgent === store.activeAgent
            ? store.activeFile
            : defaultFileForAgent(scopedAgent));
        if (allowFileSwitch && targetFile !== store.activeFile) {
            if (!prepareFileContextSwitch(targetFile)) return;
            store.setActiveFile(targetFile, resolveFileType(targetFile));
            await loadMainline(targetFile);
        }
        try {
            const payload = await createConversation(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                scopedAgent,
                targetFile,
            );
            store.hydrateAgentConversation(
                scopedAgent,
                payload.active_conversation_id || payload.conversation_id || null,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
            store.setUiNotice({
                type: 'success',
                message: '已新建会话',
                ts: Date.now(),
            });
        } catch (err) {
            console.error('Failed to create conversation:', err);
            store.setUiNotice({
                type: 'error',
                message: '新建会话失败',
                ts: Date.now(),
            });
        }
    };

    const handleRenameConversation = async (conversationId: string, scope?: ConversationActionScope) => {
        if (!store.bookRef.value) return;
        const scopedAgent = scope?.agent ?? conversationPanelAgent;
        const current = (store.conversationIndexByAgent[scopedAgent] ?? [])
            .find((row) => row.conversation_id === conversationId);
        const title = window.prompt('输入新的会话标题', current?.title || '');
        if (!title || !title.trim()) return;
        try {
            const payload = await renameConversation(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                scopedAgent,
                conversationId,
                title.trim(),
            );
            store.hydrateAgentConversation(
                scopedAgent,
                payload.active_conversation_id || payload.conversation_id || null,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
        } catch (err) {
            console.error('Failed to rename conversation:', err);
            store.setUiNotice({
                type: 'error',
                message: '重命名会话失败',
                ts: Date.now(),
            });
        }
    };

    const handleArchiveConversation = async (conversationId: string, scope?: ConversationActionScope) => {
        if (!store.bookRef.value) return;
        const scopedAgent = scope?.agent ?? conversationPanelAgent;
        const ok = window.confirm('确认归档这条会话吗？会话历史会保留，但默认不再显示。');
        if (!ok) return;
        try {
            const payload = await archiveConversation(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                scopedAgent,
                conversationId,
            );
            store.hydrateAgentConversation(
                scopedAgent,
                payload.active_conversation_id || payload.conversation_id || null,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
            if (scopedAgent === store.activeAgent && (payload.conversation_id || payload.active_conversation_id)) {
                const nextId = payload.active_conversation_id || payload.conversation_id || null;
                store.setConversationId(nextId);
                store.setUpstreamConversationId(payload.upstream_conversation_id || null);
            }
        } catch (err) {
            console.error('Failed to archive conversation:', err);
            store.setUiNotice({
                type: 'error',
                message: '归档会话失败',
                ts: Date.now(),
            });
        }
    };

    const handleDeleteConversation = async (conversationId: string, scope?: ConversationActionScope) => {
        if (!store.bookRef.value) return;
        const scopedAgent = scope?.agent ?? conversationPanelAgent;
        const ok = window.confirm('确认彻底删除这条会话吗？消息历史会一并移除，且不可恢复。');
        if (!ok) return;
        try {
            const payload = await deleteConversation(
                { kind: store.bookRef.kind, value: store.bookRef.value },
                scopedAgent,
                conversationId,
            );
            const nextId = payload.active_conversation_id || payload.conversation_id || null;
            store.hydrateAgentConversation(
                scopedAgent,
                nextId,
                payload.upstream_conversation_id || null,
                mapConversationMessages(payload.messages || []),
                payload.conversations || [],
            );
            if (scopedAgent === store.activeAgent) {
                store.setConversationId(nextId);
                store.setUpstreamConversationId(payload.upstream_conversation_id || null);
            }
            store.setUiNotice({
                type: 'success',
                message: '已删除会话',
                ts: Date.now(),
            });
        } catch (err) {
            console.error('Failed to delete conversation:', err);
            store.setUiNotice({
                type: 'error',
                message: '删除会话失败',
                ts: Date.now(),
            });
        }
    };

    return {
        conversationPanelAgent,
        setConversationPanelAgent,
        loadConversationContext,
        handleConversationSelect,
        handleSwitchConversationAgent,
        handleCreateConversation,
        handleRenameConversation,
        handleArchiveConversation,
        handleDeleteConversation,
        defaultFileForAgent,
    };
}
