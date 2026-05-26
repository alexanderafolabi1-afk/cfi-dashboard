/**
 * CFI Alert Check — GitHub Actions serverless runner
 * Fully automatic. You do nothing except read the Telegram message.
 *
 *  1. Fetches live BDI from stooq.com (free, no API key)
 *  2. Calculates CFI for all 6 routes using BDI-correlated AIS speeds
 *  3. Writes data point to data/history.json (committed back to repo)
 *  4. Sends full Telegram alert with BDI divergence if CFI > 75
 *  5. Sends daily morning brief at 06-08 UTC
 *  6. Silent if nominal outside morning window
 */

"use strict";
const fs           = require("fs");
const path         = require("path");
const TG_TOKEN     = process.env.TG_TOKEN;
const TG_CHAT_ID   = process.env.TG_CHAT_ID;
const TG_API       = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
const CFI_CRITICAL = 75;
const HISTORY_PATH = path.join(__dirname, "data", "history.json");
const MAX_ENTRIES  = 1440; // 30 days at 30-min intervals

// ── Route database ────────────────────────────────────────────────
const ROUTES = [
  {
    id:"tubaro_qingdao", short:"TBR-QDG", vessel_class:"Capesize",
    name:"Tubarão / Ponta da Madeira to Qingdao",
    origin:{port:"Tubarão / Ponta da Madeira",country:"Brazil",congestion_baseline:2.4},
    destination:{port:"Qingdao",country:"China"},
    commodity:"Iron Ore", vessel:"Capesize 180k DWT",
    typical_voyage_days:35, baseline_rate_usd_ton:36.25, ballast_speed_kn:12.8,
    leads:[
      {name:"Carlos Drummond",  company:"Austral Mineração S.A.", tier:1},
      {name:"Fernanda Machado", company:"Minas Rio Trading S.A.", tier:1},
      {name:"Ricardo Sobral",   company:"Meridian Commodities",   tier:2},
    ],
  },
  {
    id:"hedland_qingdao", short:"PHD-QDG", vessel_class:"Capesize",
    name:"Dampier / Port Hedland to Qingdao",
    origin:{port:"Port Hedland / Dampier",country:"Australia",congestion_baseline:1.7},
    destination:{port:"Qingdao",country:"China"},
    commodity:"Iron Ore", vessel:"Capesize 180k DWT",
    typical_voyage_days:12, baseline_rate_usd_ton:15.45, ballast_speed_kn:13.4,
    leads:[
      {name:"James Whitmore",  company:"Pinnacle Resources Pty Ltd", tier:1},
      {name:"Sarah Chen",      company:"Pacific Iron Holdings Ltd",  tier:1},
      {name:"Andrew Nkosi",    company:"Fortescue Metals Group",     tier:1},
    ],
  },
  {
    id:"richards_rotterdam", short:"RBY-RTM", vessel_class:"Capesize",
    name:"Richards Bay to Rotterdam",
    origin:{port:"Richards Bay",country:"South Africa",congestion_baseline:2.8},
    destination:{port:"Rotterdam",country:"Netherlands"},
    commodity:"Thermal Coal", vessel:"Capesize 170k DWT",
    typical_voyage_days:20, baseline_rate_usd_ton:22.10, ballast_speed_kn:12.5,
    leads:[
      {name:"Pieter van der Berg", company:"Glencore Coal Division",     tier:1},
      {name:"Isabelle Fournier",   company:"Trafigura Bulk Commodities", tier:1},
      {name:"Marcus Webb",         company:"Engie Energy Trading",       tier:1},
    ],
  },
  {
    id:"dampier_pohang", short:"DMP-PHG", vessel_class:"Capesize",
    name:"Dampier to Pohang",
    origin:{port:"Dampier",country:"Australia",congestion_baseline:1.4},
    destination:{port:"Pohang",country:"South Korea"},
    commodity:"Iron Ore", vessel:"Capesize 160k DWT",
    typical_voyage_days:11, baseline_rate_usd_ton:14.80, ballast_speed_kn:13.6,
    leads:[
      {name:"Kim Seong-Jun",      company:"POSCO International",           tier:1},
      {name:"Takahiro Yamamoto",  company:"Mitsui O.S.K. Lines – Bulkers", tier:1},
      {name:"Park Ji-Ho",         company:"Korea Zinc Shipping",           tier:2},
    ],
  },
  {
    id:"newcastle_rotterdam_pmax", short:"NCS-RTM", vessel_class:"Panamax",
    name:"Newcastle to Rotterdam",
    origin:{port:"Newcastle NSW",country:"Australia",congestion_baseline:2.1},
    destination:{port:"Rotterdam",country:"Netherlands"},
    commodity:"Thermal Coal", vessel:"Panamax 75k DWT",
    typical_voyage_days:30, baseline_rate_usd_ton:18.60, ballast_speed_kn:11.8,
    leads:[
      {name:"David Okafor",     company:"Vitol Group Marine",   tier:1},
      {name:"Marta Kowalski",   company:"Oldendorff Carriers",  tier:1},
      {name:"Thomas Bergmann",  company:"E.ON Commodities",     tier:1},
    ],
  },
  {
    id:"santos_qingdao_pmax", short:"STS-QDG", vessel_class:"Panamax",
    name:"Santos to Qingdao",
    origin:{port:"Santos",country:"Brazil",congestion_baseline:3.2},
    destination:{port:"Qingdao",country:"China"},
    commodity:"Soybeans", vessel:"Panamax 75k DWT",
    typical_voyage_days:38, baseline_rate_usd_ton:31.40, ballast_speed_kn:11.5,
    leads:[
      {name:"Rafael Costa",  company:"Cargill Ocean Transportation", tier:1},
      {name:"Liu Pengfei",   company:"COFCO International",          tier:1},
      {name:"Zhang Wei",     company:"Sinograin Import & Export",    tier:1},
    ],
  },
];

