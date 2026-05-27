# Atlas — Project Handoff

Use this document to brief a new Claude session on the full context of the Atlas travel app project.

---

## What This Is

**Atlas** is an AI-powered travel concierge web app built as a class project for MGMT298D (Science and Strategy of AI) at UCLA Anderson. It takes a user's trip details and generates a personalized day-by-day itinerary using the OpenAI GPT-4o-mini API.

The app runs on Node.js/Express, is currently being tested locally, is deployed on Railway, and lives at `~/Desktop/myapp`.

**Live URL:** https://atlastravel.up.railway.app

---

## App Plan (from AppPlan.md)

**Use case:** Between figuring out transportation, lodging, activities, and food, planning the perfect trip is time-intensive. With Atlas, travelers can create and edit their personalized itinerary in minutes.

**Intended user:** Busy professionals, individuals, friend groups, or families who want to make the most of limited PTO. They have opinions on key things they want to do but need help filling in the rest.

**User inputs:**
- One or more destination "legs" — each leg has its own destination + required departure/return dates (Google Flights multi-city style)
- Destination validation/canonicalization through Google Places before generation, including clarification when a bare or ambiguous city name could point to multiple places
- Group size (solo, couple, 3–4, 5+)
- Budget level (budget / mid-range / luxury)
- Trip style (flexible / structured / top 3 priorities)
- Interests and must-dos (free text)
- Travel loyalty programs (optional)

**Model output:**
- Detailed day-by-day itinerary with activities, travel time notes, and price ranges
- For multi-city trips, each day is tagged with its destination; transition days include an inter-city transport activity
- Hotel recommendations with booking search links (alternatives split per-city for multi-city trips)
- Transportation options
- Budget breakdown
- Insider tips
- Pre-trip action items / To-Do checklist (5–8 short tasks, grouped by category, with priority/timing labels)
- Downloadable ICS calendar file
- Interactive Google Map with verified/enriched Places markers, day/all-days filtering, and special Top 3 map behavior

**Post-generation editing:**
- The full-itinerary free-text revision backend still exists, but the visible "Want to tweak it?" results-page box is currently hidden because targeted edits are more reliable for the demo/product flow.
- A "Regenerate day" pill on each day card rebuilds a single day with fresh picks (same date and destination, different activities) — optional one-line hint via a styled Atlas modal.
- A "Swap" pill on each activity replaces just that activity with a different but comparable one (same time + category locked) — optional hint via a styled Atlas modal.

**App name:** Atlas

**Tone:** Playful, concise, tour-guide energy. Like texting a well-traveled friend who knows your budget. Visual style is deliberately emoji-free — the design leans on typography (Playfair + Inter), navy/blue color, and structured cards.

**Colors:** Shades of blue, calming, playful

**Fonts:** Playfair Display (serif, editorial/travel magazine) + Inter (body)

**Layout:** Full webpage with itinerary results, trip overview, interactive map, day cards, full-width action checklist, supporting cards, share/print/ICS export

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express (ES modules) |
| LLM | OpenAI GPT-4o-mini via `openai` SDK (JSON mode) |
| Maps | Google Maps JavaScript API + Places library |
| Persistence | Railway Postgres via `pg` (anonymous device-ID model, no auth) |
| Rate limiting | `express-rate-limit` (per-IP burst + daily caps on `/api/itinerary/*`) |
| Frontend | Vanilla HTML/CSS/JS |
| Deployment | Railway (deployed) |
| Port | 3000 (local), `process.env.PORT` (Railway) |

---

## File Structure

```
myapp/
├── server.js               # Express server, OpenAI + persistence endpoints, all system prompts
├── db.js                   # Postgres pool + trips schema bootstrap + trip ID generator
├── package.json            # Dependencies: express, openai, dotenv, express-rate-limit, pg
├── .railwayignore          # Excludes node_modules/local.env from Railway uploads
├── local.env               # API keys (not committed to git)
├── railway.json            # Railway deploy config
├── public/
│   ├── index.html          # All three views: form, loading, results
│   ├── styles.css          # Full design system + print styles
│   └── app.js              # Form logic, rendering, map, share, ICS, edits, persistence
├── docs/                   # (empty — knowledge_base.md placeholder deleted May 2026)
├── AppPlan.md              # Original app brief
├── App_Development_Kit.html # Course instructions
└── HANDOFF.md              # This file
```

---

## Environment Variables

Set in `local.env` for local development, and as Railway variables for deployment.

```
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-4o-mini
GOOGLE_MAPS_KEY=your_google_maps_key_here
DATABASE_URL=postgres://...   # auto-injected by Railway Postgres add-on; only needed locally for DB testing
PORT=3000
```

`PORT` and `DATABASE_URL` are auto-injected by Railway — do **not** set them manually as Railway variables. `DATABASE_URL` only needs to be in `local.env` if you want to talk to the cloud DB from local dev (alternative: `railway run npm start` uses the cloud DB without copying the URL anywhere).

**Where to get them:**
- OpenAI: https://platform.openai.com/api-keys (key starts with `sk-...`)
- Google Maps / Places: https://console.cloud.google.com → APIs & Services → Credentials → Enable "Maps JavaScript API" and "Places API" → Create API Key → restrict to "Websites" → add `localhost:3000/*` and `https://atlastravel.up.railway.app/*`
- Postgres: Railway dashboard → your project → **+ New** → **Database** → **PostgreSQL**. Railway auto-injects `DATABASE_URL` into the Atlas service.

---

## What Has Been Built

### server.js

Express server on port 3000 (or `process.env.PORT` on Railway). Five system prompts and a set of API endpoints split across OpenAI generation, app config/health, and persistence. The single original `SYSTEM_PROMPT` was split so the model can do smaller, parallel calls — the user sees results faster.

