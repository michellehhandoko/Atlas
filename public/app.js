/* ═══════════════════════════════════════════
   ATLAS — Frontend Logic
   - Form submission & view management
   - Personalized loading messages
   - Real booking/search URL generation
   - Google Maps with per-day markers
   - Share via URL hash + Print
   - ICS calendar export
════════════════════════════════════════════ */

// ── State ─────────────────────────────────────
let mapsKey = '';
let mapsReady = false;
let placesService = null;
let autocompleteService = null;
let atlasMap = null;
let atlasMapInfoWindow = null;
let atlasMapOverlays = [];
let atlasMapMarkerLookup = new Map();
let mapViewMode = 'all';
let currentItinerary = null;
let revisionHistory = [];   // [{ feedback, timestamp }] — cleared on new trip
let lastTripRequest = null; // last form payload — used to retry /extras on failure
let placeEnrichmentRequestId = 0;

// ── Day colors (one per day, cycles) ──────────
const DAY_COLORS = [
  '#1E5FAD', // blue
  '#E07B54', // coral
  '#059669', // green
  '#7C3AED', // purple
  '#BE185D', // pink
  '#F59E0B', // amber
  '#0891B2', // cyan
];

const MAX_PLACE_MATCH_DISTANCE_KM = 120;
const MAX_VISIBLE_ATLAS_TIPS = 3;

// ── Category dots (color-only, no icons) ───────
// The .activity-dot relies on a CSS class (cat-*) for color;
// no textual icon is rendered inside the dot.
function categoryIcon(_cat) {
  return '';
}

function getActiveDayIndex() {
  const active = document.querySelector('.day-selector .day-chip.active');
  if (!active) return 0;
  const idx = parseInt(active.dataset.dayIndex, 10);
  return Number.isNaN(idx) ? 0 : idx;
}

function isTopThreeTrip() {
  return lastTripRequest?.tripStyle === 'top3' || currentItinerary?._tripStyle === 'top3';
}

function shouldShowAtlasTip(dayIdx, actIdx) {
  const days = currentItinerary?.days || [];
  let shown = 0;

  for (let d = 0; d < days.length; d++) {
    let shownForDay = 0;
    const activities = days[d].activities || [];
    for (let a = 0; a < activities.length; a++) {
      if (!activities[a].atlas_tip) continue;
      if (shownForDay >= 1 || shown >= MAX_VISIBLE_ATLAS_TIPS) continue;
      if (d === dayIdx && a === actIdx) return true;
      shownForDay++;
      shown++;
    }
  }

  return false;
}

// ═══════════════════════════════════════════════
//  PERSISTENCE — anonymous device ID + saved trips
//  The server stores trips in Postgres keyed by a UUID that
//  lives in localStorage on this device. No accounts. Clearing
//  localStorage cuts the user off from previously-saved trips
//  (still openable via the share URL, just not in "My Trips").
// ═══════════════════════════════════════════════
const DEVICE_ID_KEY = 'atlas:device_id:v1';

function getOrCreateDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (id && id.length >= 8) return id;
    // crypto.randomUUID is available in all modern browsers.
    id = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // Storage blocked (private mode, etc.) — generate a per-session ID.
    return `eph-${Math.random().toString(36).slice(2, 14)}`;
  }
}

function cleanItineraryForSave(itinerary) {
  const clean = { ...itinerary };
  delete clean._loadingExtras;
  delete clean._extrasError;
  delete clean._tripId;
  return clean;
}

// Save the current itinerary to the server. Fire-and-forget from
// the UI perspective — we stash the returned trip ID on the
// itinerary object so the share button can use the short URL.
async function saveTripIfPossible(itinerary) {
  if (!itinerary || itinerary._tripId) return; // already saved
  itinerary._tripId = 'pending'; // de-dupe concurrent calls
  try {
    const clean = cleanItineraryForSave(itinerary);

    const res = await fetch('/api/trips', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
      },
      body: JSON.stringify({ itinerary: clean }),
    });
    if (!res.ok) {
      // 503 (DB not configured) is expected before Railway Postgres
      // is provisioned. Quietly fall back to legacy hash-based sharing.
      itinerary._tripId = null;
      return;
    }
    const body = await res.json();
    if (body && body.id) {
      itinerary._tripId = body.id;
      // Promote the URL to /share/:id so a reload re-fetches from
      // the server instead of trying to decode the old hash.
      if (currentItinerary === itinerary) {
        history.replaceState(null, '', `/share/${body.id}`);
      }
      // Refresh the My Trips counter for when the user clicks
      // back to the form. Fire-and-forget.
      refreshMyTripsButton();
    } else {
      itinerary._tripId = null;
    }
  } catch {
    itinerary._tripId = null;
  }
}

// Persist edits to an already-saved trip. This is intentionally
// best-effort: if the user is viewing someone else's public share link
// or the DB is unavailable, the local edited itinerary still works.
async function updateSavedTripIfPossible(itinerary) {
  const tripId = itinerary?._tripId;
  if (!tripId || tripId === 'pending') return false;

  try {
    const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getOrCreateDeviceId(),
      },
      body: JSON.stringify({ itinerary: cleanItineraryForSave(itinerary) }),
    });
    if (!res.ok) return false;
    refreshMyTripsButton();
    return true;
  } catch {
    return false;
  }
}

async function persistTripIfPossible(itinerary) {
  if (!itinerary) return false;
  if (itinerary._tripId && itinerary._tripId !== 'pending') {
    return updateSavedTripIfPossible(itinerary);
  }
  await saveTripIfPossible(itinerary);
  return Boolean(itinerary._tripId && itinerary._tripId !== 'pending');
}

async function loadTripById(id) {
  const res = await fetch(`/api/trips/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Trip not found.');
  const body = await res.json();
  if (!body.itinerary) throw new Error('Trip not found.');
  body.itinerary._tripId = body.id;
  return body.itinerary;
}

async function fetchMyTrips() {
  const res = await fetch('/api/trips', {
    headers: { 'X-Device-Id': getOrCreateDeviceId() },
  });
  if (res.status === 503) return { trips: [], unavailable: true };
  if (!res.ok) throw new Error('Failed to load trips.');
  const body = await res.json();
  return { trips: Array.isArray(body.trips) ? body.trips : [], unavailable: false };
}

async function deleteSavedTrip(id) {
  const res = await fetch(`/api/trips/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { 'X-Device-Id': getOrCreateDeviceId() },
  });
  return res.ok;
}

// Quick check on form-view load: if this device has any saved
// trips, reveal the "My Trips" button in the hero. The endpoint
// returns 503 when the DB isn't provisioned yet — in that case
// the button stays hidden and the user never sees a broken state.
async function refreshMyTripsButton() {
  const btn = document.getElementById('my-trips-btn');
  if (!btn) return;
  try {
    const { trips, unavailable } = await fetchMyTrips();
    if (unavailable || trips.length === 0) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.textContent = trips.length === 1 ? 'My Trips (1)' : `My Trips (${trips.length})`;
  } catch {
    btn.hidden = true;
  }
}

// ═══════════════════════════════════════════════
//  INIT — runs once on page load
// ═══════════════════════════════════════════════
const CONFIG_CACHE_KEY = 'atlas:config:v1';

async function loadConfig() {
  // Try sessionStorage first — /api/config only changes on a
  // server redeploy, so within a browser session a single fetch
  // is plenty. The server also sends Cache-Control: max-age=86400
  // for the cross-tab / browser-cache win.
  try {
    const cached = sessionStorage.getItem(CONFIG_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch {
    // sessionStorage can be blocked (private mode, etc.) — fall through.
  }

  const cfg = await fetch('/api/config').then(r => r.json());

  try {
    sessionStorage.setItem(CONFIG_CACHE_KEY, JSON.stringify(cfg));
  } catch {
    // Cache write failed — harmless, we still have the live value.
  }

  return cfg;
}

(async function init() {
  try {
    const cfg = await loadConfig();
    mapsKey = cfg.mapsKey || '';
    if (mapsKey) await loadGoogleMaps(mapsKey);
  } catch {
    // Config fetch failed — maps just won't appear
  }

  checkForSharedItinerary();
  // Reveal "My Trips" if this device has any. Runs in the
  // background — doesn't block render. Stays hidden if DB is
  // unavailable or this device has zero trips.
  refreshMyTripsButton();
})();

// ── Load Google Maps script dynamically ───────
function loadGoogleMaps(key) {
  return new Promise((resolve) => {
    if (window.google?.maps) { mapsReady = true; resolve(); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => { mapsReady = true; resolve(); };
    script.onerror = () => resolve(); // fail silently
    document.head.appendChild(script);
  });
}

// ═══════════════════════════════════════════════
//  VIEWS
// ═══════════════════════════════════════════════
const viewForm    = document.getElementById('view-form');
const viewLoading = document.getElementById('view-loading');
const viewResults = document.getElementById('view-results');

function showView(name) {
  viewForm.classList.remove('active');
  viewLoading.classList.remove('active');
  viewResults.classList.remove('active');
  if (name === 'form')    viewForm.classList.add('active');
  if (name === 'loading') viewLoading.classList.add('active');
  if (name === 'results') viewResults.classList.add('active');

  // Form / loading are single-screen — start at top.
  // Results is long — land on the day cards so the user sees the
  // itinerary itself, not the trip banner that sits above it.
  if (name === 'results') scrollToItinerary();
  else                    scrollToTopOfPage();
}

function scrollToTopOfPage() {
  const reset = () => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  };
  reset();
  requestAnimationFrame(() => {
    reset();
    requestAnimationFrame(reset);
  });
}

// Scroll the trip banner (destination + dates header) into view. Used
// after initial generation and retained for the hidden full-itinerary
// revision flow if that UI is restored later.
function scrollToItinerary() {
  const findTarget = () =>
       document.querySelector('.trip-banner')
    || document.querySelector('.day-selector')
    || document.querySelector('.day-cards-wrap');

  const goTo = () => {
    const target = findTarget();
    if (!target) { window.scrollTo(0, 0); return; }
    // Use rect.top + current scroll to compute an absolute Y; scrollIntoView
    // can be flaky when the document height has just changed.
    const y = target.getBoundingClientRect().top + window.pageYOffset - 8;
    window.scrollTo({ top: Math.max(0, y), left: 0, behavior: 'auto' });
  };

  // Run once, then again on the next frame so we land correctly even if
  // layout is still settling (maps script, fonts, skeleton → real card).
  goTo();
  requestAnimationFrame(() => {
    goTo();
    requestAnimationFrame(goTo);
  });
}

// ═══════════════════════════════════════════════
//  LOADING MESSAGES (personalized with destination)
// ═══════════════════════════════════════════════
let loadingInterval = null;

function startLoadingMessages(destination) {
  const dest = destination || 'your destination';
  const steps = [
    `Researching ${dest}...`,
    'Scouting the best neighborhoods...',
    'Building your day-by-day plan...',
    'Finding the hidden gems...',
    'Checking restaurant options...',
    'Comparing hotel picks...',
    'Adding insider tips...',
    'Almost ready...',
  ];
  const msgEl  = document.getElementById('loading-msg');
  const subEl  = document.querySelector('.loading-sub');
  let i = 0;
  msgEl.textContent = steps[0];
  if (subEl) subEl.textContent = 'Atlas is on it';
  loadingInterval = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);
    msgEl.textContent = steps[i];
  }, 2500);
}

function stopLoadingMessages() {
  if (loadingInterval) { clearInterval(loadingInterval); loadingInterval = null; }
}

// ═══════════════════════════════════════════════
//  MULTI-DESTINATION (LEGS) MANAGEMENT
// ═══════════════════════════════════════════════
const legsList   = document.getElementById('legs-list');
const addLegBtn  = document.getElementById('add-leg-btn');

function buildLegRow(index) {
  const row = document.createElement('div');
  row.className = 'leg-row';
  row.dataset.legIndex = String(index);
  row.innerHTML = `
    <div class="leg-index" aria-hidden="true">${index + 1}</div>
    <div class="leg-fields">
      <div class="field">
        <label>Destination</label>
        <input class="leg-destination" type="text" placeholder="Next city" autocomplete="off">
      </div>
      <div class="field-row">
        <div class="field">
          <label>Departure</label>
          <input class="leg-start" type="date">
        </div>
        <div class="field">
          <label>Return</label>
          <input class="leg-end" type="date">
        </div>
      </div>
    </div>
    <button type="button" class="leg-remove-btn" aria-label="Remove this destination">×</button>
  `;
  return row;
}

