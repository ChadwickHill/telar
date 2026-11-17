import {
  Chapter,
  Character,
  Item,
  Location,
  WorldRule,
} from '../storage/schemas';
import { stripBeatTokens } from '../ai/beats';

export type EntityCategory = 'character' | 'location' | 'item' | 'world-rule';

export interface ChapterGapWarning {
  code:
    | 'missing-continuity'
    | 'prev-missing-continuity'
    | 'unresolved-threads'
    | 'pov-absent';
  severity: 'warning' | 'info';
  detail?: string;
}

export interface MatrixChapterColumn {
  chapterId: string;
  orderIndex: number; // 0-based
  title: string;
  status: Chapter['status'];
  wordCount: number;
  beatCount: number;
  hasContinuity: boolean;
  hasConstraintsCarriedForward: boolean;
  unresolvedThreadCount: number;
  povPresent: boolean | null;
  gaps: ChapterGapWarning[];
}

export interface MatrixCellMatch {
  count: number;
  matchedTerms: Record<string, number>;
  primaryMatchedTerm: string | null;
  alwaysActive?: boolean;
}

export interface MatrixEntityRow {
  id: string;
  category: EntityCategory;
  name: string;
  subtitle?: string;
  color?: string;
  alwaysActive?: boolean;
  severity?: WorldRule['severity'];
  searchTerms: string[];
  cells: Record<string, MatrixCellMatch>;
  totalMentions: number;
  chaptersWithMentions: number;
}

export interface SceneEntityMatrix {
  columns: MatrixChapterColumn[];
  rows: MatrixEntityRow[];
  totalGaps: number;
}

export interface BuildSceneEntityMatrixParams {
  chapters: Chapter[];
  chapterOrder: string[];
  chapterMarkdowns: Record<string, string>;
  continuityList: Record<string, string>;
  characters: Character[];
  locations: Location[];
  items: Item[];
  worldRules: WorldRule[];
  povCharacterId?: string;
  wordCounts?: Record<string, number>;
}

function dedupeTerms(terms: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of terms) {
    const trimmed = (raw || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function isPlaceholderLine(line: string): boolean {
  const trimmed = line.replace(/^[-*•\d.)\s]+/, '').trim();
  if (!trimmed) return true;
  if (/^\[.*\]$/.test(trimmed)) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'none' || lower === 'n/a' || lower === 'none.' || lower === '-';
}

function analyzeContinuityDoc(continuityMd: string): {
  hasContinuity: boolean;
  hasConstraintsCarriedForward: boolean;
  unresolvedThreadCount: number;
} {
  const normalized = (continuityMd || '').replace(/\r\n/g, '\n');
  const nonHeadingContent = normalized.replace(/^#{1,6}\s.*$/gm, '').trim();
  const hasContinuity = nonHeadingContent.length > 0;

  if (!hasContinuity) {
    return {
      hasContinuity: false,
      hasConstraintsCarriedForward: false,
      unresolvedThreadCount: 0,
    };
  }

  const lines = normalized.split('\n');
  let currentSection = '';
  const unresolvedLines: string[] = [];
  const constraintLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim().toLowerCase();
      continue;
    }
    if (isPlaceholderLine(line)) continue;
    if (currentSection.includes('unresolved')) {
      unresolvedLines.push(line);
    } else if (currentSection.includes('constraint')) {
      constraintLines.push(line);
    }
  }

  return {
    hasContinuity,
    hasConstraintsCarriedForward: constraintLines.length > 0,
    unresolvedThreadCount: unresolvedLines.length,
  };
}

