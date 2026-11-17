import { ProjectStorage } from './ProjectStorage';
import { IndexedDBProjectStorage } from './IndexedDBProjectStorage';
import { DiskFolderSync } from './diskSync';

const DEBOUNCE_MS = 800;

/**
 * Write-through ProjectStorage decorator wrapping IndexedDBProjectStorage.
 * Every read/write immediately hits IndexedDB with zero latency, while project
 * writes/deletes (excluding `.history/` and `workspace/ai.json`) enqueue a
 * debounced 800ms flush to DiskFolderSync.
 */
export class SyncingProjectStorage implements ProjectStorage {
  readonly idb: IndexedDBProjectStorage;
  private diskSync: DiskFolderSync;
  private activeProjectId: string | null = null;
  private dirtyPathsByProject = new Map<string, Set<string>>();
  private timersByProject = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(idb: IndexedDBProjectStorage, diskSync: DiskFolderSync) {
    this.idb = idb;
    this.diskSync = diskSync;
  }

  setActiveProjectId(projectId: string | null): void {
    this.activeProjectId = projectId;
  }

  async readFile(path: string): Promise<string | null> {
    return this.idb.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.idb.writeFile(path, content);
    this.enqueuePathIfSyncable(path);
  }

  async deleteFile(path: string): Promise<void> {
    await this.idb.deleteFile(path);
    this.enqueuePathIfSyncable(path);
  }

  async listFiles(prefix?: string): Promise<string[]> {
    return this.idb.listFiles(prefix);
  }

  async exists(path: string): Promise<boolean> {
    return this.idb.exists(path);
  }

  private enqueuePathIfSyncable(path: string): void {
    if (!path.startsWith('projects/')) return;
    if (path.includes('/.history/') || path.endsWith('/.history')) return;
    if (path === 'workspace/ai.json' || path.endsWith('/workspace/ai.json')) return;

    const rest = path.slice('projects/'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return;

    const projectId = rest.slice(0, slashIdx);
    const relPath = rest.slice(slashIdx + 1);
    if (!relPath) return;

    // Only auto-flush writes for the currently active linked project
    if (this.activeProjectId && projectId !== this.activeProjectId) return;

    let set = this.dirtyPathsByProject.get(projectId);
    if (!set) {
      set = new Set<string>();
      this.dirtyPathsByProject.set(projectId, set);
    }
    set.add(relPath);

    const existingTimer = this.timersByProject.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.timersByProject.delete(projectId);
      void this.flushProject(projectId);
    }, DEBOUNCE_MS);

    this.timersByProject.set(projectId, timer);
  }

  async flushProject(projectId: string): Promise<void> {
    const existingTimer = this.timersByProject.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.timersByProject.delete(projectId);
    }

    const set = this.dirtyPathsByProject.get(projectId);
    if (!set || set.size === 0) return;

    const paths = Array.from(set);
    set.clear();
    await this.diskSync.flushPaths(projectId, paths);
  }

  async flushAll(): Promise<void> {
    const projectIds = Array.from(
      new Set([...this.timersByProject.keys(), ...this.dirtyPathsByProject.keys()])
    );
    for (const pid of projectIds) {
      await this.flushProject(pid);
    }
  }
}