function addLeg() {
  const idx = legsList.children.length;
  const row = buildLegRow(idx);

  // Auto-fill new leg's departure from the previous leg's return
  const prevEnd = legsList.querySelectorAll('.leg-end')[idx - 1];
  if (prevEnd?.value) {
    row.querySelector('.leg-start').value = prevEnd.value;
  }

  legsList.appendChild(row);
  refreshLegUI();
  row.querySelector('.leg-destination').focus();
}

function removeLeg(rowEl) {
  rowEl.remove();
  // Reindex remaining rows
  legsList.querySelectorAll('.leg-row').forEach((r, i) => {
    r.dataset.legIndex = String(i);
    const idxEl = r.querySelector('.leg-index');
    if (idxEl) idxEl.textContent = String(i + 1);
  });
  refreshLegUI();
}

function refreshLegUI() {
  const rows = legsList.querySelectorAll('.leg-row');
  rows.forEach(r => {
    const removeBtn = r.querySelector('.leg-remove-btn');
    if (removeBtn) removeBtn.hidden = rows.length <= 1;
  });
}

function getLegs() {
  return Array.from(legsList.querySelectorAll('.leg-row')).map(r => ({
    destination: r.querySelector('.leg-destination').value.trim(),
    startDate:   r.querySelector('.leg-start').value,
    endDate:     r.querySelector('.leg-end').value,
  }));
}

addLegBtn?.addEventListener('click', addLeg);
legsList?.addEventListener('click', (e) => {
  const btn = e.target.closest('.leg-remove-btn');
  if (btn) removeLeg(btn.closest('.leg-row'));
});

// ═══════════════════════════════════════════════
//  FORM SUBMISSION
// ═══════════════════════════════════════════════
const form      = document.getElementById('trip-form');
const submitBtn = document.getElementById('submit-btn');
const formError = document.getElementById('form-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.classList.add('hidden');

  const allLegs   = getLegs();
  const validLegs = allLegs.filter(l => l.destination);

  if (!validLegs.length) {
    showError('Please enter at least one destination.');
    return;
  }

  const missingDates = validLegs.filter(leg => !leg.startDate || !leg.endDate);
  if (missingDates.length) {
    showError(validLegs.length > 1
      ? 'Add departure and return dates for each destination so Atlas can plan the route in order.'
      : 'Add departure and return dates so Atlas can build a real day-by-day itinerary.');
    return;
  }

  // Validate per-leg date ordering
  for (const leg of validLegs) {
    if (leg.startDate && leg.endDate && leg.endDate < leg.startDate) {
      showError(`Return must be after departure for ${leg.destination}.`);
      return;
    }
  }

  let resolvedLegs;
  try {
    submitBtn.disabled = true;
    resolvedLegs = await validateDestinationLegs(validLegs);
  } catch (err) {
    submitBtn.disabled = false;
    if (err?.message) showError(err.message);
    return;
  }

  const data = {
    legs: resolvedLegs,
    groupSize:        form.elements.groupSize.value,
    budgetLevel:      form.elements.budgetLevel.value,
    tripStyle:        form.elements.tripStyle.value,
    interests:        form.elements.interests.value,
    loyaltyPrograms:  form.elements.loyaltyPrograms.value,
  };

  lastTripRequest = data;
  revisionHistory = [];
  placeEnrichmentRequestId++;

  showView('loading');
  startLoadingMessages(resolvedLegs.map(l => l.destination).join(', '));
  submitBtn.disabled = true;

  // Fire CORE + EXTRAS in PARALLEL. Render core as soon as it lands;
  // swap in extras when (and if) they arrive.
  const corePromise   = fetchJSON('/api/itinerary/core',   data);
  const extrasPromise = fetchJSON('/api/itinerary/extras', data);

  // Track whether the core view has rendered yet. If extras finishes
  // first, stash the payload and merge it in when core eventually renders.
  let coreRendered  = false;
  let pendingExtras = null;
  let pendingError  = null;

  extrasPromise.then(({ ok, body }) => {
    if (!ok || body.error) {
      const msg = (body && body.error) || 'Couldn’t load hotel + budget details.';
      if (coreRendered && currentItinerary) {
        markExtrasError(msg);
      } else {
        pendingError = msg;
      }
      return;
    }
    if (coreRendered && currentItinerary) {
      applyExtras(body.extras);
    } else {
      pendingExtras = body.extras;
    }
  }).catch(err => {
    const msg = err?.message || 'Couldn’t load hotel + budget details.';
    if (coreRendered && currentItinerary) markExtrasError(msg);
    else pendingError = msg;
  });

  try {
    const { ok, body } = await corePromise;
    if (!ok) throw new Error(body?.error || 'Something went wrong. Please try again.');

    stopLoadingMessages();

    // Build the initial itinerary from core. If extras already arrived,
    // merge it in now; otherwise mark as loading so the sidebar shows
    // skeleton cards.
    const itinerary = { ...body.itinerary, _tripStyle: lastTripRequest?.tripStyle };
    let extrasResolved = false;
    if (pendingExtras) {
      Object.assign(itinerary, pendingExtras);
      extrasResolved = true;
    } else if (pendingError) {
      itinerary._extrasError = pendingError;
      extrasResolved = true;
    } else {
      itinerary._loadingExtras = true;
    }

    coreRendered = true;
    renderResults(itinerary);
    showView('results');
    enrichPlacesForCurrentItinerary();

    // If extras already finished (success or fail) by the time core
    // rendered, save now. Otherwise applyExtras/markExtrasError
    // will save once the extras call settles.
    if (extrasResolved) saveTripIfPossible(currentItinerary);

  } catch (err) {
    stopLoadingMessages();
    showView('form');
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

// Small fetch wrapper that always returns { ok, body } so the caller can
// branch without nested try/catch around JSON parsing.
async function fetchJSON(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch { /* leave null */ }
  return { ok: res.ok, body };
}

// Merge extras into the rendered itinerary and re-render just the sidebar.
function applyExtras(extras) {
  if (!currentItinerary || !extras) return;
  Object.assign(currentItinerary, extras);
  delete currentItinerary._loadingExtras;
  delete currentItinerary._extrasError;
  rebuildSidebar(currentItinerary);
  // Save once we have the full itinerary. If extras came in before
  // core rendered (rare), the save in the core path handled it.
  persistTripIfPossible(currentItinerary);
}

function markExtrasError(message) {
  if (!currentItinerary) return;
  currentItinerary._extrasError = message;
  delete currentItinerary._loadingExtras;
  rebuildSidebar(currentItinerary);
  // Save even when extras failed — the core itinerary is still
  // useful and the user may want to re-open it later.
  persistTripIfPossible(currentItinerary);
}

// Retry the /extras call using the original form payload.
function retryExtras() {
  if (!lastTripRequest || !currentItinerary) return;
  delete currentItinerary._extrasError;
  currentItinerary._loadingExtras = true;
  rebuildSidebar(currentItinerary);

  fetchJSON('/api/itinerary/extras', lastTripRequest)
    .then(({ ok, body }) => {
      if (!ok || body?.error) {
        markExtrasError((body && body.error) || 'Still couldn’t load extras.');
        return;
      }
      applyExtras(body.extras);
    })
    .catch(err => markExtrasError(err?.message || 'Network error.'));
}

// Replace just the supporting cards and checklist — preserves the user's
// day selection and any other main-pane state.
function rebuildSidebar(itinerary) {
  const grid = document.querySelector('.results-grid');
  if (!grid) return;
  document.querySelector('.supporting-cards-section')?.remove();
  const section = buildSupportingCardsSection(itinerary);
  if (section) grid.insertAdjacentElement('afterend', section);
  rebuildActionItemsSection(itinerary);
}

function rebuildActionItemsSection(itinerary) {
  const grid = document.querySelector('.results-grid');
  if (!grid) return;
  document.querySelector('.action-items-section')?.remove();
  const section = buildActionItemsSection(itinerary);
  const anchor = document.querySelector('.supporting-cards-section') || grid;
  if (section) anchor.insertAdjacentElement('afterend', section);
}

async function enrichPlacesForCurrentItinerary() {
  if (!currentItinerary?.days?.length || !window.google?.maps?.places) return;

  const requestId = ++placeEnrichmentRequestId;
  const activeDayIndex = getActiveDayIndex();
  const enriched = structuredClone(currentItinerary);
  const lookups = [];

  (enriched.days || []).forEach((day) => {
    (day.activities || []).forEach((act) => {
      lookups.push(enrichActivityPlace(act, day, enriched.trip || {}));
    });
  });

  try {
    await Promise.allSettled(lookups);
    if (requestId !== placeEnrichmentRequestId) return;

    const merged = {
      ...currentItinerary,
      trip: enriched.trip || currentItinerary.trip,
      days: enriched.days || currentItinerary.days,
      weather_note: enriched.weather_note || currentItinerary.weather_note,
    };

    renderResults(merged);
    setActiveDay(Math.min(activeDayIndex, (merged.days?.length || 1) - 1));
    if (currentItinerary?._tripId && currentItinerary._tripId !== 'pending') {
      updateSavedTripIfPossible(currentItinerary);
    }
  } catch {
    // Places enrichment is best-effort; the generated itinerary remains usable.
  }
}

function textSimilarity(a = '', b = '') {
  const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aWords = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const bWords = new Set(normalize(b).split(/\s+/).filter(Boolean));
  if (!aWords.size || !bWords.size) return 0;
  const overlap = [...aWords].filter(w => bWords.has(w)).length;
  return overlap / Math.max(aWords.size, bWords.size);
}

function getPlacesService() {
  if (!placesService && window.google?.maps?.places) {
    placesService = new google.maps.places.PlacesService(document.createElement('div'));
  }
  return placesService;
}

function getAutocompleteService() {
  if (!autocompleteService && window.google?.maps?.places) {
    autocompleteService = new google.maps.places.AutocompleteService();
  }
  return autocompleteService;
}

async function validateDestinationLegs(legs) {
  if (!window.google?.maps?.places) {
    return legs.map(leg => ({
      ...leg,
      rawDestination: leg.destination,
      destination: formatDestinationFallback(leg.destination),
    }));
  }

  const resolved = [];
  for (const leg of legs) {
    const candidates = await findDestinationCandidates(leg.destination);
    if (!candidates.length) {
      throw new Error(`Couldn’t find "${leg.destination}" as a travel destination. Try a city, region, state, country, or a more specific place name.`);
    }

    const choice = shouldAskDestinationClarification(leg.destination, candidates)
      ? await askDestinationChoice(leg.destination, candidates)
      : candidates[0];

    if (!choice) throw new Error('Destination validation was cancelled.');

    resolved.push({
      ...leg,
      rawDestination: leg.destination,
      destination: destinationDisplayName(choice),
      place_id: choice.place_id || null,
      coordinates: choice.geometry?.location
        ? { lat: choice.geometry.location.lat(), lng: choice.geometry.location.lng() }
        : null,
    });
  }

  syncResolvedLegInputs(resolved);
  return resolved;
}

async function findDestinationCandidates(query) {
  const autocompleteCandidates = await findAutocompleteDestinationCandidates(query);
  if (autocompleteCandidates.length) return autocompleteCandidates;

  const service = getPlacesService();
  if (!service || !query) return Promise.resolve([]);

  return new Promise((resolve) => {
    service.textSearch({ query }, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.length) {
        resolve([]);
        return;
      }

      resolve(results
        .filter(isLikelyDestinationPlace)
        .slice(0, 4));
    });
  });
}

function findAutocompleteDestinationCandidates(query) {
  const service = getAutocompleteService();
  if (!service || !query) return Promise.resolve([]);

  return new Promise((resolve) => {
    service.getPlacePredictions({
      input: query,
      types: ['(regions)'],
    }, async (predictions, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !predictions?.length) {
        resolve([]);
        return;
      }

      const details = await Promise.all(predictions.slice(0, 5).map(prediction =>
        getPlaceDetails(prediction.place_id)
      ));
      resolve(details.filter(Boolean));
    });
  });
}

