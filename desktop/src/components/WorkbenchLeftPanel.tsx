import { Group, Panel, Separator } from "react-resizable-panels";
import { getFileTypeLabel, getUiCopy } from "../i18n/ui";
import { WorkbenchModeToggle } from "./WorkbenchModeToggle";
import { GitBranchPanel } from "./GitBranchPanel";
import { FileExplorer } from "./FileExplorer";
import { OutlineNavigator } from "./OutlineNavigator";
import type { RepoIntegrity, WorkbenchMode, HotFileItem, GitStatusSummary, GitBranchRow } from "../types/store";

interface WorkbenchLeftPanelProps {
    bookName: string;
    activeFile: string;
    activeFileType: HotFileItem["fileType"];
    uiLanguage: "zh-CN" | "en-US";
    workbenchMode: WorkbenchMode;
    isGitMode: boolean;
    isReviewMode: boolean;
    leftPanelTitle: string;
    repoIntegrity: RepoIntegrity | null;
    bootstrapState: "bootstrapping" | "loaded";
    repairPending: boolean;
    outlineSourceContent: string;
    explorerFiles: HotFileItem[];
    explorerFileKey: string;
    hasPendingDraftDecision: boolean;
    leftRailVerticalLayout: ReturnType<typeof import("react-resizable-panels").useDefaultLayout>;
    draftContent: string;
    mainlineContent: string;
    gitStatus: GitStatusSummary | null;
    gitBranches: GitBranchRow[];
    selectedGitBranchName: string | null;
    selectedGitCommitId: string | null;
    gitActionPending: boolean;
    onChangeLanguage: (lang: "zh-CN" | "en-US") => void;
    onRepairLayout: () => void;
    onFileSelect: (file: HotFileItem) => void;
    onGitRefresh: () => void;
    onGitSelectBranch: (name: string) => void;
    onGitCheckout: (name: string) => void;
    onGitMerge: (payload: any) => void;
    onGitCreateBranch: (payload: any) => void;
    onGitRenameBranch: (payload: any) => void;
    onGitHardRollback: (targetCommit: string) => void;
}

