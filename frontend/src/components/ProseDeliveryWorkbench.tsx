import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    attachProseReviewReport,
    fetchProseDeliveryState,
    manualSaveProseDraft,
    refreshProseDeliveryState,
    requestProseRewrite,
    type ProseDeliveryPayload,
    type ProseReviewFinding,
} from '../api/proseDelivery';
import { ApiError } from '../api/client';
import { DraftActionPending } from '../types/store';
import { extractProseReviewReport } from '../lib/proseReviewExtraction';
import { MarkdownRender } from './MarkdownRender';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ReviewState = 'idle' | 'saving' | 'error';

interface ProseDeliveryWorkbenchProps {
    bookRef: { kind: 'book_name' | 'book_id'; value: string };
    draftContent: string;
    draftCommitId: string | null;
    draftActionPending: DraftActionPending;
    onDraftLoaded: (content: string, commitId: string | null, etag: string) => void;
    onConfirm: () => void;
    onRollback: () => void;
    onRunReviewAgent: () => void;
    onRewriteWithReview: (finding?: ProseReviewFinding) => void;
    onNotice: (notice: { type: 'success' | 'error' | 'info'; message: string; ts: number }) => void;
    latestReviewMessageText?: string;
}

function lineSlice(text: string, startLine: number, endLine: number): string {
    const lines = text.split('\n');
    return lines.slice(Math.max(0, startLine - 1), Math.max(startLine - 1, endLine)).join('\n');
}

function formatApiError(err: unknown, fallback: string): string {
    if (err instanceof ApiError) return err.message;
    if (err instanceof Error) return err.message;
    return fallback;
}

function reviewStatusLabel(status: string | undefined): string {
    switch (status) {
        case 'passed':
            return '通过';
        case 'problem':
            return '有问题';
        case 'stale':
            return '需重审';
        case 'not_started':
            return '未开始';
        case 'pending':
        default:
            return '待审';
    }
}

function authorStatusLabel(status: string | undefined): string {
    switch (status) {
        case 'rewrite_requested':
            return '已打回';
        case 'pending':
        default:
            return '待处理';
    }
}

function deliveryStatusLabel(status: string | undefined): string {
    switch (status) {
        case 'draft_ready':
            return '草稿待审';
        case 'manual_edit_saved':
            return '人工修改已保存';
        case 'review_ready':
            return '审核已记录';
        case 'rewrite_requested':
            return '已打回重写';
        case 'blocked':
            return '等待正文草稿';
        default:
            return '未初始化';
    }
}

function findingSeverityLabel(severity: string | undefined): string {
    switch ((severity || '').toLowerCase()) {
        case 'blocking':
        case 'fail':
        case 'error':
        case 'problem':
            return '阻塞';
        case 'warn':
        case 'warning':
            return '提醒';
        case 'info':
        default:
            return '记录';
    }
}

