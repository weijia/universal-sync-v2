import { IFileSystem, StoredDocument, SyncOptions } from '../types.js';
import { StorageManager } from './storage-manager.js';

/**
 * Save a single document (StoredDocument) to the target filesystem using
 * StorageManager internals (partitioning, chunking, manifest updates).
 * This function wraps StorageManager to provide a small, focused API for
 * saving individual documents without running the whole SyncEngine.
 */
export async function saveDocumentToFs(
  fs: IFileSystem,
  basePath: string,
  doc: StoredDocument,
  options?: Partial<SyncOptions>
): Promise<void> {
  const opts: Required<SyncOptions> = {
    basePath,
    maxFileSize: 200 * 1024,
    mergeThreshold: 50 * 1024,
    mergeInterval: 60000,
    autoMerge: false,
    ...options,
  } as Required<SyncOptions>;

  const manager = new StorageManager(fs, opts);
  await manager.initialize();

  // StorageManager.writeDocuments accepts an array of StoredDocument
  await manager.writeDocuments([doc]);
}