function getPlaceDetails(placeId) {
  const service = getPlacesService();
  if (!service || !placeId) return Promise.resolve(null);

  return new Promise((resolve) => {
    service.getDetails({
      placeId,
      fields: ['place_id', 'name', 'formatted_address', 'geometry', 'types'],
    }, (place, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !place) {
        resolve(null);
        return;
      }
      resolve(place);
    });
  });
}

function isLikelyDestinationPlace(place) {
  const types = place.types || [];
  if (types.some(type => [
    'establishment',
    'store',
    'restaurant',
    'food',
    'bar',
    'cafe',
    'lodging',
  ].includes(type))) {
    return false;
  }

  return types.some(type => [
    'locality',
    'administrative_area_level_1',
    'administrative_area_level_2',
    'administrative_area_level_3',
    'country',
    'natural_feature',
    'park',
    'political',
  ].includes(type));
}

function shouldAskDestinationClarification(raw, candidates) {
  if (candidates.length < 2) return false;
  if (isBareDestinationName(raw) && hasMultipleLikelyLocations(candidates)) return true;
  const scores = candidates.slice(0, 3).map(candidate => textSimilarity(raw, candidate.name || destinationDisplayName(candidate)));
  const top = scores[0] || 0;
  const second = scores[1] || 0;
  if (top >= 0.85 && second < 0.85) return false;
  return second >= top - 0.2;
}

function isBareDestinationName(raw) {
  const cleaned = String(raw).trim();
  return cleaned && !/[,/]/.test(cleaned) && cleaned.split(/\s+/).length <= 2;
}

function hasMultipleLikelyLocations(candidates) {
  const names = new Set(candidates.slice(0, 4).map(candidate => destinationDisplayName(candidate)));
  return names.size > 1;
}

function destinationDisplayName(place) {
  return place.formatted_address || place.name || '';
}

function formatDestinationFallback(destination) {
  return destination
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(word => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(' ');
}

function syncResolvedLegInputs(legs) {
  const rows = legsList.querySelectorAll('.leg-row');
  legs.forEach((leg, idx) => {
    const input = rows[idx]?.querySelector('.leg-destination');
    if (input && leg.destination) input.value = leg.destination;
  });
}

function askDestinationChoice(rawDestination, candidates) {
  return new Promise((resolve) => {
    const overlay = el('div', 'destination-dialog-overlay');
    const dialog = el('div', 'destination-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'destination-dialog-title');

    const title = el('h3', 'destination-dialog-title');
    title.id = 'destination-dialog-title';
    title.textContent = 'Which destination did you mean?';
    dialog.appendChild(title);

    const copy = el('p', 'destination-dialog-copy');
    copy.textContent = `Atlas found a few matches for "${rawDestination}". Pick one before planning.`;
    dialog.appendChild(copy);

    const list = el('div', 'destination-choice-list');
    candidates.slice(0, 3).forEach(candidate => {
      const btn = el('button', 'destination-choice');
      btn.type = 'button';
      const name = el('span', 'destination-choice-name');
      name.textContent = candidate.name || destinationDisplayName(candidate);
      const address = el('span', 'destination-choice-address');
      address.textContent = candidate.formatted_address || '';
      btn.append(name, address);
      btn.addEventListener('click', () => close(candidate));
      list.appendChild(btn);
    });
    dialog.appendChild(list);

    const actions = el('div', 'destination-dialog-actions');
    const cancel = el('button', 'destination-dialog-cancel');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    actions.appendChild(cancel);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (value) => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') close(null);
    };
    cancel.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKeydown);
    list.querySelector('button')?.focus();
  });
}

function placeSearchText(act, day, trip) {
  return [
    cleanPlaceName(act?.name),
    act?.address,
    day?.destination,
    trip?.destination,
  ].filter(Boolean).join(' ');
}

function cleanPlaceName(name = '') {
  return String(name)
    .replace(/^(breakfast|brunch|lunch|dinner|coffee|drinks|snack)\s+(at|in)\s+/i, '')
    .replace(/^(visit|explore|tour|stop at|reserve)\s+/i, '')
    .trim();
}

function googleMapsPlaceUrl(placeId) {
  return placeId
    ? `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${encodeURIComponent(placeId)}`
    : null;
}

function findPlaceFromQuery(query, center) {
  const service = getPlacesService();
  if (!service || !query) return Promise.resolve(null);

  const request = {
    query,
    fields: ['place_id', 'name', 'formatted_address', 'geometry', 'rating', 'user_ratings_total', 'business_status', 'photos'],
  };
  if (center) {
    request.locationBias = {
      center: new google.maps.LatLng(center.lat, center.lng),
      radius: MAX_PLACE_MATCH_DISTANCE_KM * 1000,
    };
  }

  return new Promise((resolve) => {
    service.findPlaceFromQuery(request, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results?.[0]) {
        resolve(null);
        return;
      }
      resolve(results[0]);
    });
  });
}

async function enrichActivityPlace(act, day, trip) {
  if (!act?.name || act.category === 'transport') return;

  const expectedCenter = getExpectedDayCenter(day, trip);
  const result = await findPlaceFromQuery(placeSearchText(act, day, trip), expectedCenter);
  if (!result) {
    act.place_validation = { status: 'unverified' };
    clearEnrichedPlaceFields(act);
    return;
  }

  const score = textSimilarity(act.name, result.name);
  const location = result.geometry?.location;
  const resultCoords = location ? { lat: location.lat(), lng: location.lng() } : null;
  const distanceKm = expectedCenter && resultCoords
    ? distanceKmBetween(expectedCenter, resultCoords)
    : null;
  const isTooFar = distanceKm !== null && distanceKm > MAX_PLACE_MATCH_DISTANCE_KM;
  const status =
    isTooFar ? 'unverified' :
    score >= 0.45 ? 'validated' :
    score >= 0.25 ? 'ambiguous' :
    'unverified';
  const placeId = result.place_id || null;
  const photoUrl = getPlacePhotoUrl(result);

  act.place_validation = {
    status,
    score,
    distance_km: distanceKm,
    place_id: placeId,
    matched_name: result.name || null,
    formatted_address: result.formatted_address || null,
    rating: result.rating ?? null,
    user_ratings_total: result.user_ratings_total ?? null,
    google_maps_url: googleMapsPlaceUrl(placeId),
    photo_url: photoUrl,
    business_status: result.business_status || null,
  };

  if (status === 'unverified') {
    clearEnrichedPlaceFields(act);
    return;
  }

  if (placeId) act.place_id = placeId;
  if (result.formatted_address) act.address = result.formatted_address;
  if (resultCoords) act.coordinates = resultCoords;
  if (result.rating !== undefined) act.rating = result.rating;
  if (result.user_ratings_total !== undefined) act.user_ratings_total = result.user_ratings_total;
  if (placeId) act.google_maps_url = googleMapsPlaceUrl(placeId);
  if (photoUrl) act.photo_url = photoUrl;
}

function clearEnrichedPlaceFields(act) {
  delete act.place_id;
  delete act.google_maps_url;
  delete act.rating;
  delete act.user_ratings_total;
  delete act.photo_url;
}

function getPlacePhotoUrl(place) {
  const photo = Array.isArray(place?.photos) ? place.photos[0] : null;
  if (!photo || typeof photo.getUrl !== 'function') return null;
  try {
    return photo.getUrl({ maxWidth: 320, maxHeight: 240 }) || null;
  } catch {
    return null;
  }
}

function getExpectedDayCenter(day, trip) {
  const legs = Array.isArray(trip?.legs) ? trip.legs : [];
  const matchingLeg = legs.find(leg => leg.destination === day?.destination && isCoordinate(leg.coordinates));
  if (matchingLeg) return matchingLeg.coordinates;
  if (isCoordinate(trip?.destination_coordinates)) return trip.destination_coordinates;
  const anyLeg = legs.find(leg => isCoordinate(leg.coordinates));
  return anyLeg?.coordinates || null;
}

function isCoordinate(coords) {
  return Number.isFinite(Number(coords?.lat)) && Number.isFinite(Number(coords?.lng));
}

function distanceKmBetween(a, b) {
  const toRad = deg => Number(deg) * Math.PI / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function showError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
  formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ═══════════════════════════════════════════════
//  NAV BUTTONS
// ═══════════════════════════════════════════════
document.getElementById('new-trip-btn').addEventListener('click', () => {
  returnHome();
});

document.getElementById('atlas-home-btn').addEventListener('click', () => {
  returnHome();
});

function returnHome() {
  revisionHistory = [];
  placeEnrichmentRequestId++;
  currentItinerary = null;
  // Always return to root so a /share/:id URL doesn't linger when
  // the user starts a fresh trip.
  history.replaceState(null, '', '/');
  showView('form');
  // Refresh the count in case the user just saved a new trip
  // before navigating back.
  refreshMyTripsButton();
}

document.getElementById('my-trips-btn').addEventListener('click', () => {
  openMyTripsDialog();
});

document.getElementById('share-btn').addEventListener('click', () => {
  if (currentItinerary) shareItinerary(currentItinerary);
});

document.getElementById('calendar-btn').addEventListener('click', () => {
  if (currentItinerary) downloadICS(currentItinerary);
  else showToast('Generate an itinerary before downloading a calendar.');
});

document.getElementById('print-btn').addEventListener('click', () => {
  openPrintDialog();
});

// ═══════════════════════════════════════════════
//  MY TRIPS DIALOG
// ═══════════════════════════════════════════════
function openMyTripsDialog() {
  const overlay = el('div', 'my-trips-overlay');
  const dialog = el('div', 'my-trips-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'my-trips-title');

  const header = el('div', 'my-trips-header');
  const title = el('h3', 'my-trips-title');
  title.id = 'my-trips-title';
  title.textContent = 'My Trips';
  const closeX = el('button', 'my-trips-close');
  closeX.type = 'button';
  closeX.setAttribute('aria-label', 'Close');
  closeX.textContent = '×';
  header.append(title, closeX);
  dialog.appendChild(header);

  const copy = el('p', 'my-trips-copy');
  copy.textContent = 'Trips saved from this browser. Open one to view or re-share it.';
  dialog.appendChild(copy);

  const list = el('div', 'my-trips-list');
  list.setAttribute('aria-live', 'polite');
  const loading = el('div', 'my-trips-empty');
  loading.textContent = 'Loading…';
  list.appendChild(loading);
  dialog.appendChild(list);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  };
  const onKeydown = (e) => { if (e.key === 'Escape') close(); };
  closeX.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKeydown);
  closeX.focus();

  // Fetch + render
  fetchMyTrips().then(({ trips, unavailable }) => {
    list.innerHTML = '';
    if (unavailable) {
      const empty = el('div', 'my-trips-empty');
      empty.textContent = "Saving isn't set up yet. Once a database is connected, your trips will appear here.";
      list.appendChild(empty);
      return;
    }
    if (trips.length === 0) {
      const empty = el('div', 'my-trips-empty');
      empty.textContent = "You haven't saved any trips yet. Generate one and it'll show up here.";
      list.appendChild(empty);
      return;
    }
    trips.forEach(trip => list.appendChild(buildMyTripsRow(trip, close)));
  }).catch(() => {
    list.innerHTML = '';
    const err = el('div', 'my-trips-empty');
    err.textContent = "Couldn't load your trips. Try again in a moment.";
    list.appendChild(err);
  });
}

