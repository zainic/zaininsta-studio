import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { findOwnedVideo, streamOwnedVideo, classifyExtractorFailure, isTrustedInstagramCdn, instagramShortcode, finalizedExtractorFile, redactDownloaderDiagnostic } from '../download-helper.mjs';

const sample = 'https://www.instagram.com/reel/DISPLAY_123/';
const cdnUrl = 'https://scontent.cdninstagram.com/v/authorized-video.mp4?oh=signed';

test('Instagram link normalizing and safe CDN host checks', () => {
  assert.equal(instagramShortcode(sample), 'DISPLAY_123');
  assert.equal(instagramShortcode('https://www.instagram.com/p/ABCDEF123?utm_source=x'), 'ABCDEF123');
  assert.equal(instagramShortcode('https://attacker.example.com/reel/XYZ'), null);
  assert.equal(isTrustedInstagramCdn(cdnUrl), true);
  assert.equal(isTrustedInstagramCdn('https://video.xx.fbcdn.net/v/demo.mp4'), true);
  assert.equal(isTrustedInstagramCdn('http://scontent.cdninstagram.com/v/demo.mp4'), false);
  assert.equal(isTrustedInstagramCdn('https://cdninstagram.com.evil.test/file.mp4'), false);
  assert.equal(isTrustedInstagramCdn('https://localhost/file.mp4'), false);
  assert.equal(isTrustedInstagramCdn('https://fbcdn.net:8443/file.mp4'), false);
});

test('find owned Reel and carousel videos on later pages; other accounts are not leaked', async () => {
  const calls=[];
  const result=await findOwnedVideo({url:sample,accounts:[{id:'1'},{id:'2'}],listMedia: async (a,after)=>{
    calls.push([a.id,after]);
    if(a.id==='1')throw new Error('Account needs authorization');
    if(!after)return {data:[{id:'a',shortcode:'OLD',media_type:'IMAGE'}],paging:{next:'x',cursors:{after:'next'}}};
    return {data:[{id:'v',shortcode:'DISPLAY_123',media_type:'VIDEO',media_url:cdnUrl}]};
  }});
  assert.deepEqual(result,{accountId:'2',url:cdnUrl});
  assert.deepEqual(calls,[['1',null],['2',null],['2','next']]);
  const fromCarousel=await findOwnedVideo({url:sample,accounts:[{id:'1'}],listMedia:async()=>({data:[{shortcode:'DISPLAY_123',media_type:'CAROUSEL_ALBUM',children:{data:[{media_type:'IMAGE',media_url:'https://example.com/x.jpg'},{media_type:'VIDEO',media_url:cdnUrl}]}}]})});
  assert.equal(fromCarousel?.url,cdnUrl);
  const unavailable=await findOwnedVideo({url:sample,accounts:[{id:'1'}],listMedia:async()=>({data:[{shortcode:'DISPLAY_123',media_type:'VIDEO',media_url:'http://127.0.0.1/'}]})});
  assert.equal(unavailable,null);
});

test('owned video streaming validates bytes and blocks redirects to private/local networks', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zaininsta-download-test-'));
  try{
    const dest=path.join(dir,'test.mp4');
    const bytes=await streamOwnedVideo(cdnUrl,dest,{fetchImpl:async()=>new Response(Buffer.from('mock MP4 content'),{headers:{'Content-Type':'video/mp4','Content-Length':'16'}})});
    assert.equal(bytes,16);
    assert.equal((await fs.readFile(dest)).toString(),'mock MP4 content');
    await assert.rejects(streamOwnedVideo(cdnUrl,path.join(dir,'evil.mp4'),{fetchImpl:async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/internal'}})}),/trusted Instagram CDN/);
    await assert.rejects(streamOwnedVideo(cdnUrl,path.join(dir,'oversize.mp4'),{maxBytes:2,fetchImpl:async()=>new Response(Buffer.from('lots of content'),{headers:{'Content-Type':'video/mp4'}})}),/download limit/);
    await assert.rejects(fs.stat(path.join(dir,'oversize.mp4')),{code:'ENOENT'});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('yt-dlp failures are actionable, never leak raw tokens', () => {
  const msg=classifyExtractorFailure('ERROR: login required --cookies access_token=SENSITIVE',1);
  assert.match(msg,/Instagram blocked/);
  assert.doesNotMatch(msg,/SENSITIVE/);
  assert.match(classifyExtractorFailure('No space left on device',1),/Storage is full/);
  assert.match(classifyExtractorFailure('ERROR: Unsupported URL',1),/No downloadable video/);
});


test('extractor completion requires one finalized, nonempty job-owned file', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zaininsta-completion-'));
  try {
    const id='job-123', name=id+'.mp4', file=path.join(dir,name);
    const record=value=>'ZAININSTA_FILE:'+JSON.stringify(value)+'\n';
    await fs.writeFile(file,'video data');
    assert.equal(await finalizedExtractorFile(record(file),{directory:dir,id}),name);
    await assert.rejects(finalizedExtractorFile('download started',{directory:dir,id}),/did not finalize/);
    await assert.rejects(finalizedExtractorFile(record(file)+record(file),{directory:dir,id}),/did not finalize/);
    await assert.rejects(finalizedExtractorFile(record(path.join(dir,'other.mp4')),{directory:dir,id}),/invalid output path/);
    await assert.rejects(finalizedExtractorFile(record(path.join(dir,'..',name)),{directory:dir,id}),/invalid output path/);
    await assert.rejects(finalizedExtractorFile(record(file+'.part'),{directory:dir,id}),/invalid output path/);
    await assert.rejects(finalizedExtractorFile(record(file),{directory:dir,id,maxBytes:2}),/250 MB/);
    await fs.writeFile(file,'');
    await assert.rejects(finalizedExtractorFile(record(file),{directory:dir,id}),/empty/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('extractor diagnostics remove URLs and credentials; local failures avoid Railway assumptions', () => {
  const safe=redactDownloaderDiagnostic('https://cdn.example/video?signature=SECRET1\nAuthorization: Bearer SECRET2\nCookie: sessionid=SECRET3; csrftoken=SECRET4\n{"access_token":"SECRET5"}\ntoken=SECRET6');
  assert.doesNotMatch(safe,/SECRET[1-6]/);
  assert.match(classifyExtractorFailure('',101),/limit or cancellation/);
  assert.doesNotMatch(classifyExtractorFailure('',101),/See your Railway/);
  assert.match(classifyExtractorFailure('ERROR: ffmpeg not found',1),/requires FFmpeg/);
  assert.doesNotMatch(classifyExtractorFailure('',9),/Railway|login/);
  assert.match(classifyExtractorFailure('WARNING: ffmpeg not found',101),/limit or cancellation/);
});
