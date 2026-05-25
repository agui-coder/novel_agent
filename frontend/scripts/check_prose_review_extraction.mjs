import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transformSync } from 'esbuild';

const sourcePath = join(process.cwd(), 'src/lib/proseReviewExtraction.ts');
const source = readFileSync(sourcePath, 'utf8')
    .replace(/import type \{ ProseChapterSpan, ProseReviewFinding \} from '\.\.\/api\/proseDelivery';\n/, '');
const transformed = transformSync(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
}).code;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`;
const { extractProseReviewReport } = await import(moduleUrl);

const spans = [
    { number: 511, title: '风暴之前' },
    { number: 512, title: '旧债浮出' },
    { number: 513, title: '雨夜交锋' },
];

const problem = extractProseReviewReport(
    [
        '第512章问题：角色动机和上一章决定之间缺少承接，需要补一段因果。',
        '第513章风险：结尾越过本章大纲，建议收回到雨夜交锋结束。',
    ].join('\n'),
    spans,
);
if (problem.findings.length !== 2) {
    throw new Error(`expected 2 findings, got ${problem.findings.length}`);
}
if (problem.decision !== 'rewrite_required') {
    throw new Error(`expected rewrite_required decision, got ${problem.decision}`);
}
if (problem.findings[0].chapter_number !== 512 || problem.findings[1].chapter_number !== 513) {
    throw new Error(`unexpected chapter extraction: ${JSON.stringify(problem.findings)}`);
}

const passed = extractProseReviewReport('未发现阻塞问题，可以归档。', spans);
if (passed.findings.length !== 0 || !passed.passed || passed.decision !== 'passed') {
    throw new Error(`pass-like review was misclassified: ${JSON.stringify(passed)}`);
}

const authorFix = extractProseReviewReport('整体可以归档。第512章建议作者小修一句衔接，不影响归档。', spans);
if (authorFix.findings.length !== 0 || !authorFix.passed || authorFix.decision !== 'author_fix') {
    throw new Error(`author-fix review was misclassified: ${JSON.stringify(authorFix)}`);
}

console.log(`prose review extraction ok in ${tmpdir()}`);
