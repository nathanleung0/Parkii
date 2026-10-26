import { action } from "./_generated/server";
import { v } from "convex/values";

// Street-cleaning lookup from DataSF's Street Sweeping Schedule (public Socrata dataset yhqp-riqs).
// TypeScript port of agents/street_rules.py: nearest block face, next sweep, driver-facing text.
// Times are San Francisco local time; SF wall-clock is derived with Intl, never hardcoded offsets.

const DATASET = "https://data.sf.gov/resource/yhqp-riqs.json";
const SF_TZ = "America/Los_Angeles";
const SEARCH_RADIUS_DEG_LAT = 0.0003; // ~33 m
const SEARCH_RADIUS_DEG_LNG = 0.00038; // ~33 m at SF's latitude
const TIMEOUT_MS = 10_000;
const METERS_PER_DEG = 111_320;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LOOKAHEAD_DAYS = 36; // long enough to reach every 5th-week-only schedule

// DataSF weekday strings -> Monday = 0
const WEEKDAYS = new Map<string, number>([
  ["Mon", 0],
  ["Tues", 1],
  ["Wed", 2],
  ["Thu", 3],
  ["Fri", 4],
  ["Sat", 5],
  ["Sun", 6],
]);
const LONG_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export type StreetCleaningResult = {
  warning: "now" | "soon" | "later" | null;
  text: string | null;
  next: { corridor: string; side: string; limits: string; start: string; endHour: number } | null;
  error?: string;
};

type Row = Record<string, unknown>;
type Coord = [number, number]; // [lng, lat]
type Sweep = {
  corridor: string;
  limits: string;
  side: string;
  weekday: number; // Monday = 0
  startHour: number;
  endHour: number;
  weeks: number[]; // which occurrence of the weekday in the month (1..5) is swept
};
type Parsed = { coords: Coord[]; sweep: Sweep };

const NO_RESTRICTION: StreetCleaningResult = {
  warning: null,
  text: "No street-cleaning restriction found for this block.",
  next: null,
};

