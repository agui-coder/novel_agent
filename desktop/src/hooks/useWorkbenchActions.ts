import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { fetchHotFiles, fetchMainlineFile } from '../api/checkout';
import { buildRollingContinuationPayload, buildRollingOutlineHandoffPayload, fetchRollingWorkbenchState, runDeductionStream, runBatchInit, runStyleInit, type RollingWorkbenchState } from '../api/orchestration';
import { type DraftConfirmResponse, type MaterializedChapter, type PostConfirmWorldPayload } from '../api/draft';
import { ApiError } from '../api/client';
import { formatChapterArchiveSummary, formatChapterList } from '../lib/chapterListFormat';
import { compactProgressText, upsertProgressLine, ROLLING_STREAM_PREVIEW_LIMIT, ROLLING_STREAM_REASONING_LIMIT } from '../lib/textCompact';
import { buildRollingBriefLines } from '../lib/rollingBrief';
import { normalizeChangedFilesPayload } from '../lib/conversationUtils';
import { formatVisibleDeductionError } from '../lib/errorUtils';
import type { RepoIntegrity } from '../types/store';

export interface WorkbenchActionProgress {
    current: number;
    total: number;
    label: string;
    lines: string[];
}

export interface WorldInitActionState {
    runState: 'idle' | 'running' | 'success' | 'error';
    progress: WorkbenchActionProgress;
}

export interface StyleInitActionState {
    runState: 'idle' | 'running' | 'success' | 'error';
    progress: WorkbenchActionProgress;
}

export interface PostConfirmHandoffState {
    runState: 'idle' | 'running' | 'success' | 'error';
    payload: PostConfirmWorldPayload | null;
    materializedChapters: MaterializedChapter[];
    progress: WorkbenchActionProgress;
}

export interface RollingActionState {
    runState: 'idle' | 'running' | 'success' | 'error';
    state: RollingWorkbenchState | null;
    progress: WorkbenchActionProgress;
}

import type { MutableRefObject } from 'react';

export interface WorkbenchLateDeps {
    hasPendingDraftDecision: boolean;
    loadReviewTargetMainline: (file: string) => Promise<void>;
}

export interface UseWorkbenchActionsDeps {
    store: ReturnType<typeof useAppStore.getState>;
    repoIntegrity: RepoIntegrity | null;
    setRepoIntegrity: (v: RepoIntegrity | null) => void;
    loadMainline: (file?: string, opts?: { preserveDraftReview?: boolean }) => Promise<void>;
    lateRef: MutableRefObject<WorkbenchLateDeps>;
}

