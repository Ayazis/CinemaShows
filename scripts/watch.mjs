// Personal ticket watcher. Polls each watch's source (Kinepolis's
// programmation API, or a Kino Rotterdam film page scrape) — evaluates every
// entry in watches.json, and opens a GitHub issue when a watched date
// *becomes* bookable.
//
// State lives in .watch-state.json, committed back by the workflow, as
// { watchKey: { date: discoveredAtISO } }. A watch with no state yet is
// seeded silently — otherwise adding a watch whose range is already on sale
// would fire an alert per day. Only the transition "not bookable -> bookable"
// is reported, matching how the app frames it. A date's discoveredAt is set
// once, the first time it's seen, and carried forward unchanged after that.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PROG_API = 'https://kinepolisweb-programmation.kinepolis.com/api/Programmation/BE/NL/WWW/Cinema/KinepolisBelgium';
const LD_JSON_RE = /<script type="application\/ld\+json">({"@context":"https:\/\/schema\.org\/","@graph":\[\{"@type":"ScreeningEvent".*?)<\/script>/g;
const STATE_FILE = new URL('../.watch-state.json', import.meta.url);
const WATCH_FILE = new URL('../watches.json', import.meta.url);
const APP_URL = process.env.APP_URL || '';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const LABEL = 'ticket-alert';
// Who to ping. Assignee puts it in the "Assigned" inbox; the @mention in the
// body is what reliably pushes through the GitHub mobile app. Defaults to the
// repo owner, which for a personal watcher is always right.
const NOTIFY_USER = process.env.NOTIFY_USER || (REPO || '').split('/')[0];
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || '';

const wallDate = s => s.showtime.slice(0, 10);
const wallTime = s => s.showtime.slice(11, 16);
// Mirrors index.html: attributes arrive in either shape depending on the feed.
const has = (s, code) => (s.sessionAttributes || []).some(a => a.code === code) ||
  ('' + (s.rawSessionAttributes || '')).split(',').includes(code);

// Identity of a watch = its filters, not its display name, so renaming a watch
// doesn't re-seed it but changing what it watches does.
const watchKey = w => [
  w.source && w.source !== 'kinepolis' ? w.source : null, // omitted for kinepolis to keep existing state keys stable
  w.movie || w.url, w.format || '', w.cinema || '', w.from || '', w.to || ''
].filter(x => x !== null).join('|');

async function gh(path, init = {}) {
  const r = await fetch('https://api.github.com' + path, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: 'Bearer ' + TOKEN,
      'content-type': 'application/json',
      ...init.headers
    }
  });
  if (!r.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function fetchProgrammation() {
  // Their edge serves a 403 "Suspicious Activity" page to bare clients, so send
  // browser-ish headers. A trimmed User-Agent is enough to trip it.
  const r = await fetch(PROG_API, {
    headers: {
      accept: '*/*',
      'accept-language': 'nl-BE,nl;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      referer: 'https://kinepolis.be/'
    }
  });
  if (!r.ok) throw new Error('programmation API HTTP ' + r.status);
  return r.json();
}

// Bookable days for one watch, as [{ date, times, cinemas }]. Returns all
// bookable dates matching the filters, without date range constraints. Exported
// so it can be exercised without touching the GitHub API.
export function evaluate(prog, w) {
  const sessions = Array.isArray(prog.sessions) ? prog.sessions : Object.values(prog.sessions || {});
  const byDate = new Map();
  for (const s of sessions) {
    if (!s.film || s.film.id !== w.movie) continue;
    if (w.cinema && s.mainComplex !== w.cinema) continue;
    if (w.format && !has(s, w.format)) continue;
    if (s.isSoldOut) continue;
    const d = wallDate(s);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(s);
  }
  return [...byDate.entries()].sort().map(([date, ss]) => ({
    date,
    times: [...new Set(ss.map(wallTime))].sort(),
    cinemas: [...new Set(ss.map(s => s.cinemaLabel || s.mainComplex))].sort()
  }));
}

// Kino Rotterdam has no API — the film page is server-rendered with one
// JSON-LD ScreeningEvent block per showtime.
// A plain fetch works; unlike Kinepolis, their edge doesn't block bare clients.
//
// Scraping fails differently from an API: markup drift yields *zero* events
// rather than an error, and "no events" is indistinguishable from "no dates on
// sale" — which would blank this watch's state and kill its alerting for good.
// So treat an empty parse as a hard failure: a live film page always lists at
// least one showtime.
async function fetchKinoRotterdam(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' } });
  if (!r.ok) throw new Error(`Kino Rotterdam ${url} -> HTTP ${r.status}`);
  const html = await r.text();
  const events = [];
  let malformed = 0;
  for (const m of html.matchAll(LD_JSON_RE)) {
    try {
      const graph = JSON.parse(m[1])['@graph'] || [];
      for (const g of graph) if (g['@type'] === 'ScreeningEvent') events.push(g);
    } catch { malformed++; }
  }
  if (malformed) console.warn(`  ${url}: skipped ${malformed} malformed JSON-LD block(s)`);
  if (!events.length) throw new Error(`Kino Rotterdam ${url} -> no ScreeningEvent blocks parsed (page markup likely changed)`);
  return events;
}

// Bookable days for one Kino Rotterdam watch, in the same [{date, times,
// cinemas}] shape evaluate() returns for Kinepolis. There's one showing per
// film page (no per-cinema/format filtering — the page itself is the format).
export function evaluateKinoRotterdam(events) {
  const byDate = new Map();
  for (const e of events) {
    if (e.eventStatus && e.eventStatus !== 'https://schema.org/EventScheduled') continue;
    // startDate is optional in the schema, and one malformed block shouldn't
    // take down the whole run — including the other watches' alerts.
    if (typeof e.startDate !== 'string') continue;
    const d = e.startDate.slice(0, 10);
    const t = e.startDate.slice(11, 16);
    if (!byDate.has(d)) byDate.set(d, new Set());
    byDate.get(d).add(t);
  }
  return [...byDate.entries()].sort().map(([date, times]) => ({
    date,
    times: [...times].sort(),
    cinemas: ['KINO Rotterdam']
  }));
}

function appLink(w) {
  if (w.source === 'kino-rotterdam') return w.url || '';
  if (!APP_URL) return '';
  const p = new URLSearchParams();
  if (w.movie) p.set('movie', w.movie);
  if (w.format) p.set('format', w.format);
  if (w.cinema) p.set('cinema', w.cinema);
  if (w.from) p.set('from', w.from);
  if (w.to) p.set('to', w.to);
  return `${APP_URL}?${p}`;
}

// One batch of newly-bookable dates for one watch — the single fact both
// notification channels render, so GitHub and Discord can never disagree on
// what was actually discovered.
function buildAlertEvent(watch, key, freshHits) {
  return {
    watch, key,
    label: watch.name || watch.movie,
    hits: freshHits // [{ date, times, cinemas, discoveredAt }]
  };
}

function issueTitle(event) {
  return event.hits.length === 1
    ? `🎟️ Bookable: ${event.label} — ${event.hits[0].date}`
    : `🎟️ Bookable: ${event.label} — ${event.hits.length} new dates`;
}

function issueBody(event) {
  const { watch, key, label, hits } = event;
  const link = appLink(watch);
  const dateLines = hits.map(h =>
    `- **${h.date}** — ${h.cinemas.join(', ')} · ${h.times.join(', ')} _(discovered ${h.discoveredAt})_`
  );
  // null marks "omit"; '' is a deliberate blank line and must survive.
  return [
    NOTIFY_USER ? `@${NOTIFY_USER}` : null,
    NOTIFY_USER ? '' : null,
    `**${hits.length}** new bookable date${hits.length === 1 ? '' : 's'} for **${label}**.`,
    '',
    ...dateLines,
    '',
    watch.format ? `- Format: ${watch.format}` : null,
    '',
    link ? `[Open in the checker](${link})` : null,
    '',
    `<sub>Watch: \`${key}\`</sub>`
  ].filter(l => l !== null).join('\n');
}

async function postGitHubIssue(event) {
  const title = issueTitle(event);
  await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title, body: issueBody(event), labels: [LABEL],
      ...(NOTIFY_USER ? { assignees: [NOTIFY_USER] } : {})
    })
  });
  console.log('  opened issue: ' + title);
}

