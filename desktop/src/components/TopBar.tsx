import { getUiCopy } from '../i18n/ui';
import type { WorkbenchMode } from '../types/store';

interface TopBarProps {
    bookName: string;
    activeFile: string;
    workbenchMode: WorkbenchMode;
    isGitMode: boolean;
    isReviewMode: boolean;
    uiLanguage: 'zh-CN' | 'en-US';
    onBackToBookshelf: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({ bookName, activeFile, workbenchMode, isGitMode, isReviewMode, uiLanguage, onBackToBookshelf }) => {
    const copy = getUiCopy(uiLanguage);
    return (
        <div className="flex w-full items-center gap-4">
            <button
                type="button"
                onClick={onBackToBookshelf}
                className="flex shrink-0 items-center gap-1.5 rounded-[10px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.016)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-dark-text-muted)] transition-colors hover:border-[rgba(115,134,255,0.32)] hover:text-[var(--color-dark-text-main)]"
            >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-3.5 w-3.5">
                    <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H14l3 3v10.5a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 4 15.5v-11Z" />
                </svg>
                <span>书架</span>
            </button>
            <div className="min-w-0 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[rgba(115,134,255,0.14)] text-[var(--color-dark-text-main)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.7">
                        <path d="M10 2.8 16.2 6v8L10 17.2 3.8 14V6 10" />
                        <path d="M10 2.8v6.1L3.8 10" />
                        <path d="M16.2 6 10 8.9" />
                    </svg>
                </div>
                <div className="min-w-0">
                    <div className="truncate text-[13px] font-semibold text-[var(--color-dark-text-main)]">
                        {bookName || copy.workbench.noBookSelected}
                    </div>
                </div>
            </div>
            <button
                type="button"
                className="novel-quick-open flex min-w-0 max-w-[360px] flex-1 items-center gap-2 rounded-[10px] border border-[rgba(255,255,255,0.05)] bg-[rgba(255,255,255,0.012)] px-3 py-2 text-left text-[12px] text-[var(--color-dark-text-faint)] transition-colors hover:border-[rgba(255,255,255,0.1)] hover:text-[var(--color-dark-text-main)]"
            >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-4 w-4 shrink-0">
                    <circle cx="8.5" cy="8.5" r="4.5" />
                    <path d="m12 12 4 4" />
                </svg>
                <span className="truncate">{copy.workbench.quickOpen}</span>
            </button>
            <div className="ml-auto flex items-center gap-2 text-[10px] font-mono text-[var(--color-dark-text-faint)]">
                <span className="rounded-[8px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.012)] px-2 py-1">
                    {isGitMode ? copy.workbench.gitRail : isReviewMode ? copy.workbench.reviewState : copy.workbench.editorRail}
                </span>
                <span className="truncate">{activeFile}</span>
            </div>
        </div>
    );
};
