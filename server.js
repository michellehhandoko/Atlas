import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import { initSchema, isAvailable as dbAvailable, query as dbQuery, newTripId } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, 'local.env') });

const app = express();
const port = process.env.PORT || 3000;
const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Trust the first proxy hop (Railway sits in front of the app).
// Without this, every request looks like it's coming from the
// proxy's IP and the rate limiter can't distinguish callers.
app.set('trust proxy', 1);

// ── Request ID + access logging ─────────────────────────────
// Every inbound request gets a short ID (or honors an existing
// X-Request-Id header if one is provided), echoed back on the
// X-Request-Id response header. On response finish we log
// method, path, status, and duration so a user-reported issue
// can be matched to a specific log entry on Railway. Errors
// raised in the handlers below also log the same ID, so a
// single grep stitches the whole story together.
app.use((req, res, next) => {
  const inbound = req.get('x-request-id');
  req.id = (typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 64)
    ? inbound
    : randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id);
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[req ${req.id}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// 256kb is plenty for the largest legitimate payload (a full
// multi-city itinerary on /revise) and ~8x tighter than the
// previous 2mb default, so garbage payloads are cheap to reject.
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limits on the expensive endpoints ─────────────────
// Two tiers per IP across all /api/itinerary/* routes:
//   - burst:  20 requests per 15 minutes
//   - daily:  80 requests per 24 hours
// One initial generation costs 2 calls (/core + /extras); revise,
// regenerate-day, and swap-activity are 1 call each. These ceilings
// leave plenty of room for normal tweaking but stop a single IP
// from running up the OpenAI bill.
const itineraryBurstLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You're sending requests pretty fast — give it a minute and try again." },
});

const itineraryDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You've hit Atlas's daily request cap. Please come back tomorrow." },
});

app.use('/api/itinerary', itineraryBurstLimiter, itineraryDailyLimiter);

// ============================================================
//  ATLAS CORE SYSTEM PROMPT
//  Generates ONLY the day-by-day itinerary + trip metadata +
//  weather note. Smaller schema = faster response. Hotel,
//  transport, budget, tips and action_items are produced by a
//  parallel "extras" call so the user sees the days quickly.
// ============================================================
const SHARED_VOICE = `You are Atlas, a personal travel concierge. You are efficient, opinionated, and feel like texting a well-traveled friend who knows your budget. You make specific recommendations and justify them briefly. Not a generic chatbot — you have taste.`;

const CORE_SYSTEM_PROMPT = `${SHARED_VOICE}

YOUR TASK: Generate ONLY the core day-by-day itinerary (trip metadata, days[], and a short weather note). Hotels, transport, budget, tips, and action items are handled by a separate pass — do NOT include them.

RULES YOU MUST FOLLOW:
- Always respect the user's stated budget as a quality/range signal. You may include exceptional free or inexpensive highlights, but the overall set should feel appropriate for the chosen budget level and should not clearly exceed it.
- Never recommend a tourist trap without acknowledging it ("yes, it's touristy, but worth it because...").
- Always account for travel time between stops. Never schedule back-to-back activities on opposite sides of a city without noting travel time in travel_note.
- Never hallucinate specific prices. Always use ranges (e.g., "budget ~$15–20 for lunch here").
- If destination or dates are vague, make a reasonable assumption and proceed — don't ask clarifying questions.
- Adjust recommendations based on group size (families need different picks than solo travelers or couples).
- Keep tone friendly, confident, a little witty — not robotic.
- For "top3" trip style, generate only 3 activities total across all days — do not create a full day-by-day schedule. For luxury top3 trips, make the set feel premium: at least 2 of the 3 picks should be paid/bookable or have a premium execution angle (private guide, tasting menu, spa/resort experience, VIP/skip-the-line, private driver, chef's counter, etc.). A famous free landmark is okay only when framed with a premium way to experience it.
- For "flexible" style, keep the schedule loose with broad time blocks and fewer activities per day.
- For "structured" style, give a detailed hour-by-hour plan.
- Always set booking_url to null — the frontend generates all booking and search links automatically.
- Always provide your best-estimate GPS coordinates for every activity and for the destination — approximate is fine for well-known places.

ATLAS TIPS RULES (atlas_tip on each activity):
- Include atlas_tip sparingly: AT MOST 1 activity per day, and AT MOST 3 activities across the full itinerary. Only use it where the tip genuinely adds insider value (a reservation trick, a hidden entrance, the right time to arrive, a thing to order).
- For every other activity that day, set atlas_tip to null. Do NOT invent filler tips. A null tip is better than a forgettable one.
- Tips must be concrete and specific. Skip generic advice like "bring a camera" or "go early to avoid crowds".

MULTI-CITY RULES (when the user provides more than one destination/leg):
- Treat each leg as a self-contained mini-trip with its own dates. The trip.legs array in your response MUST list each destination IN THE ORDER GIVEN, using the user's exact destination strings and exact dates.
- Every day in days[] MUST have a "destination" field that matches one of trip.legs[].destination exactly (string match).
- A day's date MUST fall within that destination's startDate–endDate range. Do not place a Kyoto day inside the Tokyo date range.
- Number days continuously across the whole trip (Day 1, Day 2, …) — do NOT restart numbering at each city.
- On transition days (the day the traveler changes cities) include a "transport" category activity that covers the inter-city journey (e.g., "Shinkansen Tokyo → Kyoto, ~2h15m, ~$100"). Set that activity's day.destination to the city the traveler is arriving in.
- Set trip.is_multi_city to true when there are multiple legs, false otherwise.

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this exact schema. No markdown fences, no prose outside the JSON object.

{
  "trip": {
    "destination": "string — primary destination name (or 'City A → City B → City C' for multi-city)",
    "startDate": "YYYY-MM-DD — earliest arrival across all legs",
    "endDate": "YYYY-MM-DD — latest departure across all legs",
    "duration_days": number,
    "travelers": "string — e.g. '2 travelers'",
    "summary": "2–3 sentences about this trip in Atlas voice — for multi-city, mention the arc across cities",
    "destination_coordinates": {"lat": number, "lng": number},
    "is_multi_city": boolean,
    "legs": [
      {
        "destination": "string — city/region name (matches what the user entered)",
        "startDate": "YYYY-MM-DD",
        "endDate": "YYYY-MM-DD",
        "coordinates": {"lat": number, "lng": number}
      }
    ]
  },
  "days": [
    {
      "day_number": number,
      "date_label": "Day 1 — Monday, June 2",
      "destination": "string — which leg/city this day belongs to (must match one of trip.legs[].destination)",
      "theme": "Short evocative theme, e.g. 'First Impressions & Old Town'",
      "activities": [
        {
          "time": "HH:MM or 'Morning' / 'Afternoon' / 'Evening'",
          "name": "Activity or place name",
          "category": "sightseeing | food | accommodation | transport | experience | shopping",
          "description": "2–3 sentences: what it is, why Atlas picked it specifically for this traveler",
          "price_range": "Free | $X–Y per person | ~$X per person | etc.",
          "address": "Street address or neighborhood",
          "booking_url": null,
          "travel_note": "e.g. '12 min by metro from previous stop' — null if first activity of the day",
          "atlas_tip": "One sharp insider tip, or null",
          "coordinates": {"lat": number, "lng": number}
        }
      ]
    }
  ],
  "weather_note": "Typical weather for these dates and what to pack — one or two sentences"
}`;