async function postDiscord(event) {
  if (!DISCORD_WEBHOOK) return;
  const { watch, label, hits } = event;
  const userIds = watch.discord || [];
  const mention = userIds.length ? ` ${userIds.map(id => `<@${id}>`).join(' ')}` : '';
  const field = (name, value) => value ? { name, value, inline: false } : null;
  const payload = {
    content: mention.trim() ? mention.trim() : null,
    embeds: [{
      title: `🎟️ ${label}`,
      description: hits.map(h =>
        `**${h.date}** — ${h.cinemas.join(', ')}\n${h.times.join(', ')}` +
        (h.discoveredAt ? `\n*discovered ${h.discoveredAt}*` : '')
      ).join('\n\n'),
      color: 0x4ea1ff,
      fields: [
        field('Format', watch.format),
        field('Link', APP_URL ? `[Open checker](${appLink(watch)})` : null)
      ].filter(Boolean)
    }]
  };
  try {
    const r = await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error('Discord HTTP ' + r.status);
  } catch (e) {
    console.warn('discord post failed: ' + e.message);
  }
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const testDiscord = process.argv.includes('--test-discord');

  if (testDiscord) {
    const sampleWatch = { name: 'Test watch', movie: 'TEST', format: 'Test', discord: [] };
    const sampleHit = {
      date: new Date().toISOString().slice(0, 10),
      times: ['19:00'],
      cinemas: ['Test Cinema'],
      discoveredAt: new Date().toISOString()
    };
    await postDiscord(buildAlertEvent(sampleWatch, 'TEST', [sampleHit]));
    console.log('posted test Discord message');
    return;
  }

  const watches = await readJson(WATCH_FILE, []);
  const state = await readJson(STATE_FILE, {});
  const now = new Date().toISOString();
  const next = {};
  let opened = 0;

  // Kinepolis is one shared feed for every watch; Kino Rotterdam is scraped
  // per film page, so cache each fetch by URL instead of doing it once.
  let prog = null;
  const kinoRotterdamPages = new Map();

  for (const w of watches) {
    const source = w.source || 'kinepolis';
    let hits;
    if (source === 'kino-rotterdam') {
      if (!w.url) { console.log(`skip "${w.name || '(unnamed)'}": no url`); continue; }
      if (!kinoRotterdamPages.has(w.url)) kinoRotterdamPages.set(w.url, await fetchKinoRotterdam(w.url));
      hits = evaluateKinoRotterdam(kinoRotterdamPages.get(w.url));
    } else {
      if (!w.movie) { console.log(`skip "${w.name || '(unnamed)'}": no movie HOcode`); continue; }
      if (!prog) prog = await fetchProgrammation();
      hits = evaluate(prog, w);
    }
    const key = watchKey(w);
    const label = w.name || w.movie || w.url;
    // Per-date discovery timestamp: keep it if we've seen the date before,
    // stamp it "now" the first time it appears.
    const prevKnown = state[key] || {};
    next[key] = Object.fromEntries(hits.map(h => [h.date, prevKnown[h.date] || now]));

    if (!(key in state)) {
      console.log(`${label}: seeded with ${hits.length} bookable day(s) — no alerts on first run`);
      continue;
    }

    const known = new Set(Object.keys(prevKnown));
    const fresh = hits.filter(h => !known.has(h.date));
    console.log(`${label}: ${hits.length} bookable day(s), ${fresh.length} new`);

    // One event describes the whole batch; GitHub and Discord each render it
    // independently, so a run that discovers N dates opens one issue and
    // sends one ping, not N of each.
    if (fresh.length) {
      const withDiscoveredAt = fresh.map(h => ({ ...h, discoveredAt: next[key][h.date] }));
      const event = buildAlertEvent(w, key, withDiscoveredAt);

      if (dryRun) {
        console.log(`  [dry-run] would open: ${issueTitle(event)}`);
      } else {
        await postGitHubIssue(event);
        opened++;
        await postDiscord(event);
      }
    }
  }

  if (!dryRun) await writeFile(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`done — ${opened} new alert(s)`);
}

// Guard so `import`ing this file (e.g. to test evaluate) doesn't fire a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