function buildMyTripsRow(trip, closeDialog) {
  const row = el('div', 'my-trips-row');
  row.dataset.tripId = trip.id;

  const main = el('div', 'my-trips-row-main');
  const t = el('div', 'my-trips-row-title');
  t.textContent = trip.title || trip.destination || 'Untitled trip';
  const meta = el('div', 'my-trips-row-meta');
  meta.textContent = formatTripDateRange(trip);
  main.append(t, meta);

  const actions = el('div', 'my-trips-row-actions');
  const openBtn = el('button', 'my-trips-open');
  openBtn.type = 'button';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => {
    closeDialog();
    // Use a real navigation so the page goes through
    // checkForSharedItinerary() on load and fetches fresh data.
    location.assign(`/share/${trip.id}`);
  });

  const delBtn = el('button', 'my-trips-delete');
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', `Delete ${trip.title || 'trip'}`);
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${trip.title || 'this trip'}"? This can't be undone.`)) return;
    delBtn.disabled = true;
    openBtn.disabled = true;
    const ok = await deleteSavedTrip(trip.id);
    if (!ok) {
      delBtn.disabled = false;
      openBtn.disabled = false;
      showToast("Couldn't delete that trip — try again.");
      return;
    }
    row.style.opacity = '0';
    setTimeout(() => {
      row.remove();
      const remaining = row.parentElement?.querySelectorAll('.my-trips-row').length || 0;
      if (remaining === 0) {
        const empty = el('div', 'my-trips-empty');
        empty.textContent = "You haven't saved any trips yet. Generate one and it'll show up here.";
        row.parentElement?.appendChild(empty);
      }
      refreshMyTripsButton();
    }, 150);
  });

  actions.append(openBtn, delBtn);
  row.append(main, actions);
  return row;
}

function formatTripDateRange(trip) {
  const parts = [];
  if (trip.destination && trip.destination !== trip.title) parts.push(trip.destination);
  if (trip.startDate && trip.endDate) {
    parts.push(`${trip.startDate} → ${trip.endDate}`);
  } else if (trip.durationDays) {
    parts.push(`${trip.durationDays} days`);
  }
  if (trip.createdAt) {
    const d = new Date(trip.createdAt);
    if (!isNaN(d)) parts.push(`saved ${d.toLocaleDateString()}`);
  }
  return parts.join(' · ');
}

function openPrintDialog() {
  if (!currentItinerary) {
    showToast('Generate an itinerary before printing.');
    return;
  }

  const overlay = el('div', 'print-dialog-overlay');
  const dialog = el('div', 'print-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'print-dialog-title');

  const title = el('h3', 'print-dialog-title');
  title.id = 'print-dialog-title';
  title.textContent = 'Print Pack';
  dialog.appendChild(title);

  const copy = el('p', 'print-dialog-copy');
  copy.textContent = 'Choose which days to include in a cleaner printable itinerary.';
  dialog.appendChild(copy);

  const scope = el('fieldset', 'print-dialog-fieldset');
  const scopeLegend = document.createElement('legend');
  scopeLegend.textContent = 'Days';
  scope.appendChild(scopeLegend);
  scope.appendChild(printOption('radio', 'print-days', 'all', 'All days', true));
  scope.appendChild(printOption('radio', 'print-days', 'selected', `Selected day only`, false));
  scope.appendChild(printOption('radio', 'print-days', 'range', 'Day range', false));
  const range = el('div', 'print-range-fields');
  const from = printNumberField('print-range-start', 'From', 1, currentItinerary.days?.length || 1, 1);
  const to = printNumberField('print-range-end', 'To', 1, currentItinerary.days?.length || 1, currentItinerary.days?.length || 1);
  range.append(from, to);
  scope.appendChild(range);
  dialog.appendChild(scope);

  const actions = el('div', 'print-dialog-actions');
  const cancel = el('button', 'print-dialog-cancel');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const submit = el('button', 'print-dialog-submit');
  submit.type = 'button';
  submit.textContent = 'Print';
  actions.append(cancel, submit);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') close();
  };
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  submit.addEventListener('click', () => {
    const days = dialog.querySelector('input[name="print-days"]:checked')?.value || 'all';
    const rangeStart = parseInt(dialog.querySelector('#print-range-start')?.value, 10);
    const rangeEnd = parseInt(dialog.querySelector('#print-range-end')?.value, 10);
    close();
    printPack({ days, rangeStart, rangeEnd });
  });
  document.addEventListener('keydown', onKeydown);
  submit.focus();
}

function printNumberField(id, labelText, min, max, value) {
  const label = el('label', 'print-range-field');
  const text = el('span', '');
  text.textContent = labelText;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  label.append(text, input);
  return label;
}

function printOption(type, name, value, labelText, checked) {
  const label = el('label', 'print-dialog-option');
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  const text = el('span', '');
  text.textContent = labelText;
  label.append(input, text);
  return label;
}

function printPack({ days, rangeStart, rangeEnd }) {
  if (isTopThreeTrip()) days = 'all';
  applyPrintDayScope(days, rangeStart, rangeEnd);
  const classes = [
    'print-pack',
    days === 'selected' ? 'print-selected-day' : days === 'range' ? 'print-day-range' : 'print-all-days',
  ];
  document.body.classList.add(...classes);

  const cleanup = () => {
    document.body.classList.remove(...classes);
    clearPrintDayScope();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  setTimeout(cleanup, 1000);
}

function applyPrintDayScope(days, rangeStart, rangeEnd) {
  const cards = document.querySelectorAll('.day-cards-wrap .day-card');
  if (!cards.length) return;

  let start = 0;
  let end = cards.length - 1;
  if (days === 'selected') {
    start = getActiveDayIndex();
    end = start;
  } else if (days === 'range') {
    const max = cards.length;
    const first = Math.min(Math.max(Number.isFinite(rangeStart) ? rangeStart : 1, 1), max);
    const last = Math.min(Math.max(Number.isFinite(rangeEnd) ? rangeEnd : max, 1), max);
    start = Math.min(first, last) - 1;
    end = Math.max(first, last) - 1;
  }

  cards.forEach((card, idx) => {
    card.classList.toggle('print-out-of-range', idx < start || idx > end);
  });
}

function clearPrintDayScope() {
  document.querySelectorAll('.print-out-of-range').forEach(el => {
    el.classList.remove('print-out-of-range');
  });
}

// ═══════════════════════════════════════════════
//  RENDER RESULTS
// ═══════════════════════════════════════════════
function renderResults(itinerary) {
  itinerary = normalizeTopThreeItinerary(itinerary);
  currentItinerary = itinerary;

  const container = document.getElementById('results-content');

  // Preserve the live map DOM node across re-renders so Google Maps doesn't
  // error when enrichPlacesForCurrentItinerary triggers a second render.
  // Removing the atlas-map element while Google Maps holds a reference to it
  // causes a detached-container error and the "loads briefly then errors" flash.
  const prevMap = atlasMap;
  const prevMapInfoWindow = atlasMapInfoWindow;
  let savedMapSection = null;
  if (prevMap && mapsReady && mapsKey) {
    savedMapSection = container.querySelector('.map-section');
    if (savedMapSection) savedMapSection.remove(); // detach before innerHTML clear
  }
  atlasMapOverlays.forEach(o => o.setMap(null));
  atlasMapOverlays = [];
  atlasMap = null;
  atlasMapInfoWindow = null;
  container.innerHTML = '';
  if (savedMapSection) {
    atlasMap = prevMap;
    atlasMapInfoWindow = prevMapInfoWindow;
  }

  // Trip banner
  container.appendChild(buildTripBanner(itinerary.trip, itinerary.weather_note));
  container.appendChild(buildTripOverviewCard(itinerary));

  // Map section (inserted before the grid if Maps is ready)
  if (mapsReady && mapsKey) {
    container.appendChild(savedMapSection || buildMapSection(itinerary));
  }

  // Main grid
  const grid = el('div', 'results-grid');
  const main = el('div', 'main-content');

  const days = itinerary.days || [];

  // Day selector — only show if there's more than one day
  if (days.length > 1 && !isTopThreeTrip()) {
    main.appendChild(buildDaySelector(days));
  }

  // Day cards — all are rendered, but only the active one is visible
  const dayCardsWrap = el('div', 'day-cards-wrap');
  days.forEach((day, idx) => {
    const card = buildDayCard(day, idx);
    card.dataset.dayIndex = String(idx);
    if (days.length > 1 && idx !== 0 && !isTopThreeTrip()) card.classList.add('day-card-hidden');
    dayCardsWrap.appendChild(card);
  });
  main.appendChild(dayCardsWrap);

  grid.appendChild(main);
  container.appendChild(grid);
  const supportingCardsSection = buildSupportingCardsSection(itinerary);
  if (supportingCardsSection) container.appendChild(supportingCardsSection);
  const actionItemsSection = buildActionItemsSection(itinerary);
  if (actionItemsSection) container.appendChild(actionItemsSection);

  // Init map after DOM is ready (or just refresh pins if the map was preserved)
  if (mapsReady && mapsKey) {
    requestAnimationFrame(() => atlasMap ? renderMapPins(itinerary) : initMap(itinerary));
  }
}

function normalizeTopThreeItinerary(itinerary) {
  if (!(isTopThreeTrip() || itinerary?._tripStyle === 'top3') || !Array.isArray(itinerary?.days)) {
    return itinerary;
  }

  const activities = itinerary.days.flatMap(day => day.activities || []).slice(0, 3);
  if (activities.length <= 1) return itinerary;

  const firstDay = itinerary.days[0] || {};
  return {
    ...itinerary,
    days: [{
      ...firstDay,
      day_number: 1,
      date_label: 'Top 3 Must-Sees',
      theme: 'Trip-wide shortlist',
      destination: firstDay.destination || itinerary.trip?.destination || '',
      activities,
    }],
  };
}

function normalizeTopThreeDay(day) {
  if (!isTopThreeTrip() || !day) return day;
  return {
    ...day,
    day_number: 1,
    date_label: 'Top 3 Must-Sees',
    theme: 'Trip-wide shortlist',
    activities: Array.isArray(day.activities) ? day.activities.slice(0, 3) : [],
  };
}

// ── Trip Banner ────────────────────────────────
function buildTripBanner(trip, weatherNote) {
  const banner = el('div', 'trip-banner');

  const legs = Array.isArray(trip.legs) ? trip.legs.filter(l => l?.destination) : [];
  const isMultiCity = legs.length > 1;

  const dest = el('h1', 'trip-destination');
  dest.textContent = isMultiCity
    ? legs.map(l => l.destination).join(' → ')
    : (trip.destination || legs[0]?.destination || 'Your Trip');
  banner.appendChild(dest);

  // City pills with date ranges (multi-city only)
  if (isMultiCity) {
    const chain = el('div', 'trip-cities');
    legs.forEach((leg, i) => {
      const pill = el('span', 'trip-city-pill');
      const range = formatDateRange(leg.startDate, leg.endDate);
      pill.textContent = range ? `${leg.destination} · ${range}` : leg.destination;
      chain.appendChild(pill);
      if (i < legs.length - 1) {
        const arrow = el('span', 'trip-city-arrow');
        arrow.textContent = '→';
        chain.appendChild(arrow);
      }
    });
    banner.appendChild(chain);
  }

  const meta = el('div', 'trip-meta');
  if (trip.startDate || trip.endDate) meta.appendChild(metaSpan(formatDateRange(trip.startDate, trip.endDate)));
  if (trip.duration_days)             meta.appendChild(metaSpan(`${trip.duration_days} day${trip.duration_days !== 1 ? 's' : ''}`));
  if (trip.travelers)                 meta.appendChild(metaSpan(trip.travelers));
  banner.appendChild(meta);

  if (weatherNote) {
    const wn = el('p', 'weather-note');
    wn.textContent = weatherNote;
    banner.appendChild(wn);
  }

  return banner;
}

function buildTripOverviewCard(itinerary) {
  const trip = itinerary.trip || {};
  const days = itinerary.days || [];
  const activities = days.flatMap(day => day.activities || []);
  const actionItems = itinerary.action_items || [];
  const verifiedCount = activities.filter(act => act.place_validation?.status === 'validated').length;
  const topHighlights = activities
    .filter(act => act.category !== 'transport' && act.name)
    .slice(0, 3);

  const card = el('section', 'trip-overview-card');

  const header = el('div', 'trip-overview-header');
  const label = el('p', 'trip-overview-label');
  label.textContent = 'Trip overview';
  header.appendChild(label);
  card.appendChild(header);

  const stats = el('div', 'trip-overview-stats');
  [
    ['Dates', formatDateRange(trip.startDate, trip.endDate) || 'Flexible'],
    ['Pace', getPaceLabel(days, activities)],
    ['Stops', getStopLabel(trip, days)],
    ['Checklist', actionItems.length ? `${actionItems.length} to-do${actionItems.length === 1 ? '' : 's'}` : 'Loading'],
  ].forEach(([labelText, value]) => {
    const item = el('div', 'trip-overview-stat');
    const statLabel = el('span', 'trip-overview-stat-label');
    statLabel.textContent = labelText;
    const statValue = el('span', 'trip-overview-stat-value');
    statValue.textContent = value;
    item.append(statLabel, statValue);
    stats.appendChild(item);
  });
  card.appendChild(stats);

  if (topHighlights.length) {
    const highlights = el('div', 'trip-overview-highlights');
    const highlightsLabel = el('p', 'trip-overview-section-label');
    highlightsLabel.textContent = 'Top highlights';
    highlights.appendChild(highlightsLabel);

    const list = el('ul', 'trip-overview-highlight-list');
    topHighlights.forEach(act => {
      const item = document.createElement('li');
      item.textContent = act.name;
      list.appendChild(item);
    });
    highlights.appendChild(list);
    card.appendChild(highlights);
  }

  const status = el('p', 'trip-overview-status');
  const statusParts = [];
  if (verifiedCount) statusParts.push(`${verifiedCount} place${verifiedCount === 1 ? '' : 's'} verified`);
  if (itinerary.accommodation?.top_pick?.name) statusParts.push(`hotel pick: ${itinerary.accommodation.top_pick.name}`);
  if (itinerary._loadingExtras) statusParts.push('trip details loading');
  status.textContent = statusParts.length
    ? statusParts.join(' · ')
    : 'Atlas will keep tightening links and details as results load.';
  card.appendChild(status);

  return card;
}

function getPaceLabel(days, activities) {
  if (!days.length) return 'Flexible';
  const avg = activities.length / days.length;
  if (avg >= 5) return 'Structured';
  if (avg >= 3) return 'Balanced';
  return 'Relaxed';
}

function getStopLabel(trip, days) {
  const legs = Array.isArray(trip.legs) ? trip.legs.filter(l => l?.destination) : [];
  if (legs.length > 1) return `${legs.length} cities`;
  const cities = new Set(days.map(day => day.destination).filter(Boolean));
  if (cities.size > 1) return `${cities.size} cities`;
  return legs[0]?.destination || trip.destination || '1 destination';
}

// ── Day Selector (multi-day nav) ───────────────
function buildDaySelector(days) {
  const wrap = el('div', 'day-selector');

  const prev = el('button', 'day-nav-arrow day-nav-prev');
  prev.type = 'button';
  prev.setAttribute('aria-label', 'Previous day');
  prev.textContent = '‹';
  prev.disabled = true; // starts on day 0
  wrap.appendChild(prev);

  const chipsWrap = el('div', 'day-selector-chips');
  chipsWrap.setAttribute('role', 'tablist');
  chipsWrap.setAttribute('aria-label', 'Trip days');

  // Detect multi-city by inspecting unique destinations across days
  const cities = [...new Set(days.map(d => d.destination).filter(Boolean))];
  const isMultiCity = cities.length > 1;

  let lastCity = null;
  days.forEach((day, idx) => {
    const city = day.destination || '';
    const isFirstOfCity = isMultiCity && city && city !== lastCity;

    const chip = el('button', 'day-chip' + (idx === 0 ? ' active' : '') + (isFirstOfCity ? ' first-of-city' : ''));
    chip.type = 'button';
    chip.dataset.dayIndex = String(idx);
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');

    const num = el('span', 'day-chip-num');
    num.textContent = `Day ${day.day_number || idx + 1}`;
    chip.appendChild(num);

    // Multi-city: show city under day number. Single-city: show theme.
    if (isMultiCity && city) {
      const cityEl = el('span', 'day-chip-city');
      cityEl.textContent = city;
      chip.appendChild(cityEl);
    } else if (day.theme) {
      const theme = el('span', 'day-chip-theme');
      theme.textContent = day.theme;
      chip.appendChild(theme);
    }

    chip.addEventListener('click', () => setActiveDay(idx));
    chipsWrap.appendChild(chip);
    lastCity = city;
  });
  wrap.appendChild(chipsWrap);

  const next = el('button', 'day-nav-arrow day-nav-next');
  next.type = 'button';
  next.setAttribute('aria-label', 'Next day');
  next.textContent = '›';
  next.disabled = days.length <= 1;
  wrap.appendChild(next);

  prev.addEventListener('click', () => {
    const active = wrap.querySelector('.day-chip.active');
    const idx = active ? parseInt(active.dataset.dayIndex, 10) : 0;
    if (idx > 0) setActiveDay(idx - 1);
  });
  next.addEventListener('click', () => {
    const active = wrap.querySelector('.day-chip.active');
    const idx = active ? parseInt(active.dataset.dayIndex, 10) : 0;
    if (idx < days.length - 1) setActiveDay(idx + 1);
  });

  return wrap;
}

function setActiveDay(idx) {
  const chips = document.querySelectorAll('.day-selector .day-chip');
  const cards = document.querySelectorAll('.day-cards-wrap .day-card');
  const prev  = document.querySelector('.day-nav-prev');
  const next  = document.querySelector('.day-nav-next');

  chips.forEach((c, i) => {
    const isActive = i === idx;
    c.classList.toggle('active', isActive);
    c.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) c.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  });

  cards.forEach((card, i) => {
    card.classList.toggle('day-card-hidden', i !== idx);
  });

  if (prev) prev.disabled = idx === 0;
  if (next) next.disabled = idx === cards.length - 1;
  if (mapViewMode === 'selected' && currentItinerary) renderMapPins(currentItinerary);
}

