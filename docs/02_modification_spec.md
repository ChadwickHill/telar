# xnovelist Modification & Extension Specification

**Target Codebase:** `giapnguyen74/xnovelist` (audited in `docs/01_architecture_audit.md`)  
**Spec Date:** 2026-11-16  
**Status:** Execution Contract — Ready for Milestone-by-Milestone Implementation  

---

## 1. Architectural Guardrails (Non-Negotiables)

1. **Zero-Backend, Pure Client-Side Execution:**
   - Do **not** add Next.js API routes (`app/api/*`), server actions, proxies, or cloud databases.
   - All LLM calls remain browser-direct (`fetch()` in `src/ai/llm/client.ts` and `src/engine/testConnection.ts`) to OpenAI, Anthropic (`anthropic-dangerous-direct-browser-access`), OpenRouter, or user-configured `localhost` OpenAI-compatible servers (Ollama, LM Studio, llama.cpp).
   - API keys remain strictly inside IndexedDB (`workspace/ai.json`) and are **never** written to disk sync folders or JSON backups.
2. **IndexedDB First & Universal Fallback:**
   - `IndexedDBProjectStorage` (`xnovelist` DB) remains the primary, always-available persistence engine.
   - All new features (Corkboard, World Rules, Continuity Matrix) must work identically with zero local folder linked—preserving `file://` static bundles, Safari/Firefox, mobile browsers, and offline usage.
   - Browser File System Access API (`window.showDirectoryPicker`) must be feature-detected (`typeof window !== 'undefined' && 'showDirectoryPicker' in window`) and fail gracefully into read/write IndexedDB-only mode when unavailable or ungranted.
3. **Zero Unnecessary Dependencies & Strict TypeScript:**
   - Implement the YAML frontmatter parser/serializer, slugifier, LCS/line diff helper, and spatial SVG+HTML pan/zoom corkboard in pure TypeScript (`tsconfig.json` `strict: true`) without adding external runtime packages.
   - All UI icons must come from `lucide-react`; all user-facing strings must be added to `src/i18n/ui/en.json` and `src/i18n/ui/vi.json` and accessed via `t(...)`.
   - Every milestone must leave `npx tsc --noEmit`, `npm run lint`, and `npm run build` passing with 0 errors and 0 new warnings.

---

## 2. Exact Data Schemas & File Contracts

### 2.1 Updated Zod Schemas & TypeScript Interfaces (`src/storage/schemas.ts`)

Append the following schemas and exported types to `src/storage/schemas.ts` without breaking any existing `ProjectSchema`, `CharacterSchema`, `LocationSchema`, `ItemSchema`, `StyleSchema`, or `SnapshotSchema` fields:

```typescript
// ---- World Rules & Physics (Milestone 3) -----------------------------------

export const WorldRuleCategorySchema = z.enum([
  'orbital-propulsion',
  'thermodynamics',
  'comms-latency',
  'biology-life-support',
  'society-tech',
  'other',
]);
export type WorldRuleCategory = z.infer<typeof WorldRuleCategorySchema>;

export const WorldRuleSeveritySchema = z.enum(['hard', 'soft']);
export type WorldRuleSeverity = z.infer<typeof WorldRuleSeveritySchema>;

export const WorldRuleSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: WorldRuleCategorySchema.default('other'),
  severity: WorldRuleSeveritySchema.default('hard'),
  statement: z.string().default(''),
  exceptions: z.string().optional(),
  alwaysActive: z.boolean().default(true),
  keywords: z.array(z.string()).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  color: z.string().optional(),
});
export type WorldRule = z.infer<typeof WorldRuleSchema>;

export const WorldRulesSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(WorldRuleSchema).default([]),
});
export type WorldRules = z.infer<typeof WorldRulesSchema>;

// ---- Spatial Brainstorming Corkboard (Milestone 2) -------------------------

export const BrainstormCardTypeSchema = z.enum([
  'idea',
  'scene',
  'character',
  'location',
  'world-rule',
  'plot-thread',
]);
export type BrainstormCardType = z.infer<typeof BrainstormCardTypeSchema>;

export const PromotedRefSchema = z.object({
  kind: z.enum(['chapter', 'character', 'location', 'item', 'world-rule']),
  id: z.string(),
  label: z.string().optional(),
  promotedAt: z.string(),
});
export type PromotedRef = z.infer<typeof PromotedRefSchema>;

export const BrainstormCardSchema = z.object({
  id: z.string(),
  type: BrainstormCardTypeSchema.default('idea'),
  title: z.string(),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  color: z.string().optional(),
  image: z.string().optional(), // compressed WebP/PNG data URL (same pattern as coverImage/avatar)
  x: z.number(),
  y: z.number(),
  width: z.number().default(240),
  promotedRef: PromotedRefSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BrainstormCard = z.infer<typeof BrainstormCardSchema>;

export const BrainstormLinkSchema = z.object({
  id: z.string(),
  fromCardId: z.string(),
  toCardId: z.string(),
  label: z.string().default(''),
});
export type BrainstormLink = z.infer<typeof BrainstormLinkSchema>;

export const CorkboardSchema = z.object({
  schemaVersion: z.literal(1),
  viewport: z.object({
    panX: z.number().default(0),
    panY: z.number().default(0),
    zoom: z.number().min(0.25).max(2.5).default(1),
  }).default({ panX: 0, panY: 0, zoom: 1 }),
  cards: z.array(BrainstormCardSchema).default([]),
  links: z.array(BrainstormLinkSchema).default([]),
});
export type Corkboard = z.infer<typeof CorkboardSchema>;

// ---- Local Folder Sync Manifest (Milestone 1) ------------------------------

export const SyncManifestEntrySchema = z.object({
  /** Virtual IndexedDB path relative to `projects/{projectId}/` (e.g. `Artifacts/chapter-chapter-1.md`). */
  idbPath: z.string(),
  /** Disk path relative to the linked project folder root (e.g. `chapters/01-chapter-1.md`). */
  diskPath: z.string(),
  /** Hash of the content at last completed sync. */
  baseHash: z.string(),
  /** ISO timestamp from IDB / project metadata at last completed sync. */
  baseIdbUpdatedAt: z.string(),
  /** File.lastModified (epoch ms) on disk at last completed sync. */
  baseDiskMtimeMs: z.number(),
});
export type SyncManifestEntry = z.infer<typeof SyncManifestEntrySchema>;

export const SyncManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string(),
  folderName: z.string(),
  lastSyncedAt: z.string(),
  entries: z.record(z.string(), SyncManifestEntrySchema).default({}), // keyed by idbPath
});
export type SyncManifest = z.infer<typeof SyncManifestSchema>;
```

