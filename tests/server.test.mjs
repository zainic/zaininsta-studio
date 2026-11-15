import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from '../sqlite-driver.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  await fs.copyFile(path.join(root,'download-helper.mjs'),path.join(tmp,'download-helper.mjs'));
  // Native dependencies are installed at the project root; the isolated
  // test server needs access to the same installation on Node.js 20.
  try { await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'node_modules'),process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EEXIST') throw error; }
  await fs.copyFile(path.join(root,'package.json'),path.join(tmp,'package.json'));
  await fs.cp(path.join(root,'public'),path.join(tmp,'public'),{recursive:true});
  // Run a deterministic extractor fixture with Node on Windows and POSIX.
  const fakeDlp=path.join(tmp,'fake-yt-dlp.mjs');
  await fs.writeFile(fakeDlp, `
import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2), source=args.at(-1);
if(args.includes('--max-downloads') || args[args.indexOf('--playlist-items')+1] !== '1') process.exit(9);
if(args[args.indexOf('--print')+1] !== 'after_move:ZAININSTA_FILE:%(filepath)j') process.exit(9);
if(source.includes('GOODTESTCODE')) {
 console.error('ERROR: [Instagram] Requested content is not available, rate-limit reached or login required'); process.exit(1);
}
const name=args[args.indexOf('-o')+1].replace('%(ext)s','mp4');
const output=path.join(args[args.indexOf('-P')+1],name);
if(source.includes('PARTIALCODE')) { fs.writeFileSync(output+'.part','unfinished'); process.exit(0); }
fs.writeFileSync(output,source.includes('EMPTYCODE') ? '' : 'completed video fixture');
console.log('ZAININSTA_FILE:'+JSON.stringify(output));
process.exit(source.includes('LIMITCODE') ? 101 : 0);
`);
  const preload=path.join(tmp,'extractor-preload.mjs');
  await fs.writeFile(preload, `
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawn;
cp.spawn=(command,args,options)=>command===${JSON.stringify(fakeDlp)} ? original(process.execPath,[command,...args],options) : original(command,args,options);
syncBuiltinESMExports();
`);
  const child=spawn(process.execPath,['server.js'], {cwd:tmp,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(preload).href].filter(Boolean).join(' '),YT_DLP_BIN:fakeDlp,PORT:String(port),APP_BASE_URL:base,PUBLIC_BASE_URL:'https://assets.studio.test',ADMIN_PASSWORD:'test-password-not-for-production',ENCRYPTION_KEY:encKey.toString('base64'),SESSION_SECRET:sessionSecret,GRAPH_VERSION:'v27.0'}, stdio:'ignore'});
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
  const publicDownload=await request('/api/downloads','POST',{url:'https://www.instagram.com/reel/GOODTESTCODE/',confirmRights:true});
  assert.equal(publicDownload.status,202);
  const downloadId=(await publicDownload.json()).id;
  let failedDownload;
  for(let i=0;i<60;i++){
    const downloads=(await (await request('/api/downloads')).json()).downloads;
    failedDownload=downloads.find(d=>d.id===downloadId);
    if(failedDownload?.status==='failed')break;
    await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(failedDownload?.status,'failed');
  assert.match(failedDownload.lastError,/Instagram blocked/);
  assert.equal(failedDownload.sourceMethod,null);

  async function downloadFixture(shortcode) {
    const response=await request('/api/downloads','POST',{url:`https://www.instagram.com/reel/${shortcode}/`,confirmRights:true});
    assert.equal(response.status,202);
    const {id}=await response.json();
    for(let i=0;i<100;i++) {
      const rows=(await (await request('/api/downloads')).json()).downloads;
      const row=rows.find(d=>d.id===id);
      if(row && ['ready','failed'].includes(row.status)) return row;
      await new Promise(r=>setTimeout(r,50));
    }
    throw new Error('Fixture download did not finish');
  }
  const completed=await downloadFixture('SUCCESSCODE');
  assert.equal(completed.status,'ready');
  assert.equal(completed.sourceMethod,'yt-dlp');
  const downloaded=await request(`/api/downloads/${completed.id}/file`);
  assert.equal(downloaded.status,200);
  assert.equal(await downloaded.text(),'completed video fixture');
  for(const [shortcode,message] of [['LIMITCODE',/limit or cancellation/],['PARTIALCODE',/did not finalize/],['EMPTYCODE',/missing, incomplete, or empty/]]) {
    const failed=await downloadFixture(shortcode);
    assert.equal(failed.status,'failed');
    assert.match(failed.lastError,message);
    assert.equal((await fs.readdir(path.join(tmp,'data','downloads'))).some(name=>name.startsWith(failed.id+'.')),false);
  }


  await t.test('clear downloads keeps Deleted history, removes files, and protects active jobs and other files', async () => {
    const downloadDir=path.join(tmp,'data','downloads');
    const fixtureDb=new DatabaseSync(path.join(tmp,'data','studio.sqlite'));
    try {
      const endpoint='/api/downloads/'+completed.id;
      assert.equal((await fetch(base+endpoint,{method:'DELETE',headers:{Origin:base}})).status,401);
      assert.equal((await request(endpoint,'DELETE',undefined,{Origin:'https://untrusted.example'})).status,403);
      assert.equal((await request('/api/downloads/'+crypto.randomUUID(),'DELETE')).status,404);
      const unrelated=completed.id+'x.mp4';
      await fs.writeFile(path.join(downloadDir,unrelated),'keep');
      await fs.writeFile(path.join(downloadDir,completed.id+'.mp4.part'),'partial');
      assert.equal((await request(endpoint,'DELETE')).status,200);
      assert.equal((await request(endpoint+'/file')).status,404);
      const archived=fixtureDb.prepare('SELECT * FROM downloads WHERE id=?').get(completed.id);
      assert.equal(archived.status,'deleted');
      assert.equal(archived.filename,null);
      assert.equal(archived.source_url,completed.sourceUrl);
      assert.equal(archived.created_at,completed.createdAt);
      assert.equal(archived.source_method,completed.sourceMethod);
      assert.ok(Number.isFinite(Date.parse(archived.updated_at)));
      assert.equal((await fs.readdir(downloadDir)).some(name=>name.startsWith(completed.id+'.')),false);
      assert.equal(await fs.readFile(path.join(downloadDir,unrelated),'utf8'),'keep');
      assert.equal((await fetch(base+'/media/'+upload.url.split('/').at(-1))).status,200);
      assert.equal((await request(endpoint,'DELETE')).status,200);
      assert.equal(fixtureDb.prepare('SELECT updated_at FROM downloads WHERE id=?').get(completed.id).updated_at,archived.updated_at);
      const history=(await (await request('/api/downloads')).json()).downloads.find(d=>d.id===completed.id);
      assert.equal(history.status,'deleted');
      assert.equal(history.filename,null);
      assert.equal(history.updatedAt,archived.updated_at);
      assert.equal((await request(endpoint+'/file','GET',undefined,{Range:'bytes=0-15'})).status,404);

      await fs.writeFile(path.join(downloadDir,failedDownload.id+'.mp4.part'),'leftover');
      assert.equal((await request('/api/downloads/'+failedDownload.id,'DELETE')).status,200);
      await assert.rejects(fs.stat(path.join(downloadDir,failedDownload.id+'.mp4.part')),{code:'ENOENT'});
      const failedHistory=fixtureDb.prepare('SELECT status,last_error FROM downloads WHERE id=?').get(failedDownload.id);
      assert.equal(failedHistory.status,'deleted');
      assert.equal(failedHistory.last_error,failedDownload.lastError);

      const insert=fixtureDb.prepare('INSERT INTO downloads (id,source_url,status,filename,created_at,updated_at) VALUES (?,?,?,?,?,?)');
      const stamp=new Date().toISOString();
      for(const status of ['queued','downloading']) {
        const id=crypto.randomUUID(), name=id+'.mp4.part';
        insert.run(id,'https://www.instagram.com/reel/ACTIVE/',status,null,stamp,stamp);
        await fs.writeFile(path.join(downloadDir,name),'in progress');
        assert.equal((await request('/api/downloads/'+id,'DELETE')).status,409);
        assert.equal(fixtureDb.prepare('SELECT status FROM downloads WHERE id=?').get(id).status,status);
        assert.equal(await fs.readFile(path.join(downloadDir,name),'utf8'),'in progress');
      }
      const missingId=crypto.randomUUID();
      insert.run(missingId,'https://www.instagram.com/reel/MISSING/','ready',missingId+'.mp4',stamp,stamp);
      assert.equal((await request('/api/downloads/'+missingId,'DELETE')).status,200);
      assert.equal(fixtureDb.prepare('SELECT status FROM downloads WHERE id=?').get(missingId).status,'deleted');
      const unsafeId=crypto.randomUUID();
      insert.run(unsafeId,'https://www.instagram.com/reel/UNSAFE/','ready','../uploads/keep.mp4',stamp,stamp);
      assert.equal((await request('/api/downloads/'+unsafeId,'DELETE')).status,400);
      assert.ok(fixtureDb.prepare('SELECT id FROM downloads WHERE id=?').get(unsafeId));
      const blockedId=crypto.randomUUID();
      insert.run(blockedId,'https://www.instagram.com/reel/BLOCKED/','ready',blockedId+'.mp4',stamp,stamp);
      await fs.mkdir(path.join(downloadDir,blockedId+'.mp4'));
      assert.equal((await request('/api/downloads/'+blockedId,'DELETE')).status,503);
      assert.equal(fixtureDb.prepare('SELECT status FROM downloads WHERE id=?').get(blockedId).status,'ready');
    } finally { fixtureDb.close(); }
  });

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
