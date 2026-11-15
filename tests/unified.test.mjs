import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from '../sqlite-driver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function stop(server) { await new Promise(resolve => server.close(resolve)); }
async function ready(base, proc) {
  for (let i=0; i<100; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited with ${proc.exitCode}`);
    try { if ((await fetch(base+'/api/health')).ok) return; } catch {}
    await delay(70);
  }
  throw new Error('server startup timed out');
}
function json(res, obj) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function securedToken(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm',key,iv);
  const body = Buffer.concat([c.update(text,'utf8'),c.final()]);
  return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');
}

test('Unified Login end-to-end with mocked Meta: OAuth, multiple accounts, legacy migration, publishing', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zaininsta-unified-'));
  for (const file of ['server.js','sqlite-driver.mjs','download-helper.mjs','package.json']) await fs.copyFile(path.join(root,file),path.join(tmp,file));
  await fs.cp(path.join(root,'public'),path.join(tmp,'public'),{recursive:true});
  try { await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (!['EEXIST','ENOENT'].includes(err.code)) throw err; }
  await fs.mkdir(path.join(tmp,'data'),{recursive:true});
  const key = crypto.randomBytes(32);
  const old = new DatabaseSync(path.join(tmp,'data','studio.sqlite'));
  old.exec(`CREATE TABLE accounts (
    id TEXT PRIMARY KEY, username TEXT NOT NULL, account_type TEXT,
    token_ciphertext TEXT NOT NULL, token_expires_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const stamp = new Date().toISOString();
  old.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)').run('9001','old_account','BUSINESS',securedToken('legacy-secret',key),null,stamp,stamp);
  old.close();

  const requests = [];
  let emptyAccounts = false;
  const meta = http.createServer(async (req,res) => {
    const u = new URL(req.url,'http://127.0.0.1');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push({ path:u.pathname, method:req.method, params:Object.fromEntries(u.searchParams), body:Object.fromEntries(body) });
    if (u.pathname.endsWith('/oauth/access_token')) return json(res,{access_token:'TEST-SUAT-TOKEN'});
    if (u.pathname.endsWith('/me')) return json(res,{id:'sys-123',client_business_id:'business-123'});
    if (u.pathname.endsWith('/me/assigned_instagram_accounts')) {
      if (emptyAccounts) return json(res,{data:[]});
      if (!u.searchParams.has('after')) return json(res,{data:[{id:'1234567890',username:'primary_ig'}],paging:{next:'https://example.test/second',cursors:{after:'cursor-next'}}});
      return json(res,{data:[{id:'4567890123',username:'secondary_ig'}]});
    }
    if (u.pathname.endsWith('/media') && req.method==='POST') return json(res,{id:'container-100'});
    if (u.pathname.endsWith('/container-100')) return json(res,{status_code:'FINISHED'});
    if (u.pathname.endsWith('/media_publish')) return json(res,{id:'media-100'});
    if (u.pathname.endsWith('/media-100')) return json(res,{permalink:'https://www.instagram.com/p/testPost/'});
    res.writeHead(404);res.end(JSON.stringify({error:{message:'Unexpected test API endpoint'}}));
  });
  const metaBase = await listen(meta);
  t.after(async()=>{await stop(meta);});
  const service = http.createServer();
  const base = await listen(service); const port = service.address().port; await stop(service);
  const child = spawn(process.execPath,['server.js'],{cwd:tmp, env:{...process.env,
    NODE_ENV:'test',META_GRAPH_ORIGIN:metaBase,PORT:String(port),APP_BASE_URL:base,
    PUBLIC_BASE_URL:'https://zaininsta-studio-production.up.railway.app',
    INSTAGRAM_REDIRECT_URI:'https://zaininsta-studio-production.up.railway.app/auth/instagram/callback',
    META_APP_ID:'meta-app-test-id',META_APP_SECRET:'mock-secret',META_CONFIG_ID:'config-test-123',
    ADMIN_PASSWORD:'demo-password-for-testing',ENCRYPTION_KEY:key.toString('base64'),
    SESSION_SECRET:crypto.randomBytes(40).toString('base64')},stdio:'ignore'});
  t.after(async()=>{
    if (child.exitCode===null) child.kill('SIGTERM');
    await delay(200);
    await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:200});
  });
  await ready(base,child);
  const login = await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'demo-password-for-testing'})});
  assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (url, method='GET', body) => fetch(base+url,{method,redirect:'manual',headers:{Cookie:cookie,Origin:base,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const initial = await (await api('/api/accounts')).json();
  assert.equal(initial.accounts.length,1);
  assert.equal(initial.accounts[0].authType,'instagram_login');
  const config=await (await api('/api/config')).json();
  assert.equal(config.oauthConfigured,true);assert.equal(config.oauthMode,'unified');
  const started=await api('/auth/instagram/start');
  assert.equal(started.status,302);
  const auth=new URL(started.headers.get('location'));
  assert.equal(auth.origin,'https://www.facebook.com');
  assert.equal(auth.pathname,'/dialog/oauth');
  assert.equal(auth.searchParams.get('client_id'),'meta-app-test-id');
  assert.equal(auth.searchParams.get('config_id'),'config-test-123');
  assert.equal(auth.searchParams.get('scope'),null);
  assert.equal(auth.searchParams.get('redirect_uri'),'https://zaininsta-studio-production.up.railway.app/auth/instagram/callback');
  const state=auth.searchParams.get('state'); assert.ok(state && state.length>20);
  const invalid=await fetch(base+`/auth/instagram/callback?code=bad&state=${state}`,{redirect:'manual'});
  assert.equal(invalid.status,401,'callback requires the correct admin session');
  const callback=await api(`/auth/instagram/callback?code=good&state=${state}`);
  assert.equal(callback.status,302);
  assert.match(callback.headers.get('location'),/oauth=connected/);
  const replay=await api(`/auth/instagram/callback?code=good&state=${state}`);
  assert.equal(replay.status,400,'state is single use');
  const list=await (await api('/api/accounts')).json();
  assert.equal(list.accounts.length,3);
  for (const a of list.accounts) { assert.ok(!('token_ciphertext' in a)); assert.ok(!JSON.stringify(a).includes('TEST-SUAT-TOKEN')); }
  const unified=list.accounts.filter(a=>a.authType==='unified');
  assert.equal(unified.length,2);assert.equal(unified[0].tokenExpiresAt,null);
  const db = new DatabaseSync(path.join(tmp,'data','studio.sqlite'));
  const record=db.prepare('SELECT * FROM accounts WHERE id=?').get('1234567890');
  assert.equal(record.client_business_id,'business-123');
  assert.equal(record.meta_config_id,'config-test-123');
  assert.notEqual(record.token_ciphertext,'TEST-SUAT-TOKEN');
  assert.equal(db.prepare('SELECT username FROM accounts WHERE id=?').get('9001').username,'old_account');
  db.close();

  const media='https://zaininsta-studio-production.up.railway.app/media/post.jpg';
  const postResponse=await api('/api/posts','POST',{accountId:'1234567890',kind:'image',mediaUrl:media,caption:'Unified login test',mode:'now'});
  assert.equal(postResponse.status,201);
  const postId=(await postResponse.json()).post.id;
  let published=null;
  for (let i=0;i<40;i++) {
    const posts=(await (await api('/api/posts')).json()).posts;
    published=posts.find(post=>post.id===postId);
    if (['published','failed','needs_review'].includes(published?.status)) break;
    await delay(120);
  }
  assert.equal(published.status,'published', published.lastError || 'No publishing status');
  assert.equal(published.permalink,'https://www.instagram.com/p/testPost/');
  assert.ok(requests.some(r=>r.path.endsWith('/1234567890/media')));
  assert.ok(requests.some(r=>r.path.endsWith('/1234567890/media_publish')));
  assert.equal(requests.filter(r=>r.path.endsWith('/refresh_access_token')).length,0);
  const downloaded=await api('/api/downloads','POST',{url:'https://example.com/private',confirmRights:true});
  assert.equal(downloaded.status,400);
  const del=await api('/api/accounts/4567890123','DELETE');assert.equal(del.status,200);

  // No shared accounts must never be treated as a successful connection.
  emptyAccounts = true;
  const startAgain=await api('/auth/instagram/start');
  const secondState=new URL(startAgain.headers.get('location')).searchParams.get('state');
  const rejected=await api(`/auth/instagram/callback?state=${secondState}&code=second`);
  assert.match(rejected.headers.get('location'),/oauth=failed/);
  const afterFail=(await (await api('/api/accounts')).json()).accounts;
  assert.equal(afterFail.length,2,'failed connection must not delete previous accounts');
});