Additional runtime-only sync types (in `src/storage/diskSync.ts`):
```typescript
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
```

### 2.2 Local Disk Folder Directory Tree (Per Linked Novel)

A user links a dedicated local directory **per novel** (e.g., `~/Writing/Orbital-Winter/`). Inside that directory:

```text
<linked-novel-folder>/
├── chapters/
│   ├── 01-the-drift.md                 # YAML frontmatter + Markdown prose (preserves :::beat{id})
│   └── 02-perihelion-burn.md
├── continuity/
│   ├── 01-the-drift.md                 # YAML frontmatter + Continuity Markdown sections
│   └── 02-perihelion-burn.md
├── story-bible/
│   ├── characters/
│   │   └── elena-vance.md              # YAML frontmatter + Notes/Appearance Markdown
│   ├── locations/
│   │   └── station-ceres-4.md
│   ├── items/
│   │   └── epstein-injector.md
│   ├── world-rules/
│   │   └── light-lag-comms.md
│   └── style.md                        # YAML frontmatter (registers/lists) + rhythm/dialogue notes
└── .xnovelist/
    ├── Project.json                    # Lossless ProjectSchema mirror
    ├── Characters.json                 # Lossless CharactersSchema mirror
    ├── Locations.json                  # Lossless LocationsSchema mirror
    ├── Items.json                      # Lossless ItemsSchema mirror
    ├── WorldRules.json                 # Lossless WorldRulesSchema mirror
    ├── Style.json                      # Lossless StyleSchema mirror
    ├── Beats.json                      # Lossless Record<string, BeatData> mirror
    ├── Corkboard.json                  # Lossless CorkboardSchema mirror
    └── sync-manifest.json              # Baseline hashes + mtimes for 2-way reconciliation
```