// ── Day Cards ──────────────────────────────────
function buildDayCard(day, dayIdx) {
  const card = el('div', 'day-card');

  // Multi-city check (look at sibling days in the rendered itinerary)
  const allDays = currentItinerary?.days || [];
  const cities  = [...new Set(allDays.map(d => d.destination).filter(Boolean))];
  const isMultiCity = cities.length > 1;

  const header = el('div', 'day-header');

  const left  = el('div', 'day-header-left');
  const label = el('div', 'day-label');
  label.textContent = isTopThreeTrip()
    ? 'Top 3 Must-Sees'
    : (day.date_label || `Day ${day.day_number}`);
  left.appendChild(label);

  if (isMultiCity && day.destination) {
    const tag = el('span', 'day-destination-tag');
    tag.textContent = day.destination;
    left.appendChild(tag);
  }
  header.appendChild(left);

  const headerRight = el('div', 'day-header-right');
  const regenBtn = el('button', 'day-regen-btn');
  regenBtn.type = 'button';
  regenBtn.title = isTopThreeTrip()
    ? 'Rebuild this shortlist with different picks'
    : 'Rebuild this day with different picks';
  regenBtn.textContent = isTopThreeTrip() ? 'Regenerate picks' : 'Regenerate day';
  regenBtn.addEventListener('click', () => handleRegenerateDay(dayIdx, regenBtn));
  headerRight.appendChild(regenBtn);
  header.appendChild(headerRight);

  card.appendChild(header);

  if (day.activities?.length) {
    const list = el('div', 'activities-list');
    day.activities.forEach((act, actIdx) =>
      list.appendChild(buildActivity(act, day, actIdx, dayIdx))
    );
    card.appendChild(list);
  }

  return card;
}

