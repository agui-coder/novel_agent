interface GitLockedPanelProps {
    repairPending: boolean;
    onRepairLayout: () => void;
}

export const GitLockedPanel: React.FC<GitLockedPanelProps> = ({ repairPending, onRepairLayout }) => (
    <div className="flex h-full min-h-0 items-center justify-center bg-[#0b1119] p-6">
        <div className="w-full max-w-xl rounded-2xl border border-[#7f5a2e] bg-[linear-gradient(180deg,#1f140b_0%,#120d08_100%)] p-6 text-left shadow-[0_22px_46px_rgba(0,0,0,0.34)]">
            <div className="text-[10px] font-mono uppercase tracking-[0.16em] text-[#f2bf72]">Git Console Locked</div>
            <div className="mt-2 text-xl font-semibold text-[#fff1d6]">当前历史状态缺少核心布局，Git 工作台已冻结</div>
            <div className="mt-2 text-sm leading-6 text-[#d9bf95]">
                这是硬回退后的保护态，不再允许 GET 路径偷偷补文件。先执行一次显式修复，再继续查看分支、提交和 Diff。
            </div>
            <button
                type="button"
                onClick={() => { void onRepairLayout(); }}
                disabled={repairPending}
                className="mt-5 rounded-lg border border-[#f2bf72] bg-[#4a2e12] px-4 py-2 text-sm font-bold text-[#fff4e2] transition-colors hover:bg-[#61401a] disabled:cursor-not-allowed disabled:opacity-50"
            >
                {repairPending ? '修复中…' : '修复后重新载入 Git 视图'}
            </button>
        </div>
    </div>
);
