/** Weather + geocoding via Open-Meteo (no API key). */
import type { GeoLocation, Weather } from '@monarch/shared';
import { HttpError } from '../kernel.ts';

const UA = 'Monarch/0.1 (personal assistant)';
const TTL_MS = 10 * 60e3;

const WMO: Record<number, string> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Heavy freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Severe thunderstorm with hail',
};
export function wmoSummary(code: number): string {
  return WMO[code] ?? 'Unknown';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  if (!Number.isFinite(deg)) return '—';
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new HttpError(502, `Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

interface ForecastResponse {
  utc_offset_seconds: number;
  timezone?: string;
  current: {
    time: number;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    visibility?: number;
    weather_code: number;
    is_day: number;
  };
  hourly: { time: number[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability?: (number | null)[] };
  daily: {
    time: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    weather_code: number[];
    sunrise: number[];
    sunset: number[];
  };
}

const cache = new Map<string, { at: number; value: Weather }>();
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function getWeather(loc: GeoLocation, opts: { fresh?: boolean } = {}): Promise<Weather> {
  const key = `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return { ...hit.value, location: loc };
  const q = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    current:
      'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,visibility,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset',
    timezone: loc.timezone || 'auto',
    timeformat: 'unixtime',
    forecast_days: '5',
    wind_speed_unit: 'kmh',
  });
  const d = await getJson<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${q}`);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const nowSec = Date.now() / 1000;
  const firstHour = d.hourly.time.findIndex((t) => t + 3600 > nowSec);
  const hourly: Weather['hourly'] = [];
  for (let i = Math.max(0, firstHour); i < d.hourly.time.length && hourly.length < 12; i++) {
    const pp = d.hourly.precipitation_probability?.[i];
    hourly.push({
      time: iso(d.hourly.time[i]),
      tempC: r1(d.hourly.temperature_2m[i]),
      code: d.hourly.weather_code[i],
      ...(typeof pp === 'number' ? { precipProb: pp } : {}),
    });
  }
  const daily: Weather['daily'] = d.daily.time.slice(0, 5).map((t, i) => ({
    // daily timestamps are local midnight; shift by the offset to read the local calendar date
    date: new Date((t + d.utc_offset_seconds) * 1000).toISOString().slice(0, 10),
    minC: r1(d.daily.temperature_2m_min[i]),
    maxC: r1(d.daily.temperature_2m_max[i]),
    code: d.daily.weather_code[i],
    sunrise: d.daily.sunrise?.[i] ? iso(d.daily.sunrise[i]) : undefined,
    sunset: d.daily.sunset?.[i] ? iso(d.daily.sunset[i]) : undefined,
  }));
  const c = d.current;
  const value: Weather = {
    location: { ...loc, timezone: loc.timezone || d.timezone },
    current: {
      tempC: r1(c.temperature_2m),
      feelsLikeC: r1(c.apparent_temperature),
      humidity: Math.round(c.relative_humidity_2m),
      windKph: r1(c.wind_speed_10m),
      windDir: compass(c.wind_direction_10m),
      visibilityKm: typeof c.visibility === 'number' ? r1(c.visibility / 1000) : undefined,
      code: c.weather_code,
      summary: wmoSummary(c.weather_code),
      isDay: c.is_day === 1,
    },
    hourly,
    daily,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

interface GeoResponse {
  results?: { name: string; latitude: number; longitude: number; country_code?: string; country?: string; admin1?: string; timezone?: string }[];
}

export async function geocode(query: string, count = 6): Promise<GeoLocation[]> {
  const name = query.trim();
  if (!name) return [];
  const q = new URLSearchParams({ name, count: String(count), language: 'en', format: 'json' });
  const d = await getJson<GeoResponse>(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
  return (d.results ?? []).map((r) => ({
    name: [r.name, r.admin1 && r.admin1 !== r.name ? r.admin1 : null, r.country_code?.toUpperCase() ?? r.country]
      .filter(Boolean)
      .join(', '),
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone,
  }));
}

/** human summary used by tools; honours metric/imperial */
export function describeWeather(w: Weather, units: 'metric' | 'imperial'): string {
  const t = (c: number) => (units === 'imperial' ? `${Math.round((c * 9) / 5 + 32)}°F` : `${Math.round(c)}°C`);
  const wind = units === 'imperial' ? `${Math.round(w.current.windKph / 1.609)} mph` : `${Math.round(w.current.windKph)} km/h`;
  const tz = w.location.timezone;
  const hm = (iso?: string) =>
    iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }) : '—';
  const lines = [
    `Weather for ${w.location.name}: ${w.current.summary}, ${t(w.current.tempC)} (feels like ${t(w.current.feelsLikeC)}).`,
    `Humidity ${w.current.humidity}%, wind ${wind} ${w.current.windDir}` +
      (w.current.visibilityKm !== undefined ? `, visibility ${w.current.visibilityKm} km.` : '.'),
    `Next hours: ${w.hourly
      .slice(0, 6)
      .map((h) => `${hm(h.time)} ${t(h.tempC)} ${wmoSummary(h.code)}${h.precipProb ? ` (${h.precipProb}% rain)` : ''}`)
      .join('; ')}.`,
    'Forecast:',
    ...w.daily.map((d) => `- ${d.date}: ${wmoSummary(d.code)}, ${t(d.minC)}–${t(d.maxC)}, sunrise ${hm(d.sunrise)}, sunset ${hm(d.sunset)}`),
  ];
  return lines.join('\n');
}
