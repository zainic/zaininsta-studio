#!/usr/bin/env node
/**
 * Render an edit recipe exported from the Zaininsta Studio dashboard.
 * Run on your own computer with Node.js 20.18+ and FFmpeg/FFprobe installed.
 * Assets are public media URLs; this script never asks for admin credentials.
 * Only HTTPS URLs (or localhost HTTP in development) from one host are accepted.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { validateEdit, buildRenderArgs, probeVideo, runProcess } from './video-editor.mjs';

function usage() { console.log('Usage: node local-render.mjs /path/to/zaininsta-edit.json [output.mp4]'); }
const MAX = 250*1024*1024;
async function fetchAsset(media, dest, origin, maxBytes=MAX) {
  if (!media) return null;
  const url=new URL(media.url);
  if (url.origin!==origin || (url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))))
    throw new Error('Recipe contains an invalid media URL. Assets must come from one HTTPS Zaininsta host (or local development).');
  if (!/^\/media\/[a-f0-9-]{36}\.(mp4|mov|mp3|m4a|wav|png|jpg|jpeg)$/i.test(url.pathname))
    throw new Error('Only uploaded Zaininsta Media Library files are supported.');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(120_000)});
  if(!response.ok || !response.body)throw new Error(`Could not retrieve ${media.name||url.pathname}: HTTP ${response.status}. Keep your Zaininsta server online.`);
  let count=0;
  const limit=new Transform({transform(chunk,_encoding,cb){count+=chunk.length;cb(count>maxBytes?new Error('Media exceeds download size limit.'):null,chunk);}});
  await pipeline(Readable.fromWeb(response.body),limit,(await import('node:fs')).createWriteStream(dest,{flags:'wx'}));
  console.log(`Downloaded ${media.name||'asset'} (${Math.ceil(count/1024)} KB)`);
  return dest;
}
async function main() {
  if (!process.argv[2] || process.argv.includes('--help')) { usage();process.exitCode=process.argv[2]?0:1;return; }
  const recipe=JSON.parse(await fs.readFile(path.resolve(process.argv[2]),'utf8'));
  if(recipe.format!=='zaininsta-local-render-v1' || !recipe.source?.url)throw new Error('Invalid Zaininsta local-render recipe.');
  const sourceUrl=new URL(recipe.source.url);
  const origin=sourceUrl.origin;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zaininsta-render-'));
  const output=path.resolve(process.argv[3]||path.join(process.cwd(),`zaininsta-edited-${Date.now()}.mp4`));
  try {
    const source=await fetchAsset(recipe.source,path.join(dir,`source${path.extname(sourceUrl.pathname)}`),origin);
    const overlay=recipe.overlay?await fetchAsset(recipe.overlay,path.join(dir,`overlay${path.extname(new URL(recipe.overlay.url).pathname)}`),origin):null;
    const music=recipe.music?await fetchAsset(recipe.music,path.join(dir,`music${path.extname(new URL(recipe.music.url).pathname)}`),origin,25*1024*1024):null;
    const metadata=await probeVideo(source);
    const settings=validateEdit(recipe.settings,metadata);
    const textFile=settings.text?path.join(dir,'overlay.txt'):null;
    if(textFile)await fs.writeFile(textFile,settings.text,'utf8');
    const {args}=buildRenderArgs({sourcePath:source,overlayPath:overlay,musicPath:music,textPath:textFile,settings,metadata,outputPath:output});
    console.log(`Rendering ${settings.quality}p video locally with FFmpeg…`);
    await runProcess('ffmpeg',args,{timeoutMs:60*60_000,onStdout:line=>{if(line.includes('progress=end'))console.log('Video rendering completed.');}});
    const stat=await fs.stat(output);
    if(!stat.size || stat.size>MAX) {await fs.rm(output,{force:true});throw new Error('Rendered video exceeds 250 MB. Shorten the video or lower quality.');}
    console.log(`Saved: ${output}\nOpen Zaininsta Studio → Create Post → Upload local MP4 and schedule it.`);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
main().catch(e=>{console.error('Local render error:',e.message);process.exitCode=1;});
