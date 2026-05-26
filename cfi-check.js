/**
 * CFI Alert Check — runs inside GitHub Actions every 30 minutes.
 * Replicates the browser calculation engine in pure Node.js.
 * Sends a Telegram message to your phone if CFI > 75 on any route.
 *
 * No dependencies — runs with: node cfi-check.js
 */

"use strict";

// ── Config ────────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN   || "8947755675:AAFMIF3t_VcSNeS_Jd2KWx2G_PBGMRzYSHA";
const TG_CHAT_ID = process.env.TG_CHAT_ID || "8653303114";
const CFI_CRITICAL = 75;

// ── Route database ────────────────────────────────────────────────
const ROUTES = [
  {
    id: "tubaro_qingdao",
    name: "Ponta da Madeira / Tubarão → Qingdao",
    short: "TBR–QDG",
    origin: { port: "Tubarão / Ponta da Madeira", congestion_baseline: 2.4 },
    destination: { port: "Qingdao", country: "China" },
    origin_country: "Brazil",
    typical_voyage_days: 35,
    baseline_rate_usd_ton: 36.25,
    ballast_speed_kn: 12.8,
    leads: [
      { name: "Carlos Drummond",  company: "Austral Mineração S.A.",   email: "c.drummond@australmineracao.com.br" },
      { name: "Fernanda Machado", company: "Minas Rio Trading S.A.",   email: "f.machado@minasriotrading.com" },
    ],
  },
  {
    id: "hedland_qingdao",
    name: "Dampier / Port Hedland → Qingdao",
    short: "PHD–QDG",
    origin: { port: "Port Hedland / Dampier", congestion_baseline: 1.7 },
    destination: { port: "Qingdao", country: "China" },
    origin_country: "Australia",
    typical_voyage_days: 12,
    baseline_rate_usd_ton: 15.45,
    ballast_speed_kn: 13.4,
    leads: [
      { name: "James Whitmore", company: "Pinnacle Resources Pty Ltd",  email: "j.whitmore@pinnacleresources.com.au" },
      { name: "Sarah Chen",     company: "Pacific Iron Holdings Ltd",   email: "s.chen@pacificiron.com.au" },
    ],
  },
];

// ── Simulation engine (mirrors browser logic exactly) ─────────────

function simWeather(portName) {
  const seed   = portName.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hbias  = (new Date().getUTCHours() % 12) / 12;
  const wind_ms = parseFloat((2.5 + ((seed % 11) + hbias * 4.5)).toFixed(1));
  const precip  = parseFloat(((seed % 20) + hbias * 18).toFixed(1));
  const labels  = ["clear sky","light cloud","scattered cloud","overcast","light rain","moderate rain","heavy rain","near gale"];
  const desc    = labels[Math.floor((seed + hbias * 4) % labels.length)];
  return { wind_ms, precip_mm: precip, description: desc };
}

function simSpeed(routeId, baseline) {
  const seed  = routeId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  // Use seeded deterministic noise (no Math.random in Actions — keeps runs comparable)
  const noise = ((seed % 17) - 8) * 0.1;
  return parseFloat(Math.max(8.0, baseline - (seed % 3) * 0.3 + noise).toFixed(2));
}

function simCongestion(portName, baseline) {
  const seed = portName.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const hour = new Date().getUTCHours();
  const peak = (hour >= 8 && hour < 18) ? 1.35 : 0.75;
  const base = baseline + ((seed % 5) - 2) * 0.25;
  return parseFloat(Math.max(0.4, base * peak).toFixed(2));
}

function wetLoadingPenalty(precip_mm) {
  const THRESHOLD = 15;
  if (precip_mm <= THRESHOLD) return 0;
  return parseFloat(Math.min(4.0, (precip_mm - THRESHOLD) * 0.12).toFixed(2));
}

function bafCongestionLift(speedKn) {
  if (speedKn < 11) return 0.22;
  if (speedKn < 12) return 0.14;
  if (speedKn < 13) return 0.06;
  return 0;
}

function deriveWeatherFactor(wind_ms) {
  const kn = wind_ms * 1.944;
  if (kn >= 48) return 0.80;
  if (kn >= 34) return 0.55;
  if (kn >= 22) return 0.32;
  if (kn >= 11) return 0.14;
  return 0.04;
}

