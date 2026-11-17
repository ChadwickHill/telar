import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Atom,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Filter,
  Info,
  MapPin,
  Search,
  Users,
} from 'lucide-react';
import {
  Chapter,
  Character,
  Item,
  Location,
  WorldRule,
} from '../storage/schemas';
import {
  buildSceneEntityMatrix,
  ChapterGapWarning,
  EntityCategory,
  MatrixChapterColumn,
  MatrixEntityRow,
} from '../editor/entityMatrix';
import { useTranslation } from '../i18n/useTranslation';

interface ContinuityMatrixProps {
  projectTitle: string;
  chapters: Chapter[];
  chapterOrder: string[];
  chapterMarkdowns: Record<string, string>;
  wordCounts: Record<string, number>;
  continuityList: Record<string, string>;
  characters: Character[];
  locations: Location[];
  items: Item[];
  worldRules: WorldRule[];
  povCharacterId?: string;
  isLoadingMarkdowns?: boolean;
  onSelectChapter: (chapterId: string) => void;
  onSelectChapterContinuity: (chapterId: string) => void;
  onJumpToChapterSearch: (chapterId: string, searchTerm: string) => void;
  onOpenBibleEntity: (category: EntityCategory, entityId: string) => void;
}

const DEFAULT_CATEGORY_COLOR: Record<EntityCategory, string> = {
  character: '#10b981',
  location: '#3b82f6',
  item: '#8b5cf6',
  'world-rule': '#f59e0b',
};

