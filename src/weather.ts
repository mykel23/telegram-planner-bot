import { getState, setState } from "./db";
import type { Env } from "./env";
import { escapeHtml } from "./format";

/**
 * One line of weather for the morning message, from Open-Meteo
 * (free, no account or key needed). The place is set once with /weather.
 */

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

const PLACE_KEY = "weather_place";

export async function getPlace(env: Env): Promise<Place | null> {
  const raw = await getState(env.DB, PLACE_KEY);
  return raw ? (JSON.parse(raw) as Place) : null;
}

export async function setPlace(env: Env, place: Place): Promise<void> {
  await setState(env.DB, PLACE_KEY, JSON.stringify(place));
}

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  admin1?: string;
  country_code?: string;
}

/** Looks up "Houston", "Houston, TX" or "Austin, Texas". */
export async function findPlace(query: string): Promise<Place | null> {
  const [city, region] = query.split(",").map((s) => s.trim());
  if (!city) return null;
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(city)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const results = ((await res.json()) as { results?: GeoResult[] }).results ?? [];
  if (results.length === 0) return null;
  const wanted = region ? (US_STATES[region.toUpperCase()] ?? region).toLowerCase() : null;
  const match =
    (wanted && results.find((r) => r.admin1?.toLowerCase() === wanted || r.country_code?.toLowerCase() === wanted)) ||
    results.find((r) => r.country_code === "US") ||
    results[0];
  return { name: match.admin1 ? `${match.name}, ${match.admin1}` : match.name, lat: match.latitude, lon: match.longitude };
}

/** WMO weather codes, as Open-Meteo returns them. */
export function describeWeather(code: number): { icon: string; text: string } {
  if (code === 0) return { icon: "☀️", text: "clear" };
  if (code <= 2) return { icon: "🌤", text: "partly cloudy" };
  if (code === 3) return { icon: "☁️", text: "cloudy" };
  if (code <= 48) return { icon: "🌫", text: "foggy" };
  if (code <= 57) return { icon: "🌦", text: "drizzle" };
  if (code <= 67) return { icon: "🌧", text: "rain" };
  if (code <= 77) return { icon: "🌨", text: "snow" };
  if (code <= 82) return { icon: "🌧", text: "rain showers" };
  if (code <= 86) return { icon: "🌨", text: "snow showers" };
  return { icon: "⛈", text: "thunderstorms" };
}

export interface DailyForecast {
  high: number;
  low: number;
  rainChance: number | null;
  code: number;
}

export function weatherLine(place: Place, f: DailyForecast): string {
  const { icon, text } = describeWeather(f.code);
  const rain = f.rainChance != null && f.rainChance >= 20 ? `, ${f.rainChance}% chance of rain` : "";
  const city = place.name.split(",")[0];
  return `${icon} <b>${escapeHtml(city)}:</b> ${text}, ${Math.round(f.low)}° to ${Math.round(f.high)}°F${rain}`;
}

export async function fetchForecast(place: Place, timeZone: string): Promise<DailyForecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&temperature_unit=fahrenheit&forecast_days=1&timezone=${encodeURIComponent(timeZone)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast failed (${res.status})`);
  const d = ((await res.json()) as {
    daily: {
      weather_code: number[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_probability_max?: (number | null)[];
    };
  }).daily;
  return {
    code: d.weather_code[0],
    high: d.temperature_2m_max[0],
    low: d.temperature_2m_min[0],
    rainChance: d.precipitation_probability_max?.[0] ?? null,
  };
}

/** The morning message's weather line, a nudge to set a city, or "" if the forecast is unavailable. */
export async function morningWeather(env: Env): Promise<string> {
  const place = await getPlace(env);
  if (!place) return `🌤 <i>Send /weather to add your city's forecast here.</i>`;
  try {
    return weatherLine(place, await fetchForecast(place, env.TIMEZONE));
  } catch (err) {
    console.error("weather failed", err);
    return "";
  }
}

export const WEATHER_QUESTION =
  `🌤 <b>Which city should I check the weather for?</b>\n` +
  `Type your city (like <i>Houston, TX</i>), or tap <b>📍 Share my location</b>.`;
