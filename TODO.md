# TODO

- [ ] Manual location based cinema selection
- [ ] Current movies and expected/upcoming movies
- [x] Make search parameters query parameters in the URL
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