// ============================================================
//  ATLAS EXTRAS SYSTEM PROMPT
//  Generates hotel pick, transport, budget, tips, and pre-trip
//  action items. Runs in PARALLEL with the core call so the
//  total wall time is max(core, extras) instead of core+extras.
// ============================================================
const EXTRAS_SYSTEM_PROMPT = `${SHARED_VOICE}

YOUR TASK: Generate ONLY the supporting trip extras (hotel recommendations, transport overview, budget breakdown, insider tips, and pre-trip action items). The day-by-day itinerary is handled by a separate pass — do NOT output trip[] or days[].

RULES YOU MUST FOLLOW:
- Always respect the user's stated budget.
- Never hallucinate specific prices — always use ranges (e.g., "$180–240 per night").
- Adjust recommendations based on group size.
- Keep tone friendly, confident, a little witty.
- If loyalty programs are mentioned, note when the recommended hotel is a points partner.
- Always set booking_url to null — the frontend generates booking links.

MULTI-CITY RULES (when more than one destination/leg is given):
- accommodation.alternatives should include at least one option per city — prefix the vibe with the city name (e.g., "Kyoto — quiet ryokan near Gion, perfect for couples").
- accommodation.top_pick should be in the city where the traveler spends the most nights; mention the city in the neighborhood field.
- transport.getting_around should briefly cover local transport in each city plus how to move between cities (Shinkansen, regional flights, etc.).

ACTION ITEMS RULES (always produce 5–8 total):
- A short, practical pre-trip checklist of things the traveler still needs to DO themselves. Atlas only recommends — these are the user's next steps.
- 5–8 items total. NEVER more than 8. Fewer is better than padding with fluff.
- Each item.category MUST be one of: "Flights", "Lodging", "Transportation", "Restaurants", "Activities", "Documents", "Other". Omit any category that doesn't apply.
- Each item.task is a single short imperative sentence. Reference the specific destination(s), dates, and your own hotel pick so it feels personal — e.g., "Book the Park Hyatt Tokyo for June 1–4" not "Reserve a hotel". E.g., "Buy Shinkansen tickets Tokyo → Kyoto for June 4" for multi-city legs.
- Each item.priority MUST be one of: "High", "Medium", "Low". Use High for reservations, documents, flights, lodging, and sold-out attractions; Medium for useful but less urgent bookings; Low for nice-to-have prep.
- Each item.timing is a short timing cue, e.g., "Book this week", "Do this 8+ weeks out", "Opens 30 days ahead", "Before departure", or "2–4 weeks out".
- Always include a "Lodging" item naming the top hotel pick + the relevant dates.
- Always include a "Flights" item with the destination and rough date window.
- Include a "Documents" item only when the trip is international relative to a US traveler — e.g., passport validity (6+ months past return date), tourist visa requirements.
- For multi-city trips, include a "Transportation" item covering inter-city transit.
- Include category-appropriate items for "Restaurants" (e.g., "Reserve omakase in Tokyo — most counters take bookings 30 days out") and "Activities" (e.g., "Book Ghibli Museum tickets — sells out weeks in advance") when the destination has well-known reservation/timed-entry constraints.
- Don't repeat the same task across categories. Don't list generic items like "Pack a suitcase".

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this exact schema. No markdown fences, no prose outside the JSON object.

{
  "accommodation": {
    "top_pick": {
      "name": "Hotel or property name",
      "neighborhood": "Neighborhood (include city for multi-city trips)",
      "price_range": "$X–Y per night",
      "why": "1–2 sentence justification in Atlas voice",
      "booking_url": null,
      "loyalty_note": "Points/miles note if relevant to stated loyalty programs, or null"
    },
    "alternatives": [
      {
        "name": "Hotel name",
        "price_range": "$X–Y per night",
        "vibe": "One sentence: who this is best for — prefix with city name for multi-city trips"
      }
    ]
  },
  "transport": {
    "getting_there": "How to reach the first destination — flight, train, etc. with rough cost range",
    "getting_around": "Primary local transport options and practical tips (for multi-city, cover each city + inter-city transit)",
    "cost_estimate": "Estimated total transport cost for the whole trip"
  },
  "budget_breakdown": {
    "accommodation": "$X–Y total",
    "food": "$X–Y total",
    "activities": "$X–Y total",
    "transport_local": "$X–Y total",
    "total_estimate": "$X–Y total",
    "notes": "One sentence about where most of the budget goes or how to save"
  },
  "insider_tips": [
    "Tip 1 — practical, specific, not generic",
    "Tip 2",
    "Tip 3"
  ],
  "action_items": [
    {
      "category": "Flights | Lodging | Transportation | Restaurants | Activities | Documents | Other",
      "task": "Short imperative task referencing the destination, dates, or hotel pick",
      "priority": "High | Medium | Low",
      "timing": "Short timing cue, e.g. 'Book this week' or 'Opens 30 days ahead'"
    }
  ]
}`;
// ============================================================
//  END SYSTEM PROMPTS
// ============================================================

