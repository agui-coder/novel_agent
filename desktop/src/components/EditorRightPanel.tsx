import { getAgentLabel, getFsmStateLabel, getUiCopy } from '../i18n/ui';
import { AgentConversationList } from './AgentConversationList';
import { ChatPanel } from './ChatPanel';
import { ChatComposerDock } from './ChatComposerDock';
import type { AgentKey, ChatMessage, FsmState } from '../types/store';
import type { OutlineLandingTargetFile } from './ChatMessageBubble';
import { formatSuppressedBackendErrorTitle } from '../lib/errorUtils';

interface EditorRightPanelProps {
    chatAgent: AgentKey;
    chatActiveFile: string;
    visibleMessages: ChatMessage[];
    latestUserMessageId: string | null;
    agentOptions?: AgentKey[];
    fsmState: FsmState;
    isProseReviewSurface: boolean;
    isReviewMode: boolean;
    editingMessageId: string | null;
    editDraftValue: string;
    uiLanguage: 'zh-CN' | 'en-US';
    activeAgent: AgentKey;
    conversationByAgent: Record<string, string | null>;
    conversationIndexByAgent: Record<string, any[]>;
    suppressedErrors: any[];
    debugOpen: boolean;
    onSwitchAgent: (agent: AgentKey) => void;
    onCreateConversation: () => void;
    onSelectConversation: (id: string) => void;
    onRenameConversation: (id: string) => void;
    onArchiveConversation: (id: string) => void;
    onDeleteConversation: (id: string) => void;
    onConfirmDraft: () => void;
    onRollbackDraft: () => void;
    onRequestEdit: (messageId: string, text: string) => void;
    onEditDraftChange: (v: string) => void;
    onSubmitEdit: () => void;
    onCancelEdit: () => void;
    onLandOutlineMessage: (message: ChatMessage, targetFile: OutlineLandingTargetFile) => void;
    onCommandSubmit: (intent: string, clearComposer?: () => void) => void;
    onStopStream: () => void;
    onToggleDebug: (v: boolean) => void;
    onClearErrors: (v: any[]) => void;
}

export function EditorRightPanel({
    chatAgent, chatActiveFile, visibleMessages, latestUserMessageId,
    agentOptions, fsmState, isProseReviewSurface, isReviewMode,
    editingMessageId, editDraftValue, uiLanguage, activeAgent,
    conversationByAgent, conversationIndexByAgent,
    suppressedErrors, debugOpen,
    onSwitchAgent, onCreateConversation, onSelectConversation,
    onRenameConversation, onArchiveConversation, onDeleteConversation,
    onConfirmDraft, onRollbackDraft, onRequestEdit, onEditDraftChange,
    onSubmitEdit, onCancelEdit, onLandOutlineMessage,
    onCommandSubmit, onStopStream, onToggleDebug, onClearErrors,
}: EditorRightPanelProps) {
    const copy = getUiCopy(uiLanguage);
    const headingLabel = isProseReviewSurface
        ? '正文审阅台'
        : getAgentLabel(uiLanguage, chatAgent);
    const headingFile = isProseReviewSurface
        ? 'chapter_draft.md · 审核 Agent / 续写 Agent'
        : chatActiveFile;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-[rgba(255,255,255,0.032)] px-2 py-[6px]">
                <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <div className="text-[11px] font-medium text-[var(--color-dark-text-main)]">
                            {headingLabel}
                        </div>
                        <div className="truncate text-[9px] text-[var(--color-dark-text-faint)]">
                            {headingFile}
                        </div>
                    </div>
                    <div className="rounded-[8px] border border-[rgba(255,255,255,0.035)] bg-[rgba(255,255,255,0.01)] px-2 py-[2px] text-[8px] font-mono text-[var(--color-dark-text-faint)]">
                        {getFsmStateLabel(uiLanguage, fsmState)}
                    </div>
                </div>
            </div>
            <AgentConversationList
                agent={chatAgent}
                currentFileAgent={activeAgent}
                activeConversationId={conversationByAgent[chatAgent] ?? null}
                activeFile={chatActiveFile}
                conversations={conversationIndexByAgent[chatAgent] ?? []}
                agentOptions={agentOptions}
                onSwitchAgent={onSwitchAgent}
                onCreateConversation={onCreateConversation}
                onSelectConversation={onSelectConversation}
                onRenameConversation={onRenameConversation}
                onArchiveConversation={onArchiveConversation}
                onDeleteConversation={onDeleteConversation}
                disabled={fsmState === 'THINKING'}
            />
            {suppressedErrors.length > 0 && (
                <div className="border-b border-[#2b3440] bg-[#0b1119] px-3 py-2">
                    <div className="flex items-center justify-between">
                        <button
                            type="button"
                            className="text-[11px] font-mono text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                            onClick={() => onToggleDebug(!debugOpen)}
                        >
                            {debugOpen ? '▼' : '▶'} 已抑制 {suppressedErrors.length} 条后端错误
                        </button>
                        {debugOpen && (
                            <button
                                type="button"
                                className="text-[10px] font-mono text-[#8b949e] hover:text-[#c9d1d9] transition-colors"
                                onClick={() => onClearErrors([])}
                            >
                                清除
                            </button>
                        )}
                    </div>
                    {debugOpen && (
                        <div className="app-scrollbar mt-2 max-h-36 overflow-y-auto rounded border border-[#2b3440] bg-[#0a0f18] p-2 text-[11px] font-mono text-[#9ca3af]">
                            {[...suppressedErrors].reverse().map((item: any) => (
                                <div key={item.id} className="py-1 border-b border-[#1e2632] last:border-b-0">
                                    <div className="text-[#e5e7eb]">
                                        [{formatSuppressedBackendErrorTitle(item.code, copy)}] {item.reqId ? `(req:${item.reqId})` : ''}
                                    </div>
                                    <div className="text-[#9ca3af] break-all">{item.message}</div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            <ChatPanel
                messages={visibleMessages}
                fsmState={fsmState}
                onConfirmDraft={onConfirmDraft}
                onRollbackDraft={onRollbackDraft}
                isConfirmDisabled={fsmState === 'CONFLICT'}
                draftActionPending={'none' as any}
                editableUserMessageId={latestUserMessageId}
                onRequestEditUserMessage={onRequestEdit}
                editingUserMessageId={editingMessageId}
                editDraftValue={editDraftValue}
                onEditDraftChange={onEditDraftChange}
                onSubmitEditUserMessage={onSubmitEdit}
                onCancelEditUserMessage={onCancelEdit}
                canLandOutlineMessages={!isReviewMode && chatAgent === 'outline_agent'}
                onLandOutlineMessage={onLandOutlineMessage}
            />
            {!editingMessageId ? (
                <ChatComposerDock
                    isRunDisabled={fsmState === 'THINKING'}
                    isStreaming={fsmState === 'THINKING'}
                    submitLabel={copy.composer.send}
                    onSubmit={onCommandSubmit}
                    onStop={onStopStream}
                />
            ) : null}
        </div>
    );
}
