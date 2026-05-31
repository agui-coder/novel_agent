import { invokeApi, bookRefToArgs, BookRef } from './client';

// Direct HTTP calls to external tomato APIs (no backend proxy needed)
async function getJson<T>(url: string, opts?: RequestInit): Promise<T> {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

export interface TomatoImportIssue {
    severity: 'block' | 'warn';
    code: string;
    message: string;
    chapter?: string;
    first?: string;
    missing_indices?: number[];
    non_whitespace_chars?: number;
    line_count?: number;
    avg_chars_per_line?: number;
}

export interface TomatoImportQuality {
    can_confirm: boolean;
    risk_level: 'ok' | 'warn' | 'block';
    block_count: number;
    warn_count: number;
    issues: TomatoImportIssue[];
}

export interface TomatoChapterPreview {
    index: number;
    title: string;
    source_file: string;
    target_file: string;
    content_hash: string;
    chars: number;
    non_whitespace_chars: number;
    line_count: number;
    warnings: string[];
}

export interface TomatoImportReport {
    source_dir: string;
    metadata_file: string | null;
    book_name: string;
    chapter_count: number;
    total_non_whitespace_chars: number;
    warnings: Array<Record<string, unknown>>;
    source_files: string[];
}

export interface TomatoImportPreview {
    status: 'success';
    book_name: string;
    source_dir: string;
    metadata: Record<string, string>;
    report: TomatoImportReport;
    quality: TomatoImportQuality;
    chapters: TomatoChapterPreview[];
}

export interface TomatoImportConfirm extends TomatoImportPreview {
    book_id: string;
    saved_count: number;
    written_files: string[];
    force_used: boolean;
    commit_id: string;
}

export interface TomatoImportPayload {
    source_dir: string;
    allowed_root?: string;
    book_id?: string;
    book_name?: string;
    overwrite?: boolean;
    force?: boolean;
}

export interface LocalImportPreview {
    book_name: string; source_dir: string; chapter_count: number; total_chars: number;
    chapters: Array<{ index: number; title: string; source_file: string; target_file: string; chars: number }>;
    warnings: string[];
}

export interface LocalImportResult {
    book_id: string; book_name: string; saved_count: number; written_files: string[];
}

export async function previewTomatoImport(payload: TomatoImportPayload): Promise<TomatoImportPreview> {
    const dir = payload.source_dir || '';
    if (!dir) return { status: 'success', book_name: '', source_dir: '', metadata: {}, report: { source_dir: '', metadata_file: null, book_name: '', chapter_count: 0, total_non_whitespace_chars: 0, warnings: [], source_files: [] }, quality: { can_confirm: false, risk_level: 'warn', block_count: 0, warn_count: 1, issues: [{ severity: 'warn', code: 'EMPTY_DIR', message: '请填写源目录路径' }] }, chapters: [] };

    const r = await invokeApi<LocalImportPreview>('import_preview', { sourceDir: dir });
    return {
        status: 'success', book_name: r.book_name, source_dir: r.source_dir,
        metadata: {}, report: { source_dir: r.source_dir, metadata_file: null, book_name: r.book_name, chapter_count: r.chapter_count, total_non_whitespace_chars: r.total_chars, warnings: r.warnings.map(w => ({ message: w } as Record<string, unknown>)), source_files: r.chapters.map(c => c.source_file) },
        quality: { can_confirm: r.chapter_count > 0, risk_level: r.chapter_count > 0 ? 'ok' : 'block', block_count: r.chapter_count > 0 ? 0 : 1, warn_count: r.warnings.length, issues: r.warnings.map(w => ({ severity: 'warn' as const, code: 'WARN', message: w })) },
        chapters: r.chapters.map(c => ({ index: c.index, title: c.title, source_file: c.source_file, target_file: c.target_file, content_hash: '', chars: c.chars, non_whitespace_chars: c.chars, line_count: 0, warnings: [] })),
    };
}

export async function confirmTomatoImport(payload: TomatoImportPayload): Promise<TomatoImportConfirm> {
    const r = await invokeApi<LocalImportResult>('import_confirm', {
        sourceDir: payload.source_dir || '',
        bookName: payload.book_name || '',
        bookId: payload.book_id || undefined,
    });
    return {
        status: 'success', book_id: r.book_id, book_name: r.book_name,
        source_dir: payload.source_dir || '', metadata: {}, report: { source_dir: '', metadata_file: null, book_name: r.book_name, chapter_count: r.saved_count, total_non_whitespace_chars: 0, warnings: [], source_files: r.written_files },
        quality: { can_confirm: true, risk_level: 'ok', block_count: 0, warn_count: 0, issues: [] },
        chapters: [], saved_count: r.saved_count, written_files: r.written_files, force_used: false, commit_id: '',
    };
}

// ---------------------------------------------------------------------------
// Online search & import
// ---------------------------------------------------------------------------

export interface TomatoSearchResult {
    book_id: string;
    book_name: string;
    author: string;
    word_count: number;
    chapter_count: number;
    cover_url: string;
    abstract: string;
}

export interface TomatoBookInfo {
    book_id: string;
    book_name: string;
    author: string;
    abstract: string;
    word_count: number;
    chapter_count: number;
}

export interface TomatoOnlineImportResult {
    status: 'success';
    book_id: string;
    book_name: string;
    author: string;
    chapter_count: number;
    saved_count: number;
    written_files: string[];
    quality: TomatoImportQuality;
    force_used: boolean;
    commit_id: string;
}

const SEARCH_URL = 'https://api5-normal-lf.fqnovel.com/reading/bookapi/search/page/v/';
const BOOK_INFO_URL = 'https://api5-normal-lf.fqnovel.com/reading/bookapi/book/get_info/v/';

export async function searchTomatoNovels(query: string, _count = 20): Promise<TomatoSearchResult[]> {
    try {
        const data = await getJson<any>(`${SEARCH_URL}?query=${encodeURIComponent(query)}&page=0&size=20`);
        const items = data?.search_book_resp_list || data?.data?.search_book_resp_list || [];
        return items.map((item: any) => ({
            book_id: String(item.book_id || ''),
            book_name: item.book_name || '',
            author: item.author || '',
            cover_url: item.thumb_url || '',
            abstract: (item.abstract || '').slice(0, 200),
            word_count: item.word_number || 0,
            chapter_count: item.total_chapter_count || 0,
        }));
    } catch { return []; }
}

export async function getTomatoBookInfo(bookId: string): Promise<TomatoBookInfo> {
    try {
        const data = await getJson<any>(`${BOOK_INFO_URL}?book_id=${bookId}`);
        const c = data?.data || data || {};
        return {
            book_id: bookId, book_name: c.book_name || c.original_book_name || '',
            author: c.author || '',
            abstract: c.abstract || c.description || '',
            chapter_count: c.total_chapter_count || 0, word_count: c.word_number || 0,
        };
    } catch {
        return { book_id: bookId, book_name: bookId, author: '', abstract: '', word_count: 0, chapter_count: 0 };
    }
}

export async function onlineImportTomatoNovel(
    bookId: string,
    options?: { overwrite?: boolean; force?: boolean },
): Promise<TomatoOnlineImportResult> {
    return { status: 'success', book_id: bookId, book_name: '', author: '', chapter_count: 0, saved_count: 0, written_files: [], quality: { can_confirm: true, risk_level: 'ok', block_count: 0, warn_count: 0, issues: [] }, force_used: false, commit_id: '' };
}

// ---------------------------------------------------------------------------
// Summary generation progress
// ---------------------------------------------------------------------------

export interface SummaryStatus {
    book_id: string;
    status: 'idle' | 'reading' | 'generating' | 'writing' | 'done' | 'empty' | 'failed' | 'no_chapters';
    batch?: number;
    total_batches?: number;
    chapter_count?: number;
    max_workers?: number;
    max_batch_chapters?: number;
    chars?: number;
    book_name?: string;
    error?: string;
}

export async function fetchSummaryStatus(bookId: string): Promise<SummaryStatus> {
    return { book_id: bookId, status: 'idle' };
}

export interface DownloadStatus {
    book_id: string;
    status: 'idle' | 'downloading';
    saved_chapters?: number;
    chapter_total?: number;
    state?: string;
}

export async function fetchDownloadStatus(bookId: string): Promise<DownloadStatus> {
    return { book_id: bookId, status: 'idle' };
}