// ============================================================
//  ATLAS REVISE PROMPT
//  Used by /api/itinerary/revise to apply user edits to an
//  existing itinerary while preserving the rest verbatim.
// ============================================================
const REVISE_SYSTEM_PROMPT = `You are Atlas, a personal travel concierge. You are REVISING an existing itinerary based on a specific user request.

YOUR ONLY JOB IS TO APPLY THE REQUESTED CHANGE — NOTHING MORE.

PRESERVATION RULES (apply to anything the user did NOT explicitly ask to change):
- Same number of days, same dates, same destination per day, same trip.legs, same trip style. Do not turn a structured trip into a top-3 trip or vice versa.
- Same hotel picks if accommodation is not mentioned in the request.
- Same activities, same times, same descriptions, same coordinates if not mentioned in the request — copy them verbatim from the input.
- Same insider tips and weather note if not mentioned in the request.
- Same trip.destination, trip.summary, trip.travelers, and trip.duration_days unless the change forces them to update.
- Same action_items, including priority and timing labels, unless the change affects them. When a change DOES affect an action item (e.g., the user swaps a reserved restaurant), update only the relevant item and keep the rest verbatim. Keep total action items between 5 and 8.

INTERPRETING REQUESTS:
- "Keep X" / "don't change X" → leave X exactly as-is.
- "Make X cheaper / different / less packed" → change ONLY X to satisfy the request; leave everything else unchanged.
- "Add a stop on Day N" → add ONE activity to Day N's activities array; do not modify other days.
- "Change Day N" → only touch Day N.
- If the request is ambiguous or references something that doesn't exist, make the closest reasonable interpretation. Do not invent unrelated changes.
- If the request asks for something that would break the schema (e.g., removing all days), make the minimum compliant change and keep the rest intact.

OUTPUT:
Return the FULL revised itinerary as a JSON object matching the EXACT same schema as the input. Every top-level field present in the input must be present in the output. No markdown fences, no prose outside the JSON object.

ATLAS RULES (still apply to any changed content):
- Respect the original budget. Use price ranges, never fabricated exact prices.
- booking_url is always null.
- Provide GPS coordinates for every activity (reuse the originals when activities are unchanged).
- For multi-city trips, every day.destination must match a trip.legs[].destination, and a day's date must fall within its leg's range.
- atlas_tip cap: each day still has AT MOST 1 activity with a non-null atlas_tip, and the full itinerary has AT MOST 3 total. When you add or replace activities, set atlas_tip to null unless the new stop genuinely warrants insider advice, and don't push the itinerary over the cap.
- Keep the friendly, confident, slightly witty Atlas tone.`;
// ============================================================
//  END REVISE PROMPT
// ============================================================

// ============================================================
//  ATLAS REGENERATE-DAY PROMPT
//  Used by /api/itinerary/regenerate-day to rebuild one day's
//  activities with fresh picks. The day_number / date_label /
//  destination MUST stay the same.
// ============================================================
const REGENERATE_DAY_SYSTEM_PROMPT = `${SHARED_VOICE}

YOUR TASK: REGENERATE ONE DAY of an existing trip with fresh, different picks. Return a single JSON object containing one "day" object.

PRESERVATION RULES:
- day_number, date_label, and destination MUST match the input day exactly.
- If the input day contained an inter-city "transport" activity (the traveler is moving cities that day), the new day MUST also include an inter-city transport activity at a similar time slot.
- Stay within the same trip budget, group size, and trip style as provided in the context.

CHANGE RULES:
- Pick DIFFERENT specific activities than the input day — different restaurants, different sights, different stops. The point is variety.
- Keep the activity count appropriate for the trip style: ~4–6 for "structured", ~2–3 for "flexible", 3 total picks for "top3".
- Honor the user's optional hint (e.g., "less food-focused", "more outdoors", "shorter day", "indoor options for rain"). If no hint is provided, just produce a different but equally strong day.
- A new theme is fine — pick one that reflects the new mix of activities.

ATLAS RULES (still apply):
- Respect the budget. Use price ranges, never fabricated exact prices.
- Include atlas_tip on AT MOST 1 activity for this day. Set it to null for the rest. No filler tips.
- Account for travel time between stops — fill in travel_note where helpful.
- booking_url is always null.
- Provide GPS coordinates for every activity.
- Keep the friendly, confident, slightly witty Atlas tone.

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this exact schema. No markdown fences, no prose outside the JSON object.

{
  "day": {
    "day_number": <unchanged>,
    "date_label": <unchanged>,
    "destination": <unchanged>,
    "theme": "Short evocative theme reflecting the new picks",
    "activities": [
      {
        "time": "HH:MM or 'Morning' / 'Afternoon' / 'Evening'",
        "name": "Activity or place name",
        "category": "sightseeing | food | accommodation | transport | experience | shopping",
        "description": "2–3 sentences in Atlas voice",
        "price_range": "Free | $X–Y per person | ~$X per person | etc.",
        "address": "Street address or neighborhood",
        "booking_url": null,
        "travel_note": "e.g. '12 min by metro from previous stop' — null if first activity of the day",
        "atlas_tip": "One sharp insider tip, or null",
        "coordinates": {"lat": number, "lng": number}
      }
    ]
  }
}`;
// ============================================================
//  END REGENERATE-DAY PROMPT
// ============================================================

