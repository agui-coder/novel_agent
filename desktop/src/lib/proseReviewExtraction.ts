import type { ProseChapterSpan, ProseReviewFinding } from '../api/proseDelivery';

const PROBLEM_KEYWORDS = [
    '问题',
    '风险',
    '冲突',
    '矛盾',
    '越界',
    '越过',
    '违反',
    '不符合',
    '不通过',
    '打回',
    '重写',
    '缺少',
    '缺乏',
    '空洞',
    '重复',
    '失衡',
    '断裂',
    '跳跃',
    '崩',
    '硬伤',
];

const REWRITE_REQUIRED_KEYWORDS = [
    '不通过',
    '打回',
    '重写',
    '必须重写',
    '需要重写',
    '阻塞',
    '硬伤',
    '严重',
    '越界',
    '越过',
    '冲突',
    '矛盾',
    '崩',
];

const AUTHOR_FIX_KEYWORDS = [
    '作者小修',
    '小修',
    '可小修',
    '作者自行修改',
    '作者可改',
    '归档前可',
    '建议',
    '补一句',
    '补充一句',
    '润色',
    '微调',
    '不影响归档',
    '可接受',
];

const PASS_KEYWORDS = [
    '通过',
    '可以归档',
    '未发现阻塞',
    '没有阻塞',
    '没有明显问题',
    '可接受',
];

const PASS_LIKE_PATTERNS = [
    /未发现.{0,8}(?:阻塞|问题|冲突|硬伤)/,
    /没有.{0,8}(?:阻塞|问题|冲突|硬伤)/,
    /暂无.{0,8}(?:阻塞|问题|冲突|硬伤)/,
    /可以.{0,4}(?:通过|归档|接受)/,
];

const CHINESE_DIGIT_MAP = new Map([
    ['零', 0],
    ['〇', 0],
    ['一', 1],
    ['二', 2],
    ['两', 2],
    ['三', 3],
    ['四', 4],
    ['五', 5],
    ['六', 6],
    ['七', 7],
    ['八', 8],
    ['九', 9],
]);

function normalizeText(value: string): string {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function parseChineseInteger(value: string): number | null {
    const text = value.trim();
    if (!text) return null;
    if (/^\d+$/.test(text)) return Number(text);
    let result = 0;
    let section = 0;
    let number = 0;
    const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
    for (const char of text) {
        if (CHINESE_DIGIT_MAP.has(char)) {
            number = CHINESE_DIGIT_MAP.get(char) ?? 0;
            continue;
        }
        if (char === '万') {
            section = (section + number) * 10000;
            result += section;
            section = 0;
            number = 0;
            continue;
        }
        const unit = units[char];
        if (unit) {
            section += (number || 1) * unit;
            number = 0;
        }
    }
    const parsed = result + section + number;
    return parsed > 0 ? parsed : null;
}

function extractChapterNumber(text: string, spans: ProseChapterSpan[]): number | null {
    const explicit = text.match(/(?:第|CH|Ch|ch)\s*([零〇一二两三四五六七八九十百千万\d]+)\s*(?:章|回|节|话)?/);
    const parsed = explicit ? parseChineseInteger(explicit[1]) : null;
    if (parsed) return parsed;
    const titleHit = spans.find((span) => span.title && text.includes(span.title));
    return titleHit?.number ?? null;
}

function hasAnyKeyword(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
}

function isRewriteRequiredBlock(text: string): boolean {
    if (isPassLikeBlock(text) && !/(?:但是|但|不过|仍然|仍需|打回|重写|硬伤|严重|越界|越过|冲突|矛盾)/.test(text)) {
        return false;
    }
    return hasAnyKeyword(text, REWRITE_REQUIRED_KEYWORDS);
}

function isAuthorFixBlock(text: string): boolean {
    return hasAnyKeyword(text, AUTHOR_FIX_KEYWORDS) && !isRewriteRequiredBlock(text);
}

function isPassLikeBlock(text: string): boolean {
    return PASS_LIKE_PATTERNS.some((pattern) => pattern.test(text)) || hasAnyKeyword(text, PASS_KEYWORDS);
}

function isProblemBlock(text: string): boolean {
    if (isAuthorFixBlock(text)) return false;
    if (!hasAnyKeyword(text, PROBLEM_KEYWORDS)) return false;
    if (isPassLikeBlock(text) && !/(?:但是|但|不过|仍然|仍需|打回|重写|硬伤|严重|越界|越过|冲突|矛盾)/.test(text)) {
        return false;
    }
    if (!isPassLikeBlock(text)) return true;
    return /(?:但是|但|不过|仍然|仍需|打回|重写|硬伤|严重|越界|越过|冲突|矛盾)/.test(text);
}

function splitReviewBlocks(text: string): string[] {
    const normalized = normalizeText(text);
    if (!normalized) return [];
    const paragraphs = normalized
        .split(/\n{2,}/)
        .map((block) => block.replace(/^\s*[-*+]\s+/gm, '').trim())
        .filter(Boolean);
    if (paragraphs.length > 1) return paragraphs;
    return normalized
        .split('\n')
        .map((line) => line.replace(/^\s*(?:[-*+]|\d+[.、])\s*/, '').trim())
        .filter(Boolean);
}

export function extractProseReviewReport(
    reviewText: string,
    spans: ProseChapterSpan[],
): { summary: string; findings: ProseReviewFinding[]; passed: boolean; decision: 'passed' | 'author_fix' | 'rewrite_required' } {
    const normalized = normalizeText(reviewText);
    if (!normalized) return { summary: '', findings: [], passed: false, decision: 'rewrite_required' };

    const blocks = splitReviewBlocks(normalized);
    const findings = blocks
        .filter(isProblemBlock)
        .slice(0, 12)
        .map((block, index) => {
            const chapterNumber = extractChapterNumber(block, spans);
            return {
                id: `review-${Date.now()}-${index + 1}`,
                chapter_number: chapterNumber,
                severity: 'blocking',
                status: 'open',
                message: block,
                suggestion: block,
            };
        });

    const passed = findings.length === 0 && isPassLikeBlock(normalized);
    const hasAuthorFix = blocks.some(isAuthorFixBlock) || hasAnyKeyword(normalized, AUTHOR_FIX_KEYWORDS);
    const decision = findings.length > 0 ? 'rewrite_required' : (hasAuthorFix ? 'author_fix' : 'passed');
    const summary = normalized.length > 360 ? `${normalized.slice(0, 360).trim()}……` : normalized;
    return { summary, findings, passed: passed || decision === 'author_fix', decision };
}
