// Demo mode utilities — no-op in Tauri desktop
export interface DemoSessionInfo {
    enabled: boolean; session_id?: string; expires_at?: number;
    remaining_seconds?: number; template_book_id?: string | null;
    import_chapter_limit?: number; world_init_limit?: number;
    world_init_used?: number; message?: string;
}
export function isPublicDemo(): boolean { return false; }
export function getDemoCookieName(): string { return ''; }
export async function fetchDemoSession(): Promise<DemoSessionInfo> {
    return { enabled: false };
}
