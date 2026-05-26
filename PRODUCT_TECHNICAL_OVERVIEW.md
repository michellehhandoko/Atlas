# Atlas Product Technical Overview

## Executive Summary

Atlas is an AI-powered travel planning web app that turns a traveler's destination, dates, budget, group size, trip style, interests, and loyalty preferences into a personalized itinerary. It combines LLM-generated recommendations with Google Maps and Google Places validation so the output is not just a text plan, but a usable travel workspace with mapped locations, verified place links, photo thumbnails, checklists, saved trips, share URLs, print exports, and calendar export.

The product is designed around trust and usability. Atlas does not simply ask a model for a trip and display the result. It validates destinations before generation, enriches activities after generation, rejects implausible map matches, persists trips to a database, and gives the user targeted editing tools for small itinerary changes.

## Product Goals

Atlas is built for busy travelers who know where they want to go but do not want to spend hours stitching together hotels, restaurants, maps, timing, reservations, and pre-trip tasks.

Core goals:

- Generate a useful trip plan in minutes.
- Support both simple single-city trips and multi-city travel.
- Make the itinerary feel specific to the user's budget, interests, dates, and group size.
- Reduce user trust issues by validating destinations and enriching itinerary items with Google Places data.
- Let users edit the plan without restarting from scratch.
- Make the final plan easy to save, share, print, and add to a calendar.

## User Inputs

Atlas currently collects:

- Destination legs: one or more locations, each with required departure and return dates.
- Group size: solo, couple, 3-4, or 5+.
- Budget level: budget, mid-range, or luxury.
- Trip style: flexible, structured, or Top 3.
- Interests and must-dos: free text.
- Loyalty programs: optional free text.

Each destination leg is validated before the generation request is sent. This is especially important for ambiguous locations. For example, a bare input like "Saratoga" can refer to more than one place, so Atlas asks the user to clarify rather than silently choosing the wrong city.

## Core User Flow

1. The user enters trip details.
2. Atlas validates destination inputs using Google Places.
3. Atlas starts a loading view with destination-aware loading copy.
4. The frontend sends two parallel generation requests:
   - Core itinerary request: trip metadata, days, activities, weather note.
   - Extras request: hotel, transportation, budget, tips, and checklist.
5. As soon as the core itinerary returns, Atlas renders the trip page.
6. Extras merge into the page when ready.
7. Google Places enrichment runs after render to verify activities, update coordinates, add ratings, attach Google Maps links, and show verified place photos when available.
8. The trip is saved to Railway Postgres and the browser URL is upgraded to a short `/share/:id` URL.

## AI Generation Architecture

Atlas uses OpenAI GPT-4o-mini through the OpenAI SDK in JSON mode. The backend is intentionally split into multiple focused prompts and endpoints.

Core generation:

- Endpoint: `POST /api/itinerary/core`
- Produces: `trip`, `days`, and `weather_note`.
- Responsible for day-by-day activity planning, trip metadata, activity coordinates, travel notes, price ranges, and sparse Atlas tips.

Extras generation:

- Endpoint: `POST /api/itinerary/extras`
- Produces: `accommodation`, `transport`, `budget_breakdown`, `insider_tips`, and `action_items`.
- Runs in parallel with core generation so users see the main itinerary sooner.

Revision:

- Endpoint: `POST /api/itinerary/revise`
- Takes a full itinerary and user feedback.
- Returns a revised full itinerary.
- Intended for larger changes, though targeted edit tools are more reliable for small changes.

Regenerate day:

- Endpoint: `POST /api/itinerary/regenerate-day`
- Rebuilds one day while locking day number, date label, and destination.
- In Top 3 mode, it regenerates the three trip-wide picks.

Swap activity:

- Endpoint: `POST /api/itinerary/swap-activity`
- Replaces one activity while locking time and category.
- Receives neighboring context so travel notes remain sensible.

## Trip Styles

Flexible:

- Uses broader time blocks.
- Prioritizes fewer activities and a looser pace.

Structured:

- Produces a more detailed hour-by-hour itinerary.
- Better for users who want a clear daily plan.

Top 3:

- Produces exactly three trip-wide must-see picks instead of a full daily schedule.
- The UI labels them as Pick 1, Pick 2, and Pick 3.
- The map uses one Top 3 legend and no connector lines.
- Regenerated Top 3 responses are defensively capped to three picks in both server and client code.
- Luxury Top 3 prompts steer the model toward premium, paid, bookable, or elevated experiences while still allowing a standout free landmark when appropriate.

## Destination Validation

Before generation, the frontend validates destination legs using Google Places.

Validation behavior:

- Uses Google Places Autocomplete with region-style results.
- Falls back to text search when needed.
- Rejects non-destination matches such as stores, restaurants, cafes, and hotels.
- Canonicalizes destination display names.
- Prompts users to clarify ambiguous bare city names.
- Requires departure and return dates for every destination leg.

This prevents failure modes where the app starts planning around the wrong Saratoga, a random business, or an unrelated place.

## Places Enrichment And Map Trust

After the itinerary renders, Atlas enriches activity data through Google Places.

Enrichment adds:

- Place ID.
- Formatted address.
- Verified coordinates.
- Rating and rating count.
- Google Maps URL.
- Optional Google Place photo thumbnail.

Trust guardrails:

- Lookups are biased around the expected day destination.
- Non-transport activity matches more than `MAX_PLACE_MATCH_DISTANCE_KM` away are rejected.
- Unverified or implausible enriched fields are cleared.
- The map may show a coverage note if only some places can be confidently mapped.
- It is better for Atlas to show fewer pins than to show a wrong-location pin.

Photo behavior:

- Atlas only shows thumbnails for validated non-transport places with a Google Place photo.
- There is no random stock image fallback.
- Failed images remove themselves.
- Photos are hidden in print to keep the print layout clean.

## Results Page Experience

The results page includes:

- Trip banner with destination, dates, travelers, and summary.
- Trip overview card with dates, pace, stops, checklist count, highlights, verification status, and hotel pick.
- Interactive map.
- Day selector for multi-day normal itineraries.
- Day cards with activities, timing, descriptions, price badges, verified badges, links, thumbnails, travel notes, sparse Atlas tips, and swap controls.
- Full-width Trip Logistics section for hotel, transport, budget, and calendar/export context below the itinerary.
- Full-width Before You Go checklist.
- Hidden full-itinerary revision code for larger free-text changes.

The UI intentionally avoids emoji and leans on typography, color, cards, and structured layout.

## Map Modes

Normal itinerary maps:

- Show color-coded markers by day.
- Support All days and Selected day views.
- Draw route connector lines per day.
- Use info windows with activity details and links.

Top 3 maps:

- Show a single Top 3 badge and legend.
- Use one marker color.
- Do not draw connector lines because the picks are trip-wide and not necessarily one route.

## Editing Model

Atlas supports three edit paths:

Swap:

- Best for replacing one activity.
- Narrow, fast, lower risk.

Regenerate day:

- Best for replacing an entire day while preserving date and destination.
- Also powers Top 3 regeneration.

Want to tweak it:

- Backend and frontend helper code still exist for broader revisions, such as "make the trip less packed" or "keep hotels but make restaurants cheaper."
- The visible UI is currently hidden because this path is more expensive and more complex than targeted edits.
- Swap and Regenerate day are the preferred user-facing edit tools for the current product flow.

Edits persist:

- Saved trips carry an internal `_tripId`.
- After revise, regenerate, swap, extras retry, or Places enrichment, Atlas best-effort updates the saved Postgres row through owner-only `PUT /api/trips/:id`.
- Public viewers can edit locally but cannot overwrite the owner's saved trip without the original device ID.

## Checklist And Pre-Trip Tasks

Atlas generates 5-8 action items grouped by category:

- Flights.
- Lodging.
- Transportation.
- Restaurants.
- Activities.
- Documents.
- Other.

Each item has:

- Task text.
- Category.
- Priority.
- Timing cue.
- Checkbox state in the UI.

The checklist is intentionally trip-specific. It should reference the destination, dates, hotel pick, international document needs, reservation windows, or inter-city transportation when relevant.

## Saving, Sharing, And My Trips

Atlas uses an anonymous device-ID persistence model. There is no login.