function meters(lat: number, lng: number, lat2: number, lng2: number): number {
  const dy = (lat2 - lat) * METERS_PER_DEG;
  const dx = (lng2 - lng) * METERS_PER_DEG * Math.cos((lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// Distance in meters from a point to segment a->b (each [lng, lat]); projection clamped to the segment.
function segmentDistance(lat: number, lng: number, a: Coord, b: Coord): number {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((lng - ax) * dx + (lat - ay) * dy) / (dx * dx + dy * dy)));
  return meters(lat, lng, ay + t * dy, ax + t * dx);
}

function rowDistance(lat: number, lng: number, coords: Coord[]): number {
  if (coords.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    best = Math.min(best, segmentDistance(lat, lng, coords[i], coords[i + 1]));
  }
  return best;
}

function parseCoords(line: unknown): Coord[] {
  const raw = (line as { coordinates?: unknown } | null | undefined)?.coordinates;
  if (!Array.isArray(raw)) return [];
  const out: Coord[] = [];
  for (const c of raw) {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") out.push([c[0], c[1]]);
  }
  return out;
}

// Socrata returns hours as strings; accept only plain integers (Python's int() equivalent for this data).
function parseHour(value: unknown): number | null {
  const s = String(value ?? "").trim();
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

function parseRows(rows: unknown[]): Parsed[] {
  const out: Parsed[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Row;
    const weekday = WEEKDAYS.get(String(r.weekday ?? ""));
    const startHour = parseHour(r.fromhour);
    const endHour = parseHour(r.tohour);
    if (weekday === undefined || startHour === null || endHour === null) continue;
    const weeks: number[] = [];
    for (let i = 1; i <= 5; i++) if (String(r[`week${i}`] ?? "0") === "1") weeks.push(i);
    if (weeks.length === 0) continue;
    out.push({
      coords: parseCoords(r.line),
      sweep: {
        corridor: String(r.corridor ?? "?"),
        limits: String(r.limits ?? ""),
        side: String(r.blockside ?? ""),
        weekday,
        startHour,
        endHour,
        weeks,
      },
    });
  }
  return out;
}

// All sweeps on the single closest block face (same corridor, limits and side).
function nearestBlock(lat: number, lng: number, rows: unknown[]): Sweep[] {
  const parsed = parseRows(rows);
  if (parsed.length === 0) return [];
  let best = parsed[0];
  let bestDist = rowDistance(lat, lng, best.coords);
  for (const p of parsed.slice(1)) {
    const d = rowDistance(lat, lng, p.coords);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  const { corridor, limits, side } = best.sweep;
  return parsed
    .map((p) => p.sweep)
    .filter((s) => s.corridor === corridor && s.limits === limits && s.side === side);
}

// ---- San Francisco wall-clock helpers (Intl-based, no hardcoded offsets) ----

const SF_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: SF_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function sfWall(ms: number): Wall {
  const p: Record<string, number> = {};
  for (const part of SF_FORMAT.formatToParts(ms)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

// Wall-clock fields read as if they were UTC.
function wallAsUtc(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

// SF UTC offset in ms at the given instant (negative west of UTC).
function sfOffsetMs(ms: number): number {
  return wallAsUtc(sfWall(ms)) - Math.floor(ms / 1000) * 1000;
}

// SF-local wall time (date + hour, minute 0) -> real instant. Guess, measure the zone offset, correct once more if it moved.
function sfLocalToMs(y: number, mo: number, d: number, h: number): number {
  const guess = Date.UTC(y, mo - 1, d, h);
  const off1 = sfOffsetMs(guess);
  let t = guess - off1;
  const off2 = sfOffsetMs(t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

// ISO-8601 with SF offset, matching Python's datetime.isoformat() for these values (e.g. 2026-10-27T06:00:00-07:00).
function sfIso(ms: number): string {
  const w = sfWall(ms);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  const offMin = Math.round(sfOffsetMs(ms) / 60_000);
  const sign = offMin < 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  return `${pad(w.y, 4)}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

type NextSweep = { startMs: number; sweep: Sweep };

// Soonest sweep (across the block face's rows) whose window has not ended yet.
function nextSweep(sweeps: Sweep[], nowMs: number): NextSweep | null {
  const now = sfWall(nowMs);
  const today = Date.UTC(now.y, now.mo - 1, now.d); // SF calendar date, pure calendar arithmetic
  let best: NextSweep | null = null;
  for (const s of sweeps) {
    for (let offset = 0; offset < LOOKAHEAD_DAYS; offset++) {
      const cal = new Date(today + offset * DAY_MS);
      const weekday = (cal.getUTCDay() + 6) % 7; // Monday = 0
      const y = cal.getUTCFullYear();
      const mo = cal.getUTCMonth() + 1;
      const d = cal.getUTCDate();
      const weekOfMonth = Math.floor((d - 1) / 7) + 1;
      if (weekday !== s.weekday || !s.weeks.includes(weekOfMonth)) continue;
      const startMs = sfLocalToMs(y, mo, d, s.startHour);
      const endMs = sfLocalToMs(y, mo, d, s.endHour);
      if (endMs <= nowMs) continue;
      if (best === null || startMs < best.startMs) best = { startMs, sweep: s };
      break;
    }
  }
  return best;
}

function fmtHour(h: number): string {
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

function describe(sweeps: Sweep[], nowMs: number): StreetCleaningResult {
  const nxt = sweeps.length === 0 ? null : nextSweep(sweeps, nowMs);
  if (!nxt) return NO_RESTRICTION;
  const { startMs, sweep: s } = nxt;
  const hoursAway = (startMs - nowMs) / HOUR_MS;
  const when = `${LONG_NAMES[s.weekday]} ${fmtHour(s.startHour)}-${fmtHour(s.endHour)}`;
  let warning: "now" | "soon" | "later";
  let text: string;
  if (startMs <= nowMs) {
    warning = "now";
    text = `Street cleaning is in effect right now on ${s.corridor} (${s.side} side) until ${fmtHour(s.endHour)}. Don't park here.`;
  } else if (hoursAway < 24) {
    warning = "soon";
    text = `Street cleaning on ${s.corridor} (${s.side} side) starts ${when} - less than a day away. You'd need to move your car.`;
  } else {
    warning = "later";
    text = `Next street cleaning on ${s.corridor} (${s.side} side): ${when}. Move your car before then.`;
  }
  return {
    warning,
    text,
    next: { corridor: s.corridor, side: s.side, limits: s.limits, start: sfIso(startMs), endHour: s.endHour },
  };
}

async function fetchRows(url: string): Promise<unknown[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Parkii/0.1 (Cal Hacks 13.0)" },
    });
    if (!res.ok) throw new Error(`DataSF HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("DataSF response is not an array");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export const streetCleaning = action({
  args: { lat: v.number(), lng: v.number() },
  handler: async (_ctx, { lat, lng }): Promise<StreetCleaningResult> => {
    const box =
      `POLYGON((${lng - SEARCH_RADIUS_DEG_LNG} ${lat - SEARCH_RADIUS_DEG_LAT}, ` +
      `${lng + SEARCH_RADIUS_DEG_LNG} ${lat - SEARCH_RADIUS_DEG_LAT}, ` +
      `${lng + SEARCH_RADIUS_DEG_LNG} ${lat + SEARCH_RADIUS_DEG_LAT}, ` +
      `${lng - SEARCH_RADIUS_DEG_LNG} ${lat + SEARCH_RADIUS_DEG_LAT}, ` +
      `${lng - SEARCH_RADIUS_DEG_LNG} ${lat - SEARCH_RADIUS_DEG_LAT}))`;
    const url = `${DATASET}?${new URLSearchParams({ $where: `intersects(line, '${box}')`, $limit: "50" })}`;

    let rows: unknown[];
    try {
      rows = await fetchRows(url);
    } catch {
      return { warning: null, text: null, next: null, error: "unavailable" };
    }
    return describe(nearestBlock(lat, lng, rows), Date.now());
  },
});