// ============================================================
//  ATLAS SWAP-ACTIVITY PROMPT
//  Used by /api/itinerary/swap-activity to replace a single
//  activity with a different but comparable one.
// ============================================================
const SWAP_ACTIVITY_SYSTEM_PROMPT = `${SHARED_VOICE}

YOUR TASK: SWAP ONE ACTIVITY in an existing itinerary for a different but comparable one. Return a single JSON object containing one "activity" object.

PRESERVATION RULES:
- The new activity's TIME and CATEGORY MUST match the original exactly. (If the user is asking to change the time or category, ignore the change — those stay locked.)
- The new activity must fit within the existing day's flow — similar duration, similar role in the schedule.
- Stay within the same trip budget, group size, and trip style as provided in the context.

CHANGE RULES:
- Pick a DIFFERENT specific place/activity than the original. Same vibe by default; different vibe ONLY if the user's hint asks for it.
- Honor the user's optional hint (e.g., "cheaper", "more upscale", "vegetarian", "more casual", "kid-friendly", "no seafood"). If no hint is provided, just produce a different but equally strong pick.
- Provide a meaningful travel_note relative to the previous activity in the day — use the previous-activity context if given.

ATLAS RULES (still apply):
- Respect the budget. Use price ranges, never fabricated exact prices.
- atlas_tip: provide ONE sharp insider tip OR null. Generic advice → null.
- booking_url is always null.
- Provide GPS coordinates.
- Keep the friendly, confident, slightly witty Atlas tone.

OUTPUT FORMAT:
Return ONLY a valid JSON object matching this exact schema. No markdown fences, no prose outside the JSON object.

{
  "activity": {
    "time": <unchanged from input>,
    "name": "Activity or place name",
    "category": <unchanged from input>,
    "description": "2–3 sentences in Atlas voice",
    "price_range": "Free | $X–Y per person | ~$X per person | etc.",
    "address": "Street address or neighborhood",
    "booking_url": null,
    "travel_note": "e.g. '12 min by metro from previous stop' — null if not applicable",
    "atlas_tip": "One sharp insider tip, or null",
    "coordinates": {"lat": number, "lng": number}
  }
}`;
// ============================================================
//  END SWAP-ACTIVITY PROMPT
// ============================================================

// Expose non-secret client-side keys to the frontend
app.get('/api/config', (_req, res) => {
  // /api/config only changes when Railway env vars change (which
  // requires a redeploy). 24h of browser caching is safe and saves
  // every shared-URL visitor a round-trip. The client also caches
  // in sessionStorage so reloads within a tab skip the network.
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({
    mapsKey: process.env.GOOGLE_MAPS_KEY || ''
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: modelName,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasDatabase: dbAvailable(),
  });
});

// ============================================================
//  /api/trips — persistence layer (anonymous device IDs)
//  - POST   /api/trips         save the current itinerary
//  - GET    /api/trips         list trips for this device
//  - GET    /api/trips/:id     public read (share link target)
//  - PUT    /api/trips/:id     owner-only update after edits
//  - DELETE /api/trips/:id     owner-only delete
//  Device ID is sent by the client in the X-Device-Id header.
//  Trip IDs are short hex strings, safe for /share/:id URLs.
// ============================================================
const MAX_TRIP_TITLE_LEN = 300;

function getDeviceId(req) {
  const raw = req.get('x-device-id');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // 8–64 chars, URL-safe alphabet. A client-generated UUID v4
  // (36 chars) fits; so do other reasonable formats.
  if (trimmed.length < 8 || trimmed.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function isValidTripId(id) {
  return typeof id === 'string' && /^[a-f0-9]{12}$/.test(id);
}

function summarizeItinerary(itin) {
  const trip = (itin && typeof itin === 'object' && itin.trip) ? itin.trip : {};
  const destination = clampString(trip.destination || 'Untitled trip', MAX_TRIP_TITLE_LEN);
  const duration = Number.isInteger(trip.duration_days) ? trip.duration_days : null;
  const title = duration
    ? clampString(`${destination} — ${duration} days`, MAX_TRIP_TITLE_LEN)
    : destination;
  return {
    title,
    destination,
    startDate: typeof trip.startDate === 'string' ? trip.startDate.slice(0, 10) : null,
    endDate:   typeof trip.endDate   === 'string' ? trip.endDate.slice(0, 10)   : null,
    durationDays: duration,
  };
}

function ensureDatabase(res) {
  if (!dbAvailable()) {
    res.status(503).json({
      error: 'Saving trips is not configured yet. Add a Railway Postgres database to enable this.',
    });
    return false;
  }
  return true;
}

// POST /api/trips — save a freshly generated itinerary.
app.post('/api/trips', async (req, res) => {
  try {
    if (!ensureDatabase(res)) return;

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
    }

    const itinerary = req.body?.itinerary;
    if (!itinerary || typeof itinerary !== 'object' || Array.isArray(itinerary)) {
      return res.status(400).json({ error: 'Missing itinerary in request body.' });
    }
    if (!itinerary.trip || typeof itinerary.trip !== 'object') {
      return res.status(400).json({ error: 'Itinerary is missing the trip object.' });
    }

    const summary = summarizeItinerary(itinerary);
    const id = newTripId();

    await dbQuery(
      `INSERT INTO trips (id, device_id, itinerary, title, destination, start_date, end_date, duration_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        deviceId,
        JSON.stringify(itinerary),
        summary.title,
        summary.destination,
        summary.startDate,
        summary.endDate,
        summary.durationDays,
      ]
    );

    res.json({
      id,
      shareUrl: `/share/${id}`,
      title: summary.title,
    });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /api/trips POST error:`, error);
    res.status(500).json({ error: 'Failed to save trip.' });
  }
});

// GET /api/trips — list trips for this device (metadata only).
app.get('/api/trips', async (req, res) => {
  try {
    if (!ensureDatabase(res)) return;

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
    }

    const { rows } = await dbQuery(
      `SELECT id, title, destination, start_date, end_date, duration_days, created_at
         FROM trips
        WHERE device_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [deviceId]
    );

    const trips = rows.map(r => ({
      id: r.id,
      title: r.title,
      destination: r.destination,
      startDate: r.start_date ? r.start_date.toISOString().slice(0, 10) : null,
      endDate:   r.end_date   ? r.end_date.toISOString().slice(0, 10)   : null,
      durationDays: r.duration_days,
      createdAt: r.created_at.toISOString(),
    }));

    res.json({ trips });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /api/trips GET error:`, error);
    res.status(500).json({ error: 'Failed to list trips.' });
  }
});