How it works:

- The frontend creates a UUID and stores it in `localStorage`.
- The UUID is sent as `X-Device-Id` for save, list, update, and delete requests.
- Saved trips are stored in Railway Postgres.
- Each saved trip gets a 12-character hex ID.
- The browser URL is upgraded to `/share/:id` after saving.

Share behavior:

- `GET /api/trips/:id` is public so anyone with the link can view the trip.
- `PUT` and `DELETE` require the original device ID.
- Legacy `#share=<base64>` links still work and can be upgraded to short links.

My Trips:

- The form view can show a My Trips button if the current device has saved trips.
- The modal lists saved trips.
- Users can open or delete trips.

## Print And Calendar Export

Print Pack:

- The Print button opens a modal.
- Users can choose All days, Selected day, or a day range.
- Trip details and checklist are always included to keep the print flow simple.
- Print CSS hides the app navigation, map, Trip Logistics cards, buttons, and photos.
- Browser URL/header/footer text is controlled by the browser print dialog, not the app.

Calendar export:

- The Calendar button generates an `.ics` file.
- Timed activities become one-hour calendar events.
- Morning, Afternoon, and Evening activities become all-day style entries.
- Event descriptions include useful context such as price, address, visible Atlas tip, and notes.

## Backend Reliability And Cost Controls

Atlas includes a first layer of production protections:

- `express.json({ limit: '256kb' })` body cap.
- Per-IP rate limiting on `/api/itinerary/*`.
- Burst limit: 20 requests per 15 minutes.
- Daily limit: 80 requests per 24 hours.
- Server-side input validation for lengths, allowed enums, leg count, date order, and max trip duration.
- Request ID middleware for traceability in logs.
- `/api/config` caching to reduce unnecessary config calls.

The current rate limiter is in-memory and appropriate for a single Railway instance. If the app scales horizontally, the limiter should move to a shared store such as Redis.

## Data Model

The central persisted entity is a trip.

Trip table:

- `id`: short public share ID.
- `device_id`: anonymous owner identifier.
- `itinerary`: full JSONB itinerary.
- `title`: denormalized display title.
- `destination`: display destination.
- `start_date` and `end_date`: display and sorting fields.
- `duration_days`: display field.
- `created_at` and `updated_at`: timestamps.

The full itinerary JSON includes:

- Trip metadata.
- Destination legs.
- Days.
- Activities.
- Accommodation.
- Transportation.
- Budget breakdown.
- Weather note.
- Action items.
- Client-side enriched Places fields when available.

## Deployment

Atlas is deployed on Railway.

Production URL:

- `https://atlastravel.up.railway.app`

Required environment variables:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `GOOGLE_MAPS_KEY`
- `DATABASE_URL`, auto-injected by Railway Postgres
- `PORT`, auto-injected by Railway

Google Cloud requirements:

- Maps JavaScript API enabled.
- Places API enabled.
- Referrer restrictions for localhost and the Railway URL.

Railway notes:

- Use the globally installed Rust Railway CLI.
- Do not rely on the old npm `@railway/cli` wrapper.
- `.railwayignore` is required so local files and `node_modules` are not uploaded.

## Current Known Product Caveats

- The full "Want to tweak it?" revision flow is hidden in the UI because it is broader and more failure-prone than Swap or Regenerate day. It can be restored later if its loading/error behavior is tightened.
- Places guardrails may intentionally produce fewer pins/photos when matches are not trustworthy.
- Public share viewers cannot overwrite the original owner's saved trip.
- Browser print headers and footers must be controlled from the browser print dialog.
- There is no user account system yet; saved trips are tied to device-local storage.

## Suggested Next Improvements

Highest value:

- Mobile polish pass for tap targets, modal sizing, day selector usability, and activity photo layout.
- Better loading/error state before restoring the full "Want to tweak it?" revision flow.
- Saved preferences for budget, group size, trip style, and loyalty programs.

Later:

- Manual editing tools such as inline rename/time edits, insert/delete activity, and reorder within a day.
- More specific action items through a third sequential action-items call after core itinerary generation.
- Sentry or another production error tracking tool.
- Redis-backed rate limiting if traffic grows beyond one instance.
