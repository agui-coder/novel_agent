import { RailIcon } from './RailIcon';
import { getUiCopy } from '../i18n/ui';
import type { WorkbenchMode } from '../types/store';

interface ActivityBarProps {
    workbenchMode: WorkbenchMode;
    isGitMode: boolean;
    editorRailActive: boolean;
    uiLanguage: 'zh-CN' | 'en-US';
    onModeChange: (mode: WorkbenchMode) => void;
}

export const ActivityBar: React.FC<ActivityBarProps> = ({ workbenchMode: _wm, isGitMode, editorRailActive, uiLanguage, onModeChange }) => {
    const copy = getUiCopy(uiLanguage);
    void _wm;
    return (
        <div className="flex h-full flex-col items-center justify-between px-2 py-3">
            <div className="flex flex-col items-center gap-2">
                <button
                    type="button"
                    onClick={() => onModeChange('editor')}
                    className={`flex h-11 w-11 items-center justify-center rounded-[12px] border transition-colors ${
                        editorRailActive
                            ? 'border-[rgba(115,134,255,0.46)] bg-[rgba(115,134,255,0.14)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                            : 'border-transparent bg-transparent hover:border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.02)]'
                    }`}
                    aria-label={copy.workbench.editorRail}
                >
                    <RailIcon
                        active={editorRailActive}
                        path={<path d="M5.25 3.75h6.5l3 3v9.5H5.25zM11.75 3.75v3h3" />}
                    />
                </button>
                <button
                    type="button"
                    onClick={() => onModeChange('git')}
                    className={`flex h-11 w-11 items-center justify-center rounded-[12px] border transition-colors ${
                        isGitMode
                            ? 'border-[rgba(115,134,255,0.46)] bg-[rgba(115,134,255,0.14)] shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
                            : 'border-transparent bg-transparent hover:border-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.02)]'
                    }`}
                    aria-label={copy.workbench.gitRail}
                >
                    <RailIcon
                        active={isGitMode}
                        path={
                            <>
                                <circle cx="6" cy="5.5" r="1.75" />
                                <circle cx="14" cy="10" r="1.75" />
                                <circle cx="6" cy="14.5" r="1.75" />
                                <path d="M7.5 6.4 12.5 9.1M7.5 13.6l5-2.7" />
                            </>
                        }
                    />
                </button>
            </div>
            <div className="h-9 w-9 rounded-[10px] border border-[rgba(255,255,255,0.04)] bg-[rgba(255,255,255,0.012)]" />
        </div>
    );
};
