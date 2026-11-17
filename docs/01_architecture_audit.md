# xnovelist Architectural Audit

**Audited Repository:** `giapnguyen74/xnovelist` (imported into workspace)  
**Audit Date:** 2026-11-16  
**Scope:** Read-only inspection of `package.json`, build configuration, `src/` application code, storage layer, AI pipeline, UI shell, and existing `docs/` specifications.

> **Important Note on Docs vs. Implemented Reality:**  
> Several design documents under `docs/` (`docs/ARCHITECTURE.md`, `docs/STORAGE.md`) describe aspirational or planned conventions (e.g., Next.js 16, Vitest, strict zero-`localStorage` rules, `Continuity/chapter-001.md` vs. actual chapter IDs, `BroadcastChannel`). This audit documents the **actual implemented codebase in `src/`**, calling out discrepancies where relevant so future modifications target the real seams.

---

## 1. System & Stack Inventory

### 1.1 Core Frameworks, Bundler & Tooling
| Layer | Technology / Version | Source / Notes |
|---|---|---|
| Framework | **Next.js `15.5.18`** (App Router) | `package.json`; single route `src/app/page.tsx` wrapped by `src/app/layout.tsx` |
| UI Runtime | **React `19.1.0`** + `react-dom` `19.1.0` | Client-rendered SPA (`"use client"` in `src/app/page.tsx`) |
| Language | **TypeScript `^5`** (`strict: true`, `noEmit: true`, `moduleResolution: "bundler"`) | `tsconfig.json`; path alias `@/*` → `./src/*` |
| Rich Text Editor | **Tiptap `^3.23.6`** (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`) + `tiptap-markdown ^0.9.0` | `src/editor/EditorCanvas.tsx` |
| Styling | **Tailwind CSS `^4`** via `@tailwindcss/postcss` | `postcss.config.mjs`, `src/app/globals.css` (`@import "tailwindcss";`, `@custom-variant dark`) |
| Icons | **`lucide-react ^1.16.0`** | Used across all UI components |
| Validation | **`zod ^4.4.3`** | `src/storage/schemas.ts`, `src/ai/writeOps/*.ts` |
| Persistence | **`idb ^8.0.3`** | `src/storage/IndexedDBProjectStorage.ts` |
| Document Export | **`docx ^9.7.1`** | `src/ui/ExportImportDialog.tsx` |
| Guided Tours | **`driver.js ^1.4.0`** | `src/onboarding/tours.ts` |
| Linting | **ESLint `^9`** (`eslint-config-next 15.5.18`) | `eslint.config.mjs` (`@typescript-eslint/no-explicit-any` disabled) |
| Test Runner | *None installed* | `docs/ARCHITECTURE.md` mentions Vitest, but no `vitest.config.*` or test dependencies exist in `package.json` |

### 1.2 UI & CSS Architecture
- **Theming (`src/app/globals.css`):** CSS custom properties on `:root` and `.dark-theme` (`--background`, `--foreground`, `--border`, `--sidebar-bg`, `--editor-bg`, `--accent`, `--accent-light`, `--font-serif`, `--font-sans`) toggled by adding/removing `dark-theme` on `document.body` (`src/app/page.tsx:427-437`).
- **Typography:** Curated novel-writing font utilities (`.font-merriweather`, `.font-lora`, `.font-garamond`, `.font-source-serif`, `.font-crimson`, `.font-lato`, `.font-courier`) and ProseMirror spacing/indent helper classes (`.spacing-1..4`, `.indent-1..3`) loaded via Google Fonts `@import url(...)` in `src/app/globals.css`.
- **Component Architecture:** Hand-authored Tailwind components across `src/ui/`, `src/editor/`, and `src/bible/`. No third-party design system (no shadcn/Radix).
- **Internationalization (`src/i18n/`):** Custom React hook `useTranslation()` (`src/i18n/useTranslation.ts`) backed by static JSON packs `src/i18n/ui/en.json` and `src/i18n/ui/vi.json`, synced via a module-level listener `Set` and persisted in `localStorage` (`xnovelist-ui-language`).

### 1.3 State Management Approach
xnovelist uses **centralized top-level React state in `src/app/page.tsx`** (`WorkspacePage`) rather than Redux, Zustand, or React Context:
- **Workspace & Project State:** `storage`, `projectList`, `currentProjectId`, `project`, `chapters`, `activeChapterMarkdown`, `wordCounts`, `chaptersWithHistory`.
- **Story Bible & Sidecars:** `characters`, `locations`, `items`, `style`, `continuityList`, `beats` (`Record<string, BeatData>`), plus lifted Story Bible navigation state (`bibleTab`, `selectedCharId`, `selectedLocId`, `selectedItemId`).
- **AI & Editor Coordination:** `workspaceAI`, `isAIPanelOpen`, `aiPanelSelectedActionId`, `aiTranscript`, `activeSelection`, `activeBeatId`, and an imperative `editorRef` (`EditorCanvasRef` exposing `replaceRange`, `applyBeat`, `getBeatSurroundingText`, `syncBeatAttrs`).
- **UI Preferences (`localStorage` / `sessionStorage`):** Contrary to `docs/STORAGE.md`, `src/app/page.tsx` and `src/i18n/useTranslation.ts` directly use `localStorage` for user/browser preferences (`xnovelist-global-format`, `xnovelist-theme`, `xnovelist-snapshot-interval-min`, `xnovelist-ai-reasoning`, `xnovelist-active-project`, `xnovelist-last-author`, `xnovelist-ui-language`, and `driver.js` tour completion flags) and `sessionStorage` for `xnovelist_flash_shown`.

### 1.4 Zero-Backend Static Bundle Architecture (`file://` & Offline Support)
- **Original Export Model:** `next.config.ts` originally specified `output: "export"` and `images: { unoptimized: true }` (adapted to `output: "standalone"` for Node.js dev-server execution in this environment, while the application code itself remains 100% client-side).
- **Zero Server Routes:** There are no `app/api/*` routes, no Server Actions, and no server-side database connections. `src/app/layout.tsx` provides only metadata and `<html><body>{children}</body></html>`, and `src/app/page.tsx` bootstraps entirely in the browser.
- **Relative Asset Loading:** Dashboard images in `src/app/page.tsx` use relative paths (`src="logo.png"`, `src="cover1.svg"`) and `<img>` elements rather than `next/image` optimization so static bundles resolve assets identically on sub-paths or `file://`.
- **Browser-Direct AI Calls:** All LLM requests (`fetch()` in `src/ai/llm/client.ts` and `src/engine/testConnection.ts`) execute directly from the browser to `api.openai.com`, `api.anthropic.com` (with `anthropic-dangerous-direct-browser-access: true`), `openrouter.ai`, or a user-configured local endpoint (e.g., `http://localhost:11434/v1`).
- **Offline Caveat:** Core editing, Story Bible, IndexedDB persistence, snapshots, and `.docx`/JSON export work offline; only Google Fonts (`fonts.googleapis.com` in `src/app/globals.css`) and cloud AI providers require internet access.

---

## 2. Persistence & Data Schema (`IndexedDB` / Local Storage)

### 2.1 Storage Abstraction & IndexedDB Adapter
All manuscript and Story Bible persistence is gated behind a minimal 5-method interface:

- **Interface (`src/storage/ProjectStorage.ts`):**
  ```ts
  export interface ProjectStorage {
    readFile(path: string): Promise<string | null>;
    writeFile(path: string, content: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    listFiles(prefix?: string): Promise<string[]>;
    exists(path: string): Promise<boolean>;
  }
  ```
- **Implementation (`src/storage/IndexedDBProjectStorage.ts`):**
  - Opens IndexedDB database `'xnovelist'` (version `1`) with a single object store `'files'`.
  - Stores raw `string` values keyed by virtual file paths (e.g., `projects/proj-123/Project.json`).
  - `listFiles(prefix)` calls `db.getAllKeys('files')` and filters by `key.startsWith(prefix)`.
  - *Note:* `BroadcastChannel` cross-tab sync and `navigator.storage.estimate()` quota UI mentioned in `docs/STORAGE.md` are **not** implemented in `src/`.

### 2.2 Virtual Path Layout in IndexedDB
```text
projects.json                                          # Global registry: ProjectListItem[]
workspace/ai.json                                      # Global AI dial & provider configs (WorkspaceAIConfig)

projects/{projectId}/
├── Project.json                                       # Project metadata & chapterOrder (ProjectSchema)
├── Characters.json                                    # Cast bible (CharactersSchema)
├── Locations.json                                     # Locations bible (LocationsSchema)
├── Items.json                                         # Items/objects bible (ItemsSchema)
├── Style.json                                         # Author voice/style profile (StyleSchema)
├── Beats.json                                         # Beat anchor metadata sidecar (Record<string, BeatData>)
├── Artifacts/
│   └── chapter-{chapterId}.md                         # Plain Markdown prose + :::beat{beatId} tokens
├── Continuity/
│   └── chapter-{chapterId}.md                         # Per-chapter chronological continuity Markdown
└── .history/
    └── Artifacts/
        └── chapter-{chapterId}/
            ├── index.json                             # Snapshot metadata index (SnapshotIndexSchema)
            └── {isoTimestamp}--?{type}.md             # Full-text chapter snapshots
```
*(Note: `src/storage/snapshots.ts` names snapshot files `${createdAt.replace(/:/g, '-')}-${type}.md`, and `Artifacts` filenames are `chapter-${chapterId}.md`, where `chapterId` is `'chapter-1'` on the seeded project or `'chapter-' + Date.now()` for newly created chapters — resulting in IDs like `Artifacts/chapter-chapter-1.md`.)*

### 2.3 Exact Data Schemas (`src/storage/schemas.ts`, `src/storage/aiConfig.ts`, `src/app/page.tsx`)
All core schemas are defined with `zod` in `src/storage/schemas.ts`:

1. **Project & Chapters (`ProjectSchema`, `ChapterSchema`, `TypographySettingsSchema`):**
   - `Project`: `schemaVersion: 1`, `id`, `title`, `author`, `genre?`, `pov` (`'first' | 'second' | 'third' | 'third-limited' | 'third-omniscient'`), `tense` (`'past' | 'present'`), `language` (default `'en'`), `targetWordCount` (default `50000`), `createdAt`, `updatedAt`, `activeChapterId`, `chapterOrder: string[]`, `typography: TypographySettings`, `series?`, `seriesIndex?`, `coverImage?` (base64 data URL), `povCharacterId?`, `archived` (default `false`), `highlightBibleRefs` (default `true`), `chapters: Chapter[]`.
   - `Chapter`: `id`, `title`, `createdAt`, `updatedAt`, `synopsis?` (derived cache from `Continuity/chapter-{id}.md`), `status` (`'draft' | 'revised' | 'final'`).
   - `ProjectListItem` (`src/app/page.tsx:61-70`): `{ id, title, author, updatedAt, series?, seriesIndex?, coverImage?, archived? }` persisted in `projects.json`.
2. **Story Bible Entries (`src/storage/schemas.ts:55-180`):**
   - `EvidenceSchema`: `{ chapterId: string, quote: string, addedAt: number }` (attached via editor right-click context menu in `EditorCanvas.tsx` → `handleAttachEvidence` in `src/app/page.tsx:1175-1226`).
   - `CharacterSchema` (`Characters.json` `{ schemaVersion: 1, characters }`): `id`, `name`, `aliases[]`, `role?`, `age?`, `appearance?`, `traits[]`, `desires[]`, `fears[]`, `speechPatterns?`, `relationships[]` (`{ with, kind, notes? }`), `notes?`, `evidence[]`, `avatar?`, `color?`.
   - `LocationSchema` (`Locations.json` `{ schemaVersion: 1, locations }`): `id`, `name`, `aliases[]`, `scale` (`'room' | 'building' | 'district' | 'city' | 'region' | 'world'`), `descriptors[]`, `significance?`, `inhabitants[]`, `notes?`, `evidence[]`, `avatar?`, `color?`.
   - `ItemSchema` (`Items.json` `{ schemaVersion: 1, items }`): `id`, `name`, `aliases[]`, `description?`, `significance?`, `notes?`, `evidence[]`, `avatar?`, `color?`.
   - `StyleSchema` (`Style.json`): `schemaVersion: 1`, `rhythm` (`avgSentenceLengthHint?`, `paragraphLengthHint?`, `rhythmNotes?`), `diction` (`register?`, `formality?`, `favoredWords[]`, `avoidedWords[]`), `dialogue` (`taggingConvention?`, `registerNotes?`, `dialectMarkers[]`), `narrativeRegister` (`pointOfView`, `tense`, `interiority`), `sensoryPalette` (`dominantSenses[]`, `colorNotes?`, `soundNotes?`), `pronounPairs[]`.
   - **Continuity (`Continuity/chapter-{chapterId}.md`):** Markdown document with 5 template sections in `src/ai/continuity.ts` (`makeContinuityTemplate`): `# Continuity: Chapter N — Title`, `## Synopsis`, `## What the reader knows`, `## Hidden / dramatic irony`, `## Unresolved threads`, `## Constraints carried forward`. `deriveSynopsis()` extracts the first non-empty section (up to 180 chars) into `Chapter.synopsis` on every continuity write (`handleUpdateContinuity`, `src/app/page.tsx:1238-1253`).
3. **Beat Anchors (`BeatData` in `src/app/page.tsx:35-41` & `src/editor/BeatAnchor.ts`):**
   - Inline Markdown token `:::beat{beatId}` parsed/serialized by custom Tiptap `Node` (`BeatAnchor`).
   - Sidecar metadata stored in `Beats.json`: `{ type: 'action' | 'reaction' | 'dialogue' | 'realization' | 'decision' | 'transition', length: 200 | 400 | 600, intent: string, createdAt: string, mode?: 'write_beat' | 'continue' }`.
   - `handleSaveChapterMarkdown` (`src/app/page.tsx:998-1040`) garbage-collects `Beats.json` across all chapters on every save.
4. **Snapshots (`SnapshotSchema`, `SnapshotIndexSchema`, `src/storage/snapshots.ts`):**
   - Types: `'manual' | 'interval' | 'pre-restore' | 'pre-import' | 'pre-delete'`.
   - Auto-interval timer in `src/app/page.tsx:459-467` (default 30 min, configurable in `SettingsView.tsx`).
   - `takeSnapshot()` deduplicates consecutive `'interval'` snapshots by `simpleHash(markdown)` and enforces `RETENTION_CAP = 50` FIFO pruning **only** on `'interval'` snapshots (exempting manual/pre-restore/pre-import/pre-delete).
   - `restoreSnapshot()` takes a `'pre-restore'` self-snapshot before overwriting `Artifacts/chapter-{id}.md`.
   - Deleting a chapter (`confirmDeleteChapter`, `src/app/page.tsx:822-860`) takes a `'pre-delete'` snapshot and intentionally preserves `.history/Artifacts/chapter-{id}/` as a recoverable tombstone surfaced by `src/ui/RestoreDeletedChaptersDialog.tsx`.
5. **AI & UI Settings (`src/storage/aiConfig.ts`, `localStorage`):**
   - `WorkspaceAIConfig` persisted in IndexedDB at `workspace/ai.json` (`level: 0..5`, `defaultProviderId`, `providers: { openai?, anthropic?, openrouter?, local? }`). API keys are stored in plaintext inside `workspace/ai.json` in IndexedDB (unlike the encrypted-key design sketched in `docs/STORAGE.md`).
   - Typography/format defaults (`xnovelist-global-format` in `localStorage`) are stored globally across novels rather than reading `project.typography` on load (`src/app/page.tsx:177-200`, `1849`).

### 2.4 Serialization, Export & Restore (`src/ui/ExportImportDialog.tsx`)
- **JSON Full Backup (`handleExportJSON`):** Iterates `await storage.listFiles()`, reads all keys **except `workspace/ai.json`** (preventing API key leakage), and downloads `xnovelist-backup-YYYY-MM-DD.json` as `{ [path]: stringContent }`.
- **JSON Restore (`handleImportJSON` → `confirmImport`):** Validates shape via `isValidBackup()` (non-empty `Record<string, string>` containing `projects.json`, `projects/`, `Artifacts/`, or `Project.json`), asks confirmation via `ConfirmDialog`, skips `workspace/ai.json`, writes all entries via `storage.writeFile()`, and reloads the page (`window.location.reload()`). *(Note: unlike `docs/STORAGE.md`, `confirmImport` currently overwrites keys directly without taking pre-import snapshots first.)*
- **DOCX Manuscript Export (`handleExportDOCX`):** Uses `docx` (`Document`, `Paragraph`, `HeadingLevel`, `ImageRun`, `Packer.toBlob`) to compile a title page (with optional embedded `project.coverImage`), page breaks, chapter headings, scene dividers (`boxes`, `stars`, `lines`, `asterisk`), and optional Chicago-style 0.5" first-line paragraph indents across `chapterOrder`.

---

## 3. AI Dial & Agent Pipeline (Levels 0–5)

### 3.1 AI Autonomy Dial & Gating
- **Configuration & UI:** `WorkspaceAIConfig.level` (`0 | 1 | 2 | 3 | 4 | 5`, default `0`) is persisted via `loadAIConfig` / `saveAIConfig` (`src/storage/aiConfig.ts`) and edited via a range slider in `src/ui/SettingsView.tsx:445-480`.
- **Registry & Level Modules (`src/ai/registry.ts`):**
  - **Level 0 (Off):** No actions unlocked; AI panel hidden/disabled (`isAIPanelOpen && workspaceAI.level >= 1`).
  - **Level 1 (`src/ai/levels/level1.ts` — Reader):** `capture_characters`, `capture_locations`, `capture_style`, `summarize_chapter`, `check_continuity`. Reads prose, proposes Bible additions/updates, continuity docs, or contradiction reports. Never edits manuscript prose.
  - **Level 2 (`src/ai/levels/level2.ts` — Editor):** `fix_grammar`, `rephrase`, `shorten`, `polish_dialogue`, `vivid_detail`. Selection-scoped rewrites proposing `replace_range` ops.
  - **Level 3 (`src/ai/levels/level3.ts` — Co-writer):** `write_beat`, `continue`. Generates prose at `BeatAnchor` tokens (`:::beat{id}`) via `insert_beat` ops.
  - **Level 4 (`src/ai/levels/level4.ts` — Drafter) & Level 5 (`src/ai/levels/level5.ts` — Agent):** Defined as `LevelModule` stubs with `actions: []` ("Coming in future versions").
- **Single-Seam Enforcement (`src/ai/runTool.ts`):**
  - `runTool(actionId, input, ctx, ai)` throws `AIDisabledError` at Level 0 and `AILevelError` if `action.level > ai.level`, executes `action.propose(input, ctx)`, and **filters** returned proposals against the action's `action.allow` write-op manifest.
  - `executeWriteOp(opId, args, ctx, ai)` re-checks `ai.level`, `op.level`, validates `args` with the write-op's `zod` validator (`op.validate(args)`), and calls `op.execute(valRes.value, ctx)`.

### 3.2 Multi-Provider & Local LLM Client
- **`src/ai/llm/client.ts` (`makeCallModel`):**
  - Resolves `override?.providerId` or `resolveProvider(config)` (`defaultProviderId` else first ready provider).
  - Supports 4 provider wire formats:
    1. **`openai`**: `https://api.openai.com/v1/chat/completions` (uses `reasoning_effort` for `o1`/`o3` models).
    2. **`anthropic`**: `https://api.anthropic.com/v1/messages` (sets `anthropic-dangerous-direct-browser-access: true`, `max_tokens: 8192` default, extended thinking `budget_tokens` when enabled).
    3. **`openrouter`**: `https://openrouter.ai/api/v1/chat/completions` (sets `reasoning: { effort }` or `{ exclude: true }`; model catalog fetched by `src/engine/providers/openrouter.ts`).
    4. **`local`**: `${baseUrl}/chat/completions` for Ollama / LM Studio / llama.cpp / vLLM. Optional `Authorization: Bearer` key and custom `headers` map. Sets `chat_template_kwargs: { enable_thinking: false }` when reasoning is `'off'`. Uses a **30-minute timeout** (`LOCAL_TIMEOUT_MS`) vs. 5 minutes for cloud (`CLOUD_TIMEOUT_MS`) to accommodate cold model loads.
  - **URL Helper & Model Discovery (`src/engine/providers/local.ts`):** `suggestLocalBaseUrlCorrection()` auto-corrects bare hosts like `localhost:11434` → `http://localhost:11434/v1`; `fetchLocalModels()` queries `${baseUrl}/models` (supporting OpenAI `data[]` and Ollama `models[]` shapes).
  - **Round-Trip Diagnostics (`src/engine/testConnection.ts`):** Used by `SettingsView.tsx` and `src/ui/ModelTestPane.tsx` for connection testing (`ping` → `pong`) and the inline prompt playground.

### 3.3 Prompt Assembly & Context Injection (`src/ai/prompts/buildPrompt.ts`)
- **Language Packs:** `src/ai/prompts/packs/en.json` and `vi.json`, selected via `project.language` (`ctx.lang`), decoupled from UI language.
- **Sanitization:** Every prose/context input and outgoing system/user prompt passes through `stripBeatTokens()` (`src/ai/beats.ts`) so `:::beat{id}` tokens never reach the model.
- **Level 1 (`buildPrompt`):** Assembles `system` preamble + `[tool.action, optional context, "--- TEXT ---\n" + prose, tool.outputFormat]`.
  - `checkContinuity.ts` (`readBibleContext`) reads **all** `Characters.json` and `Locations.json` summaries + `Continuity/chapter-${prevId}.md` (if `activeIdx > 0`). **Gap:** `Items.json` and `Style.json` are not injected into `checkContinuity`.
- **Level 2 & 3 (`buildEditorPrompt`):** Assembles:
  1. `pack.system`
  2. `tool.action` (substituting `{target}`, `{focus}`, `{length}`, `{type}`, `{intent}`)
  3. Optional `=== WRITER GUIDANCE ===` (capped at 300 words; omitted for `write_beat` where intent is already in action)
  4. `=== STYLE PROFILE ===` from `Style.json`
  5. `=== CHARACTER BIBLE ===` — substring-matched against `beforeText + selectionText + afterText` by `name` or `aliases`
  6. `=== LOCATION BIBLE ===` — substring-matched against `beforeText + selectionText + afterText` by `name` or `aliases` *(Note: `Items.json` is currently NOT loaded or injected)*
  7. `=== PRECEDING CHAPTER CONTINUITY ===` from `Continuity/chapter-${prevId}.md`
  8. `=== BLEND INSTRUCTION ===` + `=== CONTEXT BEFORE ===` / `=== CONTEXT AFTER ===` (tool-specific word windows from 200/100 up to 1000/500) + `=== TARGET SELECTION TO EDIT ===` (for L2) + `tool.outputFormat`.
- **Token Budget Trimming:** Enforces a **6,000-token (~22,800-character)** ceiling in 3 steps: (1) shrink surrounding prose window to 100 before / 50 after, (2) drop continuity block + emit warning, (3) switch character/location formatting to `compact = true`.
- **Local Pre-Proposal Guardrails (L2):** Actions like `src/ai/actions/rephrase.ts` invoke deterministic checks in `src/ai/checks/offtopic.ts` (`jaccardBigram < 0.15` throws) and `src/ai/checks/confidence.ts` (`checkNamesPreserved`, `checkPronounPattern`).

### 3.4 Reasoning-Token Stripping & Proposal UI
- **Reasoning Stripping (`src/ai/llm/parseJson.ts` & `src/ai/llm/client.ts`):**
  - `stripThinking(raw)` extracts `<think>…</think>`, `<thinking>…</thinking>`, `<reasoning>…</reasoning>` (plus unclosed trailing open tags if cut off mid-thought) out of `content`.
  - Combined with provider-native `msg.reasoning` / `msg.reasoning_content` / Anthropic `thinking` blocks, stored on `DebugSink.reasoning`, and surfaced in `AIPanel.tsx` only when the **Debug** toggle is enabled.
  - JSON-producing L1 actions call `extractJson()` (handles raw JSON, ```` ```json ```` fences, and balanced `{}`/`[]` scanning) with a single automatic repair-prompt retry on parse failure.
- **Accept / Reject Proposal Cards (`src/ui/AIPanel.tsx`):**
  - `AIPanel` maintains `TranscriptTurn[]` (scoped per novel, reset on `project?.id` change).
  - Each `WriteOpProposal` (or `TextResult.suggestedOp`) is rendered as an inline-editable `TranscriptCard` (for `character_add`, `character_update`, `location_add`, `location_update`, `style_set`, `append_continuity`, `continuity_set`, `replace_range`, `insert_beat`).
  - Users can edit proposed fields directly in the card and click **Accept / Replace / Insert** (`handleAcceptCard` → `onExecuteWriteOp` → `executeWriteOp`), **Reject / Keep mine / Discard** (`handleRejectCard`), or **Retry** (`handleRetry`).
  - `check_continuity` returns `{ type: 'report', items: ReportItem[] }` rendered as severity-badged (`high` / `medium` / `low`) conflict cards rather than write-ops.
  - Entry points into `AIPanel`: top-right Sparkles button in `EditorCanvas.tsx`, floating `SelectionAIToolbar.tsx` (selections ≥ 10 words; `< 10` words opens `QuickCreateDialog.tsx` for zero-AI Bible creation), clicking a `BeatAnchor` (`Mod-Shift-B` or toolbar), or `Cmd/Ctrl+J`.

---

## 4. Extension Seam Analysis

### Seam A: Local Disk Folder Sync (File System Access API + YAML Frontmatter)
- **Current Storage Boundary:**
  - `src/storage/ProjectStorage.ts` already defines a clean path-keyed async interface (`readFile`, `writeFile`, `deleteFile`, `listFiles`, `exists`), and every data consumer (`snapshots.ts`, `aiConfig.ts`, `ExportImportDialog.tsx`, `RestoreDeletedChaptersDialog.tsx`, `src/ai/actions/*`, `src/ai/writeOps/*`) interacts solely through `ProjectStorage`.
  - **Coupling to address:** `src/app/page.tsx:240` hardcodes `new IndexedDBProjectStorage()` on mount, and writes occur from multiple handlers in `page.tsx`, `snapshots.ts`, and `ai/writeOps/*` without a centralized event bus or dirty-file queue.
- **Recommended Hook Points:**
  1. **Decorating / Syncing Adapter (`SyncingProjectStorage` implementing `ProjectStorage`):** Wrap `IndexedDBProjectStorage` so IndexedDB remains the instant, universal primary store (preserving `file://`, mobile, Safari, and Firefox support), while a secondary `DiskFolderSync` engine mirrors project paths (`projects/{projectId}/...`) to/from a user-granted `FileSystemDirectoryHandle`.
  2. **Handle Persistence:** Store the `FileSystemDirectoryHandle` directly in a dedicated IndexedDB object store (structured-cloneable in Chromium; requires bumping `DB_NAME = 'xnovelist'` version from `1` to `2` in `IndexedDBProjectStorage.ts`) and re-verify `queryPermission` / `requestPermission({ mode: 'readwrite' })` on user gesture.
  3. **Frontmatter & Serialization Boundary:**
     - `Artifacts/chapter-{id}.md` currently stores plain Markdown (first line `# Title`, plus optional `:::beat{id}` tokens). A pure `frontmatter.ts` codec can inject/strip YAML frontmatter (`id`, `title`, `status`, `order`, `updatedAt`, `synopsis`) when writing/reading disk Markdown files while keeping Tiptap's `initialMarkdown` and `Beats.json` clean—or optionally embedding beat metadata.
     - Structured JSON files (`Project.json`, `Characters.json`, `Locations.json`, `Items.json`, `Style.json`, `Beats.json`) can either sync as JSON or alongside human-readable Markdown views.
  4. **Security & Sync Controls:** Explicitly exclude `workspace/ai.json` (API keys) and `.history/` (optional) from folder sync, surface a sync-status/folder-link control in `ProjectSettings.tsx` (`activeTab === 'settings'`) or the workspace header in `src/app/page.tsx`, and record per-path `lastModified` / `contentHash` metadata in IDB to resolve two-way disk-vs-IDB edits cleanly.

### Seam B: Spatial Brainstorming Corkboard
- **Current Navigation & Layout Shell:**
  - `src/app/page.tsx` controls workspace views via `activeTab: 'editor' | 'outline' | 'bible' | 'settings'` (rendered in the desktop header tab switcher at lines `1656-1689` and mobile "More" bottom sheet at lines `2113-2124`).
  - `src/ui/OutlineGrid.tsx` already demonstrates a grid-based card workspace (`chapters`, drag-and-drop reordering, status chips, synopses).
  - `src/onboarding/tours.ts` and `src/i18n/ui/{en,vi}.json` define surface names and labels.
- **Recommended Hook Points:**
  1. **Workspace Tab & Shell (`src/app/page.tsx`):** Extend `activeTab` to `'editor' | 'outline' | 'corkboard' | 'bible' | 'settings'` and mount a dedicated `<CorkboardCanvas />` component (pan/zoom SVG+HTML spatial canvas, zero external heavy graph library required unless desired). Add corresponding tab button in `header` and entry in the mobile `More` sheet.
  2. **Persistence Schema (`src/storage/schemas.ts`):** Add `CorkboardSchema` (`schemaVersion: 1`, `cards[]` with `id`, `title`, `body`, `type`, `color`, `x`, `y`, `width?`, `tags[]`, `promotedRef?: { kind, id }`, and `edges[]` with `id`, `fromCardId`, `toCardId`, `label?`, `style?`), persisted at `projects/${projectId}/Corkboard.json` and loaded/saved inside `handleOpenProject` in `src/app/page.tsx`.
  3. **One-Click "Promote to Story Bible / Chapter Outline" Flow:**
     - **To Story Bible:** `src/app/page.tsx` already holds state setters and persistence writers for `characters`, `locations`, `items` (lines `2021-2035`), and `executeWriteOp` (`character_add`, `location_add`). Expose a `handlePromoteCardToBible(card, targetType)` callback (or reuse `executeWriteOp` / direct schema append) that creates the Bible entity, marks `card.promotedRef`, and optionally jumps to `activeTab = 'bible'` with that entity selected.
     - **To Chapter Outline:** Reuse `handleCreateChapter` logic in `src/app/page.tsx:761-789` (parameterized to accept `{ title, synopsis, initialBody }`), creating `Artifacts/chapter-{id}.md`, appending to `project.chapterOrder` and `project.chapters` (visible immediately in `OutlineGrid.tsx` and `ChapterList.tsx`), and optionally seeding `Continuity/chapter-{id}.md` from the card's summary.

### Seam C: World Rules & Continuity Engine
- **Current Story Bible & Prompt Architecture:**
  - `src/bible/BibleWorkspace.tsx` manages tabs `'characters' | 'locations' | 'items' | 'style' | 'continuity'`. Notably, `Items` was previously added as a 3rd entity category (in `schemas.ts`, `page.tsx`, `BibleWorkspace.tsx`, and `bibleLinkage.ts`), giving an exact blueprint for adding another category—while revealing two gaps in the existing codebase: `Items` is **not** wired into `src/ai/prompts/buildPrompt.ts` or `src/ai/actions/checkContinuity.ts`, and `QuickCreateDialog.tsx` only offers `+ Character` / `+ Location`.
  - `src/ai/prompts/buildPrompt.ts` (`buildEditorPrompt`, lines `189-344`) injects `Style.json`, matched `Characters.json`, matched `Locations.json`, and `Continuity/chapter-${prevId}.md` within a 6,000-token trimming budget.
  - `src/ai/actions/checkContinuity.ts` (`readBibleContext`, lines `9-42`) reads `Characters.json` and `Locations.json` + preceding continuity, calls `buildPrompt('check_continuity', ...)` using `src/ai/prompts/packs/{en,vi}.json`, and returns structured `{ severity, statement, conflict }[]` flags.
- **Recommended Hook Points:**
  1. **Schema & Storage (`src/storage/schemas.ts`, `src/app/page.tsx`):** Add `WorldRuleSchema` and `WorldRulesSchema` (`schemaVersion: 1`, `rules: WorldRule[]` with `id`, `title`, `category` e.g. `'physics' | 'ftl' | 'biology' | 'society' | 'tech' | 'magic' | 'constraint'`, `statement`, `constraints[]`, `exceptions?`, `keywords[]`, `alwaysActive: boolean`, `severity: 'hard' | 'soft'`, `evidence[]`), persisted at `projects/${projectId}/WorldRules.json` (and seeded on project creation with graceful fallback for legacy projects, mirroring `Items.json` at `src/app/page.tsx:577-584`).
  2. **Story Bible UI & Quick-Link (`src/bible/BibleWorkspace.tsx`, `src/editor/bibleLinkage.ts`):** Add a `'rules'` tab (`World Rules & Physics`) to `BibleWorkspace.tsx` with CRUD editor, active/hard-vs-soft toggles, and keyword triggers; optionally extend `bibleLinkage.ts` to underline rule trigger terms in the editor.
  3. **AI Write-Ops & Extraction (`src/ai/writeOps/`, `src/ai/actions/`):** Add `world_rule_add` / `world_rule_update` write-ops to `src/ai/writeOps/registry.ts` (plus card editors in `AIPanel.tsx`), and optionally a Level 1 `capture_world_rules` action in `src/ai/levels/level1.ts`.
  4. **Drafting & Review Prompt Injection (`src/ai/prompts/buildPrompt.ts`, `src/ai/actions/checkContinuity.ts`, `src/ai/prompts/packs/*.json`):**
     - In `buildEditorPrompt()`: Load `WorldRules.json`; include all rules with `alwaysActive === true` **plus** any rules whose `title` or `keywords` match `beforeText + selectionText + afterText`, formatted as a `=== WORLD RULES & CONSTRAINTS ===` block placed alongside `STYLE PROFILE` so Level 2 rewrites and Level 3 `write_beat` / `continue` prose respect hard constraints. Update the 3-step token-trimming ladder so `hard` / `alwaysActive` rules are preserved longest before compacting.
     - In `checkContinuity.ts`: Extend `readBibleContext()` (and optionally `check_continuity` prompt text in `en.json` / `vi.json`) to inject active `WorldRules.json` rules (and `Items.json`) so continuity checks flag physical/world-rule violations (e.g., FTL travel times, thermodynamic/comms limits, timeline paradoxes) with `high` severity and exact rule citations in `conflict`.
