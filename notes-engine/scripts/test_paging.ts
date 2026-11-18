// Scalability check for lib/paging (no database): a fake table that, like
// Supabase, returns at most 1,000 rows per request. Run: npm run test:paging
import assert from "node:assert/strict";
import { inChunks, pageAll, PAGE, IN_CHUNK } from "../src/lib/paging";

const MAX_ROWS = 1000; // Supabase's API page cap
let requests = 0;
function fakeTable(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: `u${String(i).padStart(6, "0")}`, n: i }));
  return (from: number, to: number, filter?: Set<string>) => {
    requests++;
    const src = filter ? rows.filter((r) => filter.has(r.id)) : rows;
    return Promise.resolve({ data: src.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null });
  };
}

(async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500, 10000]) {
    requests = 0;
    const t = fakeTable(n);
    const got = await pageAll((f, to) => t(f, to));
    assert.equal(got.length, n, `pageAll lost rows at n=${n}`);
    // Requests grow linearly with n / PAGE (one extra when n is a multiple).
    assert.ok(requests <= Math.floor(n / PAGE) + 1, `pageAll made ${requests} requests at n=${n}`);
    console.log(`pageAll n=${n}: ${got.length} rows in ${requests} request(s)`);
  }
  // 1,050 ids, each with 3 rows (e.g. 3 devices): 3,150 rows, chunked + paged.
  const ids = Array.from({ length: 1050 }, (_, i) => `x${i}`);
  const rows = ids.flatMap((id) => [0, 1, 2].map((k) => ({ id, k })));
  requests = 0;
  let maxChunk = 0;
  const got = await inChunks(ids, (chunk, from, to) => {
    requests++;
    maxChunk = Math.max(maxChunk, chunk.length);
    const set = new Set(chunk);
    const src = rows.filter((r) => set.has(r.id));
    return Promise.resolve({ data: src.slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null });
  });
  assert.equal(got.length, rows.length, "inChunks lost rows");
  assert.ok(maxChunk <= IN_CHUNK, "inChunks sent too many ids in one request");
  console.log(`inChunks ${ids.length} ids: ${got.length} rows in ${requests} request(s), at most ${maxChunk} ids each`);
  console.log("paging: all checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
