import { formatChapterList } from './chapterListFormat';

export const REASONING_FLUSH_DELAY_MS = 100;
export const ROLLING_STREAM_PREVIEW_LIMIT = 260;
export const ROLLING_STREAM_REASONING_LIMIT = 160;

export function compactList(values: number[] | undefined, empty = '无'): string {
    return formatChapterList(values, empty);
}

export function compactBriefText(value: unknown, limit = 56): string {
    const text = String(value || '').trim();
    if (!text) return '未填写';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1).trim()}…`;
}

export function compactProgressText(value: unknown, limit = 120): string {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit - 1).trim()}…`;
}

export function upsertProgressLine(lines: string[], prefix: string, value: string): void {
    if (!value) return;
    const nextLine = `${prefix}${value}`;
    const existingIndex = lines.findIndex((line) => line.startsWith(prefix));
    if (existingIndex >= 0) {
        lines[existingIndex] = nextLine;
    } else {
        lines.push(nextLine);
    }
}