**Strict Exclusions:**
- `workspace/ai.json` (API keys / provider settings) is **never** written to or read from the disk folder.
- `.history/` snapshot archives remain **IndexedDB-only** (disk sync creates `'pre-import'` snapshots inside IDB when pulling disk edits, keeping the user's writing folder clean).

### 2.3 YAML Frontmatter & Markdown Body Contracts

All synced `.md` files use standard `---` delimited YAML frontmatter implemented by `src/storage/frontmatter.ts` (supporting scalars: strings, numbers, booleans, inline/block string arrays, and nested objects for `relationships` / `evidence` / `style` registers).

1. **Chapter Manuscript (`chapters/{NN}-{slug}.md`):**
   - `NN`: 2-digit 1-based index from `project.chapterOrder` (e.g., `01`, `02`), `{slug}` derived from chapter title (fallback `chapter-{id}`).
   - **Frontmatter:**
     ```yaml
     ---
     id: "chapter-1"
     title: "The Drift"
     status: "draft"
     order: 1
     updatedAt: "2026-11-16T18:00:00.000Z"
     ---
     ```
   - **Body:** Raw chapter Markdown (`# Title\n\n...`), **preserving `:::beat{beatId}` tokens inline** on their own lines so beats round-trip losslessly alongside `.xnovelist/Beats.json`.
   - **IDB Mapping:** IndexedDB key remains `projects/{projectId}/Artifacts/chapter-{id}.md`. If a user renames a chapter or reorders `chapterOrder`, the disk sync deletes the stale `chapters/{old}.md` file and writes `chapters/{new}.md` using `sync-manifest.json`'s `diskPath` tracking.

2. **Continuity Document (`continuity/{NN}-{slug}.md`):**
   - **Frontmatter:**
     ```yaml
     ---
     chapterId: "chapter-1"
     title: "The Drift"
     order: 1
     updatedAt: "2026-11-16T18:00:00.000Z"
     ---
     ```
   - **Body:** The Continuity Markdown document (`# Continuity: Chapter 1 — ...`, `## Synopsis`, etc.).

3. **Character (`story-bible/characters/{slug}.md`):**
   - **Frontmatter:** `id`, `name`, `aliases`, `role`, `age`, `traits`, `desires`, `fears`, `speechPatterns`, `relationships`, `color`. (`avatar` base64 and `evidence` are preserved in `.xnovelist/Characters.json`; `evidence` may also be included as a compact array or synced via the JSON mirror).
   - **Body:** `## Appearance\n\n{appearance}\n\n## Notes\n\n{notes}`.

4. **Location (`story-bible/locations/{slug}.md`):**
   - **Frontmatter:** `id`, `name`, `aliases`, `scale`, `descriptors`, `inhabitants`, `color`.
   - **Body:** `## Significance\n\n{significance}\n\n## Notes\n\n{notes}`.

5. **Item (`story-bible/items/{slug}.md`):**
   - **Frontmatter:** `id`, `name`, `aliases`, `color`.
   - **Body:** `## Description\n\n{description}\n\n## Significance\n\n{significance}\n\n## Notes\n\n{notes}`.

6. **World Rule (`story-bible/world-rules/{slug}.md`):**
   - **Frontmatter:** `id`, `title`, `category`, `severity`, `alwaysActive`, `keywords`, `color`.
   - **Body:** `## Statement\n\n{statement}\n\n## Exceptions\n\n{exceptions}`.

7. **Style Profile (`story-bible/style.md`):**
   - **Frontmatter:** `schemaVersion`, `narrativeRegister` (`pointOfView`, `tense`, `interiority`), `diction` (`register`, `formality`, `favoredWords`, `avoidedWords`), `sensoryPalette` (`dominantSenses`), `pronounPairs`.
   - **Body:** Markdown sections for `## Rhythm`, `## Dialogue`, and `## Sensory Notes`.

### 2.4 Two-Way Reconciliation State Machine (`SyncingProjectStorage` + `DiskFolderSync`)

1. **IDB Handle Store (`IndexedDBProjectStorage.ts`):**
   - Bump `DB_NAME = 'xnovelist'` from version `1` to `2` in `openDB(DB_NAME, 2, { upgrade(...) })`, adding a second object store `'handles'` (alongside existing `'files'`) to store `{ dirHandle: FileSystemDirectoryHandle, folderName: string }` keyed by `projectId`.
2. **Write-Through Decorator (`SyncingProjectStorage implements ProjectStorage`):**
   - Wraps `IndexedDBProjectStorage` and exposes `ProjectStorage` unchanged to all callers (`src/app/page.tsx`, `snapshots.ts`, `ai/writeOps/*`, `ExportImportDialog.tsx`).
   - Intercepts `writeFile(path, content)` and `deleteFile(path)`:
     - Immediately executes on `IndexedDBProjectStorage` (zero keystroke latency).
     - If `path` belongs to the active linked `projects/{projectId}/...` and is not `.history/` or `workspace/ai.json`, enqueues `path` into a debounced (`800ms`) disk-flush queue.
3. **Reconciliation Algorithm (Triggered on project open, manual "Sync Now", window focus, or disk poll):**
   - Verifies `handle.queryPermission({ mode: 'readwrite' }) === 'granted'`. If `'prompt'`, sets status `'needs-permission'` and exposes a one-click **"Reconnect Folder"** button in the header/settings (since `requestPermission` requires a user gesture).
   - Builds the current virtual snapshot of IDB project files and scans disk (`chapters/`, `continuity/`, `story-bible/`, `.xnovelist/`).
   - For each tracked entity/file, compares `idbHash` and `diskHash` against `sync-manifest.json`'s `baseHash`:
     - **Both hashes === `baseHash`:** No-op.
     - **`idbHash !== baseHash` and `diskHash === baseHash`:** Push IDB → Disk (write `.md` + `.xnovelist/*.json`), update `sync-manifest.json`.
     - **`idbHash === baseHash` and `diskHash !== baseHash`:** Pull Disk → IDB:
       1. For any chapter markdown modified on disk, **first** call `takeSnapshot(idbStore, chapterId, 'pre-import', 'Before disk sync import', undefined, projectId)`.
       2. Parse disk `.md` frontmatter/body (or `.xnovelist/*.json` if the JSON mirror changed without a matching `.md` edit; if a user edited `.md` directly in an external editor, `.md` fields take precedence and regenerate the corresponding `.xnovelist/*.json` entry).
       3. Write updated files to IDB, update `sync-manifest.json`, invoke `onExternalSyncReload(changedPaths)` to refresh React state in `src/app/page.tsx`, and display a non-blocking toast (`"Synced N file(s) from disk folder"`).
     - **`idbHash !== baseHash` and `diskHash !== baseHash`:** Pause auto-sync for that path, set status `'conflict'`, and queue `SyncConflict` for the `SyncConflictModal` (`Keep My Version (Push to Disk)` | `Use Disk Version (Snapshot IDB & Pull)`).
   - On **first folder link** to a non-empty folder vs. empty folder:
     - If disk folder has no `.xnovelist/sync-manifest.json` and no `.md` files → Initial Push (IDB → Disk).
     - If disk folder already contains an `.xnovelist/Project.json` or `chapters/*.md` → Prompt user: `"Push current browser novel to folder"` vs. `"Import folder contents into browser (snapshots taken first)"`.

---

## 3. Milestone-by-Milestone Execution Plan

---

### Milestone 1: Local Folder Sync Adapter

#### Goal & User-Visible Behavior
Enable Chromium-based desktop browsers (Chrome, Edge, Brave) to link any novel to a local filesystem folder via the File System Access API (`showDirectoryPicker`), automatically writing human-readable Markdown files with YAML frontmatter (`chapters/*.md`, `continuity/*.md`, `story-bible/**/*.md`) alongside lossless `.xnovelist/*.json` mirrors while keeping `IndexedDB` as the instant primary store and universal fallback. Changes edited externally in Obsidian/VS Code/text editors are safely pulled back into `xnovelist` with automatic `'pre-import'` snapshots, non-blocking toasts, and explicit conflict resolution only when both sides diverged.

#### Exact Files to Create
1. **`src/storage/frontmatter.ts`**
   - Pure TS YAML frontmatter parser & serializer (`parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string }`, `stringifyFrontmatter(data: Record<string, unknown>, body: string): string`).
   - Deterministic `slugifyFilename(name: string, fallback: string): string` and `padOrder(index: number): string`.
2. **`src/storage/diskSync.ts`**
   - `DiskFolderSync` service class and serialization mappers (`chapterToDiskMd`, `diskMdToChapter`, `bibleEntityToDiskMd`, `diskMdToBibleEntity`, `styleToDiskMd`, `diskMdToStyle`).
   - Two-way reconciliation engine (`reconcile()`, `linkFolder()`, `unlinkFolder()`, `requestFolderPermission()`, `resolveConflict()`).
   - Simple hash utility + manifest reader/writer (`.xnovelist/sync-manifest.json`).
3. **`src/storage/SyncingProjectStorage.ts`**
   - `SyncingProjectStorage implements ProjectStorage` wrapping `IndexedDBProjectStorage`, routing writes/deletes through an `800ms` debounced disk flush callback for the active linked project.
4. **`src/ui/SyncStatusBadge.tsx`**
   - Compact workspace header pill/indicator showing sync state (`Synced`, `Syncing…`, `Reconnect Folder`, `Conflict (N)`, or hidden/subtle when unlinked) + non-blocking toast banner for auto-pulled disk updates.
5. **`src/ui/SyncConflictModal.tsx`**
   - Modal displaying side-by-side summary / line diff when `SyncConflict[]` is non-empty, allowing per-file `"Keep Browser Version"` or `"Use Disk Version (Auto-Snapshot First)"`.

#### Exact Existing Files to Modify
1. **`src/storage/schemas.ts`**
   - Add `SyncManifestEntrySchema`, `SyncManifestSchema`, and exported TS types.
2. **`src/storage/IndexedDBProjectStorage.ts`**
   - Upgrade `openDB(DB_NAME, 2, ...)` to create `'handles'` object store if absent.
   - Add typed helper methods `saveFolderHandle(projectId: string, handle: FileSystemDirectoryHandle)`, `getFolderHandle(projectId: string)`, and `deleteFolderHandle(projectId: string)`.
3. **`src/ui/ProjectSettings.tsx`**
   - Add a **"Local Folder Sync"** card alongside Metadata/Cover/Prose Discipline: shows linked folder name, browser support notice if `showDirectoryPicker` is unavailable, **"Link Local Folder"**, **"Sync Now"**, **"Reconnect Permission"**, and **"Unlink Folder"** buttons.
4. **`src/app/page.tsx`**
   - Instantiate `SyncingProjectStorage` wrapping `IndexedDBProjectStorage` inside the bootstrap `useEffect` (replacing direct `new IndexedDBProjectStorage()` at line `240` while keeping the same `ProjectStorage` state type).
   - Bind `DiskFolderSync` to `handleOpenProject` (line `503`), `handleBackToDashboard` (line `726`), and `window` `focus` listener so external disk edits reconcile automatically.
   - Mount `<SyncStatusBadge />` in the workspace `<header>` (around line `1693`) and `<SyncConflictModal />` at root modal level.
   - Add `onExternalSyncReload` callback that reloads active project/chapter/Bible state when disk changes are pulled.
5. **`src/i18n/ui/en.json` & `src/i18n/ui/vi.json`**
   - Add translation keys for Local Folder Sync UI, status badges, toasts, and conflict dialog.

#### Verification Checklist (Preview Pane)
1. **Fallback check:** Open app without linking any folder → create/edit chapters and Story Bible entries → reload page → confirm everything persists cleanly via IndexedDB with zero console errors.
2. **Initial Link & Push:** Open Project → `Settings` tab → click **Link Local Folder** → select an empty local directory → inspect directory on disk to verify `chapters/01-*.md`, `story-bible/**/*.md`, and `.xnovelist/*.json` are created, `:::beat{id}` tokens are preserved inside chapter `.md`, and `workspace/ai.json` is **absent**.
3. **External Edit Pull:** Edit `chapters/01-*.md` in a local text editor → refocus the app window → verify toast notification appears, editor updates with the disk text, and `Snapshots` history contains a new `'pre-import'` snapshot.
4. **Conflict Flow:** Disconnect/pause permission or edit both in-app and on disk before syncing → trigger sync → confirm `SyncConflictModal` appears and both resolution buttons update state without data loss.
5. **Build Check:** Run `npx tsc --noEmit && npm run lint && npm run build`.

---

### Milestone 2: Spatial Brainstorming Corkboard

#### Goal & User-Visible Behavior
Provide a dedicated **"Corkboard"** workspace tab with an interactive 2D spatial canvas (pan, zoom, drag-and-drop positioning, SVG directional connectors with editable labels, typed/tagged cards with optional image attachments, and quick filtering) plus a one-click **"Promote to Story Bible / Chapter Outline"** flow that leaves the original card on the board with a clickable `"Jump to..."` badge.

#### Exact Files to Create
1. **`src/ui/CorkboardCanvas.tsx`**
   - Main Corkboard workspace component:
     - Pan (`Space+drag` or middle-mouse/background drag) and Zoom (`wheel` + `- / 100% / +` controls) persisted to `corkboard.viewport`.
     - Card creation toolbar (`+ Idea`, `+ Scene`, `+ Character`, `+ Location`, `+ World Rule`, `+ Plot Thread`), type/tag filter bar, and search box.
     - Draggable cards with inline title/body editing, tag chips, color picker, optional image upload (WebP compressed `<= 800px` data URL, matching `ProjectSettings.tsx` cover compression pattern), and `"Connect"` drag-handle / mode.
     - SVG connector layer rendering curved cubic Bezier arrows between `fromCardId` → `toCardId` with clickable/editable midpoint labels and delete action.
     - **Promote Menu** on each card: `"Promote → Chapter Outline"`, `"Promote → Character"`, `"Promote → Location"`, `"Promote → Item"`, `"Promote → World Rule"` (World Rule option enabled or gracefully queued/created via `WorldRules.json`). Once promoted, renders a clickable `"Jump to: {label}"` badge using `card.promotedRef`.
     - Responsive fallback / usable touch-pan & list toggle on narrow viewports (`< sm`).

#### Exact Existing Files to Modify
1. **`src/storage/schemas.ts`**
   - Add `BrainstormCardTypeSchema`, `PromotedRefSchema`, `BrainstormCardSchema`, `BrainstormLinkSchema`, `CorkboardSchema`, and exported types.
2. **`src/app/page.tsx`**
   - Extend `activeTab` union (line `162`) from `'editor' | 'outline' | 'bible' | 'settings'` to `'editor' | 'outline' | 'corkboard' | 'bible' | 'settings'`.
   - Add `corkboard` state (`Corkboard`), load `${prefix}Corkboard.json` in `handleOpenProject` (line `503`), seed empty `Corkboard.json` in `handleCreateProject` (line `627`) and default project seed (line `306`), and persist via `handleUpdateCorkboard` (debounced/immediate write to `${prefix}Corkboard.json`).
   - Add header tab button (`t('corkboardTab')`) in `data-tour="nav-tabs"` (line `1656`) and mobile `"More"` sheet item (line `2113`).
   - Refactor `handleCreateChapter` (line `761`) to accept optional `{ title?: string; initialBody?: string; synopsis?: string }` so promoting a Scene card creates a populated chapter + optional `Continuity/chapter-{id}.md` and updates `OutlineGrid` immediately.
   - Implement `handlePromoteCorkboardCard(card: BrainstormCard, target: PromotedRef['kind'])` and `handleJumpToPromotedRef(ref: PromotedRef)` (switches `activeTab` to `'editor'`/`'outline'`/`'bible'` and selects the target chapter/entity ID).
3. **`src/storage/diskSync.ts`** *(from Milestone 1)*
   - Ensure `Corkboard.json` is included in `.xnovelist/Corkboard.json` sync mirroring.
4. **`src/i18n/ui/en.json` & `src/i18n/ui/vi.json`**
   - Add Corkboard tab, card types, connector, pan/zoom, and promotion copy keys.

#### Verification Checklist (Preview Pane)
1. **Canvas Navigation:** Switch to **Corkboard** tab → create 3 cards of different types (e.g., `Scene`, `Character`, `World Rule`), upload an image onto one card, add tags, drag cards to arrange, pan/zoom canvas → reload page → verify positions, zoom, image, and tags persist in `Corkboard.json`.
2. **Connectors:** Draw a directional connector between two cards, add a label (e.g., `"causes"`), move one card, and verify the SVG curve and label track smoothly.
3. **Promote to Chapter & Story Bible:** Promote a `Scene` card to Chapter Outline → verify card remains on the board with a `"Jump to..."` badge, and clicking it opens the newly created chapter in `Outline` / `Write`. Promote a `Character` card → verify it appears in `Story Bible → Characters` and `"Jump to..."` selects it directly.
4. **Build Check:** Run `npx tsc --noEmit && npm run lint && npm run build`.

---

### Milestone 3: World Rules & Physics Engine

#### Goal & User-Visible Behavior
Introduce `"World Rules & Physics"` as a first-class Story Bible category (alongside Characters, Locations, Items, Style, and Continuity), wire **both `WorldRules.json` and the previously un-injected `Items.json`** into `buildEditorPrompt()` and `check_continuity`, add `world_rule_add` / `world_rule_update` write-ops (and optional `capture_world_rules` extraction), and ship a dedicated one-click **"Audit World Rules"** Level 1 action in `AIPanel` that outputs severity-badged conflict cards citing the exact violated rule.

#### Exact Files to Create
1. **`src/ai/actions/auditWorldRules.ts`**
   - Level 1 chapter-scoped `Action<CheckContinuityInput>` (`id: 'audit_world_rules'`, `label: 'Audit World Rules'`, `level: 1`, `scope: 'chapter'`, `allow: []`).
   - Loads `WorldRules.json` (audits **all** `'hard'` rules + keyword-matched `'soft'` rules + `alwaysActive` rules), `Items.json`, `Characters.json`, `Locations.json`, and `Continuity/chapter-{prevId}.md`.
   - Calls `buildPrompt('audit_world_rules', ...)` + `extractJson<{ flags: unknown[] }>` with automatic single repair retry, returning `{ type: 'report', items: ReportItem[] }` where each `conflict` cites the exact rule title, category, and statement.
2. **`src/ai/actions/captureWorldRules.ts`**
   - Level 1 selection-scoped `Action<CaptureInput>` (`id: 'capture_world_rules'`, `level: 1`, `scope: 'selection'`, `allow: ['world_rule_add', 'world_rule_update']`) to extract world constraints/physics rules from selected prose or lore notes.
3. **`src/ai/writeOps/worldRuleAdd.ts` & `src/ai/writeOps/worldRuleUpdate.ts`**
   - Zod-validated `WriteOp` implementations (`id: 'world_rule_add'`, `id: 'world_rule_update'`, `level: 1`) reading/writing `${ctx.prefix}WorldRules.json` and calling `ctx.onUpdateWorldRules`.

#### Exact Existing Files to Modify
1. **`src/storage/schemas.ts`**
   - Add `WorldRuleCategorySchema`, `WorldRuleSeveritySchema`, `WorldRuleSchema`, `WorldRulesSchema`, and types.
2. **`src/bible/BibleWorkspace.tsx`**
   - Extend `bibleTab` union to `'characters' | 'locations' | 'items' | 'rules' | 'style' | 'continuity'`.
   - Add `worldRules`, `onUpdateWorldRules`, `selectedRuleId`, `onSelectRule` props.
   - Add `"World Rules"` tab button (e.g., `Scale` or `Atom` icon from `lucide-react`) with sidebar list, category badge (`orbital-propulsion`, `thermodynamics`, `comms-latency`, `biology-life-support`, `society-tech`, `other`), severity toggle (`Hard` vs `Soft`), `alwaysActive` checkbox, `keywords` comma-input, `statement` textarea, `exceptions` textarea, and highlight color picker.
3. **`src/editor/bibleLinkage.ts`**
   - Optionally accept `worldRules?: WorldRule[]` and highlight rule `keywords` (e.g. `.rule-highlight` dotted underline) so clicking a highlighted rule keyword opens its `World Rules` entry in `BibleWorkspace`.
4. **`src/ai/types.ts`**
   - Add `onUpdateWorldRules?: (list: WorldRule[]) => void;` to `ToolContext` and `WorldRuleDraft` type.
5. **`src/ai/prompts/buildPrompt.ts`**
   - In `buildEditorPrompt()` (around lines `196-344`):
     - Load `Items.json` and inject matched items (`=== ITEM BIBLE ===`) by `name` / `aliases`.
     - Load `WorldRules.json` and select rules where `rule.alwaysActive === true` OR any `rule.keywords` / `rule.title` matches `textToSearch` (`beforeText + selectionText + afterText`), formatted as `=== WORLD RULES & CONSTRAINTS ===` (tagging `[HARD RULE]` vs `[SOFT RULE]` and `Exceptions:` if present).
     - Update the 6,000-token 3-step trimming budget so `alwaysActive` + `'hard'` world rules are retained before compacting entities (`compact = true`).
6. **`src/ai/actions/checkContinuity.ts`**
   - Update `readBibleContext()` (lines `9-42`) to also include `Items.json` and `WorldRules.json` (**all** `'hard'` rules + matched `'soft'` rules + `alwaysActive` rules) so `check_continuity` catches physical/world-rule contradictions automatically.
7. **`src/ai/prompts/packs/en.json` & `src/ai/prompts/packs/vi.json`**
   - Add prompt blocks for `audit_world_rules` and `capture_world_rules`, and refine `check_continuity` instruction to explicitly check `WORLD RULES` alongside Characters, Locations, Items, and Preceding Continuity.
8. **`src/ai/levels/level1.ts` & `src/ai/writeOps/registry.ts`**
   - Register `auditWorldRules` and `captureWorldRules` in `LEVEL_1.actions`; register `worldRuleAdd` and `worldRuleUpdate` in `ALL_WRITE_OPS`.
9. **`src/ui/AIPanel.tsx`**
   - Add inline editable card renderers in `TranscriptCard` for `world_rule_add` and `world_rule_update` (matching lines `776-853`).
10. **`src/app/page.tsx`**
    - Add `worldRules` and `selectedRuleId` state; load/seed `${prefix}WorldRules.json` (with graceful legacy fallback like `Items.json` at line `577`); wire `onUpdateWorldRules` in `BibleWorkspace` and `buildToolContext` (line `1256`); wire Corkboard `'world-rule'` promotion (from Milestone 2) cleanly into `WorldRules.json`; wire `handleAttachEvidence` (`'characters' | 'locations' | 'items' | 'rules'`).
11. **`src/storage/diskSync.ts`** *(from Milestone 1)* & **`src/i18n/ui/{en,vi}.json`**
    - Sync `story-bible/world-rules/{slug}.md` + `.xnovelist/WorldRules.json` and add UI translations.

#### Verification Checklist (Preview Pane)
1. **Bible CRUD:** Open `Story Bible → World Rules` → create a Hard rule (e.g., `"Light-Lag Comms"`, category `comms-latency`, `alwaysActive: true`, statement `"No instantaneous FTL communication; Ceres-to-Earth lag is 15–28 minutes."`) and a Soft keyword rule (`keywords: ["epstein", "torchship"]`). Reload and verify persistence.
2. **Drafting Prompt Injection (Local/Cloud LLM):** With AI Level ≥ 2/3, trigger `Write Beat` or `Rephrase` in a scene mentioning `"Ceres"` or `"torchship"` and verify generated prose respects the active rules (and `Items.json` entries).
3. **One-Click Audit & Continuity Check:** Write an intentional violation in a chapter (e.g., `"Elena answered Earth's live video call from Ceres without delay"`) → open `AIPanel` at Level 1 → click **Audit World Rules** (and also test **Check continuity**) → confirm a `high` severity `ReportItem` card is returned citing `"Light-Lag Comms"`. Confirm **no** automatic popup fires after inserting a beat.
4. **Build Check:** Run `npx tsc --noEmit && npm run lint && npm run build`.

---

### Milestone 4: Continuity & Scene-Entity Matrix

#### Goal & User-Visible Behavior
Provide a lightweight **Continuity & Scene-Entity Matrix** view inside the `Outline` workspace (via an `Outline Cards | Entity Matrix` mode toggle, avoiding top-header clutter) that cross-references every chapter in `chapterOrder` against all Characters, Locations, Items, and World Rules, showing occurrence counts, POV focus mismatches, missing chapter continuity records, and clickable cells that jump straight to the matching chapter or Story Bible entry.

#### Exact Files to Create
1. **`src/editor/entityMatrix.ts`**
   - Pure, zero-LLM deterministic scanner (`buildSceneEntityMatrix(params)`):
     - Scans each chapter's stripped Markdown (`stripBeatTokens`) using the same word-boundary case-sensitive/insensitive matching rules as `src/editor/bibleLinkage.ts` for `characters` (name + aliases), `locations` (name + aliases), `items` (name + aliases), and `worldRules` (`keywords` + `title` terms, plus an indicator when a rule is `alwaysActive`).
     - Computes per-chapter health indicators: word count, continuity doc status (`hasContinuity: boolean`, `hasConstraintsCarriedForward: boolean`), beat anchor count, and gap warnings (e.g., `"No continuity summary for completed/non-empty chapter"`, `"Preceding chapter has unresolved threads / missing continuity"`, `"POV character absent from chapter"`).
2. **`src/ui/ContinuityMatrix.tsx`**
   - Responsive table/matrix component:
     - Sticky left entity column grouped by collapsible sections (`Characters`, `Locations`, `Items`, `World Rules`), with color dots and entity count badges.
     - Scrollable chapter columns (`Ch.1`, `Ch.2`, …) with status pill + continuity indicator icon in column headers.
     - Cell rendering: exact mention count badge (or `∞` badge for `alwaysActive` world rules), tooltip showing matched aliases/keywords, and click handler to jump to the chapter in `Editor` (pre-populating `jumpToSearchQuery` so `EditorCanvas` highlights the first occurrence!) or open the entity in `Story Bible`.
     - Category filter chips + `"Show Gaps Only"` toggle + `"Export CSV"` utility button (client-side Blob download).

#### Exact Existing Files to Modify
1. **`src/ui/OutlineGrid.tsx`**
   - Add an internal sub-view switcher in the Outline header (`Cards` | `Entity Matrix`) and pass through the needed props (`characters`, `locations`, `items`, `worldRules`, `continuityList`, `chapterMarkdowns`, `povCharacterId`, `onJumpToChapterSearch`, `onOpenBibleEntity`).
2. **`src/app/page.tsx`**
   - Pass Story Bible lists (`characters.characters`, `locations.locations`, `items.items`, `worldRules.rules`), `continuityList`, `project.povCharacterId`, and a lightweight loader/cache of chapter markdown texts (loaded on demand when switching to `activeTab === 'outline'` and entering `Entity Matrix` mode so typing in the editor incurs zero extra I/O) into `<OutlineGrid />`.
   - Wire `onJumpToChapterSearch(chapterId, term)` using existing `handleSelectChapter(chapterId)` + `setActiveTab('editor')` + `setJumpToSearchQuery(term)`.
3. **`src/i18n/ui/en.json` & `src/i18n/ui/vi.json`**
   - Add matrix mode, filter, gap-warning, and CSV export translation keys.

#### Verification Checklist (Preview Pane)
1. **Cross-Reference Accuracy:** Open a multi-chapter novel with at least 2 Characters, 2 Locations, 1 Item, and 1 World Rule → switch to `Outline → Entity Matrix` → verify exact mention counts appear in the corresponding `(Entity × Chapter)` cells.
2. **Gap Highlighting:** Leave Chapter 1 non-empty without a `Continuity/chapter-*.md` document or omit the `povCharacterId` from Chapter 2 → verify the matrix column header flags the continuity/POV gap clearly.
3. **Deep Jump Navigation:** Click a non-zero cell → confirm it opens that chapter in `Write` and jumps `FindBar` directly to the matched entity name; click an entity row header → confirm it opens that entry in `Story Bible`.
4. **Final Regression & Build Check:** Run `npx tsc --noEmit && npm run lint && npm run build`, and verify static offline / IndexedDB-only mode and Local Folder Sync mode both work cleanly.
