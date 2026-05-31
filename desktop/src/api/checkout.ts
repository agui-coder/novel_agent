import { invokeApi, ApiError, bookRefToArgs, BookRef } from './client';
import { HotFileItem, RepoIntegrity } from '../types/store';

// Rust response types use snake_case (serde default)
interface RustFileData {
    status: string; book_id: string; file_name: string;
    content: string; etag: string; exists: boolean; virtual_file: boolean;
    size_chars: number;
}

interface RustPingData {
    status: string; book_id: string; exists: boolean; layout_issues: string[];
}

interface RustWriteResult {
    status: string; book_id: string; file_name: string; new_etag: string; new_size: number;
}

interface RustInitResult {
    status: string; book_id: string; book_name: string; created: boolean;
}

export interface GetFileResponse {
    status: string; book_id: string; file_name: string;
    content: string; etag: string; exists: boolean; virtual_file: boolean;
    size_chars: number;
}

function defaultIntegrity(bookId: string): RepoIntegrity {
    return { bookId, exists: true, repoExists: true, headExists: true,
        headCommit: null, missingCoreFiles: [], missingDirectories: [],
        untrackedLayoutFiles: [], problemCodes: [], needsRepair: false };
}

export async function fetchMainlineFile(
    bookRef: BookRef, fileName: string
): Promise<{ content: string; etag: string; exists: boolean; virtual: boolean; integrity: RepoIntegrity }> {
    const data = await invokeApi<RustFileData>('get_file', {
        ...bookRefToArgs(bookRef), fileName,
    });
    if (!data.etag) {
        throw new ApiError(428, 'PRECONDITION_REQUIRED', 'No ETag in response');
    }
    return {
        content: data.content, etag: data.etag,
        exists: Boolean(data.exists), virtual: Boolean(data.virtual_file),
        integrity: defaultIntegrity(data.book_id),
    };
}

export async function fetchHotFiles(
    bookRef: BookRef
): Promise<{ files: HotFileItem[]; integrity: RepoIntegrity }> {
    const ping = await invokeApi<RustPingData>('ping_book', bookRefToArgs(bookRef));
    const files: HotFileItem[] = [
        { fileName: 'chapter_draft.md', fileType: 'chapter', label: '续写草稿', exists: true },
        { fileName: 'chapter_outline.md', fileType: 'outline', label: '章节大纲', exists: true },
        { fileName: 'world_model.md', fileType: 'world_core', label: '世界观底座', exists: true },
        { fileName: 'status_card.md', fileType: 'world_core', label: '状态卡', exists: true },
        { fileName: 'summary.md', fileType: 'summary', label: '剧情总纲', exists: true },
        { fileName: 'style_constraints_for_continuation.md', fileType: 'style', label: '文风参考卡', exists: true },
        { fileName: 'error_archive.md', fileType: 'error_archive', label: '错误档案', exists: true },
        { fileName: 'brainstorm.md', fileType: 'outline', label: '头脑风暴', exists: true },
        { fileName: 'master_outline.md', fileType: 'outline', label: '总纲', exists: true },
        { fileName: 'arc_outline.md', fileType: 'outline', label: '篇章大纲', exists: true },
    ];
    return { integrity: defaultIntegrity(ping.book_id), files };
}

export async function fetchRepoIntegrity(bookRef: BookRef): Promise<RepoIntegrity> {
    const ping = await invokeApi<RustPingData>('ping_book', bookRefToArgs(bookRef));
    return defaultIntegrity(ping.book_id);
}

export async function repairBookLayout(
    bookRef: BookRef
): Promise<{ integrity: RepoIntegrity; headCommit: string | null; repairCommits: string[] }> {
    const result = await invokeApi<RustInitResult>('init_book', bookRefToArgs(bookRef));
    return { integrity: defaultIntegrity(result.book_id), headCommit: null, repairCommits: [] };
}

export async function updateMainlineFile(
    bookRef: BookRef, fileName: string, content: string, baseEtag: string
): Promise<{ etag: string; commitId: string | null; message: string | null }> {
    const result = await invokeApi<RustWriteResult>('update_file', {
        ...bookRefToArgs(bookRef), fileName, content,
        baseEtag, origin: 'user', message: `live edit ${fileName}`,
    });
    return { etag: result.new_etag, commitId: null, message: null };
}
