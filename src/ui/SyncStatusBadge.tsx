import React from 'react';
import { FolderSync, RefreshCw, FolderKey, AlertTriangle, AlertCircle, X } from 'lucide-react';
import { SyncStatus } from '../storage/diskSync';
import { useTranslation } from '../i18n/useTranslation';

interface SyncStatusBadgeProps {
  status: SyncStatus;
  folderName: string | null;
  conflictCount: number;
  error: string | null;
  onSyncNow: () => void;
  onReconnect: () => void;
  onOpenConflicts: () => void;
  onOpenSyncSettings: () => void;
}

export default function SyncStatusBadge({
  status,
  folderName,
  conflictCount,
  error,
  onSyncNow,
  onReconnect,
  onOpenConflicts,
  onOpenSyncSettings,
}: SyncStatusBadgeProps) {
  const { t } = useTranslation();

  // Stay unobtrusive when no folder is linked or browser does not support FS Access API
  if (status === 'disconnected' || status === 'unsupported') {
    return null;
  }

  if (status === 'syncing') {
    return (
      <span
        className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border border-[var(--border)] text-[11px] font-medium text-[var(--foreground)] opacity-80 select-none"
        title={folderName ? `${folderName}` : undefined}
      >
        <RefreshCw size={12} className="animate-spin text-[var(--accent)]" />
        <span>{t('syncStatusSyncing')}</span>
      </span>
    );
  }

  if (status === 'needs-permission') {
    return (
      <button
        onClick={onReconnect}
        className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 text-[11px] font-semibold transition-colors cursor-pointer"
        title={folderName ? `${t('reconnectFolder')}: ${folderName}` : t('reconnectFolder')}
      >
        <FolderKey size={12} />
        <span>{t('syncStatusNeedsPerm')}</span>
      </button>
    );
  }

  if (status === 'conflict') {
    return (
      <button
        onClick={onOpenConflicts}
        className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-[11px] font-bold transition-colors cursor-pointer"
        title={t('syncConflictTitle')}
      >
        <AlertTriangle size={12} />
        <span>
          {t('syncStatusConflict')} ({conflictCount})
        </span>
      </button>
    );
  }

  if (status === 'error') {
    return (
      <button
        onClick={onOpenSyncSettings}
        className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 text-[11px] font-semibold transition-colors cursor-pointer"
        title={error || t('syncStatusError')}
      >
        <AlertCircle size={12} />
        <span>{t('syncStatusError')}</span>
      </button>
    );
  }

  // 'synced'
  return (
    <button
      onClick={onSyncNow}
      className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 border border-[var(--border)] hover:bg-[var(--border)]/40 text-[11px] font-medium text-[var(--foreground)] opacity-85 hover:opacity-100 transition-colors cursor-pointer"
      title={folderName ? `${t('linkedFolder')}: ${folderName} — ${t('syncNow')}` : t('syncNow')}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
      <FolderSync size={12} className="opacity-75" />
      <span className="max-w-[110px] truncate">{folderName || t('syncStatusSynced')}</span>
    </button>
  );
}

interface SyncToastProps {
  message: string | null;
  onDismiss: () => void;
}

export function SyncToast({ message, onDismiss }: SyncToastProps) {
  if (!message) return null;

  return (
    <div className="fixed bottom-16 sm:bottom-5 right-5 z-50 flex items-center gap-2.5 px-3.5 py-2.5 bg-white dark:bg-[#1e1e1d] border border-[var(--border)] shadow-lg text-xs text-[var(--foreground)]">
      <FolderSync size={14} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
      <span className="font-medium">{message}</span>
      <button
        onClick={onDismiss}
        className="p-0.5 opacity-60 hover:opacity-100 cursor-pointer"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}
