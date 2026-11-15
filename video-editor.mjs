/**
 * Zaininsta Studio server-side video editor.
 * FFmpeg receives only local server-managed files and validated numeric options.
 * No shell, URLs, user-supplied filter expressions, or user-supplied filesystem paths.
 */
import { spawn } from 'node:child_process';

export class EditValidationError extends Error {}
const bad = msg => { throw new EditValidationError(msg); };
function decimal(value, label, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) bad(`${label} must be between ${min} and ${max}.`);
  return n;
}
function choice(value, label, items, fallback) {
  const v = value === undefined ? fallback : value;
  if (!items.includes(v)) bad(`Invalid ${label}.`);
  return v;
}
export const SIZES = Object.freeze({
  '9:16': [[480,854],[720,1280],[1080,1920]],
  '4:5': [[480,600],[720,900],[1080,1350]],
  '1:1': [[480,480],[720,720],[1080,1080]],
  '16:9': [[854,480],[1280,720],[1920,1080]],
});
export function validateEdit(body, metadata) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Invalid editor settings.');
  const duration = Number(metadata?.duration);
  if (!Number.isFinite(duration) || duration <= 0) bad('Video duration could not be read.');
  const trimStart = decimal(body.trimStart,'Trim start',0,Math.max(0,duration-.1),0);
  const trimEnd = decimal(body.trimEnd,'Trim end',.1,duration,duration);
  if (trimEnd - trimStart < .2 || trimEnd <= trimStart) bad('Select at least 0.2 seconds of video.');
  const speed = decimal(body.speed,'Speed',.5,2,1);
  if ((trimEnd - trimStart) / speed > 180) bad('Edited videos must be 180 seconds or shorter. Trim more video or increase speed.');
  const aspect = choice(body.aspect,'aspect ratio',Object.keys(SIZES),'9:16');
  const quality = choice(Number(body.quality ?? 720),'output quality',[480,720,1080],720);
  const rotation = choice(Number(body.rotation ?? 0),'rotation',[0,90,180,270],0);
  const musicMode = choice(body.musicMode,'music mode',['mix','replace'],'mix');
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length > 140 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) bad('Overlay text must contain no more than 140 printable characters.');
  const textColor = choice(String(body.textColor ?? '#FFFFFF').toUpperCase(),'text color', ['#FFFFFF','#000000','#FACC15','#EC4899','#8B5CF6','#22C55E'],'#FFFFFF');
  return {
    trimStart, trimEnd, speed, aspect, quality, rotation,
    zoom:decimal(body.zoom,'Crop zoom',1,2,1),
    cropX:decimal(body.cropX,'Horizontal crop position',0,100,50),
    cropY:decimal(body.cropY,'Vertical crop position',0,100,50),
    brightness:decimal(body.brightness,'Brightness',-100,100,0),
    contrast:decimal(body.contrast,'Contrast',-100,100,0),
    saturation:decimal(body.saturation,'Saturation',0,200,100),
    gamma:decimal(body.gamma,'Gamma',.5,2,1),
    hue:decimal(body.hue,'Hue',-180,180,0),
    temperature:decimal(body.temperature,'Color temperature',-100,100,0),
    originalVolume:decimal(body.originalVolume,'Original volume',0,200,100),
    musicVolume:decimal(body.musicVolume,'Music volume',0,200,60),
    musicMode,
    overlayOpacity:decimal(body.overlayOpacity,'Overlay opacity',0,100,100),
    overlayScale:decimal(body.overlayScale,'Overlay width',5,80,25),
    overlayX:decimal(body.overlayX,'Overlay horizontal position',0,100,50),
    overlayY:decimal(body.overlayY,'Overlay vertical position',0,100,50),
    text,
    textColor,
    textSize:decimal(body.textSize,'Font size',16,90,38),
    textX:decimal(body.textX,'Text horizontal position',0,100,50),
    textY:decimal(body.textY,'Text vertical position',0,100,80)
  };
}

