import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from './sqlite-driver.mjs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { spawn } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA, 'uploads');
const DOWNLOAD_DIR = path.join(DATA, 'downloads');
const PUBLIC = path.join(ROOT, 'public');
for (const d of [DATA, UPLOAD_DIR, DOWNLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

// Small dependency-free .env parser; values may be quoted.
try {
  const content = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || Object.hasOwn(process.env, m[1])) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }

const env = process.env;
const PORT = Number(env.PORT || 3000);
const BASE = (env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_BASE = (env.PUBLIC_BASE_URL || BASE).replace(/\/$/, '');
const GRAPH = `https://graph.instagram.com/${/^v\d+\.\d+$/.test(env.GRAPH_VERSION || '') ? env.GRAPH_VERSION : 'v27.0'}`;
const MAX_UPLOAD = 250 * 1024 * 1024;
const MAX_DOWNLOAD = 250 * 1024 * 1024;
const YT_DLP = env.YT_DLP_BIN || 'yt-dlp';
const SESSION_TTL = 8 * 60 * 60 * 1000;
const now = () => Date.now();
const isoNow = () => new Date().toISOString();

const ENC_KEY = (() => {
  try { const b = Buffer.from(env.ENCRYPTION_KEY || '', 'base64'); return b.length === 32 ? b : null; }
  catch { return null; }
})();
const SESSION_SECRET = env.SESSION_SECRET || '';
if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.startsWith('CHANGE_ME') || !ENC_KEY || SESSION_SECRET.length < 32 || SESSION_SECRET.startsWith('CHANGE_ME')) {
  console.error('Set ADMIN_PASSWORD, ENCRYPTION_KEY (32 random bytes in base64), and SESSION_SECRET (>=32 random chars) in .env. See README.md.');
  process.exit(1);
}
const protect = plaintext => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
};
const reveal = encoded => {
  const data = Buffer.from(encoded, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
};
const db = new DatabaseSync(path.join(DATA, 'studio.sqlite'));
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, account_type TEXT,
    token_ciphertext TEXT NOT NULL, token_expires_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN ('image','reel')),
    media_url TEXT NOT NULL, caption TEXT NOT NULL,
    scheduled_at TEXT NOT NULL, status TEXT NOT NULL,
    container_id TEXT, published_media_id TEXT, permalink TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_posts_schedule ON posts(status, scheduled_at);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY, source_url TEXT NOT NULL, status TEXT NOT NULL,
    filename TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`);
// An interrupted publish request could already have succeeded. Never auto-retry those.
db.prepare("UPDATE posts SET status='scheduled', updated_at=? WHERE status='processing'").run(isoNow());
db.prepare("UPDATE posts SET status='needs_review', last_error='Server restarted during publication. Check Instagram manually; do not blindly retry.', updated_at=? WHERE status='publishing'").run(isoNow());
db.prepare("UPDATE downloads SET status='failed', last_error='Download interrupted by a restart. Please try again.', updated_at=? WHERE status IN ('queued','downloading')").run(isoNow());

class HttpError extends Error { constructor(code, message) { super(message); this.code = code; } }
function json(res, status, payload, headers = {}) {
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(buf);
}
function redirect(res, url, extra = {}) { res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', ...extra }); res.end(); }
function failIf(condition, status, message) { if (condition) throw new HttpError(status, message); }
function checkOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && origin !== new URL(BASE).origin) throw new HttpError(403, 'Invalid request origin. Check APP_BASE_URL.');
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const idx = s.indexOf('='); return [s.slice(0, idx), s.slice(idx + 1)];
  }));
}
function signature(token) { return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('base64url'); }
function sessionHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function sessionToken(req) {
  const value = cookies(req).studio_session;
  if (!value) return null;
  const split = value.split('.');
  if (split.length !== 2) return null;
  const [token, sig] = split;
  const expected = signature(token);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const record = db.prepare('SELECT 1 FROM sessions WHERE hash=? AND expires_at>?').get(sessionHash(token), now());
  return record ? token : null;
}
function authorize(req) { failIf(!sessionToken(req), 401, 'Please sign in first.'); }
function setSessionCookie(token, maxAge = 8 * 60 * 60) {
  const secure = new URL(BASE).protocol === 'https:' ? '; Secure' : '';
  return `studio_session=${token ? `${token}.${signature(token)}` : ''}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}
