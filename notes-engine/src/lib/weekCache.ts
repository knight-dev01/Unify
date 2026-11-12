// In-memory cache of assembled weeks (shell + latest topics + author badges).
// The reader, share links, course progress, Revision and the games all ask for
// the same weeks over and over; each assembly is several database round trips.
// Entries live 60 s, concurrent asks share one load, a failed load is never
// kept, and any successful write that could touch notes clears everything
// (server.ts). Render runs one instance, so one process-wide cache is coherent.
const TTL_MS = 60_000;
const MAX_ENTRIES = 400;
const store = new Map<string, { at: number; value: Promise<unknown> }>();

export function cachedWeek<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  if (store.size >= MAX_ENTRIES) store.clear();
  const value = load();
  store.set(key, { at: now, value });
  value.catch(() => { if (store.get(key)?.value === value) store.delete(key); });
  return value;
}

export function bustWeekCache(): void {
  store.clear();
}

// Paths whose successful writes may change what a week shows.
export const NOTE_WRITE = /(note|topic|week|publish|content|seed|course|studio|save|upload|convert)/i;
