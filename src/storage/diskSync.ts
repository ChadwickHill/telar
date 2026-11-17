import {
  Chapter,
  Character,
  CharactersSchema,
  CorkboardSchema,
  Item,
  ItemsSchema,
  Location,
  LocationsSchema,
  Project,
  ProjectSchema,
  Style,
  StyleSchema,
  SyncManifest,
  SyncManifestEntry,
  SyncManifestSchema,
  WorldRule,
  WorldRuleCategory,
  WorldRulesSchema,
  WorldRuleSeverity,
} from './schemas';
import { IndexedDBProjectStorage } from './IndexedDBProjectStorage';
import { padOrder, parseFrontmatter, slugifyFilename, stringifyFrontmatter } from './frontmatter';
import { takeSnapshot } from './snapshots';

// ---- Browser File System Access API Types (no global pollution) -----------

type PermissionStateValue = 'granted' | 'denied' | 'prompt';

interface PermissionDescriptorExt {
  mode?: 'read' | 'readwrite';
}

type DirHandleExt = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: PermissionDescriptorExt) => Promise<PermissionStateValue>;
  requestPermission?: (descriptor?: PermissionDescriptorExt) => Promise<PermissionStateValue>;
  entries: () => AsyncIterableIterator<[string, FileSystemHandle]>;
};

interface WindowWithDirPicker {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite'; id?: string }) => Promise<FileSystemDirectoryHandle>;
}

// ---- Exported Runtime Sync Types -------------------------------------------

export type SyncStatus =
  | 'disconnected'
  | 'unsupported'
  | 'needs-permission'
  | 'syncing'
  | 'synced'
  | 'conflict'
  | 'error';

export interface SyncConflict {
  idbPath: string;
  diskPath: string;
  label: string;
  idbContent: string;
  diskContent: string;
  idbUpdatedAt: string;
  diskMtimeMs: number;
}

export interface FolderInspectionResult {
  handle: FileSystemDirectoryHandle;
  folderName: string;
  hasExistingNovel: boolean;
  hasManifest: boolean;
  mdFileCount: number;
}

export interface SyncResult {
  pulledCount: number;
  pushedCount: number;
  deletedCount: number;
  conflicts: SyncConflict[];
  pulledPaths: string[];
}

export interface DiskSyncCallbacks {
  onStatusChange?: (status: SyncStatus, meta: { folderName: string | null; lastSyncedAt: string | null; error: string | null }) => void;
  onConflictsChange?: (conflicts: SyncConflict[]) => void;
  onExternalSyncReload?: (changedIdbPaths: string[]) => Promise<void> | void;
  onToast?: (message: string) => void;
}

// ---- Utilities -------------------------------------------------------------

function normalizeLf(text: string): string {
  return (text || '').replace(/\r\n/g, '\n');
}

/**
 * Deterministic fast 64-bit hex hash (dual 32-bit FNV-1a lanes).
 */
export function hashContent(input: string): string {
  const str = normalizeLf(input);
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= ch ^ ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function asString(val: unknown, fallback = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return fallback;
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map((v) => asString(v).trim()).filter(Boolean);
}

function asNumberOrUndefined(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asBoolean(val: unknown, fallback: boolean): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return fallback;
}

function parseMarkdownSections(body: string): Record<string, string> {
  const normalized = normalizeLf(body).trim();
  if (!normalized) return {};

  const sections: Record<string, string> = {};
  const lines = normalized.split('\n');
  let currentHeading = '__preamble__';
  let buffer: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      sections[currentHeading] = buffer.join('\n').trim();
      currentHeading = headingMatch[1].trim().toLowerCase();
      buffer = [];
    } else {
      buffer.push(line);
    }
  }
  sections[currentHeading] = buffer.join('\n').trim();
  return sections;
}

// ---- Markdown <-> Entity Mappers -------------------------------------------

export function chapterToDiskMd(chapter: Chapter, order: number, markdownBody: string): string {
  const cleanBody = normalizeLf(markdownBody).replace(/^\n+/, '');
  return stringifyFrontmatter(
    {
      id: chapter.id,
      title: chapter.title,
      status: chapter.status || 'draft',
      order,
      updatedAt: chapter.updatedAt || new Date().toISOString(),
    },
    cleanBody
  );
}

export function diskMdToChapter(
  raw: string,
  fallbackId: string
): {
  id: string;
  title: string;
  status: Chapter['status'];
  order: number;
  updatedAt: string;
  body: string;
} {
  const { data, body } = parseFrontmatter(raw);
  const id = asString(data.id, fallbackId).trim() || fallbackId;
  const firstHeadingLine = normalizeLf(body).split('\n').find((l) => l.trim().startsWith('#'));
  const headingTitle = firstHeadingLine ? firstHeadingLine.replace(/^#+\s*/, '').trim() : '';
  const title = asString(data.title, headingTitle || `Chapter ${fallbackId}`).trim() || `Chapter ${fallbackId}`;
  const rawStatus = asString(data.status, 'draft');
  const status: Chapter['status'] =
    rawStatus === 'revised' || rawStatus === 'final' ? rawStatus : 'draft';
  const order = asNumberOrUndefined(data.order) ?? 9999;
  const updatedAt = asString(data.updatedAt, new Date().toISOString());

  return {
    id,
    title,
    status,
    order,
    updatedAt,
    body: normalizeLf(body),
  };
}

export function continuityToDiskMd(
  chapterId: string,
  title: string,
  order: number,
  updatedAt: string,
  markdownBody: string
): string {
  const cleanBody = normalizeLf(markdownBody).replace(/^\n+/, '');
  return stringifyFrontmatter(
    {
      chapterId,
      title,
      order,
      updatedAt: updatedAt || new Date().toISOString(),
    },
    cleanBody
  );
}

export function diskMdToContinuity(
  raw: string,
  fallbackChapterId: string
): {
  chapterId: string;
  title: string;
  order: number;
  updatedAt: string;
  body: string;
} {
  const { data, body } = parseFrontmatter(raw);
  const chapterId = asString(data.chapterId, fallbackChapterId).trim() || fallbackChapterId;
  const title = asString(data.title, `Chapter ${chapterId}`).trim();
  const order = asNumberOrUndefined(data.order) ?? 9999;
  const updatedAt = asString(data.updatedAt, new Date().toISOString());

  return {
    chapterId,
    title,
    order,
    updatedAt,
    body: normalizeLf(body),
  };
}

export function characterToDiskMd(char: Character): string {
  const frontmatter: Record<string, unknown> = {
    id: char.id,
    name: char.name,
    aliases: char.aliases || [],
    role: char.role || '',
    ...(char.age !== undefined ? { age: char.age } : {}),
    traits: char.traits || [],
    desires: char.desires || [],
    fears: char.fears || [],
    speechPatterns: char.speechPatterns || '',
    relationships: (char.relationships || []).map((rel) => ({
      with: rel.with,
      kind: rel.kind,
      ...(rel.notes ? { notes: rel.notes } : {}),
    })),
    ...(char.color ? { color: char.color } : {}),
  };

  const body = [
    '## Appearance',
    '',
    (char.appearance || '').trim(),
    '',
    '## Notes',
    '',
    (char.notes || '').trim(),
    '',
  ].join('\n');

  return stringifyFrontmatter(frontmatter, body);
}

export function diskMdToCharacter(raw: string, existing?: Character, fallbackId?: string): Character {
  const { data, body } = parseFrontmatter(raw);
  const sections = parseMarkdownSections(body);

  const relationshipsRaw = Array.isArray(data.relationships) ? data.relationships : [];
  const relationships = relationshipsRaw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      with: asString(r.with),
      kind: asString(r.kind),
      ...(asString(r.notes) ? { notes: asString(r.notes) } : {}),
    }))
    .filter((r) => r.with || r.kind);

  const appearance = sections['appearance'] ?? existing?.appearance ?? '';
  const notes = sections['notes'] ?? (Object.keys(sections).length === 1 && sections['__preamble__'] ? sections['__preamble__'] : existing?.notes ?? '');

  return {
    id: asString(data.id, existing?.id || fallbackId || `char-${Date.now()}`),
    name: asString(data.name, existing?.name || 'Unnamed Character'),
    aliases: data.aliases !== undefined ? asStringArray(data.aliases) : (existing?.aliases || []),
    role: data.role !== undefined ? (asString(data.role) || undefined) : existing?.role,
    age: data.age !== undefined ? asNumberOrUndefined(data.age) : existing?.age,
    appearance: appearance || undefined,
    traits: data.traits !== undefined ? asStringArray(data.traits) : (existing?.traits || []),
    desires: data.desires !== undefined ? asStringArray(data.desires) : (existing?.desires || []),
    fears: data.fears !== undefined ? asStringArray(data.fears) : (existing?.fears || []),
    speechPatterns: data.speechPatterns !== undefined ? (asString(data.speechPatterns) || undefined) : existing?.speechPatterns,
    relationships: data.relationships !== undefined ? relationships : (existing?.relationships || []),
    notes: notes || undefined,
    evidence: existing?.evidence || [],
    avatar: existing?.avatar,
    color: data.color !== undefined ? (asString(data.color) || undefined) : existing?.color,
  };
}

export function locationToDiskMd(loc: Location): string {
  const frontmatter: Record<string, unknown> = {
    id: loc.id,
    name: loc.name,
    aliases: loc.aliases || [],
    scale: loc.scale || 'room',
    descriptors: loc.descriptors || [],
    inhabitants: loc.inhabitants || [],
    ...(loc.color ? { color: loc.color } : {}),
  };

  const body = [
    '## Significance',
    '',
    (loc.significance || '').trim(),
    '',
    '## Notes',
    '',
    (loc.notes || '').trim(),
    '',
  ].join('\n');

  return stringifyFrontmatter(frontmatter, body);
}

export function diskMdToLocation(raw: string, existing?: Location, fallbackId?: string): Location {
  const { data, body } = parseFrontmatter(raw);
  const sections = parseMarkdownSections(body);
  const rawScale = asString(data.scale, existing?.scale || 'room');
  const validScales: Location['scale'][] = ['room', 'building', 'district', 'city', 'region', 'world'];
  const scale: Location['scale'] = validScales.includes(rawScale as Location['scale'])
    ? (rawScale as Location['scale'])
    : 'room';

  const significance = sections['significance'] ?? existing?.significance ?? '';
  const notes = sections['notes'] ?? (Object.keys(sections).length === 1 && sections['__preamble__'] ? sections['__preamble__'] : existing?.notes ?? '');

  return {
    id: asString(data.id, existing?.id || fallbackId || `loc-${Date.now()}`),
    name: asString(data.name, existing?.name || 'Unnamed Location'),
    aliases: data.aliases !== undefined ? asStringArray(data.aliases) : (existing?.aliases || []),
    scale,
    descriptors: data.descriptors !== undefined ? asStringArray(data.descriptors) : (existing?.descriptors || []),
    significance: significance || undefined,
    inhabitants: data.inhabitants !== undefined ? asStringArray(data.inhabitants) : (existing?.inhabitants || []),
    notes: notes || undefined,
    evidence: existing?.evidence || [],
    avatar: existing?.avatar,
    color: data.color !== undefined ? (asString(data.color) || undefined) : existing?.color,
  };
}

export function itemToDiskMd(item: Item): string {
  const frontmatter: Record<string, unknown> = {
    id: item.id,
    name: item.name,
    aliases: item.aliases || [],
    ...(item.color ? { color: item.color } : {}),
  };

  const body = [
    '## Description',
    '',
    (item.description || '').trim(),
    '',
    '## Significance',
    '',
    (item.significance || '').trim(),
    '',
    '## Notes',
    '',
    (item.notes || '').trim(),
    '',
  ].join('\n');

  return stringifyFrontmatter(frontmatter, body);
}

export function diskMdToItem(raw: string, existing?: Item, fallbackId?: string): Item {
  const { data, body } = parseFrontmatter(raw);
  const sections = parseMarkdownSections(body);

  const description = sections['description'] ?? existing?.description ?? '';
  const significance = sections['significance'] ?? existing?.significance ?? '';
  const notes = sections['notes'] ?? (Object.keys(sections).length === 1 && sections['__preamble__'] ? sections['__preamble__'] : existing?.notes ?? '');

  return {
    id: asString(data.id, existing?.id || fallbackId || `item-${Date.now()}`),
    name: asString(data.name, existing?.name || 'Unnamed Item'),
    aliases: data.aliases !== undefined ? asStringArray(data.aliases) : (existing?.aliases || []),
    description: description || undefined,
    significance: significance || undefined,
    notes: notes || undefined,
    evidence: existing?.evidence || [],
    avatar: existing?.avatar,
    color: data.color !== undefined ? (asString(data.color) || undefined) : existing?.color,
  };
}

