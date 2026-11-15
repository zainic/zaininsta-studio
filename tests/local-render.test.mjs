import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { evaluateRenderResources, humanRenderFailure } from '../render-resources.mjs';
import {probeVideo,validateEdit} from '../video-editor.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hasFFmpeg=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0&&spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status===0;
const MiB=1024*1024;

test('preflight blocks 1080p on 512 MB; warns for 720p and CPU; detects disk errors',()=>{
  const settings={quality:1080,trimStart:0,trimEnd:60,speed:1};
  const resource={memoryLimitBytes:512*MiB,memoryUsedBytes:350*MiB,cpuQuota:1,diskAvailableBytes:400*MiB};
  const blocked=evaluateRenderResources(settings,resource);
  assert.equal(blocked.ok,false);
  assert.match(blocked.errors.join(' '),/1080p.*only 512 MB/i);
  assert.match(blocked.warnings.join(' '),/1.00 vCPU/i);
  const lighter=evaluateRenderResources({...settings,quality:720},resource);
  assert.equal(lighter.ok,true);
  assert.match(lighter.warnings.join(' '),/720p/);
  const safe=evaluateRenderResources({...settings,quality:480},{...resource,memoryLimitBytes:4*1024*MiB,memoryUsedBytes:0,cpuQuota:4});
  assert.equal(safe.ok,true);
  const full=evaluateRenderResources(settings,{...resource,memoryLimitBytes:4*1024*MiB,memoryUsedBytes:0,diskAvailableBytes:12*MiB});
  assert.equal(full.ok,false);
  assert.match(full.errors.join(' '),/Not enough disk/);
  assert.match(humanRenderFailure('ffmpeg terminated by SIGKILL'),/memory limit/i);
  assert.match(humanRenderFailure('ffmpeg timed out after 480 seconds'),/8-minute limit/i);
  assert.match(humanRenderFailure('No space left on device'),/volume is full/i);
  assert.equal(validateEdit({quality:480}, {duration:2,width:640,height:480,hasAudio:false}).quality,480);
});

test('exported local-edit recipe downloads source and renders MP4 without server FFmpeg', {skip:!hasFFmpeg}, async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zaininsta-local-recipe-test-'));
  t.after(async()=>fs.rm(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.mp4'),output=path.join(dir,'result.mp4'),recipePath=path.join(dir,'recipe.json');
  let proc=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=12','-t','1.5','-c:v','libx264','-y',source],{encoding:'utf8',timeout:30000});
  assert.equal(proc.status,0,proc.stderr);
  const name='99999999-9999-4999-8999-999999999999.mp4';
  const server=http.createServer(async(req,res)=>{
    if(req.url!==`/media/${name}`){res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':'video/mp4'});res.end(await fs.readFile(source));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}/media/${name}`;
  await fs.writeFile(recipePath,JSON.stringify({format:'zaininsta-local-render-v1',source:{url,name:'source.mp4'},
    settings:{quality:480,aspect:'9:16',trimStart:0,trimEnd:1,speed:1,brightness:8,text:'Local render passed'}}));
  const child=spawn(process.execPath,['local-render.mjs',recipePath,output],{cwd:ROOT,stdio:['ignore','pipe','pipe']});
  let message='';for(const s of [child.stdout,child.stderr])s.on('data',b=>{message+=b.toString()});
  const [code]=await once(child,'close');
  assert.equal(code,0,message);
  assert.match(message,/Saved:/);
  const metadata=await probeVideo(output);
  assert.equal(metadata.width,480);assert.equal(metadata.height,854);
  assert.ok((await fs.stat(output)).size>500);
});
