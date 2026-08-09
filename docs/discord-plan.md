# Discord notification plan

Status: **planned, not implemented.**

Adds Discord as a second notification channel for the personal ticket watcher
(`scripts/watch.mjs`, `.github/workflows/watch.yml`). See `TODO.md` for how the
existing GitHub-issue watcher works.

## Why Discord

Compared with the email plan in `TODO.md` ("Notify me" button per date), Discord
removes the two things that make email expensive:

- **No domain needed.** Resend's free tier allows one *verified domain*, so the
  email path quietly requires a domain you control. A Discord webhook needs
  nothing.
- **No double opt-in, unsubscribe tokens, or deliverability work.** A Discord
  user ID is an already-verified identity the user revokes by leaving the
  server. Email needs that machinery precisely because addresses are unverified
  and spammable.

It also keeps subscriptions committable: Discord user IDs are semi-public and
not credentials, unlike email addresses, which cannot live in a public repo.

## Design

Discord is an **additional** channel, not a replacement. The GitHub issue stays
as the durable log and the de-dupe record; Discord is the fast ping. If Discord
breaks, the issue still arrives.

### Config & secrets

- `DISCORD_WEBHOOK_URL` as a **repo secret** — anyone holding the URL can post
  to the channel, so it must not be committed.
- Wire it into `.github/workflows/watch.yml` alongside `APP_URL`/`NOTIFY_USER`.
- Optional per-watch field in `watches.json`:
  `"discord": ["<user id>", ...]` — who to ping for that watch. Absent means
  post to the channel without pinging anyone.

### Script changes (`scripts/watch.mjs`)

- `postDiscord(watch, hits)` — **one message per watch** containing all newly
  bookable dates, not one message per date. Avoids a burst of pings and stays
  well clear of Discord's ~5 requests/second webhook limit.
- Message shape: mentions go in **`content`**, detail goes in an **embed**.
  This matters — *mentions inside an embed do not generate a notification*,
  which is the easiest way to build this and have it silently ping nobody.
- Set `allowed_mentions: { users: [...] }` so pings are explicit rather than
  relying on content parsing.
- Embed carries date, cinema, times, format, and the `APP_URL` deep link.

### Failure semantics

Today any throw exits before `.watch-state.json` is written, so a failed alert
is retried on the next run. Preserving that intent across two channels:

| Failure | Behaviour | Why |
| --- | --- | --- |
| Issue creation fails | throw | State stays unwritten; retried in 30 min |
| Discord post fails | warn, continue | The issue already notified; failing would re-fire it next run |
| Webhook secret absent | skip silently | Keeps the repo forkable and working without secrets |

The rule to preserve: **never persist state for a date nobody was told about.**

## Verification

Uses the seeded-flip technique already proven twice (issues #2 and #3):

1. Extend the stubbed-fetch test to assert the Discord POST shape — mention in
   `content`, `allowed_mentions` populated.
2. Add a `--test-discord` flag that posts a sample message on demand, so the
   phone push can be confirmed without waiting for a real flip.
3. One live run with a temporary watch on an already-bookable date, hand-seeded
   to `[]` in `.watch-state.json` so it registers as a genuine flip. Delete the
   test watch afterwards.

Step 3 is the one that matters: a stub cannot prove a real ping arrives.

## Rollout

1. Create the webhook: *Server Settings -> Integrations -> Webhooks*.
2. Add `DISCORD_WEBHOOK_URL` as a repo secret.
3. Push the code with a temporary test watch; confirm the ping lands on a phone.
4. Remove the test watch.

## Needed before deployment

1. Create a webhook in Discord:
   - *Server Settings -> Integrations -> Webhooks -> New Webhook*
   - Copy the full webhook URL
   
2. Add it as a repo secret:
   - *Settings -> Secrets and variables -> Actions*
   - New repository secret: `DISCORD_WEBHOOK_URL` = the full URL

3. Get your Discord user ID:
   - Enable Developer Mode (User Settings -> Advanced -> Developer Mode)
   - Right-click your name -> Copy User ID

4. (Optional) Add Discord mentions to your watches:
   - Edit `watches.json`, add `"discord": ["<your id>"]` to each watch you want pinged
   - If `discord` is absent or empty, the message posts to the channel without pinging

5. Test locally (no webhook needed):
   ```bash
   DISCORD_WEBHOOK_URL='https://test' node scripts/watch.mjs --test-discord
   ```

## Implementation status

- **Code complete**: `postDiscord()` function handles message formatting and posting
- **Webhook integration**: secret passed through `.github/workflows/watch.yml`
- **Stub tests**: verify payload shape and error handling
- **Ready to deploy**: once the webhook URL and user ID(s) are provided

## Later: self-service for a handful of users

If friends should subscribe themselves rather than asking for a `watches.json`
edit, that needs a Discord bot with a `/watch` slash command, which needs an
HTTPS interactions endpoint. A Cloudflare Worker on the free `workers.dev`
subdomain covers it — no domain required. The Worker verifies Discord's Ed25519
request signature, writes the subscription to D1, and the existing Actions cron
keeps polling and posting.

This is *less* work than the email equivalent, because Discord supplies a
verified user identity for free.