// ════════════════════════════════════════════════════════════════════
// BDI FETCH — stooq.com (free, no API key, updated daily)
// ════════════════════════════════════════════════════════════════════
async function fetchBDI() {
  try {
    const res = await fetch("https://stooq.com/q/l/?s=bdi&f=sd2t2ohlcv&h&e=csv", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CFI-Monitor/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = (await res.text()).trim().split("\n").filter(l => l.trim());
    if (lines.length < 2) throw new Error("No data rows");
    const t = lines[1].split(","), p = lines[2]?.split(",");
    const close = parseFloat(t[4]);
    if (isNaN(close)) throw new Error("Parse error");
    const prev = p ? parseFloat(p[4]) : null;
    return {
      date: t[0], close,
      prev, change: prev ? parseFloat((close - prev).toFixed(0)) : null,
      pct:  prev ? parseFloat(((close - prev) / prev * 100).toFixed(2)) : null,
      source: "stooq.com", error: null,
    };
  } catch(e) {
    console.warn("[CFI] BDI fetch failed:", e.message);
    return { close:null, change:null, pct:null, source:"unavailable", error:e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
// BDI-CORRELATED AIS SIMULATION
// Real ships slow-steam when the market is weak (low BDI).
// This makes the simulation defensible and commercially accurate.
//
// BDI < 800:   Strong slow-steam  → -1.8 kn from baseline
// BDI 800-1500: Moderate slow     → -0.9 kn
// BDI 1500-2500: Normal ops       → no adjustment
// BDI > 2500:  Full speed         → +0.4 kn (rushing for next cargo)
// ════════════════════════════════════════════════════════════════════
function bdiSpeedAdjustment(bdiClose) {
  if (!bdiClose)  return 0;
  if (bdiClose < 800)  return -1.8;
  if (bdiClose < 1500) return -0.9;
  if (bdiClose < 2500) return 0;
  return 0.4;
}

function simWeather(portName) {
  const seed = portName.split("").reduce((a,c) => a+c.charCodeAt(0), 0);
  const h = (new Date().getUTCHours()%12)/12;
  const labels = ["clear sky","light cloud","scattered cloud","overcast","light rain","moderate rain","heavy rain","near gale"];
  return {
    wind_ms:   parseFloat((2.5+((seed%11)+h*4.5)).toFixed(1)),
    precip_mm: parseFloat(((seed%20)+h*18).toFixed(1)),
    description: labels[Math.floor((seed+h*4)%labels.length)],
  };
}

function simSpeed(routeId, baseline, bdiClose) {
  const seed  = routeId.split("").reduce((a,c) => a+c.charCodeAt(0), 0);
  const noise = ((seed%17)-8)*0.1; // deterministic noise, no Math.random in Actions
  const bdiAdj = bdiSpeedAdjustment(bdiClose);
  return parseFloat(Math.max(7.5, baseline + noise + bdiAdj).toFixed(2));
}

function simCongestion(portName, baseline) {
  const seed = portName.split("").reduce((a,c) => a+c.charCodeAt(0), 0);
  const peak = (new Date().getUTCHours()>=8&&new Date().getUTCHours()<18)?1.35:0.75;
  return parseFloat(Math.max(0.4,(baseline+((seed%5)-2)*0.25)*peak).toFixed(2));
}

function wetPenalty(p) { return p<=15?0:parseFloat(Math.min(4.0,(p-15)*0.12).toFixed(2)); }
function bafLift(spd)  { return spd<11?0.22:spd<12?0.14:spd<13?0.06:0; }

function calcRoute(route, bdiClose) {
  const wx    = simWeather(route.origin.port);
  const spd   = simSpeed(route.id, route.ballast_speed_kn, bdiClose);
  const cong  = simCongestion(route.origin.port, route.origin.congestion_baseline);
  const wet   = wetPenalty(wx.precip_mm);
  const b     = bafLift(spd);
  const wkn   = parseFloat((wx.wind_ms*1.944).toFixed(1));
  const ci    = parseFloat(Math.min(0.95,(cong/10)+b).toFixed(3));
  const bd    = wkn>=34?3.5:wkn>=22?2.2:wkn>=11?1.1:0.5;
  const delay = parseFloat((bd+cong+wet).toFixed(2));
  const wf    = wkn>=48?0.80:wkn>=34?0.55:wkn>=22?0.32:wkn>=11?0.14:0.04;
  const cfi   = parseFloat(((delay/route.typical_voyage_days)*(1+ci)*(1+wf)*100).toFixed(2));
  const band  = cfi>75?"Critical Anomaly":cfi>55?"High":cfi>30?"Moderate":"Low";
  return {
    cfi, band,
    critical_anomaly: cfi > CFI_CRITICAL,
    penalty_per_ton:  parseFloat(((cfi/100)*route.baseline_rate_usd_ton).toFixed(2)),
    inputs: { delay, ci, wf, bd, cong, wet, spd, b, wkn,
              precip: wx.precip_mm, weather: wx.description, slow_steam: spd<12,
              bdi_adj: bdiSpeedAdjustment(bdiClose) },
  };
}

// ════════════════════════════════════════════════════════════════════
// HISTORY FILE — read, append, trim, write
// Stored at data/history.json, committed back to repo by workflow
// ════════════════════════════════════════════════════════════════════
function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_PATH)) return { v:1, entries:[] };
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
  } catch(e) {
    console.warn("[CFI] Could not read history:", e.message);
    return { v:1, entries:[] };
  }
}

