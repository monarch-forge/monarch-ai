/**
 * Unit Convert — offline unit conversions + time-zone math (Intl). No permissions needed.
 *
 * Shows: pure-computation tools, input validation with zod refinements, and throwing an Error
 * with a helpful message (the agent sees it as a failed tool call).
 */

// factor = how many base units one of this unit is. Base: m, kg, L, m/s, m², byte, s, Pa, J.
const UNITS = {
  length: { base: 'm', units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 } },
  mass: { base: 'kg', units: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237, st: 6.35029318 } },
  volume: { base: 'L', units: { ml: 0.001, cl: 0.01, l: 1, m3: 1000, tsp: 0.00492892159375, tbsp: 0.01478676478125, floz: 0.0295735295625, cup: 0.2365882365, pt: 0.473176473, qt: 0.946352946, gal: 3.785411784 } },
  speed: { base: 'm/s', units: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.514444444, 'ft/s': 0.3048 } },
  area: { base: 'm²', units: { mm2: 1e-6, cm2: 1e-4, m2: 1, km2: 1e6, ha: 1e4, acre: 4046.8564224, ft2: 0.09290304, in2: 0.00064516, mi2: 2589988.110336 } },
  data: { base: 'byte', units: { bit: 0.125, b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 } },
  time: { base: 's', units: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, wk: 604800, yr: 31557600 } },
  pressure: { base: 'Pa', units: { pa: 1, kpa: 1000, bar: 1e5, atm: 101325, psi: 6894.757293168, mmhg: 133.322387415 } },
  energy: { base: 'J', units: { j: 1, kj: 1000, cal: 4.184, kcal: 4184, wh: 3600, kwh: 3.6e6, btu: 1055.05585262 } },
};
const TEMPS = ['c', 'f', 'k'];
const ALIASES = {
  meter: 'm', meters: 'm', metre: 'm', kilometer: 'km', kilometers: 'km', mile: 'mi', miles: 'mi', inch: 'in', inches: 'in',
  foot: 'ft', feet: 'ft', yard: 'yd', yards: 'yd', gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', stone: 'st', tonne: 't', tonnes: 't', liter: 'l', liters: 'l',
  litre: 'l', litres: 'l', milliliter: 'ml', gallon: 'gal', gallons: 'gal', kph: 'km/h', kmh: 'km/h', knots: 'kn', knot: 'kn',
  celsius: 'c', '°c': 'c', fahrenheit: 'f', '°f': 'f', kelvin: 'k', byte: 'b', bytes: 'b', bits: 'bit', 'm²': 'm2', 'km²': 'km2',
  sec: 's', second: 's', seconds: 's', minute: 'min', minutes: 'min', hour: 'h', hours: 'h', hr: 'h', day: 'd', days: 'd',
  week: 'wk', weeks: 'wk', year: 'yr', years: 'yr', hectare: 'ha', acres: 'acre', calorie: 'cal', calories: 'cal',
};

const norm = (u) => {
  const k = String(u).trim().toLowerCase();
  return ALIASES[k] ?? k;
};
function dimensionOf(unit) {
  if (TEMPS.includes(unit)) return 'temperature';
  for (const [dim, def] of Object.entries(UNITS)) if (unit in def.units) return dim;
  return null;
}
function toCelsius(v, u) {
  return u === 'c' ? v : u === 'f' ? ((v - 32) * 5) / 9 : v - 273.15;
}
function fromCelsius(v, u) {
  return u === 'c' ? v : u === 'f' ? (v * 9) / 5 + 32 : v + 273.15;
}
const round = (n) => Number.parseFloat(n.toPrecision(10));

/** offset of `zone` at instant `date`, in minutes east of UTC */
function zoneOffset(zone, date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
/** "2026-11-14 15:30" as wall-clock time in `zone` → Date */
function wallTimeToDate(text, zone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`time must look like "2026-11-14 15:30" (got "${text}")`);
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = asUtc - zoneOffset(zone, new Date(asUtc)) * 60_000;
  guess = asUtc - zoneOffset(zone, new Date(guess)) * 60_000; // second pass settles DST edges
  return new Date(guess);
}
function checkZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    throw new Error(`unknown time zone "${zone}" — use IANA names like "Europe/Berlin", "America/New_York", "UTC"`);
  }
}

export default function activate(api) {
  const { z } = api;

  api.tool({
    name: 'convert',
    description:
      'Convert a value between units of the same dimension (length, mass, volume, temperature, speed, area, data, time, pressure, energy). Exact factors, offline.',
    risk: 'safe',
    input: z.object({
      value: z.number().describe('The amount to convert.'),
      from: z.string().min(1).describe('Source unit, e.g. "mi", "lb", "°F", "GiB", "km/h".'),
      to: z.string().min(1).describe('Target unit, e.g. "km", "kg", "c", "MB", "mph".'),
    }),
    run: ({ value, from, to }) => {
      const a = norm(from);
      const b = norm(to);
      const da = dimensionOf(a);
      const db = dimensionOf(b);
      if (!da) throw new Error(`unknown unit "${from}" — call list_units to see what is supported`);
      if (!db) throw new Error(`unknown unit "${to}" — call list_units to see what is supported`);
      if (da !== db) throw new Error(`cannot convert ${da} (${from}) to ${db} (${to})`);
      const out =
        da === 'temperature'
          ? fromCelsius(toCelsius(value, a), b)
          : (value * UNITS[da].units[a]) / UNITS[da].units[b];
      return `${value} ${from} = ${round(out)} ${to}`;
    },
  });

  api.tool({
    name: 'list_units',
    description: 'List the supported units, optionally for one dimension.',
    risk: 'safe',
    input: z.object({ dimension: z.string().optional().describe('e.g. "length"; omit for all.') }),
    run: ({ dimension }) => {
      const dims = dimension ? [dimension.toLowerCase()] : [...Object.keys(UNITS), 'temperature'];
      return dims
        .map((d) =>
          d === 'temperature'
            ? 'temperature: c, f, k'
            : UNITS[d]
              ? `${d} (base ${UNITS[d].base}): ${Object.keys(UNITS[d].units).join(', ')}`
              : `${d}: unknown dimension`,
        )
        .join('\n');
    },
  });

  api.tool({
    name: 'time_zones',
    description:
      'Show one moment in several time zones. Give a wall-clock time in a source zone ("2026-11-14 15:30" in "Asia/Jakarta"), or omit time for now.',
    risk: 'safe',
    input: z.object({
      zones: z.array(z.string()).min(1).max(12).describe('IANA zones to show, e.g. ["Europe/London","America/New_York"].'),
      time: z.string().optional().describe('Wall-clock "YYYY-MM-DD HH:mm" in `from`. Omit for now.'),
      from: z.string().default('UTC').describe('IANA zone the time is expressed in (default UTC).'),
    }),
    run: ({ zones, time, from }) => {
      const src = checkZone(from);
      const at = time ? wallTimeToDate(time, src) : new Date();
      const fmt = (zone) =>
        new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          weekday: 'short',
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'shortOffset',
        }).format(at);
      const rows = [src, ...zones.filter((zn) => zn !== src)].map((zn) => `${checkZone(zn).padEnd(22)} ${fmt(zn)}`);
      return `${at.toISOString()}\n${rows.join('\n')}`;
    },
  });
}
