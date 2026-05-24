function normalizeChapterNumbers(values: number[] | undefined): number[] {
    if (!values) return [];
    return Array.from(new Set(
        values
            .filter((value) => Number.isFinite(value) && value > 0)
            .map((value) => Math.trunc(value))
    )).sort((a, b) => a - b);
}

function formatRanges(values: number[]): string[] {
    if (values.length === 0) return [];
    const ranges: string[] = [];
    let start = values[0];
    let previous = values[0];

    for (const value of values.slice(1)) {
        if (value === previous + 1) {
            previous = value;
            continue;
        }
        ranges.push(start === previous ? String(start) : `${start}-${previous}`);
        start = value;
        previous = value;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    return ranges;
}

export function formatChapterList(values: number[] | undefined, empty = '无'): string {
    const chapters = normalizeChapterNumbers(values);
    if (chapters.length === 0) return empty;
    if (chapters.length <= 12) return chapters.join(', ');

    const ranges = formatRanges(chapters);
    if (ranges.length <= 4) {
        return `${ranges.join('、')}（共 ${chapters.length} 章）`;
    }

    const head = chapters.slice(0, 8).join(', ');
    const tail = chapters.slice(-3).join(', ');
    return `${head} … ${tail}（共 ${chapters.length} 章）`;
}

export function formatChapterArchiveSummary(values: number[] | undefined, empty = '无'): string {
    const chapters = normalizeChapterNumbers(values);
    if (chapters.length === 0) return empty;

    const ranges = formatRanges(chapters);
    const rangeText = ranges.length <= 4
        ? ranges.join('、')
        : `${ranges.slice(0, 2).join('、')}…${ranges[ranges.length - 1]}`;

    return `已归档 ${chapters.length} 章（${rangeText}）`;
}
