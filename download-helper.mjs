import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Only direct first-party Instagram CDNs can be fetched server-side. */
export function isTrustedInstagramCdn(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['fbcdn.net', 'cdninstagram.com'].some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain));
  } catch { return false; }
}

export function instagramShortcode(url) {
  try {
    const u = new URL(url);
    if (!['www.instagram.com','instagram.com','m.instagram.com'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)\/?$/);
    return m ? m[1] : null;
  } catch { return null; }
}

function selectVideo(record) {
  if (record.media_type === 'VIDEO' && record.media_url) return record.media_url;
  if (record.media_type === 'CAROUSEL_ALBUM') {
    const children = record.children?.data || [];
    return children.find(child => child.media_type === 'VIDEO' && child.media_url)?.media_url || null;
  }
  return null;
}

/**
 * Locate a video the connected Instagram professional account can access.
 * No arbitrary public Instagram scraping, no cookies, no private media access.
 * Expects Graph listMedia returning {data, paging} for an account/cursor.
 */
export async function findOwnedVideo({ url, accounts, listMedia, maxPages = 5 }) {
  const shortcode = instagramShortcode(url);
  if (!shortcode || !accounts?.length) return null;
  for (const account of accounts) {
    let after = null;
    const seen = new Set();
    for (let page = 0; page < maxPages; page++) {
      let result;
      try { result = await listMedia(account, after); }
      catch { break; } // A disconnected/expired account should not prevent public fallback.
      if (!Array.isArray(result?.data)) break;
      for (const media of result.data) {
        const mediaShortcode = String(media.shortcode || '') || instagramShortcode(media.permalink);
        if (mediaShortcode !== shortcode) continue;
        const mediaUrl = selectVideo(media);
        if (mediaUrl && isTrustedInstagramCdn(mediaUrl)) return { url: mediaUrl, accountId: account.id };
        // If Meta doesn't return a video URL (copyright/music restrictions),
        // try the public extractor instead of returning an inaccessible URL.
        return null;
      }
      const next = result.paging?.cursors?.after;
      if (!next || !result.paging?.next || seen.has(next)) break;
      after = next;
      seen.add(after);
    }
  }
  return null;
}

/** A short actionable error without exposing request headers, access tokens, or cookies. */
export function classifyExtractorFailure(stderr = '', exitCode = null) {
  const raw = String(stderr);
  if (/login required|log in to access|login to access|rate.limit|requested content is not available|HTTP Error (?:403|429)|empty media response|sign in to confirm/i.test(raw)) {
    return 'Instagram blocked this public video request from the hosting server (login required, rate limited, or unavailable). Try a post from your connected Instagram account, or save an authorized copy using Instagram or an external download service.';
  }
  if (/HTTP Error 404|post is unavailable|private account|not available/i.test(raw)) {
    return 'The post may have been deleted, made private, or restricted. Check that it is public and its URL opens in a logged-out browser.';
  }
  if (/Unsupported URL|No video formats|requested format is not available/i.test(raw)) {
    return 'No downloadable video was found at that Instagram link. Check that it points to a Reel or video post.';
  }
  if (/No space left on device|disk quota exceeded/i.test(raw)) {
    return 'Storage is full. Free space on your Railway /app/data volume before downloading again.';
  }
  if (/timed out|timeout|Temporary failure in name resolution|name or service not known/i.test(raw)) {
    return 'The Instagram connection timed out or DNS failed from the server. Retry later and inspect Railway networking logs.';
  }
  return `yt-dlp failed (exit ${exitCode ?? '?'}). See your Railway logs for diagnostics; public Instagram links may require a logged-in session or be restricted by the platform.`;
}

/**
 * Streams an authorized Meta media URL to private storage; validates *each*
 * redirect to prevent fetching arbitrary/private network resources.
 * Tests may inject a local response stub as fetchImpl.
 */
export async function streamOwnedVideo(mediaUrl, destination, { fetchImpl = fetch, maxBytes = 250 * 1024 * 1024, timeoutMs = 75_000 } = {}) {
  let url = mediaUrl;
  for (let hop = 0; hop < 4; hop++) {
    if (!isTrustedInstagramCdn(url)) throw new Error('Meta provided a media URL outside trusted Instagram CDN hosts.');
    const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'video/*,application/octet-stream' } });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Instagram CDN returned a redirect without a location.');
      await response.body?.cancel();
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Instagram CDN returned HTTP ${response.status}. The media URL may have expired.`);
    const len = Number(response.headers.get('content-length') || 0);
    if (len > maxBytes) { await response.body.cancel(); throw new Error('Video exceeds the 250 MB download limit.'); }
    const mime = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (mime && !mime.startsWith('video/') && mime !== 'application/octet-stream') {
      await response.body.cancel(); throw new Error('Instagram CDN did not return a video file.');
    }
    let bytes = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) done(new Error('Video exceeds the 250 MB download limit.'));
      else done(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(destination, { flags: 'wx' }));
      if (!bytes) throw new Error('Instagram CDN returned an empty video.');
      return bytes;
    } catch (err) {
      await fsp.rm(destination, { force: true }).catch(() => {});
      throw err;
    }
  }
  throw new Error('Instagram CDN redirected too many times.');
}