function calcRoute(route) {
  const weather     = simWeather(route.origin.port);
  const ballast_spd = simSpeed(route.id, route.ballast_speed_kn);
  const cong_raw    = simCongestion(route.origin.port, route.origin.congestion_baseline);
  const wet_days    = wetLoadingPenalty(weather.precip_mm);
  const baf_lift    = bafCongestionLift(ballast_spd);
  const wind_kn     = parseFloat((weather.wind_ms * 1.944).toFixed(1));

  const congestion_index = parseFloat(Math.min(0.95, (cong_raw / 10) + baf_lift).toFixed(3));
  const beaufort_delay   = wind_kn >= 34 ? 3.5 : wind_kn >= 22 ? 2.2 : wind_kn >= 11 ? 1.1 : 0.5;
  const delay_days       = parseFloat((beaufort_delay + cong_raw + wet_days).toFixed(2));
  const weather_factor   = deriveWeatherFactor(weather.wind_ms);

  const cfi = parseFloat(
    ((delay_days / route.typical_voyage_days) * (1 + congestion_index) * (1 + weather_factor) * 100).toFixed(2)
  );

  const band = cfi > 75 ? "Critical Anomaly" : cfi > 55 ? "High" : cfi > 30 ? "Moderate" : "Low";
  const penalty_per_ton = parseFloat(((cfi / 100) * route.baseline_rate_usd_ton).toFixed(2));

  return {
    cfi, band,
    critical_anomaly: cfi > CFI_CRITICAL,
    penalty_per_ton,
    inputs: {
      delay_days, congestion_index, weather_factor,
      beaufort_delay, congestion_raw: cong_raw, wet_loading_days: wet_days,
      ballast_speed_kn: ballast_spd, baf_lift,
      wind_speed_kn: wind_kn, precip_mm: weather.precip_mm,
      weather_description: weather.description,
      slow_steam_flag: ballast_spd < 12,
    },
  };
}

// ── Telegram messenger ────────────────────────────────────────────

async function sendTelegram(text) {
  const url  = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "Markdown" });

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`[CFI] Check started — ${new Date().toUTCString()}`);

  const results  = ROUTES.map(r => ({ route: r, payload: calcRoute(r) }));
  const crits    = results.filter(r => r.payload.critical_anomaly);
  const allClear = crits.length === 0;

  // Log all scores regardless
  results.forEach(({ route, payload }) => {
    console.log(`[CFI] ${route.short} → CFI ${payload.cfi.toFixed(1)} [${payload.band}] Penalty $${payload.penalty_per_ton}/MT`);
  });

  if (allClear) {
    console.log("[CFI] All routes nominal. No alert sent.");
    return;
  }

  // Build one message covering all critical routes
  const lines = ["⛔ *CFI CRITICAL ANOMALY ALERT*", ""];

  for (const { route, payload: p } of crits) {
    const leadList = route.leads.map(l => `  • ${l.name} — ${l.company}`).join("\n");
    lines.push(
      `*Route:* ${route.name}`,
      `*CFI Score:* ${p.cfi.toFixed(1)} \\[threshold: ${CFI_CRITICAL}\\]`,
      `*Band:* ${p.band}`,
      `*Penalty/MT:* $${p.penalty_per_ton.toFixed(2)} vs $${route.baseline_rate_usd_ton} baseline`,
      ``,
      `*Inputs:*`,
      `  Delay: ${p.inputs.delay_days.toFixed(2)}d | Congestion: ${p.inputs.congestion_index.toFixed(3)}`,
      `  Wind: ${p.inputs.wind_speed_kn.toFixed(1)} kn | ${p.inputs.weather_description}`,
      p.inputs.slow_steam_flag ? `  ⚠ Slow-steam detected: ${p.inputs.ballast_speed_kn.toFixed(1)} kn` : null,
      p.inputs.wet_loading_days > 0 ? `  ⚠ Wet-load shutdown risk: ${p.inputs.wet_loading_days.toFixed(2)}d` : null,
      ``,
      `*Tier 1 Targets:*`,
      leadList,
      ``,
      `──────────────────`,
      ``,
    );
  }

  lines.push(
    `🕐 ${new Date().toUTCString().replace("GMT", "UTC")}`,
    `_Open dashboard → Generate Outreach → Send_`,
  );

  const message = lines.filter(l => l !== null).join("\n");

  try {
    await sendTelegram(message);
    console.log("[CFI] Telegram alert sent successfully.");
  } catch (err) {
    console.error("[CFI] Failed to send Telegram alert:", err.message);
    process.exit(1);
  }
}

main();