export function useWorkbenchActions(deps: UseWorkbenchActionsDeps) {
    const { store, repoIntegrity, setRepoIntegrity, loadMainline, lateRef } = deps;

    const [worldInitActionState, setWorldInitActionState] = useState<WorldInitActionState>({
        runState: 'idle',
        progress: { current: 0, total: 1, label: '等待启动', lines: [] },
    });
    const [postConfirmHandoffState, setPostConfirmHandoffState] = useState<PostConfirmHandoffState>({
        runState: 'idle',
        payload: null,
        materializedChapters: [],
        progress: { current: 0, total: 3, label: '等待正文归档', lines: [] },
    });
    const [styleInitActionState, setStyleInitActionState] = useState<StyleInitActionState>({
        runState: 'idle',
        progress: { current: 0, total: 1, label: '等待启动', lines: [] },
    });
    const [rollingActionState, setRollingActionState] = useState<RollingActionState>({
        runState: 'idle',
        state: null,
        progress: { current: 0, total: 1, label: '等待刷新', lines: [] },
    });
    const refreshRollingStateRef = useRef<() => Promise<void> | void>(() => undefined);

    const runPostConfirmWorldDistill = useCallback(async (
        payload: PostConfirmWorldPayload,
        materializedChapters: MaterializedChapter[],
    ) => {
        const materializedCount = materializedChapters.length;
        if (!payload || materializedCount <= 0) return;
        setPostConfirmHandoffState((current) => ({
            ...current,
            payload,
            materializedChapters,
        }));
        if (postConfirmHandoffState.runState === 'running') {
            store.setUiNotice({
                type: 'info',
                message: '正文已归档；状态卡接棒任务正在运行。',
                ts: Date.now(),
            });
            return;
        }
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({
                type: 'info',
                message: '正文已归档；当前 Agent 正在输出，稍后可在动作面板运行状态接棒。',
                ts: Date.now(),
            });
            return;
        }
        if (payload.no_prose_boundary?.payload_contains_chapter_prose) {
            store.setUiNotice({
                type: 'error',
                message: '状态接棒已拦截：payload 不应包含章节正文。',
                ts: Date.now(),
            });
            setPostConfirmHandoffState({
                runState: 'error',
                payload,
                materializedChapters,
                progress: {
                    current: 0,
                    total: 3,
                    label: '接棒边界失败',
                    lines: ['状态接棒已拦截：payload_contains_chapter_prose=true。'],
                },
            });
            return;
        }
        const lines = [
            `章节已入库：${materializedCount} 章`,
            `正式归档：${materializedChapters.map((chapter) => chapter.file_name).join(', ')}`,
            '交给 world_model 路由刷新 status_card.md，并按需更新 world_model.md/domain_rules.md。',
        ];
        const setProgress = (
            runState: 'running' | 'success' | 'error',
            label: string,
            current: number,
            total = 3,
        ) => {
            setPostConfirmHandoffState({
                runState,
                payload,
                materializedChapters,
                progress: {
                    current,
                    total,
                    label,
                    lines: [...lines],
                },
            });
        };
        setProgress('running', '确认后状态接棒', 0);
        try {
            let draftReady = false;
            let draftTargetFile = payload.active_file;
            let draftCommitId = '';
            let changedFiles: string[] = [];
            await runDeductionStream(payload.intent, useAppStore.getState(), {
                onAck: (ack) => {
                    const routed = typeof ack?.routed_agent === 'string' ? ack.routed_agent : 'world_model';
                    lines.push(`Dify 路由：${routed}`);
                    setProgress('running', '读取正式章节', 1);
                },
                onStage: (stage) => {
                    const text = typeof stage?.stage_text === 'string' ? stage.stage_text : '';
                    if (text) {
                        lines.push(text);
                        setProgress('running', '状态蒸馏中', 1);
                    }
                },
                onDraftReady: (draftPayload) => {
                    draftReady = true;
                    draftTargetFile = typeof draftPayload?.file_name === 'string' ? draftPayload.file_name : payload.active_file;
                    draftCommitId = typeof draftPayload?.commit_id === 'string' ? draftPayload.commit_id : '';
                    const draftContent = typeof draftPayload?.content === 'string' ? draftPayload.content : '';
                    const branch = typeof draftPayload?.branch === 'string' ? draftPayload.branch : store.draftBranch;
                    const diffPreview = typeof draftPayload?.diff_preview === 'string' ? draftPayload.diff_preview : '';
                    changedFiles = normalizeChangedFilesPayload(draftPayload?.changed_files);
                    const reviewChangedFiles = changedFiles.includes(draftTargetFile)
                        ? changedFiles
                        : [draftTargetFile, ...changedFiles];
                    store.setSandboxDraft(draftContent, draftCommitId || null);
                    store.setReviewTarget(draftTargetFile, reviewChangedFiles);
                    store.setReviewReadyNotice({
                        fileName: draftTargetFile,
                        branch,
                        commitId: draftCommitId || null,
                        diffPreview,
                        changedFiles: reviewChangedFiles,
                        ts: Date.now(),
                    });
                    store.setFsmState('REVIEW');
                    store.setWorkbenchMode('review');
                    void fetchMainlineFile(store.bookRef, draftTargetFile)
                        .then(({ content, etag }) => {
                            store.setReviewMainlineFact(content, etag);
                        })
                        .catch((err) => {
                            console.warn('Failed to load post-confirm review target mainline:', err);
                            store.setReviewMainlineFact('', '');
                        });
                    lines.push(`生成审阅草稿：${draftTargetFile}${draftCommitId ? ` @ ${draftCommitId.slice(0, 8)}` : ''}`);
                    setProgress('running', '等待审阅确权', 2);
                },
                onDone: (donePayload) => {
                    const doneChangedFiles = normalizeChangedFilesPayload(donePayload?.changed_files);
                    if (!changedFiles.length && doneChangedFiles.length) {
                        changedFiles = doneChangedFiles;
                    }
                    if (!draftCommitId && typeof donePayload?.sync_commit_id === 'string') {
                        draftCommitId = donePayload.sync_commit_id;
                    }
                    if (changedFiles.length) {
                        lines.push(`待审更新：${changedFiles.join(', ')}`);
                    } else {
                        lines.push('world_model 路由完成：没有检测到需要写入的状态变更。');
                    }
                },
                onError: (errorPayload) => {
                    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'STREAM_ERROR';
                    const message = typeof errorPayload?.message === 'string' ? errorPayload.message : '确认后状态接棒失败';
                    throw new ApiError(
                        typeof errorPayload?.status === 'number' ? errorPayload.status : 500,
                        code,
                        message,
                        errorPayload,
                    );
                },
            }, {
                routeAgentKey: 'world_agent',
                activeFile: payload.active_file,
                fileType: payload.file_type,
                writeScope: payload.write_scope,
                baseEtag: '',
                detachedJob: true,
                difyUser: payload.dify_user,
            });
            if (draftReady) {
                try {
                    const { files, integrity } = await fetchHotFiles(store.bookRef);
                    setRepoIntegrity(integrity);
                    if (files.length > 0) {
                        store.setHotFiles(files);
                    }
                } catch (err) {
                    console.warn('Failed to refresh hot files after post-confirm world distill:', err);
                }
                await loadMainline(store.activeFile, { preserveDraftReview: true });
                const latestState = useAppStore.getState();
                if (draftTargetFile !== latestState.activeFile) {
                    try {
                        const { content, etag } = await fetchMainlineFile(latestState.bookRef, draftTargetFile);
                        latestState.setReviewMainlineFact(content, etag);
                    } catch (err) {
                        console.warn('Failed to refresh post-confirm review target mainline:', err);
                    }
                }
            }
            setProgress('success', draftReady ? '等待作者审阅状态更新' : '状态接棒已完成', 3);
            store.setUiNotice({
                type: draftReady ? 'info' : 'success',
                message: draftReady
                    ? '正文已归档；状态卡/世界观草稿已生成，等待作者审阅确权。'
                    : '正文已归档，world_model 路由未检测到需要写入的状态变更。',
                ts: Date.now(),
            });
        } catch (err: any) {
            const message = err instanceof ApiError
                ? formatVisibleDeductionError(err.code, err.message)
                : (err?.message || '确认后状态接棒失败');
            lines.push(`错误：${message}`);
            setProgress('error', '状态接棒失败', 0);
            store.setUiNotice({
                type: 'error',
                message,
                ts: Date.now(),
            });
        }
    }, [loadMainline, postConfirmHandoffState.runState, setRepoIntegrity, store]);

    const runPostConfirmWorldDistillFromResult = useCallback(async (result: DraftConfirmResponse) => {
        const payload = result.post_confirm_payload;
        const materializedChapters = result.materialized_chapters || [];
        if (!payload || materializedChapters.length <= 0) return;
        await runPostConfirmWorldDistill(payload, materializedChapters);
    }, [runPostConfirmWorldDistill]);

    const handleRunPostConfirmHandoff = useCallback(() => {
        const payload = postConfirmHandoffState.payload;
        const materializedChapters = postConfirmHandoffState.materializedChapters;
        if (!payload || materializedChapters.length <= 0) {
            store.setUiNotice({
                type: 'info',
                message: '没有可重试的正文归档接棒任务。',
                ts: Date.now(),
            });
            return;
        }
        void runPostConfirmWorldDistill(payload, materializedChapters);
    }, [postConfirmHandoffState.materializedChapters, postConfirmHandoffState.payload, runPostConfirmWorldDistill, store]);

    const handleRunWorldInitAction = useCallback(async (options?: { forceRebuild?: boolean }) => {
        const forceRebuild = options?.forceRebuild === true;
        if (worldInitActionState.runState === 'running') return;
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({
                type: 'info',
                message: '当前 Agent 正在输出，稍后再执行工作台动作。',
                ts: Date.now(),
            });
            return;
        }
        const lines: string[] = [
            forceRebuild
                ? '准备完整重跑 world/status 初始化 pipeline…'
                : '准备调用后端初始化 pipeline…',
        ];
        let totalBatches = 1;
        let completedBatches = 0;
        const setProgress = (runState: 'running' | 'success' | 'error', label: string, current = completedBatches, total = totalBatches) => {
            setWorldInitActionState({ runState, progress: { current, total: Math.max(total, 1), label, lines: [...lines] } });
        };
        setProgress('running', forceRebuild ? '准备完整重跑' : '准备检查/补齐', 0, 1);
        const pushLine = (line: string, label: string, current = completedBatches, total = totalBatches) => {
            lines.push(line);
            setProgress('running', label, current, total);
        };
        try {
            await runBatchInit(store.bookRef, {
                onAck: (d) => {
                    totalBatches = Math.max(d.total_batches || 1, 1);
                    completedBatches = 0;
                    pushLine(`开始：${totalBatches} 个批次${forceRebuild ? '（完整重跑）' : ''}`, forceRebuild ? '完整重跑已连接 pipeline' : '已连接 pipeline', 0, totalBatches);
                },
                onProgress: (d) => {
                    totalBatches = Math.max(d.total || totalBatches, 1);
                    pushLine(`处理中 ${d.batch_index + 1}/${totalBatches}: ${d.title}`, `处理中 ${d.batch_index + 1}/${totalBatches}`, d.batch_index, totalBatches);
                },
                onBatchDone: (d) => {
                    totalBatches = Math.max(d.total || totalBatches, 1);
                    completedBatches = Math.max(completedBatches, d.batch_index + 1);
                    pushLine(`完成 ${completedBatches}/${totalBatches}: ${d.title}`, `完成 ${completedBatches}/${totalBatches}`, completedBatches, totalBatches);
                },
                onBatchError: (d) => {
                    pushLine(`失败: ${d.title} - ${d.error}`, '批次失败');
                },
                onDone: (d) => {
                    const skipped = d.skipped ? (d.status_card_committed ? '；已补齐状态卡' : '；已存在，跳过重建') : '';
                    lines.push(`完成${skipped}：成功 ${d.completed}，失败 ${d.failed}`);
                    const total = Math.max(totalBatches, d.completed + d.failed, 1);
                    const successLabel = forceRebuild ? '完整重跑完成' : d.skipped ? '检查完成' : '初始化完成';
                    setWorldInitActionState({ runState: d.failed > 0 ? 'error' : 'success', progress: { current: d.failed > 0 ? Math.min(d.completed, total) : total, total, label: d.failed > 0 ? '完成但存在失败' : successLabel, lines: [...lines] } });
                    const currentFile = useAppStore.getState().activeFile;
                    if (currentFile === 'world_model.md' || currentFile === 'status_card.md') {
                        void loadMainline(currentFile);
                    }
                },
                onError: (d) => {
                    lines.push(`错误: ${d.message}`);
                    setProgress('error', '初始化失败');
                },
            }, { forceRebuild });
        } catch (err: any) {
            lines.push(`错误: ${err?.message || '批量初始化失败'}`);
            setWorldInitActionState({ runState: 'error', progress: { current: completedBatches, total: Math.max(totalBatches, 1), label: '初始化失败', lines: [...lines] } });
        }
    }, [loadMainline, store, worldInitActionState.runState]);

    const handleRunStyleInitAction = useCallback(async (options?: { forceRebuild?: boolean }) => {
        const forceRebuild = options?.forceRebuild === true;
        if (styleInitActionState.runState === 'running') return;
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({ type: 'info', message: '当前 Agent 正在输出，稍后再执行工作台动作。', ts: Date.now() });
            return;
        }
        const lines: string[] = [forceRebuild ? '准备完整重跑文风 diagnostics pipeline…' : '准备检查/补齐文风 diagnostics pipeline…'];
        let totalSteps = 1;
        let currentStep = 0;
        const setProgress = (runState: 'running' | 'success' | 'error', label: string, current = currentStep, total = totalSteps) => {
            setStyleInitActionState({ runState, progress: { current, total: Math.max(total, 1), label, lines: [...lines] } });
        };
        setProgress('running', forceRebuild ? '准备完整重跑' : '准备检查/补齐', 0, 1);
        const pushLine = (line: string, label: string, current = currentStep, total = totalSteps) => {
            lines.push(line);
            setProgress('running', label, current, total);
        };
        try {
            await runStyleInit(store.bookRef, {
                onAck: (d) => {
                    totalSteps = Math.max(d.total_steps || 1, 1);
                    currentStep = 0;
                    pushLine(`开始：${totalSteps} 个步骤${forceRebuild ? '（完整重跑）' : ''}`, forceRebuild ? '完整重跑已连接 pipeline' : '已连接 pipeline', 0, totalSteps);
                },
                onProgress: (d) => {
                    totalSteps = Math.max(d.total || totalSteps, 1);
                    currentStep = Math.max(0, d.step_index);
                    pushLine(`处理中 ${Math.min(currentStep + 1, totalSteps)}/${totalSteps}: ${d.title}`, `处理中 ${Math.min(currentStep + 1, totalSteps)}/${totalSteps}`, currentStep, totalSteps);
                },
                onDone: (d) => {
                    const skipped = d.skipped ? '；已有成品，跳过重建' : '';
                    const updated = d.updated_artifacts?.length ? `；更新 ${d.updated_artifacts.join(', ')}` : '';
                    lines.push(`完成${skipped}${updated}：成功 ${d.completed}，失败 ${d.failed}`);
                    const total = Math.max(totalSteps, d.completed + d.failed, 1);
                    setStyleInitActionState({ runState: d.failed > 0 ? 'error' : 'success', progress: { current: d.failed > 0 ? Math.min(d.completed, total) : total, total, label: d.failed > 0 ? '完成但存在失败' : d.skipped ? '检查完成' : '文风初始化完成', lines: [...lines] } });
                    const currentFile = useAppStore.getState().activeFile;
                    if (currentFile === 'style_fingerprint.md' || currentFile === 'style_review.md' || currentFile === 'style_constraints_for_continuation.md' || currentFile === 'style_guide.md') {
                        void loadMainline(currentFile);
                    }
                },
                onError: (d) => {
                    lines.push(`错误: ${d.message}`);
                    setProgress('error', '文风初始化失败');
                },
            }, { forceRebuild, sourceCount: 12 });
        } catch (err: any) {
            lines.push(`错误: ${err?.message || '文风初始化失败'}`);
            setStyleInitActionState({ runState: 'error', progress: { current: currentStep, total: Math.max(totalSteps, 1), label: '文风初始化失败', lines: [...lines] } });
        }
    }, [loadMainline, store, styleInitActionState.runState]);

    const handleRefreshRollingState = useCallback(async () => {
        if (rollingActionState.runState === 'running') return;
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({ type: 'info', message: '当前 Agent 正在输出，稍后再刷新滚动队列。', ts: Date.now() });
            return;
        }
        const lines = ['读取 chapter_outline.md 与 chapter_draft.md…'];
        setRollingActionState((prev) => ({ ...prev, runState: 'running', progress: { current: 0, total: 1, label: '刷新队列', lines: [...lines] } }));
        try {
            const response = await fetchRollingWorkbenchState(store.bookRef, { batchSize: 3 });
            const next = response.workbench_state;
            lines.push(`下一步：${next.next_action}`);
            lines.push(`已写：${formatChapterArchiveSummary(next.written_chapter_numbers)}`);
            lines.push(`本轮：${formatChapterList(next.selected_card_numbers)}`);
            if (next.next_action === 'replenish_outline') { lines.push('章节卡已消耗完，需要先补纲。'); }
            setRollingActionState({ runState: 'success', state: next, progress: { current: 1, total: 1, label: '队列已刷新', lines } });
        } catch (err: any) {
            lines.push(`错误：${err?.message || '滚动队列刷新失败'}`);
            setRollingActionState((prev) => ({ ...prev, runState: 'error', progress: { current: 0, total: 1, label: '刷新失败', lines } }));
        }
    }, [rollingActionState.runState, store]);

    useEffect(() => {
        refreshRollingStateRef.current = handleRefreshRollingState;
    }, [handleRefreshRollingState]);

    const handleRunRollingContinuation = useCallback(async () => {
        if (rollingActionState.runState === 'running') return;
        if (repoIntegrity?.needsRepair) {
            store.setUiNotice({ type: 'error', message: '仓库核心布局不完整，修复后才能启动滚动续写。', ts: Date.now() });
            return;
        }
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({ type: 'info', message: '当前 Agent 正在输出，稍后再启动滚动续写。', ts: Date.now() });
            return;
        }
        if (store.fsmState === 'REVIEW' || store.fsmState === 'CONFLICT' || lateRef.current.hasPendingDraftDecision) {
            store.setWorkbenchMode('review');
            store.setUiNotice({ type: 'info', message: '当前已有待审草稿，先确权或回滚后再启动下一轮滚动续写。', ts: Date.now() });
            return;
        }
        const lines = ['刷新滚动队列…'];
        const setRunningProgress = (current: number, total: number, label: string, nextLines = lines) => {
            setRollingActionState((prev) => ({ ...prev, runState: 'running', progress: { current, total, label, lines: [...nextLines] } }));
        };
        setRunningProgress(0, 4, '准备续写');
        try {
            const payload = await buildRollingContinuationPayload(store.bookRef, { batchSize: 3 });
            const nextState = payload.workbench_state;
            lines.push(`本轮章节：${formatChapterList(nextState.selected_card_numbers)}`);
            lines.push(...buildRollingBriefLines(payload.author_writing_brief));
            lines.push('已生成章节执行包，交给 continuation Agent。');
            setRunningProgress(1, 4, '调用续写 Agent');
            let draftReady = false;
            let draftCommitId = '';
            let draftTargetFile = 'chapter_draft.md';
            let changedFiles: string[] = [];
            let streamPreviewBuffer = '';
            const abortController = new AbortController();
            await runDeductionStream(payload.intent, useAppStore.getState(), {
                onAck: (ack) => {
                    const routed = typeof ack?.routed_agent === 'string' ? ack.routed_agent : 'continuation_agent';
                    lines.push(`续写 Agent 已接单：${routed}`);
                    const taskId = typeof ack?.task_id === 'string' ? ack.task_id : '';
                    if (taskId) { lines.push(`执行编号：${taskId.slice(0, 8)}`); }
                    setRunningProgress(2, 4, '续写中');
                },
                onStage: (stage) => {
                    const text = typeof stage?.stage_text === 'string' ? stage.stage_text : '';
                    if (text) {
                        const nodeTitle = typeof stage?.node_title === 'string' ? stage.node_title : '';
                        const nodeLabel = nodeTitle ? `（${nodeTitle}）` : '';
                        lines.push(`执行阶段：${compactProgressText(text, 96)}${nodeLabel}`);
                        setRunningProgress(2, 4, '续写中');
                    }
                },
                onReasoning: (reasoningPayload) => {
                    const text = compactProgressText(reasoningPayload?.text, ROLLING_STREAM_REASONING_LIMIT);
                    if (!text) return;
                    const label = typeof reasoningPayload?.label === 'string' && reasoningPayload.label ? reasoningPayload.label : '模型过程';
                    upsertProgressLine(lines, `${label}：`, text);
                    setRunningProgress(2, 4, '续写中');
                },
                onPreview: (previewPayload) => {
                    const text = compactProgressText(previewPayload?.text, ROLLING_STREAM_PREVIEW_LIMIT);
                    if (!text) return;
                    const label = typeof previewPayload?.label === 'string' && previewPayload.label ? previewPayload.label : '模型输出预览';
                    upsertProgressLine(lines, `${label}：`, text);
                    setRunningProgress(2, 4, '续写中');
                },
                onDelta: (delta) => {
                    if (!delta) return;
                    streamPreviewBuffer = `${streamPreviewBuffer}${delta}`;
                    if (streamPreviewBuffer.length > ROLLING_STREAM_PREVIEW_LIMIT * 2) {
                        streamPreviewBuffer = streamPreviewBuffer.slice(-ROLLING_STREAM_PREVIEW_LIMIT * 2);
                    }
                    const preview = compactProgressText(streamPreviewBuffer, ROLLING_STREAM_PREVIEW_LIMIT);
                    upsertProgressLine(lines, '模型输出预览：', preview);
                    setRunningProgress(2, 4, '模型生成中');
                },
                onDraftReady: (draftPayload) => {
                    draftReady = true;
                    draftTargetFile = typeof draftPayload?.file_name === 'string' ? draftPayload.file_name : 'chapter_draft.md';
                    draftCommitId = typeof draftPayload?.commit_id === 'string' ? draftPayload.commit_id : '';
                    const draftContent = typeof draftPayload?.content === 'string' ? draftPayload.content : '';
                    changedFiles = normalizeChangedFilesPayload(draftPayload?.changed_files);
                    const reviewChangedFiles = changedFiles.includes(draftTargetFile) ? changedFiles : [draftTargetFile, ...changedFiles];
                    store.setSandboxDraft(draftContent, draftCommitId || null);
                    store.setReviewTarget(draftTargetFile, reviewChangedFiles);
                    if (draftTargetFile === store.activeFile) {
                        store.setReviewMainlineFact(store.mainlineContent, store.baseEtag);
                    } else {
                        void lateRef.current.loadReviewTargetMainline(draftTargetFile);
                    }
                    store.clearReviewReadyNotice();
                    store.setFsmState('REVIEW');
                    store.setWorkbenchMode('review');
                    lines.push(`草稿已写入：${draftTargetFile}${draftCommitId ? ` @ ${draftCommitId.slice(0, 8)}` : ''}`);
                    if (reviewChangedFiles.length > 0) { lines.push(`变更文件：${reviewChangedFiles.join(', ')}`); }
                    setRunningProgress(3, 4, '进入审阅');
                },
                onGitSyncSuccess: (syncPayload) => {
                    const commitId = typeof syncPayload?.commit_id === 'string' ? syncPayload.commit_id : typeof syncPayload?.sync_commit_id === 'string' ? syncPayload.sync_commit_id : '';
                    const fileName = typeof syncPayload?.file_name === 'string' ? syncPayload.file_name : 'chapter_draft.md';
                    lines.push(`草稿同步成功：${fileName}${commitId ? ` @ ${commitId.slice(0, 8)}` : ''}`);
                    setRunningProgress(3, 4, '草稿已同步');
                },
                onDone: (donePayload) => {
                    const doneChangedFiles = normalizeChangedFilesPayload(donePayload?.changed_files);
                    if (!changedFiles.length && doneChangedFiles.length) { changedFiles = doneChangedFiles; }
                    if (!draftCommitId && typeof donePayload?.sync_commit_id === 'string') { draftCommitId = donePayload.sync_commit_id; }
                    if (doneChangedFiles.length > 0) { lines.push(`流式任务结束：${doneChangedFiles.join(', ')}`); }
                    else { lines.push('流式任务结束：等待草稿检测。'); }
                },
                onError: (errorPayload) => {
                    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'STREAM_ERROR';
                    const message = typeof errorPayload?.message === 'string' ? errorPayload.message : '滚动续写失败';
                    throw new ApiError(typeof errorPayload?.status === 'number' ? errorPayload.status : 500, code, message, errorPayload);
                },
            }, {
                signal: abortController.signal,
                routeAgentKey: 'continuation_agent',
                activeFile: payload.target_file,
                fileType: payload.file_type,
                baseEtag: '',
                detachedJob: true,
                difyUser: payload.dify_user,
            });
            if (!draftReady) {
                lines.push('续写流程结束，但没有检测到 chapter_draft.md 草稿写入。');
                setRollingActionState((prev) => ({ ...prev, runState: 'error', progress: { current: 3, total: 4, label: '未生成草稿', lines: [...lines] } }));
                return;
            }
            try {
                const { files, integrity } = await fetchHotFiles(store.bookRef);
                setRepoIntegrity(integrity);
                if (files.length > 0) { store.setHotFiles(files); }
            } catch (err) { console.warn('Failed to refresh hot files after rolling continuation:', err); }
            await loadMainline(store.activeFile, { preserveDraftReview: true });
            if (draftTargetFile !== store.activeFile) { await lateRef.current.loadReviewTargetMainline(draftTargetFile); }
            const refreshed = await fetchRollingWorkbenchState(store.bookRef, { batchSize: 3 });
            lines.push('审阅工作台已打开，等待作者确权或回滚。');
            setRollingActionState({ runState: 'success', state: refreshed.workbench_state, progress: { current: 4, total: 4, label: '已进入审阅', lines } });
            store.setUiNotice({ type: 'success', message: draftCommitId ? `滚动续写完成，草稿提交 ${draftCommitId.slice(0, 8)} 等待审阅。` : '滚动续写完成，草稿等待审阅。', ts: Date.now() });
        } catch (err: any) {
            const message = err instanceof ApiError ? formatVisibleDeductionError(err.code, err.message) : (err?.message || '滚动续写失败');
            lines.push(`错误：${message}`);
            setRollingActionState((prev) => ({ ...prev, runState: 'error', progress: { current: 0, total: 4, label: '续写失败', lines: [...lines] } }));
            store.setUiNotice({ type: 'error', message, ts: Date.now() });
        }
    }, [lateRef, loadMainline, repoIntegrity?.needsRepair, rollingActionState.runState, store]);

    const handleRunRollingOutlineHandoff = useCallback(async () => {
        if (rollingActionState.runState === 'running') return;
        if (repoIntegrity?.needsRepair) {
            store.setUiNotice({ type: 'error', message: '仓库核心布局不完整，修复后才能启动大纲交接。', ts: Date.now() });
            return;
        }
        if (store.fsmState === 'THINKING') {
            store.setUiNotice({ type: 'info', message: '当前 Agent 正在输出，稍后再启动大纲交接。', ts: Date.now() });
            return;
        }
        if (store.fsmState === 'REVIEW' || store.fsmState === 'CONFLICT' || lateRef.current.hasPendingDraftDecision) {
            store.setWorkbenchMode('review');
            store.setUiNotice({ type: 'info', message: '当前已有待审草稿，先确权或回滚后再修复/补充章节卡。', ts: Date.now() });
            return;
        }
        const lines = ['刷新滚动队列，准备大纲交接…'];
        const setRunningProgress = (current: number, total: number, label: string, nextLines = lines) => {
            setRollingActionState((prev) => ({ ...prev, runState: 'running', progress: { current, total, label, lines: [...nextLines] } }));
        };
        setRunningProgress(0, 4, '准备大纲交接');
        try {
            const payload = await buildRollingOutlineHandoffPayload(store.bookRef, { batchSize: 3 });
            lines.push('交接模式：生成下一批章节卡');
            lines.push(`下一步：${payload.workbench_state.next_action}`);
            lines.push('已有章节卡已消耗，准备补充下一批。');
            lines.push('已生成大纲交接包，交给 outline Agent。');
            setRunningProgress(1, 4, '调用大纲 Agent');
            let draftReady = false;
            let draftCommitId = '';
            let draftTargetFile = payload.target_file;
            let changedFiles: string[] = [];
            const abortController = new AbortController();
            await runDeductionStream(payload.intent, useAppStore.getState(), {
                onAck: (ack) => {
                    const routed = typeof ack?.routed_agent === 'string' ? ack.routed_agent : 'outline';
                    lines.push(`大纲 Agent 已接单：${routed}`);
                    setRunningProgress(2, 4, '大纲处理中');
                },
                onStage: (stage) => {
                    const text = typeof stage?.stage_text === 'string' ? stage.stage_text : '';
                    if (text) { lines.push(`执行阶段：${text}`); setRunningProgress(2, 4, '大纲处理中'); }
                },
                onDraftReady: (draftPayload) => {
                    draftReady = true;
                    draftTargetFile = typeof draftPayload?.file_name === 'string' ? draftPayload.file_name : payload.target_file;
                    draftCommitId = typeof draftPayload?.commit_id === 'string' ? draftPayload.commit_id : '';
                    const draftContent = typeof draftPayload?.content === 'string' ? draftPayload.content : '';
                    const branch = typeof draftPayload?.branch === 'string' ? draftPayload.branch : store.draftBranch;
                    const diffPreview = typeof draftPayload?.diff_preview === 'string' ? draftPayload.diff_preview : '';
                    changedFiles = normalizeChangedFilesPayload(draftPayload?.changed_files);
                    const reviewChangedFiles = changedFiles.includes(draftTargetFile) ? changedFiles : [draftTargetFile, ...changedFiles];
                    store.setSandboxDraft(draftContent, draftCommitId || null);
                    store.setReviewTarget(draftTargetFile, reviewChangedFiles);
                    if (draftTargetFile === store.activeFile) {
                        store.setReviewMainlineFact(store.mainlineContent, store.baseEtag);
                    } else {
                        void lateRef.current.loadReviewTargetMainline(draftTargetFile);
                    }
                    store.setReviewReadyNotice({ fileName: draftTargetFile, branch, commitId: draftCommitId || null, diffPreview, changedFiles: reviewChangedFiles, ts: Date.now() });
                    store.setFsmState('REVIEW');
                    store.setWorkbenchMode('review');
                    lines.push(`大纲草稿已写入：${draftTargetFile}${draftCommitId ? ` @ ${draftCommitId.slice(0, 8)}` : ''}`);
                    setRunningProgress(3, 4, '进入审阅');
                },
                onDone: (donePayload) => {
                    const doneChangedFiles = normalizeChangedFilesPayload(donePayload?.changed_files);
                    if (!changedFiles.length && doneChangedFiles.length) { changedFiles = doneChangedFiles; }
                    if (!draftCommitId && typeof donePayload?.sync_commit_id === 'string') { draftCommitId = donePayload.sync_commit_id; }
                },
                onError: (errorPayload) => {
                    const code = typeof errorPayload?.code === 'string' ? errorPayload.code : 'STREAM_ERROR';
                    const message = typeof errorPayload?.message === 'string' ? errorPayload.message : '大纲交接失败';
                    throw new ApiError(typeof errorPayload?.status === 'number' ? errorPayload.status : 500, code, message, errorPayload);
                },
            }, {
                signal: abortController.signal,
                routeAgentKey: payload.route_agent_key,
                activeFile: payload.target_file,
                fileType: payload.file_type,
                baseEtag: '',
                detachedJob: true,
                difyUser: payload.dify_user,
            });
            if (!draftReady) {
                lines.push('大纲交接流程结束，但没有检测到 chapter_outline.md 草稿写入。');
                setRollingActionState((prev) => ({ ...prev, runState: 'error', progress: { current: 3, total: 4, label: '未生成大纲草稿', lines: [...lines] } }));
                return;
            }
            try {
                const { files, integrity } = await fetchHotFiles(store.bookRef);
                setRepoIntegrity(integrity);
                if (files.length > 0) { store.setHotFiles(files); }
            } catch (err) { console.warn('Failed to refresh hot files after rolling outline handoff:', err); }
            await loadMainline(store.activeFile, { preserveDraftReview: true });
            if (draftTargetFile !== store.activeFile) { await lateRef.current.loadReviewTargetMainline(draftTargetFile); }
            const refreshed = await fetchRollingWorkbenchState(store.bookRef, { batchSize: 3 });
            lines.push('大纲审阅工作台已打开，确认后将自动回到滚动队列。');
            setRollingActionState({ runState: 'success', state: refreshed.workbench_state, progress: { current: 4, total: 4, label: '已进入审阅', lines } });
            store.setUiNotice({ type: 'success', message: draftCommitId ? `大纲交接完成，草稿提交 ${draftCommitId.slice(0, 8)} 等待审阅。` : '大纲交接完成，草稿等待审阅。', ts: Date.now() });
        } catch (err: any) {
            const message = err instanceof ApiError ? formatVisibleDeductionError(err.code, err.message) : (err?.message || '大纲交接失败');
            lines.push(`错误：${message}`);
            setRollingActionState((prev) => ({ ...prev, runState: 'error', progress: { current: 0, total: 4, label: '大纲交接失败', lines: [...lines] } }));
            store.setUiNotice({ type: 'error', message, ts: Date.now() });
        }
    }, [lateRef, loadMainline, repoIntegrity?.needsRepair, rollingActionState.runState, store]);

    return {
        worldInitActionState,
        styleInitActionState,
        rollingActionState,
        postConfirmHandoffState,
        handleRunWorldInitAction,
        handleRunStyleInitAction,
        handleRefreshRollingState,
        handleRunRollingContinuation,
        handleRunRollingOutlineHandoff,
        runPostConfirmWorldDistill,
        runPostConfirmWorldDistillFromResult,
        handleRunPostConfirmHandoff,
        refreshRollingStateRef,
    };
}
