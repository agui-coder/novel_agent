import { AgentKey, ConversationMeta } from '../types/store';

interface BookRef {
    kind: 'book_name' | 'book_id';
    value: string;
}

export interface ConversationRecordPayload {
    id: string; ts: string; role: 'user' | 'assistant' | 'system';
    text: string; conversation_id: string; upstream_conversation_id?: string | null;
    active_file: string; target_draft_commit?: string | null;
    status: 'streaming' | 'done' | 'error' | 'interrupted';
}

export interface ConversationContextResponse {
    status: 'success'; book_id: string; agent_key: AgentKey;
    active_conversation_id: string | null; conversation_id: string | null;
    upstream_conversation_id: string | null; conversations: ConversationMeta[];
    messages: ConversationRecordPayload[];
}

function genId(): string {
    return `t_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function emptyContext(bookRef: BookRef, agentKey: AgentKey, conversationId?: string | null): ConversationContextResponse {
    const id = conversationId || genId();
    return {
        status: 'success', book_id: bookRef.value, agent_key: agentKey,
        active_conversation_id: id, conversation_id: id, upstream_conversation_id: null,
        conversations: [], messages: [],
    };
}

// Local conversation management (no backend needed in Tauri desktop)
export async function fetchConversationContext(bookRef: BookRef, agentKey: AgentKey, conversationId?: string | null): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey, conversationId);
}

export async function createConversation(bookRef: BookRef, agentKey: AgentKey, _activeFile: string, _title?: string): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey);
}

export async function activateConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey, conversationId);
}

export async function renameConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string, _title: string): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey, conversationId);
}

export async function archiveConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey, conversationId);
}

export async function deleteConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    return emptyContext(bookRef, agentKey, conversationId);
}
