// Personal ticket watcher. Polls the same programmation API the browser app
// uses, evaluates every entry in watches.json, and opens a GitHub issue when a
// watched date *becomes* bookable.
//
// State lives in .watch-state.json, committed back by the workflow. A watch
// with no state yet is seeded silently — otherwise adding a watch whose range
// is already on sale would fire an alert per day. Only the transition
// "not bookable -> bookable" is reported, matching how the app frames it.

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PROG_API = 'https://kinepolisweb-programmation.kinepolis.com/api/Programmation/BE/NL/WWW/Cinema/KinepolisBelgium';
const STATE_FILE = new URL('../.watch-state.json', import.meta.url);
const WATCH_FILE = new URL('../watches.json', import.meta.url);
const APP_URL = process.env.APP_URL || '';
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const LABEL = 'ticket-alert';

const wallDate = s => s.showtime.slice(0, 10);
const wallTime = s => s.showtime.slice(11, 16);
// Mirrors index.html: attributes arrive in either shape depending on the feed.
const has = (s, code) => (s.sessionAttributes || []).some(a => a.code === code) ||
  ('' + (s.rawSessionAttributes || '')).split(',').includes(code);

// Identity of a watch = its filters, not its display name, so renaming a watch
// doesn't re-seed it but changing what it watches does.
const watchKey = w => [w.movie, w.format || '', w.cinema || '', w.from || '', w.to || ''].join('|');

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

// Bookable days for one watch, as [{ date, times, cinemas }]. Exported so it
// can be exercised without touching the GitHub API.
export function evaluate(prog, w) {
  const sessions = Array.isArray(prog.sessions) ? prog.sessions : Object.values(prog.sessions || {});
  const byDate = new Map();
  for (const s of sessions) {
    if (!s.film || s.film.id !== w.movie) continue;
    if (w.cinema && s.mainComplex !== w.cinema) continue;
    if (w.format && !has(s, w.format)) continue;
    if (s.isSoldOut) continue;
    const d = wallDate(s);
    if (w.from && d < w.from) continue;
    if (w.to && d > w.to) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(s);
  }
  return [...byDate.entries()].sort().map(([date, ss]) => ({
    date,
    times: [...new Set(ss.map(wallTime))].sort(),
    cinemas: [...new Set(ss.map(s => s.cinemaLabel || s.mainComplex))].sort()
  }));
}

function appLink(w) {
  if (!APP_URL) return '';
  const p = new URLSearchParams();
  if (w.movie) p.set('movie', w.movie);
  if (w.format) p.set('format', w.format);
  if (w.cinema) p.set('cinema', w.cinema);
  if (w.from) p.set('from', w.from);
  if (w.to) p.set('to', w.to);
  return `${APP_URL}?${p}`;
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const watches = await readJson(WATCH_FILE, []);
  const state = await readJson(STATE_FILE, {});
  const prog = await fetchProgrammation();
  const next = {};
  let opened = 0;

  for (const w of watches) {
    if (!w.movie) { console.log(`skip "${w.name || '(unnamed)'}": no movie HOcode`); continue; }
    const key = watchKey(w);
    const hits = evaluate(prog, w);
    const label = w.name || w.movie;
    next[key] = hits.map(h => h.date);

    if (!(key in state)) {
      console.log(`${label}: seeded with ${hits.length} bookable day(s) — no alerts on first run`);
      continue;
    }

    const known = new Set(state[key]);
    const fresh = hits.filter(h => !known.has(h.date));
    console.log(`${label}: ${hits.length} bookable day(s), ${fresh.length} new`);

    for (const hit of fresh) {
      const title = `🎟️ Bookable: ${label} — ${hit.date}`;
      const link = appLink(w);
      const body = [
        `**${hit.date}** just became bookable for **${label}**.`,
        '',
        `- Cinemas: ${hit.cinemas.join(', ')}`,
        `- Times: ${hit.times.join(', ')}`,
        w.format ? `- Format: ${w.format}` : '',
        '',
        link ? `[Open in the checker](${link})` : '',
        '',
        `<sub>Watch: \`${key}\`</sub>`
      ].filter(Boolean).join('\n');

      if (dryRun) { console.log('  [dry-run] would open: ' + title); continue; }
      await gh(`/repos/${REPO}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels: [LABEL] })
      });
      opened++;
      console.log('  opened issue: ' + title);
    }
  }

  if (!dryRun) await writeFile(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`done — ${opened} new alert(s)`);
}

// Guard so `import`ing this file (e.g. to test evaluate) doesn't fire a run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
