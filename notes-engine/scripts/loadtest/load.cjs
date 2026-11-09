// 100 simulated students, each with their own session, using the app like a real morning:
// open Home (me + courses + updates + timetable), then poll/browse for the run time.
const BASE = process.env.BASE || 'http://localhost:3099';
const USERS = Number(process.env.USERS || 100);
const SECS = Number(process.env.SECS || 30);
const THINK = Number(process.env.THINK || 1200); // ms between actions per user
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const exp = Math.floor(Date.now() / 1000) + 3600;
const tokenFor = (i) => `${b64({ alg: 'HS256' })}.${b64({ sub: 'user-' + i, exp })}.sig`;
const lat = {}; let errors = 0, limited = 0, total = 0; const codes = {};
const rec = (name, ms, status) => { (lat[name] ||= []).push(ms); total++; codes[status] = (codes[status] || 0) + 1; if (status === 429) limited++; else if (status >= 500 || status === 0) errors++; };
async function call(name, path, tok, opt = {}) {
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + path, { headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json', 'accept-encoding': 'gzip' }, ...opt });
    await r.arrayBuffer();
    rec(name, performance.now() - t0, r.status);
  } catch { rec(name, performance.now() - t0, 0); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function user(i, until) {
  const tok = tokenFor(i);
  await sleep(Math.random() * 3000); // arrivals spread over 3 s
  while (Date.now() < until) {
    await Promise.all([call('GET /v1/me', '/v1/me', tok), call('GET /v1/updates', '/v1/updates', tok), call('GET /v1/timetable', '/v1/timetable?course=CHE201', tok)]);
    await sleep(THINK * (0.5 + Math.random()));
    await call('GET /v1/attendance/mine', '/v1/attendance/mine', tok);
    await sleep(THINK * (0.5 + Math.random()));
    await call('GET /v1/materials', '/v1/materials?course=CHE201', tok);
    await sleep(THINK * (0.5 + Math.random()));
  }
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
(async () => {
  const until = Date.now() + SECS * 1000;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => user(i, until)));
  const secs = (Date.now() - t0) / 1000;
  console.log(`users=${USERS} duration=${secs.toFixed(0)}s requests=${total} rps=${(total / secs).toFixed(1)} 5xx/failed=${errors} 429=${limited}`);
  console.log('status codes', JSON.stringify(codes));
  for (const [k, v] of Object.entries(lat)) console.log(k.padEnd(26), 'n=' + String(v.length).padStart(5), 'p50=' + Math.round(pct(v, 50)) + 'ms', 'p95=' + Math.round(pct(v, 95)) + 'ms', 'max=' + Math.round(Math.max(...v)) + 'ms');
})();