function buildActivity(act, day, actIdx, dayIdx) {
  const destination = currentItinerary?.trip?.destination || '';
  const item = el('div', isTopThreeTrip() ? 'activity-item top3-pick' : 'activity-item');
  if (Number.isInteger(actIdx)) item.dataset.actIdx = String(actIdx);
  if (Number.isInteger(dayIdx)) item.dataset.dayIdx = String(dayIdx);

  if (canOpenActivityOnMap(act, day)) {
    item.classList.add('activity-item-mappable');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Show ${act.name || 'this stop'} on the trip map`);
    item.title = 'Show on map';
    item.addEventListener('click', (event) => {
      if (event.target.closest('a, button')) return;
      openMapMarkerForActivity(dayIdx, actIdx);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target.closest('a, button')) return;
      event.preventDefault();
      openMapMarkerForActivity(dayIdx, actIdx);
    });
  }

  const time = el('div', 'activity-time');
  time.textContent = isTopThreeTrip() ? `Pick ${actIdx + 1}` : (act.time || '');
  item.appendChild(time);

  const dot = el('div', `activity-dot cat-${act.category || 'sightseeing'}`);
  dot.textContent = isTopThreeTrip() ? String(actIdx + 1) : categoryIcon(act.category);
  item.appendChild(dot);

  const body = el('div', 'activity-body');
  const hasPhoto = shouldShowActivityPhoto(act);
  if (hasPhoto) body.classList.add('has-photo');
  const copy = el('div', 'activity-copy');

  const name = el('p', 'activity-name');
  name.textContent = act.name || '';
  copy.appendChild(name);

  if (act.description) {
    const desc = el('p', 'activity-desc');
    desc.textContent = act.description;
    copy.appendChild(desc);
  }

  const meta = el('div', 'activity-meta');
  if (act.price_range) {
    const badge = el('span', 'badge badge-price');
    badge.textContent = act.price_range;
    meta.appendChild(badge);
  }
  if (act.place_validation?.status === 'validated') {
    const verified = el('span', 'badge badge-verified');
    verified.textContent = act.rating
      ? `Verified · ${act.rating}★`
      : 'Verified';
    meta.appendChild(verified);
  }
  // Always generate a real search/booking link
  const bookingUrl = buildBookingUrl(act, destination);
  const link = el('a', 'badge badge-link');
  link.href = bookingUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = act.google_maps_url && act.category !== 'accommodation' && act.place_validation?.status !== 'unverified' ? 'Open in Maps →' :
                     act.category === 'accommodation' ? 'Search hotels →' :
                     act.category === 'food'          ? 'Find & reserve →' :
                     act.category === 'transport'     ? 'Get directions →' : 'Search →';
  meta.appendChild(link);

  // Swap-this-activity button (only when we know which day/activity this is)
  if (Number.isInteger(actIdx) && Number.isInteger(dayIdx)) {
    const swapBtn = el('button', 'activity-swap-btn');
    swapBtn.type = 'button';
    swapBtn.title = 'Swap this activity for a different pick';
    swapBtn.textContent = 'Swap';
    swapBtn.addEventListener('click', () => handleSwapActivity(dayIdx, actIdx, swapBtn));
    meta.appendChild(swapBtn);
  }

  copy.appendChild(meta);

  if (act.travel_note) {
    const tn = el('p', 'travel-note');
    tn.textContent = act.travel_note;
    copy.appendChild(tn);
  }

  if (act.atlas_tip && shouldShowAtlasTip(dayIdx, actIdx)) {
    const tip = el('div', 'atlas-tip');
    tip.textContent = act.atlas_tip;
    copy.appendChild(tip);
  }

  body.appendChild(copy);
  if (hasPhoto) body.appendChild(buildActivityPhoto(act));
  item.appendChild(body);
  return item;
}

function shouldShowActivityPhoto(act) {
  return Boolean(
    act?.photo_url &&
    act?.place_validation?.status === 'validated' &&
    act.category !== 'transport'
  );
}

function buildActivityPhoto(act) {
  const img = el('img', 'activity-photo');
  img.src = act.photo_url;
  img.alt = act.name ? `${act.name} photo` : 'Place photo';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    img.remove();
  }, { once: true });
  return img;
}

// ── Targeted edits: regenerate one day, swap one activity ──
function getFormContext() {
  if (!lastTripRequest) return {};
  // Don't include legs — the day already carries its destination.
  const { legs: _legs, ...rest } = lastTripRequest;
  return rest;
}

function askForHint({ title, message, placeholder = '' }) {
  return new Promise((resolve) => {
    const overlay = el('div', 'hint-dialog-overlay');
    const dialog = el('div', 'hint-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'hint-dialog-title');

    const heading = el('h3', 'hint-dialog-title');
    heading.id = 'hint-dialog-title';
    heading.textContent = title;
    dialog.appendChild(heading);

    const copy = el('p', 'hint-dialog-copy');
    copy.textContent = message;
    dialog.appendChild(copy);

    const input = el('input', 'hint-dialog-input');
    input.type = 'text';
    input.placeholder = placeholder;
    dialog.appendChild(input);

    const actions = el('div', 'hint-dialog-actions');
    const cancel = el('button', 'hint-dialog-cancel');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const submit = el('button', 'hint-dialog-submit');
    submit.type = 'button';
    submit.textContent = 'Submit';
    actions.append(cancel, submit);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (value) => {
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter') close(input.value.trim());
    };

    cancel.addEventListener('click', () => close(null));
    submit.addEventListener('click', () => close(input.value.trim()));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKeydown);
    input.focus();
  });
}

async function handleRegenerateDay(dayIdx, btn) {
  const day = currentItinerary?.days?.[dayIdx];
  if (!day) { showToast('No day to regenerate.'); return; }

  const hint = await askForHint({
    title: isTopThreeTrip() ? 'Regenerate Top 3' : `Regenerate Day ${day.day_number}`,
    message: isTopThreeTrip()
      ? 'Add an optional note for Atlas, or submit blank for three fresh picks.'
      : 'Add an optional note for Atlas, or submit blank for fresh picks.',
    placeholder: isTopThreeTrip()
      ? 'More premium, more food-focused, less touristy...'
      : 'More outdoors, less packed, shorter day...',
  });
  if (hint === null) return; // user cancelled

  const cardEl = btn.closest('.day-card');
  if (!cardEl) return;

  cardEl.classList.add('day-regenerating');
  btn.disabled = true;

  try {
    const { ok, body } = await fetchJSON('/api/itinerary/regenerate-day', {
      trip: currentItinerary.trip,
      day,
      formContext: getFormContext(),
      hint: hint || '',
    });
    if (!ok || body?.error || !body?.day) {
      throw new Error(body?.error || 'Couldn’t regenerate this day.');
    }

    const newDay = normalizeTopThreeDay(body.day);

    // Update state
    currentItinerary.days[dayIdx] = newDay;

    // Build a fresh card and swap it in. Preserve hidden/visible state
    // so the active day stays active (if the user regen'd a hidden day,
    // it stays hidden; if it was visible, it stays visible).
    const wasHidden = cardEl.classList.contains('day-card-hidden');
    const newCard = buildDayCard(newDay, dayIdx);
    newCard.dataset.dayIndex = String(dayIdx);
    if (wasHidden) newCard.classList.add('day-card-hidden');
    cardEl.replaceWith(newCard);

    // If the day selector chip shows a theme (single-city), update it
    // so the chip text matches the regenerated theme.
    const chip = document.querySelector(`.day-chip[data-day-index="${dayIdx}"] .day-chip-theme`);
    if (chip && newDay.theme) chip.textContent = newDay.theme;

    showToast(isTopThreeTrip() ? 'Top 3 regenerated.' : `Day ${day.day_number} regenerated.`);
    persistTripIfPossible(currentItinerary);
    enrichPlacesForCurrentItinerary();
  } catch (err) {
    cardEl.classList.remove('day-regenerating');
    btn.disabled = false;
    showToast(err.message || 'Couldn’t regenerate — try again.');
  }
}

async function handleSwapActivity(dayIdx, actIdx, btn) {
  const day = currentItinerary?.days?.[dayIdx];
  const act = day?.activities?.[actIdx];
  if (!day || !act) { showToast('No activity to swap.'); return; }

  const hint = await askForHint({
    title: 'Swap activity',
    message: `Add an optional preference for replacing "${act.name}", or submit blank.`,
    placeholder: 'Cheaper, vegetarian, more casual...',
  });
  if (hint === null) return; // user cancelled

  const itemEl = btn.closest('.activity-item');
  if (!itemEl) return;

  const originalBtnText = btn.textContent;
  itemEl.classList.add('activity-swapping');
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Swapping…';

  try {
    const { ok, body } = await fetchJSON('/api/itinerary/swap-activity', {
      trip: currentItinerary.trip,
      day,
      activity: act,
      activityIndex: actIdx,
      formContext: getFormContext(),
      hint: hint || '',
    });
    if (!ok || body?.error || !body?.activity) {
      throw new Error(body?.error || 'Couldn’t swap this activity.');
    }

    // Update state
    currentItinerary.days[dayIdx].activities[actIdx] = body.activity;

    // Build a fresh activity row and swap it in.
    const newItem = buildActivity(body.activity, currentItinerary.days[dayIdx], actIdx, dayIdx);
    itemEl.replaceWith(newItem);

    showToast('Activity swapped.');
    persistTripIfPossible(currentItinerary);
    enrichPlacesForCurrentItinerary();
  } catch (err) {
    itemEl.classList.remove('activity-swapping');
    btn.disabled = false;
    btn.textContent = originalBtnText;
    showToast(err.message || 'Couldn’t swap — try again.');
  }
}

// ── Booking URL generator ──────────────────────
function buildBookingUrl(act, destination) {
  if (act.google_maps_url && act.category !== 'accommodation' && act.place_validation?.status !== 'unverified') {
    return act.google_maps_url;
  }

  const name = act.name || '';
  const dest = destination || '';
  const address = act.address || '';
  const q = (s) => encodeURIComponent(s);

  switch (act.category) {
    case 'accommodation':
      return `https://www.booking.com/search.html?ss=${q(name + ' ' + dest)}`;
    case 'food':
      return `https://www.google.com/search?q=${q(name + ' ' + dest)}`;
    case 'transport':
      return address
        ? `https://www.google.com/maps/dir/?api=1&destination=${q(address)}`
        : `https://www.google.com/search?q=${q(name + ' ' + dest)}`;
    default:
      return `https://www.google.com/search?q=${q(name + ' ' + dest)}`;
  }
}

// ═══════════════════════════════════════════════
//  GOOGLE MAPS
// ═══════════════════════════════════════════════
function buildMapSection(itinerary) {
  const section = el('div', 'map-section');

  const header = el('div', 'map-header');
  const title  = el('div', 'map-header-title');
  title.textContent = 'Trip Map';
  header.appendChild(title);

  if (isTopThreeTrip()) {
    const badge = el('div', 'map-mode-static');
    badge.textContent = 'Top 3 picks';
    header.appendChild(badge);
  } else {
    const controls = el('div', 'map-mode-toggle');
    const allBtn = el('button', 'map-mode-btn' + (mapViewMode === 'all' ? ' active' : ''));
    allBtn.type = 'button';
    allBtn.dataset.mapMode = 'all';
    allBtn.textContent = 'All days';
    const selectedBtn = el('button', 'map-mode-btn' + (mapViewMode === 'selected' ? ' active' : ''));
    selectedBtn.type = 'button';
    selectedBtn.dataset.mapMode = 'selected';
    selectedBtn.textContent = 'Selected day';
    controls.append(allBtn, selectedBtn);
    controls.addEventListener('click', (e) => {
      const btn = e.target.closest('.map-mode-btn');
      if (!btn) return;
      setMapViewMode(btn.dataset.mapMode);
    });
    header.appendChild(controls);
  }

  // Legend: one dot per day
  if (itinerary.days?.length) {
    const legend = el('div', 'map-legend');
    const legendItems = isTopThreeTrip() ? [{ day: itinerary.days[0], i: 0 }] : itinerary.days.map((day, i) => ({ day, i }));
    legendItems.forEach(({ day, i }) => {
      const item = el('div', 'map-legend-item');
      const dot  = el('div', 'map-legend-dot');
      dot.style.background = isTopThreeTrip() ? DAY_COLORS[0] : DAY_COLORS[i % DAY_COLORS.length];
      item.appendChild(dot);
      const lbl = document.createTextNode(isTopThreeTrip() ? 'Top 3' : `Day ${day.day_number}`);
      item.appendChild(lbl);
      legend.appendChild(item);
    });
    header.appendChild(legend);
  }

  section.appendChild(header);

  const mapEl = document.createElement('div');
  mapEl.id = 'atlas-map';
  section.appendChild(mapEl);

  const empty = el('p', 'map-empty-state hidden');
  empty.id = 'map-empty-state';
  empty.textContent = 'No mapped places for this view yet.';
  section.appendChild(empty);

  const coverage = el('p', 'map-coverage-status hidden');
  coverage.id = 'map-coverage-status';
  section.appendChild(coverage);

  return section;
}

function initMap(itinerary) {
  const mapEl = document.getElementById('atlas-map');
  if (!mapEl || !window.google?.maps) return;

  const center = itinerary.trip?.destination_coordinates || { lat: 20, lng: 0 };

  atlasMap = new google.maps.Map(mapEl, {
    center,
    zoom: 13,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_CENTER },
    styles: [
      { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
      { featureType: 'transit', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    ],
  });

  atlasMapInfoWindow = new google.maps.InfoWindow();
  renderMapPins(itinerary);
}

function renderMapPins(itinerary) {
  if (!atlasMap || !window.google?.maps) return;

  atlasMapOverlays.forEach(overlay => overlay.setMap(null));
  atlasMapOverlays = [];
  atlasMapMarkerLookup.clear();

  const bounds     = new google.maps.LatLngBounds();
  let hasMarkers   = false;
  let visibleCount  = 0;
  let expectedCount = 0;
  const activeIdx  = getActiveDayIndex();
  const daysToShow = mapViewMode === 'selected' && !isTopThreeTrip()
    ? (itinerary.days || []).map((day, dayIdx) => ({ day, dayIdx })).filter(({ dayIdx }) => dayIdx === activeIdx)
    : (itinerary.days || []).map((day, dayIdx) => ({ day, dayIdx }));

  daysToShow.forEach(({ day, dayIdx }) => {
    const color     = isTopThreeTrip() ? DAY_COLORS[0] : DAY_COLORS[dayIdx % DAY_COLORS.length];
    const positions = [];

    (day.activities || []).forEach((act, actIdx) => {
      if (act.category !== 'transport') expectedCount++;
      const { lat, lng } = act.coordinates || {};
      if (!lat || !lng) return;
      if (isMapCoordinateOutlier(act, day, itinerary.trip)) return;

      const pos = new google.maps.LatLng(lat, lng);
      bounds.extend(pos);
      positions.push(pos);
      hasMarkers = true;
      if (act.category !== 'transport') visibleCount++;

      const marker = new google.maps.Marker({
        position: pos,
        map: atlasMap,
        title: act.name,
        icon: makeMarkerIcon(color, actIdx + 1),
        zIndex: actIdx,
      });
      atlasMapOverlays.push(marker);
      atlasMapMarkerLookup.set(getActivityMapKey(dayIdx, actIdx), { marker, act, color });

      marker.addListener('click', () => openMapMarker({ marker, act, color }));
    });

    // Route line through the day
    if (positions.length > 1 && !isTopThreeTrip()) {
      const route = new google.maps.Polyline({
        path: positions,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.55,
        strokeWeight: 2.5,
        map: atlasMap,
      });
      atlasMapOverlays.push(route);
    }
  });

  if (hasMarkers) {
    document.getElementById('map-empty-state')?.classList.add('hidden');
    atlasMap.fitBounds(bounds);
    // Don't zoom in too close on single markers
    google.maps.event.addListenerOnce(atlasMap, 'idle', () => {
      if (atlasMap.getZoom() > 15) atlasMap.setZoom(15);
    });
  } else {
    document.getElementById('map-empty-state')?.classList.remove('hidden');
    const activeDay = (itinerary.days || [])[getActiveDayIndex()];
    const fallbackCenter = getExpectedDayCenter(activeDay, itinerary.trip) || itinerary.trip?.destination_coordinates;
    if (fallbackCenter) atlasMap.setCenter(fallbackCenter);
  }
  updateMapCoverageStatus(visibleCount, expectedCount);
}

function getActivityMapKey(dayIdx, actIdx) {
  return `${dayIdx}:${actIdx}`;
}

function canOpenActivityOnMap(act, day) {
  if (!mapsReady || !mapsKey || !isCoordinate(act?.coordinates)) return false;
  return !isMapCoordinateOutlier(act, day, currentItinerary?.trip);
}

function openMapMarkerForActivity(dayIdx, actIdx) {
  if (!atlasMap || !atlasMapInfoWindow || !currentItinerary) return;

  let entry = atlasMapMarkerLookup.get(getActivityMapKey(dayIdx, actIdx));
  if (!entry) {
    renderMapPins(currentItinerary);
    entry = atlasMapMarkerLookup.get(getActivityMapKey(dayIdx, actIdx));
  }
  if (!entry) {
    showToast('This stop is not pinned on the map yet.');
    return;
  }

  document.querySelector('.map-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  openMapMarker(entry);
}

function openMapMarker({ marker, act, color }) {
  if (!atlasMap || !atlasMapInfoWindow || !marker) return;
  atlasMap.panTo(marker.getPosition());
  if (atlasMap.getZoom() < 13) atlasMap.setZoom(13);
  atlasMapInfoWindow.setContent(buildInfoWindowContent(act, color));
  atlasMapInfoWindow.open(atlasMap, marker);
}

function updateMapCoverageStatus(visibleCount, expectedCount) {
  const status = document.getElementById('map-coverage-status');
  if (!status) return;
  if (!expectedCount || visibleCount >= expectedCount) {
    status.classList.add('hidden');
    status.textContent = '';
    return;
  }
  const label = isTopThreeTrip() ? 'picks' : 'places';
  status.textContent = `Showing ${visibleCount} of ${expectedCount} mapped ${label}. Some locations need confirmation.`;
  status.classList.remove('hidden');
}

function setMapViewMode(mode) {
  if (!['all', 'selected'].includes(mode) || mapViewMode === mode) return;
  mapViewMode = mode;
  document.querySelectorAll('.map-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mapMode === mode);
  });
  if (currentItinerary) renderMapPins(currentItinerary);
}

function isMapCoordinateOutlier(act, day, trip) {
  if (act.category === 'transport') return false;
  if (act.place_validation?.status === 'validated' || act.place_validation?.status === 'ambiguous') return false;
  const expectedCenter = getExpectedDayCenter(day, trip);
  if (!expectedCenter || !isCoordinate(act.coordinates)) return false;
  return distanceKmBetween(expectedCenter, act.coordinates) > MAX_PLACE_MATCH_DISTANCE_KM;
}

function makeMarkerIcon(color, label) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 30 38">
    <path d="M15 0C6.716 0 0 6.716 0 15c0 11.25 15 23 15 23S30 26.25 30 15C30 6.716 23.284 0 15 0z" fill="${color}"/>
    <circle cx="15" cy="15" r="8" fill="white"/>
    <text x="15" y="19" text-anchor="middle" font-size="9" font-weight="700" fill="${color}" font-family="Inter,Arial,sans-serif">${label}</text>
  </svg>`;
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    scaledSize: new google.maps.Size(30, 38),
    anchor: new google.maps.Point(15, 38),
  };
}

function buildInfoWindowContent(act, color) {
  const bookingUrl = buildBookingUrl(act, currentItinerary?.trip?.destination || '');
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:230px;padding:2px 4px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0"></span>
        <strong style="color:#0B2347;font-size:13px;line-height:1.25">${act.name || ''}</strong>
      </div>
      ${act.description ? `<p style="color:#64748B;font-size:12px;margin:0 0 6px;line-height:1.45">${act.description.slice(0, 120)}${act.description.length > 120 ? '…' : ''}</p>` : ''}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        ${act.price_range ? `<span style="color:#1E5FAD;font-size:11px;font-weight:700">${act.price_range}</span>` : '<span></span>'}
        <a href="${bookingUrl}" target="_blank" rel="noopener" style="font-size:11px;font-weight:700;color:#fff;background:#0B2347;padding:4px 9px;border-radius:10px;text-decoration:none">Search →</a>
      </div>
    </div>`;
}

