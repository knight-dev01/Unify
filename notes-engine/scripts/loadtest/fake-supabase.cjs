// A stand-in for Supabase (Auth + PostgREST + Storage) with realistic latency, so the real API
// server can be load-tested without touching the real database.
const http = require('http');
const LAT = Number(process.env.LAT || 60);
let authCalls = 0, restCalls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = { id: 'u-demo', role: 'student', first_name: 'Ada', email: 'a@x.com', university: 'LASU', faculty: 'Eng', department: 'Chem', level: '200 Level', university_id: null, avatar_url: '', semester: 'First Semester', onboarded: true, cgpa_target: 3.5, grad_target: null, email_confirmed: true, attendance_full_name: 'Ada A', attendance_matric: '12345' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  await sleep(LAT + Math.random() * 20);
  res.setHeader('content-type', 'application/json');
  if (u.pathname === '/__stats') return res.end(JSON.stringify({ authCalls, restCalls }));
  if (u.pathname.startsWith('/auth/v1/user')) {
    authCalls++;
    const tok = (req.headers.authorization || '').slice(7);
    const sub = tok.split('.')[1] ? Buffer.from(tok.split('.')[1], 'base64url').toString() : '{}';
    let id = 'u-demo'; try { id = JSON.parse(sub).sub || id; } catch {}
    return res.end(JSON.stringify({ id, aud: 'authenticated', email: id + '@x.com', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }));
  }
  if (u.pathname.startsWith('/rest/v1/')) {
    restCalls++;
    const accept = req.headers.accept || '';
    if (req.method === 'HEAD') { res.setHeader('content-range', '0-0/3'); res.statusCode = 200; return res.end(); }
    if (req.method !== 'GET') { res.statusCode = 201; return res.end('[]'); }
    if (accept.includes('pgrst.object')) return res.end(JSON.stringify(profile));
    if (u.pathname.endsWith('/app_settings')) return res.end(JSON.stringify([{ value: 'First Semester' }]));
    return res.end('[]');
  }
  res.statusCode = 200; res.end('{}');
}).listen(54321, () => console.log('fake supabase on 54321'));
