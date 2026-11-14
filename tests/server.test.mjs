import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from '../sqlite-driver.mjs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const encKey = crypto.randomBytes(32);
const port = 35000 + Math.floor(Math.random() * 10_000);
const base = `http://127.0.0.1:${port}`;
const sessionSecret = crypto.randomBytes(40).toString('base64');
async function waitForReady(proc) {
  for (let i=0;i<60;i++) {
    if (proc.exitCode !== null) throw new Error(`Server exited: ${proc.exitCode}`);
    try { const r=await fetch(base+'/api/health'); if (r.ok) return; } catch {};
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Server did not start.');
}
function encrypt(text) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',encKey,iv);
  const encrypted=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}

test('self-hosted dashboard API: login, upload, schedule, cancel and disconnect', async t=>{
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'instagram-studio-test-'));
  await fs.copyFile(path.join(root,'server.js'),path.join(tmp,'server.js'));
  await fs.copyFile(path.join(root,'sqlite-driver.mjs'),path.join(tmp,'sqlite-driver.mjs'));
  // Native dependencies are installed at the project root; the isolated
  // test server needs access to the same installation on Node.js 20.
  try { await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'dir'); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error; }
  await fs.copyFile(path.join(root,'package.json'),path.join(tmp,'package.json'));
  await fs.cp(path.join(root,'public'),path.join(tmp,'public'),{recursive:true});
  const child=spawn(process.execPath,['server.js'], {cwd:tmp,env:{...process.env,PORT:String(port),APP_BASE_URL:base,PUBLIC_BASE_URL:'https://assets.studio.test',ADMIN_PASSWORD:'test-password-not-for-production',ENCRYPTION_KEY:encKey.toString('base64'),SESSION_SECRET:sessionSecret,GRAPH_VERSION:'v27.0'}, stdio:'ignore'});
  t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:200});});
  await waitForReady(child);
  const health=await (await fetch(base+'/api/health')).json(); assert.equal(health.ok,true);
  const unauth=await fetch(base+'/api/dashboard'); assert.equal(unauth.status,401);
  const wrong=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','Origin':base},body:JSON.stringify({password:'wrong'})});assert.equal(wrong.status,401);
  const logged=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json','Origin':base},body:JSON.stringify({password:'test-password-not-for-production'})}); assert.equal(logged.status,200);
  const cookie=logged.headers.get('set-cookie').split(';')[0];
  const request=async(uri,method='GET',payload,extra={})=>fetch(base+uri,{method,headers:{Cookie:cookie,Origin:base,...(payload===undefined?{}:{'Content-Type':'application/json'}),...extra},body:payload===undefined?undefined:JSON.stringify(payload)});
  const config=await (await request('/api/config')).json();assert.equal(config.publicMediaConfigured,true);
  const accountList=await (await request('/api/accounts')).json();assert.equal(accountList.accounts.length,0);
  const image=Buffer.from([0xff,0xd8,0xff,0xe0,0,16,0x4a,0x46,0x49,0x46,0,1,1,0]);
  const uploaded=await fetch(base+'/api/upload',{method:'PUT',headers:{Cookie:cookie,Origin:base,'Content-Type':'image/jpeg','X-Filename':'test.jpg'},body:image});
  assert.equal(uploaded.status,201);
  const upload=(await uploaded.json()).media;
  assert.match(upload.url,/https:\/\/assets.studio.test\/media\/.*\.jpg$/);
  const localMedia=await fetch(base+'/media/'+upload.url.split('/').at(-1));assert.equal(localMedia.status,200);
  const invalidDownload=await request('/api/downloads','POST',{url:'https://private.example.com/video',confirmRights:true});assert.equal(invalidDownload.status,400);
  const date=new Date(Date.now()+3600000).toISOString();
  const noAccount=await request('/api/posts','POST',{accountId:'1',kind:'image',mediaUrl:upload.url,caption:'Test!',mode:'scheduled',scheduledAt:date});assert.equal(noAccount.status,400);
  const db=new DatabaseSync(path.join(tmp,'data','studio.sqlite'));
  const now=new Date().toISOString();
  db.prepare('INSERT INTO accounts (id,username,account_type,token_ciphertext,token_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('12345','demo_account','BUSINESS',encrypt('fake-token'),new Date(Date.now()+30*86400000).toISOString(),now,now);
  db.close();
  const postResp=await request('/api/posts','POST',{accountId:'12345',kind:'image',mediaUrl:upload.url,caption:'Scheduled for later',mode:'scheduled',scheduledAt:date});assert.equal(postResp.status,201);
  const post=(await postResp.json()).post;assert.equal(post.status,'scheduled');
  const list=await (await request('/api/posts')).json();assert.equal(list.posts.length,1);
  const cancel=await request('/api/posts/'+post.id+'/cancel','POST',{});assert.equal(cancel.status,200);
  const disconnect=await request('/api/accounts/12345','DELETE');assert.equal(disconnect.status,200);
  const after=(await (await request('/api/posts')).json()).posts[0];assert.equal(after.status,'canceled');assert.equal(after.accountId,null);
  const logout=await request('/api/logout','POST',{});assert.equal(logout.status,200);
  const afterLogout=await request('/api/accounts');assert.equal(afterLogout.status,401);
});