// ═══════════════════════════════════════════════
//  SIDEBAR
// ═══════════════════════════════════════════════
function buildSupportingCardsSection(itinerary) {
  const cards = buildSidebar(itinerary);
  if (!cards.children.length) return null;
  const section = el('section', 'supporting-cards-section');
  const heading = el('div', 'section-heading');
  const title = el('h2', 'section-title');
  title.textContent = 'Trip Logistics';
  heading.appendChild(title);
  section.appendChild(heading);
  section.appendChild(cards);
  return section;
}

function buildSidebar(itinerary) {
  const sidebar = el('div', 'sidebar');
  const loading = Boolean(itinerary._loadingExtras);
  const error   = itinerary._extrasError;

  if (error) sidebar.appendChild(buildExtrasErrorCard(error));

  // Hotels
  if (itinerary.accommodation) sidebar.appendChild(buildHotelCard(itinerary.accommodation));
  else if (loading)            sidebar.appendChild(buildSkeletonCard('Where to Stay', 4));

  // Transport
  if (itinerary.transport) sidebar.appendChild(buildTransportCard(itinerary.transport));
  else if (loading)        sidebar.appendChild(buildSkeletonCard('Getting Around', 3));

  // Budget
  if (itinerary.budget_breakdown) sidebar.appendChild(buildBudgetCard(itinerary.budget_breakdown));
  else if (loading)               sidebar.appendChild(buildSkeletonCard('Budget Breakdown', 5));

  return sidebar;
}

function buildActionItemsSection(itinerary) {
  const loading = Boolean(itinerary._loadingExtras);
  if (itinerary.action_items?.length) {
    const section = el('section', 'action-items-section');
    section.appendChild(buildSectionHeading('Before You Go'));
    section.appendChild(buildActionItemsCard(itinerary.action_items));
    return section;
  }
  if (loading) {
    const section = el('section', 'action-items-section');
    section.appendChild(buildSectionHeading('Before You Go'));
    section.appendChild(buildSkeletonCard('To-Do Before Your Trip', 6));
    return section;
  }
  return null;
}

function buildSectionHeading(titleText) {
  const heading = el('div', 'section-heading');
  const title = el('h2', 'section-title');
  title.textContent = titleText;
  heading.appendChild(title);
  return heading;
}

// Shimmer placeholder card while /extras is still loading.
function buildSkeletonCard(title, lines = 3) {
  const card = sidebarCard(title);
  card.classList.add('sidebar-card-loading');
  const body = card.querySelector('.sidebar-card-body');
  for (let i = 0; i < lines; i++) {
    const line = el('div', 'skeleton-line' + (i === lines - 1 ? ' short' : ''));
    body.appendChild(line);
  }
  return card;
}

function buildExtrasErrorCard(message) {
  const card = sidebarCard('Hit a snag');
  card.classList.add('sidebar-card-error');
  const body = card.querySelector('.sidebar-card-body');
  const p = el('p', 'extras-error-msg');
  p.textContent = message || 'Atlas couldn’t finish the hotel + budget pieces.';
  body.appendChild(p);
  const btn = el('button', 'extras-retry-btn');
  btn.type = 'button';
  btn.textContent = 'Try again';
  btn.addEventListener('click', retryExtras);
  body.appendChild(btn);
  return card;
}

// ── Action Items Checklist ─────────────────────
const CATEGORY_ORDER = ['Documents', 'Flights', 'Lodging', 'Transportation', 'Restaurants', 'Activities', 'Other'];
// CATEGORY_META kept for future use (and to gate "Other"). No icons rendered.
const CATEGORY_META = {
  Documents:      {},
  Flights:        {},
  Lodging:        {},
  Transportation: {},
  Restaurants:    {},
  Activities:     {},
  Other:          {},
};

function buildActionItemsCard(items) {
  const card = sidebarCard('To-Do Before Your Trip');
  card.classList.add('action-items-card');
  const body = card.querySelector('.sidebar-card-body');

  // Progress indicator
  const progress = el('div', 'action-items-progress');
  const progressLabel = el('span', 'action-items-progress-label');
  progressLabel.textContent = `0 of ${items.length} done`;
  progress.appendChild(progressLabel);
  const bar = el('div', 'action-items-progress-bar');
  const fill = el('div', 'action-items-progress-fill');
  bar.appendChild(fill);
  progress.appendChild(bar);
  body.appendChild(progress);

  // Group items by category (using fixed ordering, unknown cats go to "Other")
  const byCategory = new Map();
  items.forEach(item => {
    if (!item?.task) return;
    const cat = CATEGORY_META[item.category] ? item.category : 'Other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(item);
  });

  const orderedCats = CATEGORY_ORDER.filter(c => byCategory.has(c));

  orderedCats.forEach(cat => {
    const group = el('div', 'action-items-group');
    const label = el('p', 'action-items-group-label');
    label.textContent = cat;
    group.appendChild(label);

    const list = el('ul', 'action-items-list');
    byCategory.get(cat).forEach(item => {
      const li = document.createElement('li');
      const labelEl = el('label', 'action-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        labelEl.classList.toggle('done', cb.checked);
        updateActionItemsProgress();
      });
      const task = el('span', 'action-item-task');
      task.textContent = item.task;
      const text = el('span', 'action-item-text');
      text.appendChild(task);
      if (item.priority || item.timing) {
        const meta = el('span', 'action-item-meta');
        meta.textContent = [item.priority ? `${item.priority} priority` : '', item.timing]
          .filter(Boolean)
          .join(' · ');
        text.appendChild(meta);
      }
      labelEl.appendChild(cb);
      labelEl.appendChild(text);
      li.appendChild(labelEl);
      list.appendChild(li);
    });
    group.appendChild(list);
    body.appendChild(group);
  });

  return card;
}

function updateActionItemsProgress() {
  const card = document.querySelector('.action-items-card');
  if (!card) return;
  const all  = card.querySelectorAll('.action-item input[type="checkbox"]');
  const done = card.querySelectorAll('.action-item input[type="checkbox"]:checked');
  const label = card.querySelector('.action-items-progress-label');
  const fill  = card.querySelector('.action-items-progress-fill');
  if (label) label.textContent = `${done.length} of ${all.length} done`;
  if (fill)  fill.style.width = all.length ? `${(done.length / all.length) * 100}%` : '0%';
}

function buildHotelCard(accommodation) {
  const card = sidebarCard('Where to Stay');
  const body = card.querySelector('.sidebar-card-body');
  const top  = accommodation.top_pick;

  if (top) {
    const topDiv = el('div', 'hotel-top-pick');
    const name = el('p', 'hotel-name'); name.textContent = top.name || ''; topDiv.appendChild(name);
    if (top.neighborhood) { const h = el('p','hotel-neighborhood'); h.textContent = top.neighborhood; topDiv.appendChild(h); }
    if (top.price_range)  { const p = el('p','hotel-price'); p.textContent = top.price_range; topDiv.appendChild(p); }
    if (top.why)          { const w = el('p','hotel-why'); w.textContent = top.why; topDiv.appendChild(w); }
    if (top.loyalty_note) {
      const l = el('span','hotel-loyalty'); l.textContent = top.loyalty_note; topDiv.appendChild(l);
    }
    // Real booking link
    const searchName = top.name || '';
    const searchDest = currentItinerary?.trip?.destination || '';
    const link = el('a', 'badge badge-link');
    link.href = `https://www.booking.com/search.html?ss=${encodeURIComponent(searchName + ' ' + searchDest)}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.textContent = 'Search on Booking.com →';
    link.style.cssText = 'display:inline-flex;margin-top:6px';
    topDiv.appendChild(link);
    body.appendChild(topDiv);
  }

  if (accommodation.alternatives?.length) {
    const lbl = el('p', 'transport-label'); lbl.textContent = 'Also consider'; lbl.style.marginBottom = '8px';
    body.appendChild(lbl);
    accommodation.alternatives.forEach(alt => {
      const div  = el('div', 'hotel-alt');
      const name = el('p', 'hotel-alt-name'); name.textContent = alt.name || ''; div.appendChild(name);
      const info = el('p', 'hotel-alt-info'); info.textContent = [alt.price_range, alt.vibe].filter(Boolean).join(' · '); div.appendChild(info);
      body.appendChild(div);
    });
  }

  return card;
}

function buildTransportCard(transport) {
  const card = sidebarCard('Getting Around');
  const body = card.querySelector('.sidebar-card-body');
  const rows = [
    { label: 'Getting There',  value: transport.getting_there },
    { label: 'Getting Around', value: transport.getting_around },
    { label: 'Transport Cost', value: transport.cost_estimate },
  ];
  rows.forEach(({ label, value }) => {
    if (!value) return;
    const row = el('div', 'transport-row');
    const lbl = el('p', 'transport-label'); lbl.textContent = label; row.appendChild(lbl);
    const val = el('p', 'transport-value'); val.textContent = value;  row.appendChild(val);
    body.appendChild(row);
  });
  return card;
}

function buildBudgetCard(budget) {
  const card  = sidebarCard('Budget Breakdown');
  const body  = card.querySelector('.sidebar-card-body');
  const table = document.createElement('table');
  table.className = 'budget-table';
  [
    ['Accommodation',    budget.accommodation],
    ['Food',             budget.food],
    ['Activities',       budget.activities],
    ['Local Transport',  budget.transport_local],
  ].forEach(([label, value]) => {
    if (!value) return;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${label}</td><td>${value}</td>`;
    table.appendChild(tr);
  });
  if (budget.total_estimate) {
    const tr = document.createElement('tr');
    tr.className = 'budget-total';
    tr.innerHTML = `<td>Total Estimate</td><td>${budget.total_estimate}</td>`;
    table.appendChild(tr);
  }
  body.appendChild(table);
  if (budget.notes) {
    const note = el('p', 'budget-note'); note.textContent = budget.notes; body.appendChild(note);
  }
  return card;
}

