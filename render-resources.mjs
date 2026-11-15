/**
 * Best-effort preflight for FFmpeg rendering on low-resource hosts.
 * Cgroup limits and filesystem statistics may not reflect billing quotas.
 * Never claims to predict Railway credits or to guarantee a render will finish.
 */
import fs from 'node:fs/promises';

const MiB = 1024 * 1024;
const finitePositive = n => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
async function read(file) {
  try { return (await fs.readFile(file, 'utf8')).trim(); } catch { return ''; }
}
export async function getRenderResources(directory) {
  const maxText = await read('/sys/fs/cgroup/memory.max');
  const v1Text = maxText ? '' : await read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const numeric = finitePositive(maxText || v1Text);
  const memoryLimitBytes = numeric && numeric < 1e15 ? numeric : null;
  const usedText = await read('/sys/fs/cgroup/memory.current') || await read('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const memoryUsedBytes = finitePositive(usedText);
  const cpuText = await read('/sys/fs/cgroup/cpu.max');
  let cpuQuota = null;
  if (cpuText && !cpuText.startsWith('max')) {
    const [quota,period] = cpuText.split(/\s+/).map(Number);
    if (quota > 0 && period > 0) cpuQuota = quota / period;
  } else if (!cpuText) {
    const quota=finitePositive(await read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
    const period=finitePositive(await read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (quota && period) cpuQuota=quota/period;
  }
  let diskAvailableBytes = null;
  try {
    const stats=await fs.statfs(directory);
    diskAvailableBytes=stats.bavail * stats.bsize;
  } catch {}
  return { memoryLimitBytes, memoryUsedBytes, cpuQuota, diskAvailableBytes };
}

export function evaluateRenderResources(settings, resources={}) {
  const quality = Number(settings.quality);
  const duration = (settings.trimEnd - settings.trimStart) / settings.speed;
  const warnings = [], errors = [];
  const ram = resources.memoryLimitBytes == null ? null : resources.memoryLimitBytes/MiB;
  const freeRam = ram !== null && resources.memoryUsedBytes != null ? (resources.memoryLimitBytes-resources.memoryUsedBytes)/MiB : null;
  const disk = resources.diskAvailableBytes == null ? null : resources.diskAvailableBytes/MiB;
  const estimatedOutputMiB = Math.ceil(duration * ({480:.26,720:.48,1080:.9}[quality]||.48) + 8);
  if (ram !== null) {
    if (quality===1080 && ram < 1536)
      errors.push(`1080p server rendering is disabled because this server has only ${Math.round(ram)} MB RAM (recommended minimum: 1536 MB). Render locally, or choose 720p/480p.`);
    else if (quality===720 && ram < 768)
      warnings.push(`Only ${Math.round(ram)} MB RAM detected. 720p with overlays may fail. Try 480p or render locally.`);
    else if (quality===480 && ram < 512)
      warnings.push(`Only ${Math.round(ram)} MB RAM detected. Even 480p rendering may fail on this server.`);
    if (freeRam !== null && freeRam < 180)
      warnings.push(`Less than ${Math.max(0,Math.round(freeRam))} MB RAM is currently free in the container. The render could be killed.`);
  } else if (quality===1080) {
    warnings.push('Server RAM limit could not be detected. 1080p may require 2 GB RAM or more. Use local rendering on a small host.');
  }
  if (resources.cpuQuota!==null && resources.cpuQuota!==undefined && resources.cpuQuota < 1.5)
    warnings.push(`Only ${resources.cpuQuota.toFixed(2)} vCPU quota detected. Rendering may be slow or hit the 8-minute timeout.`);
  if (disk!==null) {
    if (disk < estimatedOutputMiB + 32)
      errors.push(`Not enough disk space to render: approximately ${Math.ceil(disk)} MB free; reserve at least ${estimatedOutputMiB+32} MB. Delete unused media or render locally.`);
    else if (disk < estimatedOutputMiB + 120)
      warnings.push(`Disk space is low (${Math.ceil(disk)} MB free). The render may fail as the volume fills.`);
  }
  return { ok:errors.length===0, errors, warnings, estimatedOutputMiB,
    resources:{ memoryLimitMB:ram===null?null:Math.round(ram),
      memoryAvailableMB:freeRam===null?null:Math.max(0,Math.round(freeRam)),
      cpuQuota:resources.cpuQuota??null,
      diskAvailableMB:disk===null?null:Math.max(0,Math.round(disk)) } };
}

export function humanRenderFailure(message) {
  const s=String(message||'Unknown FFmpeg failure');
  if (/ENOSPC|No space left|disk full/i.test(s)) return 'Rendering stopped: the server volume is full. Clear unused media or render locally and upload the MP4.';
  if (/SIGKILL|status null|out of memory|ENOMEM|Cannot allocate memory/i.test(s)) return 'Rendering stopped: FFmpeg was killed, possibly by the server memory limit. Choose 480p or render on your computer.';
  if (/timed out|timeout/i.test(s)) return 'Rendering exceeded the server 8-minute limit. Trim the video, use 480p, or render locally.';
  return s.slice(-600).replace(/[\r\n]+/g,' ');
}
