import { fetchApi } from './client';

export interface DemoSessionInfo {
    enabled: boolean;
    session_id?: string;
    expires_at?: number;
    remaining_seconds?: number;
    template_book_id?: string | null;
    import_chapter_limit?: number;
    world_init_limit?: number;
    world_init_used?: number;
    message?: string;
}

export async function fetchDemoSession(): Promise<DemoSessionInfo> {
    return fetchApi<DemoSessionInfo>('/api/demo/session');
}
