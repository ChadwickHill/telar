import { openDB, IDBPDatabase } from 'idb';
import { ProjectStorage } from './ProjectStorage';

const DB_NAME = 'xnovelist';
const DB_VERSION = 2;
const STORE_NAME = 'files';
const HANDLES_STORE_NAME = 'handles';

export interface StoredFolderHandle {
  dirHandle: FileSystemDirectoryHandle;
  folderName: string;
}

export class IndexedDBProjectStorage implements ProjectStorage {
  private dbPromise: Promise<IDBPDatabase>;

  constructor() {
    this.dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
        if (!db.objectStoreNames.contains(HANDLES_STORE_NAME)) {
          db.createObjectStore(HANDLES_STORE_NAME);
        }
      },
    });
  }

  async readFile(path: string): Promise<string | null> {
    const db = await this.dbPromise;
    const value = await db.get(STORE_NAME, path);
    return value !== undefined ? value : null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORE_NAME, content, path);
  }

  async deleteFile(path: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORE_NAME, path);
  }

  async listFiles(prefix?: string): Promise<string[]> {
    const db = await this.dbPromise;
    const keys = await db.getAllKeys(STORE_NAME) as string[];
    if (prefix) {
      return keys.filter((key) => key.startsWith(prefix));
    }
    return keys;
  }

  async exists(path: string): Promise<boolean> {
    const db = await this.dbPromise;
    const count = await db.count(STORE_NAME, path);
    return count > 0;
  }

  async saveFolderHandle(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.dbPromise;
    const record: StoredFolderHandle = {
      dirHandle: handle,
      folderName: handle.name,
    };
    await db.put(HANDLES_STORE_NAME, record, projectId);
  }

  async getFolderHandle(projectId: string): Promise<StoredFolderHandle | null> {
    const db = await this.dbPromise;
    const record = await db.get(HANDLES_STORE_NAME, projectId) as StoredFolderHandle | undefined;
    return record ?? null;
  }

  async deleteFolderHandle(projectId: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(HANDLES_STORE_NAME, projectId);
  }
}
