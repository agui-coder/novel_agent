// @ts-nocheck - legacy component, types to be updated
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
import { ChatMessage, DraftActionPending } from '../types/store';
import { extractProseReviewReport } from '../lib/proseReviewExtraction';
import { MarkdownRender } from './MarkdownRender';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
type ReviewState = 'idle' | 'saving' | 'rewriting' | 'error';
type RewriteProgressStatus = 'idle' | 'registering' | 'running' | 'refreshing' | 'ready' | 'error';

interface RewriteProgress {
    status: RewriteProgressStatus;
    message: string;
    priorCommit: string | null;
    nextCommit: string | null;
}

interface RewriteStreamLine {
    id: string;
    label: string;
    text: string;
    tone?: 'warning' | 'success' | 'danger';
}

interface ProseDeliveryWorkbenchProps {
    bookRef: { kind: 'book_name' | 'book_id'; value: string };
    draftContent: string;
    draftCommitId: string | null;
    draftActionPending: DraftActionPending;
    onDraftLoaded: (content: string, commitId: string | null, etag: string) => void;
    onConfirm: () => void;
    onRollback: () => void;
    onRunReviewAgent: () => void;
    onRewriteWithReview: (finding?: ProseReviewFinding) => Promise<void> | void;
    onNotice: (notice: { type: 'success' | 'error' | 'info'; message: string; ts: number }) => void;
    latestReviewMessageText?: string;
    latestReviewTargetDraftCommit?: string | null;
    latestRewriteMessage?: ChatMessage | null;
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
        case 'rewrite_completed':
            return '已重写';
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
        case 'rewrite_completed':
            return '重写已返回';
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
    latestReviewTargetDraftCommit = null,
    latestRewriteMessage = null,
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
    const [rewriteProgress, setRewriteProgress] = useState<RewriteProgress>({
        status: 'idle',
        message: '',
        priorCommit: null,
        nextCommit: null,
    });
    const rewriteInFlightRef = useRef(false);
    const editorScrollRef = useRef<HTMLTextAreaElement | null>(null);
    const previewScrollRef = useRef<HTMLDivElement | null>(null);
    const rewriteStreamRef = useRef<HTMLDivElement | null>(null);
    const syncScrollLockRef = useRef(false);