function safeFilterPath(filename) {
  // Quoting FFmpeg filter values requires escaping filtergraph delimiters,
  // not shell quoting (spawn does not run a shell).
  return String(filename).replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/,/g,'\\,').replace(/'/g,"\\'").replace(/\[/g,'\\[').replace(/\]/g,'\\]');
}
export function buildRenderArgs({ sourcePath, outputPath, settings:s, metadata, musicPath, overlayPath, textPath, threads=2 }) {
  const [width,height] = SIZES[s.aspect][{480:0,720:1,1080:2}[s.quality]];
  if (!Number.isInteger(threads) || threads<1 || threads>8) bad('Invalid render threads.');
  const selectedDuration = s.trimEnd - s.trimStart;
  const outputDuration = selectedDuration / s.speed;
  const args = ['-hide_banner','-nostdin','-loglevel','error','-y','-threads',String(threads),
    '-ss',String(s.trimStart),'-t',String(selectedDuration),'-i',sourcePath];
  let overlayIndex = -1, musicIndex = -1, nextInput = 1;
  if (overlayPath) { overlayIndex=nextInput++;args.push('-loop','1','-i',overlayPath); }
  if (musicPath) { musicIndex=nextInput++;args.push('-stream_loop','-1','-i',musicPath); }
  const ratio = width/height;
  const rot = {0:'',90:'transpose=1,',180:'hflip,vflip,',270:'transpose=2,'}[s.rotation];
  const bright = (s.brightness/200).toFixed(4);
  const contrast = (1+s.contrast/100).toFixed(4);
  const saturation = (s.saturation/100).toFixed(4);
  const temperature = (s.temperature/500).toFixed(4);
  const filters = [];
  filters.push(`[0:v]fps=30,${rot}crop=w='trunc(min(iw\\,ih*${ratio})/${s.zoom}/2)*2':h='trunc(min(ih\\,iw/${ratio})/${s.zoom}/2)*2':x='(iw-ow)*${s.cropX/100}':y='(ih-oh)*${s.cropY/100}',scale=${width}:${height}:flags=lanczos,setsar=1,eq=brightness=${bright}:contrast=${contrast}:saturation=${saturation}:gamma=${s.gamma},hue=h=${s.hue},colorbalance=rs=${temperature}:bs=${-Number(temperature)},setpts=(PTS-STARTPTS)/${s.speed}[v0]`);
  let video = 'v0'; let vCount=0;
  if (overlayIndex!==-1) {
    const overlayWidth=Math.round(width*s.overlayScale/100/2)*2;
    filters.push(`[${overlayIndex}:v]scale=${overlayWidth}:-2,format=rgba,colorchannelmixer=aa=${s.overlayOpacity/100}[logo]`);
    filters.push(`[${video}][logo]overlay=x='(W-w)*${s.overlayX/100}':y='(H-h)*${s.overlayY/100}':shortest=1[v${++vCount}]`);
    video=`v${vCount}`;
  }
  if (s.text) {
    if (!textPath) bad('Overlay text file is missing.');
    const c = s.textColor.slice(1);
    // Text content is stored in a dedicated UTF-8 file, never interpolated into filters.
    filters.push(`[${video}]drawtext=textfile='${safeFilterPath(textPath)}':expansion=none:reload=0:fontcolor=0x${c}:fontsize=${s.textSize}:x='(w-text_w)*${s.textX/100}':y='(h-text_h)*${s.textY/100}':box=1:boxcolor=black@0.35:boxborderw=10[v${++vCount}]`);
    video=`v${vCount}`;
  }
  let audio = null;
  if (metadata.hasAudio && (!musicPath || s.musicMode==='mix')) {
    filters.push(`[0:a]asetpts=PTS-STARTPTS,atempo=${s.speed},volume=${s.originalVolume/100}[original]`);
    audio='original';
  }
  if (musicIndex!==-1) {
    filters.push(`[${musicIndex}:a]asetpts=PTS-STARTPTS,atrim=duration=${outputDuration},volume=${s.musicVolume/100}[music]`);
    if (audio) {
      filters.push(`[${audio}][music]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]`);
      audio='aout';
    } else audio='music';
  }
  args.push('-filter_complex',filters.join(';'),'-map',`[${video}]`);
  if (audio) args.push('-map',`[${audio}]`,'-c:a','aac','-b:a','128k');
  else args.push('-an');
  args.push('-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-r','30',
    '-threads',String(threads),'-t',String(outputDuration),'-movflags','+faststart','-max_muxing_queue_size','1024',
    '-progress','pipe:1','-nostats','-f','mp4',outputPath);
  return {args,outputDuration,width,height};
}

export function runProcess(binary,args,{ timeoutMs=20_000, maxOutput=64_000, onStdout }={}) {
  return new Promise((resolve,reject)=>{
    const proc=spawn(binary,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='',stderr='',settled=false;
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;proc.kill('SIGKILL');},timeoutMs);
    function done(error,result) { if(settled)return;settled=true;clearTimeout(timer); if(error)reject(error);else resolve(result); }
    proc.stdout.on('data',data=>{const text=data.toString();stdout=(stdout+text).slice(-maxOutput); if(onStdout)onStdout(text);});
    proc.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-maxOutput);});
    proc.on('error',error=>done(new Error(`${binary} could not start: ${error.code||error.message}`)));
    proc.on('close',(code,signal)=> code===0 ? done(null,{stdout,stderr}) : done(new Error(timedOut?`${binary} timed out after ${Math.ceil(timeoutMs/1000)} seconds.`:signal?`${binary} terminated by ${signal}. ${stderr.slice(-1300)}`:`${binary} exited with status ${code}. ${stderr.slice(-1300) || 'Check FFmpeg availability and input media.'}`)));
  });
}
export async function probeVideo(file) {
  const {stdout}=await runProcess('ffprobe',['-v','error','-show_format','-show_streams','-of','json',file],{timeoutMs:15_000});
  let data;try {data=JSON.parse(stdout);}catch{bad('Unable to inspect video metadata.');}
  const stream=data.streams?.find(s=>s.codec_type==='video');
  const duration=Number(data.format?.duration||stream?.duration);
  if(!stream || !Number.isFinite(duration) || duration<.3)bad('Upload a valid video containing at least 0.3 seconds of footage.');
  if(stream.width<40 || stream.height<40)bad('Video dimensions are too small to edit.');
  return {duration:Number(duration.toFixed(3)),width:stream.width,height:stream.height,hasAudio:!!data.streams?.some(s=>s.codec_type==='audio')};
}
