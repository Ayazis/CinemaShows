# TODO

- [ ] Manual location based cinema selection
- [ ] Current movies and expected/upcoming movies
- [x] Make search parameters query parameters in the URL
- [x] Seating-area availability per session (Standard / Cosy / Cosy Loungers)
- [x] Detect improvements between checks (sold out → available, seats freed up)
- [ ] Row/seat-level availability — needs a backend, see below
- [x] Personal watcher — GitHub Actions cron opens an issue when a date flips
- [x] Discord notifications — optional second channel to the GitHub issues
- [ ] "Notify me" button per date — self-service email notifications

## Plans

### Manual location based cinema selection

Let the user set a "home" location (city/postcode or geolocation) and have the
cinema dropdown sort/filter by distance instead of alphabetically.

- Add a small location input (text field for city/postcode, or a "Use my
  location" button using `navigator.geolocation`).
- Kinepolis' programmation API (`PROG.sessions[].cinemaLabel`/`mainComplex`)
  doesn't include coordinates, so maintain a small static lookup table of
  cinema -> {lat, lng} (Kinepolis has ~25 BE cinemas, stable list).
- On location set, compute distance (haversine) from the chosen point to each
  cinema and reorder `buildCinemas()`'s sorted list by distance instead of
  `localeCompare`; optionally show "12 km" next to each option.
- Persist the chosen location in `localStorage` so it survives reloads.
- Edge case: if geolocation is denied/unavailable, fall back to current
  alphabetical sort.

### Current movies and expected/upcoming movies

Split the movie dropdown into "Now showing" vs "Coming soon" so users aren't
stuck picking from a flat list.

- The programmation API's `film` objects likely carry a release date field
  (needs checking in the raw payload — e.g. `releaseDate`/`onSaleDate`); use
  that plus `sessionsByMovie.has(ho)` to classify:
  - Has sessions in the past/today -> "Now showing"
  - Has a future release date and no sessions yet -> "Expected"
- Render as an `<optgroup>` split in `buildMovieOptions()`, or two separate
  sections in the movie card area.
- For "Expected" movies, the checker view should just show "not yet released"
  for all dates (already partly handled — `run()` already renders "not yet"
  when a day has no sessions).
- Confirm whether the API even returns not-yet-released films with zero
  sessions; if not, this may need a second API call or a curated list.

### Detecting improvements between checks

There is **no seat count in the feed** — 27 fields per session, none of them a
capacity, remaining or occupancy figure. So "are more tickets available now"
cannot be answered absolutely, only as a change between two observations.

Each check stores a compact snapshot in `localStorage` (`cinemashows:seatsnap:v1`,
~98 KB for ~5000 sessions: sold-out flag + seating-area initials per session) and
diffs the next check against it. Three improvements are reported:

- `isSoldOut` true → false (returns/releases put back on sale)
- `availableSeatingAreas` gaining an area (e.g. Cosy freed up)
- empty → populated (sales opened for that session)

Deliberately one-directional: seats disappearing is the normal direction of
travel and isn't surfaced.

Known limits, both inherent to a static browser-only app:

- Detection only happens **when you press Check**. Two checks in quick
  succession will consume the diff — the second reports "no improvements"
  because the first already overwrote the baseline.
- The snapshot is per-browser `localStorage`, so it doesn't follow you across
  devices, and private-mode/quota failures silently restart the baseline.

Continuous, unattended watching needs the backend below.

### Row/seat-level availability

What the programmation API exposes per session, and nothing more:

- `availableSeatingAreas` — **live**, not hall config. Only populated once a
  session is on sale, and an area disappears from it when that area sells out.
  Evidence in the full feed: 4533 sessions have `hasCosySeating` (hall has cosy
  seats) but only 2963 list `"Cosy"` as available. 1703 sessions have an empty
  list purely because tickets aren't released yet — that is "unknown", not
  "unavailable", and must not be conflated.
- Whole vocabulary: `Standard` (3350 — every on-sale session), `Cosy` (2963),
  `CosyLoungers` (39). Since `Standard` is universal, only the premium areas
  carry signal.
- Supporting flags (static hall config, not availability): `hasSeatingPlan`,
  `hasSpecialSeating`, `hasCosySeating`, `hasCosyLoungersSeating`.

There is **no public per-seat/row API**. Verified dead ends (all 404 or
NXDOMAIN): `/Booking/{SeatPicker,SeatPlan,GetSeatPlan,SeatSelection}` on
tickets.kinepolis.be, `WSVistaWebClient/{RESTData,OData}.svc`, and the
`kinepolisweb-{seatplan,api,booking,seatingplan,session}.kinepolis.com` host
family.

Actual seat maps live behind Kinepolis' Vista booking flow:

1. `https://kinepolis.be/nl/direct-vista-redirect/{vistaSessionId}/0/{mainComplex}/0`
   (this is the deep link their own `common.js` builds — the app now links each
   showtime to it) redirects to `tickets.kinepolis.be/Booking/TicketSelection`.
2. That client is **cookie/server-session stateful**. The seat step is only
   reachable by POSTing the ticket-quantity form back to `/Booking/TicketSelection`
   with its `__RequestVerificationToken` CSRF field.

So scraping seats means: redirect → POST a quantity → parse the seat step, which
**creates a short-lived booking hold in their live system on every poll**. It
also cannot run in-browser (cross-origin + cookies + CSRF, no CORS), so it needs
the same backend as the notification work below.

Note: their edge blocks plain `curl` with a 403 "Suspicious Activity" page, so
any poller needs realistic headers and gentle rate limiting.

### Personal watcher (done)

Single-user version of the notification idea below, with no backend: a GitHub
Actions cron (`.github/workflows/watch.yml`, every 30 min) runs
`scripts/watch.mjs`, which re-implements `run()`'s "bookable" test against
`PROG_API` for each entry in `watches.json` and opens a labelled GitHub issue
when a date flips. GitHub's own notifications do the emailing/pushing.

- State is `.watch-state.json`, committed back by the workflow. A watch with no
  state yet is **seeded silently** — otherwise adding a watch whose range is
  already on sale fires one alert per day (23, when this was built).
- Watch identity is its filters, not its `name`, so renaming doesn't re-seed but
  changing the movie/format/cinema/range does.
- The API 403s bare clients ("Suspicious Activity"), so the script sends a full
  browser User-Agent + Referer. A trimmed UA is enough to trip it.
- `node scripts/watch.mjs --dry-run` prints what it would file, writes nothing.
- Deliberately not surfaced in the UI — that's the self-service work below.

### "Notify me" button per date — self-service email notifications

Letting arbitrary visitors self-subscribe (not just the dev) needs a real,
durable backend — a committed-file/GitHub-Actions approach doesn't scale
since every subscription would need a PR. Everything below can still be done
on free tiers.

- **Backend**: Cloudflare Workers (free tier) + D1 (free SQLite) for storing
  subscriptions `{email, movieHO, format, cinema, date, createdAt}`, plus a
  Cron Trigger (free) polling on a schedule (e.g. every 15 min).
  - Alternative if avoiding Cloudflare: Supabase free tier (Postgres +
    scheduled Edge Functions) — same shape.
- **Frontend**: add a small "🔔 Notify me" button to each `.target-row` in
  `run()` for days that are "not yet"/sold out. Clicking opens a tiny inline
  form (email input) that POSTs `{email, movie, format, cinema, date}` to a
  Worker endpoint.
- **Double opt-in**: on subscribe, Worker sends a confirmation email (via
  Resend/Mailjet free tier) with a confirm link (signed token) before the
  subscription goes live — avoids spam/abuse and fake emails.
- **Cron job**: on each run, re-implements the `run()` "bookable" check
  against `PROG_API` for every active subscription; when a date flips to
  bookable, emails the user (via Resend/Mailjet) with a link back to the
  query-parameter URL (see above) and then deletes/deactivates that
  subscription (one-shot notification, not repeated).
- **Unsubscribe**: include an unsubscribe link (token-based) in every email.
- **Abuse/cost guardrails**: rate-limit subscriptions per IP/email, cap total
  active subscriptions to stay within free-tier email/DB limits.