    const state = payload?.state ?? null;
    const draftEtag = payload?.draft.etag ?? '';
    const spans = state?.draft_package.chapter_spans ?? [];
    const findings = state?.review_report.findings ?? [];
    const stale = Boolean(payload?.staleness.stale || state?.review_report.stale);
    const rewriteRequests = state?.rewrite_requests ?? [];
    const latestRewriteRequest = [...rewriteRequests].reverse()[0] ?? null;
    const latestCompletedRewriteRequest = [...rewriteRequests].reverse().find((item) => item.status === 'completed') ?? null;
    const latestReviewText = latestReviewMessageText.trim();
    const currentDraftCommit = payload?.draft.commit_id ?? state?.draft_commit ?? draftCommitId ?? null;
    const hasUnsavedEdit = editorDraft !== (payload?.draft.content ?? draftContent);
    const hasDraftWithoutDeliveryState = Boolean(payload && !payload.state && payload.draft.commit_id && payload.draft.content.trim());
    const latestReviewExtraction = useMemo(
        () => latestReviewText ? extractProseReviewReport(latestReviewText, spans) : null,
        [latestReviewText, spans],
    );
    const canAuthorAdoptLatestReview = Boolean(
        latestReviewExtraction
        && latestReviewExtraction.findings.length === 0
        && latestReviewExtraction.passed
        && currentDraftCommit
        && !latestReviewTargetDraftCommit,
    );
    const pendingRewrite = state?.status === 'rewrite_requested'
        || findings.some((finding) => finding.status === 'rewrite_requested');
    const rewriteStreamActive = reviewState === 'rewriting'
        || latestRewriteMessage?.status === 'streaming'
        || rewriteProgress.status === 'registering'
        || rewriteProgress.status === 'running'
        || rewriteProgress.status === 'refreshing';
    const rewriteBusy = reviewState === 'saving'
        || rewriteStreamActive;
    const rewriteTelemetryLines = useMemo(() => {
        const lines: RewriteStreamLine[] = [];
        if (rewriteProgress.status !== 'idle' && rewriteProgress.message) {
            lines.push({
                id: 'progress',
                label: '进度',
                text: rewriteProgress.message,
                tone: rewriteProgress.status === 'error'
                    ? 'danger'
                    : rewriteProgress.status === 'ready'
                        ? 'success'
                        : 'warning',
            });
        }
        if (rewriteProgress.priorCommit || rewriteProgress.nextCommit) {
            lines.push({
                id: 'commit',
                label: '草稿版本',
                text: `${rewriteProgress.priorCommit ? rewriteProgress.priorCommit.slice(0, 8) : '未知'} -> ${rewriteProgress.nextCommit ? rewriteProgress.nextCommit.slice(0, 8) : '等待写入'}`,
            });
        }
        if (latestCompletedRewriteRequest?.completed_draft_commit) {
            lines.push({
                id: 'completed',
                label: '最近完成',
                text: `已收到新草稿 ${latestCompletedRewriteRequest.completed_draft_commit.slice(0, 8)}`,
                tone: 'success',
            });
        } else if (latestRewriteRequest?.status === 'requested') {
            lines.push({
                id: 'request',
                label: '打回请求',
                text: `已登记 ${latestRewriteRequest.id}，等待续写 Agent 写回新草稿。`,
                tone: 'warning',
            });
        }
        if (!latestRewriteMessage) {
            return lines;
        }
        const currentStage = latestRewriteMessage.stageProgress
            || [...latestRewriteMessage.stageEvents].reverse().find((item) => item.stageText);
        const currentReasoning = [...latestRewriteMessage.reasoningEvents].reverse().find((item) => item.text);
        const currentPreview = [...latestRewriteMessage.previewEvents].reverse().find((item) => item.text);
        if (currentStage?.stageText) lines.push({ id: 'stage', label: '当前节点', text: currentStage.stageText });
        if (currentReasoning?.text) lines.push({ id: 'reasoning', label: currentReasoning.label || '思考片段', text: currentReasoning.text });
        if (currentPreview?.text) lines.push({ id: 'preview', label: currentPreview.label || '草稿预览', text: currentPreview.text });
        if (latestRewriteMessage.text.trim()) lines.push({ id: 'answer', label: 'Agent 回复', text: latestRewriteMessage.text.trim() });
        if (latestRewriteMessage.status === 'streaming') lines.push({ id: 'streaming', label: '状态', text: '续写 Agent 正在输出或写入草稿。', tone: 'warning' });
        if (latestRewriteMessage.status === 'done') lines.push({ id: 'done', label: '状态', text: '续写 Agent 已结束，等待草稿审阅。', tone: 'success' });
        if (latestRewriteMessage.status === 'error') lines.push({ id: 'error', label: '状态', text: '续写 Agent 返回错误，请查看右侧会话详情。', tone: 'danger' });
        return lines.slice(-5);
    }, [latestCompletedRewriteRequest, latestRewriteMessage, latestRewriteRequest, rewriteProgress]);
    const rewriteStreamLines = useMemo(() => {
        const lines: RewriteStreamLine[] = [];
        const pushLine = (line: RewriteStreamLine) => {
            const text = line.text.trim();
            if (!text) return;
            lines.push({ ...line, text });
        };
        for (const line of rewriteTelemetryLines) {
            if (line.id === 'reasoning' || line.id === 'preview' || line.id === 'answer') continue;
            pushLine(line);
        }
        if (latestRewriteMessage) {
            for (const event of latestRewriteMessage.reasoningEvents.slice(-3)) {
                pushLine({
                    id: `reasoning-${event.sourceEvent || ''}-${event.label}`,
                    label: event.label || '思考',
                    text: event.text,
                });
            }
            for (const event of latestRewriteMessage.previewEvents.slice(-4)) {
                pushLine({
                    id: `preview-${event.sourceEvent || ''}-${event.label}`,
                    label: event.label || '草稿预览',
                    text: event.text,
                });
            }
            pushLine({
                id: 'answer-stream',
                label: latestRewriteMessage.status === 'streaming' ? '正在返回' : '最终回复',
                text: latestRewriteMessage.text,
                tone: latestRewriteMessage.status === 'error'
                    ? 'danger'
                    : latestRewriteMessage.status === 'done'
                        ? 'success'
                        : undefined,
            });
        }
        return lines.slice(-10);
    }, [latestRewriteMessage, rewriteTelemetryLines]);
    const showRewriteTelemetry = reviewState === 'rewriting'
        || pendingRewrite
        || rewriteProgress.status !== 'idle'
        || latestRewriteMessage?.status === 'streaming'
        || rewriteTelemetryLines.length > 0;
    const showRewriteStream = showRewriteTelemetry || rewriteStreamLines.length > 0;
    const hasRewriteInput = findings.length > 0 || Boolean(manualFinding.trim()) || Boolean(latestReviewText);
    const canRequestRewrite = !hasUnsavedEdit
        && !rewriteBusy
        && draftActionPending === 'none'
        && (hasRewriteInput || pendingRewrite);
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

