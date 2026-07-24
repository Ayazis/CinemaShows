# TODO

- [ ] Manual location based cinema selection
- [ ] Current movies and expected/upcoming movies
- [ ] Make search parameters query parameters in the URL

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

### Query parameters in the URL

Make the current selection (movie, format, cinema, from, to) reflected in the
URL so links can be shared and refresh/back-button preserve state.

- On load, read `location.search` before `buildDateDefaults()`/preselection
  logic in `load()` and use those values to override the defaults.
- On every control change (`movieSel`, `formatSel`, `cinemaSel`, `fromEl`,
  `toEl`), call `history.replaceState` with an updated `URLSearchParams`
  (avoid `pushState` to not spam browser history).
- Since the movie dropdown is keyed by `film.id` (HOcode), use that as the
  `movie` param value (stable across reloads, unlike title).
- Keep it degrading gracefully: missing/invalid params fall back to current
  defaults (Odyssey preselect, today..+21 days).