export function WorkbenchLeftPanel({
    bookName, activeFile, activeFileType, uiLanguage, workbenchMode,
    isGitMode, isReviewMode, leftPanelTitle, repoIntegrity, bootstrapState,
    repairPending, outlineSourceContent, explorerFiles, explorerFileKey,
    hasPendingDraftDecision, leftRailVerticalLayout, draftContent, mainlineContent,
    gitStatus, gitBranches, selectedGitBranchName, selectedGitCommitId, gitActionPending,
    onChangeLanguage, onRepairLayout, onFileSelect,
    onGitRefresh, onGitSelectBranch, onGitCheckout, onGitMerge,
    onGitCreateBranch, onGitRenameBranch, onGitHardRollback,
}: WorkbenchLeftPanelProps) {
    const copy = getUiCopy(uiLanguage);
    return (
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="border-b border-[var(--color-dark-border)] px-3 py-3">
                <div className="cursor-section-label">
                    {isGitMode ? copy.workbench.versionControl : copy.workbench.workspace}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2.5">
                    <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-[var(--color-dark-text-main)]">{leftPanelTitle}</div>
                        <div className="truncate text-[10px] text-[var(--color-dark-text-faint)]">
                            {bookName || copy.workbench.noBookSelected}
                        </div>
                    </div>
                    <div className="rounded-[8px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.015)] px-2 py-[3px] text-[9px] font-mono text-[var(--color-dark-text-faint)]">
                        {isGitMode ? copy.workbench.repository : isReviewMode ? copy.workbench.reviewState : getFileTypeLabel(uiLanguage, activeFileType)}
                    </div>
                </div>
            </div>
            <WorkbenchModeToggle
                uiLanguage={uiLanguage}
                onChangeLanguage={onChangeLanguage}
            />
            {repoIntegrity?.needsRepair && bootstrapState === 'loaded' && (
                <div className="border-b border-[#583d1f] bg-[linear-gradient(180deg,#24180d_0%,#1a120a_100%)] px-3 py-3">
                    <div className="rounded-xl border border-[#7f5a2e] bg-[#120d08] p-3 shadow-[0_10px_24px_rgba(0,0,0,0.28)]">
                        <div className="text-[10px] font-mono tracking-[0.14em] text-[#f2bf72]">仓库修复</div>
                        <div className="mt-1 text-sm font-semibold text-[#fff1d6]">当前仓库核心布局不完整</div>
                        <div className="mt-1 text-[11px] leading-5 text-[#d9bf95]">
                            缺失或未追踪文件：{(repoIntegrity ? [repoIntegrity!.missingCoreFiles, repoIntegrity.untrackedLayoutFiles].flat().slice(0, 3).join("、") : "") || "核心底座"}
                        </div>
                        <button
                            type="button"
                            onClick={() => { void onRepairLayout(); }}
                            disabled={repairPending}
                            className="mt-3 w-full rounded-lg border border-[#f2bf72] bg-[#4a2e12] px-3 py-2 text-xs font-bold text-[#fff4e2] transition-colors hover:bg-[#61401a] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {repairPending ? '修复中…' : '修复仓库布局'}
                        </button>
                    </div>
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
                {isGitMode ? (
                    <GitBranchPanel
                        status={gitStatus}
                        branches={gitBranches}
                        selectedBranchName={selectedGitBranchName}
                        selectedCommitId={selectedGitCommitId}
                        chapterDraftContent={activeFile === 'chapter_draft.md' ? (draftContent || mainlineContent) : ''}
                        pending={gitActionPending}
                        onRefresh={() => {
                            void onGitRefresh();
                        }}
                        onSelectBranch={(branchName) => {
                            void onGitSelectBranch(branchName);
                        }}
                        onCheckout={(branchName) => {
                            void onGitCheckout(branchName);
                        }}
                        onMerge={(payload) => {
                            void onGitMerge(payload);
                        }}
                        onCreateBranch={(payload) => {
                            void onGitCreateBranch(payload);
                        }}
                        onRenameBranch={(payload) => {
                            void onGitRenameBranch(payload);
                        }}
                        onHardRollback={(targetCommit) => {
                            void onGitHardRollback(targetCommit);
                        }}
                    />
                ) : (
                    <Group
                        orientation="vertical"
                        className="h-full min-h-0"
                        data-left-rail-stack="true"
                        defaultLayout={leftRailVerticalLayout.defaultLayout}
                        onLayoutChanged={leftRailVerticalLayout.onLayoutChanged}
                    >
                        <Panel id="left-files-panel" defaultSize="52%" minSize="18%">
                            <div className="flex h-full min-h-0 flex-col overflow-hidden">
                                <div className="border-b border-[rgba(255,255,255,0.035)] px-3 py-2">
                                    <div className="cursor-section-label">{copy.explorer.filesSection}</div>
                                </div>
                                <div className="min-h-0 flex-1 overflow-hidden">
                                    <FileExplorer
                                        key={explorerFileKey}
                                        files={explorerFiles}
                                        activeFile={activeFile}
                                        disabled={hasPendingDraftDecision}
                                        hotkeysEnabled={workbenchMode !== 'git'}
                                        onSelectFile={onFileSelect}
                                    />
                                </div>
                            </div>
                        </Panel>
                        <Separator className="group relative h-3 shrink-0 cursor-row-resize bg-transparent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-blue)]">
                            <div className="absolute inset-x-4 top-1/2 h-px -translate-y-1/2 rounded-full bg-[rgba(255,255,255,0.05)] transition-all duration-150 group-hover:inset-x-3 group-hover:bg-[rgba(255,255,255,0.18)]" />
                            <div className="absolute left-1/2 top-1/2 hidden h-[3px] w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(255,255,255,0.14)] blur-[1px] transition-opacity duration-150 group-hover:block" />
                        </Separator>
                        <Panel id="left-outline-panel" defaultSize="48%" minSize="20%">
                            <div className="h-full min-h-0 overflow-hidden border-t border-[rgba(255,255,255,0.035)]">
                                <OutlineNavigator
                                    content={outlineSourceContent}
                                    activeFile={activeFile}
                                />
                            </div>
                        </Panel>
                    </Group>
                )}
            </div>
        </div>
    );
}