async function bodyJson(req, limit = 40_000) {
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}
const publicAccount = a => ({ id: a.id, username: a.username, accountType: a.account_type || 'Professional', tokenExpiresAt: a.token_expires_at });
const publicPost = p => ({ id: p.id, accountId: p.account_id, username: p.username, kind: p.kind, mediaUrl: p.media_url, caption: p.caption, scheduledAt: p.scheduled_at, status: p.status, permalink: p.permalink, publishedMediaId: p.published_media_id, lastError: p.last_error, createdAt: p.created_at });
const postsQuery = `SELECT p.*, a.username FROM posts p LEFT JOIN accounts a ON a.id=p.account_id`;
function assertMediaUrl(input) {
  failIf(typeof input !== 'string' || input.length > 2048, 400, 'Enter a valid media URL.');
  let u;
  try { u = new URL(input); } catch { throw new HttpError(400, 'Enter a valid media URL.'); }
  failIf(u.protocol !== 'https:' || u.username || u.password, 400, 'Media URL must be a public HTTPS URL.');
  failIf(!u.hostname || u.hostname === 'localhost' || u.hostname.endsWith('.local'), 400, 'Media must be publicly accessible over HTTPS.');
  return u.href;
}
function assertInstagramVideoUrl(input) {
  let u;
  try { u = new URL(input); } catch { throw new HttpError(400, 'Enter an Instagram video link.'); }
  failIf(u.protocol !== 'https:' || !['www.instagram.com','instagram.com','m.instagram.com'].includes(u.hostname) || u.username || u.password, 400, 'Only public HTTPS instagram.com post, reel, or TV links are supported.');
  failIf(!/^\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname), 400, 'Use a direct Instagram Reel or video post link.');
  return `https://www.instagram.com${u.pathname}`;
}
function metaError(payload, responseStatus) {
  const detail = payload?.error?.message || payload?.error_message || payload?.message || `Meta returned HTTP ${responseStatus}`;
  return String(detail).slice(0, 700);
}
async function metaRequest(url, { method = 'GET', params = {}, token, timeout = 35_000 } = {}) {
  let target = new URL(url);
  let data = new URLSearchParams({ ...params, access_token: token });
  const options = { method, signal: AbortSignal.timeout(timeout) };
  if (method === 'GET') target.search = data.toString();
  else { options.body = data; options.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  const response = await fetch(target, options);
  const raw = await response.text();
  let result = {}; try { result = JSON.parse(raw); } catch { /* A gateway may return plain text */ }
  if (!response.ok || result.error) throw new Error(metaError(result, response.status));
  return result;
}
async function getProfile(token) { return metaRequest(`${GRAPH}/me`, { params: { fields: 'id,user_id,username,account_type' }, token }); }
async function exchangeOAuthCode(code) {
  const params = new FormData();
  for (const [key, value] of Object.entries({ client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: 'authorization_code', redirect_uri: env.INSTAGRAM_REDIRECT_URI, code })) params.set(key, value);
  const response = await fetch('https://api.instagram.com/oauth/access_token', { method: 'POST', body: params, signal: AbortSignal.timeout(35_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(metaError(data, response.status));
  const short = Array.isArray(data.data) ? data.data[0] : data;
  if (!short?.access_token) throw new Error('Meta returned no Instagram access token.');
  const long = await metaRequest('https://graph.instagram.com/access_token', { params: { grant_type: 'ig_exchange_token', client_secret: env.INSTAGRAM_APP_SECRET }, token: short.access_token });
  return { short, long };
}
async function refreshAccount(account) {
  const token = reveal(account.token_ciphertext);
  const refreshed = await metaRequest('https://graph.instagram.com/refresh_access_token', { params: { grant_type: 'ig_refresh_token' }, token });
  const expiry = new Date(now() + Number(refreshed.expires_in || 5_184_000) * 1000).toISOString();
  db.prepare('UPDATE accounts SET token_ciphertext=?, token_expires_at=?, updated_at=? WHERE id=?').run(protect(refreshed.access_token), expiry, isoNow(), account.id);
  return refreshed.access_token;
}
async function accountToken(account) {
  const expiry = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (expiry && expiry < now()) throw new Error('Instagram token expired. Reconnect the account in Settings.');
  // Instagram long-lived tokens should be refreshed before expiry, but after their first 24h.
  if (expiry && expiry - now() < 14 * 86400000 && now() - new Date(account.updated_at).getTime() > 86400000) {
    try { return await refreshAccount(account); }
    catch (e) { console.warn(`Token refresh for ${account.username}: ${e.message}`); }
  }
  return reveal(account.token_ciphertext);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function setPostStatus(id, status, extra = {}) {
  const fields = ['status=?', 'updated_at=?'];
  const values = [status, isoNow()];
  for (const [key, value] of Object.entries(extra)) { fields.push(`${key}=?`); values.push(value); }
  db.prepare(`UPDATE posts SET ${fields.join(', ')} WHERE id=?`).run(...values, id);
}
const inProgress = new Set();
async function publishPost(id) {
  let post = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!post) return;
  const account = db.prepare('SELECT * FROM accounts WHERE id=?').get(post.account_id);
  if (!account) { setPostStatus(id, 'failed', { last_error: 'Instagram account is disconnected.' }); return; }
  try {
    const token = await accountToken(account);
    let containerId = post.container_id;
    if (!containerId) {
      const payload = post.kind === 'reel'
        ? { media_type: 'REELS', video_url: post.media_url, caption: post.caption, share_to_feed: 'true' }
        : { image_url: post.media_url, caption: post.caption };
      const result = await metaRequest(`${GRAPH}/${account.id}/media`, { method: 'POST', params: payload, token, timeout: 90_000 });
      if (!result.id) throw new Error('Meta did not return a media container ID.');
      containerId = String(result.id);
      setPostStatus(id, 'processing', { container_id: containerId });
    }
    let ready = false;
    for (let i = 0; i < 36; i++) {
      const status = await metaRequest(`${GRAPH}/${containerId}`, { params: { fields: 'status_code,status' }, token });
      if (status.status_code === 'FINISHED') { ready = true; break; }
      if (['ERROR', 'EXPIRED'].includes(status.status_code)) throw new Error(`Instagram rejected media: ${status.status || status.status_code}`);
      await sleep(10_000);
    }
    if (!ready) throw new Error('Instagram did not finish processing the media within 6 minutes. Retry later.');
    // Crash/network failure after sending media_publish has an ambiguous outcome.
    // Keep this state for manual review rather than risking a duplicate post.
    setPostStatus(id, 'publishing');
    const published = await metaRequest(`${GRAPH}/${account.id}/media_publish`, { method: 'POST', params: { creation_id: containerId }, token, timeout: 90_000 });
    if (!published.id) throw new Error('Publish response did not contain an Instagram media ID. Check Instagram before retrying.');
    setPostStatus(id, 'published', { published_media_id: String(published.id), last_error: null });
    try {
      const detail = await metaRequest(`${GRAPH}/${published.id}`, { params: { fields: 'permalink' }, token });
      if (detail.permalink) setPostStatus(id, 'published', { permalink: String(detail.permalink) });
    } catch { /* Publishing succeeded; permalink is optional. */ }
    console.log(`[publish] published ${id} as ${published.id}`);
  } catch (err) {
    const current = db.prepare('SELECT status FROM posts WHERE id=?').get(id);
    const ambiguous = current?.status === 'publishing';
    setPostStatus(id, ambiguous ? 'needs_review' : 'failed', { last_error: String(err.message).slice(0, 700) });
    console.error(`[publish] ${id}: ${err.message}`);
  } finally { inProgress.delete(id); }
}
function tick() {
  const slots = Math.max(0, 2 - inProgress.size);
  if (!slots) return;
  const due = db.prepare("SELECT id FROM posts WHERE status='scheduled' AND scheduled_at<=? ORDER BY scheduled_at ASC LIMIT ?").all(isoNow(), slots);
  for (const { id } of due) {
    const reservation = db.prepare("UPDATE posts SET status='processing', attempts=attempts+1, updated_at=? WHERE id=? AND status='scheduled'").run(isoNow(), id);
    if (!reservation.changes) continue;
    inProgress.add(id);
    void publishPost(id);
  }
}
let activeDownloads = 0;
async function runDownloader(id, url) {
  activeDownloads++;
  db.prepare("UPDATE downloads SET status='downloading', updated_at=? WHERE id=?").run(isoNow(), id);
  try {
    const args = ['--ignore-config', '--no-playlist', '--max-downloads', '1', '--max-filesize', '250M',
      '--no-progress', '--no-warnings', '--no-write-thumbnail', '--no-write-info-json',
      '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--merge-output-format', 'mp4',
      '-P', DOWNLOAD_DIR, '-o', `${id}.%(ext)s`, '--print', 'after_move:filepath', url];
    await new Promise((resolve, reject) => {
      const child = spawn(YT_DLP, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '', stopped = false;
      child.stdout.on('data', () => {});
      child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-3000); });
      child.on('error', e => { stopped = true; reject(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed. Install it or use Docker.' : e.message)); });
      const timer = setInterval(async () => {
        if (stopped) return;
        try {
          const names = (await fsp.readdir(DOWNLOAD_DIR)).filter(n => n.startsWith(`${id}.`));
          let bytes = 0;
          for (const n of names) bytes += (await fsp.stat(path.join(DOWNLOAD_DIR, n))).size;
          if (bytes > MAX_DOWNLOAD) { stopped = true; child.kill('SIGKILL'); reject(new Error('Video exceeds 250 MB download limit.')); }
        } catch { /* File may be moving while downloading */ }
      }, 1500);
      const timeout = setTimeout(() => { if (!stopped) { stopped = true; child.kill('SIGKILL'); reject(new Error('Download timed out after 5 minutes.')); } }, 300_000);
      child.on('close', code => {
        clearInterval(timer); clearTimeout(timeout);
        if (stopped) return;
        stopped = true;
        code === 0 ? resolve() : reject(new Error((stderr.trim() || `yt-dlp exited with status ${code}`).slice(-700)));
      });
    });
    const files = (await fsp.readdir(DOWNLOAD_DIR)).filter(n => n.startsWith(`${id}.`) && !/\.(?:part|ytdl|temp)$/.test(n));
    if (files.length !== 1) throw new Error('Could not locate a single downloaded video.');
    const size = (await fsp.stat(path.join(DOWNLOAD_DIR, files[0]))).size;
    if (!size || size > MAX_DOWNLOAD) throw new Error('Download is empty or exceeds the size limit.');
    db.prepare("UPDATE downloads SET status='ready', filename=?, last_error=NULL, updated_at=? WHERE id=?").run(files[0], isoNow(), id);
  } catch (e) {
    const files = (await fsp.readdir(DOWNLOAD_DIR)).filter(n => n.startsWith(`${id}.`));
    for (const f of files) await fsp.rm(path.join(DOWNLOAD_DIR, f), { force: true }).catch(() => {});
    db.prepare("UPDATE downloads SET status='failed', last_error=?, updated_at=? WHERE id=?").run(String(e.message).slice(0, 700), isoNow(), id);
    console.warn(`[download] ${id}: ${e.message}`);
  } finally { activeDownloads--; }
}
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
async function serveFile(req, res, file, { attachment = false, publicFile = false } = {}) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, 'File not found.');
  const total = st.size;
  const ext = path.extname(file).toLowerCase();
  const mime = contentTypes[ext] || 'application/octet-stream';
  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': publicFile ? 'public, max-age=86400' : 'private, no-store' };
  if (attachment) headers['Content-Disposition'] = `attachment; filename="instagram-video-${path.basename(file).replace(/[^a-zA-Z0-9._-]/g, '')}"`;
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range) {
    let start = range[1] ? Number(range[1]) : 0, end = range[2] ? Number(range[2]) : total - 1;
    if (!range[1] && range[2]) start = Math.max(0, total - Number(range[2]));
    if (start >= total || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end(); }
    end = Math.min(total - 1, end);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': total });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function postsList({ limit = 200, status } = {}) {
  if (status && ['scheduled','processing','publishing','published','failed','canceled','needs_review'].includes(status)) return db.prepare(`${postsQuery} WHERE p.status=? ORDER BY p.scheduled_at DESC LIMIT ?`).all(status, limit).map(publicPost);
  return db.prepare(`${postsQuery} ORDER BY p.scheduled_at DESC LIMIT ?`).all(limit).map(publicPost);
}
function downloadsList() { return db.prepare('SELECT id, source_url AS sourceUrl, status, filename, last_error AS lastError, created_at AS createdAt FROM downloads ORDER BY created_at DESC LIMIT 40').all(); }
const attemptsByIp = new Map();
function checkLoginAttempts(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const record = attemptsByIp.get(ip) || { count: 0, until: now() + 10 * 60_000 };
  if (record.until < now()) { record.count = 0; record.until = now() + 10 * 60_000; }
  if (record.count >= 8) throw new HttpError(429, 'Too many attempts. Try again in 10 minutes.');
  return { ip, record };
}
function stats() {
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all().map(r => [r.status, r.n]));
  const recent = postsList({ limit: 8 });
  const upcoming = db.prepare(`${postsQuery} WHERE p.status='scheduled' ORDER BY p.scheduled_at ASC LIMIT 5`).all().map(publicPost);
  const published = db.prepare("SELECT substr(scheduled_at,1,10) AS day, COUNT(*) AS n FROM posts WHERE status='published' AND scheduled_at>=? GROUP BY day").all(new Date(now()-13*86400000).toISOString());
  return {
    counts, scheduled: counts.scheduled || 0, published: counts.published || 0,
    failed: (counts.failed || 0) + (counts.needs_review || 0), total: Object.values(counts).reduce((a,b)=>a+b,0),
    accounts: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
    media: db.prepare('SELECT COUNT(*) AS n FROM media').get().n,
    upcoming, recent, publishedByDay: published,
  };
}

async function handler(req, res) {
  const u = new URL(req.url, BASE);
  const route = u.pathname;
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; media-src 'self' https: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'");
  checkOrigin(req);

  if (route === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'zaininsta-studio' });
  if (route === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: !!sessionToken(req) });
  if (route === '/api/login' && req.method === 'POST') {
    const { ip, record } = checkLoginAttempts(req);
    const body = await bodyJson(req);
    const actual = crypto.scryptSync(String(body.password || ''), 'instagram-studio-login-check', 32);
    const expected = crypto.scryptSync(env.ADMIN_PASSWORD, 'instagram-studio-login-check', 32);
    if (!crypto.timingSafeEqual(actual, expected)) {
      record.count++; attemptsByIp.set(ip, record);
      throw new HttpError(401, 'Incorrect password.');
    }
    attemptsByIp.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (hash,expires_at) VALUES (?,?)').run(sessionHash(token), now() + SESSION_TTL);
    return json(res, 200, { authenticated: true }, { 'Set-Cookie': setSessionCookie(token) });
  }
  if (route === '/api/logout' && req.method === 'POST') {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': setSessionCookie(null, 0) });
  }
  if (route.startsWith('/media/') && ['GET','HEAD'].includes(req.method)) {
    const name = route.slice('/media/'.length);
    failIf(!/^[a-f0-9-]{36}\.(jpg|jpeg|mp4|mov)$/.test(name), 404, 'Media not found.');
    return serveFile(req, res, path.join(UPLOAD_DIR, name), { publicFile: true });
  }
  if (route === '/auth/instagram/callback' && req.method === 'GET') {
    authorize(req);
    const state = u.searchParams.get('state') || '';
    const record = db.prepare('SELECT * FROM oauth_states WHERE state=?').get(state);
    failIf(!record || record.expires_at < now(), 400, 'Login session expired. Start again from Settings.');
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    if (u.searchParams.has('error')) return redirect(res, '/?view=settings&oauth=denied');
    const code = (u.searchParams.get('code') || '').replace(/#_$/, '');
    failIf(!code, 400, 'No authorization code returned by Instagram.');
    try {
      const { short, long } = await exchangeOAuthCode(code);
      const profile = await getProfile(long.access_token);
      const accountId = String(profile.user_id || profile.id || short.user_id || '');
      failIf(!accountId || !profile.username, 502, 'Instagram did not return a professional account ID and username.');
      const expiry = new Date(now() + Number(long.expires_in || 5_184_000)*1000).toISOString();
      const t = isoNow();
      db.prepare(`INSERT INTO accounts (id, username, account_type, token_ciphertext, token_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username, account_type=excluded.account_type,
          token_ciphertext=excluded.token_ciphertext,token_expires_at=excluded.token_expires_at,updated_at=excluded.updated_at`)
        .run(accountId, profile.username, profile.account_type || 'Professional', protect(long.access_token), expiry, t, t);
      return redirect(res, '/?view=settings&oauth=connected');
    } catch (e) {
      console.error('Instagram OAuth error:', e.message);
      return redirect(res, '/?view=settings&oauth=failed');
    }
  }
  if (route === '/auth/instagram/start' && req.method === 'GET') {
    authorize(req);
    failIf(!env.INSTAGRAM_APP_ID || !env.INSTAGRAM_APP_SECRET || !env.INSTAGRAM_REDIRECT_URI, 400, 'Set Instagram OAuth credentials in .env first.');
    const state = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO oauth_states (state,expires_at) VALUES (?,?)').run(state, now() + 10*60_000);
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, redirect_uri: env.INSTAGRAM_REDIRECT_URI, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state }).toString();
    return redirect(res, url.href);
  }
  // All remaining API/file-download endpoints require admin session.
  if (route.startsWith('/api/')) {
    authorize(req);
    if (route === '/api/config' && req.method === 'GET') return json(res, 200, {
      oauthConfigured: !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_REDIRECT_URI),
      publicMediaConfigured: /^https:\/\//.test(PUBLIC_BASE) && !PUBLIC_BASE.includes('example'),
      baseUrl: BASE, publicMediaBase: PUBLIC_BASE,
    });
    if (route === '/api/dashboard' && req.method === 'GET') return json(res, 200, stats());
    if (route === '/api/accounts' && req.method === 'GET') return json(res, 200, { accounts: db.prepare('SELECT * FROM accounts ORDER BY username').all().map(publicAccount) });
    const accountMatch = route.match(/^\/api\/accounts\/([0-9]+)$/);
    if (accountMatch && req.method === 'DELETE') {
      const count = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE account_id=? AND status IN ('scheduled','processing','publishing')").get(accountMatch[1]).n;
      failIf(count > 0, 409, 'Cancel outstanding scheduled posts before disconnecting this account.');
      db.prepare('DELETE FROM accounts WHERE id=?').run(accountMatch[1]);
      return json(res, 200, { ok: true });
    }
    if (route === '/api/posts' && req.method === 'GET') return json(res, 200, { posts: postsList({ status: u.searchParams.get('status') }) });
    if (route === '/api/posts' && req.method === 'POST') {
      const body = await bodyJson(req);
      const account = db.prepare('SELECT id FROM accounts WHERE id=?').get(String(body.accountId || ''));
      failIf(!account, 400, 'Connect and select an Instagram account.');
      failIf(!['image','reel'].includes(body.kind), 400, 'Select an image or a reel.');
      const mediaUrl = assertMediaUrl(body.mediaUrl);
      const caption = String(body.caption || '');
      failIf([...caption].length > 2200, 400, 'Instagram captions must be 2,200 characters or fewer.');
      const instant = body.mode === 'now';
      const scheduledMs = instant ? now() : Date.parse(body.scheduledAt);
      failIf(!Number.isFinite(scheduledMs), 400, 'Enter a valid schedule date and time.');
      const scheduledAt = new Date(scheduledMs).toISOString();
      const delta = new Date(scheduledAt).getTime() - now();
      failIf(!Number.isFinite(delta) || (!instant && delta < 30_000) || delta > 365*86400000, 400, 'Choose a time at least 30 seconds from now and within one year.');
      const id = crypto.randomUUID(), t = isoNow();
      db.prepare(`INSERT INTO posts (id,account_id,kind,media_url,caption,scheduled_at,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, account.id, body.kind, mediaUrl, caption, scheduledAt, 'scheduled', t, t);
      if (instant) setImmediate(tick);
      return json(res, 201, { post: publicPost(db.prepare(`${postsQuery} WHERE p.id=?`).get(id)) });
    }
    const postMatch = route.match(/^\/api\/posts\/([a-f0-9-]{36})(?:\/(cancel|retry))?$/);
    if (postMatch && req.method === 'POST' && postMatch[2] === 'cancel') {
      const result = db.prepare("UPDATE posts SET status='canceled', updated_at=? WHERE id=? AND status='scheduled'").run(isoNow(), postMatch[1]);
      failIf(!result.changes, 409, 'Only scheduled posts can be canceled.');
      return json(res, 200, { ok: true });
    }
    if (postMatch && req.method === 'POST' && postMatch[2] === 'retry') {
      const result = db.prepare("UPDATE posts SET status='scheduled', scheduled_at=?, container_id=NULL, last_error=NULL, updated_at=? WHERE id=? AND status='failed'").run(isoNow(), isoNow(), postMatch[1]);
      failIf(!result.changes, 409, 'Only failed posts can be retried. Check Instagram manually for posts marked Needs review.');
      setImmediate(tick);
      return json(res, 200, { ok: true });
    }
    if (route === '/api/media' && req.method === 'GET') {
      const files = db.prepare('SELECT * FROM media ORDER BY created_at DESC LIMIT 100').all().map(m => ({ id: m.id, name: m.original_name, size: m.size, mime: m.mime, url: `${PUBLIC_BASE}/media/${m.filename}`, createdAt: m.created_at }));
      return json(res, 200, { media: files });
    }
    if (route === '/api/upload' && req.method === 'PUT') {
      const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const extByType = { 'image/jpeg': '.jpg', 'video/mp4': '.mp4', 'video/quicktime': '.mov' };
      failIf(!extByType[type], 415, 'Only JPEG images, MP4 videos, and MOV videos are allowed.');
      const len = Number(req.headers['content-length']);
      failIf(!Number.isFinite(len) || len <= 0 || len > MAX_UPLOAD, 413, 'File must be 1 byte to 250 MB.');
      let name;
      try { name = decodeURIComponent(String(req.headers['x-filename'] || 'upload')).slice(0, 150); }
      catch { name = 'upload'; }
      name = name.replace(/[\x00-\x1f\\/]/g, '_');
      const id = crypto.randomUUID(), filename = `${id}${extByType[type]}`;
      const fullPath = path.join(UPLOAD_DIR, filename);
      let count = 0;
      const limiter = new Transform({ transform(chunk, _encoding, cb) { count += chunk.length; cb(count <= MAX_UPLOAD ? null : new HttpError(413, 'File exceeds 250 MB.'), chunk); } });
      try {
        await pipeline(req, limiter, fs.createWriteStream(fullPath, { flags: 'wx' }));
        failIf(count !== len, 400, 'Incomplete file upload.');
        const handle = await fsp.open(fullPath, 'r');
        const first = Buffer.alloc(16); await handle.read(first, 0, 16, 0); await handle.close();
        const jpeg = first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff;
        const isoVideo = first.toString('ascii', 4, 8) === 'ftyp';
        failIf(type === 'image/jpeg' ? !jpeg : !isoVideo, 415, 'File content does not match its selected format.');
        db.prepare('INSERT INTO media (id,filename,original_name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(id, filename, name, type, count, isoNow());
        return json(res, 201, { media: { id, name, size: count, mime: type, url: `${PUBLIC_BASE}/media/${filename}` } });
      } catch (e) { await fsp.rm(fullPath, { force: true }).catch(() => {}); throw e; }
    }
    const mediaMatch = route.match(/^\/api\/media\/([a-f0-9-]{36})$/);
    if (mediaMatch && req.method === 'DELETE') {
      const record = db.prepare('SELECT * FROM media WHERE id=?').get(mediaMatch[1]);
      failIf(!record, 404, 'Media file not found.');
      const fullURL = `${PUBLIC_BASE}/media/${record.filename}`;
      const dependent = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE media_url=? AND status IN ('scheduled','processing','publishing')").get(fullURL).n;
      failIf(dependent > 0, 409, 'This file is used by an active scheduled post.');
      db.prepare('DELETE FROM media WHERE id=?').run(mediaMatch[1]);
      await fsp.rm(path.join(UPLOAD_DIR, record.filename), { force: true });
      return json(res, 200, { ok: true });
    }
    if (route === '/api/downloads' && req.method === 'GET') return json(res, 200, { downloads: downloadsList() });
    if (route === '/api/downloads' && req.method === 'POST') {
      failIf(activeDownloads >= 2, 429, 'Two downloads are already in progress. Try again shortly.');
      const body = await bodyJson(req);
      failIf(body.confirmRights !== true, 400, 'Confirm that you have permission to save the video.');
      const source = assertInstagramVideoUrl(body.url);
      const id = crypto.randomUUID(), t = isoNow();
      db.prepare('INSERT INTO downloads (id,source_url,status,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, source, 'queued', t, t);
      void runDownloader(id, source);
      return json(res, 202, { id, status: 'queued' });
    }
    const downloadMatch = route.match(/^\/api\/downloads\/([a-f0-9-]{36})\/file$/);
    if (downloadMatch && req.method === 'GET') {
      const d = db.prepare('SELECT * FROM downloads WHERE id=?').get(downloadMatch[1]);
      failIf(!d || d.status !== 'ready' || !d.filename, 404, 'This download is not ready.');
      failIf(path.basename(d.filename) !== d.filename || !d.filename.startsWith(d.id + '.'), 400, 'Invalid download file.');
      return serveFile(req, res, path.join(DOWNLOAD_DIR, d.filename), { attachment: true });
    }
    throw new HttpError(404, 'API endpoint not found.');
  }
  if (['GET','HEAD'].includes(req.method)) {
    const filename = route === '/' ? 'index.html' : route.slice(1);
    failIf(!['index.html','styles.css','app.js','favicon.svg'].includes(filename), 404, 'Page not found.');
    return serveFile(req, res, path.join(PUBLIC, filename));
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch(err => {
    const status = err instanceof HttpError ? err.code : 500;
    if (status === 500) console.error('[server]', err);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'An unexpected server error occurred.' : err.message });
    else res.destroy();
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Zaininsta Studio listening on ${BASE} (port ${PORT})`));
const scheduler = setInterval(tick, 10_000);
setTimeout(tick, 1500);
const housekeeping = setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
  db.prepare('DELETE FROM oauth_states WHERE expires_at<?').run(now());
  for (const a of db.prepare('SELECT * FROM accounts').all()) {
    if (a.token_expires_at && new Date(a.token_expires_at).getTime() - now() < 14 * 86400000 && now() - new Date(a.updated_at).getTime() > 86400000) {
      void refreshAccount(a).catch(e => console.warn(`[refresh] ${a.username}: ${e.message}`));
    }
  }
}, 60 * 60_000);
function shutdown() { clearInterval(scheduler); clearInterval(housekeeping); server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
