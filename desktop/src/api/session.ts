import { AgentKey, ConversationMeta } from '../types/store';

const STORAGE_KEY = 'novel-agent-conversations';

interface BookRef { kind: 'book_name' | 'book_id'; value: string; }

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

interface StoredConversation {
    id: string; agent_key: AgentKey; book_key: string; title: string;
    created_at: string; messages: ConversationRecordPayload[];
}

function genId(): string { return `c_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
function bookKey(ref: BookRef): string { return `${ref.kind}:${ref.value}`; }

function loadAll(): StoredConversation[] {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveAll(data: StoredConversation[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

function emptyResponse(bookRef: BookRef, agentKey: AgentKey, conversationId?: string | null): ConversationContextResponse {
    const id = conversationId || genId();
    return { status: 'success', book_id: bookRef.value, agent_key: agentKey, active_conversation_id: id, conversation_id: id, upstream_conversation_id: null, conversations: [], messages: [] };
}

export async function fetchConversationContext(bookRef: BookRef, agentKey: AgentKey, conversationId?: string | null): Promise<ConversationContextResponse> {
    const all = loadAll().filter(c => c.book_key === bookKey(bookRef) && c.agent_key === agentKey);
    const conversations: ConversationMeta[] = all.map(c => ({ conversation_id: c.id, title: c.title, created_at: c.created_at, updated_at: c.created_at, last_active_file: '', message_count: c.messages.length }));
    if (conversationId) {
        const found = all.find(c => c.id === conversationId);
        return { status: 'success', book_id: bookRef.value, agent_key: agentKey, active_conversation_id: conversationId, conversation_id: conversationId, upstream_conversation_id: null, conversations, messages: found?.messages || [] };
    }
    const id = all.length > 0 ? all[all.length - 1].id : genId();
    return { status: 'success', book_id: bookRef.value, agent_key: agentKey, active_conversation_id: id, conversation_id: id, upstream_conversation_id: null, conversations, messages: [] };
}

export async function createConversation(bookRef: BookRef, agentKey: AgentKey, _activeFile: string, title?: string): Promise<ConversationContextResponse> {
    const id = genId();
    const all = loadAll();
    all.push({ id, agent_key: agentKey, book_key: bookKey(bookRef), title: title || `New ${agentKey}`, created_at: new Date().toISOString(), messages: [] });
    saveAll(all);
    return { status: 'success', book_id: bookRef.value, agent_key: agentKey, active_conversation_id: id, conversation_id: id, upstream_conversation_id: null, conversations: all.filter(c => c.book_key === bookKey(bookRef) && c.agent_key === agentKey).map(c => ({ conversation_id: c.id, title: c.title, created_at: c.created_at, updated_at: c.created_at, last_active_file: '', message_count: c.messages.length })), messages: [] };
}

export async function activateConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    return fetchConversationContext(bookRef, agentKey, conversationId);
}

export async function renameConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string, title: string): Promise<ConversationContextResponse> {
    const all = loadAll();
    const found = all.find(c => c.id === conversationId);
    if (found) { found.title = title; saveAll(all); }
    return fetchConversationContext(bookRef, agentKey, conversationId);
}

export async function archiveConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    const all = loadAll().filter(c => !(c.id === conversationId && c.book_key === bookKey(bookRef) && c.agent_key === agentKey));
    saveAll(all);
    return emptyResponse(bookRef, agentKey);
}

export async function deleteConversation(bookRef: BookRef, agentKey: AgentKey, conversationId: string): Promise<ConversationContextResponse> {
    return archiveConversation(bookRef, agentKey, conversationId);
}
