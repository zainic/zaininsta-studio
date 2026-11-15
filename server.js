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
import { classifyExtractorFailure, findOwnedVideo, streamOwnedVideo, finalizedExtractorFile, redactDownloaderDiagnostic } from './download-helper.mjs';
import { EditValidationError, validateEdit, buildRenderArgs, probeVideo, runProcess } from './video-editor.mjs';
import { getRenderResources, evaluateRenderResources, humanRenderFailure } from './render-resources.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA, 'uploads');
const DOWNLOAD_DIR = path.join(DATA, 'downloads');
const EDIT_DIR = path.join(DATA, 'edits');
const PUBLIC = path.join(ROOT, 'public');
for (const d of [DATA, UPLOAD_DIR, DOWNLOAD_DIR, EDIT_DIR]) fs.mkdirSync(d, { recursive: true });

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
const GRAPH_VERSION = /^v\d+\.\d+$/.test(env.GRAPH_VERSION || '') ? env.GRAPH_VERSION : 'v27.0';
const LEGACY_GRAPH = `https://graph.instagram.com/${GRAPH_VERSION}`;
// Test-only origin override. Production is always pinned to Meta.
const META_GRAPH_ORIGIN = env.NODE_ENV === 'test' && env.META_GRAPH_ORIGIN ? env.META_GRAPH_ORIGIN.replace(/\/$/, '') : 'https://graph.facebook.com';
const UNIFIED_GRAPH = `${META_GRAPH_ORIGIN}/${GRAPH_VERSION}`;
const UNIFIED_CONFIGURED = !!(env.META_APP_ID && env.META_APP_SECRET && env.META_CONFIG_ID && env.INSTAGRAM_REDIRECT_URI);
const LEGACY_CONFIGURED = !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET && env.INSTAGRAM_REDIRECT_URI);
const MAX_UPLOAD = 250 * 1024 * 1024;
const MAX_DOWNLOAD = 250 * 1024 * 1024;
const MAX_AUDIO_UPLOAD = 25 * 1024 * 1024;
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
  CREATE TABLE IF NOT EXISTS video_edits (
    id TEXT PRIMARY KEY, source_media_id TEXT NOT NULL, overlay_media_id TEXT, music_media_id TEXT,
    status TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, result_media_id TEXT,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
`);
// Non-destructive migration: pre-Unified Login installations retain their existing
// accounts and scheduled posts. Existing accounts keep the legacy token semantics.
function addColumnIfMissing(table, column, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing('accounts', 'auth_type', "TEXT NOT NULL DEFAULT 'instagram_login'");
addColumnIfMissing('accounts', 'client_business_id', 'TEXT');
addColumnIfMissing('accounts', 'meta_config_id', 'TEXT');
addColumnIfMissing('oauth_states', 'session_hash', 'TEXT');
addColumnIfMissing('oauth_states', 'flow', "TEXT NOT NULL DEFAULT 'legacy'");
addColumnIfMissing('downloads', 'source_method', "TEXT");
// An interrupted publish request could already have succeeded. Never auto-retry those.
db.prepare("UPDATE posts SET status='scheduled', updated_at=? WHERE status='processing'").run(isoNow());
db.prepare("UPDATE posts SET status='needs_review', last_error='Server restarted during publication. Check Instagram manually; do not blindly retry.', updated_at=? WHERE status='publishing'").run(isoNow());
db.prepare("UPDATE video_edits SET status='failed', last_error='Rendering stopped after a server restart or resource limit. Check Railway logs and use 480p or local rendering.', updated_at=? WHERE status IN ('queued','rendering')").run(isoNow());
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
const publicAccount = a => ({ id: a.id, username: a.username, accountType: a.account_type || 'Professional', authType: a.auth_type || 'instagram_login', tokenExpiresAt: a.token_expires_at });
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
  const target = new URL(url);
  // Graph Facebook supports Authorization headers. Keep Unified Login tokens
  // out of query strings and application/proxy request logs.
  const unifiedHost = target.origin === new URL(UNIFIED_GRAPH).origin;
  const data = new URLSearchParams(unifiedHost ? params : { ...params, access_token: token });
  const options = { method, signal: AbortSignal.timeout(timeout) };
  if (unifiedHost) options.headers = { Authorization: `Bearer ${token}` };
  if (method === 'GET') target.search = data.toString();
  else {
    options.body = data;
    options.headers = { ...options.headers, 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  const response = await fetch(target, options);
  const raw = await response.text();
  let result = {}; try { result = JSON.parse(raw); } catch { /* A gateway may return plain text */ }
  if (!response.ok || result.error) throw new Error(metaError(result, response.status));
  return result;
}
async function getProfile(token) { return metaRequest(`${LEGACY_GRAPH}/me`, { params: { fields: 'id,user_id,username,account_type' }, token }); }
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
// Unified Login issues a Business Integration System User access token (SUAT).
// Unlike legacy Instagram Login tokens, it must not be sent to ig_refresh_token.
async function exchangeUnifiedCode(code) {
  const url = new URL(`${UNIFIED_GRAPH}/oauth/access_token`);
  url.search = new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET,
    redirect_uri: env.INSTAGRAM_REDIRECT_URI, code }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(35_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.access_token) {
    throw new Error(`Unified Login token exchange failed: ${metaError(data, response.status)}`);
  }
  return data;
}
async function assignedInstagramAccounts(token) {
  const accounts = [];
  let after = null;
  const seen = new Set();
  for (let page = 0; page < 10; page++) {
    const params = { fields: 'id,username', limit: '100' };
    if (after) params.after = after;
    const result = await metaRequest(`${UNIFIED_GRAPH}/me/assigned_instagram_accounts`, { token, params });
    if (!Array.isArray(result.data)) throw new Error('Meta did not return an Instagram account list.');
    for (const a of result.data) {
      if (/^\d+$/.test(String(a.id || '')) && typeof a.username === 'string' && a.username.trim()) {
        if (!accounts.some(item => item.id === String(a.id))) accounts.push({ id: String(a.id), username: a.username.trim() });
      }
    }
    const cursor = result.paging?.cursors?.after;
    if (!result.paging?.next || !cursor || seen.has(cursor)) break;
    seen.add(cursor);
    after = cursor;
  }
  return accounts;
}
async function connectUnifiedAccounts(code) {
  const exchanged = await exchangeUnifiedCode(code);
  const token = exchanged.access_token;
  // Business ID is kept for potential future SUAT management/rotation.
  const business = await metaRequest(`${UNIFIED_GRAPH}/me`, { token, params: { fields: 'client_business_id' } });
  const accounts = await assignedInstagramAccounts(token);
  if (!accounts.length) throw new Error('No Instagram professional accounts were shared. Select an Instagram asset in Meta Business Login, then reconnect.');
  // A missing expiration is not assumed to be a 60-day Instagram token. It
  // means Meta did not return an expiration. Reconnect if the SUAT is revoked.
  const seconds = Number(exchanged.expires_in);
  const expiry = Number.isFinite(seconds) && seconds > 0 ? new Date(now() + seconds * 1000).toISOString() : null;
  const clientBusinessId = business.client_business_id ? String(business.client_business_id) : null;
  const t = isoNow();
  const upsert = db.prepare(`INSERT INTO accounts
    (id, username, account_type, token_ciphertext, token_expires_at, auth_type, client_business_id, meta_config_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET username=excluded.username, account_type=excluded.account_type,
      token_ciphertext=excluded.token_ciphertext, token_expires_at=excluded.token_expires_at,
      auth_type=excluded.auth_type, client_business_id=excluded.client_business_id,
      meta_config_id=excluded.meta_config_id, updated_at=excluded.updated_at`);
  // On an existing account, preserve outstanding scheduled posts (same IG id).
  for (const a of accounts) upsert.run(a.id, a.username, 'Professional', protect(token), expiry,
    'unified', clientBusinessId, env.META_CONFIG_ID, t, t);
  return accounts;
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
  // Unified Login SUAT rotation uses a separate Meta management API, not ig_refresh_token.
  if (account.auth_type === 'unified') return reveal(account.token_ciphertext);
  // Legacy Instagram Login long-lived tokens can be refreshed before expiry.
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
      const result = await metaRequest(`${account.auth_type === 'unified' ? UNIFIED_GRAPH : LEGACY_GRAPH}/${account.id}/media`, { method: 'POST', params: payload, token, timeout: 90_000 });
      if (!result.id) throw new Error('Meta did not return a media container ID.');
      containerId = String(result.id);
      setPostStatus(id, 'processing', { container_id: containerId });
    }
    let ready = false;
    for (let i = 0; i < 36; i++) {
      const status = await metaRequest(`${account.auth_type === 'unified' ? UNIFIED_GRAPH : LEGACY_GRAPH}/${containerId}`, { params: { fields: 'status_code,status' }, token });
      if (status.status_code === 'FINISHED') { ready = true; break; }
      if (['ERROR', 'EXPIRED'].includes(status.status_code)) throw new Error(`Instagram rejected media: ${status.status || status.status_code}`);
      await sleep(10_000);
    }
    if (!ready) throw new Error('Instagram did not finish processing the media within 6 minutes. Retry later.');
    // Crash/network failure after sending media_publish has an ambiguous outcome.
    // Keep this state for manual review rather than risking a duplicate post.
    setPostStatus(id, 'publishing');
    const published = await metaRequest(`${account.auth_type === 'unified' ? UNIFIED_GRAPH : LEGACY_GRAPH}/${account.id}/media_publish`, { method: 'POST', params: { creation_id: containerId }, token, timeout: 90_000 });
    if (!published.id) throw new Error('Publish response did not contain an Instagram media ID. Check Instagram before retrying.');
    setPostStatus(id, 'published', { published_media_id: String(published.id), last_error: null });
    try {
      const detail = await metaRequest(`${account.auth_type === 'unified' ? UNIFIED_GRAPH : LEGACY_GRAPH}/${published.id}`, { params: { fields: 'permalink' }, token });
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
// Use Meta's authorized API for videos on an account connected to this studio.
// For other *public* links use yt-dlp. Neither method bypasses access limits.
async function findAuthorizedVideo(url) {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 5').all();
  if (!accounts.length) return null;
  return findOwnedVideo({ url, accounts, maxPages: 3, listMedia: async (account, after) => {
    const token = await accountToken(account);
    const base = account.auth_type === 'unified' ? UNIFIED_GRAPH : LEGACY_GRAPH;
    const params = { fields: 'id,shortcode,permalink,media_type,media_url,children{media_type,media_url}', limit: '100' };
    if (after) params.after = after;
    return metaRequest(`${base}/${account.id}/media`, { token, params, timeout: 12_000 });
  }});
}
async function runYtDlp(id, url) {
  // --max-downloads cancels yt-dlp with exit 101 after a successful download.
  // Select one entry instead, including when Instagram returns a carousel.
  const args = ['--ignore-config', '--no-playlist', '--playlist-items', '1', '--max-filesize', '250M',
    '--no-progress', '--no-write-thumbnail', '--no-write-info-json', '--no-simulate',
    '--print', 'after_move:ZAININSTA_FILE:%(filepath)j',
    '--socket-timeout', '20', '--retries', '2', '--fragment-retries', '2', '--merge-output-format', 'mp4',
    '-P', DOWNLOAD_DIR, '-o', `${id}.%(ext)s`, url];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', stopped = false, stopError = null;
    child.stdout.on('data', d => { stdout = (stdout + d.toString()).slice(-12000); });
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-6000); });
    function finish(error) {
      clearInterval(timer); clearTimeout(timeout);
      if (stopped) return;
      stopped = true;
      error ? reject(error) : resolve(stdout);
    }
    function stop(error) {
      if (stopped || stopError) return;
      stopError = error;
      // Wait for close before cleanup so the process cannot recreate partial files.
      child.kill('SIGKILL');
    }
    child.on('error', e => finish(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed. Install it or use Docker.' : e.message)));
    const timer = setInterval(async () => {
      if (stopped || stopError) return;
      try {
        const names = (await fsp.readdir(DOWNLOAD_DIR)).filter(n => n.startsWith(`${id}.`));
        let bytes = 0;
        for (const n of names) bytes += (await fsp.stat(path.join(DOWNLOAD_DIR, n))).size;
        if (bytes > MAX_DOWNLOAD) stop(new Error('Video exceeds 250 MB download limit.'));
      } catch { /* File may be moving while downloading */ }
    }, 1500);
    const timeout = setTimeout(() => stop(new Error('Download timed out after 5 minutes.')), 300_000);
    child.on('close', (code, signal) => {
      if (stopped) return;
      if (stopError || code !== 0) {
        const diagnostic = redactDownloaderDiagnostic(stderr + '\n' + stdout).slice(-2500);
        console.warn(`[yt-dlp] ${JSON.stringify({ downloadId: id, exitCode: code, signal, diagnostic })}`);
        finish(stopError || new Error(signal ? `Video downloader stopped by signal ${signal}. Check the application server logs.` : classifyExtractorFailure(stderr + '\n' + stdout, code)));
      } else finish();
    });
  });
  return finalizedExtractorFile(output, { directory: DOWNLOAD_DIR, id, maxBytes: MAX_DOWNLOAD });
}
let activeDownloads = 0;
async function runDownloader(id, url) {
  activeDownloads++;
  db.prepare("UPDATE downloads SET status='downloading', updated_at=? WHERE id=?").run(isoNow(), id);
  try {
    let sourceMethod = 'yt-dlp', filename;
    // The Graph API can resolve a user's own media more reliably than scraping
    // an Instagram webpage from a Railway cloud IP.
    const authorized = await findAuthorizedVideo(url).catch(e => {
      console.warn(`[download] Meta media lookup unavailable: ${redactDownloaderDiagnostic(e.message).slice(0, 180)}`);
      return null;
    });
    if (authorized) {
      try {
        await streamOwnedVideo(authorized.url, path.join(DOWNLOAD_DIR, `${id}.mp4`), { maxBytes: MAX_DOWNLOAD });
        sourceMethod = 'meta';
        filename = `${id}.mp4`;
      } catch (error) {
        // A transient CDN failure can fall back to the regular public extractor.
        console.warn(`[download] Meta media copy failed: ${redactDownloaderDiagnostic(error.message).slice(0, 180)}`);
        await fsp.rm(path.join(DOWNLOAD_DIR, `${id}.mp4`), { force: true });
        filename = await runYtDlp(id, url);
      }
    } else {
      filename = await runYtDlp(id, url);
    }
    const size = (await fsp.stat(path.join(DOWNLOAD_DIR, filename))).size;
    if (!size || size > MAX_DOWNLOAD) throw new Error('Download is empty or exceeds the size limit.');
    db.prepare("UPDATE downloads SET status='ready', filename=?, source_method=?, last_error=NULL, updated_at=? WHERE id=?").run(filename, sourceMethod, isoNow(), id);
    console.info(`[download] ${id}: ready via ${sourceMethod}, ${size} bytes`);
  } catch (e) {
    const files = (await fsp.readdir(DOWNLOAD_DIR)).filter(n => n.startsWith(`${id}.`));
    for (const f of files) await fsp.rm(path.join(DOWNLOAD_DIR, f), { force: true }).catch(() => {});
    db.prepare("UPDATE downloads SET status='failed', last_error=?, updated_at=? WHERE id=?").run(String(e.message).slice(0, 700), isoNow(), id);
    console.warn(`[download] ${id}: ${e.message}`);
  } finally { activeDownloads--; }
}
const contentTypes = { '.png':'image/png', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.wav':'audio/wav', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
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
function downloadsList() { return db.prepare('SELECT id, source_url AS sourceUrl, status, filename, last_error AS lastError, created_at AS createdAt, updated_at AS updatedAt, source_method AS sourceMethod FROM downloads ORDER BY created_at DESC LIMIT 40').all(); }
const attemptsByIp = new Map();
function checkLoginAttempts(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const record = attemptsByIp.get(ip) || { count: 0, until: now() + 10 * 60_000 };
  if (record.until < now()) { record.count = 0; record.until = now() + 10 * 60_000; }
  if (record.count >= 8) throw new HttpError(429, 'Too many attempts. Try again in 10 minutes.');
  return { ip, record };
}

function lookupEditableMedia(id, allowed, label) {
  if (!/^[a-f0-9-]{36}$/.test(String(id || ''))) throw new HttpError(400, `Select a valid uploaded ${label}.`);
  const record = db.prepare('SELECT * FROM media WHERE id=?').get(id);
  if (!record || !allowed.includes(record.mime)) throw new HttpError(400, `Select ${label} from your uploaded Media Library.`);
  return record;
}
function publicMedia(record) {
  return { id:record.id, name:record.original_name, size:record.size, mime:record.mime,
    url:`${PUBLIC_BASE}/media/${record.filename}`, createdAt:record.created_at };
}
async function prepareVideoEdit(body) {
  const source=lookupEditableMedia(body.mediaId,['video/mp4','video/quicktime'],'video');
  const overlay=body.overlayMediaId?lookupEditableMedia(body.overlayMediaId,['image/jpeg','image/png'],'overlay image'):null;
  const music=body.musicMediaId?lookupEditableMedia(body.musicMediaId,['audio/mpeg','audio/mp4','audio/wav','audio/x-wav'],'audio track'):null;
  let metadata;
  try { metadata=await probeVideo(path.join(UPLOAD_DIR,source.filename)); }
  catch(error) { throw new HttpError(422,String(error.message).slice(0,240)); }
  let settings;
  try { settings=validateEdit(body.settings,metadata); }
  catch(error) { if(error instanceof EditValidationError)throw new HttpError(400,error.message);throw error; }
  return {source,overlay,music,settings,metadata};
}
const activeEditJobs = new Set();
let editRequestPending = false;
async function renderVideoEdit(id, source, overlay, music, settings, metadata, threads=2) {
  const sourcePath=path.join(UPLOAD_DIR,source.filename);
  const outputId=crypto.randomUUID(), outputName=`${outputId}.mp4`;
  const outputPath=path.join(UPLOAD_DIR,outputName);
  const textFile=path.join(EDIT_DIR,`${id}.txt`);
  activeEditJobs.add(id);
  try {
    db.prepare("UPDATE video_edits SET status='rendering',progress=1,updated_at=? WHERE id=?").run(isoNow(),id);
    if(settings.text) await fsp.writeFile(textFile,settings.text,'utf8');
    const {args,outputDuration}=buildRenderArgs({sourcePath,outputPath,settings,metadata,
      overlayPath:overlay&&path.join(UPLOAD_DIR,overlay.filename),
      musicPath:music&&path.join(UPLOAD_DIR,music.filename),textPath:settings.text?textFile:null,threads});
    let stdoutBuffer='',lastPercent=0;
    const progressUpdater = text => {
      stdoutBuffer=(stdoutBuffer+text).slice(-1000);
      const lines=stdoutBuffer.split(/\r?\n/);stdoutBuffer=lines.pop();
      for(const line of lines){
        const m=/^out_time_(?:ms|us)=(\d+)/.exec(line);
        if(!m)continue;
        const percent=Math.min(99,Math.floor(Number(m[1])/1e6/outputDuration*100));
        if(percent>=lastPercent+4){lastPercent=percent;db.prepare('UPDATE video_edits SET progress=?,updated_at=? WHERE id=?').run(percent,isoNow(),id);}
      }
    };
    await runProcess('ffmpeg',args,{timeoutMs:8*60_000,onStdout:progressUpdater});
    const stat=await fsp.stat(outputPath);
    if(!stat.size || stat.size>MAX_UPLOAD)throw new Error('Rendered video exceeds the 250 MB media limit. Reduce the duration or quality.');
    const t=isoNow();
    const mediaName=`zaininsta-edited-${new Date().toISOString().slice(0,10)}.mp4`;
    db.prepare('INSERT INTO media (id,filename,original_name,mime,size,created_at) VALUES (?,?,?,?,?,?)')
      .run(outputId,outputName,mediaName,'video/mp4',stat.size,t);
    db.prepare("UPDATE video_edits SET status='ready',progress=100,result_media_id=?,last_error=NULL,updated_at=? WHERE id=?")
      .run(outputId,t,id);
    console.info(`[editor] ${id} rendered ${stat.size} bytes`);
  }catch(error){
    await fsp.rm(outputPath,{force:true}).catch(()=>{});
    const reason=humanRenderFailure(error.message||'Video rendering failed');
    db.prepare("UPDATE video_edits SET status='failed',last_error=?,updated_at=? WHERE id=?")
      .run(reason,isoNow(),id);
    console.warn(`[editor] ${id} failed: ${reason}`);
  }finally{
    await fsp.rm(textFile,{force:true}).catch(()=>{});
    activeEditJobs.delete(id);
  }
}
function editJobView(id) {
  const e=db.prepare('SELECT * FROM video_edits WHERE id=?').get(id);
  if(!e)throw new HttpError(404,'Video edit job not found.');
  const media=e.result_media_id&&db.prepare('SELECT * FROM media WHERE id=?').get(e.result_media_id);
  return {id:e.id,status:e.status,progress:e.progress,lastError:e.last_error,media:media?publicMedia(media):null};
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
    failIf(!/^[a-f0-9-]{36}\.(jpg|jpeg|png|mp4|mov|mp3|m4a|wav)$/.test(name), 404, 'Media not found.');
    return serveFile(req, res, path.join(UPLOAD_DIR, name), { publicFile: true });
  }
  if (route === '/auth/instagram/callback' && req.method === 'GET') {
    const session = sessionToken(req);
    failIf(!session, 401, 'Your admin session expired. Sign in and start the connection again.');
    const state = u.searchParams.get('state') || '';
    const record = db.prepare('SELECT * FROM oauth_states WHERE state=?').get(state);
    failIf(!record || record.expires_at < now() || !record.session_hash ||
      record.session_hash !== sessionHash(session), 400, 'Login session expired or does not match your admin session. Start again from Connections.');
    // Consume OAuth state exactly once, including on cancellation or failure.
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    if (u.searchParams.has('error')) return redirect(res, '/?view=settings&oauth=denied');
    const code = (u.searchParams.get('code') || '').replace(/#_$/, '');
    failIf(!code, 400, 'Meta did not return an authorization code.');
    try {
      if (record.flow === 'unified') {
        await connectUnifiedAccounts(code);
      } else {
        const { short, long } = await exchangeOAuthCode(code);
        const profile = await getProfile(long.access_token);
        const accountId = String(profile.user_id || profile.id || short.user_id || '');
        failIf(!/^\d+$/.test(accountId) || !profile.username, 502, 'Instagram did not return a professional account ID and username.');
        const expiry = new Date(now() + Number(long.expires_in || 5_184_000)*1000).toISOString();
        const t = isoNow();
        db.prepare(`INSERT INTO accounts (id, username, account_type, token_ciphertext, token_expires_at, auth_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'instagram_login', ?, ?)
          ON CONFLICT(id) DO UPDATE SET username=excluded.username, account_type=excluded.account_type,
            token_ciphertext=excluded.token_ciphertext,token_expires_at=excluded.token_expires_at,
            auth_type=excluded.auth_type,updated_at=excluded.updated_at`)
          .run(accountId, profile.username, profile.account_type || 'Professional', protect(long.access_token), expiry, t, t);
      }
      return redirect(res, '/?view=settings&oauth=connected');
    } catch (e) {
      // Avoid logging tokens, authorization codes, or app secrets.
      console.error('[instagram oauth]', String(e.message).slice(0, 500));
      return redirect(res, '/?view=settings&oauth=failed');
    }
  }
  if (route === '/auth/instagram/start' && req.method === 'GET') {
    const session = sessionToken(req);
    failIf(!session, 401, 'Please sign in first.');
    failIf(!UNIFIED_CONFIGURED && !LEGACY_CONFIGURED, 400, 'Set META_APP_ID, META_APP_SECRET, META_CONFIG_ID, and INSTAGRAM_REDIRECT_URI in Railway Variables.');
    const unified = UNIFIED_CONFIGURED;
    const state = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO oauth_states (state,expires_at,session_hash,flow) VALUES (?,?,?,?)')
      .run(state, now() + 10 * 60_000, sessionHash(session), unified ? 'unified' : 'legacy');
    if (unified) {
      const url = new URL('https://www.facebook.com/dialog/oauth');
      url.search = new URLSearchParams({ client_id: env.META_APP_ID, config_id: env.META_CONFIG_ID,
        redirect_uri: env.INSTAGRAM_REDIRECT_URI, response_type: 'code', prompt: 'login', state }).toString();
      return redirect(res, url.href);
    }
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.search = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID,
      redirect_uri: env.INSTAGRAM_REDIRECT_URI, response_type: 'code',
      scope: 'instagram_business_basic,instagram_business_content_publish', state }).toString();
    return redirect(res, url.href);
  }
  // All remaining API/file-download endpoints require admin session.
  if (route.startsWith('/api/')) {
    authorize(req);
    if (route === '/api/config' && req.method === 'GET') return json(res, 200, {
      oauthConfigured: UNIFIED_CONFIGURED || LEGACY_CONFIGURED,
      oauthMode: UNIFIED_CONFIGURED ? 'unified' : LEGACY_CONFIGURED ? 'instagram_login' : null,
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
      const files = db.prepare('SELECT * FROM media ORDER BY created_at DESC LIMIT 100').all().map(publicMedia);
      return json(res, 200, { media: files });
    }
    if (route === '/api/upload' && req.method === 'PUT') {
      const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
      const extByType = { 'image/png': '.png', 'image/jpeg': '.jpg', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
      failIf(!extByType[type], 415, 'Upload JPEG, PNG, MP4, MOV, MP3, M4A, or WAV files.');
      const len = Number(req.headers['content-length']);
      failIf(!Number.isFinite(len) || len <= 0 || len > (type.startsWith('audio/') ? MAX_AUDIO_UPLOAD : MAX_UPLOAD), 413, 'Videos must be 250 MB or smaller; audio must be 25 MB or smaller.');
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
        const png = first.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const mp3 = first.toString('ascii',0,3) === 'ID3' || (first[0] === 0xff && (first[1] & 0xe0) === 0xe0);
        const wav = first.toString('ascii',0,4) === 'RIFF' && first.toString('ascii',8,12) === 'WAVE';
        const isValid = type==='image/jpeg'?jpeg:type==='image/png'?png:type==='audio/mpeg'?mp3:type==='audio/wav'||type==='audio/x-wav'?wav:isoVideo;
        failIf(!isValid, 415, 'File content does not match its selected format.');
        db.prepare('INSERT INTO media (id,filename,original_name,mime,size,created_at) VALUES (?,?,?,?,?,?)').run(id, filename, name, type, count, isoNow());
        return json(res, 201, { media: { id, name, size: count, mime: type, url: `${PUBLIC_BASE}/media/${filename}` } });
      } catch (e) { await fsp.rm(fullPath, { force: true }).catch(() => {}); throw e; }
    }
    if (route === '/api/editor/probe' && req.method === 'POST') {
      const body=await bodyJson(req);
      const source=lookupEditableMedia(body.mediaId,['video/mp4','video/quicktime'],'video');
      const metadata=await probeVideo(path.join(UPLOAD_DIR,source.filename)).catch(error=>{
        throw new HttpError(422, String(error.message).slice(0,220));
      });
      return json(res,200,{media:publicMedia(source),metadata});
    }
    if (route === '/api/editor/preflight' && req.method === 'POST') {
      const body=await bodyJson(req,12_000);
      const selection=await prepareVideoEdit(body);
      const assessment=evaluateRenderResources(selection.settings,await getRenderResources(UPLOAD_DIR));
      return json(res,200,{assessment});
    }
    if (route === '/api/editor/render' && req.method === 'POST') {
      if(editRequestPending || activeEditJobs.size || db.prepare("SELECT COUNT(*) AS n FROM video_edits WHERE status IN ('queued','rendering')").get().n)
        throw new HttpError(429,'Another video render is in progress. Wait for it to finish.');
      editRequestPending = true;
      try {
        const body=await bodyJson(req,12_000);
        const {source,overlay,music,settings,metadata}=await prepareVideoEdit(body);
        const assessment=evaluateRenderResources(settings,await getRenderResources(UPLOAD_DIR));
        if(!assessment.ok)throw new HttpError(422,'Server rendering blocked: '+assessment.errors.join(' '));
        const threads=assessment.resources.memoryLimitMB!==null && assessment.resources.memoryLimitMB<=1024?1:2;
        const id=crypto.randomUUID(),t=isoNow();
        db.prepare(`INSERT INTO video_edits (id,source_media_id,overlay_media_id,music_media_id,status,created_at,updated_at)
          VALUES (?,?,?,?,'queued',?,?)`).run(id,source.id,overlay?.id||null,music?.id||null,t,t);
        void renderVideoEdit(id,source,overlay,music,settings,metadata,threads);
        return json(res,202,{job:editJobView(id),warnings:assessment.warnings});
      } finally { editRequestPending = false; }
    }
    const editMatch=route.match(/^\/api\/editor\/jobs\/([a-f0-9-]{36})$/);
    if(editMatch && req.method==='GET') return json(res,200,{job:editJobView(editMatch[1])});
    const mediaMatch = route.match(/^\/api\/media\/([a-f0-9-]{36})$/);
    if (mediaMatch && req.method === 'DELETE') {
      const record = db.prepare('SELECT * FROM media WHERE id=?').get(mediaMatch[1]);
      failIf(!record, 404, 'Media file not found.');
      const fullURL = `${PUBLIC_BASE}/media/${record.filename}`;
      const dependent = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE media_url=? AND status IN ('scheduled','processing','publishing')").get(fullURL).n;
      failIf(dependent > 0, 409, 'This file is used by an active scheduled post.');
      const usedInEditor=db.prepare("SELECT COUNT(*) AS n FROM video_edits WHERE status IN ('queued','rendering') AND (source_media_id=? OR overlay_media_id=? OR music_media_id=?)").get(record.id,record.id,record.id).n;
      failIf(usedInEditor>0,409,'This file is in use by an active video render.');
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
    const clearDownloadMatch = route.match(/^\/api\/downloads\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/);
    if (clearDownloadMatch && req.method === 'DELETE') {
      const record = db.prepare('SELECT * FROM downloads WHERE id=?').get(clearDownloadMatch[1]);
      failIf(!record, 404, 'Download not found.');
      if (record.status === 'deleted') return json(res, 200, { ok: true, status: 'deleted', updatedAt: record.updated_at });
      failIf(!['ready', 'failed'].includes(record.status), 409, 'Wait for this download to finish before clearing it.');
      failIf(record.filename && (path.basename(record.filename) !== record.filename || !record.filename.startsWith(record.id + '.')), 400, 'Invalid download file.');
      try {
        // Delete only this job's files, including any leftover partial files.
        // Never recursively remove directories or follow paths from the database.
        const files = (await fsp.readdir(DOWNLOAD_DIR)).filter(name => name.startsWith(record.id + '.'));
        for (const name of files) {
          await fsp.unlink(path.join(DOWNLOAD_DIR, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      } catch (error) {
        console.warn(`[download] clear ${record.id}: ${error.code || 'filesystem error'}`);
        throw new HttpError(503, 'Could not delete the saved files. Try clearing this download again.');
      }
      // Retain the source, original timestamp, method, and errors as history.
      // The file endpoint only serves ready records, so deleted links stay disabled.
      const deletedAt = isoNow();
      db.prepare("UPDATE downloads SET status='deleted', filename=NULL, updated_at=? WHERE id=?").run(deletedAt, record.id);
      return json(res, 200, { ok: true, status: 'deleted', updatedAt: deletedAt });
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
    if (a.auth_type !== 'unified' && a.token_expires_at && new Date(a.token_expires_at).getTime() - now() < 14 * 86400000 && now() - new Date(a.updated_at).getTime() > 86400000) {
      void refreshAccount(a).catch(e => console.warn(`[refresh] ${a.username}: ${e.message}`));
    }
  }
}, 60 * 60_000);
function shutdown() { clearInterval(scheduler); clearInterval(housekeeping); server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