    const applyLoadedPayload = (next: ProseDeliveryPayload) => {
        setPayload(next);
        setEditorDraft(next.draft.content);
        onDraftLoaded(next.draft.content, next.draft.commit_id, next.draft.etag);
    };

    const loadState = async (mode: 'fetch' | 'refresh' = 'fetch'): Promise<ProseDeliveryPayload | null> => {
        if (!bookRef.value) return null;
        setLoading(true);
        setError('');
        try {
            let next = mode === 'refresh'
                ? await refreshProseDeliveryState(bookRef)
                : await fetchProseDeliveryState(bookRef);
            if (mode === 'fetch' && !next.state && next.draft.commit_id && next.draft.content.trim()) {
                next = await refreshProseDeliveryState(bookRef);
                onNotice({ type: 'info', message: '检测到正文草稿，已自动初始化交付状态。', ts: Date.now() });
            }
            applyLoadedPayload(next);
            return next;
        } catch (err) {
            const message = formatApiError(err, '正文交付状态加载失败');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
            return null;
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

    useEffect(() => {
        const streamPanel = rewriteStreamRef.current;
        if (!streamPanel) return;
        streamPanel.scrollTop = streamPanel.scrollHeight;
    }, [rewriteStreamLines, latestRewriteMessage?.status]);

    const handleRefresh = async () => {
        await loadState('refresh');
    };

    const ensureDeliveryState = async (): Promise<ProseDeliveryPayload> => {
        if (payload?.state && !payload.staleness.stale && !payload.state.review_report.stale) return payload;
        const next = await refreshProseDeliveryState(bookRef);
        applyLoadedPayload(next);
        return next;
    };

    const refreshAfterRewrite = async (priorCommit: string | null): Promise<ProseDeliveryPayload> => {
        setRewriteProgress((current) => ({
            ...current,
            status: 'refreshing',
            message: '续写 Agent 已结束，正在接收新的 chapter_draft.md。',
        }));
        const fetched = await fetchProseDeliveryState(bookRef);
        const nextCommit = fetched.draft.commit_id;
        const draftCommitChanged = Boolean(nextCommit && nextCommit !== priorCommit);
        const stateIsStaleFromDraft = fetched.staleness.stale && fetched.staleness.reasons.includes('draft_commit');
        if (!draftCommitChanged && !stateIsStaleFromDraft) {
            applyLoadedPayload(fetched);
            throw new Error('续写 Agent 已结束，但没有检测到新的 chapter_draft.md。请查看右侧续写会话的错误或输出。');
        }
        const refreshed = await refreshProseDeliveryState(bookRef);
        applyLoadedPayload(refreshed);
        setReviewSummary('');
        setManualFinding('');
        setRewriteProgress({
            status: 'ready',
            message: '新草稿已接收，已回到审阅台，下一步请重新审核或人工修改。',
            priorCommit,
            nextCommit: refreshed.draft.commit_id,
        });
        return refreshed;
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
                source_draft_commit: currentDraftCommit || undefined,
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
                decision: 'passed',
                source_draft_commit: currentDraftCommit || undefined,
                review_is_author_approval: true,
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
        if (currentDraftCommit && latestReviewTargetDraftCommit && latestReviewTargetDraftCommit !== currentDraftCommit) {
            onNotice({
                type: 'error',
                message: `最近审核回复对应旧草稿 ${latestReviewTargetDraftCommit.slice(0, 8)}，当前草稿是 ${currentDraftCommit.slice(0, 8)}。请重新启动审核 Agent。`,
                ts: Date.now(),
            });
            return;
        }
        setReviewState('saving');
        setError('');
        try {
            const extracted = latestReviewExtraction || extractProseReviewReport(reviewText, spans);
            const adoptingUnboundPass = Boolean(currentDraftCommit && !latestReviewTargetDraftCommit);
            if (adoptingUnboundPass && (extracted.findings.length > 0 || !extracted.passed)) {
                onNotice({
                    type: 'error',
                    message: '最近审核回复没有绑定草稿版本，且不是纯通过结论。请重新启动审核 Agent，避免旧审核污染当前草稿。',
                    ts: Date.now(),
                });
                setReviewState('idle');
                return;
            }
            const next = await attachProseReviewReport(bookRef, {
                summary: adoptingUnboundPass
                    ? `作者采用历史审核结论：${extracted.summary || '审核 Agent 最近一次回复判断通过。'}`
                    : extracted.summary || '已同步审核 Agent 最近一次回复。',
                decision: extracted.decision,
                source_draft_commit: latestReviewTargetDraftCommit || currentDraftCommit || undefined,
                review_is_author_approval: adoptingUnboundPass,
                findings: extracted.findings,
            });
            setPayload(next);
            setReviewSummary(extracted.summary);
            setReviewState('idle');
            onNotice({
                type: extracted.findings.length > 0 ? 'success' : 'info',
                message: extracted.findings.length > 0
                    ? `已同步 ${extracted.findings.length} 条审核问题。`
                    : adoptingUnboundPass
                        ? '已由作者采用这条历史通过结论，并绑定到当前草稿；归档仍需作者确认。'
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

    const requestRewriteForFinding = async (finding: ProseReviewFinding) => {
        if (rewriteInFlightRef.current) {
            throw new Error('已经有一轮打回重写正在执行，请等待续写 Agent 返回新草稿。');
        }
        rewriteInFlightRef.current = true;
        const priorCommit = payload?.draft.commit_id ?? draftCommitId ?? null;
        setRewriteProgress({
            status: 'registering',
            message: '正在登记审核打回请求。',
            priorCommit,
            nextCommit: null,
        });
        try {
            const next = await requestProseRewrite(bookRef, {
                finding_id: finding.id,
                instruction: finding.suggestion || finding.message,
            });
            applyLoadedPayload(next);
            const nextFinding = next.state?.review_report.findings.find((item) => item.id === finding.id) || finding;
            setReviewState('rewriting');
            setRewriteProgress({
                status: 'running',
                message: '已交给续写 Agent，正在按审核意见重写 chapter_draft.md。',
                priorCommit,
                nextCommit: null,
            });
            await onRewriteWithReview(nextFinding);
            return await refreshAfterRewrite(priorCommit);
        } catch (err) {
            const message = formatApiError(err, '续写 Agent 重写失败');
            setRewriteProgress({
                status: 'error',
                message,
                priorCommit,
                nextCommit: null,
            });
            throw err;
        } finally {
            rewriteInFlightRef.current = false;
        }
    };

    const handleRewriteFinding = async (finding: ProseReviewFinding) => {
        setReviewState('saving');
        setError('');
        try {
            await requestRewriteForFinding(finding);
            setReviewState('idle');
            onNotice({ type: 'success', message: '已登记打回请求，并交给续写 Agent 重写。', ts: Date.now() });
        } catch (err) {
            const message = formatApiError(err, '登记重写请求失败');
            setReviewState('error');
            setError(message);
            onNotice({ type: 'error', message, ts: Date.now() });
        }
    };

    const handleRewriteFromCurrentReview = async () => {
        if (hasUnsavedEdit) {
            onNotice({ type: 'info', message: '当前草稿有未保存修改，请先保存后再打回重写。', ts: Date.now() });
            return;
        }
        if (!hasRewriteInput) {
            onNotice({ type: 'info', message: '还没有审核意见。可以先启动审核 Agent，或手动写下需要打回的问题。', ts: Date.now() });
            return;
        }
        setReviewState('saving');
        setError('');
        try {
            const currentPayload = await ensureDeliveryState();
            const currentSpans = currentPayload.state?.draft_package.chapter_spans ?? spans;
            const currentFindings = currentPayload.state?.review_report.findings ?? findings;
            let targetFinding = currentFindings.find((finding) => finding.status !== 'rewrite_requested') || currentFindings[0];
            if (!targetFinding) {
                const chapterNumber = selectedChapter === 'all' ? null : selectedChapter;
                const manualText = manualFinding.trim();
                const extracted = manualText
                    ? {
                        summary: reviewSummary || '作者手动打回重写。',
                        findings: [{
                            id: `human-${Date.now()}`,
                            chapter_number: chapterNumber,
                            severity: 'blocking',
                            status: 'open',
                            message: manualText,
                            suggestion: manualText,
                        } as ProseReviewFinding],
                        passed: false,
                    }
                    : extractProseReviewReport(latestReviewText, currentSpans);
                let nextFindings = extracted.findings;
                if (nextFindings.length === 0) {
                    if (extracted.passed) {
                        setReviewState('idle');
                        onNotice({ type: 'info', message: '最近审核回复判断为通过，没有生成打回问题。', ts: Date.now() });
                        return;
                    }
                    const fallbackText = extracted.summary || latestReviewText;
                    nextFindings = [{
                        id: `review-${Date.now()}-fallback`,
                        chapter_number: chapterNumber,
                        severity: 'blocking',
                        status: 'open',
                        message: fallbackText,
                        suggestion: fallbackText,
                    }];
                }
                const next = await attachProseReviewReport(bookRef, {
                    summary: extracted.summary || reviewSummary || '按审核意见打回重写。',
                    decision: 'rewrite_required',
                    source_draft_commit: currentDraftCommit || undefined,
                    findings: nextFindings,
                });
                setPayload(next);
                setReviewSummary(extracted.summary || reviewSummary);
                setManualFinding('');
                targetFinding = next.state?.review_report.findings.find((item) => item.status !== 'rewrite_requested')
                    || next.state?.review_report.findings[0]
                    || nextFindings[0];
            }
            if (targetFinding.status === 'rewrite_requested') {
                if (rewriteInFlightRef.current) {
                    throw new Error('已经有一轮打回重写正在执行，请等待续写 Agent 返回新草稿。');
                }
                rewriteInFlightRef.current = true;
                const priorCommit = payload?.draft.commit_id ?? draftCommitId ?? null;
                setReviewState('rewriting');
                setRewriteProgress({
                    status: 'running',
                    message: '已有打回请求，正在重新交给续写 Agent。',
                    priorCommit,
                    nextCommit: null,
                });
                try {
                    await onRewriteWithReview(targetFinding);
                    await refreshAfterRewrite(priorCommit);
                } catch (err) {
                    const message = formatApiError(err, '续写 Agent 重写失败');
                    setRewriteProgress({
                        status: 'error',
                        message,
                        priorCommit,
                        nextCommit: null,
                    });
                    throw err;
                } finally {
                    rewriteInFlightRef.current = false;
                }
            } else {
                await requestRewriteForFinding(targetFinding);
            }
            setReviewState('idle');
            onNotice({ type: 'success', message: '已按审核意见打回，并交给续写 Agent 重写。', ts: Date.now() });
        } catch (err) {
            const message = formatApiError(err, '打回重写失败');
            setReviewState('error');
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
                            {hasDraftWithoutDeliveryState ? (
                                <div className="text-[var(--tone-warning-text)]">已检测到草稿，正在补齐交付状态</div>
                            ) : null}
                            {canAuthorAdoptLatestReview ? (
                                <div className="text-[var(--tone-success-text)]">最近审核回复是未绑定版本的通过结论，可由作者采用到当前草稿</div>
                            ) : null}
                            {rewriteStreamActive ? (
                                <div className="text-[var(--tone-warning-text)]">续写 Agent 正在按审核意见重写，请等待新草稿返回</div>
                            ) : pendingRewrite ? (
                                <div className="text-[var(--tone-warning-text)]">已有打回请求，可继续交给续写 Agent 重写</div>
                            ) : null}
                            {latestCompletedRewriteRequest?.completed_draft_commit ? (
                                <div className="text-[var(--tone-success-text)]">
                                    最近一次打回已收到新草稿 {latestCompletedRewriteRequest.completed_draft_commit.slice(0, 8)}
                                </div>
                            ) : null}
                            {stale ? <div className="text-[var(--tone-warning-text)]">状态需要刷新或重审</div> : null}
                            {hasUnsavedEdit ? <div className="text-[var(--tone-warning-text)]">有未保存修改</div> : null}
                            {state?.archive_state.blocked_reason === 'review_findings_require_rewrite_or_author_approval' ? (
                                <div className="text-[var(--tone-warning-text)]">有审核问题，需打回重写或人工修改后再确认通过</div>
                            ) : null}
                        </div>
                        {showRewriteStream ? (
                            <div className="mt-3 rounded-[8px] border border-[rgba(245,158,11,0.2)] bg-[rgba(245,158,11,0.045)]">
                                <div className="flex items-center justify-between border-b border-[rgba(245,158,11,0.12)] px-2.5 py-1.5">
                                    <span className="text-[10px] font-semibold text-[var(--tone-warning-text)]">草稿返回流</span>
                                    <span className="text-[10px] text-[var(--color-dark-text-faint)]">
                                        {latestRewriteMessage?.status === 'streaming' ? '实时' : '最近'}
                                    </span>
                                </div>
                                <div
                                    ref={rewriteStreamRef}
                                    className="app-scrollbar max-h-[168px] overflow-y-auto px-2.5 py-2 text-[11px] leading-5"
                                >
                                    {rewriteStreamLines.length > 0 ? rewriteStreamLines.map((line, index) => (
                                        <div key={`${line.id}-${index}`} className="mb-2 last:mb-0">
                                            <div className={
                                                line.tone === 'danger'
                                                    ? 'mb-0.5 text-[10px] font-semibold text-[var(--tone-danger-text)]'
                                                    : line.tone === 'success'
                                                        ? 'mb-0.5 text-[10px] font-semibold text-[var(--tone-success-text)]'
                                                        : line.tone === 'warning'
                                                            ? 'mb-0.5 text-[10px] font-semibold text-[var(--tone-warning-text)]'
                                                            : 'mb-0.5 text-[10px] font-semibold text-[var(--color-dark-text-faint)]'
                                            }>
                                                {line.label}
                                            </div>
                                            <div className="whitespace-pre-wrap break-words text-[var(--color-dark-text-muted)]">
                                                {line.text}
                                                {latestRewriteMessage?.status === 'streaming' && index === rewriteStreamLines.length - 1 ? (
                                                    <span className="stream-caret ml-1" aria-hidden="true" />
                                                ) : null}
                                            </div>
                                        </div>
                                    )) : (
                                        <div className="text-[var(--color-dark-text-faint)]">等待续写 Agent 返回第一段文字。</div>
                                    )}
                                </div>
                            </div>
                        ) : null}
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
                            disabled={reviewState === 'saving' || reviewState === 'rewriting' || hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-success-text)] hover:bg-[rgba(255,255,255,0.1)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            标记审核通过
                        </button>
                        <button
                            type="button"
                            onClick={onRunReviewAgent}
                            disabled={reviewState === 'rewriting' || hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[rgba(255,255,255,0.12)] px-3 py-2 text-[12px] font-semibold text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            启动审核 Agent
                        </button>
                        <button
                            type="button"
                            onClick={handleSyncLatestReview}
                            disabled={!latestReviewText || reviewState === 'saving' || reviewState === 'rewriting' || hasUnsavedEdit || draftActionPending !== 'none'}
                            className="w-full rounded-[8px] border border-[rgba(255,255,255,0.12)] px-3 py-2 text-[12px] font-semibold text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {canAuthorAdoptLatestReview ? '采用历史通过结论' : '同步最近审核回复'}
                        </button>
                        <button
                            type="button"
                            onClick={() => { void handleRewriteFromCurrentReview(); }}
                            disabled={!canRequestRewrite}
                            title="把最近审核回复或作者标记的问题登记为打回请求，然后交给续写 Agent 重写 chapter_draft.md。"
                            className="w-full rounded-[8px] border border-[var(--tone-warning-border)] bg-[rgba(245,158,11,0.1)] px-3 py-2 text-[12px] font-semibold text-[var(--tone-warning-text)] hover:bg-[rgba(245,158,11,0.16)] disabled:cursor-not-allowed disabled:opacity-45"
                        >
                            {reviewState === 'saving'
                                ? '打回处理中'
                                : rewriteStreamActive
                                    ? '等待续写 Agent 重写'
                                    : pendingRewrite
                                        ? '继续已登记重写'
                                    : '按审核意见打回重写'}
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
                                {showRewriteTelemetry ? (
                                    <div className="mb-3 rounded-[8px] border border-[rgba(245,158,11,0.22)] bg-[rgba(245,158,11,0.055)] p-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="cursor-section-label">重写过程</div>
                                            <div className="text-[10px] text-[var(--tone-warning-text)]">
                                                {latestRewriteMessage?.status === 'streaming' ? '进行中' : pendingRewrite ? '等待新草稿' : '最近一次'}
                                            </div>
                                        </div>
                                        <div className="app-scrollbar mt-2 max-h-[116px] space-y-2 overflow-y-auto pr-1">
                                            {rewriteStreamLines.length > 0 ? rewriteStreamLines.map((line, index) => (
                                                <div key={`${line.id}-${index}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-5">
                                                    <div className="text-[var(--color-dark-text-faint)]">{line.label}</div>
                                                    <div className={
                                                        line.tone === 'danger'
                                                            ? 'text-[var(--tone-danger-text)]'
                                                            : line.tone === 'success'
                                                                ? 'text-[var(--tone-success-text)]'
                                                                : line.tone === 'warning'
                                                                    ? 'text-[var(--tone-warning-text)]'
                                                                    : 'text-[var(--color-dark-text-muted)]'
                                                    }>
                                                        <span className="whitespace-pre-wrap break-words">{line.text}</span>
                                                        {latestRewriteMessage?.status === 'streaming' && index === rewriteStreamLines.length - 1 ? (
                                                            <span className="stream-caret ml-1" aria-hidden="true" />
                                                        ) : null}
                                                    </div>
                                                </div>
                                            )) : (
                                                <div className="text-[11px] leading-5 text-[var(--color-dark-text-muted)]">
                                                    已登记打回请求，正在等待续写 Agent 开始返回流式进度。
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ) : null}
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
                                                    disabled={reviewState === 'saving' || rewriteStreamActive || (pendingRewrite && finding.status !== 'rewrite_requested') || hasUnsavedEdit || draftActionPending !== 'none'}
                                                    className="shrink-0 rounded-[8px] border border-[var(--tone-warning-border)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--tone-warning-text)] hover:bg-[rgba(245,158,11,0.08)] disabled:cursor-not-allowed disabled:opacity-45"
                                                >
                                                    {finding.status === 'rewrite_requested' ? '继续重写' : '打回重写'}
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