export function worldRuleToDiskMd(rule: WorldRule): string {
  const frontmatter: Record<string, unknown> = {
    id: rule.id,
    title: rule.title,
    category: rule.category || 'other',
    severity: rule.severity || 'hard',
    alwaysActive: rule.alwaysActive ?? true,
    keywords: rule.keywords || [],
    ...(rule.color ? { color: rule.color } : {}),
  };

  const body = [
    '## Statement',
    '',
    (rule.statement || '').trim(),
    '',
    '## Exceptions',
    '',
    (rule.exceptions || '').trim(),
    '',
  ].join('\n');

  return stringifyFrontmatter(frontmatter, body);
}

export function diskMdToWorldRule(raw: string, existing?: WorldRule, fallbackId?: string): WorldRule {
  const { data, body } = parseFrontmatter(raw);
  const sections = parseMarkdownSections(body);

  const validCategories: WorldRuleCategory[] = [
    'orbital-propulsion',
    'thermodynamics',
    'comms-latency',
    'biology-life-support',
    'society-tech',
    'other',
  ];
  const rawCategory = asString(data.category, existing?.category || 'other');
  const category: WorldRuleCategory = validCategories.includes(rawCategory as WorldRuleCategory)
    ? (rawCategory as WorldRuleCategory)
    : 'other';

  const rawSeverity = asString(data.severity, existing?.severity || 'hard');
  const severity: WorldRuleSeverity = rawSeverity === 'soft' ? 'soft' : 'hard';

  const statement =
    sections['statement'] ??
    (Object.keys(sections).length === 1 && sections['__preamble__']
      ? sections['__preamble__']
      : existing?.statement ?? '');
  const exceptions = sections['exceptions'] ?? existing?.exceptions ?? '';

  return {
    id: asString(data.id, existing?.id || fallbackId || `rule-${Date.now()}`),
    title: asString(data.title, existing?.title || 'Untitled World Rule'),
    category,
    severity,
    statement: statement || '',
    exceptions: exceptions || undefined,
    alwaysActive: data.alwaysActive !== undefined ? asBoolean(data.alwaysActive, existing?.alwaysActive ?? true) : (existing?.alwaysActive ?? true),
    keywords: data.keywords !== undefined ? asStringArray(data.keywords) : (existing?.keywords || []),
    evidence: existing?.evidence || [],
    color: data.color !== undefined ? (asString(data.color) || undefined) : existing?.color,
  };
}

export function styleToDiskMd(style: Style): string {
  const frontmatter: Record<string, unknown> = {
    schemaVersion: 1,
    narrativeRegister: style.narrativeRegister,
    diction: style.diction,
    sensoryPalette: style.sensoryPalette,
    pronounPairs: style.pronounPairs || [],
  };

  const body = [
    '## Rhythm',
    '',
    `Avg Sentence Length: ${style.rhythm.avgSentenceLengthHint || ''}`,
    `Paragraph Length: ${style.rhythm.paragraphLengthHint || ''}`,
    '',
    (style.rhythm.rhythmNotes || '').trim(),
    '',
    '## Dialogue',
    '',
    `Tagging Convention: ${style.dialogue.taggingConvention || ''}`,
    `Dialect Markers: ${(style.dialogue.dialectMarkers || []).join(', ')}`,
    '',
    (style.dialogue.registerNotes || '').trim(),
    '',
    '## Sensory Notes',
    '',
    `Color Notes: ${style.sensoryPalette.colorNotes || ''}`,
    `Sound Notes: ${style.sensoryPalette.soundNotes || ''}`,
    '',
  ].join('\n');

  return stringifyFrontmatter(frontmatter, body);
}

function extractLabeledLine(block: string, prefix: string): { value: string | undefined; remainingLines: string[] } {
  const lines = normalizeLf(block).split('\n');
  let found: string | undefined;
  const remaining: string[] = [];
  for (const line of lines) {
    if (line.startsWith(prefix)) {
      found = line.slice(prefix.length).trim() || undefined;
    } else {
      remaining.push(line);
    }
  }
  return { value: found, remainingLines: remaining };
}

export function diskMdToStyle(raw: string, existing?: Style): Style {
  const { data, body } = parseFrontmatter(raw);
  const sections = parseMarkdownSections(body);

  const nr = (data.narrativeRegister && typeof data.narrativeRegister === 'object' ? data.narrativeRegister : {}) as Record<string, unknown>;
  const dict = (data.diction && typeof data.diction === 'object' ? data.diction : {}) as Record<string, unknown>;
  const sp = (data.sensoryPalette && typeof data.sensoryPalette === 'object' ? data.sensoryPalette : {}) as Record<string, unknown>;

  const rhythmSec = sections['rhythm'] ?? '';
  const avgRes = extractLabeledLine(rhythmSec, 'Avg Sentence Length:');
  const paraRes = extractLabeledLine(avgRes.remainingLines.join('\n'), 'Paragraph Length:');
  const rhythmNotes = paraRes.remainingLines.join('\n').trim();

  const dialogueSec = sections['dialogue'] ?? '';
  const tagRes = extractLabeledLine(dialogueSec, 'Tagging Convention:');
  const dialectRes = extractLabeledLine(tagRes.remainingLines.join('\n'), 'Dialect Markers:');
  const registerNotes = dialectRes.remainingLines.join('\n').trim();

  const sensorySec = sections['sensory notes'] ?? '';
  const colorRes = extractLabeledLine(sensorySec, 'Color Notes:');
  const soundRes = extractLabeledLine(colorRes.remainingLines.join('\n'), 'Sound Notes:');

  const validPovs: Style['narrativeRegister']['pointOfView'][] = ['first', 'second', 'third-limited', 'third-omniscient'];
  const rawPov = asString(nr.pointOfView, existing?.narrativeRegister.pointOfView || 'third-limited');
  const pov = validPovs.includes(rawPov as Style['narrativeRegister']['pointOfView'])
    ? (rawPov as Style['narrativeRegister']['pointOfView'])
    : 'third-limited';

  const rawTense = asString(nr.tense, existing?.narrativeRegister.tense || 'past');
  const tense: 'past' | 'present' = rawTense === 'present' ? 'present' : 'past';

  const rawInteriority = asString(nr.interiority, existing?.narrativeRegister.interiority || 'medium');
  const interiority: 'high' | 'medium' | 'low' =
    rawInteriority === 'high' || rawInteriority === 'low' ? rawInteriority : 'medium';

  const rawFormality = asString(dict.formality, existing?.diction.formality || 'neutral');
  const formality: 'formal' | 'neutral' | 'casual' =
    rawFormality === 'formal' || rawFormality === 'casual' ? rawFormality : 'neutral';

  const validSenses = new Set(['sight', 'sound', 'smell', 'taste', 'touch']);
  const dominantSenses = asStringArray(sp.dominantSenses).filter((s) =>
    validSenses.has(s)
  ) as Style['sensoryPalette']['dominantSenses'];

  return StyleSchema.parse({
    schemaVersion: 1,
    rhythm: {
      avgSentenceLengthHint: avgRes.value ?? existing?.rhythm.avgSentenceLengthHint,
      paragraphLengthHint: paraRes.value ?? existing?.rhythm.paragraphLengthHint,
      rhythmNotes: rhythmNotes || existing?.rhythm.rhythmNotes,
    },
    diction: {
      register: dict.register !== undefined ? (asString(dict.register) || undefined) : existing?.diction.register,
      formality,
      favoredWords: dict.favoredWords !== undefined ? asStringArray(dict.favoredWords) : (existing?.diction.favoredWords || []),
      avoidedWords: dict.avoidedWords !== undefined ? asStringArray(dict.avoidedWords) : (existing?.diction.avoidedWords || []),
    },
    dialogue: {
      taggingConvention: tagRes.value ?? existing?.dialogue.taggingConvention,
      registerNotes: registerNotes || existing?.dialogue.registerNotes,
      dialectMarkers: dialectRes.value
        ? dialectRes.value.split(',').map((s) => s.trim()).filter(Boolean)
        : (existing?.dialogue.dialectMarkers || []),
    },
    narrativeRegister: {
      pointOfView: pov,
      tense,
      interiority,
    },
    sensoryPalette: {
      dominantSenses: sp.dominantSenses !== undefined ? dominantSenses : (existing?.sensoryPalette.dominantSenses || []),
      colorNotes: colorRes.value ?? existing?.sensoryPalette.colorNotes,
      soundNotes: soundRes.value ?? existing?.sensoryPalette.soundNotes,
    },
    pronounPairs: data.pronounPairs !== undefined ? asStringArray(data.pronounPairs) : (existing?.pronounPairs || []),
  });
}

// ---- Low-Level Directory Handle Helpers ------------------------------------

async function getSubdir(root: DirHandleExt, segments: string[], create: boolean): Promise<DirHandleExt | null> {
  let curr: DirHandleExt = root;
  for (const seg of segments) {
    try {
      curr = (await curr.getDirectoryHandle(seg, { create })) as unknown as DirHandleExt;
    } catch {
      return null;
    }
  }
  return curr;
}

async function readDiskFile(root: DirHandleExt, relPath: string): Promise<{ content: string; mtimeMs: number } | null> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const fileName = parts[parts.length - 1];
  const dir = await getSubdir(root, parts.slice(0, -1), false);
  if (!dir) return null;

  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    const content = await file.text();
    return { content, mtimeMs: file.lastModified };
  } catch {
    return null;
  }
}

async function writeDiskFile(root: DirHandleExt, relPath: string, content: string): Promise<number> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return Date.now();
  const fileName = parts[parts.length - 1];
  const dir = await getSubdir(root, parts.slice(0, -1), true);
  if (!dir) throw new Error(`Failed to resolve directory for ${relPath}`);

  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(normalizeLf(content));
  await writable.close();
  try {
    const file = await fileHandle.getFile();
    return file.lastModified;
  } catch {
    return Date.now();
  }
}

async function deleteDiskFile(root: DirHandleExt, relPath: string): Promise<void> {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return;
  const fileName = parts[parts.length - 1];
  const dir = await getSubdir(root, parts.slice(0, -1), false);
  if (!dir) return;
  try {
    await dir.removeEntry(fileName);
  } catch {
    // ignore NotFoundError
  }
}

async function listDiskMarkdownFiles(root: DirHandleExt, dirRelPath: string): Promise<string[]> {
  const parts = dirRelPath.split('/').filter(Boolean);
  const dir = await getSubdir(root, parts, false);
  if (!dir) return [];

  const results: string[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && name.toLowerCase().endsWith('.md')) {
      results.push(`${dirRelPath}/${name}`);
    }
  }
  return results.sort();
}

// ---- Canonical Hashing Helpers ---------------------------------------------

function canonicalChapterHash(id: string, title: string, status: Chapter['status'], order: number, body: string): string {
  return hashContent(JSON.stringify({ id, title, status, order, body: normalizeLf(body).trimEnd() }));
}

function canonicalContinuityHash(chapterId: string, title: string, order: number, body: string): string {
  return hashContent(JSON.stringify({ chapterId, title, order, body: normalizeLf(body).trimEnd() }));
}

function canonicalCharacterHash(char: Character): string {
  return hashContent(characterToDiskMd(char));
}

function canonicalLocationHash(loc: Location): string {
  return hashContent(locationToDiskMd(loc));
}

function canonicalItemHash(item: Item): string {
  return hashContent(itemToDiskMd(item));
}

function canonicalWorldRuleHash(rule: WorldRule): string {
  return hashContent(worldRuleToDiskMd(rule));
}

function canonicalStyleHash(style: Style): string {
  return hashContent(styleToDiskMd(style));
}

function canonicalCorkboardHash(rawJson: string): string {
  try {
    const parsed = CorkboardSchema.safeParse(JSON.parse(rawJson));
    if (parsed.success) {
      return hashContent(JSON.stringify(parsed.data));
    }
  } catch {
    // ignore malformed json
  }
  return hashContent(rawJson);
}

function formatCorkboardForDisk(rawJson: string): string {
  try {
    const parsed = CorkboardSchema.safeParse(JSON.parse(rawJson));
    if (parsed.success) {
      return JSON.stringify(parsed.data, null, 2);
    }
  } catch {
    // ignore
  }
  return rawJson;
}

// ---- DiskFolderSync Service ------------------------------------------------

const MANIFEST_DISK_PATH = '.xnovelist/sync-manifest.json';

export class DiskFolderSync {
  private idbStore: IndexedDBProjectStorage;
  private callbacks: DiskSyncCallbacks = {};
  private status: SyncStatus = 'disconnected';
  private folderName: string | null = null;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private conflicts: SyncConflict[] = [];
  private activeProjectId: string | null = null;
  private activeHandle: DirHandleExt | null = null;
  private syncChain: Promise<void> = Promise.resolve();

  constructor(idbStore: IndexedDBProjectStorage, callbacks?: DiskSyncCallbacks) {
    this.idbStore = idbStore;
    if (callbacks) {
      this.callbacks = callbacks;
    }
    if (!DiskFolderSync.isSupported()) {
      this.status = 'unsupported';
    }
  }

  static isSupported(): boolean {
    return typeof window !== 'undefined' && typeof (window as unknown as WindowWithDirPicker).showDirectoryPicker === 'function';
  }

