// Robosys scheduled publisher — GitHub Actions edition.
// Ports the proven n8n chain: pick one due item of a given media type, push it to
// Instagram (+ Facebook), write the result back into queue.json. Runs on GitHub's
// servers on a cron schedule — no laptop required.
//
// Usage:  node scripts/publish.mjs REELS
//         node scripts/publish.mjs IMAGE
//
// Required env (injected from GitHub Actions Secrets):
//   META_IG_ACCESS_TOKEN, META_IG_ACCOUNT_ID, META_PAGE_ID, META_PAGE_ACCESS_TOKEN
// Optional env (Actions provides GITHUB_REPOSITORY automatically):
//   GITHUB_REPOSITORY (owner/repo), GITHUB_REF_NAME / branch (default: main)
//
// Exit codes: 0 = posted OR nothing due (both are success). Non-zero = real failure
// (bad config, API error before publish) so the Action run goes red and is visible.

import { readFile, writeFile } from 'node:fs/promises';

const IG_API = 'https://graph.instagram.com/v21.0';
const FB_API = 'https://graph.facebook.com/v21.0';
const QUEUE_PATH = new URL('../queue.json', import.meta.url);

const mediaTypeArg = (process.argv[2] || '').toUpperCase();
if (mediaTypeArg !== 'REELS' && mediaTypeArg !== 'IMAGE') {
  fail(`First argument must be REELS or IMAGE (got "${process.argv[2] || ''}")`);
}

const env = process.env;
for (const k of ['META_IG_ACCESS_TOKEN', 'META_IG_ACCOUNT_ID', 'META_PAGE_ID', 'META_PAGE_ACCESS_TOKEN']) {
  if (!env[k]) fail(`Missing required env var ${k}`);
}

const repo = env.GITHUB_REPOSITORY || 'relt602-dev/hoboho';
const branch = env.BRANCH || env.GITHUB_REF_NAME || 'main';

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(msg);
}
function todayICT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function graphGET(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${res.status}: ${JSON.stringify(body)}`);
  return body;
}
async function graphPOST(base, path, params) {
  const url = `${base}/${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const raw = await readFile(QUEUE_PATH, 'utf8');
  const queue = JSON.parse(raw);
  const today = todayICT();

  const idx = queue.items.findIndex(
    (it) => it.status === 'ready' && it.scheduledAt <= today && it.mediaType === mediaTypeArg
  );

  if (idx === -1) {
    log(`Nothing due for ${mediaTypeArg} on ${today}.`);
    // Signal "no change" so the Action skips the commit step.
    await writeFile(process.env.GITHUB_OUTPUT || '/dev/null', 'posted=false\n', { flag: 'a' }).catch(() => {});
    return;
  }

  const item = queue.items[idx];
  const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${item.filePath}`;
  log(`Due: ${item.slug} (${mediaTypeArg}) -> ${rawUrl}`);

  // 1. Create the IG media container.
  const createParams = {
    access_token: env.META_IG_ACCESS_TOKEN,
    caption: item.caption,
  };
  if (mediaTypeArg === 'REELS') {
    createParams.video_url = rawUrl;
    createParams.media_type = 'REELS';
  } else {
    createParams.image_url = rawUrl;
  }
  const container = await graphPOST(IG_API, `${env.META_IG_ACCOUNT_ID}/media`, createParams);
  const containerId = container.id;
  if (!containerId) throw new Error(`No container id returned: ${JSON.stringify(container)}`);
  log(`Container: ${containerId}`);

  // 2. Reels must finish processing before publish. Poll status_code.
  if (mediaTypeArg === 'REELS') {
    const maxAttempts = 24; // ~2 min at 5s
    let finished = false;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(5000);
      const st = await graphGET(
        `${IG_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(env.META_IG_ACCESS_TOKEN)}`
      );
      log(`  poll ${i + 1}: ${st.status_code}`);
      if (st.status_code === 'FINISHED') { finished = true; break; }
      if (st.status_code === 'ERROR') throw new Error('Instagram container processing ERROR');
    }
    if (!finished) throw new Error('Timed out waiting for reel container to finish');
  } else {
    await sleep(3000); // let the CDN settle for images
  }

  // 3. Publish. This is the point the post goes live.
  const published = await graphPOST(IG_API, `${env.META_IG_ACCOUNT_ID}/media_publish`, {
    creation_id: containerId,
    access_token: env.META_IG_ACCESS_TOKEN,
  });
  const mediaId = published.id;
  if (!mediaId) throw new Error(`Publish returned no id: ${JSON.stringify(published)}`);
  log(`Published IG media id: ${mediaId}`);

  // From here on, nothing throws — the post is already live, so we must always
  // reach the queue write-back to avoid a duplicate on the next run.
  let igPermalink = '';
  try {
    const pl = await graphGET(
      `${IG_API}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(env.META_IG_ACCESS_TOKEN)}`
    );
    igPermalink = pl.permalink || '';
  } catch (e) {
    log(`WARN: could not fetch IG permalink: ${e.message}`);
  }
  log(`IG permalink: ${igPermalink || '(unknown)'}`);

  // 4. Facebook Page — best effort, never blocks the IG result.
  let fbPermalink = '';
  try {
    const edge = mediaTypeArg === 'REELS' ? 'videos' : 'photos';
    const fbParams = { access_token: env.META_PAGE_ACCESS_TOKEN };
    if (mediaTypeArg === 'REELS') {
      fbParams.file_url = rawUrl;
      fbParams.description = item.caption;
    } else {
      fbParams.url = rawUrl;
      fbParams.caption = item.caption;
    }
    const fb = await graphPOST(FB_API, `${env.META_PAGE_ID}/${edge}`, fbParams);
    const fbId = fb.post_id || fb.id;
    try {
      const fbpl = await graphGET(
        `${FB_API}/${fbId}?fields=permalink_url&access_token=${encodeURIComponent(env.META_PAGE_ACCESS_TOKEN)}`
      );
      fbPermalink = fbpl.permalink_url || `POSTED:${fbId}`;
    } catch {
      fbPermalink = `POSTED:${fbId}`;
    }
  } catch (e) {
    fbPermalink = `FAILED: ${e.message}`;
    log(`WARN: Facebook post failed: ${e.message}`);
  }
  log(`FB result: ${fbPermalink}`);

  // 5. Mark posted and write queue.json back.
  item.status = 'posted';
  item.postedAt = today;
  item.permalink = igPermalink;
  item.permalinkFacebook = fbPermalink;
  await writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2) + '\n', 'utf8');
  log(`Marked ${item.slug} posted; queue.json updated.`);
  await writeFile(process.env.GITHUB_OUTPUT || '/dev/null', 'posted=true\n', { flag: 'a' }).catch(() => {});
}

main().catch((e) => fail(e.message));
