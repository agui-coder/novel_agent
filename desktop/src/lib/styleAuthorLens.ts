export const STYLE_AUTHOR_FILES = new Set([
    'style_guide.md',
    'style_fingerprint.md',
    'style_review.md',
    'style_constraints_for_continuation.md',
]);

export type StyleSectionTone = 'neutral' | 'accent' | 'warning';

export interface StyleMetricSnapshot {
    label?: string;
    chars?: number;
    paragraphs?: number;
    avgSentence?: number;
    avgPara?: number;
    dialogueRatio?: number;
    interiorDensity?: number;
    actionDensity?: number;
    environmentDensity?: number;
    expositionDensity?: number;
    suspenseDensity?: number;
}

export interface StyleMetricBadge {
    label: string;
    value: string;
    note: string;
}

export interface StyleAuthorSection {
    title: string;
    items: string[];
    tone: StyleSectionTone;
}

export interface StyleAuthorLens {
    eyebrow: string;
    title: string;
    sourceLabel: string;
    voiceSummary: string;
    sections: StyleAuthorSection[];
    evidenceTitle: string;
    evidenceItems: string[];
    metricBadges: StyleMetricBadge[];
    rawReportLabel: string;
}

const FILE_LABELS: Record<string, string> = {
    'style_guide.md': '作者文风偏好',
    'style_fingerprint.md': '原文近段手感证据',
    'style_review.md': '草稿文风偏差提示',
    'style_constraints_for_continuation.md': '续写文风参考卡',
};

function normalizeFileName(fileName: string): string {
    return String(fileName || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
}

export function isStyleAuthorFile(fileName?: string): boolean {
    return STYLE_AUTHOR_FILES.has(normalizeFileName(fileName || ''));
}

function asNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return undefined;
    const parsed = Number(value.replace('%', '').trim());
    if (!Number.isFinite(parsed)) return undefined;
    return value.includes('%') ? parsed / 100 : parsed;
}

function readJsonSnapshot(content: string): StyleMetricSnapshot {
    const match = content.match(/```json\s*([\s\S]*?)```/i);
    if (!match) return {};
    try {
        const parsed = JSON.parse(match[1]);
        const row = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!row || typeof row !== 'object') return {};
        return {
            label: typeof row.label === 'string' ? row.label : undefined,
            chars: asNumber(row.chars),
            paragraphs: asNumber(row.paragraphs),
            avgSentence: asNumber(row.avg_sentence),
            avgPara: asNumber(row.avg_para),
            dialogueRatio: asNumber(row.dialogue_ratio),
            interiorDensity: asNumber(row.interior_density),
            actionDensity: asNumber(row.action_density),
            environmentDensity: asNumber(row.environment_density),
            expositionDensity: asNumber(row.exposition_density),
            suspenseDensity: asNumber(row.suspense_density),
        };
    } catch {
        return {};
    }
}

function readMetricLine(content: string, label: string, percent = false): number | undefined {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = content.match(new RegExp(`${escaped}[：:]\\s*([0-9.]+%?)`));
    if (!match) return undefined;
    const raw = match[1];
    const parsed = Number(raw.replace('%', ''));
    if (!Number.isFinite(parsed)) return undefined;
    if (raw.includes('%')) return parsed / 100;
    if (percent && parsed > 1) return parsed / 100;
    return parsed;
}

function readMetrics(content: string): StyleMetricSnapshot {
    const jsonMetrics = readJsonSnapshot(content);
    return {
        label: jsonMetrics.label,
        chars: jsonMetrics.chars,
        paragraphs: jsonMetrics.paragraphs,
        avgSentence: jsonMetrics.avgSentence ?? readMetricLine(content, '句式呼吸'),
        avgPara: jsonMetrics.avgPara ?? readMetricLine(content, '段落节拍'),
        dialogueRatio: jsonMetrics.dialogueRatio ?? readMetricLine(content, '对白推进度', true),
        interiorDensity: jsonMetrics.interiorDensity ?? readMetricLine(content, '内心贴近度'),
        actionDensity: jsonMetrics.actionDensity ?? readMetricLine(content, '动作驱动度'),
        environmentDensity: jsonMetrics.environmentDensity ?? readMetricLine(content, '环境压迫感'),
        expositionDensity: jsonMetrics.expositionDensity ?? readMetricLine(content, '设定解释度'),
        suspenseDensity: jsonMetrics.suspenseDensity ?? readMetricLine(content, '悬念留白度'),
    };
}

