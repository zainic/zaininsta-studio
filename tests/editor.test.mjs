import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateEdit, buildRenderArgs, EditValidationError, probeVideo } from '../video-editor.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const supported=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0 && spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status===0;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(exe,args){
 const r=spawnSync(exe,args,{encoding:'utf8',timeout:30_000});
 if(r.status!==0)throw new Error(`fixture ${exe} failed: ${r.stderr}`);
}

test('video-editor settings reject unsafe values and generate no shell execution',()=>{
 const meta={duration:10,width:640,height:480,hasAudio:false};
 for(const settings of [
  {trimStart:9,trimEnd:3}, {zoom:100}, {rotation:45}, {text:'hi',textColor:'red'},
  {text:'x'.repeat(150)}, {speed:0}, {quality:4096}, {trimEnd:0.1}
 ]) assert.throws(()=>validateEdit(settings,meta),EditValidationError);
 const s=validateEdit({text:'hello:world',aspect:'4:5',rotation:90},meta);
 const render=buildRenderArgs({sourcePath:'/tmp/my video.mp4',outputPath:'/tmp/output.mp4',settings:s,
  metadata:meta,textPath:'/tmp/text.txt'});
 assert.equal(render.width,720);
 assert.equal(render.height,900);
 assert.match(render.args.join(' '),/transpose=1/);
 assert.match(render.args.join(' '),/textfile=/);
 assert.equal(render.args.at(-1),'/tmp/output.mp4');
});

test('video editing authenticated endpoints render MP4 with sound, text, overlays, and preserved source', { skip:!supported }, async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'zaininsta-edit-integration-'));
 for(const f of ['server.js','sqlite-driver.mjs','download-helper.mjs','video-editor.mjs','render-resources.mjs','package.json'])
   await fs.copyFile(path.join(root,f),path.join(tmp,f));
 await fs.cp(path.join(root,'public'),path.join(tmp,'public'),{recursive:true});
 try{await fs.symlink(path.join(root,'node_modules'),path.join(tmp,'node_modules'),process.platform==='win32'?'junction':'dir');}
 catch(e){if(!['EEXIST','ENOENT'].includes(e.code))throw e;}
 const video=path.join(tmp,'test.mp4'), image=path.join(tmp,'logo.jpg'),music=path.join(tmp,'music.mp3');
 fixture('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x480:rate=15',
  '-f','lavfi','-i','sine=frequency=330:sample_rate=44100','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-y',video]);
 fixture('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=yellow:s=120x60','-frames:v','1','-y',image]);
 fixture('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:a','libmp3lame','-y',music]);
 const port=41000+Math.floor(Math.random()*8000),base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,['server.js'],{cwd:tmp,env:{...process.env,PORT:String(port),APP_BASE_URL:base,PUBLIC_BASE_URL:base,
  ADMIN_PASSWORD:'editor-test-password',ENCRYPTION_KEY:crypto.randomBytes(32).toString('base64'),
  SESSION_SECRET:crypto.randomBytes(40).toString('base64')},stdio:'ignore'});
 t.after(async()=>{child.kill('SIGTERM');await delay(300);await fs.rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:250});});
 let available=false;
 for(let i=0;i<80;i++){
  try{if((await fetch(base+'/api/health')).ok){available=true;break;}}catch{};
  if(child.exitCode!==null)break;
  await delay(100);
 }
 assert.equal(available,true,'test server started');
 const req=(url,method='GET',body,cookie)=>fetch(base+url,{method,headers:{Origin:base,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 assert.equal((await req('/api/editor/probe','POST',{mediaId:'abc'})).status,401);
 const login=await req('/api/login','POST',{password:'editor-test-password'});
 assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie').split(';')[0];
 async function upload(file,mime){
  const body=await fs.readFile(file);
  const r=await fetch(base+'/api/upload',{method:'PUT',headers:{Origin:base,Cookie:cookie,'Content-Type':mime,'X-Filename':path.basename(file)},body});
  assert.equal(r.status,201,`upload ${file}: ${await r.clone().text()}`);
  return (await r.json()).media;
 }
 const source=await upload(video,'video/mp4'), overlay=await upload(image,'image/jpeg'), track=await upload(music,'audio/mpeg');
 const originalBytes=await fs.readFile(video);
 const probe=await req('/api/editor/probe','POST',{mediaId:source.id},cookie);
 assert.equal(probe.status,200);
 const meta=(await probe.json()).metadata;
 assert.equal(meta.width,640);
 assert.equal(meta.hasAudio,true);
 const preflight=await req('/api/editor/preflight','POST',{mediaId:source.id,settings:{quality:480,trimStart:0,trimEnd:1}},cookie);
 assert.equal(preflight.status,200);
 const assessment=(await preflight.json()).assessment;
 assert.equal(typeof assessment.ok,'boolean');
 assert.equal(Array.isArray(assessment.warnings),true);
 assert.equal(assessment.resources.diskAvailableMB===null||assessment.resources.diskAvailableMB>=0,true);
 const invalid=await req('/api/editor/render','POST',{mediaId:source.id,settings:{trimStart:3,trimEnd:1}},cookie);
 assert.equal(invalid.status,400);
 const external=await req('/api/editor/probe','POST',{mediaId:'https://example.com/foo.mp4'},cookie);
 assert.equal(external.status,400);
 const rendered=await req('/api/editor/render','POST',{mediaId:source.id,overlayMediaId:overlay.id,musicMediaId:track.id,settings:{
   aspect:'9:16',quality:720,rotation:90,trimStart:.1,trimEnd:1.8,speed:1.25,
   brightness:10,contrast:5,saturation:120,hue:6,temperature:20,text:'Test text: ✓',textColor:'#FFFFFF',
   overlayScale:20,overlayOpacity:80,musicMode:'mix'}},cookie);
 assert.equal(rendered.status,202,await rendered.clone().text());
 const id=(await rendered.json()).job.id;
 const activeDelete=await req(`/api/media/${source.id}`,'DELETE',undefined,cookie);
 assert.equal(activeDelete.status,409);
 let job;
 for(let i=0;i<120;i++){
  const r=await req(`/api/editor/jobs/${id}`,'GET',undefined,cookie);
  assert.equal(r.status,200);
  job=(await r.json()).job;
  if(['ready','failed'].includes(job.status))break;
  await delay(150);
 }
 assert.equal(job?.status,'ready',job?.lastError);
 assert.equal(job.progress,100);
 assert.match(job.media.url,/\/media\/.+\.mp4/);
 const result=await fetch(job.media.url);
 assert.equal(result.status,200);
 assert.match(result.headers.get('content-type'),/video\/mp4/);
 const uploadedFile=path.join(tmp,'data','uploads',job.media.url.split('/').at(-1));
 const edited=await probeVideo(uploadedFile);
 assert.equal(edited.width,720);
 assert.equal(edited.height,1280);
 assert.equal(edited.hasAudio,true);
 assert.ok(edited.duration>1 && edited.duration<2);
 const storedOriginal=await fs.readFile(path.join(tmp,'data','uploads',source.url.split('/').at(-1)));
 assert.deepEqual(storedOriginal,originalBytes,'original video not overwritten');
 const list=await req('/api/media','GET',undefined,cookie);
 assert.equal((await list.json()).media.length,4);
});