**Middleware (top of file, in order):**
- `app.set('trust proxy', 1)` — required for Railway's proxy so per-IP rate limiting and request logging see real client IPs, not the proxy's.
- **Request-ID middleware** — every request gets a short hex ID (or honors an inbound `X-Request-Id` header, capped at 64 chars). The ID is attached to `req.id`, echoed back on the `X-Request-Id` response header, and printed in an access log line on response finish: `[req <id>] METHOD path status durationMs`. Every `console.error` inside the OpenAI/trips endpoints prefixes the same ID so a user-reported failure → one grep stitches the whole story together.
- `express.json({ limit: '256kb' })` — tight body cap (down from 2mb default). Garbage payloads are rejected before they reach the model.
- **Rate limiters on `/api/itinerary/*`** — `express-rate-limit` with two per-IP tiers: 20 requests / 15 min (burst) and 80 / 24 hours (daily). State is in-memory — fine on a single Railway instance; a multi-instance scale-out would want a shared store (Redis).

**System prompts (top of file, in this order — easy to edit):**
- `SHARED_VOICE` — single voice/persona line reused by every prompt
- `CORE_SYSTEM_PROMPT` — generates only `trip` + `days[]` + `weather_note`. Contains the multi-city rules, atlas-tip cap (1 tip per day max, 3 total visible), trip-style rules (top3 / flexible / structured), budget/tone rules, and Top 3 quality guidance.
- `EXTRAS_SYSTEM_PROMPT` — generates only `accommodation` + `transport` + `budget_breakdown` + `insider_tips` + `action_items`. Contains the action-items rules (5–8 items, fixed category list, priority/timing labels, must reference destination/dates/own hotel pick).
- `REVISE_SYSTEM_PROMPT` — for the free-text "Want to tweak it?" feature. Strict preservation rules: every unchanged field must be copied verbatim. Maintains the current atlas-tip cap when editing.
- `REGENERATE_DAY_SYSTEM_PROMPT` — rebuilds one `day` object. Day number / date label / destination are locked. For Top 3 mode, returns exactly 3 trip-wide picks rather than one pseudo-day; server and client both defensively cap Top 3 regenerated activities to 3. Honors an optional user hint.
- `SWAP_ACTIVITY_SYSTEM_PROMPT` — replaces one activity. Time and category are locked. Sees the previous + next activity for travel-note context. Honors an optional user hint.

**Endpoints:**
- `GET /api/health` — `{ ok, model, hasOpenAIKey, hasDatabase }`
- `GET /api/config` — exposes `GOOGLE_MAPS_KEY` to the frontend (safe; restrict key by domain in Google Cloud Console). Sends `Cache-Control: public, max-age=86400` so a shared-URL visitor doesn't re-fetch config on every load; the frontend also caches the response in `sessionStorage`.
- `POST /api/itinerary/core` — initial generation, core half. Returns `{ itinerary: { trip, days, weather_note } }`. Frontend fires this in parallel with `/extras`.
- `POST /api/itinerary/extras` — initial generation, extras half. Returns `{ extras: { accommodation, transport, budget_breakdown, insider_tips, action_items } }`. Independent of `/core` — does not need to know what activities the day-by-day picked.
- `POST /api/itinerary/revise` — takes `{ itinerary, feedback }`, returns the FULL revised itinerary. Temperature 0.5 (lower than initial gen — we want faithful edits, not creativity).
- `POST /api/itinerary/regenerate-day` — takes `{ trip, day, formContext, hint }`, returns `{ day: newDay }`. Server re-asserts the locked fields (day_number, date_label, destination) as defense in depth.
- `POST /api/itinerary/swap-activity` — takes `{ trip, day, activity, activityIndex, formContext, hint }`, returns `{ activity: newActivity }`. Server re-asserts the locked fields (time, category, booking_url=null).
- `POST /api/trips` — save a generated itinerary. Requires `X-Device-Id` header. Generates a 12-char hex `id`, derives `title` / `destination` / dates from the itinerary, stores the full JSON in `trips.itinerary` (jsonb). Returns `{ id, shareUrl: "/share/:id", title }`. Returns **503** if `DATABASE_URL` is missing — the rest of the app keeps working.
- `GET /api/trips` — list trips for this device (metadata only, no itinerary blob). Requires `X-Device-Id`. Returns `{ trips: [{ id, title, destination, startDate, endDate, durationDays, createdAt }, ...] }` ordered newest first, capped at 100.
- `GET /api/trips/:id` — **public** read (powers `/share/:id`); no device check. Returns `{ id, itinerary }`. 404 on unknown ID.
- `PUT /api/trips/:id` — owner-only update after revise/regenerate/swap. Requires `X-Device-Id`, replaces `trips.itinerary`, refreshes denormalized title/destination/dates, and returns `{ id, shareUrl, title }`. 404 when the device does not own the trip.
- `DELETE /api/trips/:id` — owner-only. SQL only matches when both `id` AND `device_id` match, so a foreign device can't delete someone else's trip even with the ID.
- `GET /share/:id` — static route that serves `public/index.html`. The route is constrained to `:id([a-f0-9]{12})` so anything else (e.g. `/share/junk`, `/share/styles.css`) 404s instead of falsely serving the SPA shell. The frontend reads the ID from `location.pathname`, fetches `/api/trips/:id`, and renders.