function hasMetricBaseline(metrics: StyleMetricSnapshot): boolean {
    return metrics.avgSentence !== undefined || metrics.avgPara !== undefined || metrics.dialogueRatio !== undefined;
}

function formatNumber(value: number | undefined, suffix = ''): string {
    if (value === undefined) return '未记录';
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
}

function formatPercent(value: number | undefined): string {
    if (value === undefined) return '未记录';
    return `${Math.round(value * 100)}%`;
}

function sentenceNote(value?: number): string {
    if (value === undefined) return '句长缺少基准';
    if (value < 20) return '短句快切';
    if (value < 25) return '偏快推进';
    if (value <= 32) return '中长句承压';
    return '长句铺陈';
}

function paragraphNote(value?: number): string {
    if (value === undefined) return '段落缺少基准';
    if (value < 32) return '换气很勤';
    if (value <= 48) return '短段推进';
    if (value <= 80) return '中段承载';
    return '段落偏重';
}

function dialogueNote(value?: number): string {
    if (value === undefined) return '对白缺少基准';
    if (value < 0.18) return '对白克制';
    if (value <= 0.3) return '对白点到即止';
    return '对白承担推进';
}

function densityNote(value: number | undefined, low: string, mid: string, high: string): string {
    if (value === undefined) return '缺少基准';
    if (value < 4) return low;
    if (value < 8) return mid;
    return high;
}

