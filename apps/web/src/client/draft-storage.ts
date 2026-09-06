// Only explicit local work is durable. Native history, authentication and query
// caches never enter this database. IndexedDB already partitions by origin.
export const DRAFT_BUDGET_BYTES = 256 * 1_024 * 1_024;
export interface LocalDocument<T = unknown> {
  id: string;
  scope: string;
  kind: "draft" | "operation";
  revision: number;
  updatedAt: number;
  bytes: number;
  value: T;
}
const DATABASE = "leo-local-work";
let database: Promise<IDBDatabase> | undefined;
export function openDraftDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Local draft storage is unavailable in this browser")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("work", { keyPath: ["scope", "id"] });
      store.createIndex("scope", "scope");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      db.onclose = () => { database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Close other older app windows to enable draft storage")); };
  });
  return database;
}
export async function documents<T = unknown>(scope: string): Promise<LocalDocument<T>[]> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("work", "readonly").objectStore("work").index("scope").getAll(scope);
    request.onsuccess = () => resolve(request.result as LocalDocument<T>[]);
    request.onerror = () => reject(request.error);
  });
}
export async function readDocument<T>(scope: string, id: string): Promise<LocalDocument<T> | undefined> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("work", "readonly").objectStore("work").get([scope, id]);
    request.onsuccess = () => resolve(request.result as LocalDocument<T> | undefined);
    request.onerror = () => reject(request.error);
  });
}
export function documentBytes(value: unknown): number {
  if (value instanceof Blob) return value.size;
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (Array.isArray(value)) return value.reduce((size, entry) => size + documentBytes(entry), 0);
  if (value && typeof value === "object") return Object.entries(value).reduce((size, [key, entry]) => size + documentBytes(key) + documentBytes(entry), 0);
  return 8;
}
export function checkDraftBudget(existingBytes: number, previousBytes: number, nextBytes: number): void {
  if (existingBytes - previousBytes + nextBytes > DRAFT_BUDGET_BYTES) throw new Error("Local drafts exceed 256 MiB. Delete saved drafts or attachments before saving more; this draft remains in this window.");
}
// The comparison and aggregate budget check share one read/write transaction,
// including across tabs. Conflicting edits become an explicit preserved copy.
export async function writeDocument<T>(scope: string, id: string, kind: LocalDocument["kind"], value: T, revision: number, conflictId?: string): Promise<{ document: LocalDocument<T>; conflict: boolean }> {
  const db = await openDraftDatabase();
  const bytes = documentBytes(value);
  return new Promise((resolve, reject) => {
    const tx = db.transaction("work", "readwrite");
    const store = tx.objectStore("work");
    let result: { document: LocalDocument<T>; conflict: boolean };
    let failure: unknown;
    const request = store.getAll();
    request.onsuccess = () => {
      try {
        const all = request.result as LocalDocument[];
        const previous = all.find((entry) => entry.scope === scope && entry.id === id);
        const conflict = (previous?.revision ?? 0) !== revision;
        if (conflict && !conflictId) throw new Error("This saved operation changed in another window. Reload and check its receipt before continuing.");
        const targetId = conflict ? conflictId! : id;
        checkDraftBudget(all.reduce((size, entry) => size + entry.bytes, 0), conflict ? 0 : previous?.bytes ?? 0, bytes);
        const document: LocalDocument<T> = { id: targetId, scope, kind, revision: conflict ? 1 : revision + 1, updatedAt: Date.now(), bytes, value };
        store.put(document);
        result = { document, conflict };
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("Unable to save local work"));
    tx.onerror = () => { /* abort owns the final error */ };
  });
}
export async function removeDocument(scope: string, id: string): Promise<void> {
  const db = await openDraftDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("work", "readwrite");
    tx.objectStore("work").delete([scope, id]);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