function escapeCsvCell(val: string | number): string {
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default function ContinuityMatrix({
  projectTitle,
  chapters,
  chapterOrder,
  chapterMarkdowns,
  wordCounts,
  continuityList,
  characters,
  locations,
  items,
  worldRules,
  povCharacterId,
  isLoadingMarkdowns = false,
  onSelectChapter,
  onSelectChapterContinuity,
  onJumpToChapterSearch,
  onOpenBibleEntity,
}: ContinuityMatrixProps) {
  const { t } = useTranslation();

  const [categoryFilter, setCategoryFilter] = useState<'all' | EntityCategory>('all');
  const [showGapsOnly, setShowGapsOnly] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<EntityCategory, boolean>>({
    character: false,
    location: false,
    item: false,
    'world-rule': false,
  });

  const matrix = useMemo(
    () =>
      buildSceneEntityMatrix({
        chapters,
        chapterOrder,
        chapterMarkdowns,
        continuityList,
        characters,
        locations,
        items,
        worldRules,
        povCharacterId,
        wordCounts,
      }),
    [
      chapters,
      chapterOrder,
      chapterMarkdowns,
      continuityList,
      characters,
      locations,
      items,
      worldRules,
      povCharacterId,
      wordCounts,
    ]
  );

  const formatGapMessage = (gap: ChapterGapWarning): string => {
    switch (gap.code) {
      case 'missing-continuity':
        return t('matrixGapMissingContinuity');
      case 'prev-missing-continuity':
        return `${t('matrixGapPrevContinuity')}${gap.detail ? ` (${gap.detail})` : ''}`;
      case 'unresolved-threads':
        return `${gap.detail || '1'} ${t('matrixGapUnresolvedThreads')}`;
      case 'pov-absent':
        return `${t('matrixGapPovAbsent')}${gap.detail ? `: ${gap.detail}` : ''}`;
      default:
        return '';
    }
  };

  const formatGapShortLabel = (gap: ChapterGapWarning): string => {
    switch (gap.code) {
      case 'missing-continuity':
        return t('matrixGapMissingShort');
      case 'prev-missing-continuity':
        return t('matrixGapPrevShort');
      case 'unresolved-threads':
        return `${gap.detail || ''} ${t('matrixGapThreadsShort')}`.trim();
      case 'pov-absent':
        return t('matrixGapPovShort');
      default:
        return '';
    }
  };

  const columnsWithIssues = useMemo(
    () => matrix.columns.filter((col) => col.gaps.length > 0),
    [matrix.columns]
  );

  const visibleColumns = useMemo(() => {
    if (!showGapsOnly) return matrix.columns;
    return columnsWithIssues;
  }, [matrix.columns, columnsWithIssues, showGapsOnly]);

  const filteredRows = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    return matrix.rows.filter((row) => {
      if (categoryFilter !== 'all' && row.category !== categoryFilter) {
        return false;
      }
      if (q) {
        const hay = `${row.name} ${row.subtitle || ''} ${row.searchTerms.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [matrix.rows, categoryFilter, searchFilter]);

  const groupedRows = useMemo(() => {
    const groups: Array<{
      category: EntityCategory;
      label: string;
      rows: MatrixEntityRow[];
    }> = [
      { category: 'character', label: t('characters'), rows: [] },
      { category: 'location', label: t('locations'), rows: [] },
      { category: 'item', label: t('objectsItems'), rows: [] },
      { category: 'world-rule', label: t('worldRules'), rows: [] },
    ];
    const map = new Map(groups.map((g) => [g.category, g]));
    for (const row of filteredRows) {
      map.get(row.category)?.rows.push(row);
    }
    return groups.filter((g) => g.rows.length > 0);
  }, [filteredRows, t]);

  const toggleGroup = (category: EntityCategory) => {
    setCollapsedGroups((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  const renderGroupIcon = (category: EntityCategory) => {
    switch (category) {
      case 'character':
        return <Users size={13} className="text-emerald-600 dark:text-emerald-400" />;
      case 'location':
        return <MapPin size={13} className="text-blue-600 dark:text-blue-400" />;
      case 'item':
        return <Box size={13} className="text-violet-600 dark:text-violet-400" />;
      case 'world-rule':
        return <Atom size={13} className="text-amber-600 dark:text-amber-400" />;
    }
  };

  const handleExportCsv = () => {
    const headerRow = [
      'Category',
      'Entity',
      'Always Active',
      'Total Mentions',
      ...matrix.columns.map((col) => `Ch.${col.orderIndex + 1}: ${col.title}`),
    ];

    const lines: string[] = [headerRow.map(escapeCsvCell).join(',')];

    // Chapter health summary rows
    lines.push(
      [
        'Chapter Health',
        'Word Count',
        '',
        '',
        ...matrix.columns.map((col) => col.wordCount),
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push(
      [
        'Chapter Health',
        'Continuity Recorded',
        '',
        '',
        ...matrix.columns.map((col) => (col.hasContinuity ? 'Yes' : 'Missing')),
      ]
        .map(escapeCsvCell)
        .join(',')
    );
    lines.push(
      [
        'Chapter Health',
        'Gap Warnings',
        '',
        '',
        ...matrix.columns.map((col) =>
          col.gaps.length > 0 ? col.gaps.map(formatGapMessage).join('; ') : 'OK'
        ),
      ]
        .map(escapeCsvCell)
        .join(',')
    );

    for (const row of matrix.rows) {
      lines.push(
        [
          row.category,
          row.name,
          row.alwaysActive ? 'Yes' : 'No',
          row.totalMentions,
          ...matrix.columns.map((col) => {
            const cell = row.cells[col.chapterId];
            if (!cell) return 0;
            if (row.alwaysActive && cell.count === 0) return 'Always Active';
            if (row.alwaysActive && cell.count > 0) return `${cell.count} (Always)`;
            return cell.count;
          }),
        ]
          .map(escapeCsvCell)
          .join(',')
      );
    }

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeSlug = (projectTitle || 'manuscript')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    link.href = url;
    link.download = `${safeSlug || 'manuscript'}-entity-matrix.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const renderStatusLabel = (status: Chapter['status']) => {
    if (status === 'final') return t('statusFinal');
    if (status === 'revised') return t('statusRevised');
    return t('statusDraft');
  };

  return (
    <div className="flex flex-col h-full gap-4 select-none">
      {/* Controls & Filters Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Category Segmented Controls */}
          <div className="flex items-center border border-[var(--border)] bg-white dark:bg-[#1e1e1d] p-0.5 text-xs">
            {(
              [
                { id: 'all', label: t('matrixFilterAll') },
                { id: 'character', label: t('characters') },
                { id: 'location', label: t('locations') },
                { id: 'item', label: t('items') },
                { id: 'world-rule', label: t('worldRules') },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCategoryFilter(opt.id)}
                className={`px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                  categoryFilter === opt.id
                    ? 'bg-[var(--accent)] text-white'
                    : 'text-[var(--foreground)] opacity-75 hover:opacity-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Show Gaps Only Toggle */}
          <button
            type="button"
            onClick={() => setShowGapsOnly((prev) => !prev)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold border transition-colors cursor-pointer ${
              showGapsOnly
                ? 'bg-amber-600 text-white border-amber-600'
                : 'bg-white dark:bg-[#1e1e1d] text-[var(--foreground)] border-[var(--border)] hover:border-amber-500/60'
            }`}
          >
            <Filter size={12} />
            <span>{t('matrixShowGapsOnly')}</span>
            <span className="font-mono tabular-nums opacity-80">
              ({columnsWithIssues.length})
            </span>
          </button>

          {/* Entity Search Filter */}
          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 opacity-45 pointer-events-none"
            />
            <input
              type="text"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              placeholder={t('matrixSearchEntities')}
              className="pl-7 pr-3 py-1.5 text-xs bg-white dark:bg-[#1e1e1d] border border-[var(--border)] text-[var(--foreground)] focus:outline-none focus:border-[var(--accent)] w-44 sm:w-52"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          {isLoadingMarkdowns && (
            <span className="text-[11px] opacity-60 animate-pulse">
              {t('matrixScanning')}
            </span>
          )}

          {/* Subtle Legend */}
          <div className="hidden xl:flex items-center gap-3 text-[11px] opacity-70">
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={12} className="text-emerald-600 dark:text-emerald-400" />
              {t('matrixContinuityOk')}
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <AlertTriangle size={12} className="text-amber-600 dark:text-amber-400" />
              {t('matrixGapWarning')}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">∞ {t('matrixAlwaysActiveLegend')}</span>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={matrix.columns.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold border border-[var(--border)] bg-white dark:bg-[#1e1e1d] text-[var(--foreground)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-40 transition-colors cursor-pointer"
          >
            <Download size={12} />
            <span>{t('matrixExportCsv')}</span>
          </button>
        </div>
      </div>

      {/* Matrix Table Container */}
      {matrix.columns.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[var(--border)] p-10 text-center text-xs opacity-65">
          {t('noChapters')}
        </div>
      ) : showGapsOnly && visibleColumns.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-[var(--border)] bg-white dark:bg-[#1e1e1d] p-10 text-center space-y-2">
          <CheckCircle2 size={24} className="text-emerald-600 dark:text-emerald-400" />
          <p className="text-sm font-semibold text-[var(--foreground)]">
            {t('matrixNoGapsTitle')}
          </p>
          <p className="text-xs opacity-65 max-w-md">
            {t('matrixNoGapsDesc')}
          </p>
        </div>
      ) : matrix.rows.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center border border-dashed border-[var(--border)] p-10 text-center space-y-1.5">
          <p className="text-sm font-semibold text-[var(--foreground)]">
            {t('matrixNoEntitiesTitle')}
          </p>
          <p className="text-xs opacity-65 max-w-md">
            {t('matrixNoEntitiesDesc')}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto border border-[var(--border)] bg-white dark:bg-[#1e1e1d]">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--sidebar-bg)]">
                {/* Sticky Top-Left Corner */}
                <th className="sticky top-0 left-0 z-30 min-w-[230px] max-w-[260px] bg-[var(--sidebar-bg)] border-r border-[var(--border)] px-3 py-2.5 align-bottom">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--foreground)]">
                    {t('matrixEntityColumn')}
                  </div>
                  <div className="text-[10px] opacity-60 font-normal mt-0.5 font-mono tabular-nums">
                    {filteredRows.length} {t('entries')} · {visibleColumns.length}{' '}
                    {t('chapters')}
                  </div>
                </th>

                {/* Scrollable Chapter Columns */}
                {visibleColumns.map((col: MatrixChapterColumn) => {
                  const hasWarning = col.gaps.some((g) => g.severity === 'warning');
                  const hasInfo = col.gaps.some((g) => g.severity === 'info');
                  const gapTooltip =
                    col.gaps.length > 0
                      ? col.gaps.map(formatGapMessage).join(' | ')
                      : col.hasContinuity
                        ? t('matrixContinuityOk')
                        : '';

                  return (
                    <th
                      key={col.chapterId}
                      className={`sticky top-0 z-20 min-w-[132px] max-w-[160px] border-r border-[var(--border)] px-2.5 py-2 align-top font-normal ${
                        hasWarning
                          ? 'bg-amber-50/90 dark:bg-amber-950/30'
                          : 'bg-[var(--sidebar-bg)]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectChapter(col.chapterId)}
                          className="font-mono text-[11px] font-bold text-[var(--accent)] hover:underline cursor-pointer"
                          title={col.title}
                        >
                          Ch.{col.orderIndex + 1}
                        </button>

                        <button
                          type="button"
                          onClick={() => onSelectChapterContinuity(col.chapterId)}
                          className="inline-flex items-center gap-1 cursor-pointer hover:opacity-100 opacity-85"
                          title={
                            col.hasContinuity
                              ? `${t('matrixContinuityOk')} — ${t('editContinuityTooltip')}`
                              : `${t('matrixGapMissingContinuity')} — ${t('editContinuityTooltip')}`
                          }
                        >
                          {col.hasContinuity ? (
                            <CheckCircle2
                              size={13}
                              className="text-emerald-600 dark:text-emerald-400"
                            />
                          ) : (
                            <AlertTriangle
                              size={13}
                              className="text-amber-600 dark:text-amber-400"
                            />
                          )}
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => onSelectChapter(col.chapterId)}
                        className="block w-full text-left font-serif font-semibold text-xs text-[var(--foreground)] truncate mt-0.5 hover:text-[var(--accent)] transition-colors cursor-pointer"
                        title={col.title}
                      >
                        {col.title}
                      </button>

                      {/* Clean unboxed chapter metadata */}
                      <div className="flex items-center gap-1.5 text-[10px] opacity-65 mt-1 font-mono tabular-nums truncate">
                        <span>{renderStatusLabel(col.status)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{col.wordCount.toLocaleString()}w</span>
                        {col.beatCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{col.beatCount}b</span>
                          </>
                        )}
                      </div>

                      {/* Gap warning summary row inside header */}
                      {col.gaps.length > 0 && (
                        <div
                          className={`mt-1.5 pt-1 border-t border-[var(--border)]/60 flex items-start gap-1 text-[10px] leading-tight ${
                            hasWarning
                              ? 'text-amber-700 dark:text-amber-300'
                              : hasInfo
                                ? 'text-sky-700 dark:text-sky-300'
                                : 'opacity-70'
                          }`}
                          title={gapTooltip}
                        >
                          {hasWarning ? (
                            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                          ) : (
                            <Info size={11} className="shrink-0 mt-0.5" />
                          )}
                          <span className="line-clamp-2">
                            {col.gaps.map(formatGapShortLabel).join(' · ')}
                          </span>
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {groupedRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={visibleColumns.length + 1}
                    className="p-8 text-center text-xs opacity-60"
                  >
                    {t('noCharactersFound')}
                  </td>
                </tr>
              ) : (
                groupedRows.map((group) => {
                  const isCollapsed = collapsedGroups[group.category];
                  return (
                    <React.Fragment key={group.category}>
                      {/* Group Section Divider Row */}
                      <tr className="border-b border-[var(--border)] bg-[var(--editor-bg)]/80">
                        <td
                          colSpan={visibleColumns.length + 1}
                          className="sticky left-0 z-10 px-3 py-1.5"
                        >
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.category)}
                            className="inline-flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-[var(--foreground)] opacity-85 hover:opacity-100 cursor-pointer"
                          >
                            {isCollapsed ? (
                              <ChevronRight size={13} />
                            ) : (
                              <ChevronDown size={13} />
                            )}
                            {renderGroupIcon(group.category)}
                            <span>{group.label}</span>
                            <span className="font-mono tabular-nums text-[10px] opacity-60 font-normal">
                              ({group.rows.length})
                            </span>
                          </button>
                        </td>
                      </tr>

                      {/* Entity Rows */}
                      {!isCollapsed &&
                        group.rows.map((row) => {
                          const dotColor =
                            row.color || DEFAULT_CATEGORY_COLOR[row.category];
                          const isPovEntity =
                            row.category === 'character' && row.id === povCharacterId;

                          return (
                            <tr
                              key={`${row.category}:${row.id}`}
                              className="border-b border-[var(--border)]/70 hover:bg-[var(--editor-bg)]/45 transition-colors"
                            >
                              {/* Sticky Entity Row Header */}
                              <td className="sticky left-0 z-10 bg-white dark:bg-[#1e1e1d] border-r border-[var(--border)] px-3 py-2 align-middle">
                                <div className="flex items-center justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => onOpenBibleEntity(row.category, row.id)}
                                    className="flex items-center gap-2 min-w-0 text-left group/ent cursor-pointer"
                                    title={t('matrixOpenInBible')}
                                  >
                                    <span
                                      className="w-2.5 h-2.5 rounded-full shrink-0"
                                      style={{ backgroundColor: dotColor }}
                                    />
                                    <span className="font-medium text-[var(--foreground)] group-hover/ent:text-[var(--accent)] group-hover/ent:underline truncate">
                                      {row.name}
                                    </span>
                                    <ExternalLink
                                      size={10}
                                      className="shrink-0 opacity-0 group-hover/ent:opacity-60 transition-opacity"
                                    />
                                  </button>

                                  <div className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono tabular-nums opacity-65">
                                    {isPovEntity && (
                                      <span
                                        className="font-semibold text-[var(--accent)]"
                                        title={t('povFocusChar')}
                                      >
                                        POV
                                      </span>
                                    )}
                                    {row.alwaysActive && (
                                      <span
                                        title={t('worldRuleAlwaysActive')}
                                        className="text-amber-600 dark:text-amber-400 font-bold"
                                      >
                                        ∞
                                      </span>
                                    )}
                                    <span
                                      title={`${row.totalMentions} total mentions`}
                                      className={row.totalMentions === 0 ? 'opacity-50' : ''}
                                    >
                                      {row.totalMentions}
                                    </span>
                                  </div>
                                </div>
                              </td>

                              {/* Chapter Cells */}
                              {visibleColumns.map((col) => {
                                const cell = row.cells[col.chapterId] || {
                                  count: 0,
                                  matchedTerms: {},
                                  primaryMatchedTerm: null,
                                };
                                const isPovGapCell =
                                  isPovEntity &&
                                  col.gaps.some((g) => g.code === 'pov-absent');

                                if (cell.count > 0) {
                                  const matchedSummary = Object.entries(cell.matchedTerms)
                                    .map(([term, cnt]) => `${term}: ${cnt}`)
                                    .join(', ');
                                  return (
                                    <td
                                      key={col.chapterId}
                                      className="border-r border-[var(--border)]/60 p-1 text-center align-middle"
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          onJumpToChapterSearch(
                                            col.chapterId,
                                            cell.primaryMatchedTerm || row.name
                                          )
                                        }
                                        title={`${matchedSummary} — ${t('matrixClickToJump')}`}
                                        className="w-full py-1.5 px-2 inline-flex items-center justify-center gap-1 font-mono tabular-nums text-xs font-bold text-[var(--foreground)] bg-[var(--accent)]/12 hover:bg-[var(--accent)] hover:text-white transition-colors cursor-pointer"
                                      >
                                        <span>{cell.count}</span>
                                        {row.alwaysActive && (
                                          <span className="text-[10px] opacity-75">∞</span>
                                        )}
                                      </button>
                                    </td>
                                  );
                                }

                                if (row.alwaysActive) {
                                  return (
                                    <td
                                      key={col.chapterId}
                                      className="border-r border-[var(--border)]/60 p-1 text-center align-middle"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => onSelectChapter(col.chapterId)}
                                        title={`${t('worldRuleAlwaysActive')} — ${t('matrixClickOpenChapter')}`}
                                        className="w-full py-1.5 px-2 inline-flex items-center justify-center font-mono text-xs text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors cursor-pointer"
                                      >
                                        ∞
                                      </button>
                                    </td>
                                  );
                                }

                                if (isPovGapCell) {
                                  return (
                                    <td
                                      key={col.chapterId}
                                      className="border-r border-[var(--border)]/60 p-1 text-center align-middle"
                                    >
                                      <button
                                        type="button"
                                        onClick={() => onSelectChapter(col.chapterId)}
                                        title={`${t('matrixGapPovAbsent')}: ${row.name}`}
                                        className="w-full py-1.5 px-2 inline-flex items-center justify-center gap-1 font-mono text-[11px] text-amber-700 dark:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 transition-colors cursor-pointer"
                                      >
                                        <AlertTriangle size={11} />
                                        <span>0</span>
                                      </button>
                                    </td>
                                  );
                                }

                                return (
                                  <td
                                    key={col.chapterId}
                                    className="border-r border-[var(--border)]/60 p-1 text-center align-middle text-[var(--foreground)] opacity-25 font-mono"
                                  >
                                    —
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
