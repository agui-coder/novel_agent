import type { ReactNode } from 'react';

export function RailIcon({ path, active }: { path: ReactNode; active: boolean }) {
    return (
        <span
            className={`inline-flex h-5 w-5 items-center justify-center transition-colors ${
                active ? 'text-[var(--color-dark-text-main)]' : 'text-[var(--color-dark-text-faint)]'
            }`}
            aria-hidden="true"
        >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="h-5 w-5">
                {path}
            </svg>
        </span>
    );
}