// GET /api/trips/:id — public read. This powers /share/:id —
// anyone with the link can view, no device-id required.
app.get('/api/trips/:id', async (req, res) => {
  try {
    if (!ensureDatabase(res)) return;

    const { id } = req.params;
    if (!isValidTripId(id)) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    const { rows } = await dbQuery(
      `SELECT itinerary FROM trips WHERE id = $1`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    res.json({ id, itinerary: rows[0].itinerary });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /api/trips/:id GET error:`, error);
    res.status(500).json({ error: 'Failed to load trip.' });
  }
});

// PUT /api/trips/:id — owner-only update. Used after revise,
// regenerate-day, and swap-activity so /share/:id and My Trips
// reopen the edited itinerary instead of the original generation.
app.put('/api/trips/:id', async (req, res) => {
  try {
    if (!ensureDatabase(res)) return;

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
    }

    const { id } = req.params;
    if (!isValidTripId(id)) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    const itinerary = req.body?.itinerary;
    if (!itinerary || typeof itinerary !== 'object' || Array.isArray(itinerary)) {
      return res.status(400).json({ error: 'Missing itinerary in request body.' });
    }
    if (!itinerary.trip || typeof itinerary.trip !== 'object') {
      return res.status(400).json({ error: 'Itinerary is missing the trip object.' });
    }

    const summary = summarizeItinerary(itinerary);
    const result = await dbQuery(
      `UPDATE trips
          SET itinerary = $3,
              title = $4,
              destination = $5,
              start_date = $6,
              end_date = $7,
              duration_days = $8,
              updated_at = NOW()
        WHERE id = $1 AND device_id = $2`,
      [
        id,
        deviceId,
        JSON.stringify(itinerary),
        summary.title,
        summary.destination,
        summary.startDate,
        summary.endDate,
        summary.durationDays,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    res.json({
      id,
      shareUrl: `/share/${id}`,
      title: summary.title,
    });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /api/trips/:id PUT error:`, error);
    res.status(500).json({ error: 'Failed to update trip.' });
  }
});