function stripMarkdown(line: string): string {
    return line
        .replace(/^\s*[-*]\s+/, '')
        .replace(/`+/g, '')
        .replace(/\*\*/g, '')
        .trim();
}

function uniqueItems(items: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const raw of items) {
        const item = stripMarkdown(raw);
        if (!item || seen.has(item)) continue;
        seen.add(item);
        result.push(item);
    }
    return result;
}

function extractBulletsUnderHeadings(content: string, headings: string[]): string[] {
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    for (const heading of headings) {
        const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
        if (startIndex < 0) continue;
        for (const line of lines.slice(startIndex + 1)) {
            if (/^#{1,3}\s+/.test(line)) break;
            if (/^\s*[-*]\s+/.test(line)) {
                result.push(stripMarkdown(line));
            }
        }
    }
    return uniqueItems(result);
}

function extractParagraphsUnderHeadings(content: string, headings: string[]): string[] {
    const lines = content.split(/\r?\n/);
    const result: string[] = [];
    for (const heading of headings) {
        const startIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
        if (startIndex < 0) continue;
        for (const line of lines.slice(startIndex + 1)) {
            if (/^#{1,3}\s+/.test(line)) break;
            const trimmed = stripMarkdown(line);
            if (!trimmed || trimmed === '```json' || trimmed === '```' || /^[{}"]/.test(trimmed)) continue;
            result.push(trimmed);
        }
    }
    return uniqueItems(result);
}

function extractFirstMatch(content: string, patterns: RegExp[]): string | null {
    for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match?.[1]) return stripMarkdown(match[1]);
    }
    return null;
}

function buildMetricBadges(metrics: StyleMetricSnapshot): StyleMetricBadge[] {
    if (!hasMetricBaseline(metrics)) return [];
    return [
        { label: '句式', value: formatNumber(metrics.avgSentence, '字/句'), note: sentenceNote(metrics.avgSentence) },
        { label: '段落', value: formatNumber(metrics.avgPara, '字/段'), note: paragraphNote(metrics.avgPara) },
        { label: '对白', value: formatPercent(metrics.dialogueRatio), note: dialogueNote(metrics.dialogueRatio) },
        {
            label: '动作',
            value: formatNumber(metrics.actionDensity, '/千字'),
            note: densityNote(metrics.actionDensity, '动作很少', '动作参与推进', '动作驱动强'),
        },
        {
            label: '环境',
            value: formatNumber(metrics.environmentDensity, '/千字'),
            note: densityNote(metrics.environmentDensity, '环境轻', '环境承压', '环境压迫强'),
        },
        {
            label: '解释',
            value: formatNumber(metrics.expositionDensity, '/千字'),
            note: densityNote(metrics.expositionDensity, '解释很少', '解释适中', '解释偏密'),
        },
        {
            label: '留白',
            value: formatNumber(metrics.suspenseDensity, '/千字'),
            note: densityNote(metrics.suspenseDensity, '留白少', '留白稳定', '悬念密'),
        },
    ];
}

function metricSentence(metrics: StyleMetricSnapshot): string {
    if (!hasMetricBaseline(metrics)) {
        return '当前文件还没有可读数值基准，先以作者偏好和原文内容为准。';
    }
    const action = metrics.actionDensity ?? 0;
    const environment = metrics.environmentDensity ?? 0;
    const exposition = metrics.expositionDensity ?? 0;
    const driver = action >= environment && action >= exposition
        ? '人物行动和局势反应'
        : environment >= exposition
            ? '空间压力和现场气氛'
            : '设定解释和逻辑补足';
    return `${sentenceNote(metrics.avgSentence)}，${paragraphNote(metrics.avgPara)}，${dialogueNote(metrics.dialogueRatio)}，推进重心更偏向${driver}。`;
}

function buildEvidence(content: string, fileName: string, metrics: StyleMetricSnapshot): string[] {
    const normalized = normalizeFileName(fileName);
    const sample = extractFirstMatch(content, [
        /原文采样[：:]\s*([^\n]+)/,
        /对照样本[：:]\s*([^\n]+)/,
        /样本标签[：:]\s*([^\n]+)/,
    ]);
    const chapters = extractFirstMatch(content, [/原文章节[：:]\s*([^\n]+)/]);
    const evidence = [`当前文件：${FILE_LABELS[normalized] || normalized || '文风文件'}`];
    if (sample) evidence.push(sample);
    if (metrics.chars && metrics.paragraphs) {
        evidence.push(`样本规模：${metrics.chars} 字 / ${metrics.paragraphs} 段`);
    }
    if (chapters) evidence.push(`章节依据：${chapters}`);
    return evidence.slice(0, 4);
}

function buildGuideLens(content: string, fileName: string): StyleAuthorLens {
    const longTermPrefs = extractBulletsUnderHeadings(content, ['长期偏好', '作者偏好', '文风偏好']);
    const avoidPrefs = extractBulletsUnderHeadings(content, ['不想要的写法', '避雷写法', '禁忌']);
    return {
        eyebrow: '作者偏好',
        title: '作者文风偏好',
        sourceLabel: FILE_LABELS[normalizeFileName(fileName)] || normalizeFileName(fileName),
        voiceSummary: '这页由作者和文风助手共同维护，记录你长期想保留的口味。它是作者偏好，不是机器判罚，也不是原文统计证据。',
        sections: [
            {
                title: '当前偏好',
                items: longTermPrefs.length > 0 ? longTermPrefs.slice(0, 6) : [
                    '记录作者明确喜欢的叙述口味，例如节奏、镜头、对白密度、信息释放方式。',
                    '记录作者想长期保留的题材气质，例如克制、爽感、悬疑感、压迫感或幽默感。',
                    '只沉淀长期偏好；单章临时修订意见放在草稿审查或错误档案里。',
                ],
                tone: 'accent',
            },
            {
                title: '不要混入',
                items: avoidPrefs.length > 0 ? avoidPrefs.slice(0, 6) : [
                    '不要把剧情事实、世界规则、人物状态写进这里；它们属于世界模型和状态卡。',
                    '不要把原文统计指标当成作者命令；统计证据属于原文近段手感证据。',
                    '不要把草稿是否合格写成硬判罚；文风修改权最终属于作者。',
                ],
                tone: 'neutral',
            },
        ],
        evidenceTitle: '使用说明',
        evidenceItems: [
            '文风助手：根据作者讨论补充或修订本页。',
            '续写智能体：读取本页作为作者偏好，再结合原文近段自主模仿。',
            '作者：新卷、新轮回、新题材阶段切换时，可以直接更新这里。',
        ],
        metricBadges: [],
        rawReportLabel: '偏好原文',
    };
}

function buildFingerprintLens(content: string, fileName: string, metrics: StyleMetricSnapshot): StyleAuthorLens {
    const structure = [
        `句式：${formatNumber(metrics.avgSentence, '字/句')}，${sentenceNote(metrics.avgSentence)}。`,
        `段落：${formatNumber(metrics.avgPara, '字/段')}，${paragraphNote(metrics.avgPara)}。`,
        `对白：${formatPercent(metrics.dialogueRatio)}，${dialogueNote(metrics.dialogueRatio)}。`,
        `动作 / 环境 / 解释：${formatNumber(metrics.actionDensity, '/千字')}、${formatNumber(metrics.environmentDensity, '/千字')}、${formatNumber(metrics.expositionDensity, '/千字')}。`,
    ];
    return {
        eyebrow: '原文证据',
        title: '原文近段手感证据',
        sourceLabel: metrics.label || FILE_LABELS[normalizeFileName(fileName)] || normalizeFileName(fileName),
        voiceSummary: `这页只回答“原文最近怎么写”。它给续写提供模仿依据，不代表作者必须永远锁死在这个风格里。${metricSentence(metrics)}`,
        sections: [
            { title: '读到的手感', items: structure, tone: 'accent' },
            {
                title: '适合怎么用',
                items: [
                    '给续写智能体做近段模仿参考，不直接判定草稿通过或失败。',
                    '新轮回、新地图、新阶段切换时，重新生成它来刷新最近手感。',
                    '作者想主动改风格时，把这里当作“智能体当前读到的原文样本”，而不是命令。',
                ],
                tone: 'neutral',
            },
        ],
        evidenceTitle: '采样依据',
        evidenceItems: buildEvidence(content, fileName, metrics),
        metricBadges: buildMetricBadges(metrics),
        rawReportLabel: '证据原文',
    };
}

function buildReviewLens(content: string, fileName: string, metrics: StyleMetricSnapshot): StyleAuthorLens {
    const conclusions = extractParagraphsUnderHeadings(content, ['审查结论', '诊断摘要']);
    return {
        eyebrow: '草稿提示',
        title: '草稿文风偏差提示',
        sourceLabel: metrics.label || FILE_LABELS[normalizeFileName(fileName)] || normalizeFileName(fileName),
        voiceSummary: '这页看“草稿相对原文有没有偏”。它是给作者和续写智能体的打磨提示，不是剧情审核，也不是卡死演示流程的硬闸门。',
        sections: [
            {
                title: '当前提示',
                items: conclusions.length > 0 ? conclusions.slice(0, 6) : ['当前没有明确偏差结论，先以原始报告和作者判断为准。'],
                tone: 'warning',
            },
            {
                title: '修改边界',
                items: [
                    '只修影响阅读手感的偏差，剧情事件、胜负结果、人物动机和世界状态不在这里改。',
                    '轻微风格差异交给作者判断，不自动推倒重写。',
                    '需要重跑时先刷新近段证据，再让续写智能体参考原文和作者偏好自主模仿。',
                ],
                tone: 'neutral',
            },
        ],
        evidenceTitle: '诊断依据',
        evidenceItems: buildEvidence(content, fileName, metrics),
        metricBadges: buildMetricBadges(metrics),
        rawReportLabel: '提示原文',
    };
}

function buildContinuationLens(content: string, fileName: string, metrics: StyleMetricSnapshot): StyleAuthorLens {
    const references = extractBulletsUnderHeadings(content, ['写作参考', '写作硬约束']);
    const ranges = extractBulletsUnderHeadings(content, ['参考范围', '数值边界']);
    return {
        eyebrow: '续写参考',
        title: '续写文风参考卡',
        sourceLabel: metrics.label || FILE_LABELS[normalizeFileName(fileName)] || normalizeFileName(fileName),
        voiceSummary: `这页给续写智能体当软参考，只影响节奏、句式和信息释放。逐章大纲、世界模型、状态卡、剧情因果优先级更高。${metricSentence(metrics)}`,
        sections: [
            {
                title: '续写可参考',
                items: references.length > 0 ? references.slice(0, 5) : [
                    '先写人物选择、动作反应和代价，再补必要解释。',
                    '对白承担关键冲突或信息转折，避免连续问答顶替场景推进。',
                    '段落换气服务阅读节奏，不为了贴指标机械拆分。',
                ],
                tone: 'accent',
            },
            {
                title: '只作提示',
                items: ranges.length > 0 ? ranges.slice(0, 4) : [
                    '参考范围用于提醒，不单独决定章节能否继续推进。',
                    '诊断明显偏差时，只做局部语言修正，不改剧情事实。',
                    '作者可以接受、忽略或人工改写这些文风建议。',
                ],
                tone: 'warning',
            },
        ],
        evidenceTitle: '参考依据',
        evidenceItems: buildEvidence(content, fileName, metrics),
        metricBadges: buildMetricBadges(metrics),
        rawReportLabel: '参考卡原文',
    };
}

export function buildStyleAuthorLens(fileName: string, content: string): StyleAuthorLens {
    const metrics = readMetrics(content);
    const normalized = normalizeFileName(fileName);
    if (normalized === 'style_guide.md') {
        return buildGuideLens(content, fileName);
    }
    if (normalized === 'style_review.md') {
        return buildReviewLens(content, fileName, metrics);
    }
    if (normalized === 'style_constraints_for_continuation.md') {
        return buildContinuationLens(content, fileName, metrics);
    }
    return buildFingerprintLens(content, fileName, metrics);
}