**Input validation (server-side, on `/api/itinerary/*`):**
- Per-field length caps: destination ≤ 200, interests ≤ 1000, loyalty ≤ 500, group size ≤ 20, dates ≤ 32, feedback ≤ 2000, hint ≤ 500.
- Allow-list checks: `budgetLevel ∈ {budget, mid, luxury}`, `tripStyle ∈ {flexible, structured, top3}`.
- `legs[]` must be 1–6, each leg must have valid start/end strings with start ≤ end, and the **total trip duration** is capped at 21 days. These bounds protect the OpenAI bill from a 90-day / 15-city request that quietly burns 10× the tokens.

**Shared helpers:**
- `normalizeTripInput(body)` — reads the form payload (supports both the legs array and legacy single-destination fields) and produces a canonical `{ tripLegs, groupSize, budgetLevel, interests, tripStyle, loyaltyPrograms }`.
- `buildUserMessage(input, mode)` — assembles the user message for `/core` or `/extras` with the right closing instruction.
- `callOpenAIJson({ systemPrompt, userMessage, temperature })` — wraps the OpenAI call with `response_format: { type: 'json_object' }`.

Model is configurable via `OPENAI_MODEL` env var (default `gpt-4o-mini`); to upgrade to `gpt-4o` just change the env var and redeploy.

### db.js

Tiny Postgres module. The whole module is no-op-safe when `DATABASE_URL` is unset — `isAvailable()` returns false and every `/api/trips` endpoint returns 503 with a friendly message. The rest of the app keeps working before/after the Railway Postgres add-on is wired.