  setCallbacks(callbacks: DiskSyncCallbacks): void {
    this.callbacks = callbacks;
  }

  getState(): {
    supported: boolean;
    status: SyncStatus;
    folderName: string | null;
    lastSyncedAt: string | null;
    error: string | null;
    conflicts: SyncConflict[];
  } {
    return {
      supported: DiskFolderSync.isSupported(),
      status: this.status,
      folderName: this.folderName,
      lastSyncedAt: this.lastSyncedAt,
      error: this.lastError,
      conflicts: this.conflicts,
    };
  }

  private emitStatus(status: SyncStatus, error: string | null = null): void {
    this.status = status;
    this.lastError = error;
    this.callbacks.onStatusChange?.(status, {
      folderName: this.folderName,
      lastSyncedAt: this.lastSyncedAt,
      error,
    });
  }

  private emitConflicts(conflicts: SyncConflict[]): void {
    this.conflicts = conflicts;
    this.callbacks.onConflictsChange?.(conflicts);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncChain.then(fn, fn);
    this.syncChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /**
   * Loads any persisted folder handle for `projectId`, checks permission, and reconciles if granted.
   */
  async loadProjectLink(projectId: string): Promise<void> {
    this.activeProjectId = projectId;
    this.emitConflicts([]);

    if (!DiskFolderSync.isSupported()) {
      this.activeHandle = null;
      this.folderName = null;
      this.lastSyncedAt = null;
      this.emitStatus('unsupported');
      return;
    }

    const saved = await this.idbStore.getFolderHandle(projectId);
    if (!saved) {
      this.activeHandle = null;
      this.folderName = null;
      this.lastSyncedAt = null;
      this.emitStatus('disconnected');
      return;
    }

    const handle = saved.dirHandle as unknown as DirHandleExt;
    this.activeHandle = handle;
    this.folderName = saved.folderName || handle.name;

    const manifestRaw = await readDiskFile(handle, MANIFEST_DISK_PATH).catch(() => null);
    if (manifestRaw) {
      try {
        const parsed = SyncManifestSchema.safeParse(JSON.parse(manifestRaw.content));
        if (parsed.success) {
          this.lastSyncedAt = parsed.data.lastSyncedAt;
        }
      } catch {
        // ignore
      }
    }

    const perm = await this.queryReadWritePermission(handle);
    if (perm === 'granted') {
      await this.reconcile(projectId);
    } else {
      this.emitStatus('needs-permission');
    }
  }

  clearActiveProject(): void {
    this.activeProjectId = null;
    this.activeHandle = null;
    this.folderName = null;
    this.lastSyncedAt = null;
    this.emitConflicts([]);
    this.emitStatus(DiskFolderSync.isSupported() ? 'disconnected' : 'unsupported');
  }

  private async queryReadWritePermission(handle: DirHandleExt): Promise<PermissionStateValue> {
    try {
      if (typeof handle.queryPermission === 'function') {
        return await handle.queryPermission({ mode: 'readwrite' });
      }
      return 'granted';
    } catch {
      return 'prompt';
    }
  }

  /**
   * Must be invoked inside a user gesture (button click).
   */
  async pickAndInspectFolder(): Promise<FolderInspectionResult | null> {
    if (!DiskFolderSync.isSupported()) {
      this.emitStatus('unsupported');
      return null;
    }
    const picker = (window as unknown as WindowWithDirPicker).showDirectoryPicker;
    if (!picker) return null;

    let rawHandle: FileSystemDirectoryHandle;
    try {
      rawHandle = await picker({ mode: 'readwrite', id: 'xnovelist-novel-folder' });
    } catch (err) {
      // User cancelled picker
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null;
      }
      throw err;
    }

    const handle = rawHandle as unknown as DirHandleExt;
    const projectJson = await readDiskFile(handle, '.xnovelist/Project.json');
    const manifestJson = await readDiskFile(handle, MANIFEST_DISK_PATH);
    const chapterFiles = await listDiskMarkdownFiles(handle, 'chapters');

    return {
      handle: rawHandle,
      folderName: rawHandle.name,
      hasExistingNovel: Boolean(projectJson || chapterFiles.length > 0),
      hasManifest: Boolean(manifestJson),
      mdFileCount: chapterFiles.length,
    };
  }