function countEntityMatchesInText(
  plainText: string,
  searchTerms: string[],
  caseInsensitive: boolean
): { count: number; matchedTerms: Record<string, number>; primaryMatchedTerm: string | null } {
  if (!plainText || searchTerms.length === 0) {
    return { count: 0, matchedTerms: {}, primaryMatchedTerm: null };
  }

  // Sort longest-first to avoid double-counting shorter aliases nested inside fuller names
  const sortedTerms = [...searchTerms].sort((a, b) => b.length - a.length);
  const matchedIndices = new Uint8Array(plainText.length);
  const matchedTerms: Record<string, number> = {};
  let totalCount = 0;

  for (const term of sortedTerms) {
    const escaped = term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const flags = caseInsensitive ? 'gi' : 'g';
    const regex = new RegExp(`\\b${escaped}\\b`, flags);

    let match: RegExpExecArray | null;
    while ((match = regex.exec(plainText)) !== null) {
      const startIdx = match.index;
      const endIdx = startIdx + match[0].length;

      let overlap = false;
      for (let i = startIdx; i < endIdx; i++) {
        if (matchedIndices[i] === 1) {
          overlap = true;
          break;
        }
      }

      if (!overlap) {
        for (let i = startIdx; i < endIdx; i++) {
          matchedIndices[i] = 1;
        }
        matchedTerms[term] = (matchedTerms[term] || 0) + 1;
        totalCount++;
      }

      if (match.index === regex.lastIndex) {
        regex.lastIndex++;
      }
    }
  }

  let primaryMatchedTerm: string | null = null;
  let bestTermCount = 0;
  for (const [term, count] of Object.entries(matchedTerms)) {
    if (count > bestTermCount) {
      bestTermCount = count;
      primaryMatchedTerm = term;
    }
  }

  return {
    count: totalCount,
    matchedTerms,
    primaryMatchedTerm,
  };
}

