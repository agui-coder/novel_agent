import { MainlineView } from "./MainlineView";
import { getUiCopy } from "../i18n/ui";
import type { RepoIntegrity, FsmState } from "../types/store";

interface EditorCenterPanelProps {
    activeFile: string;
    baseEtag: string;
    editorContent: string;
    editorSaveState: "idle" | "saving" | "error";
    isEditing: boolean;
    editDraft: string;
    isSaving: boolean;
    saveConflict: { draftFile: string } | null;
    repoIntegrity: RepoIntegrity | null;
    mainlineFileState: { exists: boolean; virtual: boolean } | null;
    bootstrapState: "bootstrapping" | "loaded";
    repairPending: boolean;
    fsmState: FsmState;
    uiLanguage: "zh-CN" | "en-US";
    onRepairLayout: () => void;
    onDismissConflict: () => void;
    onPullLatest: () => void;
    onEnterEdit: () => void;
    onCancelEdit: () => void;
    onSaveEdit: () => void;
    onEditDraftChange: (next: string) => void;
}

export const EditorCenterPanel: React.FC<EditorCenterPanelProps> = ({
    activeFile, baseEtag, editorContent, editorSaveState,
    isEditing, editDraft, isSaving, saveConflict,
    repoIntegrity, mainlineFileState, bootstrapState,
    repairPending, fsmState, uiLanguage,
    onRepairLayout, onDismissConflict, onPullLatest,
    onEnterEdit, onCancelEdit, onSaveEdit, onEditDraftChange,
}) => {
    const copy = getUiCopy(uiLanguage);
    return (
        <>
            {/* Conflict guard modal — draft-file UX, no force-overwrite */}
            {saveConflict && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div className="workspace-strip w-[520px] rounded-[16px] border border-[var(--tone-warning-border)] bg-[var(--tone-warning-bg)] p-6 shadow-[0_24px_50px_rgba(0,0,0,0.35)]">
                        <div className="mb-2 text-sm font-bold text-[var(--tone-warning-text)]">⚠️ 写入冲突 — 你的修改已自动存为草稿</div>
                        <div className="mb-4 text-xs text-[var(--color-dark-text-muted)] leading-relaxed">
                            在你编辑期间，AI Agent 已向此文件提交了更新（ETag 已变更）。<br />
                            为防止内容丢失，你的修改已被系统自动保存到：
                        </div>
                        <div className="mb-4 rounded-[12px] border border-[rgba(255,255,255,0.08)] bg-[rgba(9,12,16,0.9)] px-3 py-2 font-mono text-[11px] text-[var(--tone-warning-text)] break-all">
                            📄 {saveConflict.draftFile}
                        </div>
                        <div className="mb-4 text-xs text-[var(--color-dark-text-muted)] leading-relaxed">
                            请在文件管理器中打开该草稿，复制你需要的内容，然后<strong className="text-white">删除草稿文件</strong>。<br />
                            点击「拉取最新」可查看 AI 的当前版本。
                        </div>
                        <div className="flex gap-3 justify-end">
                            <button
                                onClick={onPullLatest}
                                className="rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.08)] px-4 py-2 text-xs font-semibold text-[var(--color-dark-text-main)] hover:bg-[rgba(255,255,255,0.12)]"
                            >📥 拉取最新版本</button>
                            <button
                                onClick={onDismissConflict}
                                className="rounded px-4 py-2 text-xs border border-[var(--color-dark-border)] text-[var(--color-dark-text-muted)] hover:bg-white/5"
                            >关闭（稍后处理）</button>
                        </div>
                    </div>
                </div>
            )}
            {repoIntegrity?.needsRepair && bootstrapState === 'loaded' && (
                <div className="border-b border-[var(--tone-warning-border)] bg-transparent px-4 py-3">
                    <div className="workspace-strip flex items-center justify-between gap-4 rounded-[14px] border border-[var(--tone-warning-border)] bg-[var(--tone-warning-bg)] px-4 py-3">
                        <div className="min-w-0">
                            <div className="cursor-section-label text-[var(--tone-warning-text)]">Integrity Guard</div>
                            <div className="mt-1 text-sm font-semibold text-[#fff1d6]">已切入只读保护态，正常保存 / AI / Git 均已阻断</div>
                            <div className="text-[11px] leading-5 text-[#d9bf95]">
                                缺失核心文件：{repoIntegrity.missingCoreFiles.join('、') || '无'}
                                {repoIntegrity.untrackedLayoutFiles.length > 0 ? `；未追踪：${repoIntegrity.untrackedLayoutFiles.join('、')}` : ''}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => { void onRepairLayout(); }}
                            disabled={repairPending}
                            className="shrink-0 rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.06)] px-4 py-2 text-xs font-bold text-[#fff4e2] transition-colors hover:bg-[rgba(255,255,255,0.1)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {repairPending ? '修复中…' : '立即修复'}
                        </button>
                    </div>
                </div>
            )}
            {!repoIntegrity?.needsRepair && mainlineFileState?.virtual && (
                <div className="border-b border-[var(--color-dark-border)] bg-[rgba(255,255,255,0.025)] px-4 py-2.5 text-[11px] text-[var(--color-dark-text-faint)]">
                    当前文件在此状态下不存在，正在使用虚拟空文件预览：`{activeFile}`。修复布局后将恢复真实物理文件。
                </div>
            )}
            <div className="flex items-center justify-between border-b border-[var(--color-dark-border)] p-2 px-4 text-xs font-mono">
                {/* Left: file name + ETAG */}
                <span className="text-[var(--color-dark-text-muted)]">{copy.editor.mainlineContent(activeFile)}
                    {!isEditing && <span className="ml-2 opacity-50">{copy.editor.etag}: {baseEtag?.slice(0, 8) || '…'}</span>}
                </span>
                {/* Right: action buttons */}
                <span className="flex items-center gap-2">
                    {!isEditing ? (
                        <>
                            <span className="opacity-50">{editorSaveState === 'saving' ? '⏳ 保存中' : editorSaveState === 'error' ? '❌ 保存失败' : ''}</span>
                            <span className="text-[11px] text-[var(--color-dark-text-muted)]">{copy.editor.editorEntryBottom}</span>
                        </>
                    ) : (
                        <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold text-amber-300 animate-pulse">
                            ● {copy.editor.editing}
                        </span>
                    )}
                </span>
            </div>
            <div className="relative min-h-0 flex-1 overflow-hidden">
                {!isEditing && (
                    <MainlineView
                        mode="view"
                        fileName={activeFile}
                        content={editorContent}
                        readOnly
                    />
                )}
                <div
                    className={`absolute inset-x-3 bottom-3 z-20 flex h-[80vh] min-h-0 flex-col overflow-hidden rounded-t-[18px] border border-[var(--color-dark-border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.018)_0%,rgba(255,255,255,0)_100%),rgba(17,20,26,0.98)] shadow-[0_-20px_45px_rgba(0,0,0,0.6)] transition-all duration-200 ${
                        isEditing ? 'translate-y-0 opacity-100' : 'translate-y-full opacity-0 pointer-events-none'
                    }`}
                    aria-hidden={!isEditing}
                    inert={!isEditing}
                >
                    <div className="flex items-center justify-between border-b border-[var(--color-dark-border)] bg-[rgba(255,255,255,0.02)] px-4 py-2.5 text-[12px] font-mono">
                        <span className="text-[var(--color-dark-text-main)] font-semibold">{copy.editor.bottomEditor(activeFile)}</span>
                        <span className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-bold text-amber-300 animate-pulse">
                                ● {copy.editor.editing}
                            </span>
                            <button
                                onClick={onCancelEdit}
                                disabled={isSaving}
                                className="rounded-md border border-[#ffb86b] bg-[#4a2b11] px-4 py-1.5 text-[11px] font-semibold text-[#ffd9ac] shadow-[0_0_0_1px_rgba(255,184,107,0.15)] transition-all hover:border-[#ffc37d] hover:bg-[#663815] disabled:opacity-40"
                            >{copy.editor.collapseEditor}</button>
                            <button
                                onClick={() => void onSaveEdit()}
                                disabled={isSaving}
                                className="rounded-md border border-[var(--tone-success-border)] bg-[var(--tone-success-bg)] px-4 py-1.5 text-[11px] font-bold text-[var(--tone-success-text)] transition-all hover:bg-[rgba(255,255,255,0.12)] disabled:opacity-40"
                            >{isSaving ? `⏳ ${copy.editor.saving}` : copy.editor.saveAndCollapse}</button>
                        </span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-hidden">
                        <MainlineView
                            mode="edit"
                            fileName={activeFile}
                            content={editDraft}
                            readOnly={false}
                            onChange={(next) => {
                                onEditDraftChange(next);
                            }}
                        />
                    </div>
                </div>
            </div>
            {!isEditing && (
                <div className="px-4 pb-2 pt-3">
                    <div className="workspace-strip-muted rounded-[14px] px-4 py-3">
                        <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0">
                                <div className="cursor-section-label">{copy.editor.humanEdit}</div>
                                <div className="mt-1 text-sm font-semibold text-[var(--color-dark-text-main)]">{copy.editor.editMainline}</div>
                                <div className="text-[11px] text-[var(--color-dark-text-faint)]">{copy.editor.editHint}</div>
                            </div>
                            <button
                                onClick={onEnterEdit}
                                disabled={fsmState === 'THINKING' || isSaving || Boolean(repoIntegrity?.needsRepair)}
                                className="shrink-0 rounded-[12px] border border-[rgba(255,255,255,0.14)] bg-[rgba(255,255,255,0.06)] px-4 py-2 text-xs font-bold tracking-wide text-[var(--color-dark-text-main)] transition-all duration-150 hover:-translate-y-[1px] hover:bg-[rgba(255,255,255,0.1)] disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                {copy.editor.expandEditor}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
};