  async completeLink(
    projectId: string,
    handle: FileSystemDirectoryHandle,
    mode: 'push' | 'pull' | 'reconcile'
  ): Promise<SyncResult> {
    return this.enqueue(async () => {
      const extHandle = handle as unknown as DirHandleExt;
      if (typeof extHandle.requestPermission === 'function') {
        const perm = await extHandle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          this.activeProjectId = projectId;
          this.activeHandle = extHandle;
          this.folderName = handle.name;
          this.emitStatus('needs-permission');
          return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
        }
      }

      await this.idbStore.saveFolderHandle(projectId, handle);
      this.activeProjectId = projectId;
      this.activeHandle = extHandle;
      this.folderName = handle.name;

      if (mode === 'push') {
        return await this.pushAllFromIdb(projectId, extHandle);
      }
      if (mode === 'pull') {
        return await this.pullAllFromDisk(projectId, extHandle);
      }
      return await this.runReconcile(projectId, extHandle);
    });
  }

  async requestFolderPermission(projectId: string): Promise<boolean> {
    if (!DiskFolderSync.isSupported()) return false;
    let handle = this.activeHandle;
    if (!handle) {
      const saved = await this.idbStore.getFolderHandle(projectId);
      if (!saved) return false;
      handle = saved.dirHandle as unknown as DirHandleExt;
      this.activeHandle = handle;
      this.folderName = saved.folderName || handle.name;
    }

    if (typeof handle.requestPermission === 'function') {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        this.emitStatus('needs-permission');
        return false;
      }
    }

    await this.reconcile(projectId);
    return true;
  }

  async unlinkFolder(projectId: string): Promise<void> {
    await this.enqueue(async () => {
      await this.idbStore.deleteFolderHandle(projectId);
      if (this.activeProjectId === projectId) {
        this.activeHandle = null;
        this.folderName = null;
        this.lastSyncedAt = null;
        this.emitConflicts([]);
        this.emitStatus(DiskFolderSync.isSupported() ? 'disconnected' : 'unsupported');
      }
    });
  }

  async reconcile(projectId: string): Promise<SyncResult> {
    return this.enqueue(async () => {
      if (!DiskFolderSync.isSupported()) {
        this.emitStatus('unsupported');
        return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
      }
      if (this.activeProjectId !== projectId || !this.activeHandle) {
        const saved = await this.idbStore.getFolderHandle(projectId);
        if (!saved) {
          this.emitStatus('disconnected');
          return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
        }
        this.activeProjectId = projectId;
        this.activeHandle = saved.dirHandle as unknown as DirHandleExt;
        this.folderName = saved.folderName || saved.dirHandle.name;
      }

      const perm = await this.queryReadWritePermission(this.activeHandle);
      if (perm !== 'granted') {
        this.emitStatus('needs-permission');
        return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
      }

      return await this.runReconcile(projectId, this.activeHandle);
    });
  }

  /**
   * Called by SyncingProjectStorage after debounced writes/deletes inside IndexedDB.
   * Ignores `.history/` and `workspace/ai.json`.
   */
  async flushPaths(projectId: string, changedPaths: string[]): Promise<void> {
    const filtered = changedPaths.filter((p) => !p.includes('.history') && !p.includes('workspace/ai.json'));
    if (filtered.length === 0) return;
    if (this.activeProjectId !== projectId || !this.activeHandle) return;
    await this.reconcile(projectId);
  }

  /**
   * Resolves a single conflict by keeping either browser (IDB) or disk version.
   */
  async resolveConflict(projectId: string, conflict: SyncConflict, choice: 'idb' | 'disk'): Promise<void> {
    await this.enqueue(async () => {
      if (!this.activeHandle) return;
      const handle = this.activeHandle;
      const perm = await this.queryReadWritePermission(handle);
      if (perm !== 'granted') {
        this.emitStatus('needs-permission');
        return;
      }

      this.emitStatus('syncing');
      const prefix = `projects/${projectId}/`;
      const manifest = await this.readManifest(projectId, handle);
      const changedIdbPaths: string[] = [];

      if (choice === 'idb') {
        // Push IDB content to disk and update manifest baseline
        const mtimeMs = await writeDiskFile(handle, conflict.diskPath, conflict.idbContent);
        const now = new Date().toISOString();
        const canonical = await this.computeCanonicalHashForVirtualPath(projectId, conflict.idbPath, conflict.idbContent);
        manifest.entries[conflict.idbPath] = {
          idbPath: conflict.idbPath,
          diskPath: conflict.diskPath,
          baseHash: canonical,
          baseIdbUpdatedAt: conflict.idbUpdatedAt || now,
          baseDiskMtimeMs: mtimeMs,
        };
      } else {
        // Use disk content: snapshot chapter first if chapter markdown, then import into IDB
        if (conflict.idbPath.startsWith('Artifacts/chapter-')) {
          const chapterId = conflict.idbPath.replace('Artifacts/chapter-', '').replace('.md', '');
          await takeSnapshot(
            this.idbStore,
            chapterId,
            'pre-import',
            'Before disk conflict resolution',
            undefined,
            projectId
          ).catch(() => {});

          const parsed = diskMdToChapter(conflict.diskContent, chapterId);
          await this.idbStore.writeFile(`${prefix}${conflict.idbPath}`, parsed.body);

          const projRaw = await this.idbStore.readFile(`${prefix}Project.json`);
          if (projRaw) {
            const proj = ProjectSchema.parse(JSON.parse(projRaw));
            const idx = proj.chapters.findIndex((c) => c.id === chapterId);
            if (idx >= 0) {
              proj.chapters[idx] = {
                ...proj.chapters[idx],
                title: parsed.title,
                status: parsed.status,
                updatedAt: parsed.updatedAt,
              };
            }
            await this.idbStore.writeFile(`${prefix}Project.json`, JSON.stringify(proj));
          }
          changedIdbPaths.push(conflict.idbPath, 'Project.json');
        } else if (conflict.idbPath.startsWith('Continuity/chapter-')) {
          const chapterId = conflict.idbPath.replace('Continuity/chapter-', '').replace('.md', '');
          const parsed = diskMdToContinuity(conflict.diskContent, chapterId);
          await this.idbStore.writeFile(`${prefix}${conflict.idbPath}`, parsed.body);
          changedIdbPaths.push(conflict.idbPath);
        } else if (conflict.idbPath.startsWith('Bible/character-')) {
          const charId = conflict.idbPath.replace('Bible/character-', '');
          const rawChars = await this.idbStore.readFile(`${prefix}Characters.json`);
          const parsedChars = rawChars ? CharactersSchema.parse(JSON.parse(rawChars)) : { schemaVersion: 1 as const, characters: [] };
          const existing = parsedChars.characters.find((c) => c.id === charId);
          const updatedChar = diskMdToCharacter(conflict.diskContent, existing, charId);
          const nextChars = existing
            ? parsedChars.characters.map((c) => (c.id === charId ? updatedChar : c))
            : [...parsedChars.characters, updatedChar];
          const nextCharsJson = JSON.stringify({ schemaVersion: 1, characters: nextChars });
          await this.idbStore.writeFile(`${prefix}Characters.json`, nextCharsJson);
          await writeDiskFile(handle, '.xnovelist/Characters.json', nextCharsJson);
          changedIdbPaths.push('Characters.json');
        } else if (conflict.idbPath.startsWith('Bible/location-')) {
          const locId = conflict.idbPath.replace('Bible/location-', '');
          const rawLocs = await this.idbStore.readFile(`${prefix}Locations.json`);
          const parsedLocs = rawLocs ? LocationsSchema.parse(JSON.parse(rawLocs)) : { schemaVersion: 1 as const, locations: [] };
          const existing = parsedLocs.locations.find((l) => l.id === locId);
          const updatedLoc = diskMdToLocation(conflict.diskContent, existing, locId);
          const nextLocs = existing
            ? parsedLocs.locations.map((l) => (l.id === locId ? updatedLoc : l))
            : [...parsedLocs.locations, updatedLoc];
          const nextLocsJson = JSON.stringify({ schemaVersion: 1, locations: nextLocs });
          await this.idbStore.writeFile(`${prefix}Locations.json`, nextLocsJson);
          await writeDiskFile(handle, '.xnovelist/Locations.json', nextLocsJson);
          changedIdbPaths.push('Locations.json');
        } else if (conflict.idbPath.startsWith('Bible/item-')) {
          const itemId = conflict.idbPath.replace('Bible/item-', '');
          const rawItems = await this.idbStore.readFile(`${prefix}Items.json`);
          const parsedItems = rawItems ? ItemsSchema.parse(JSON.parse(rawItems)) : { schemaVersion: 1 as const, items: [] };
          const existing = parsedItems.items.find((it) => it.id === itemId);
          const updatedItem = diskMdToItem(conflict.diskContent, existing, itemId);
          const nextItems = existing
            ? parsedItems.items.map((it) => (it.id === itemId ? updatedItem : it))
            : [...parsedItems.items, updatedItem];
          const nextItemsJson = JSON.stringify({ schemaVersion: 1, items: nextItems });
          await this.idbStore.writeFile(`${prefix}Items.json`, nextItemsJson);
          await writeDiskFile(handle, '.xnovelist/Items.json', nextItemsJson);
          changedIdbPaths.push('Items.json');
        } else if (conflict.idbPath.startsWith('Bible/rule-')) {
          const ruleId = conflict.idbPath.replace('Bible/rule-', '');
          const rawRules = await this.idbStore.readFile(`${prefix}WorldRules.json`);
          const parsedRules = rawRules ? WorldRulesSchema.parse(JSON.parse(rawRules)) : { schemaVersion: 1 as const, rules: [] };
          const existing = parsedRules.rules.find((r) => r.id === ruleId);
          const updatedRule = diskMdToWorldRule(conflict.diskContent, existing, ruleId);
          const nextRules = existing
            ? parsedRules.rules.map((r) => (r.id === ruleId ? updatedRule : r))
            : [...parsedRules.rules, updatedRule];
          const nextRulesJson = JSON.stringify({ schemaVersion: 1, rules: nextRules });
          await this.idbStore.writeFile(`${prefix}WorldRules.json`, nextRulesJson);
          await writeDiskFile(handle, '.xnovelist/WorldRules.json', nextRulesJson);
          changedIdbPaths.push('WorldRules.json');
        } else if (conflict.idbPath === 'Style.json') {
          const rawStyle = await this.idbStore.readFile(`${prefix}Style.json`);
          const existingStyle = rawStyle ? StyleSchema.parse(JSON.parse(rawStyle)) : undefined;
          const updatedStyle = diskMdToStyle(conflict.diskContent, existingStyle);
          const nextStyleJson = JSON.stringify(updatedStyle);
          await this.idbStore.writeFile(`${prefix}Style.json`, nextStyleJson);
          await writeDiskFile(handle, '.xnovelist/Style.json', nextStyleJson);
          changedIdbPaths.push('Style.json');
        } else if (conflict.idbPath === 'Corkboard.json') {
          const parsedDisk = CorkboardSchema.safeParse(JSON.parse(conflict.diskContent));
          const normalized = parsedDisk.success ? JSON.stringify(parsedDisk.data) : conflict.diskContent;
          await this.idbStore.writeFile(`${prefix}Corkboard.json`, normalized);
          changedIdbPaths.push('Corkboard.json');
        }

        const canonical = await this.computeCanonicalHashForVirtualPath(projectId, conflict.idbPath, conflict.diskContent);
        manifest.entries[conflict.idbPath] = {
          idbPath: conflict.idbPath,
          diskPath: conflict.diskPath,
          baseHash: canonical,
          baseIdbUpdatedAt: new Date().toISOString(),
          baseDiskMtimeMs: conflict.diskMtimeMs,
        };
      }

      const now = new Date().toISOString();
      manifest.lastSyncedAt = now;
      await this.writeManifest(handle, manifest);
      this.lastSyncedAt = now;

      const remaining = this.conflicts.filter((c) => c.idbPath !== conflict.idbPath);
      this.emitConflicts(remaining);
      this.emitStatus(remaining.length > 0 ? 'conflict' : 'synced');

      if (changedIdbPaths.length > 0) {
        await this.callbacks.onExternalSyncReload?.(changedIdbPaths);
      }
    });
  }

  private async computeCanonicalHashForVirtualPath(projectId: string, idbPath: string, content: string): Promise<string> {
    if (idbPath.startsWith('Artifacts/chapter-')) {
      const chId = idbPath.replace('Artifacts/chapter-', '').replace('.md', '');
      const parsed = diskMdToChapter(content, chId);
      return canonicalChapterHash(parsed.id, parsed.title, parsed.status, parsed.order, parsed.body);
    }
    if (idbPath.startsWith('Continuity/chapter-')) {
      const chId = idbPath.replace('Continuity/chapter-', '').replace('.md', '');
      const parsed = diskMdToContinuity(content, chId);
      return canonicalContinuityHash(parsed.chapterId, parsed.title, parsed.order, parsed.body);
    }
    if (idbPath.startsWith('Bible/character-')) {
      const chId = idbPath.replace('Bible/character-', '');
      const parsed = diskMdToCharacter(content, undefined, chId);
      return canonicalCharacterHash(parsed);
    }
    if (idbPath.startsWith('Bible/location-')) {
      const locId = idbPath.replace('Bible/location-', '');
      const parsed = diskMdToLocation(content, undefined, locId);
      return canonicalLocationHash(parsed);
    }
    if (idbPath.startsWith('Bible/item-')) {
      const itemId = idbPath.replace('Bible/item-', '');
      const parsed = diskMdToItem(content, undefined, itemId);
      return canonicalItemHash(parsed);
    }
    if (idbPath.startsWith('Bible/rule-')) {
      const ruleId = idbPath.replace('Bible/rule-', '');
      const parsed = diskMdToWorldRule(content, undefined, ruleId);
      return canonicalWorldRuleHash(parsed);
    }
    if (idbPath === 'Style.json') {
      const parsed = diskMdToStyle(content);
      return canonicalStyleHash(parsed);
    }
    if (idbPath === 'Corkboard.json') {
      return canonicalCorkboardHash(content);
    }
    return hashContent(`${projectId}:${content}`);
  }

  private async readManifest(projectId: string, handle: DirHandleExt): Promise<SyncManifest> {
    const file = await readDiskFile(handle, MANIFEST_DISK_PATH);
    if (file) {
      try {
        const parsed = SyncManifestSchema.safeParse(JSON.parse(file.content));
        if (parsed.success && parsed.data.projectId === projectId) {
          return parsed.data;
        }
      } catch {
        // ignore corrupt manifest
      }
    }
    return {
      schemaVersion: 1,
      projectId,
      folderName: handle.name,
      lastSyncedAt: new Date(0).toISOString(),
      entries: {},
    };
  }

  private async writeManifest(handle: DirHandleExt, manifest: SyncManifest): Promise<void> {
    await writeDiskFile(handle, MANIFEST_DISK_PATH, JSON.stringify(manifest, null, 2));
  }

  private async loadIdbProjectState(projectId: string) {
    const prefix = `projects/${projectId}/`;
    const projStr = await this.idbStore.readFile(`${prefix}Project.json`);
    if (!projStr) return null;

    const project = ProjectSchema.parse(JSON.parse(projStr));
    const charsStr = await this.idbStore.readFile(`${prefix}Characters.json`);
    const characters = charsStr
      ? CharactersSchema.parse(JSON.parse(charsStr))
      : { schemaVersion: 1 as const, characters: [] as Character[] };

    const locsStr = await this.idbStore.readFile(`${prefix}Locations.json`);
    const locations = locsStr
      ? LocationsSchema.parse(JSON.parse(locsStr))
      : { schemaVersion: 1 as const, locations: [] as Location[] };

    const itemsStr = await this.idbStore.readFile(`${prefix}Items.json`);
    const items = itemsStr
      ? ItemsSchema.parse(JSON.parse(itemsStr))
      : { schemaVersion: 1 as const, items: [] as Item[] };

    const styleStr = await this.idbStore.readFile(`${prefix}Style.json`);
    const style = styleStr
      ? StyleSchema.parse(JSON.parse(styleStr))
      : StyleSchema.parse({ schemaVersion: 1 });

    const beatsStr = await this.idbStore.readFile(`${prefix}Beats.json`);
    const chapterFiles = await this.idbStore.listFiles(`${prefix}Artifacts/chapter-`);
    const chaptersBody: Record<string, string> = {};
    for (const p of chapterFiles) {
      const cid = p.replace(`${prefix}Artifacts/chapter-`, '').replace('.md', '');
      chaptersBody[cid] = (await this.idbStore.readFile(p)) || '';
    }

    const contFiles = await this.idbStore.listFiles(`${prefix}Continuity/chapter-`);
    const continuityBody: Record<string, string> = {};
    for (const p of contFiles) {
      const cid = p.replace(`${prefix}Continuity/chapter-`, '').replace('.md', '');
      continuityBody[cid] = (await this.idbStore.readFile(p)) || '';
    }

    const worldRulesStr = await this.idbStore.readFile(`${prefix}WorldRules.json`);
    const worldRules = worldRulesStr
      ? WorldRulesSchema.parse(JSON.parse(worldRulesStr))
      : { schemaVersion: 1 as const, rules: [] as WorldRule[] };
    const corkboardStr = await this.idbStore.readFile(`${prefix}Corkboard.json`);

    return {
      prefix,
      project,
      characters,
      locations,
      items,
      worldRules,
      style,
      beatsStr,
      chaptersBody,
      continuityBody,
      worldRulesStr,
      corkboardStr,
    };
  }

  private async updateProjectRegistryTitle(project: Project): Promise<void> {
    const regStr = await this.idbStore.readFile('projects.json');
    if (!regStr) return;
    try {
      const list = JSON.parse(regStr) as Array<Record<string, unknown>>;
      let changed = false;
      const next = list.map((item) => {
        if (item.id === project.id) {
          changed = true;
          return {
            ...item,
            title: project.title,
            author: project.author,
            updatedAt: project.updatedAt || new Date().toISOString(),
          };
        }
        return item;
      });
      if (changed) {
        await this.idbStore.writeFile('projects.json', JSON.stringify(next));
      }
    } catch {
      // ignore
    }
  }

  private allocateUniquePath(desiredPath: string, usedPaths: Set<string>, id: string): string {
    if (!usedPaths.has(desiredPath)) {
      usedPaths.add(desiredPath);
      return desiredPath;
    }
    const dotIdx = desiredPath.lastIndexOf('.');
    const stem = dotIdx >= 0 ? desiredPath.slice(0, dotIdx) : desiredPath;
    const ext = dotIdx >= 0 ? desiredPath.slice(dotIdx) : '';
    const shortId = slugifyFilename(id, 'dup').slice(0, 12);
    const candidate = `${stem}-${shortId}${ext}`;
    if (!usedPaths.has(candidate)) {
      usedPaths.add(candidate);
      return candidate;
    }
    let counter = 2;
    while (usedPaths.has(`${stem}-${counter}${ext}`)) {
      counter++;
    }
    const finalPath = `${stem}-${counter}${ext}`;
    usedPaths.add(finalPath);
    return finalPath;
  }

  private resolveChapterMeta(project: Project, id: string, md: string): Chapter {
    const existing = (project.chapters || []).find((c) => c.id === id);
    const firstLine = normalizeLf(md).split('\n')[0] || '';
    const headingTitle = firstLine.startsWith('#') ? firstLine.replace(/^#+\s*/, '').trim() : '';
    return {
      id,
      title: headingTitle || existing?.title || `Chapter ${id}`,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: existing?.updatedAt || new Date().toISOString(),
      synopsis: existing?.synopsis,
      status: existing?.status || 'draft',
    };
  }

  /**
   * Unconditionally writes the complete IDB project to disk and resets sync-manifest.json.
   */
  private async pushAllFromIdb(projectId: string, handle: DirHandleExt): Promise<SyncResult> {
    this.emitStatus('syncing');
    const state = await this.loadIdbProjectState(projectId);
    if (!state) {
      this.emitStatus('error', 'Active project missing in browser storage.');
      return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
    }

    const entries: Record<string, SyncManifestEntry> = {};
    const usedPaths = new Set<string>();
    const now = new Date().toISOString();
    let pushedCount = 0;

    // Build ordered chapter list
    const allChapterIds = Array.from(
      new Set([...state.project.chapterOrder, ...Object.keys(state.chaptersBody)])
    ).filter((cid) => state.chaptersBody[cid] !== undefined);

    for (let i = 0; i < allChapterIds.length; i++) {
      const cid = allChapterIds[i];
      const order = i + 1;
      const body = state.chaptersBody[cid] || '';
      const chapMeta = this.resolveChapterMeta(state.project, cid, body);
      const diskPath = this.allocateUniquePath(
        `chapters/${padOrder(order)}-${slugifyFilename(chapMeta.title, `chapter-${cid}`)}.md`,
        usedPaths,
        cid
      );
      const diskMd = chapterToDiskMd(chapMeta, order, body);
      const mtimeMs = await writeDiskFile(handle, diskPath, diskMd);
      const idbPath = `Artifacts/chapter-${cid}.md`;
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalChapterHash(cid, chapMeta.title, chapMeta.status, order, body),
        baseIdbUpdatedAt: chapMeta.updatedAt,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;

      // Continuity if present
      if (state.continuityBody[cid] !== undefined) {
        const contBody = state.continuityBody[cid];
        const contDiskPath = this.allocateUniquePath(
          `continuity/${padOrder(order)}-${slugifyFilename(chapMeta.title, `chapter-${cid}`)}.md`,
          usedPaths,
          cid
        );
        const contMd = continuityToDiskMd(cid, chapMeta.title, order, chapMeta.updatedAt, contBody);
        const contMtime = await writeDiskFile(handle, contDiskPath, contMd);
        const contIdbPath = `Continuity/chapter-${cid}.md`;
        entries[contIdbPath] = {
          idbPath: contIdbPath,
          diskPath: contDiskPath,
          baseHash: canonicalContinuityHash(cid, chapMeta.title, order, contBody),
          baseIdbUpdatedAt: chapMeta.updatedAt,
          baseDiskMtimeMs: contMtime,
        };
        pushedCount++;
      }
    }

    // Characters
    for (const char of state.characters.characters) {
      const diskPath = this.allocateUniquePath(
        `story-bible/characters/${slugifyFilename(char.name, char.id)}.md`,
        usedPaths,
        char.id
      );
      const md = characterToDiskMd(char);
      const mtimeMs = await writeDiskFile(handle, diskPath, md);
      const idbPath = `Bible/character-${char.id}`;
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalCharacterHash(char),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;
    }

    // Locations
    for (const loc of state.locations.locations) {
      const diskPath = this.allocateUniquePath(
        `story-bible/locations/${slugifyFilename(loc.name, loc.id)}.md`,
        usedPaths,
        loc.id
      );
      const md = locationToDiskMd(loc);
      const mtimeMs = await writeDiskFile(handle, diskPath, md);
      const idbPath = `Bible/location-${loc.id}`;
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalLocationHash(loc),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;
    }

    // Items
    for (const item of state.items.items) {
      const diskPath = this.allocateUniquePath(
        `story-bible/items/${slugifyFilename(item.name, item.id)}.md`,
        usedPaths,
        item.id
      );
      const md = itemToDiskMd(item);
      const mtimeMs = await writeDiskFile(handle, diskPath, md);
      const idbPath = `Bible/item-${item.id}`;
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalItemHash(item),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;
    }

    // World Rules
    for (const rule of state.worldRules.rules) {
      const diskPath = this.allocateUniquePath(
        `story-bible/world-rules/${slugifyFilename(rule.title, rule.id)}.md`,
        usedPaths,
        rule.id
      );
      const md = worldRuleToDiskMd(rule);
      const mtimeMs = await writeDiskFile(handle, diskPath, md);
      const idbPath = `Bible/rule-${rule.id}`;
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalWorldRuleHash(rule),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;
    }

    // Style
    {
      const diskPath = 'story-bible/style.md';
      const md = styleToDiskMd(state.style);
      const mtimeMs = await writeDiskFile(handle, diskPath, md);
      entries['Style.json'] = {
        idbPath: 'Style.json',
        diskPath,
        baseHash: canonicalStyleHash(state.style),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: mtimeMs,
      };
      pushedCount++;
    }

    // Lossless JSON mirrors under .xnovelist/
    await writeDiskFile(handle, '.xnovelist/Project.json', JSON.stringify(state.project, null, 2));
    await writeDiskFile(handle, '.xnovelist/Characters.json', JSON.stringify(state.characters, null, 2));
    await writeDiskFile(handle, '.xnovelist/Locations.json', JSON.stringify(state.locations, null, 2));
    await writeDiskFile(handle, '.xnovelist/Items.json', JSON.stringify(state.items, null, 2));
    await writeDiskFile(handle, '.xnovelist/WorldRules.json', JSON.stringify(state.worldRules, null, 2));
    await writeDiskFile(handle, '.xnovelist/Style.json', JSON.stringify(state.style, null, 2));
    if (state.beatsStr) {
      await writeDiskFile(handle, '.xnovelist/Beats.json', state.beatsStr);
    }
    if (state.corkboardStr) {
      const corkMtime = await writeDiskFile(handle, '.xnovelist/Corkboard.json', formatCorkboardForDisk(state.corkboardStr));
      entries['Corkboard.json'] = {
        idbPath: 'Corkboard.json',
        diskPath: '.xnovelist/Corkboard.json',
        baseHash: canonicalCorkboardHash(state.corkboardStr),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: corkMtime,
      };
      pushedCount++;
    }

    const manifest: SyncManifest = {
      schemaVersion: 1,
      projectId,
      folderName: handle.name,
      lastSyncedAt: now,
      entries,
    };
    await this.writeManifest(handle, manifest);
    this.lastSyncedAt = now;
    this.emitConflicts([]);
    this.emitStatus('synced');

    return { pulledCount: 0, pushedCount, deletedCount: 0, conflicts: [], pulledPaths: [] };
  }

  /**
   * Imports all novel files from a disk folder into IndexedDB after taking pre-import snapshots.
   */
  private async pullAllFromDisk(projectId: string, handle: DirHandleExt): Promise<SyncResult> {
    this.emitStatus('syncing');
    const prefix = `projects/${projectId}/`;
    const now = new Date().toISOString();
    const entries: Record<string, SyncManifestEntry> = {};
    const pulledPaths: string[] = [];

    // 1. Pre-import snapshot for every existing IDB chapter
    const existingChapterPaths = await this.idbStore.listFiles(`${prefix}Artifacts/chapter-`);
    for (const p of existingChapterPaths) {
      const cid = p.replace(`${prefix}Artifacts/chapter-`, '').replace('.md', '');
      await takeSnapshot(this.idbStore, cid, 'pre-import', 'Before disk folder import', undefined, projectId).catch(() => {});
    }

    // 2. Load base Project.json from disk (if present) or existing IDB project
    const diskProjFile = await readDiskFile(handle, '.xnovelist/Project.json');
    const idbProjStr = await this.idbStore.readFile(`${prefix}Project.json`);
    let project: Project = diskProjFile
      ? ProjectSchema.parse({ ...JSON.parse(diskProjFile.content), id: projectId })
      : idbProjStr
      ? ProjectSchema.parse(JSON.parse(idbProjStr))
      : ProjectSchema.parse({
          schemaVersion: 1,
          id: projectId,
          title: handle.name,
          createdAt: now,
          updatedAt: now,
          activeChapterId: 'chapter-1',
          chapterOrder: [],
          typography: {
            fontFamily: 'serif',
            fontSize: 'normal',
            lineHeight: 'comfortable',
            pageWidth: 'normal',
            textIndent: 'normal',
            chicagoStyle: false,
            paragraphSpacing: 'normal',
            textAlignment: 'left',
            sceneDivider: 'asterisk',
          },
          chapters: [],
        });

    // 3. Import chapters/*.md
    const diskChapterPaths = await listDiskMarkdownFiles(handle, 'chapters');
    const importedChapters: Array<{ chapter: Chapter; order: number; diskPath: string; mtimeMs: number; body: string }> = [];

    for (let i = 0; i < diskChapterPaths.length; i++) {
      const diskPath = diskChapterPaths[i];
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const baseName = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const fallbackId = `chapter-${slugifyFilename(baseName, String(i + 1))}`;
      const parsed = diskMdToChapter(fileData.content, fallbackId);
      const existingChap = project.chapters.find((c) => c.id === parsed.id);

      const chap: Chapter = {
        id: parsed.id,
        title: parsed.title,
        createdAt: existingChap?.createdAt || parsed.updatedAt || now,
        updatedAt: parsed.updatedAt || now,
        synopsis: existingChap?.synopsis,
        status: parsed.status,
      };
      importedChapters.push({
        chapter: chap,
        order: parsed.order !== 9999 ? parsed.order : i + 1,
        diskPath,
        mtimeMs: fileData.mtimeMs,
        body: parsed.body,
      });
    }

    importedChapters.sort((a, b) => a.order - b.order);

    // Replace existing chapter files cleanly
    for (const oldPath of existingChapterPaths) {
      await this.idbStore.deleteFile(oldPath);
    }

    const nextChapterOrder: string[] = [];
    const nextChapters: Chapter[] = [];
    for (let i = 0; i < importedChapters.length; i++) {
      const item = importedChapters[i];
      const idbPath = `Artifacts/chapter-${item.chapter.id}.md`;
      await this.idbStore.writeFile(`${prefix}${idbPath}`, item.body);
      nextChapterOrder.push(item.chapter.id);
      nextChapters.push(item.chapter);
      entries[idbPath] = {
        idbPath,
        diskPath: item.diskPath,
        baseHash: canonicalChapterHash(item.chapter.id, item.chapter.title, item.chapter.status, i + 1, item.body),
        baseIdbUpdatedAt: item.chapter.updatedAt,
        baseDiskMtimeMs: item.mtimeMs,
      };
      pulledPaths.push(idbPath);
    }

    if (nextChapterOrder.length > 0) {
      project = {
        ...project,
        chapterOrder: nextChapterOrder,
        chapters: nextChapters,
        activeChapterId: nextChapterOrder.includes(project.activeChapterId) ? project.activeChapterId : nextChapterOrder[0],
        updatedAt: now,
      };
    }

    await this.idbStore.writeFile(`${prefix}Project.json`, JSON.stringify(project));
    await this.updateProjectRegistryTitle(project);
    pulledPaths.push('Project.json');

    // 4. Import continuity/*.md
    const existingContPaths = await this.idbStore.listFiles(`${prefix}Continuity/`);
    for (const oldCont of existingContPaths) {
      await this.idbStore.deleteFile(oldCont);
    }
    const diskContPaths = await listDiskMarkdownFiles(handle, 'continuity');
    for (const diskPath of diskContPaths) {
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const baseName = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const parsed = diskMdToContinuity(fileData.content, baseName);
      const idbPath = `Continuity/chapter-${parsed.chapterId}.md`;
      await this.idbStore.writeFile(`${prefix}${idbPath}`, parsed.body);
      entries[idbPath] = {
        idbPath,
        diskPath,
        baseHash: canonicalContinuityHash(parsed.chapterId, parsed.title, parsed.order, parsed.body),
        baseIdbUpdatedAt: parsed.updatedAt,
        baseDiskMtimeMs: fileData.mtimeMs,
      };
      pulledPaths.push(idbPath);
    }

    // 5. Characters (merge .xnovelist/Characters.json + story-bible/characters/*.md)
    const diskCharsJson = await readDiskFile(handle, '.xnovelist/Characters.json');
    const baseChars = diskCharsJson ? CharactersSchema.parse(JSON.parse(diskCharsJson.content)).characters : [];
    const charById = new Map<string, Character>(baseChars.map((c) => [c.id, c]));
    const diskCharFiles = await listDiskMarkdownFiles(handle, 'story-bible/characters');
    for (const diskPath of diskCharFiles) {
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const slug = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const parsedMeta = parseFrontmatter(fileData.content).data;
      const charId = asString(parsedMeta.id, `char-${slug}`);
      const existing = charById.get(charId);
      const merged = diskMdToCharacter(fileData.content, existing, charId);
      charById.set(merged.id, merged);
      entries[`Bible/character-${merged.id}`] = {
        idbPath: `Bible/character-${merged.id}`,
        diskPath,
        baseHash: canonicalCharacterHash(merged),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: fileData.mtimeMs,
      };
    }
    const nextChars = { schemaVersion: 1 as const, characters: Array.from(charById.values()) };
    await this.idbStore.writeFile(`${prefix}Characters.json`, JSON.stringify(nextChars));
    pulledPaths.push('Characters.json');

    // 6. Locations
    const diskLocsJson = await readDiskFile(handle, '.xnovelist/Locations.json');
    const baseLocs = diskLocsJson ? LocationsSchema.parse(JSON.parse(diskLocsJson.content)).locations : [];
    const locById = new Map<string, Location>(baseLocs.map((l) => [l.id, l]));
    const diskLocFiles = await listDiskMarkdownFiles(handle, 'story-bible/locations');
    for (const diskPath of diskLocFiles) {
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const slug = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const parsedMeta = parseFrontmatter(fileData.content).data;
      const locId = asString(parsedMeta.id, `loc-${slug}`);
      const existing = locById.get(locId);
      const merged = diskMdToLocation(fileData.content, existing, locId);
      locById.set(merged.id, merged);
      entries[`Bible/location-${merged.id}`] = {
        idbPath: `Bible/location-${merged.id}`,
        diskPath,
        baseHash: canonicalLocationHash(merged),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: fileData.mtimeMs,
      };
    }
    const nextLocs = { schemaVersion: 1 as const, locations: Array.from(locById.values()) };
    await this.idbStore.writeFile(`${prefix}Locations.json`, JSON.stringify(nextLocs));
    pulledPaths.push('Locations.json');

    // 7. Items
    const diskItemsJson = await readDiskFile(handle, '.xnovelist/Items.json');
    const baseItems = diskItemsJson ? ItemsSchema.parse(JSON.parse(diskItemsJson.content)).items : [];
    const itemById = new Map<string, Item>(baseItems.map((it) => [it.id, it]));
    const diskItemFiles = await listDiskMarkdownFiles(handle, 'story-bible/items');
    for (const diskPath of diskItemFiles) {
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const slug = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const parsedMeta = parseFrontmatter(fileData.content).data;
      const itemId = asString(parsedMeta.id, `item-${slug}`);
      const existing = itemById.get(itemId);
      const merged = diskMdToItem(fileData.content, existing, itemId);
      itemById.set(merged.id, merged);
      entries[`Bible/item-${merged.id}`] = {
        idbPath: `Bible/item-${merged.id}`,
        diskPath,
        baseHash: canonicalItemHash(merged),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: fileData.mtimeMs,
      };
    }
    const nextItems = { schemaVersion: 1 as const, items: Array.from(itemById.values()) };
    await this.idbStore.writeFile(`${prefix}Items.json`, JSON.stringify(nextItems));
    pulledPaths.push('Items.json');

    // 8. Style
    const diskStyleJson = await readDiskFile(handle, '.xnovelist/Style.json');
    const diskStyleMd = await readDiskFile(handle, 'story-bible/style.md');
    let nextStyle: Style = diskStyleJson
      ? StyleSchema.parse(JSON.parse(diskStyleJson.content))
      : StyleSchema.parse({ schemaVersion: 1 });
    if (diskStyleMd) {
      nextStyle = diskMdToStyle(diskStyleMd.content, nextStyle);
      entries['Style.json'] = {
        idbPath: 'Style.json',
        diskPath: 'story-bible/style.md',
        baseHash: canonicalStyleHash(nextStyle),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: diskStyleMd.mtimeMs,
      };
    }
    await this.idbStore.writeFile(`${prefix}Style.json`, JSON.stringify(nextStyle));
    pulledPaths.push('Style.json');

    // 8b. World Rules (merge .xnovelist/WorldRules.json + story-bible/world-rules/*.md)
    const diskWorldRulesJson = await readDiskFile(handle, '.xnovelist/WorldRules.json');
    const baseWorldRules = diskWorldRulesJson
      ? WorldRulesSchema.parse(JSON.parse(diskWorldRulesJson.content)).rules
      : [];
    const ruleById = new Map<string, WorldRule>(baseWorldRules.map((r) => [r.id, r]));
    const diskRuleFiles = await listDiskMarkdownFiles(handle, 'story-bible/world-rules');
    for (const diskPath of diskRuleFiles) {
      const fileData = await readDiskFile(handle, diskPath);
      if (!fileData) continue;
      const slug = diskPath.split('/').pop()!.replace(/\.md$/i, '');
      const parsedMeta = parseFrontmatter(fileData.content).data;
      const ruleId = asString(parsedMeta.id, `rule-${slug}`);
      const existing = ruleById.get(ruleId);
      const merged = diskMdToWorldRule(fileData.content, existing, ruleId);
      ruleById.set(merged.id, merged);
      entries[`Bible/rule-${merged.id}`] = {
        idbPath: `Bible/rule-${merged.id}`,
        diskPath,
        baseHash: canonicalWorldRuleHash(merged),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: fileData.mtimeMs,
      };
    }
    const nextWorldRules = { schemaVersion: 1 as const, rules: Array.from(ruleById.values()) };
    await this.idbStore.writeFile(`${prefix}WorldRules.json`, JSON.stringify(nextWorldRules));
    pulledPaths.push('WorldRules.json');

    // 9. Beats / Corkboard sidecars if present
    const diskBeats = await readDiskFile(handle, '.xnovelist/Beats.json');
    if (diskBeats) {
      await this.idbStore.writeFile(`${prefix}Beats.json`, diskBeats.content);
      pulledPaths.push('Beats.json');
    }
    const diskCorkboard = await readDiskFile(handle, '.xnovelist/Corkboard.json');
    if (diskCorkboard) {
      let normalizedCork = diskCorkboard.content;
      try {
        const parsedCork = CorkboardSchema.safeParse(JSON.parse(diskCorkboard.content));
        if (parsedCork.success) {
          normalizedCork = JSON.stringify(parsedCork.data);
        }
      } catch {
        // keep raw content if malformed
      }
      await this.idbStore.writeFile(`${prefix}Corkboard.json`, normalizedCork);
      entries['Corkboard.json'] = {
        idbPath: 'Corkboard.json',
        diskPath: '.xnovelist/Corkboard.json',
        baseHash: canonicalCorkboardHash(normalizedCork),
        baseIdbUpdatedAt: now,
        baseDiskMtimeMs: diskCorkboard.mtimeMs,
      };
      pulledPaths.push('Corkboard.json');
    }

    const manifest: SyncManifest = {
      schemaVersion: 1,
      projectId,
      folderName: handle.name,
      lastSyncedAt: now,
      entries,
    };
    await this.writeManifest(handle, manifest);
    this.lastSyncedAt = now;
    this.emitConflicts([]);
    this.emitStatus('synced');

    await this.callbacks.onExternalSyncReload?.(pulledPaths);
    this.callbacks.onToast?.(`Synced ${pulledPaths.length} file(s) from disk folder`);

    return { pulledCount: pulledPaths.length, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths };
  }

  /**
   * Core 3-way reconciliation between IndexedDB state, Disk folder, and `.xnovelist/sync-manifest.json`.
   */
  private async runReconcile(projectId: string, handle: DirHandleExt): Promise<SyncResult> {
    this.emitStatus('syncing');

    try {
      const state = await this.loadIdbProjectState(projectId);
      if (!state) {
        this.emitStatus('error', 'Project metadata missing in IndexedDB.');
        return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
      }

      const manifest = await this.readManifest(projectId, handle);
      const now = new Date().toISOString();
      const nextEntries: Record<string, SyncManifestEntry> = { ...manifest.entries };
      const conflicts: SyncConflict[] = [];
      const pulledPaths: string[] = [];
      let pushedCount = 0;
      let deletedCount = 0;

      // Index existing disk files by frontmatter ID so renamed/reordered files still match
      const diskChaptersById = new Map<string, { diskPath: string; content: string; mtimeMs: number; parsed: ReturnType<typeof diskMdToChapter> }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'chapters')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const baseName = dp.split('/').pop()!.replace(/\.md$/i, '');
        const parsed = diskMdToChapter(f.content, `chapter-${slugifyFilename(baseName, 'ch')}`);
        diskChaptersById.set(parsed.id, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs, parsed });
      }

      const diskContById = new Map<string, { diskPath: string; content: string; mtimeMs: number; parsed: ReturnType<typeof diskMdToContinuity> }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'continuity')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const baseName = dp.split('/').pop()!.replace(/\.md$/i, '');
        const parsed = diskMdToContinuity(f.content, baseName);
        diskContById.set(parsed.chapterId, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs, parsed });
      }

      const diskCharsById = new Map<string, { diskPath: string; content: string; mtimeMs: number }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'story-bible/characters')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const fm = parseFrontmatter(f.content).data;
        const id = asString(fm.id, `char-${dp.split('/').pop()!.replace(/\.md$/i, '')}`);
        diskCharsById.set(id, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs });
      }

      const diskLocsById = new Map<string, { diskPath: string; content: string; mtimeMs: number }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'story-bible/locations')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const fm = parseFrontmatter(f.content).data;
        const id = asString(fm.id, `loc-${dp.split('/').pop()!.replace(/\.md$/i, '')}`);
        diskLocsById.set(id, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs });
      }

      const diskItemsById = new Map<string, { diskPath: string; content: string; mtimeMs: number }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'story-bible/items')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const fm = parseFrontmatter(f.content).data;
        const id = asString(fm.id, `item-${dp.split('/').pop()!.replace(/\.md$/i, '')}`);
        diskItemsById.set(id, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs });
      }

      const diskRulesById = new Map<string, { diskPath: string; content: string; mtimeMs: number }>();
      for (const dp of await listDiskMarkdownFiles(handle, 'story-bible/world-rules')) {
        const f = await readDiskFile(handle, dp);
        if (!f) continue;
        const fm = parseFrontmatter(f.content).data;
        const id = asString(fm.id, `rule-${dp.split('/').pop()!.replace(/\.md$/i, '')}`);
        diskRulesById.set(id, { diskPath: dp, content: f.content, mtimeMs: f.mtimeMs });
      }

      // Mutable copies of IDB state for any pulled updates
      const nextProject = { ...state.project, chapters: [...(state.project.chapters || [])], chapterOrder: [...state.project.chapterOrder] };
      let projectJsonChanged = false;
      const nextCharacters = [...state.characters.characters];
      let charactersChanged = false;
      const nextLocations = [...state.locations.locations];
      let locationsChanged = false;
      const nextItems = [...state.items.items];
      let itemsChanged = false;
      const nextWorldRules = [...state.worldRules.rules];
      let worldRulesChanged = false;
      let nextStyle = state.style;
      let styleChanged = false;

      const usedPaths = new Set<string>();

      // ---- 1. Reconcile Chapters -------------------------------------------
      const idbChapterIds = Array.from(
        new Set([...nextProject.chapterOrder, ...Object.keys(state.chaptersBody)])
      ).filter((cid) => state.chaptersBody[cid] !== undefined);

      const idbChapterSet = new Set(idbChapterIds);

      for (let i = 0; i < idbChapterIds.length; i++) {
        const cid = idbChapterIds[i];
        const order = i + 1;
        const idbPath = `Artifacts/chapter-${cid}.md`;
        const idbMd = state.chaptersBody[cid];
        const chapMeta = this.resolveChapterMeta(nextProject, cid, idbMd);
        const idbHash = canonicalChapterHash(cid, chapMeta.title, chapMeta.status, order, idbMd);
        const desiredDiskPath = this.allocateUniquePath(
          `chapters/${padOrder(order)}-${slugifyFilename(chapMeta.title, `chapter-${cid}`)}.md`,
          usedPaths,
          cid
        );

        const baseEntry = manifest.entries[idbPath];
        const diskMatch = diskChaptersById.get(cid);
        const diskHash = diskMatch
          ? canonicalChapterHash(
              diskMatch.parsed.id,
              diskMatch.parsed.title,
              diskMatch.parsed.status,
              diskMatch.parsed.order,
              diskMatch.parsed.body
            )
          : null;

        if (!baseEntry && !diskMatch) {
          // New chapter in IDB -> Push to disk
          const diskMd = chapterToDiskMd(chapMeta, order, idbMd);
          const mtimeMs = await writeDiskFile(handle, desiredDiskPath, diskMd);
          nextEntries[idbPath] = {
            idbPath,
            diskPath: desiredDiskPath,
            baseHash: idbHash,
            baseIdbUpdatedAt: chapMeta.updatedAt,
            baseDiskMtimeMs: mtimeMs,
          };
          pushedCount++;
        } else if (baseEntry && !diskMatch) {
          // Was synced previously, now deleted on disk
          if (idbHash === baseEntry.baseHash) {
            // Safe delete from IDB after snapshot
            await takeSnapshot(this.idbStore, cid, 'pre-delete', 'Removed on disk folder', undefined, projectId).catch(() => {});
            await this.idbStore.deleteFile(`${state.prefix}${idbPath}`);
            nextProject.chapterOrder = nextProject.chapterOrder.filter((id) => id !== cid);
            nextProject.chapters = nextProject.chapters.filter((c) => c.id !== cid);
            if (nextProject.activeChapterId === cid) {
              nextProject.activeChapterId = nextProject.chapterOrder[0] || '';
            }
            projectJsonChanged = true;
            delete nextEntries[idbPath];
            pulledPaths.push(idbPath);
            deletedCount++;
          } else {
            // IDB modified while disk deleted -> re-push IDB
            const diskMd = chapterToDiskMd(chapMeta, order, idbMd);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, diskMd);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: idbHash,
              baseIdbUpdatedAt: chapMeta.updatedAt,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else if (diskMatch && diskHash !== null) {
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || idbHash !== baseHash;
          const diskChanged = !baseHash || diskHash !== baseHash;

          if (!idbChanged && !diskChanged) {
            // Neither changed, ensure filename reflects any order/title rename cleanly
            if (diskMatch.diskPath !== desiredDiskPath) {
              const diskMd = chapterToDiskMd(chapMeta, order, idbMd);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, diskMd);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: idbHash,
                baseIdbUpdatedAt: chapMeta.updatedAt,
                baseDiskMtimeMs: mtimeMs,
              };
              pushedCount++;
            } else {
              usedPaths.add(diskMatch.diskPath);
            }
          } else if (idbHash === diskHash) {
            // Both converged to same content
            usedPaths.add(diskMatch.diskPath);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: idbHash,
              baseIdbUpdatedAt: chapMeta.updatedAt,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
          } else if (idbChanged && !diskChanged) {
            // IDB -> Disk
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const diskMd = chapterToDiskMd(chapMeta, order, idbMd);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, diskMd);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: idbHash,
              baseIdbUpdatedAt: chapMeta.updatedAt,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            // Disk -> IDB (auto snapshot first)
            await takeSnapshot(this.idbStore, cid, 'pre-import', 'Before disk sync import', undefined, projectId).catch(() => {});
            await this.idbStore.writeFile(`${state.prefix}${idbPath}`, diskMatch.parsed.body);

            const existingIdx = nextProject.chapters.findIndex((c) => c.id === cid);
            const updatedChap: Chapter = {
              id: cid,
              title: diskMatch.parsed.title,
              createdAt: chapMeta.createdAt,
              updatedAt: diskMatch.parsed.updatedAt || now,
              synopsis: chapMeta.synopsis,
              status: diskMatch.parsed.status,
            };
            if (existingIdx >= 0) {
              nextProject.chapters[existingIdx] = updatedChap;
            } else {
              nextProject.chapters.push(updatedChap);
            }
            projectJsonChanged = true;

            usedPaths.add(diskMatch.diskPath);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: diskHash,
              baseIdbUpdatedAt: updatedChap.updatedAt,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push(idbPath);
          } else {
            // Both changed -> conflict!
            usedPaths.add(diskMatch.diskPath);
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `Chapter: ${chapMeta.title}`,
              idbContent: chapterToDiskMd(chapMeta, order, idbMd),
              diskContent: diskMatch.content,
              idbUpdatedAt: chapMeta.updatedAt,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      // Chapters deleted from IDB (present in manifest, absent from IDB)
      for (const [entryPath, entry] of Object.entries(manifest.entries)) {
        if (!entryPath.startsWith('Artifacts/chapter-')) continue;
        const cid = entryPath.replace('Artifacts/chapter-', '').replace('.md', '');
        if (idbChapterSet.has(cid)) continue;

        const diskMatch = diskChaptersById.get(cid);
        if (diskMatch) {
          const diskHash = canonicalChapterHash(
            diskMatch.parsed.id,
            diskMatch.parsed.title,
            diskMatch.parsed.status,
            diskMatch.parsed.order,
            diskMatch.parsed.body
          );
          if (diskHash === entry.baseHash) {
            await deleteDiskFile(handle, diskMatch.diskPath);
            delete nextEntries[entryPath];
            deletedCount++;
          } else {
            // Edited on disk after IDB deletion -> import back to IDB
            await this.idbStore.writeFile(`${state.prefix}${entryPath}`, diskMatch.parsed.body);
            nextProject.chapterOrder.push(cid);
            nextProject.chapters.push({
              id: cid,
              title: diskMatch.parsed.title,
              createdAt: now,
              updatedAt: diskMatch.parsed.updatedAt || now,
              status: diskMatch.parsed.status,
            });
            projectJsonChanged = true;
            nextEntries[entryPath] = {
              idbPath: entryPath,
              diskPath: diskMatch.diskPath,
              baseHash: diskHash,
              baseIdbUpdatedAt: diskMatch.parsed.updatedAt || now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push(entryPath);
          }
        } else {
          delete nextEntries[entryPath];
        }
      }

      // Brand-new chapters created directly on disk (not in IDB and not in manifest)
      for (const [cid, diskMatch] of diskChaptersById.entries()) {
        if (idbChapterSet.has(cid)) continue;
        const idbPath = `Artifacts/chapter-${cid}.md`;
        if (manifest.entries[idbPath]) continue;

        await this.idbStore.writeFile(`${state.prefix}${idbPath}`, diskMatch.parsed.body);
        if (!nextProject.chapterOrder.includes(cid)) {
          nextProject.chapterOrder.push(cid);
        }
        nextProject.chapters.push({
          id: cid,
          title: diskMatch.parsed.title,
          createdAt: now,
          updatedAt: diskMatch.parsed.updatedAt || now,
          status: diskMatch.parsed.status,
        });
        projectJsonChanged = true;
        nextEntries[idbPath] = {
          idbPath,
          diskPath: diskMatch.diskPath,
          baseHash: canonicalChapterHash(
            diskMatch.parsed.id,
            diskMatch.parsed.title,
            diskMatch.parsed.status,
            diskMatch.parsed.order,
            diskMatch.parsed.body
          ),
          baseIdbUpdatedAt: diskMatch.parsed.updatedAt || now,
          baseDiskMtimeMs: diskMatch.mtimeMs,
        };
        pulledPaths.push(idbPath);
      }

      // ---- 2. Reconcile Continuity Docs ------------------------------------
      const effectiveOrder = nextProject.chapterOrder;
      const allContIds = Array.from(
        new Set([...Object.keys(state.continuityBody), ...Array.from(diskContById.keys())])
      );

      for (const cid of allContIds) {
        const idbPath = `Continuity/chapter-${cid}.md`;
        const idbBody = state.continuityBody[cid];
        const diskMatch = diskContById.get(cid);
        const orderIdx = Math.max(1, effectiveOrder.indexOf(cid) + 1);
        const chapMeta = nextProject.chapters.find((c) => c.id === cid);
        const title = chapMeta?.title || diskMatch?.parsed.title || `Chapter ${cid}`;
        const updatedAt = chapMeta?.updatedAt || now;
        const baseEntry = manifest.entries[idbPath];

        if (idbBody !== undefined && !diskMatch) {
          if (baseEntry && canonicalContinuityHash(cid, title, orderIdx, idbBody) === baseEntry.baseHash) {
            await this.idbStore.deleteFile(`${state.prefix}${idbPath}`);
            delete nextEntries[idbPath];
            pulledPaths.push(idbPath);
            deletedCount++;
          } else {
            const diskPath = this.allocateUniquePath(
              `continuity/${padOrder(orderIdx)}-${slugifyFilename(title, `chapter-${cid}`)}.md`,
              usedPaths,
              cid
            );
            const md = continuityToDiskMd(cid, title, orderIdx, updatedAt, idbBody);
            const mtimeMs = await writeDiskFile(handle, diskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: canonicalContinuityHash(cid, title, orderIdx, idbBody),
              baseIdbUpdatedAt: updatedAt,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else if (idbBody === undefined && diskMatch) {
          const dHash = canonicalContinuityHash(
            diskMatch.parsed.chapterId,
            diskMatch.parsed.title,
            diskMatch.parsed.order,
            diskMatch.parsed.body
          );
          if (baseEntry && dHash === baseEntry.baseHash) {
            await deleteDiskFile(handle, diskMatch.diskPath);
            delete nextEntries[idbPath];
            deletedCount++;
          } else {
            await this.idbStore.writeFile(`${state.prefix}${idbPath}`, diskMatch.parsed.body);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: diskMatch.parsed.updatedAt || now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push(idbPath);
          }
        } else if (idbBody !== undefined && diskMatch) {
          const iHash = canonicalContinuityHash(cid, title, orderIdx, idbBody);
          const dHash = canonicalContinuityHash(
            diskMatch.parsed.chapterId,
            diskMatch.parsed.title,
            diskMatch.parsed.order,
            diskMatch.parsed.body
          );
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;
          const desiredDiskPath = this.allocateUniquePath(
            `continuity/${padOrder(orderIdx)}-${slugifyFilename(title, `chapter-${cid}`)}.md`,
            usedPaths,
            cid
          );

          if (iHash === dHash) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              const md = continuityToDiskMd(cid, title, orderIdx, updatedAt, idbBody);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: iHash,
                baseIdbUpdatedAt: updatedAt,
                baseDiskMtimeMs: mtimeMs,
              };
            }
          } else if (idbChanged && !diskChanged) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const md = continuityToDiskMd(cid, title, orderIdx, updatedAt, idbBody);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: updatedAt,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            await this.idbStore.writeFile(`${state.prefix}${idbPath}`, diskMatch.parsed.body);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: diskMatch.parsed.updatedAt || now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push(idbPath);
          } else {
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `Continuity: ${title}`,
              idbContent: continuityToDiskMd(cid, title, orderIdx, updatedAt, idbBody),
              diskContent: diskMatch.content,
              idbUpdatedAt: updatedAt,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      // ---- 3. Reconcile Characters -----------------------------------------
      const idbCharIds = new Set(nextCharacters.map((c) => c.id));
      for (let i = 0; i < nextCharacters.length; i++) {
        const char = nextCharacters[i];
        const idbPath = `Bible/character-${char.id}`;
        const iHash = canonicalCharacterHash(char);
        const baseEntry = manifest.entries[idbPath];
        const diskMatch = diskCharsById.get(char.id);
        const desiredDiskPath = this.allocateUniquePath(
          `story-bible/characters/${slugifyFilename(char.name, char.id)}.md`,
          usedPaths,
          char.id
        );

        if (!diskMatch) {
          if (baseEntry && iHash === baseEntry.baseHash) {
            nextCharacters.splice(i, 1);
            i--;
            charactersChanged = true;
            delete nextEntries[idbPath];
            pulledPaths.push('Characters.json');
            deletedCount++;
          } else {
            const md = characterToDiskMd(char);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else {
          const parsedDiskChar = diskMdToCharacter(diskMatch.content, char, char.id);
          const dHash = canonicalCharacterHash(parsedDiskChar);
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              const md = characterToDiskMd(char);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: iHash,
                baseIdbUpdatedAt: now,
                baseDiskMtimeMs: mtimeMs,
              };
            }
          } else if (idbChanged && !diskChanged) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const md = characterToDiskMd(char);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            nextCharacters[i] = parsedDiskChar;
            charactersChanged = true;
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push('Characters.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `Character: ${char.name}`,
              idbContent: characterToDiskMd(char),
              diskContent: diskMatch.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      // New or deleted characters from disk/IDB
      for (const [charId, diskMatch] of diskCharsById.entries()) {
        if (idbCharIds.has(charId)) continue;
        const idbPath = `Bible/character-${charId}`;
        const parsed = diskMdToCharacter(diskMatch.content, undefined, charId);
        const dHash = canonicalCharacterHash(parsed);
        const baseEntry = manifest.entries[idbPath];

        if (baseEntry && dHash === baseEntry.baseHash) {
          await deleteDiskFile(handle, diskMatch.diskPath);
          delete nextEntries[idbPath];
          deletedCount++;
        } else {
          nextCharacters.push(parsed);
          charactersChanged = true;
          nextEntries[idbPath] = {
            idbPath,
            diskPath: diskMatch.diskPath,
            baseHash: dHash,
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: diskMatch.mtimeMs,
          };
          pulledPaths.push('Characters.json');
        }
      }

      // ---- 4. Reconcile Locations ------------------------------------------
      const idbLocIds = new Set(nextLocations.map((l) => l.id));
      for (let i = 0; i < nextLocations.length; i++) {
        const loc = nextLocations[i];
        const idbPath = `Bible/location-${loc.id}`;
        const iHash = canonicalLocationHash(loc);
        const baseEntry = manifest.entries[idbPath];
        const diskMatch = diskLocsById.get(loc.id);
        const desiredDiskPath = this.allocateUniquePath(
          `story-bible/locations/${slugifyFilename(loc.name, loc.id)}.md`,
          usedPaths,
          loc.id
        );

        if (!diskMatch) {
          if (baseEntry && iHash === baseEntry.baseHash) {
            nextLocations.splice(i, 1);
            i--;
            locationsChanged = true;
            delete nextEntries[idbPath];
            pulledPaths.push('Locations.json');
            deletedCount++;
          } else {
            const md = locationToDiskMd(loc);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else {
          const parsedDiskLoc = diskMdToLocation(diskMatch.content, loc, loc.id);
          const dHash = canonicalLocationHash(parsedDiskLoc);
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              const md = locationToDiskMd(loc);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: iHash,
                baseIdbUpdatedAt: now,
                baseDiskMtimeMs: mtimeMs,
              };
            }
          } else if (idbChanged && !diskChanged) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const md = locationToDiskMd(loc);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            nextLocations[i] = parsedDiskLoc;
            locationsChanged = true;
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push('Locations.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `Location: ${loc.name}`,
              idbContent: locationToDiskMd(loc),
              diskContent: diskMatch.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      for (const [locId, diskMatch] of diskLocsById.entries()) {
        if (idbLocIds.has(locId)) continue;
        const idbPath = `Bible/location-${locId}`;
        const parsed = diskMdToLocation(diskMatch.content, undefined, locId);
        const dHash = canonicalLocationHash(parsed);
        const baseEntry = manifest.entries[idbPath];

        if (baseEntry && dHash === baseEntry.baseHash) {
          await deleteDiskFile(handle, diskMatch.diskPath);
          delete nextEntries[idbPath];
          deletedCount++;
        } else {
          nextLocations.push(parsed);
          locationsChanged = true;
          nextEntries[idbPath] = {
            idbPath,
            diskPath: diskMatch.diskPath,
            baseHash: dHash,
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: diskMatch.mtimeMs,
          };
          pulledPaths.push('Locations.json');
        }
      }

      // ---- 5. Reconcile Items ----------------------------------------------
      const idbItemIds = new Set(nextItems.map((it) => it.id));
      for (let i = 0; i < nextItems.length; i++) {
        const item = nextItems[i];
        const idbPath = `Bible/item-${item.id}`;
        const iHash = canonicalItemHash(item);
        const baseEntry = manifest.entries[idbPath];
        const diskMatch = diskItemsById.get(item.id);
        const desiredDiskPath = this.allocateUniquePath(
          `story-bible/items/${slugifyFilename(item.name, item.id)}.md`,
          usedPaths,
          item.id
        );

        if (!diskMatch) {
          if (baseEntry && iHash === baseEntry.baseHash) {
            nextItems.splice(i, 1);
            i--;
            itemsChanged = true;
            delete nextEntries[idbPath];
            pulledPaths.push('Items.json');
            deletedCount++;
          } else {
            const md = itemToDiskMd(item);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else {
          const parsedDiskItem = diskMdToItem(diskMatch.content, item, item.id);
          const dHash = canonicalItemHash(parsedDiskItem);
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              const md = itemToDiskMd(item);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: iHash,
                baseIdbUpdatedAt: now,
                baseDiskMtimeMs: mtimeMs,
              };
            }
          } else if (idbChanged && !diskChanged) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const md = itemToDiskMd(item);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            nextItems[i] = parsedDiskItem;
            itemsChanged = true;
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push('Items.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `Item: ${item.name}`,
              idbContent: itemToDiskMd(item),
              diskContent: diskMatch.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      for (const [itemId, diskMatch] of diskItemsById.entries()) {
        if (idbItemIds.has(itemId)) continue;
        const idbPath = `Bible/item-${itemId}`;
        const parsed = diskMdToItem(diskMatch.content, undefined, itemId);
        const dHash = canonicalItemHash(parsed);
        const baseEntry = manifest.entries[idbPath];

        if (baseEntry && dHash === baseEntry.baseHash) {
          await deleteDiskFile(handle, diskMatch.diskPath);
          delete nextEntries[idbPath];
          deletedCount++;
        } else {
          nextItems.push(parsed);
          itemsChanged = true;
          nextEntries[idbPath] = {
            idbPath,
            diskPath: diskMatch.diskPath,
            baseHash: dHash,
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: diskMatch.mtimeMs,
          };
          pulledPaths.push('Items.json');
        }
      }

      // ---- 5b. Reconcile World Rules ---------------------------------------
      const idbRuleIds = new Set(nextWorldRules.map((r) => r.id));
      for (let i = 0; i < nextWorldRules.length; i++) {
        const rule = nextWorldRules[i];
        const idbPath = `Bible/rule-${rule.id}`;
        const iHash = canonicalWorldRuleHash(rule);
        const baseEntry = manifest.entries[idbPath];
        const diskMatch = diskRulesById.get(rule.id);
        const desiredDiskPath = this.allocateUniquePath(
          `story-bible/world-rules/${slugifyFilename(rule.title, rule.id)}.md`,
          usedPaths,
          rule.id
        );

        if (!diskMatch) {
          if (baseEntry && iHash === baseEntry.baseHash) {
            nextWorldRules.splice(i, 1);
            i--;
            worldRulesChanged = true;
            delete nextEntries[idbPath];
            pulledPaths.push('WorldRules.json');
            deletedCount++;
          } else {
            const md = worldRuleToDiskMd(rule);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          }
        } else {
          const parsedDiskRule = diskMdToWorldRule(diskMatch.content, rule, rule.id);
          const dHash = canonicalWorldRuleHash(parsedDiskRule);
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              const md = worldRuleToDiskMd(rule);
              const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
              await deleteDiskFile(handle, diskMatch.diskPath);
              nextEntries[idbPath] = {
                idbPath,
                diskPath: desiredDiskPath,
                baseHash: iHash,
                baseIdbUpdatedAt: now,
                baseDiskMtimeMs: mtimeMs,
              };
            }
          } else if (idbChanged && !diskChanged) {
            if (diskMatch.diskPath !== desiredDiskPath) {
              await deleteDiskFile(handle, diskMatch.diskPath);
            }
            const md = worldRuleToDiskMd(rule);
            const mtimeMs = await writeDiskFile(handle, desiredDiskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath: desiredDiskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            nextWorldRules[i] = parsedDiskRule;
            worldRulesChanged = true;
            nextEntries[idbPath] = {
              idbPath,
              diskPath: diskMatch.diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskMatch.mtimeMs,
            };
            pulledPaths.push('WorldRules.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath: diskMatch.diskPath,
              label: `World Rule: ${rule.title}`,
              idbContent: worldRuleToDiskMd(rule),
              diskContent: diskMatch.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskMatch.mtimeMs,
            });
          }
        }
      }

      for (const [ruleId, diskMatch] of diskRulesById.entries()) {
        if (idbRuleIds.has(ruleId)) continue;
        const idbPath = `Bible/rule-${ruleId}`;
        const parsed = diskMdToWorldRule(diskMatch.content, undefined, ruleId);
        const dHash = canonicalWorldRuleHash(parsed);
        const baseEntry = manifest.entries[idbPath];

        if (baseEntry && dHash === baseEntry.baseHash) {
          await deleteDiskFile(handle, diskMatch.diskPath);
          delete nextEntries[idbPath];
          deletedCount++;
        } else {
          nextWorldRules.push(parsed);
          worldRulesChanged = true;
          nextEntries[idbPath] = {
            idbPath,
            diskPath: diskMatch.diskPath,
            baseHash: dHash,
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: diskMatch.mtimeMs,
          };
          pulledPaths.push('WorldRules.json');
        }
      }

      // ---- 6. Reconcile Style Profile --------------------------------------
      {
        const idbPath = 'Style.json';
        const diskPath = 'story-bible/style.md';
        const iHash = canonicalStyleHash(state.style);
        const diskStyleFile = await readDiskFile(handle, diskPath);
        const baseEntry = manifest.entries[idbPath];

        if (!diskStyleFile) {
          const md = styleToDiskMd(state.style);
          const mtimeMs = await writeDiskFile(handle, diskPath, md);
          nextEntries[idbPath] = {
            idbPath,
            diskPath,
            baseHash: iHash,
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: mtimeMs,
          };
          pushedCount++;
        } else {
          const parsedDiskStyle = diskMdToStyle(diskStyleFile.content, state.style);
          const dHash = canonicalStyleHash(parsedDiskStyle);
          const baseHash = baseEntry?.baseHash;
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskStyleFile.mtimeMs,
            };
          } else if (idbChanged && !diskChanged) {
            const md = styleToDiskMd(state.style);
            const mtimeMs = await writeDiskFile(handle, diskPath, md);
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            nextStyle = parsedDiskStyle;
            styleChanged = true;
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskStyleFile.mtimeMs,
            };
            pulledPaths.push('Style.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath,
              label: 'Story Bible: Style Profile',
              idbContent: styleToDiskMd(state.style),
              diskContent: diskStyleFile.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskStyleFile.mtimeMs,
            });
          }
        }
      }

      // ---- 7. Persist Merged IDB Updates & Lossless .xnovelist Mirrors -----
      if (projectJsonChanged) {
        await this.idbStore.writeFile(`${state.prefix}Project.json`, JSON.stringify(nextProject));
        await this.updateProjectRegistryTitle(nextProject);
        pulledPaths.push('Project.json');
      }
      if (charactersChanged) {
        await this.idbStore.writeFile(
          `${state.prefix}Characters.json`,
          JSON.stringify({ schemaVersion: 1, characters: nextCharacters })
        );
      }
      if (locationsChanged) {
        await this.idbStore.writeFile(
          `${state.prefix}Locations.json`,
          JSON.stringify({ schemaVersion: 1, locations: nextLocations })
        );
      }
      if (itemsChanged) {
        await this.idbStore.writeFile(
          `${state.prefix}Items.json`,
          JSON.stringify({ schemaVersion: 1, items: nextItems })
        );
      }
      if (worldRulesChanged) {
        await this.idbStore.writeFile(
          `${state.prefix}WorldRules.json`,
          JSON.stringify({ schemaVersion: 1, rules: nextWorldRules })
        );
      }
      if (styleChanged) {
        await this.idbStore.writeFile(`${state.prefix}Style.json`, JSON.stringify(nextStyle));
      }

      // Refresh .xnovelist/*.json mirrors from latest IDB state
      await writeDiskFile(handle, '.xnovelist/Project.json', JSON.stringify(nextProject, null, 2));
      await writeDiskFile(
        handle,
        '.xnovelist/Characters.json',
        JSON.stringify({ schemaVersion: 1, characters: nextCharacters }, null, 2)
      );
      await writeDiskFile(
        handle,
        '.xnovelist/Locations.json',
        JSON.stringify({ schemaVersion: 1, locations: nextLocations }, null, 2)
      );
      await writeDiskFile(
        handle,
        '.xnovelist/Items.json',
        JSON.stringify({ schemaVersion: 1, items: nextItems }, null, 2)
      );
      await writeDiskFile(
        handle,
        '.xnovelist/WorldRules.json',
        JSON.stringify({ schemaVersion: 1, rules: nextWorldRules }, null, 2)
      );
      await writeDiskFile(handle, '.xnovelist/Style.json', JSON.stringify(nextStyle, null, 2));

      if (state.beatsStr) {
        await writeDiskFile(handle, '.xnovelist/Beats.json', state.beatsStr);
      }

      // ---- 8. Reconcile Corkboard (.xnovelist/Corkboard.json) ----------------
      {
        const idbPath = 'Corkboard.json';
        const diskPath = '.xnovelist/Corkboard.json';
        const diskCorkFile = await readDiskFile(handle, diskPath);
        const baseHash = manifest.entries[idbPath]?.baseHash;

        if (state.corkboardStr && !diskCorkFile) {
          const mtimeMs = await writeDiskFile(handle, diskPath, formatCorkboardForDisk(state.corkboardStr));
          nextEntries[idbPath] = {
            idbPath,
            diskPath,
            baseHash: canonicalCorkboardHash(state.corkboardStr),
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: mtimeMs,
          };
          pushedCount++;
        } else if (!state.corkboardStr && diskCorkFile) {
          let normalized = diskCorkFile.content;
          try {
            const parsed = CorkboardSchema.safeParse(JSON.parse(diskCorkFile.content));
            if (parsed.success) normalized = JSON.stringify(parsed.data);
          } catch {
            // ignore
          }
          await this.idbStore.writeFile(`${state.prefix}Corkboard.json`, normalized);
          nextEntries[idbPath] = {
            idbPath,
            diskPath,
            baseHash: canonicalCorkboardHash(normalized),
            baseIdbUpdatedAt: now,
            baseDiskMtimeMs: diskCorkFile.mtimeMs,
          };
          pulledPaths.push('Corkboard.json');
        } else if (state.corkboardStr && diskCorkFile) {
          const iHash = canonicalCorkboardHash(state.corkboardStr);
          const dHash = canonicalCorkboardHash(diskCorkFile.content);
          const idbChanged = !baseHash || iHash !== baseHash;
          const diskChanged = !baseHash || dHash !== baseHash;

          if (iHash === dHash) {
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskCorkFile.mtimeMs,
            };
          } else if (idbChanged && !diskChanged) {
            const mtimeMs = await writeDiskFile(handle, diskPath, formatCorkboardForDisk(state.corkboardStr));
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: iHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: mtimeMs,
            };
            pushedCount++;
          } else if (!idbChanged && diskChanged) {
            let normalized = diskCorkFile.content;
            try {
              const parsed = CorkboardSchema.safeParse(JSON.parse(diskCorkFile.content));
              if (parsed.success) normalized = JSON.stringify(parsed.data);
            } catch {
              // ignore
            }
            await this.idbStore.writeFile(`${state.prefix}Corkboard.json`, normalized);
            nextEntries[idbPath] = {
              idbPath,
              diskPath,
              baseHash: dHash,
              baseIdbUpdatedAt: now,
              baseDiskMtimeMs: diskCorkFile.mtimeMs,
            };
            pulledPaths.push('Corkboard.json');
          } else {
            conflicts.push({
              idbPath,
              diskPath,
              label: 'Brainstorming Corkboard',
              idbContent: formatCorkboardForDisk(state.corkboardStr),
              diskContent: diskCorkFile.content,
              idbUpdatedAt: now,
              diskMtimeMs: diskCorkFile.mtimeMs,
            });
          }
        }
      }

      const nextManifest: SyncManifest = {
        schemaVersion: 1,
        projectId,
        folderName: handle.name,
        lastSyncedAt: now,
        entries: nextEntries,
      };
      await this.writeManifest(handle, nextManifest);
      this.lastSyncedAt = now;

      this.emitConflicts(conflicts);
      this.emitStatus(conflicts.length > 0 ? 'conflict' : 'synced');

      if (pulledPaths.length > 0) {
        await this.callbacks.onExternalSyncReload?.(Array.from(new Set(pulledPaths)));
        this.callbacks.onToast?.(`Synced ${Array.from(new Set(pulledPaths)).length} file(s) from disk folder`);
      }

      return {
        pulledCount: Array.from(new Set(pulledPaths)).length,
        pushedCount,
        deletedCount,
        conflicts,
        pulledPaths: Array.from(new Set(pulledPaths)),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Folder sync failed';
      this.emitStatus('error', msg);
      return { pulledCount: 0, pushedCount: 0, deletedCount: 0, conflicts: [], pulledPaths: [] };
    }
  }
}
