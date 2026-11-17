import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, HardDrive, Monitor, X } from 'lucide-react';
import { SyncConflict } from '../storage/diskSync';
import { useTranslation } from '../i18n/useTranslation';

interface SyncConflictModalProps {
  isOpen: boolean;
  conflicts: SyncConflict[];
  onResolve: (conflict: SyncConflict, choice: 'idb' | 'disk') => Promise<void> | void;
  onClose: () => void;
}

interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

/**
 * Lightweight line-level LCS diff bounded for crisp UI previews.
 */
function computeLineDiff(leftText: string, rightText: string): DiffLine[] {
  const left = leftText.replace(/\r\n/g, '\n').split('\n').slice(0, 250);
  const right = rightText.replace(/\r\n/g, '\n').split('\n').slice(0, 250);
  const m = left.length;
  const n = right.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (left[i] === right[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (left[i] === right[j]) {
      out.push({ kind: 'same', text: left[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'removed', text: left[i] });
      i++;
    } else {
      out.push({ kind: 'added', text: right[j] });
      j++;
    }
  }
  while (i < m) {
    out.push({ kind: 'removed', text: left[i++] });
  }
  while (j < n) {
    out.push({ kind: 'added', text: right[j++] });
  }
  return out;
}

export default function SyncConflictModal({
  isOpen,
  conflicts,
  onResolve,
  onClose,
}: SyncConflictModalProps) {
  const { t } = useTranslation();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [resolvingPath, setResolvingPath] = useState<string | null>(null);

  const safeIdx = Math.min(selectedIdx, Math.max(0, conflicts.length - 1));
  const active = conflicts[safeIdx] || null;

  const diffLines = useMemo(() => {
    if (!active) return [];
    return computeLineDiff(active.idbContent, active.diskContent);
  }, [active]);

  if (!isOpen || conflicts.length === 0 || !active) return null;

  const handleChoose = async (choice: 'idb' | 'disk') => {
    setResolvingPath(active.idbPath);
    try {
      await onResolve(active, choice);
      setSelectedIdx(0);
    } finally {
      setResolvingPath(null);
    }
  };

  const wordCountOf = (str: string) => {
    const trimmed = str.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 select-none">
      <div className="w-full max-w-4xl max-h-[90vh] bg-white dark:bg-[#1e1e1d] border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border)] bg-[var(--sidebar-bg)]">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 shrink-0">
              <AlertTriangle size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-[var(--foreground)]">{t('syncConflictTitle')}</h3>
              <p className="text-xs opacity-75 mt-0.5">{t('syncConflictSubtitle')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-[var(--border)] text-[var(--foreground)] opacity-70 hover:opacity-100 cursor-pointer"
            aria-label={t('close')}
          >
            <X size={16} />
          </button>
        </div>

        {/* Conflict File Tabs if multiple */}
        {conflicts.length > 1 && (
          <div className="flex items-center gap-1 px-5 py-2 border-b border-[var(--border)] overflow-x-auto bg-[var(--background)]">
            {conflicts.map((c, idx) => (
              <button
                key={c.idbPath}
                onClick={() => setSelectedIdx(idx)}
                className={`px-2.5 py-1 text-xs font-semibold border transition-colors whitespace-nowrap cursor-pointer ${
                  idx === safeIdx
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                    : 'border-[var(--border)] opacity-70 hover:opacity-100'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}

        {/* Active Conflict Meta */}
        <div className="px-5 py-3 border-b border-[var(--border)] flex flex-wrap items-center justify-between gap-3 text-xs bg-[var(--editor-bg)]">
          <div>
            <span className="font-bold text-[var(--foreground)]">{active.label}</span>
            <span className="ml-2 font-mono text-[11px] opacity-65">{active.diskPath}</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] opacity-75">
            <span className="inline-flex items-center gap-1">
              <Monitor size={12} />
              {t('browserVersionLabel')}: {wordCountOf(active.idbContent)} {t('words')}
            </span>
            <span className="inline-flex items-center gap-1">
              <HardDrive size={12} />
              {t('diskVersionLabel')}: {wordCountOf(active.diskContent)} {t('words')} ({new Date(active.diskMtimeMs).toLocaleString()})
            </span>
          </div>
        </div>

        {/* Unified Line Diff Preview */}
        <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed bg-[var(--background)] select-text">
          <div className="border border-[var(--border)] divide-y divide-[var(--border)]/30">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={`px-3 py-0.5 whitespace-pre-wrap break-words ${
                  line.kind === 'removed'
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300'
                    : line.kind === 'added'
                    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : 'opacity-75'
                }`}
              >
                <span className="inline-block w-4 select-none opacity-60">
                  {line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' '}
                </span>
                {line.text || ' '}
              </div>
            ))}
          </div>
        </div>

        {/* Resolution Footer */}
        <div className="px-5 py-3.5 border-t border-[var(--border)] bg-[var(--sidebar-bg)] flex flex-wrap items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-3 py-1.5 border border-[var(--border)] hover:bg-[var(--border)] text-xs font-semibold cursor-pointer"
          >
            {t('close')}
          </button>
          <button
            disabled={resolvingPath === active.idbPath}
            onClick={() => handleChoose('idb')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 border border-[var(--border)] bg-white dark:bg-[#20201e] hover:border-[var(--accent)] text-xs font-bold text-[var(--foreground)] cursor-pointer disabled:opacity-50"
          >
            <Monitor size={13} />
            <span>{t('keepBrowserVersion')}</span>
          </button>
          <button
            disabled={resolvingPath === active.idbPath}
            onClick={() => handleChoose('disk')}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[var(--accent)] text-white hover:opacity-90 text-xs font-bold cursor-pointer disabled:opacity-50"
          >
            <Check size={13} />
            <span>{t('useDiskVersion')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