// DELETE /api/trips/:id — owner-only. The DELETE only matches
// when both id AND device_id match, so a foreign device can't
// nuke someone else's trip even with the ID.
app.delete('/api/trips/:id', async (req, res) => {
  try {
    if (!ensureDatabase(res)) return;

    const deviceId = getDeviceId(req);
    if (!deviceId) {
      return res.status(400).json({ error: 'Missing or invalid X-Device-Id header.' });
    }

    const { id } = req.params;
    if (!isValidTripId(id)) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    const result = await dbQuery(
      `DELETE FROM trips WHERE id = $1 AND device_id = $2`,
      [id, deviceId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Trip not found.' });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /api/trips/:id DELETE error:`, error);
    res.status(500).json({ error: 'Failed to delete trip.' });
  }
});

// /share/:id — serve the SPA so the client can read the ID
// from location.pathname and fetch the trip on load. Constrained
// to the 12-char hex ID format so /share/anything-else 404s
// instead of falsely serving the SPA shell.
app.get('/share/:id([a-f0-9]{12})', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Input limits & allowed values ────────────────────────────
// All of these protect the OpenAI bill: every field below ends up
// inside a prompt, so unbounded input = unbounded token cost.
const MAX_DESTINATION_LEN    = 200;
const MAX_INTERESTS_LEN      = 1000;
const MAX_LOYALTY_LEN        = 500;
const MAX_GROUP_SIZE_LEN     = 20;
const MAX_DATE_LEN           = 32;
const MAX_LEGS               = 6;
const MAX_TRIP_DURATION_DAYS = 21;
const MAX_FEEDBACK_LEN       = 2000;
const MAX_HINT_LEN           = 500;

const ALLOWED_BUDGET_LEVELS = new Set(['budget', 'mid', 'luxury']);
const ALLOWED_TRIP_STYLES   = new Set(['flexible', 'structured', 'top3']);

function clampString(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

// Inclusive day span between two YYYY-MM-DD strings. Returns null
// if either date is missing or unparseable.
function daysBetween(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const s = new Date(`${startISO}T00:00:00Z`);
  const e = new Date(`${endISO}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  return Math.floor((e - s) / 86_400_000) + 1;
}

// ── Shared input normalization for /core and /extras ─────────
function normalizeTripInput(body) {
  const {
    legs = [],
    // Legacy single-destination fields (still accepted for backward compatibility)
    destination = '',
    startDate = '',
    endDate = '',
    groupSize = '2',
    budgetLevel = 'mid',
    interests = '',
    tripStyle = 'structured',
    loyaltyPrograms = ''
  } = body || {};

  let tripLegs = Array.isArray(legs)
    ? legs
        .filter(l => l && typeof l.destination === 'string' && l.destination.trim())
        .map(l => ({
          destination: clampString(l.destination, MAX_DESTINATION_LEN),
          startDate:   clampString(l.startDate,   MAX_DATE_LEN),
          endDate:     clampString(l.endDate,     MAX_DATE_LEN),
        }))
    : [];

  if (!tripLegs.length && typeof destination === 'string' && destination.trim()) {
    tripLegs = [{
      destination: clampString(destination, MAX_DESTINATION_LEN),
      startDate:   clampString(startDate,   MAX_DATE_LEN),
      endDate:     clampString(endDate,     MAX_DATE_LEN),
    }];
  }

  const safeBudget = ALLOWED_BUDGET_LEVELS.has(budgetLevel) ? budgetLevel : 'mid';
  const safeStyle  = ALLOWED_TRIP_STYLES.has(tripStyle)     ? tripStyle   : 'structured';

  return {
    tripLegs,
    groupSize:       clampString(groupSize,       MAX_GROUP_SIZE_LEN),
    budgetLevel:     safeBudget,
    interests:       clampString(interests,       MAX_INTERESTS_LEN),
    tripStyle:       safeStyle,
    loyaltyPrograms: clampString(loyaltyPrograms, MAX_LOYALTY_LEN),
  };
}

// Returns an error string if the normalized input is unusable
// (too many legs, too-long trip, missing destination, etc.) or
// null when it's safe to send to the model.
function validateTripInput(input) {
  if (!input.tripLegs.length) {
    return 'Please enter at least one destination.';
  }
  if (input.tripLegs.length > MAX_LEGS) {
    return `Atlas supports up to ${MAX_LEGS} destinations per trip. Please remove a leg and try again.`;
  }
  for (const leg of input.tripLegs) {
    if (!leg.destination) return 'Each leg needs a destination.';
    // Per-leg date sanity: if both dates are given, departure must be on or after arrival.
    if (leg.startDate && leg.endDate) {
      const legSpan = daysBetween(leg.startDate, leg.endDate);
      if (legSpan !== null && legSpan < 1) {
        return "Each leg's departure date must be on or after its arrival date.";
      }
    }
  }
  // Only enforce the total-duration cap when every leg has both dates —
  // partial-date trips fall back to the model's interpretation.
  const allDates = input.tripLegs.flatMap(l => [l.startDate, l.endDate]).filter(Boolean);
  if (allDates.length === input.tripLegs.length * 2) {
    const earliest = allDates.reduce((a, b) => (a < b ? a : b));
    const latest   = allDates.reduce((a, b) => (a > b ? a : b));
    const duration = daysBetween(earliest, latest);
    if (duration !== null && duration > MAX_TRIP_DURATION_DAYS) {
      return `Atlas plans trips up to ${MAX_TRIP_DURATION_DAYS} days long. Please shorten your dates.`;
    }
  }
  return null;
}

function buildUserMessage(input, mode) {
  const { tripLegs, groupSize, budgetLevel, interests, tripStyle, loyaltyPrograms } = input;
  const isMultiCity = tripLegs.length > 1;

  const budgetLabels = {
    budget: 'budget traveler (under $100/day per person) — prioritize affordable/free options and value',
    mid: 'mid-range ($100–200/day per person) — mix paid experiences with strong-value highlights',
    luxury: 'luxury ($200+/day per person) — prioritize premium, bookable, high-touch experiences; free landmarks are okay only with a premium angle'
  };

  const styleLabels = {
    flexible: 'flexible and relaxed — loose suggestions, not hour-by-hour',
    structured: 'structured and detailed — hour-by-hour daily schedule',
    top3: 'top 3 priorities only — just the absolute must-dos, no full schedule'
  };

  const legLines = tripLegs.map((l, i) =>
    `  ${i + 1}. ${l.destination} — ${l.startDate || 'flexible start'} to ${l.endDate || 'flexible end'}`
  ).join('\n');

  const tripHeader = isMultiCity
    ? `Plan a multi-city trip with ${tripLegs.length} destinations (in order):\n${legLines}`
    : `Plan a trip to ${tripLegs[0].destination}.\nTravel dates: ${tripLegs[0].startDate || 'flexible'} to ${tripLegs[0].endDate || 'flexible'}`;

  const multiCityReminder = isMultiCity
    ? `\nThis is a MULTI-CITY trip. Follow the MULTI-CITY RULES strictly.`
    : '';

  const closer = mode === 'core'
    ? 'Return ONLY the core itinerary JSON (trip, days, weather_note) matching the schema in your instructions.'
    : 'Return ONLY the extras JSON (accommodation, transport, budget_breakdown, insider_tips, action_items) matching the schema in your instructions.';

  return `${tripHeader}
Group size: ${groupSize} traveler(s)
Budget: ${budgetLabels[budgetLevel] || budgetLevel}
Trip style preference: ${styleLabels[tripStyle] || tripStyle}
Interests and must-dos: ${interests.trim() || 'No specific preferences — show me the best of each destination.'}
Travel loyalty programs: ${loyaltyPrograms.trim() || 'None mentioned'}
${multiCityReminder}

${closer}`;
}

async function callOpenAIJson({ systemPrompt, userMessage, temperature }) {
  const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await ai.chat.completions.create({
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage }
    ],
    response_format: { type: 'json_object' },
    temperature,
  });
  const rawText = response.choices?.[0]?.message?.content || '';
  return JSON.parse(rawText);
}

// ── /api/itinerary/core ─────────────────────────────────────
// Returns trip + days + weather_note. Render this immediately,
// then the frontend swaps in the sidebar from /extras.
app.post('/api/itinerary/core', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: 'Missing OPENAI_API_KEY. Add it to local.env locally and to Railway variables before deploying.'
      });
    }
    const input = normalizeTripInput(req.body);
    const inputError = validateTripInput(input);
    if (inputError) {
      return res.status(400).json({ error: inputError });
    }

    const userMessage = buildUserMessage(input, 'core');
    let core;
    try {
      core = await callOpenAIJson({
        systemPrompt: CORE_SYSTEM_PROMPT,
        userMessage,
        temperature: 0.85,
      });
    } catch (parseOrCallErr) {
      console.error(`[req ${req.id}] Core call failed:`, parseOrCallErr);
      return res.status(500).json({ error: 'The model returned malformed JSON. Please try again.' });
    }

    res.json({ itinerary: core, model: modelName });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /core error:`, error);
    res.status(500).json({ error: error.message || 'Model call failed. Check your API key and server logs.' });
  }
});

// ── /api/itinerary/extras ───────────────────────────────────
// Returns accommodation + transport + budget_breakdown +
// insider_tips + action_items. Called in PARALLEL with /core.
app.post('/api/itinerary/extras', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: 'Missing OPENAI_API_KEY. Add it to local.env locally and to Railway variables before deploying.'
      });
    }
    const input = normalizeTripInput(req.body);
    const inputError = validateTripInput(input);
    if (inputError) {
      return res.status(400).json({ error: inputError });
    }

    const userMessage = buildUserMessage(input, 'extras');
    let extras;
    try {
      extras = await callOpenAIJson({
        systemPrompt: EXTRAS_SYSTEM_PROMPT,
        userMessage,
        temperature: 0.7,
      });
    } catch (parseOrCallErr) {
      console.error(`[req ${req.id}] Extras call failed:`, parseOrCallErr);
      return res.status(500).json({ error: 'The model returned malformed JSON. Please try again.' });
    }

    res.json({ extras, model: modelName });
  } catch (error) {
    console.error(`[req ${req.id}] Atlas /extras error:`, error);
    res.status(500).json({ error: error.message || 'Model call failed. Check your API key and server logs.' });
  }
});

