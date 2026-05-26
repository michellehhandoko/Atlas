// ============================================================
//  Atlas — Postgres connection + schema
//  Railway's managed Postgres add-on injects DATABASE_URL into
//  the service env automatically. Locally, paste it into
//  local.env or run `railway run npm start`.
//
//  The whole module is no-op-safe when DATABASE_URL is unset:
//  `isAvailable()` returns false and the trips endpoints return
//  503 with a clear message, so the rest of the app keeps
//  working before/after the Railway Postgres add-on is wired.
// ============================================================
import pg from 'pg';
import { randomBytes } from 'node:crypto';

const { Pool } = pg;

let pool = null;
let schemaReady = false;

function shouldUseSsl(url) {
  // Local Postgres typically doesn't speak SSL; cloud providers
  // (Railway, Render, Neon, Supabase) require it. The simplest
  // heuristic that's correct in practice.
  if (!url) return false;
  return !/(localhost|127\.0\.0\.1|::1)/i.test(url);
}

export function isAvailable() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) return null;
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    console.error('[db] Idle client error:', err);
  });
  return pool;
}

export async function query(text, params) {
  const p = getPool();
  if (!p) throw new Error('Database is not configured (DATABASE_URL is missing).');
  return p.query(text, params);
}

// ── Schema bootstrap ────────────────────────────────────────
// Idempotent: safe to call on every boot. CREATE TABLE IF NOT
// EXISTS handles the cold-start case; the index is similarly
// guarded. Returns true if the schema is ready (DB available
// and migrations applied), false if no DB is configured.
export async function initSchema() {
  if (!isAvailable()) {
    console.log('[db] DATABASE_URL not set — persistence endpoints disabled.');
    return false;
  }
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS trips (
        id              TEXT PRIMARY KEY,
        device_id       TEXT NOT NULL,
        itinerary       JSONB NOT NULL,
        title           TEXT NOT NULL,
        destination     TEXT NOT NULL,
        start_date      DATE,
        end_date        DATE,
        duration_days   INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await query(`
      CREATE INDEX IF NOT EXISTS idx_trips_device_created
        ON trips (device_id, created_at DESC);
    `);
    schemaReady = true;
    console.log('[db] Schema ready.');
    return true;
  } catch (err) {
    console.error('[db] Schema init failed:', err);
    return false;
  }
}

export function isSchemaReady() {
  return schemaReady;
}

// ── ID generation ───────────────────────────────────────────
// 12-character hex ID (6 random bytes = 2^48 entropy ≈ 280T).
// Plenty for trip share links and short enough to fit in URLs
// without folding. Collision probability is negligible at the
// scales this app will see.
export function newTripId() {
  return randomBytes(6).toString('hex');
}