function sidebarCard(headerText) {
  const card   = el('div', 'sidebar-card');
  const header = el('div', 'sidebar-card-header');
  header.innerHTML = headerText;
  card.appendChild(header);
  const body = el('div', 'sidebar-card-body');
  card.appendChild(body);
  return card;
}

// ═══════════════════════════════════════════════
//  REVISE CARD (edit suggestion box)
// ═══════════════════════════════════════════════
function buildReviseCard() {
  const card = el('div', 'revise-card');

  const title = el('h3', 'revise-title');
  title.textContent = 'Want to tweak it?';
  card.appendChild(title);

  const sub = el('p', 'revise-sub');
  sub.textContent = 'Tell Atlas what to keep and what to change — the rest of your itinerary stays exactly as it is.';
  card.appendChild(sub);

  // Previous edits (if any)
  if (revisionHistory.length) {
    const hist = el('div', 'revise-history');
    const histLabel = el('p', 'revise-history-label');
    histLabel.textContent = `${revisionHistory.length} previous edit${revisionHistory.length === 1 ? '' : 's'}`;
    hist.appendChild(histLabel);
    revisionHistory.forEach(entry => {
      const item = el('div', 'revise-history-item');
      item.textContent = entry.feedback;
      hist.appendChild(item);
    });
    card.appendChild(hist);
  }

  const textarea = el('textarea', 'revise-input');
  textarea.id = 'revise-input';
  textarea.rows = 3;
  textarea.placeholder = 'e.g. "keep the hotels but make the restaurants cheaper" or "make Day 2 less packed"';
  card.appendChild(textarea);

  const actions = el('div', 'revise-actions');

  const btn = el('button', 'revise-btn');
  btn.id = 'revise-btn';
  btn.type = 'button';
  btn.innerHTML = '<span class="revise-btn-text">Update itinerary</span><span class="revise-btn-arrow">→</span>';
  btn.addEventListener('click', submitRevision);
  actions.appendChild(btn);

  const status = el('span', 'revise-status');
  status.id = 'revise-status';
  actions.appendChild(status);

  card.appendChild(actions);

  const hint = el('p', 'revise-hint');
  hint.textContent = 'Tip: press ⌘/Ctrl + Enter to submit';
  card.appendChild(hint);

  // Submit on Cmd/Ctrl + Enter
  textarea.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitRevision();
    }
  });

  return card;
}

async function submitRevision() {
  const textarea = document.getElementById('revise-input');
  const btn      = document.getElementById('revise-btn');
  const status   = document.getElementById('revise-status');
  if (!textarea || !btn) return;

  const feedback = textarea.value.trim();
  if (!feedback) {
    textarea.focus();
    return;
  }
  if (!currentItinerary) {
    showToast('No itinerary to revise.');
    return;
  }

  // Loading state
  textarea.disabled = true;
  btn.disabled = true;
  btn.innerHTML = '<span class="revise-spinner" aria-hidden="true"></span><span class="revise-btn-text">Updating…</span>';
  if (status) status.textContent = 'Atlas is rewriting your itinerary…';

  try {
    const res  = await fetch('/api/itinerary/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itinerary: currentItinerary, feedback }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Could not update the itinerary. Try again.');

    // Save edit to history BEFORE re-rendering (so it shows up in the new revise card)
    const activeDayIndex = getActiveDayIndex();
    revisionHistory.push({ feedback, timestamp: Date.now() });

    const savedTripId = currentItinerary._tripId;
    if (savedTripId) json.itinerary._tripId = savedTripId;

    renderResults(json.itinerary);
    setActiveDay(Math.min(activeDayIndex, (json.itinerary.days?.length || 1) - 1));
    persistTripIfPossible(currentItinerary);
    enrichPlacesForCurrentItinerary();
    scrollToItinerary();
    showToast('Itinerary updated!');

  } catch (err) {
    // Restore UI on failure
    textarea.disabled = false;
    btn.disabled = false;
    btn.innerHTML = '<span class="revise-btn-text">Update itinerary</span><span class="revise-btn-arrow">→</span>';
    if (status) status.textContent = '';
    showToast(err.message || 'Could not update — try again.');
  }
}

// ═══════════════════════════════════════════════
//  SHARE — short /share/:id URLs (with legacy fallback)
// ═══════════════════════════════════════════════
async function shareItinerary(itinerary) {
  try {
    // Make sure the trip is saved. If the auto-save is still in
    // flight or hasn't run yet, save now so the share button never
    // copies a stale link.
    if (!itinerary._tripId || itinerary._tripId === 'pending') {
      await saveTripIfPossible(itinerary);
    } else {
      await updateSavedTripIfPossible(itinerary);
    }

    let shareUrl;
    if (itinerary._tripId && itinerary._tripId !== 'pending' && itinerary._tripId !== null) {
      shareUrl = `${location.origin}/share/${itinerary._tripId}`;
    } else {
      // Save failed (likely DB not configured yet). Fall back to the
      // legacy base64-in-hash format so the share button still works.
      const clean = cleanItineraryForSave(itinerary);
      const json    = JSON.stringify(clean);
      const bytes   = new TextEncoder().encode(json);
      const binary  = Array.from(bytes, b => String.fromCharCode(b)).join('');
      const encoded = btoa(binary);
      shareUrl = `${location.origin}/#share=${encoded}`;
    }

    await navigator.clipboard.writeText(shareUrl);
    showToast('Link copied to clipboard!');
  } catch {
    showToast('Could not copy — try printing instead.');
  }
}

// Detect a shared trip from the URL and load it. Handles three
// formats: /share/:id (current), ?t=:id (test convenience), and
// #share=<base64-json> (legacy — kept so links already sent out
// still work).
async function checkForSharedItinerary() {
  // 1) /share/:id
  const pathMatch = location.pathname.match(/^\/share\/([a-f0-9]{12})\/?$/);
  if (pathMatch) {
    try {
      const itinerary = await loadTripById(pathMatch[1]);
      renderResults(itinerary);
      showView('results');
      enrichPlacesForCurrentItinerary();
      return;
    } catch {
      showToast('That trip link is no longer valid.');
      history.replaceState(null, '', '/');
      return;
    }
  }

  // 2) ?t=:id (test-friendly alternate)
  const params = new URLSearchParams(location.search);
  const tParam = params.get('t');
  if (tParam && /^[a-f0-9]{12}$/.test(tParam)) {
    try {
      const itinerary = await loadTripById(tParam);
      renderResults(itinerary);
      showView('results');
      enrichPlacesForCurrentItinerary();
      return;
    } catch {
      showToast('That trip link is no longer valid.');
      history.replaceState(null, '', '/');
      return;
    }
  }

  // 3) #share=<base64> — legacy. Decode and (best-effort) save so
  //    re-shares of an old link can upgrade to the short format.
  const hash = location.hash;
  if (hash.startsWith('#share=')) {
    try {
      const encoded = hash.slice(7);
      const binary  = atob(encoded);
      const bytes   = new Uint8Array([...binary].map(c => c.charCodeAt(0)));
      const json    = new TextDecoder().decode(bytes);
      const itinerary = JSON.parse(json);
      renderResults(itinerary);
      showView('results');
      // Upgrade-in-place: save to server so future shares use /share/:id.
      saveTripIfPossible(itinerary);
    } catch {
      // Malformed hash — just show the form.
    }
  }
}

// ═══════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════
let toastTimeout = null;

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ═══════════════════════════════════════════════
//  ICS CALENDAR EXPORT
// ═══════════════════════════════════════════════
function downloadICS(itinerary) {
  const content  = generateICS(itinerary);
  const blob     = new Blob([content], { type: 'text/calendar;charset=utf-8' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href         = url;
  a.download     = `atlas-${slugify(itinerary.trip?.destination || 'trip')}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateICS(itinerary) {
  const { trip, days } = itinerary;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Atlas Travel Concierge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Atlas – ${trip.destination || 'Trip'}`,
    'X-WR-TIMEZONE:UTC',
  ];

  let tripStartMs = null;
  if (trip?.startDate) {
    const d = new Date(trip.startDate + 'T00:00:00Z');
    if (!isNaN(d.getTime())) tripStartMs = d.getTime();
  }

  (days || []).forEach(day => {
    let dayDateStr = null;
    if (tripStartMs !== null) {
      dayDateStr = toICSDate(new Date(tripStartMs + (day.day_number - 1) * 86400000));
    }

    (day.activities || []).forEach(act => {
      if (!dayDateStr) return;
      const uid       = `atlas-d${day.day_number}-${slugify(act.name || 'activity')}@atlas`;
      const timeMatch = (act.time || '').match(/^(\d{1,2}):(\d{2})$/);
      let dtstart, dtend;
      if (timeMatch) {
        const hh = timeMatch[1].padStart(2, '0');
        const mm = timeMatch[2];
        const eh = String(Math.min(parseInt(hh, 10) + 1, 23)).padStart(2, '0');
        dtstart = `DTSTART:${dayDateStr}T${hh}${mm}00Z`;
        dtend   = `DTEND:${dayDateStr}T${eh}${mm}00Z`;
      } else {
        dtstart = `DTSTART;VALUE=DATE:${dayDateStr}`;
        dtend   = `DTEND;VALUE=DATE:${dayDateStr}`;
      }
      const descParts = [act.description, act.price_range ? `Price: ${act.price_range}` : null, shouldShowAtlasTip(day.day_number - 1, (day.activities || []).indexOf(act)) && act.atlas_tip ? `Tip: ${act.atlas_tip}` : null].filter(Boolean);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${toICSDateTime(new Date())}`,
        dtstart,
        dtend,
        `SUMMARY:${icsEscape(act.name || 'Activity')}`,
        descParts.length ? foldICS(`DESCRIPTION:${icsEscape(descParts.join('\\n'))}`) : '',
        act.address ? foldICS(`LOCATION:${icsEscape(act.address)}`) : '',
        'END:VEVENT',
      );
    });
  });

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}

function toICSDate(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}
function toICSDateTime(d) {
  return `${toICSDate(d)}T${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}${String(d.getUTCSeconds()).padStart(2,'0')}Z`;
}
function icsEscape(t) {
  return String(t).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}
function foldICS(line) {
  if (line.length <= 75) return line;
  let out = ''; let off = 0;
  out += line.slice(0, 75); off = 75;
  while (off < line.length) { out += '\r\n ' + line.slice(off, off + 74); off += 74; }
  return out;
}

// ═══════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════
function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}
function metaSpan(text) {
  const s = document.createElement('span'); s.textContent = text; return s;
}
function formatDateRange(start, end) {
  const opts = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
  try {
    const s = start ? new Date(start + 'T00:00:00Z').toLocaleDateString('en-US', opts) : '';
    const e = end   ? new Date(end   + 'T00:00:00Z').toLocaleDateString('en-US', opts) : '';
    if (s && e) return `${s} – ${e}`;
    return s || e;
  } catch { return [start, end].filter(Boolean).join(' – '); }
}
function slugify(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,40);
}
