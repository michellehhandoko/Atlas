# Atlas — Session Handoff (May 25, 2026)

This doc captures one chat session of work on the Atlas travel app. Read this first; then read `HANDOFF.md` for full project context. Anything not mentioned here is unchanged from `HANDOFF.md`.

---

## Where to start

1. Read this whole doc.
2. Skim `HANDOFF.md` for project-level architecture, schema, deploy mechanics.
3. **Verify the latest changes are live** by running the [Test checklist](#test-checklist) below. If anything fails, that's your first task.
4. Pick up from [Open follow-ups](#open-follow-ups).

---

## Session summary

This session worked through a Tier 1 protections punch list, then built a persistence layer end-to-end, then fixed a bug discovered on first deploy. All edits are committed to the working tree at `~/Desktop/myapp`. The Railway deploy has been done once; the bug fix is **not yet deployed** as of the end of this session.

### Shipped — Tier 1 protections (one rolled-up PR)

In `server.js`:

- **Rate limiting** — `express-rate-limit` on `/api/itinerary/*`. Two tiers per IP: 20 requests / 15 min (burst) and 80 / 24 hours (daily). In-memory state.
- **Body size cap** — `express.json({ limit: '256kb' })`, down from the 2mb default.
- **Input validation** — `normalizeTripInput` clamps every string field, `validateTripInput` rejects empty/too-many legs, swapped dates within a leg, and trips longer than 21 days total. `budgetLevel` / `tripStyle` are allow-listed to known values. Hint/feedback fields are length-capped.
- **Request-ID middleware** — every request gets a short hex ID (or honors an inbound `X-Request-Id` header, capped at 64 chars). The ID is attached to `req.id`, echoed back as a response header, and printed in an access log line on response finish: `[req <id>] METHOD path status durationMs`. Every `console.error` in the OpenAI + trips endpoints prefixes the same ID so a user-reported failure → one grep on Railway logs stitches the whole story.
- **`/api/config` caching** — `Cache-Control: public, max-age=86400` on the server response; client (`public/app.js`) also caches in `sessionStorage` under `atlas:config:v1`.

Cleanup:

- `@railway/cli` removed from `devDependencies` (the npm v3 wrapper that throws `Cannot query field "teams"`); the Rust CLI on PATH is the canonical install.
- `docs/knowledge_base.md` deleted (was a RAG-corpus placeholder Atlas never used).

### Shipped — Persistence layer (Tier 2 #12)

**Decision made:** anonymous device IDs (not email magic-link). User picked this over magic-link to avoid signup friction; the schema is straightforward enough that an email/account upgrade can be retrofitted later.

**Scope shipped:** Short `/share/:id` URLs + My Trips list. Saved preferences was intentionally **not** included.

New `db.js` module:

- `pg.Pool` keyed off `DATABASE_URL`. SSL auto-enabled for non-localhost URLs (Railway's managed Postgres requires it).
- `initSchema()` is idempotent — `CREATE TABLE IF NOT EXISTS trips` + `CREATE INDEX IF NOT EXISTS (device_id, created_at DESC)`. Runs on every boot.
- The whole module is no-op-safe when `DATABASE_URL` is unset — `isAvailable()` returns false, all `/api/trips/*` endpoints return 503 with a friendly message, the rest of the app keeps working.

Schema (`trips` table):

| column | type | notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | 12-char hex (`crypto.randomBytes(6).toString('hex')`) |
| `device_id` | TEXT NOT NULL | sent by client in `X-Device-Id` header; lives in `localStorage` |
| `itinerary` | JSONB NOT NULL | full assembled itinerary (internal `_loadingExtras` / `_extrasError` / `_tripId` are stripped before save) |
| `title` | TEXT | denormalized for list view, e.g. `"Tokyo, Japan — 5 days"` |
| `destination` | TEXT | first leg's destination |
| `start_date` / `end_date` | DATE | for sort/display |
| `duration_days` | INTEGER | for display |
| `created_at` / `updated_at` | TIMESTAMPTZ | default `NOW()` |

Endpoints added in `server.js`:

- `POST /api/trips` — save (requires `X-Device-Id`). Returns `{ id, shareUrl, title }`. 503 if DB not configured.
- `GET /api/trips` — list trips for this device. Metadata only, 100 max, newest first.
- `GET /api/trips/:id` — **public** read (powers `/share/:id`). 404 on bad ID format or unknown.
- `PUT /api/trips/:id` — owner-only update. Replaces the saved itinerary JSON and refreshes denormalized title/destination/dates after revise, regenerate-day, swap-activity, extras retry, or Places enrichment.
- `DELETE /api/trips/:id` — owner-only. SQL only matches when `id` AND `device_id` both match.
- `GET /share/:id([a-f0-9]{12})` — static route that serves `public/index.html`. The regex constraint stops `/share/styles.css` / `/share/junk` from falsely matching.

Frontend (`public/app.js`):

- `getOrCreateDeviceId()` — mints a `crypto.randomUUID()` on first visit, stores under `atlas:device_id:v1` in `localStorage`.
- `saveTripIfPossible(itinerary)` — fires after both `/core` and `/extras` settle (or after either succeeds while the other fails). Stashes the returned ID on `currentItinerary._tripId` and rewrites the URL via `history.replaceState` to `/share/:id`.
- `checkForSharedItinerary()` — handles three URL formats: `/share/:id` (current), `?t=:id` (test convenience), and `#share=<base64>` (legacy — kept so links already sent out still work, and auto-upgraded to `/share/:id` on reshare).
- `shareItinerary()` — copies `${origin}/share/${id}` to clipboard. Falls back to legacy hash format if save failed.
- `fetchMyTrips()` / `deleteSavedTrip()` / `refreshMyTripsButton()` — list / delete / update counter on the hero button.
- `openMyTripsDialog()` — full modal: list of saved trips with title + destination + dates + saved-on date, Open / Delete per row. Open does `location.assign('/share/:id')` to re-enter through `checkForSharedItinerary()`. Delete calls the API, fades the row, refreshes the counter.

UI (`public/index.html` + `public/styles.css`):

- New `<button id="my-trips-btn" class="my-trips-btn" hidden>` in the form-view hero (top-right). `refreshMyTripsButton()` unhides it and shows `My Trips (N)` if this device has saved trips.
- Modal styled to match existing `.print-dialog` pattern. Hidden in print media.
- Responsive at 720px (stacks the trip-row buttons).

### Shipped — Bugfix (relative asset paths)

Discovered on first deploy: when the URL was `/share/abc123def456`, the browser resolved `<link href="styles.css">` as `/share/styles.css` and got HTML back (the SPA route was too permissive), so CSS/JS never loaded → page rendered with all three views stacked, no JS, no maps.

Fix in `public/index.html` — switched to absolute paths:

```html
<link rel="stylesheet" href="/styles.css">
<script src="/app.js"></script>
```

And the `/share/:id` route in `server.js` is now constrained to `[a-f0-9]{12}` so junk paths 404 instead of falsely matching.

**This fix is NOT yet deployed.** The user needs to run `railway up`.

### Documentation

`HANDOFF.md` was updated multiple times during the session to reflect the current state. It's the source of truth for the project.

---

## Current deployment state

- Railway: **first persistence deploy done**, DB provisioned and live (`[db] Schema ready` in production logs), `POST /api/trips` + `GET /api/trips` returning 200 in production.
- **Pending deploy:** the relative-path / regex fix. User has not run `railway up` again since the fix was made.
- Local: all edits in `~/Desktop/myapp`. `npm install` was run (added `pg` and `express-rate-limit` to `package.json`).

---

## Test checklist

Give this to the user after they run `railway up`. They need to do a **hard reload (Cmd+Shift+R)** in the browser first to bust cached broken CSS.

1. **Form page renders styled** — navy hero, "My Trips (1)" button top-right. If unstyled, hard reload again (Railway sometimes serves the previous build for ~10 sec).
2. **Click My Trips** — modal opens with one row (the Tokyo trip from the first deploy). Click **Delete** in the modal. Row fades, button hides. (Tests delete without needing to navigate into a trip.)
3. **Generate a fresh trip** — fill form, hit Plan My Trip. After both core + extras land, URL bar should change to `https://atlastravel.up.railway.app/share/<12-char-hex>`. Page should render fully styled.
4. **Map check** — scroll to map. If pins render, Maps works. If blank or red Google error, check DevTools console for `RefererNotAllowedMapError` etc.
5. **Click Share** — clipboard should contain `https://atlastravel.up.railway.app/share/<12-char-hex>`. Paste somewhere to confirm.
6. **Open the share URL in a new tab** — should render full styled trip page.
7. **Back to form** → "My Trips" → new trip should be there. Open → loads styled. Back → Delete it.

If anything fails, ask the user for the failing step + a screenshot / DevTools console error.

---

## Fix shipped after this session handoff

1. **Edited trips now persist to saved rows.** Added owner-only `PUT /api/trips/:id` in `server.js`. Added `cleanItineraryForSave()`, `updateSavedTripIfPossible()`, and `persistTripIfPossible()` in `public/app.js`. The frontend now preserves `_tripId` through full revisions and updates the saved row after revise, regenerate-day, swap-activity, extras retry, Places enrichment, and before copying a share link. Public viewers without the original device ID can still edit locally, but cannot overwrite the owner's saved trip.
2. **Verified activity thumbnails.** Places enrichment now requests Google Place photos and stores `photo_url` on validated non-transport activities when available. `buildActivity()` renders a small thumbnail next to the itinerary item only for validated places; failed images remove themselves, mobile sizes are constrained, and print hides thumbnails to preserve the clean print layout. The trip overview no longer displays the first day theme as a title.

## Open follow-ups

Ordered roughly by ROI. Pick one when the user is ready.

1. **Saved preferences** (was bracketed out of scope this session). Tier 2 #12 originally included "form remembers default budget, trip style, group size, loyalty programs across visits." Could be `localStorage` only (no DB column needed), or a per-device server column for cross-tab.

2. **Tier 2 items not yet started** (from the original prioritized list):
   - #9 Sentry / error tracking
   - #10 Streaming OpenAI responses
   - #11 Sequential third call for day-specific action items
   - #13 Manual editing escape hatches (drag-reorder, inline edit)
   - #14 Mobile pass
   - #15 Accessibility pass

3. **Rate-limit state in Redis** if Atlas ever scales to multiple Railway instances. Not a concern at current traffic.

---

## Decisions and rationale

- **Anonymous device ID over email magic-link** — user's call. Lower friction, simpler implementation. Schema is fine for retrofitting magic-link later (just add a nullable `user_id` column and a `users` table, then claim trips on signup).
- **Saved trips update after owner edits** — added after this handoff was first written. The anonymous device ID model still prevents a public share viewer from overwriting someone else's saved trip.
- **`/share/:id` is a real path, not a hash** — better for link previews / browser history / social cards than `/#share=<base64>`. Required regex constraint on the route to avoid false matches.
- **Legacy `#share=<base64>` URLs kept working** — anyone who shared a URL before this session still gets a valid page; the legacy decode also auto-saves on the fly so a reshare upgrades the link.
- **DB-not-configured returns 503 with friendly message, not 500** — explicit "saving isn't set up yet" message so the user knows what's wrong, and the rest of the app keeps working before Postgres is provisioned.

---

## Files changed this session

- `server.js` — rate limiters, request-ID middleware, body cap, input validation, `/api/trips/*` endpoints, `/share/:id` route, schema bootstrap on boot, `[req-id]` prefix on every `console.error`. Imports `pg` via `./db.js`.
- `db.js` — new file. Pool + schema + `newTripId()`.
- `package.json` — added `express-rate-limit` and `pg`; removed `@railway/cli`.
- `package-lock.json` — refreshed.
- `public/app.js` — device ID helpers, save / load / list / delete, save hook in `applyExtras` / `markExtrasError` / core-render path, new share-URL flow with legacy fallback, My Trips dialog + row builder + counter refresh.
- `public/index.html` — `<button id="my-trips-btn">` in hero; **absolute** asset paths for `/styles.css` and `/app.js`.
- `public/styles.css` — `.my-trips-btn`, `.my-trips-overlay`, `.my-trips-dialog`, `.my-trips-row*`, `.my-trips-empty`, print-media hide rules for the overlay and button. Responsive rules at 720px.
- `docs/knowledge_base.md` — deleted.
- `HANDOFF.md` — updated to reflect all of the above.

---

## Pointers

- **Project file structure, schema, deploy notes**: `HANDOFF.md`.
- **Live URL**: https://atlastravel.up.railway.app
- **Local dev**: `cd ~/Desktop/myapp && npm start` → http://localhost:3000.
- **Local dev with the cloud DB**: `railway run npm start` (uses Railway's `DATABASE_URL` without copying it anywhere).
- **Redeploy**: `railway up` from `~/Desktop/myapp`. Wait for `Deploy complete` + `Atlas is running` before testing.
- **Tail prod logs**: `railway logs`.
- **Look up a specific failing request**: it'll have a `[req <id>]` prefix in production logs. The same ID is on the `X-Request-Id` response header the user can pull from DevTools → Network.
