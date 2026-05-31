import { invoke } from '@tauri-apps/api/core';

export class ApiError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public data?: any
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

const BASE_URL = '';
const DEFAULT_TIMEOUT_MS = 30000;

function getTimeoutMs(_endpoint: string): number {
    return DEFAULT_TIMEOUT_MS;
}

// ── Legacy HTTP fetch (for SSE streaming and endpoints not yet migrated) ──

export async function fetchApi<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${BASE_URL}${endpoint}`;
    const timeoutMs = getTimeoutMs(endpoint);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    if (options.signal) {
        if (options.signal.aborted) {
            controller.abort();
        } else {
            options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
    }

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
    };

    let response: Response;
    let data: any;
    try {
        response = await fetch(url, { ...options, headers, signal: controller.signal });
        data = await response.json().catch(() => ({}));
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            throw new ApiError(504, 'REQUEST_TIMEOUT', `Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok || data.status === 'error') {
        if (response.status === 409 && data.code === 'CHAPTER_CANON_CONFLICT') {
            throw new ApiError(409, 'CHAPTER_CANON_CONFLICT', data.message || '章节归档保护：目标章节已存在。', data);
        }
        if (response.status === 409 && data.code === 'MERGE_CONFLICT') {
            const err = new ApiError(409, 'MERGE_CONFLICT', data.message || 'Merge conflict detected.', data) as ApiError & { conflictedFiles?: string[] };
            err.conflictedFiles = Array.isArray(data.conflicted_files) ? data.conflicted_files : [];
            throw err;
        }
        if (response.status === 409 && data.code === 'WORKTREE_DIRTY') {
            const err = new ApiError(409, 'WORKTREE_DIRTY', data.message || 'Worktree has uncommitted changes.', data) as ApiError & { entries?: unknown[] };
            err.entries = Array.isArray(data.entries) ? data.entries : [];
            throw err;
        }
        if (response.status === 409 || data.code === 'WRITE_CONFLICT') {
            throw new ApiError(409, 'WRITE_CONFLICT', data.message || 'Baseline modified by another process.', data);
        }
        if (response.status === 428 || data.code === 'PRECONDITION_REQUIRED') {
            throw new ApiError(428, 'PRECONDITION_REQUIRED', data.message || 'Missing required ETag.', data);
        }
        throw new ApiError(response.status, data.code || 'UNKNOWN_ERROR', data.message || 'An unknown API error occurred', data);
    }
    return data;
}

// ── Tauri IPC invoke wrapper ──

export async function invokeApi<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    try {
        const result = await invoke<T>(command, args);
        return result;
    } catch (error: any) {
        // Map Rust errors to ApiError
        const message = typeof error === 'string' ? error : (error?.message || 'Unknown IPC error');
        if (message.includes('ETag mismatch') || message.includes('WRITE_CONFLICT')) {
            throw new ApiError(409, 'WRITE_CONFLICT', message);
        }
        if (message.includes('not found') || message.includes('Book not found')) {
            throw new ApiError(404, 'NOT_FOUND', message);
        }
        if (message.includes('escapes book directory') || message.includes('Invalid file_name')) {
            throw new ApiError(400, 'INVALID_PAYLOAD', message);
        }
        throw new ApiError(500, 'IPC_ERROR', message);
    }
}

// ── Book reference helper ──

export type BookRef = { kind: 'book_name' | 'book_id'; value: string };

export function bookRefToArgs(ref: BookRef): { bookId?: string; bookName?: string } {
    return ref.kind === 'book_name' ? { bookName: ref.value } : { bookId: ref.value };
}

export function bookRefToQuery(ref: BookRef): string {
    return ref.kind === 'book_name'
        ? `book_name=${encodeURIComponent(ref.value)}`
        : `book_id=${encodeURIComponent(ref.value)}`;
}