export const ProseDeliveryWorkbench: React.FC<ProseDeliveryWorkbenchProps> = ({
    bookRef,
    draftContent,
    draftCommitId,
    draftActionPending,
    onDraftLoaded,
    onConfirm,
    onRollback,
    onRunReviewAgent,
    onRewriteWithReview,
    onNotice,
    latestReviewMessageText = '',
}) => {
    const [payload, setPayload] = useState<ProseDeliveryPayload | null>(null);
    const [loading, setLoading] = useState(false);
    const [editorDraft, setEditorDraft] = useState(draftContent);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [reviewState, setReviewState] = useState<ReviewState>('idle');
    const [reviewSummary, setReviewSummary] = useState('');
    const [manualFinding, setManualFinding] = useState('');
    const [selectedChapter, setSelectedChapter] = useState<number | 'all'>('all');
    const [error, setError] = useState('');
    const editorScrollRef = useRef<HTMLTextAreaElement | null>(null);
    const previewScrollRef = useRef<HTMLDivElement | null>(null);
    const syncScrollLockRef = useRef(false);

    const state = payload?.state ?? null;
    const draftEtag = payload?.draft.etag ?? '';
    const spans = state?.draft_package.chapter_spans ?? [];
    const findings = state?.review_report.findings ?? [];
    const stale = Boolean(payload?.staleness.stale || state?.review_report.stale);
    const hasUnsavedEdit = editorDraft !== (payload?.draft.content ?? draftContent);
    const canArchive = Boolean(
        state
        && state.review_report.status === 'passed'
        && state.archive_state.eligible
        && !stale
        && !hasUnsavedEdit
        && draftActionPending === 'none',
    );

    const selectedPreview = useMemo(() => {
        if (selectedChapter === 'all') return editorDraft;
        const span = spans.find((item) => item.number === selectedChapter);
        if (!span) return editorDraft;
        return lineSlice(editorDraft, span.heading_line, span.end_line);
    }, [editorDraft, selectedChapter, spans]);

    const syncScroll = (source: HTMLElement, target: HTMLElement | null) => {
        if (!target || syncScrollLockRef.current) return;
        const sourceMax = source.scrollHeight - source.clientHeight;
        const targetMax = target.scrollHeight - target.clientHeight;
        if (sourceMax <= 0 || targetMax <= 0) return;
        syncScrollLockRef.current = true;
        target.scrollTop = (source.scrollTop / sourceMax) * targetMax;
        window.requestAnimationFrame(() => {
            syncScrollLockRef.current = false;
        });
    };

    const loadState = async (mode: 'fetch' | 'refresh' = 'fetch') => {
        if (!bookRef.value) return;
        setLoading(true);
        setError('');
        try {
            const next = mode === 'refresh'
                ? await refreshProseDeliveryState(bookRef)
                : await fetchProseDeliveryState(bookRef);
            setPayload(next);
            setEditorDraft(next.draft.content);
            onDraftLoaded(next.draft.content, next.draft.commit_id, next.draft.etag);
        } catch (err) {
            const message = formatApiError(err, '正文交付状态加载失败');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        setEditorDraft(draftContent);
    }, [draftContent]);

    useEffect(() => {
        void loadState('fetch');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookRef.kind, bookRef.value, draftCommitId]);

    const handleRefresh = async () => {
        await loadState('refresh');
    };

    const handleSave = async () => {
        if (!bookRef.value) return;
        setSaveState('saving');
        setError('');
        try {
            const next = await manualSaveProseDraft(bookRef, {
                content: editorDraft,
                base_etag: draftEtag,
            });
            setPayload(next);
            setEditorDraft(next.draft.content);
            onDraftLoaded(next.draft.content, next.draft.commit_id, next.draft.etag);
            setSaveState('saved');
            onNotice({ type: 'success', message: '人工修改已保存，旧审核已标记为需要重审。', ts: Date.now() });
        } catch (err) {
            const message = formatApiError(err, '保存正文草稿失败');
            setSaveState('error');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    const handleAttachManualFinding = async () => {
        if (!manualFinding.trim()) return;
        setReviewState('saving');
        setError('');
        try {
            const chapterNumber = selectedChapter === 'all' ? null : selectedChapter;
            const next = await attachProseReviewReport(bookRef, {
                summary: reviewSummary || '作者手动标记审核问题。',
                findings: [
                    ...findings,
                    {
                        id: `human-${Date.now()}`,
                        chapter_number: chapterNumber,
                        severity: 'blocking',
                        status: 'open',
                        message: manualFinding.trim(),
                        suggestion: manualFinding.trim(),
                    },
                ],
            });
            setPayload(next);
            setManualFinding('');
            setReviewState('idle');
            onNotice({ type: 'success', message: '审核问题已写入正文交付状态。', ts: Date.now() });
        } catch (err) {
            const message = formatApiError(err, '写入审核问题失败');
            setReviewState('error');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    const handleMarkPassed = async () => {
        setReviewState('saving');
        setError('');
        try {
            const next = await attachProseReviewReport(bookRef, {
                summary: reviewSummary || '作者确认本轮审核未发现阻塞问题。',
                findings: [],
            });
            setPayload(next);
            setReviewState('idle');
            onNotice({ type: 'success', message: '已标记审核通过。归档仍需作者点击确认。', ts: Date.now() });
        } catch (err) {
            const message = formatApiError(err, '标记审核通过失败');
            setReviewState('error');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    const handleSyncLatestReview = async () => {
        const reviewText = latestReviewMessageText.trim();
        if (!reviewText) {
            onNotice({ type: 'info', message: '还没有可同步的审核 Agent 回复。', ts: Date.now() });
            return;
        }
        setReviewState('saving');
        setError('');
        try {
            const extracted = extractProseReviewReport(reviewText, spans);
            const next = await attachProseReviewReport(bookRef, {
                summary: extracted.summary || '已同步审核 Agent 最近一次回复。',
                findings: extracted.findings,
            });
            setPayload(next);
            setReviewSummary(extracted.summary);
            setReviewState('idle');
            onNotice({
                type: extracted.findings.length > 0 ? 'success' : 'info',
                message: extracted.findings.length > 0
                    ? `已同步 ${extracted.findings.length} 条审核问题。`
                    : '审核回复未识别到阻塞问题，已按通过记录；归档仍需作者确认。',
                ts: Date.now(),
            });
        } catch (err) {
            const message = formatApiError(err, '同步审核回复失败');
            setReviewState('error');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    const handleRewriteFinding = async (finding: ProseReviewFinding) => {
        try {
            const next = await requestProseRewrite(bookRef, {
                finding_id: finding.id,
                instruction: finding.suggestion || finding.message,
            });
            setPayload(next);
            onRewriteWithReview(finding);
        } catch (err) {
            const message = formatApiError(err, '登记重写请求失败');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    return (
        <div className="flex h-full min-h-0 flex-col bg-[rgba(9,11,15,0.72)]">
            <div className="border-b border-[rgba(255,255,255,0.04)] px-4 py-3">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="cursor-section-label">正文交付台</div>
                        <div className="mt-1 text-[15px] font-semibold text-[var(--color-dark-text-main)]">
                            chapter_draft.md 审核与归档
                        </div>
                        <div className="mt-1 text-[11px] text-[var(--color-dark-text-faint)]">
                            {state?.draft_commit ? `草稿 ${state.draft_commit.slice(0, 8)}` : '等待草稿'} · {spans.length} 个章节段
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={handleRefresh}
                            disabled={loading || draftActionPending !== 'none'}
                            className="rounded-[8px] border border-[rgba(255,255,255,0.1)] px-3 py-1.5 text-[11px] text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {loading ? '刷新中' : '刷新状态'}
                        </button>
                    </div>
                </div>
                {error ? (
                    <div className="mt-3 rounded-[8px] border border-[var(--tone-danger-border)] bg-[var(--tone-danger-bg)] px-3 py-2 text-[12px] text-[var(--tone-danger-text)]">
                        {error}
                    </div>
                ) : null}
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(0,1fr)] overflow-hidden">
                <aside className="app-scrollbar min-h-0 overflow-y-auto border-r border-[rgba(255,255,255,0.04)] p-3">
                    <div className="workspace-strip-muted rounded-[8px] p-3">
                        <div className="cursor-section-label">章节状态</div>
                        <div className="mt-2 space-y-1.5">
                            <button
                                type="button"
                                onClick={() => setSelectedChapter('all')}
                                className={`w-full rounded-[8px] px-2.5 py-2 text-left text-[11px] ${selectedChapter === 'all' ? 'cursor-chip-active' : 'text-[var(--color-dark-text-muted)] hover:bg-[rgba(255,255,255,0.04)]'}`}
                            >
                                全部草稿
                            </button>
                            {spans.map((span) => (
                                <button
                                    key={`${span.number}-${span.heading_line}`}
                                    type="button"
                                    onClick={() => setSelectedChapter(span.number)}
                                    className={`w-full rounded-[8px] px-2.5 py-2 text-left text-[11px] ${selectedChapter === span.number ? 'cursor-chip-active' : 'text-[var(--color-dark-text-muted)] hover:bg-[rgba(255,255,255,0.04)]'}`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="truncate">第{span.number}章 {span.title || '未命名'}</span>
                                        <span className={span.review_status === 'problem' ? 'text-[var(--tone-warning-text)]' : 'text-[var(--tone-success-text)]'}>
                                            {reviewStatusLabel(span.review_status)}
                                        </span>
                                    </div>
                                    <div className="mt-1 text-[10px] text-[var(--color-dark-text-faint)]">
                                        {span.heading_line}-{span.end_line} 行 · {authorStatusLabel(span.author_status)}
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="mt-3 workspace-strip-muted rounded-[8px] p-3">
                        <div className="cursor-section-label">交付状态</div>
                        <div className="mt-2 space-y-1.5 text-[11px] text-[var(--color-dark-text-muted)]">
                            <div>阶段：{deliveryStatusLabel(state?.status)}</div>
                            <div>审核：{reviewStatusLabel(state?.review_report.status)}</div>
                            <div>归档：{canArchive ? '可由作者确认' : '需先审核通过'}</div>
                            {stale ? <div className="text-[var(--tone-warning-text)]">状态需要刷新或重审</div> : null}
                            {hasUnsavedEdit ? <div className="text-[var(--tone-warning-text)]">有未保存修改</div> : null}
                            {state?.archive_state.blocked_reason === 'review_findings_require_rewrite_or_author_approval' ? (
                                <div className="text-[var(--tone-warning-text)]">有审核问题，需打回重写或人工修改后再确认通过</div>
                            ) : null}
                        </div>
                    </div>

                    <div className="mt-3 space-y-2">
                        <button
                            type="button"
                            onClick={handleSave}
                            disabled={!hasUnsavedEdit || saveState === 'saving' || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[rgba(96,165,250,0.48)] bg-[rgba(37,99,235,0.12)] px-3 py-2 text-[12px] font-semibold text-[#bfdbfe] hover:bg-[rgba(37,99,235,0.18)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {saveState === 'saving' ? '保存中' : '保存人工修改'}
                        </button>
                        <button
                            type="button"
                            onClick={handleMarkPassed}
                            disabled={reviewState === 'saving' || hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-success-text)] hover:bg-[rgba(255,255,255,0.1)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            标记审核通过
                        </button>
                        <button
                            type="button"
                            onClick={onRunReviewAgent}
                            disabled={hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[rgba(255,255,255,0.12)] px-3 py-2 text-[12px] font-semibold text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            启动审核 Agent
                        </button>
                        <button
                            type="button"
                            onClick={handleSyncLatestReview}
                            disabled={!latestReviewMessageText.trim() || reviewState === 'saving' || hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[rgba(255,255,255,0.12)] px-3 py-2 text-[12px] font-semibold text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            同步最近审核回复
                        </button>
                        <button
                            type="button"
                            onClick={onConfirm}
                            disabled={!canArchive}
                            className="w-full rounded-[8px] border border-[var(--tone-success-border)] bg-[rgba(16,185,129,0.12)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-success-text)] hover:bg-[rgba(16,185,129,0.18)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            归入正文归档
                        </button>
                        <button
                            type="button"
                            onClick={onRollback}
                            disabled={draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[var(--tone-danger-border)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-danger-text)] hover:bg-[var(--tone-danger-bg)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            放弃本轮草稿
                        </button>
                    </div>
                </aside>

                <main className="grid min-h-0 grid-rows-[minmax(0,1fr)_220px]">
                    <div className="grid min-h-0 grid-cols-2 overflow-hidden">
                        <section className="min-h-0 border-r border-[rgba(255,255,255,0.04)]">
                            <div className="border-b border-[rgba(255,255,255,0.035)] px-3 py-2 text-[11px] font-semibold text-[var(--color-dark-text-muted)]">
                                可直接修改的草稿
                            </div>
                            <textarea
                                ref={editorScrollRef}
                                value={editorDraft}
                                onChange={(event) => setEditorDraft(event.target.value)}
                                onScroll={(event) => syncScroll(event.currentTarget, previewScrollRef.current)}
                                spellCheck={false}
                                className="app-scrollbar h-[calc(100%-34px)] w-full resize-none bg-[rgba(7,10,14,0.72)] px-4 py-3 font-mono text-[13px] leading-6 text-[var(--color-dark-text-main)] outline-none"
                            />
                        </section>
                        <section className="min-h-0">
                            <div className="border-b border-[rgba(255,255,255,0.035)] px-3 py-2 text-[11px] font-semibold text-[var(--color-dark-text-muted)]">
                                当前预览
                            </div>
                            <div
                                ref={previewScrollRef}
                                onScroll={(event) => syncScroll(event.currentTarget, editorScrollRef.current)}
                                className="app-scrollbar h-[calc(100%-34px)] overflow-y-auto px-5 py-4"
                            >
                                <MarkdownRender content={selectedPreview} />
                            </div>
                        </section>
                    </div>

                    <section className="min-h-0 border-t border-[rgba(255,255,255,0.04)] p-3">
                        <div className="grid h-full grid-cols-[minmax(0,1fr)_260px] gap-3">
                            <div className="min-h-0">
                                <div className="cursor-section-label">审核问题</div>
                                <div className="app-scrollbar mt-2 max-h-[160px] space-y-2 overflow-y-auto">
                                    {findings.length === 0 ? (
                                        <div className="rounded-[8px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.015)] px-3 py-3 text-[12px] text-[var(--color-dark-text-faint)]">
                                            还没有结构化审核问题。作者可以直接标记通过，也可以让审核 Agent 先看一轮。
                                        </div>
                                    ) : findings.map((finding) => (
                                        <div key={finding.id} className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.018)] px-3 py-2">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="text-[12px] font-semibold text-[var(--color-dark-text-main)]">
                                                        {finding.chapter_number ? `第${finding.chapter_number}章` : '全局'} · {findingSeverityLabel(finding.severity)}
                                                    </div>
                                                    <div className="mt-1 text-[11px] leading-5 text-[var(--color-dark-text-muted)]">
                                                        {finding.message || finding.suggestion}
                                                    </div>
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => { void handleRewriteFinding(finding); }}
                                                    className="shrink-0 rounded-[8px] border border-[var(--tone-warning-border)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--tone-warning-text)] hover:bg-[rgba(245,158,11,0.08)]"
                                                >
                                                    打回重写
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="min-h-0">
                                <div className="cursor-section-label">作者标记</div>
                                <input
                                    value={reviewSummary}
                                    onChange={(event) => setReviewSummary(event.target.value)}
                                    placeholder="本轮审核摘要，可留空"
                                    className="mt-2 h-9 w-full rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(7,10,14,0.72)] px-3 text-[12px] text-[var(--color-dark-text-main)] outline-none placeholder:text-[var(--color-dark-text-faint)]"
                                />
                                <textarea
                                    value={manualFinding}
                                    onChange={(event) => setManualFinding(event.target.value)}
                                    placeholder="写下需要打回的问题或修改要求"
                                    className="mt-2 h-[72px] w-full resize-none rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-[rgba(7,10,14,0.72)] px-3 py-2 text-[12px] leading-5 text-[var(--color-dark-text-main)] outline-none placeholder:text-[var(--color-dark-text-faint)]"
                                />
                                <button
                                    type="button"
                                    onClick={handleAttachManualFinding}
                                    disabled={!manualFinding.trim() || reviewState === 'saving'}
                                    className="mt-2 w-full rounded-[8px] border border-[var(--tone-warning-border)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-warning-text)] hover:bg-[rgba(245,158,11,0.08)] disabled:cursor-not-allowed disabled:opacity-45"
                                >
                                    记录问题
                                </button>
                            </div>
                        </div>
                    </section>
                </main>
            </div>
        </div>
    );
};