- `getPool()` — lazy `pg.Pool` keyed off `DATABASE_URL`. Adds `ssl: { rejectUnauthorized: false }` for non-local URLs (Railway's managed Postgres requires SSL); skips SSL for `localhost`. Max 5 connections.
- `query(text, params)` — wrapper around the pool.
- `initSchema()` — called from `app.listen`. Idempotent `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`. Safe on every boot.
- `newTripId()` — 12-char hex (6 random bytes ≈ 2^48 entropy). Used as the trip primary key + share-URL slug.

**Schema (`trips` table):**

| column | type | notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | 12-char hex |
| `device_id` | TEXT NOT NULL | sent by client in `X-Device-Id`; lives in `localStorage` |
| `itinerary` | JSONB NOT NULL | the full assembled itinerary (`_loadingExtras`/`_extrasError`/`_tripId` are stripped before save) |
| `title` | TEXT | denormalized for list view, e.g. `"Tokyo, Japan — 5 days"` |
| `destination` | TEXT | first leg's destination |
| `start_date` / `end_date` | DATE | for sort/display |
| `duration_days` | INTEGER | for display |
| `created_at` / `updated_at` | TIMESTAMPTZ | default `NOW()` |

Index: `(device_id, created_at DESC)` for the My Trips list query.

### public/index.html

Three views managed by JavaScript (`view-form`, `view-loading`, `view-results`):

- **Form view:** Hero header with Atlas wordmark. The "Where are you going?" card uses a multi-leg pattern — `#legs-list` holds one or more numbered `.leg-row` entries (destination + required departure + required return), plus an "+ Add another destination" button. The first leg is rendered in HTML; subsequent legs are added by JS. A round × button on each leg removes it (hidden when only one leg exists). Trip-style radio cards (Flexible / Structured / Top 3) are text-only — no emoji icons.
- **Loading view:** Animated compass spinner, personalized step-by-step loading messages.
- **Results view:** Sticky nav with clickable Atlas wordmark plus Share / Calendar / Print / New Trip buttons, results content injected by JS. Everything inside (trip banner, overview card, map, day cards, day selector, checklist, supporting cards) is built and re-built from `app.js`.

### public/styles.css

- CSS variables design system (navy, blue, sky, cream, gold, coral).
- Playfair Display + Inter from Google Fonts.
- Multi-leg form styles: `.leg-row` (wash-blue card with numbered badge), `.leg-remove-btn` (round ×), `.add-leg-btn` (dashed blue pill).
- Day selector chip bar: `.day-selector`, `.day-nav-arrow` (round prev/next), `.day-chip` / `.day-chip.active`, `.day-chip-city` (city under day number for multi-city), `.day-chip.first-of-city` (vertical divider between cities).
- Day card destination tag: `.day-destination-tag` (city pill in the navy header).
- Trip banner city chain: `.trip-cities`, `.trip-city-pill`, `.trip-city-arrow` (shown only for multi-city).
- `.day-card-hidden { display: none }` so only the active day card is visible at a time.
- Day cards with left-border timeline layout. `.day-header-right` holds the day theme and the per-day **Regenerate day** pill button (`.day-regen-btn`). `.day-regenerating` adds a centered "Atlas is rebuilding this day…" overlay while a regeneration is in flight.
- Activity row: `.activity-item` with `data-day-idx` and `data-act-idx` attributes for targeted swaps. The meta strip holds the price badge, the search link, and a small `.activity-swap-btn` (outlined pill, "Swap"). `.activity-swapping` dims the row during a swap; `.btn-spinner` spins in the button.
- Full-width **Before You Go** action items section (`.action-items-section`, `.action-items-card` — progress bar, category groups, custom-styled checkboxes, priority/timing labels) below the itinerary grid.
- Full-width **Trip Logistics** section for hotels, transport, budget, and calendar/export context below the itinerary. The old right rail and old "Insider Tips" sidebar card were intentionally removed; the model may still return `insider_tips`, but the UI no longer renders a side tips box.
- **Progressive-loading skeletons** — `.sidebar-card-loading` + `.skeleton-line` (shimmer animation) are shown for each sidebar card while `/extras` is still in flight. `.sidebar-card-error` + `.extras-retry-btn` appear if `/extras` fails.
- **Hidden revise card code** (`.revise-card`, `.revise-input`, `.revise-btn`, `.revise-spinner`, `.revise-history-item`) — retained in code but not rendered in the current results page.
- Map section styles, including normal itinerary All days / Selected day segmented control, Top 3 "Top 3 picks" badge, empty/coverage states, and a single-color Top 3 legend.
- Styled dialogs for destination clarification and regenerate/swap hints.
- Toast notification styles (`.toast`).
- Print Pack styles and full print media query (hides nav, map, buttons; clean cover/overview/day/checklist layout with selected-day and day-range support).
- Responsive down to mobile (`@media (max-width: 720px)` collapses the day header so the regenerate button stacks correctly, etc.).
- `html { scroll-behavior: smooth }` so the targeted scroll-to-itinerary animates instead of snapping.
- **Deliberately emoji-free** — no `::before { content: '📍 ' }` style prefixes anywhere. The `.atlas-tip::before` reads `'Atlas tip — '`; `.tips-list li::before` uses a typographic em-dash in gold.

### public/app.js

State globals at the top:
- `mapsKey` / `mapsReady` — Google Maps + Places script load tracking.
- `atlasMap`, `atlasMapInfoWindow`, `atlasMapOverlays`, `mapViewMode` — persistent map instance and overlay state. The app redraws markers/routes instead of rebuilding the full results view for map mode changes.
- `placeEnrichmentRequestId` — guards against stale Google Places enrichment responses after a newer itinerary render.
- `currentItinerary` — the rendered itinerary. Mutated in place by targeted edits (swap activity, regenerate day) and by extras-arriving-after-core. May carry an internal `_tripId` field once the trip has been saved to the server (see Share + persistence).
- `revisionHistory` — `[{ feedback, timestamp }]` for the hidden full-itinerary revision flow. Cleared on new trip submission.
- `lastTripRequest` — the form payload of the most recent submission. Used to (a) build `formContext` for regenerate-day and swap-activity calls, and (b) retry `/extras` if it failed.

Persistence storage keys (localStorage / sessionStorage):
- `atlas:device_id:v1` — UUID v4 minted on first visit; sent as `X-Device-Id` header. Lives forever unless cleared.
- `atlas:config:v1` — sessionStorage cache of `/api/config` response so reloads in the same tab skip the network.

Key features:

1. **Init:** On page load, calls `loadConfig()` (which prefers the sessionStorage cache before hitting `/api/config`) for the Maps key, dynamically loads the Google Maps script with `libraries=places`, then `checkForSharedItinerary()` inspects `location.pathname` / `location.search` / `location.hash` for a `/share/:id`, `?t=:id`, or legacy `#share=<base64>` URL and restores the trip.
2. **Multi-leg form management + validation:** `addLeg()` / `removeLeg()` / `getLegs()` / `refreshLegUI()` handle add/remove, re-number rows, and toggle the × button visibility. When you click "+ Add another destination", the new leg's departure auto-fills from the previous leg's return (Google Flights pattern). Dates are required for every leg. Before generation, destinations are validated/canonicalized with Google Places Autocomplete/Places service using region-style results; bare ambiguous names can trigger a clarification dialog, and non-destination matches such as stores/restaurants are rejected.
3. **Progressive rendering (core + extras in parallel):** Form submit fires `/api/itinerary/core` and `/api/itinerary/extras` simultaneously via `fetchJSON()`. As soon as `/core` lands, the page switches to the results view and renders the trip banner + day cards. Checklist/supporting cards show shimmer skeletons. When `/extras` lands, `applyExtras()` merges the data into `currentItinerary` and rebuilds the extras surfaces without re-rendering the day cards (which preserves the active-day selection). If `/extras` fails, `markExtrasError()` shows a "Hit a snag" card with a "Try again" button that calls `retryExtras()`. If `/extras` resolves before `/core`, the payload is stashed and merged when `/core` eventually renders.
4. **Loading messages:** Personalized with the destination list (e.g., "Researching Tokyo, Kyoto, Osaka..."), steps through 8 phases. Stops as soon as `/core` returns.
5. **Booking URLs:** Auto-generated per activity category. Verified Google Places results use the enriched Google Maps URL when available; otherwise hotels → Booking.com search, food → Google search, transport → Google Maps directions, everything else → Google search. The model never generates these (always null); frontend builds them in `buildBookingUrl()`.
6. **Day selector (multi-day nav):** `buildDaySelector(days)` adds a horizontal chip bar with prev/next arrows above the day cards whenever there's more than one normal itinerary day. Only the active day's `.day-card` is visible; the rest are toggled via `.day-card-hidden`. `setActiveDay(idx)` swaps which card is visible, updates the active chip, and enables/disables the arrows at the ends. For multi-city trips, each chip shows `Day N` + the city name and a vertical divider appears before the first chip of each new city. Top 3 mode hides normal day navigation and uses a trip-wide shortlist presentation.
7. **Multi-city rendering:** `buildTripBanner` shows the city chain ("Tokyo → Kyoto → Osaka") plus per-city pills with date ranges when `trip.legs.length > 1`. `buildDayCard` adds a city destination tag to each day-card header on multi-city trips. Multi-city detection is derived from the rendered itinerary's `days[].destination` values (and from `trip.legs`).
8. **Day cards + activity rows:** `buildDayCard(day, dayIdx)` and `buildActivity(act, day, actIdx, dayIdx)` both take their position indices, which are needed by the per-day and per-activity edit buttons. Activity dots use a CSS category color only — no emoji icon inside the dot.
9. **Full-itinerary revision (currently hidden in UI):** `buildReviseCard()` and `submitRevision()` remain in `app.js`, and `/api/itinerary/revise` remains on the backend, but `renderResults()` no longer appends the card. The product currently steers users toward narrower Swap and Regenerate day edits.
10. **Regenerate day (targeted):** Each normal day-card header has a small "Regenerate day" pill; Top 3 mode shows "Regenerate picks." `handleRegenerateDay(dayIdx, btn)` prompts for an optional hint via `askForHint()` (styled modal), fires `/api/itinerary/regenerate-day`, shows a centered "Atlas is rebuilding this day…" overlay on that card, then swaps in a freshly built card. Preserves which day was visible. Also updates the day-chip's theme text if it changed.
11. **Swap activity (targeted):** Each `.activity-item` has a small "Swap" pill in the meta strip. `handleSwapActivity(dayIdx, actIdx, btn)` prompts for an optional hint via `askForHint()`, fires `/api/itinerary/swap-activity`, shows a spinner in the button + dims the row, then replaces just that activity DOM node.
12. **Google Maps + Places enrichment:** Full-width interactive map below trip banner. Normal itineraries support All days / Selected day filtering, per-day marker colors, and per-day route polylines. Top 3 mode uses one marker color, one legend item, no route connector, and a "Top 3 picks" badge. After render, `enrichPlacesForCurrentItinerary()` uses the existing Google Places integration to add place IDs, ratings, addresses, coordinates, Google Maps URLs, and verified place photo thumbnails. It biases lookup around the day destination and rejects implausible matches over `MAX_PLACE_MATCH_DISTANCE_KM = 120`; bad enriched fields are cleared. The map skips non-transport pins with implausible coordinates and can show coverage text like "Showing 1 of 3 mapped picks. Some locations need confirmation." Activity rows with valid map coordinates are clickable/keyboard-focusable and pan to the matching marker while opening the same info popup as a direct marker click. Activity thumbnails render only for validated non-transport places with a Google Place photo; there is no random stock-image fallback.
13. **Share + persistence (May 2026 rebuild):** Short server-side share URLs.
    - On first load, `getOrCreateDeviceId()` mints a UUID v4 and stores it in `localStorage` under `atlas:device_id:v1`. Sent on persistence calls as the `X-Device-Id` header. Clearing storage cuts the user off from the My Trips list but does **not** invalidate already-shared `/share/:id` links.
    - After both `/core` and `/extras` resolve (or after `/extras` fails — the core itinerary is still useful), `saveTripIfPossible(currentItinerary)` POSTs to `/api/trips` and stashes the returned ID on `currentItinerary._tripId`. The URL is upgraded to `/share/:id` via `history.replaceState` so a reload re-fetches from the server.
    - **Share button** uses the saved ID to build `${origin}/share/${id}`. If the save failed (most often because Railway Postgres isn't provisioned yet), it falls back to the legacy `#share=<base64>` format silently.
    - **On page load**, `checkForSharedItinerary()` handles three formats: `/share/:id` (current), `?t=:id` (test-friendly), and `#share=<base64>` (legacy — kept so links already sent out still work). Legacy links are also re-saved on the fly, so a reshare upgrades them to the short format.
    - **Edit persistence:** revisions, regenerate-day, swap-activity, retrying extras, and Places enrichment now best-effort update the existing saved row via owner-only `PUT /api/trips/:id`, so `/share/:id` and My Trips reopen the edited version. Public viewers without the original device ID can still edit locally, but cannot overwrite the owner's saved trip.
14. **My Trips list (May 2026):** Button in the form-view hero (`#my-trips-btn`), hidden until `refreshMyTripsButton()` confirms this device has at least one saved trip and the DB is reachable. Click opens a modal (`openMyTripsDialog()`) that fetches `/api/trips`, renders each trip as a row with title + destination + dates + saved-on date, and gives Open / Delete actions. Open does a real navigation to `/share/:id` so the page goes through `checkForSharedItinerary()` and fetches fresh data. Delete calls `DELETE /api/trips/:id` with the device header, fades the row out, and refreshes the button count. The button counter updates after save, after delete, and when returning to the form view via "New Trip". The full flow has **not yet been smoke-tested against a live Postgres** — see Recent feature additions for the activation steps.
15. **Print Pack:** Print opens a modal with All days / Selected day / Day range options. Trip details and checklist are always included to keep the UI simple; Trip Logistics/supporting cards, maps, the "Before You Go" section heading, and clickable-style buttons are hidden or simplified in print so Top 3 and normal itineraries stay clean. CSS classes (`print-pack`, `print-all-days`, `print-selected-day`, `print-day-range`) control the day scope. Browser-generated URL/header/footer text can only be hidden from the browser print dialog.
16. **ICS export:** Generates a `.ics` calendar file from the itinerary from the top nav Calendar button. Timed events (HH:MM) get 1-hour calendar blocks. Vague times (Morning/Afternoon/Evening) become all-day events. Includes description, price range, visible atlas tip, and address per event.
17. **Scroll behaviour:** `showView('results')` calls `scrollToItinerary()` (lands on `.trip-banner` — the navy header with the destination + dates, falling back to `.day-selector` / `.day-cards-wrap` if the banner isn't found). `showView('form')` and `showView('loading')` call `scrollToTopOfPage()`. Revisions (`submitRevision()`) also call `scrollToItinerary()` so the page smoothly animates back up from the revise card to land on the trip banner. (The helper is named `scrollToItinerary` for historical reasons; it currently targets the trip banner, not the day cards.)

---

## JSON Schema (the merged itinerary the frontend renders)

The full schema below is what `currentItinerary` looks like after both `/core` and `/extras` have resolved. `/core` returns `trip` + `days` + `weather_note`. `/extras` returns `accommodation` + `transport` + `budget_breakdown` + `insider_tips` + `action_items`. The revise / regenerate-day / swap-activity endpoints all operate on subsets of the same schema.

```json
{
  "trip": {
    "destination": "string (or 'City A → City B → City C' for multi-city)",
    "startDate": "YYYY-MM-DD (earliest arrival across all legs)",
    "endDate": "YYYY-MM-DD (latest departure across all legs)",
    "duration_days": number,
    "travelers": "string",
    "summary": "2–3 sentence trip overview",
    "destination_coordinates": { "lat": number, "lng": number },
    "is_multi_city": boolean,
    "legs": [
      {
        "destination": "string (matches what the user entered)",
        "startDate": "YYYY-MM-DD",
        "endDate": "YYYY-MM-DD",
        "coordinates": { "lat": number, "lng": number }
      }
    ]
  },
  "days": [
    {
      "day_number": number,
      "date_label": "Day 1 — Monday, June 2",
      "destination": "string (must match one of trip.legs[].destination)",
      "theme": "Short theme name",
      "activities": [
        {
          "time": "HH:MM or Morning/Afternoon/Evening",
          "name": "string",
          "category": "sightseeing | food | accommodation | transport | experience | shopping",
          "description": "string",
          "price_range": "string",
          "address": "string",
          "booking_url": null,
          "travel_note": "string or null",
          "atlas_tip": "string or null (at most 1 per day; frontend shows at most 3 total)",
          "coordinates": { "lat": number, "lng": number },
          "place_validation": {
            "status": "validated | ambiguous | unverified",
            "score": "number",
            "distance_km": "number or null",
            "place_id": "string or null",
            "matched_name": "string or null",
            "formatted_address": "string or null",
            "rating": "number or null",
            "user_ratings_total": "number or null",
            "google_maps_url": "string or null",
            "photo_url": "string or null",
            "business_status": "string or null"
          },
          "place_id": "string or null",
          "rating": "number or null",
          "user_ratings_total": "number or null",
          "google_maps_url": "string or null",
          "photo_url": "string or null"
        }
      ]
    }
  ],
  "accommodation": {
    "top_pick": { "name", "neighborhood", "price_range", "why", "booking_url": null, "loyalty_note" },
    "alternatives": [{ "name", "price_range", "vibe — prefix with city name for multi-city" }]
  },
  "transport": { "getting_there", "getting_around (cover each city + inter-city for multi-city)", "cost_estimate" },
  "budget_breakdown": { "accommodation", "food", "activities", "transport_local", "total_estimate", "notes" },
  "insider_tips": ["string"],
  "weather_note": "string",
  "action_items": [
    {
      "category": "Flights | Lodging | Transportation | Restaurants | Activities | Documents | Other",
      "task": "Short imperative task referencing the destination, dates, or hotel pick",
      "priority": "High | Medium | Low",
      "timing": "Book this week | 1–2 weeks out | Book this month | Before departure | Flexible"
    }
  ]
}
```

**Single-destination trips:** `trip.legs` will contain one entry, `trip.is_multi_city: false`, and the frontend renders the existing single-city UI (no city chain, no destination tag on day cards, day chips show themes instead of cities).

**Internal-only fields on the frontend (never sent in API responses, stripped before sharing):**
- `_loadingExtras: boolean` — set on `currentItinerary` while `/extras` is in flight; triggers the skeleton sidebar.
- `_extrasError: string` — set if `/extras` failed; triggers the "Hit a snag" card + retry button.
- `_tripId: string | 'pending' | null` — set after `saveTripIfPossible()` completes. Used by the share button to build `/share/:id` URLs. Stripped on the server before saving the itinerary to `trips.itinerary`, and stripped on the client before legacy-fallback base64 encoding.
- Enriched Google Places fields are added client-side after render and may not exist in the raw API response or in old shared URLs.

---

## Current Status

### Recent feature additions

The latest work is being tested locally first. Do not assume every local change below has been redeployed to Railway until a future session explicitly runs the deploy workflow.

1. **Day-by-day selector UI (May 2026)** — long itineraries no longer stack as one overwhelming page. A chip bar above the day cards lets users jump to any day; prev/next round arrows step through them one at a time. Only the active day's card is visible. Single-day "Top 3" itineraries hide the selector. See `buildDaySelector()` / `setActiveDay()` in `app.js`.
2. **Multi-city / multi-destination trip planning (May 2026)** — the form now accepts multiple destination "legs" (Google Flights pattern). Each leg has its own required departure/return dates. Adding a new leg auto-fills its departure from the previous leg's return. The server sends a `legs` array to the model, which returns `trip.legs[]` + a `destination` field on every day. Multi-city trips render a city chain in the banner, per-city pills, a destination tag on each day card, and city-grouped chips in the day selector. Backward compatible: single-destination requests still work (`trip.legs` will just have one entry).
3. **Full-itinerary revision backend (May 2026, UI hidden)** — `/api/itinerary/revise` and frontend helper code still exist, but the visible "Want to tweak it?" card is hidden for now. Swap and Regenerate day are the preferred user-facing edit tools because they are narrower and more reliable.
4. **Pre-trip Action Items / To-Do checklist (May 2026)** — full-width section below the itinerary grid with 5–8 short tasks grouped by category (Documents, Flights, Lodging, Transportation, Restaurants, Activities, Other). Each item is a checkbox with custom-styled check; a progress bar at the top shows X of Y done. Tasks include priority/timing labels like "High priority · Book this week" and reference the destinations, dates, hotel pick, and inter-city legs.
5. **Style tweaks (May 2026)** — emoji removed throughout (card titles, action-item categories, activity-dot icons, CSS prefixes on tips/destination tags/atlas tips). Atlas tips are capped at 1 per day and 3 visible total to make them feel more valuable. The old side "Insider Tips" box was removed.
6. **Progressive rendering — core + extras in parallel (May 2026)** — the original single `/api/itinerary` call was the slowest part of the UX. Split into `/api/itinerary/core` (returns trip + days + weather) and `/api/itinerary/extras` (returns hotel + transport + budget + tips + action items). Both fire simultaneously from the frontend; results view shows the day-by-day plan as soon as `/core` lands, with shimmer skeletons while `/extras` is still in flight. Total wall time is now `max(core, extras)` instead of `core + extras`. If `/extras` fails, the user sees an inline "Hit a snag" card with a retry button — the trip is still useful.
7. **Targeted edits: regenerate day + swap activity (May 2026)** — every normal day card has a "Regenerate day" pill in its header; Top 3 has "Regenerate picks"; every activity row has a "Swap" pill in its meta strip. Both ask for an optional one-line hint via the styled `askForHint()` modal, then hit narrowly-scoped backend endpoints (`/api/itinerary/regenerate-day`, `/api/itinerary/swap-activity`) that return just the changed piece. The DOM is updated in place. Server-side prompts lock immutable fields and the route handlers re-assert them defensively.
8. **Scroll fix (May 2026)** — `scrollToItinerary()` replaces the previous "snap to scrollY=0 on view change" behaviour for the results view. After initial generation, the page smoothly animates from the loading view down to the trip banner (the navy header with destination + dates). Hidden full-itinerary revisions also use the same helper if restored. Form and loading views still snap to the top. The scroll target was briefly the day cards before being moved to the trip banner so the user always lands on the trip title first.
9. **Destination validation + Places enrichment (May 2026)** — the frontend validates/canonicalizes destinations through Google Places before generation, prompts for clarification when city names are ambiguous, and rejects non-destination matches. After itinerary render, Places enrichment adds verified place data, optional place photo thumbnails, and rejects implausible coordinates, which prevents wrong-country/wrong-city pins from silently appearing. Mapped itinerary rows can also open their matching map pin directly.
10. **Top 3 trip-wide mode (May 2026)** — Top 3 is now treated as a trip-wide shortlist rather than "Day 1." It normalizes pseudo-day model output into one `Top 3 Must-Sees` card with `Pick 1`, `Pick 2`, `Pick 3`; the map uses one Top 3 legend item and no connector lines. Regenerated Top 3 responses are hard-capped to exactly 3 displayed/saved picks even if the model returns extra activities.
11. **Print Pack (May 2026)** — Print now opens a modal for All days / Selected day / Day range. Print CSS produces a cleaner itinerary document with a designed cover/overview, compact day/checklist sections, no "Before You Go" heading, and simplified Top 3 stop labels/highlights. Browser URL/header/footer text is controlled by the browser print dialog, not the app.
12. **Nav polish (May 2026)** — Calendar/ICS export moved into the top nav next to Share and Print. The loading view no longer appears in print because inactive views are hidden correctly.
13. **Tier 1 cost & vulnerability protections (May 2026)** — single PR. `express-rate-limit` on `/api/itinerary/*` (20 / 15 min burst + 80 / 24h daily, per IP), body size cap dropped from 2mb to 256kb, full server-side input validation (per-field length caps, allow-listed enums, ≤ 6 legs, ≤ 21-day total duration, swapped-date detection within a leg). Request-ID middleware (`X-Request-Id` header + access log + error-log prefix). `/api/config` sends `Cache-Control: max-age=86400` and the client caches in sessionStorage. Cleanup: `@railway/cli` removed from `devDependencies` (the Rust CLI lives on PATH); `docs/knowledge_base.md` placeholder deleted.
14. **Persistence layer (May 2026)** — Railway Postgres provisioned and live; server-side persistence verified end-to-end (`[db] Schema ready` on boot, `POST /api/trips` and `GET /api/trips` returning 200 in production logs).
    - **Done:** New `db.js` module + `trips` table schema (id, device_id, jsonb itinerary, denormalized title/destination/dates, timestamps). New endpoints `POST /api/trips`, `GET /api/trips` (list), `GET /api/trips/:id` (public share read), `PUT /api/trips/:id` (owner-only update), `DELETE /api/trips/:id` (owner-only), `GET /share/:id` (serves index.html — route constrained to `[a-f0-9]{12}`). Frontend mints an anonymous device ID into `localStorage`, saves the itinerary after both `/core` and `/extras` settle, updates saved trips after edits, rewrites the URL to `/share/:id`, and the share button copies the new short URL. Legacy `#share=<base64>` URLs still work and are auto-upgraded to `/share/:id` on reshare. **My Trips panel** is built (button + modal + list + open + delete + auto-counter).
    - **Bug found + fixed during first deploy:** `public/index.html` originally loaded `styles.css` and `app.js` with relative paths, which resolved correctly on `/` but resolved to `/share/styles.css` and `/share/app.js` when the URL was `/share/abc123def456`. Both 404'd (or were caught by the SPA route before the constraint was tightened), so the My Trips → Open flow landed on a fully unstyled page with no JS — looked broken, no maps, no click handlers. Paths are now absolute (`/styles.css` and `/app.js`) and `/share/:id` is regex-constrained to a 12-char hex ID so junk paths 404 cleanly. **Requires a `railway up` to pick up the fix.**
    - **Not yet built:** Revisions are not persisted back to the saved row (a single PUT endpoint + save-after-edit hooks is the obvious next step).
    - **Activation steps (already taken in production):** in Railway, **+ New → Database → PostgreSQL** → `DATABASE_URL` auto-injected → `railway up`. The first boot triggers `initSchema()` to create the `trips` table. Before provisioning, `/api/trips` returns 503 and the frontend silently falls back to the legacy hash share URL — the rest of the app keeps working.

### Working locally
- `npm start` boots the server at http://localhost:3000
- Local smoke path: Form → validation/loading → results → map/checklist/print
- After JS edits, run `node --check server.js` and `node --check public/app.js`

### Live on Railway
- **URL:** https://atlastravel.up.railway.app (custom subdomain edited in Railway → Settings → Networking)
- **Project:** Atlas
- **Project ID:** 674094ec-3dfd-44ea-bc17-d83c08d411be
- **Service ID:** 41a355c2-4e64-494d-a4f5-1a0e854f7264
- **Environment:** production
- **Builder:** RAILPACK (configured in `railway.json`)
- Env vars set on Railway: `OPENAI_API_KEY`, `OPENAI_MODEL`, `GOOGLE_MAPS_KEY` (plus Railway's auto-injected `RAILWAY_*` and `PORT`)
- Google Maps API key referrer allowlist includes `https://atlastravel.up.railway.app/*`

### How the deploy actually went (notes for next time)
1. **Install Railway CLI properly.** The `@railway/cli` npm package was an outdated v3.x wrapper that throws `Cannot query field "teams" on type "User"`. The fix is to install the real Rust CLI globally — either `brew install railway` or the official installer `bash <(curl -fsSL cli.new/install)` (which installs to `~/.railway/bin` and updates `~/.zshrc`). After installing, run `source "$HOME/.railway/env"` in any open shells.
2. **`.railwayignore` is required.** Railway's CLI does not honor `.gitignore` when uploading. Without `.railwayignore`, the uploader walks `node_modules/` and can trip on dangling symlinks (e.g. `node_modules/.bin/rimraf` from a partially-cleaned install). Our `.railwayignore` excludes `node_modules/`, `local.env`, `.env`, `.DS_Store`, build dirs, and `.git/`.
3. **`railway service` is interactive.** `railway domain`, `railway up`, etc. require a linked service. If `railway status` shows `Linked service: None`, run `railway service` and pick Atlas — that link persists.
4. **Setting variables from `local.env`** — use a `while read` loop, not the single-line `--set "KEY=$(grep ... )"` trick, because the grep returns empty when the variable name doesn't match and `--set` silently sets nothing:
   ```bash
   while IFS= read -r line; do
     [[ -z "$line" || "$line" == \#* ]] && continue
     railway variables --set "$line"
   done < local.env
   ```
5. **Env var changes don't apply until the next deploy.** After setting variables, run `railway up` and **wait for "Deploy complete" + "Atlas is running"** before hitting `/api/health` — otherwise you're talking to the previous container.

### Redeploy cheatsheet
From `~/Desktop/myapp`:
```bash
railway up                                # push current code + rebuild
railway logs                              # tail live container logs
railway variables                         # list env vars on the service
railway variables --set "KEY=VALUE"       # set a variable (one or many --set flags)
curl https://atlastravel.up.railway.app/api/health   # smoke test
```

---

## Known Issues / Notes

- **Railway CLI setup.** Use the globally-installed Rust CLI (v4.x), not the npm `@railway/cli` v3 wrapper (which throws `Cannot query field "teams" on type "User"`). The npm wrapper was removed from `devDependencies` in May 2026. Install via `brew install railway` or `bash <(curl -fsSL cli.new/install)`.
- **Google Maps API key is exposed to the frontend** via `/api/config`. This is standard practice — security comes from HTTP referrer restrictions in Google Cloud Console, not from hiding the key. If you change the Railway URL again, update the referrer allowlist. The key must have both Maps JavaScript API and Places API enabled for the current validation/enrichment behavior.
- **OpenAI cost expectations** — gpt-4o-mini is ~$0.15 per 1M input tokens / $0.60 per 1M output tokens. A typical 5-day itinerary uses ~3K input + ~3K output tokens, so each generation costs under a tenth of a cent. The new architecture makes two model calls per initial generation (`/core` + `/extras`) instead of one, with slightly more total tokens because the system-prompt context is duplicated — still well under a cent per trip. The targeted edit endpoints (`/regenerate-day`, `/swap-activity`) are even cheaper since the output is tiny. Safe for class demo traffic. Bump to `gpt-4o` via the `OPENAI_MODEL` env var if you want noticeably higher-quality recommendations (~30× cost).
- **Action items vs. day-by-day specificity.** Because `/extras` runs in parallel with `/core` and doesn't see the day-by-day picks, action items can't say *"Reserve Sushi Saito for Day 2"* — they reference destinations, dates, and the hotel pick, but not specific day activities. The earlier monolithic generation could do this; the trade-off was speed. If specificity matters more than speed, a sequential approach (core → extras) or a third small call (core + extras → action_items) would restore it.
- **Places guardrails may show fewer pins by design.** If Google Places cannot confidently match an activity near the day destination, the map may show fewer pins and a coverage note. This is preferable to silently plotting a wrong-city or wrong-country coordinate.
- **Print URL/header/footer text is browser-controlled.** The app can style the printable page and hide inactive/loading views, but Chrome/Safari header/footer metadata must be disabled in the print dialog.
- **Unsplash integration** was considered but skipped by choice. The trip banner uses a CSS gradient instead of a photo.
- **Persistence is opt-in via Railway Postgres.** Until the add-on is provisioned, `POST /api/trips` returns 503, the share button falls back to legacy base64 hash URLs, and "My Trips" cannot be exposed. See Recent feature additions #14 for the activation steps.
- **Rate-limit state is in-memory.** Restarts reset the counters; multi-instance scale-out would need a Redis store for shared counts. Not a concern at class-demo scale.