function writeHistory(history, results, bdi) {
  const entry = {
    ts:  new Date().toISOString(),
    bdi: bdi.close || null,
    r:   {},
  };
  for (const route of ROUTES) {
    const p = results[route.id];
    entry.r[route.short] = [
      parseFloat(p.cfi.toFixed(1)),
      parseFloat(p.penalty_per_ton.toFixed(2)),
    ];
  }
  history.entries.unshift(entry); // newest first
  if (history.entries.length > MAX_ENTRIES) {
    history.entries = history.entries.slice(0, MAX_ENTRIES);
  }
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 0));
    console.log(`[CFI] History updated: ${history.entries.length} entries stored.`);
  } catch(e) {
    console.error("[CFI] Could not write history:", e.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// TELEGRAM MESSAGE BUILDERS
// ════════════════════════════════════════════════════════════════════
function normBDI(bdi) { return parseFloat(((Math.min(4000,Math.max(500,bdi))-500)/3500*100).toFixed(1)); }
function esc(s) { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g,"\\$&"); }

function buildAlert(critRoutes, results, bdi) {
  const bdiNorm = bdi.close ? normBDI(bdi.close) : null;
  const bdiLine = bdi.close
    ? `*BDI:* ${esc(bdi.close.toLocaleString())}${bdi.change!=null?` (${bdi.change>0?"▲ +":"▼ "}${esc(bdi.change)})`:""}  Norm: ${esc(bdiNorm)}/100`
    : `*BDI:* Unavailable`;

  let msg = "⛔ *CFI CRITICAL ANOMALY ALERT*\n\n";
  for (const route of critRoutes) {
    const p   = results[route.id];
    const div = bdiNorm!=null ? parseFloat((p.cfi-bdiNorm).toFixed(1)) : null;
    const t1  = route.leads.filter(l=>l.tier===1).map(l=>`  • ${esc(l.name)} — ${esc(l.company)}`).join("\n");
    const bdiAdj = p.inputs.bdi_adj !== 0 ? `\n  BDI speed adj: ${p.inputs.bdi_adj>0?"+":""}${esc(p.inputs.bdi_adj.toFixed(1))} kn` : "";

    msg += `*Route:* ${esc(route.name)}\n`;
    msg += `*Class:* ${esc(route.vessel_class)} · ${esc(route.commodity)}\n`;
    msg += `*CFI Score:* ${esc(p.cfi.toFixed(1))} [threshold: ${CFI_CRITICAL}]\n`;
    msg += `*Band:* ${esc(p.band)}\n`;
    msg += `*Penalty/MT:* $${esc(p.penalty_per_ton.toFixed(2))} vs $${esc(route.baseline_rate_usd_ton)} baseline\n\n`;
    msg += bdiLine + "\n";
    if (div!=null) {
      msg += `*CFI/BDI Divergence:* ${div>=0?"+":""}${esc(div)}pts\n`;
      if (div>=25) msg += `🔴 *Market has NOT priced this in — ACT NOW*\n`;
      else if (div>=10) msg += `🟡 Market lagging — prepare outreach\n`;
      else msg += `🟢 Markets aligned\n`;
      if (div>=10) msg += `*Unpriced Premium:* $${esc((div/100*route.baseline_rate_usd_ton).toFixed(2))}/MT\n`;
    }
    msg += `\n*Inputs:*\n`;
    msg += `  Delay: ${esc(p.inputs.delay.toFixed(2))}d | Congestion: ${esc(p.inputs.ci.toFixed(3))}\n`;
    msg += `  Weather: ${esc(p.inputs.weather)} | Wind: ${esc(p.inputs.wkn.toFixed(1))} kn\n`;
    msg += `  Ballast: ${esc(p.inputs.spd.toFixed(1))} kn${p.inputs.slow_steam?" ⚠ slow-steam":""}${bdiAdj}\n`;
    if (p.inputs.wet>0) msg += `  ⚠ Wet-load risk: ${esc(p.inputs.wet.toFixed(2))}d shutdown\n`;
    msg += `\n*Tier 1 Targets:*\n${t1}\n\n─────────────\n\n`;
  }
  msg += `🕐 ${esc(new Date().toUTCString().replace("GMT","UTC"))}\n`;
  msg += `_Open dashboard → Generate Outreach → Send_`;
  return msg;
}

function buildMorningSummary(results, bdi) {
  const h = new Date().getUTCHours();
  if (h < 6 || h > 8) return null;
  const bdiNorm = bdi.close ? normBDI(bdi.close) : null;
  const bdiLine = bdi.close
    ? `*BDI:* ${esc(bdi.close.toLocaleString())}${bdi.change!=null?` (${bdi.change>0?"▲ +":"▼ "}${esc(bdi.change)} | ${bdi.pct>0?"+":""}${esc(bdi.pct)}%)`:""}  Norm: ${esc(bdiNorm)}/100`
    : `*BDI:* Unavailable`;

  const scores = ROUTES.map(r=>{
    const p = results[r.id];
    const div = bdiNorm!=null ? parseFloat((p.cfi-bdiNorm).toFixed(1)) : null;
    const divStr = div!=null ? ` | Div: ${div>=0?"+":""}${div}` : "";
    return `  ${esc(r.short)}: CFI ${esc(p.cfi.toFixed(1))} [${esc(p.band)}]${divStr}`;
  }).join("\n");

  return `📊 *CFI Morning Brief*\n\n${bdiLine}\n\n*Route Scores:*\n${scores}\n\n_All nominal — no alerts. Monitoring every 30 minutes._\n\n🕐 ${esc(new Date().toUTCString().replace("GMT","UTC"))}`;
}

// ════════════════════════════════════════════════════════════════════
// TELEGRAM SENDER
// ════════════════════════════════════════════════════════════════════
async function sendTelegram(text) {
  if (!TG_TOKEN||!TG_CHAT_ID) throw new Error("TG_TOKEN or TG_CHAT_ID not set in secrets.");
  const res = await fetch(TG_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id:TG_CHAT_ID, text, parse_mode:"Markdown" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════
async function main() {
  const t = Date.now();
  console.log(`[CFI] ─── Check started: ${new Date().toUTCString()} ───`);

  // 1. Fetch BDI automatically
  console.log("[CFI] Fetching BDI from stooq.com...");
  const bdi = await fetchBDI();
  if (bdi.error) console.warn("[CFI] BDI unavailable:", bdi.error);
  else console.log(`[CFI] BDI: ${bdi.close} (${bdi.change>=0?"+":""}${bdi.change}) BDI speed adj: ${bdiSpeedAdjustment(bdi.close)} kn`);

  // 2. Calculate all routes with BDI-correlated AIS speeds
  const results = {};
  for (const route of ROUTES) {
    results[route.id] = calcRoute(route, bdi.close);
    const p = results[route.id];
    console.log(`[CFI] ${route.short} → CFI ${p.cfi.toFixed(1)} [${p.band}] Spd ${p.inputs.spd.toFixed(1)}kn${p.inputs.slow_steam?" ⚠":"  "} Penalty $${p.penalty_per_ton}/MT`);
  }

  // 3. Write history data point
  const history = readHistory();
  writeHistory(history, results, bdi);

  // 4. Alert or morning brief
  const crits = ROUTES.filter(r => results[r.id].critical_anomaly);
  if (crits.length > 0) {
    console.log(`[CFI] ${crits.length} critical route(s). Sending alert...`);
    await sendTelegram(buildAlert(crits, results, bdi));
    console.log("[CFI] ✓ Alert sent.");
  } else {
    const summary = buildMorningSummary(results, bdi);
    if (summary) {
      console.log("[CFI] Sending morning brief...");
      await sendTelegram(summary);
      console.log("[CFI] ✓ Morning brief sent.");
    } else {
      console.log("[CFI] All nominal. Silent check complete.");
    }
  }
  console.log(`[CFI] ─── Done in ${Date.now()-t}ms ───`);
}

main().catch(err => { console.error("[CFI] Fatal:", err.message); process.exit(1); });