// ============================================================
//  /api/itinerary/revise
//  Takes the current itinerary + user feedback text, returns
//  a revised itinerary that preserves everything the user
//  didn't ask to change.
// ============================================================
app.post('/api/itinerary/revise', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: 'Missing OPENAI_API_KEY. Add it to local.env locally and to Railway variables before deploying.'
      });
    }

    const { itinerary, feedback } = req.body || {};

    if (!itinerary || typeof itinerary !== 'object' || Array.isArray(itinerary)) {
      return res.status(400).json({ error: 'Missing current itinerary to revise.' });
    }
    if (!feedback || typeof feedback !== 'string' || !feedback.trim()) {
      return res.status(400).json({ error: 'Please describe what you want to change.' });
    }
    const safeFeedback = clampString(feedback, MAX_FEEDBACK_LEN);

    const userMessage = `Here is the CURRENT itinerary (the source of truth — preserve everything not explicitly mentioned in the change request):

\`\`\`json
${JSON.stringify(itinerary, null, 2)}
\`\`\`

The user's revision request:
"""
${safeFeedback}
"""

Return the FULL revised itinerary as a JSON object matching the same schema as the input above. Apply ONLY the requested change; copy every unchanged field verbatim from the input.`;

    const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await ai.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: REVISE_SYSTEM_PROMPT },
        { role: 'user', content: userMessage }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5  // lower than initial gen — we want faithful edits, not creativity
    });

    const rawText = response.choices?.[0]?.message?.content || '';

    let revised;
    try {
      revised = JSON.parse(rawText);
    } catch {
      console.error(`[req ${req.id}] Revise JSON parse failed. Raw response:`, rawText.slice(0, 500));
      return res.status(500).json({
        error: 'The model returned malformed JSON. Please try again.'
      });
    }

    res.json({ itinerary: revised, model: modelName });

  } catch (error) {
    console.error(`[req ${req.id}] Atlas revise error:`, error);
    res.status(500).json({
      error: error.message || 'Revision failed. Check server logs.'
    });
  }
});

// ============================================================
//  /api/itinerary/regenerate-day
//  Rebuilds ONE day with fresh picks. Takes the trip context
//  (so the model knows budget, style, group size, dest legs)
//  and the existing day. Returns a single replacement day.
// ============================================================
app.post('/api/itinerary/regenerate-day', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: 'Missing OPENAI_API_KEY. Add it to local.env locally and to Railway variables before deploying.'
      });
    }

    const { trip, day, formContext = {}, hint = '' } = req.body || {};
    if (!trip || typeof trip !== 'object') return res.status(400).json({ error: 'Missing trip context.' });
    if (!day  || typeof day  !== 'object') return res.status(400).json({ error: 'Missing day to regenerate.' });

    const {
      groupSize = '2',
      budgetLevel = 'mid',
      tripStyle = 'structured',
      interests = '',
      loyaltyPrograms = ''
    } = formContext;

    const budgetLabels = {
      budget: 'budget traveler (under $100/day per person)',
      mid: 'mid-range ($100–200/day per person)',
      luxury: 'luxury ($200+/day per person)'
    };
    const styleLabels = {
      flexible: 'flexible and relaxed — loose suggestions, not hour-by-hour',
      structured: 'structured and detailed — hour-by-hour daily schedule',
      top3: 'top 3 priorities only — just the absolute must-dos'
    };

    const userMessage = `Regenerate the following day of an existing trip with fresh picks. Keep day_number, date_label, and destination identical. Pick different activities.

TRIP CONTEXT:
${JSON.stringify(trip, null, 2)}

THE DAY TO REGENERATE (input — produce a different version):
\`\`\`json
${JSON.stringify(day, null, 2)}
\`\`\`

Group size: ${groupSize} traveler(s)
Budget: ${budgetLabels[budgetLevel] || budgetLevel}
Trip style: ${styleLabels[tripStyle] || tripStyle}
Interests: ${interests.trim() || 'No specific preferences.'}
Loyalty programs: ${loyaltyPrograms.trim() || 'None mentioned'}

User hint for the new day (optional, may be empty): "${clampString(hint, MAX_HINT_LEN)}"

Return a JSON object with a single "day" field matching the schema in your instructions.`;

    let parsed;
    try {
      parsed = await callOpenAIJson({
        systemPrompt: REGENERATE_DAY_SYSTEM_PROMPT,
        userMessage,
        temperature: 0.85,
      });
    } catch (err) {
      console.error(`[req ${req.id}] Regenerate-day call failed:`, err);
      return res.status(500).json({ error: 'The model returned malformed JSON. Please try again.' });
    }

    if (!parsed?.day) {
      return res.status(500).json({ error: 'The model did not return a day object.' });
    }

    // Lock the immutable fields back to the original — defense in depth
    // against the model deciding to renumber or rename.
    parsed.day.day_number = day.day_number;
    parsed.day.date_label = day.date_label;
    parsed.day.destination = day.destination;
    if (tripStyle === 'top3' && Array.isArray(parsed.day.activities)) {
      parsed.day.activities = parsed.day.activities.slice(0, 3);
    }

    res.json({ day: parsed.day, model: modelName });

  } catch (error) {
    console.error(`[req ${req.id}] Atlas regenerate-day error:`, error);
    res.status(500).json({ error: error.message || 'Day regeneration failed.' });
  }
});