export function buildSceneEntityMatrix(
  params: BuildSceneEntityMatrixParams
): SceneEntityMatrix {
  const {
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
  } = params;

  const orderedChapters = chapterOrder
    .map((id) => chapters.find((c) => c.id === id))
    .filter((c): c is Chapter => !!c);

  interface PreparedChapter {
    chapter: Chapter;
    orderIndex: number;
    strippedText: string;
    hasNonEmptyBody: boolean;
    wordCount: number;
    beatCount: number;
    continuityInfo: ReturnType<typeof analyzeContinuityDoc>;
  }

  const preparedChapters: PreparedChapter[] = orderedChapters.map((chapter, orderIndex) => {
    const rawMd = chapterMarkdowns[chapter.id] || '';
    const beatMatches = rawMd.match(/:::beat\{[^}]+\}/g);
    const beatCount = beatMatches ? beatMatches.length : 0;
    const strippedText = stripBeatTokens(rawMd);
    const trimmed = strippedText.trim();
    const wordCount = trimmed
      ? trimmed.split(/\s+/).length
      : (wordCounts?.[chapter.id] ?? 0);

    const bodyWithoutHeading = strippedText.replace(/^#{1,6}\s.*(\n|$)/, '').trim();
    const hasNonEmptyBody =
      bodyWithoutHeading.length > 0 &&
      bodyWithoutHeading !== 'Start writing your novel here...';

    const continuityInfo = analyzeContinuityDoc(continuityList[chapter.id] || '');

    return {
      chapter,
      orderIndex,
      strippedText,
      hasNonEmptyBody,
      wordCount,
      beatCount,
      continuityInfo,
    };
  });

  // Build entity definitions
  interface EntityDef {
    id: string;
    category: EntityCategory;
    name: string;
    subtitle?: string;
    color?: string;
    alwaysActive?: boolean;
    severity?: WorldRule['severity'];
    searchTerms: string[];
    caseInsensitive: boolean;
  }

  const entityDefs: EntityDef[] = [
    ...characters.map((c) => ({
      id: c.id,
      category: 'character' as const,
      name: c.name,
      subtitle: c.role || undefined,
      color: c.color,
      searchTerms: dedupeTerms([c.name, ...(c.aliases || [])]),
      caseInsensitive: false,
    })),
    ...locations.map((l) => ({
      id: l.id,
      category: 'location' as const,
      name: l.name,
      subtitle: l.scale,
      color: l.color,
      searchTerms: dedupeTerms([l.name, ...(l.aliases || [])]),
      caseInsensitive: false,
    })),
    ...items.map((it) => ({
      id: it.id,
      category: 'item' as const,
      name: it.name,
      subtitle: it.description ? it.description.slice(0, 60) : undefined,
      color: it.color,
      searchTerms: dedupeTerms([it.name, ...(it.aliases || [])]),
      caseInsensitive: false,
    })),
    ...worldRules.map((r) => ({
      id: r.id,
      category: 'world-rule' as const,
      name: r.title,
      subtitle: r.category,
      color: r.color,
      alwaysActive: r.alwaysActive,
      severity: r.severity,
      searchTerms: dedupeTerms([...(r.keywords || []), r.title]),
      caseInsensitive: true,
    })),
  ];

  const rows: MatrixEntityRow[] = entityDefs.map((def) => {
    const cells: Record<string, MatrixCellMatch> = {};
    let totalMentions = 0;
    let chaptersWithMentions = 0;

    for (const prep of preparedChapters) {
      const res = countEntityMatchesInText(
        prep.strippedText,
        def.searchTerms,
        def.caseInsensitive
      );
      cells[prep.chapter.id] = {
        ...res,
        alwaysActive: def.alwaysActive,
      };
      totalMentions += res.count;
      if (res.count > 0) {
        chaptersWithMentions++;
      }
    }

    return {
      id: def.id,
      category: def.category,
      name: def.name,
      subtitle: def.subtitle,
      color: def.color,
      alwaysActive: def.alwaysActive,
      severity: def.severity,
      searchTerms: def.searchTerms,
      cells,
      totalMentions,
      chaptersWithMentions,
    };
  });

  const povCharacter = povCharacterId
    ? characters.find((c) => c.id === povCharacterId)
    : undefined;
  const povRow = povCharacter
    ? rows.find((r) => r.category === 'character' && r.id === povCharacter.id)
    : undefined;

  const columns: MatrixChapterColumn[] = preparedChapters.map((prep, idx) => {
    const gaps: ChapterGapWarning[] = [];
    const { chapter, wordCount, beatCount, hasNonEmptyBody, continuityInfo } = prep;

    // 1. Missing continuity doc for non-empty or revised/final chapter
    if (
      !continuityInfo.hasContinuity &&
      (hasNonEmptyBody ||
        chapter.status === 'revised' ||
        chapter.status === 'final' ||
        wordCount > 25)
    ) {
      gaps.push({
        code: 'missing-continuity',
        severity: 'warning',
      });
    }

    // 2. Preceding chapter missing continuity or carrying unresolved threads
    if (idx > 0) {
      const prev = preparedChapters[idx - 1];
      if (
        !prev.continuityInfo.hasContinuity &&
        (prev.hasNonEmptyBody || prev.wordCount > 25)
      ) {
        gaps.push({
          code: 'prev-missing-continuity',
          severity: 'warning',
          detail: `Ch.${idx}`,
        });
      }
      if (prev.continuityInfo.unresolvedThreadCount > 0) {
        gaps.push({
          code: 'unresolved-threads',
          severity: 'info',
          detail: String(prev.continuityInfo.unresolvedThreadCount),
        });
      }
    }

    // 3. POV character absent from non-empty chapter
    let povPresent: boolean | null = null;
    if (povCharacter && povRow) {
      const count = povRow.cells[chapter.id]?.count ?? 0;
      povPresent = count > 0;
      if (!povPresent && (hasNonEmptyBody || wordCount > 25)) {
        gaps.push({
          code: 'pov-absent',
          severity: 'warning',
          detail: povCharacter.name,
        });
      }
    }

    return {
      chapterId: chapter.id,
      orderIndex: idx,
      title: chapter.title,
      status: chapter.status || 'draft',
      wordCount,
      beatCount,
      hasContinuity: continuityInfo.hasContinuity,
      hasConstraintsCarriedForward: continuityInfo.hasConstraintsCarriedForward,
      unresolvedThreadCount: continuityInfo.unresolvedThreadCount,
      povPresent,
      gaps,
    };
  });

  const totalGaps = columns.filter((col) =>
    col.gaps.some((g) => g.severity === 'warning')
  ).length;

  return {
    columns,
    rows,
    totalGaps,
  };
}