// ============================================================
//  /api/itinerary/swap-activity
//  Replaces ONE activity with a different but comparable pick.
//  Time and category are locked to the original.
// ============================================================
app.post('/api/itinerary/swap-activity', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        error: 'Missing OPENAI_API_KEY. Add it to local.env locally and to Railway variables before deploying.'
      });
    }

    const {
      trip,
      day,
      activity,
      activityIndex,
      formContext = {},
      hint = ''
    } = req.body || {};

    if (!trip || typeof trip !== 'object') return res.status(400).json({ error: 'Missing trip context.' });
    if (!activity || typeof activity !== 'object') return res.status(400).json({ error: 'Missing activity to swap.' });

    const {
      groupSize = '2',
      budgetLevel = 'mid',
      tripStyle = 'structured',
      interests = '',
      loyaltyPrograms = ''
    } = formContext;

    const budgetLabels = {
      budget: 'budget traveler (under $100/day per person)',
      mid: 'mid-range ($100–200/day per person)',
      luxury: 'luxury ($200+/day per person)'
    };
    const styleLabels = {
      flexible: 'flexible and relaxed',
      structured: 'structured and detailed',
      top3: 'top 3 priorities only'
    };

    // Pull neighbouring activities (the one before and after) so the model
    // can write a sensible travel_note and avoid duplicating something the
    // traveler is already doing that day.
    const dayActs = Array.isArray(day?.activities) ? day.activities : [];
    const idx = Number.isInteger(activityIndex) ? activityIndex : -1;
    const previousActivity = idx > 0 ? dayActs[idx - 1] : null;
    const nextActivity     = (idx >= 0 && idx < dayActs.length - 1) ? dayActs[idx + 1] : null;

    const userMessage = `Swap the following activity in an existing day for a different but comparable one. The TIME ("${activity.time || ''}") and CATEGORY ("${activity.category || ''}") MUST stay the same.

TRIP CONTEXT (high level):
Destination(s): ${trip.destination || ''}
${Array.isArray(trip.legs) && trip.legs.length > 1 ? `Legs: ${trip.legs.map(l => `${l.destination} (${l.startDate} → ${l.endDate})`).join('; ')}` : ''}

DAY CONTEXT:
Day ${day?.day_number || '?'} — ${day?.date_label || ''} in ${day?.destination || trip.destination || ''}
Theme: ${day?.theme || ''}

PREVIOUS ACTIVITY (for travel_note context — may be null):
${previousActivity ? JSON.stringify(previousActivity, null, 2) : 'null'}

ACTIVITY TO SWAP (input — produce a different version):
\`\`\`json
${JSON.stringify(activity, null, 2)}
\`\`\`

NEXT ACTIVITY (so you don't duplicate it — may be null):
${nextActivity ? JSON.stringify(nextActivity, null, 2) : 'null'}

Group size: ${groupSize} traveler(s)
Budget: ${budgetLabels[budgetLevel] || budgetLevel}
Trip style: ${styleLabels[tripStyle] || tripStyle}
Interests: ${interests.trim() || 'No specific preferences.'}
Loyalty programs: ${loyaltyPrograms.trim() || 'None mentioned'}

User hint for the swap (optional, may be empty): "${clampString(hint, MAX_HINT_LEN)}"

Return a JSON object with a single "activity" field matching the schema in your instructions.`;

    let parsed;
    try {
      parsed = await callOpenAIJson({
        systemPrompt: SWAP_ACTIVITY_SYSTEM_PROMPT,
        userMessage,
        temperature: 0.85,
      });
    } catch (err) {
      console.error(`[req ${req.id}] Swap-activity call failed:`, err);
      return res.status(500).json({ error: 'The model returned malformed JSON. Please try again.' });
    }

    if (!parsed?.activity) {
      return res.status(500).json({ error: 'The model did not return an activity object.' });
    }

    // Lock the immutable fields back to the original.
    parsed.activity.time     = activity.time;
    parsed.activity.category = activity.category;
    parsed.activity.booking_url = null;

    res.json({ activity: parsed.activity, model: modelName });

  } catch (error) {
    console.error(`[req ${req.id}] Atlas swap-activity error:`, error);
    res.status(500).json({ error: error.message || 'Activity swap failed.' });
  }
});

app.listen(port, async () => {
  console.log(`Atlas is running → http://localhost:${port}`);
  // Best-effort schema bootstrap. If DATABASE_URL is missing or
  // the DB is unreachable, the persistence endpoints return 503
  // with a friendly message; the rest of the app keeps working.
  await initSchema();
});
