// admin-overview — ADMIN ONLY. Read-only aggregate of every user's yard so an
// operator can see exactly what each customer sees in their app.
//
// Safety: requires a signed-in user whose profile has is_admin = true. All data
// is READ via the service role (no writes to any user record), so this has zero
// effect on any user's experience. It does not touch report-v2 or the app.
//
// The per-plant status/advice logic below mirrors report-v2 so the admin view
// matches the customer's app. Keep in sync if report-v2's catalog changes.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// --- catalog + logic mirrored from report-v2 ---
const profiles = {
  citrus:{size:"large",low:35,high:55,species:"citrus",why:"Citrus prefers consistent moisture but tolerates moderate drying. Chronic saturation invites root and crown rot."},
  avocado:{size:"large",low:40,high:60,species:"avocado",why:"Avocados have shallow feeder roots: they hate drought AND wet feet. Sustained high moisture = Phytophthora root rot."},
  camellia:{size:"medium",low:35,high:50,species:"camellia",why:"Camellias are more often killed by over-watering than under. Moderate, even moisture."},
  hydrangea:{size:"medium",low:40,high:60,species:"hydrangea",why:"Hydrangea needs consistently moist, well-drained soil and wilts visibly when dry."},
  rosemary:{size:"small",low:18,high:35,species:"rosemary",why:"Mediterranean drought-adapted shrub. Roots need air between waterings."},
  westringia:{size:"small",low:20,high:38,species:"westringia",why:"Australian coast rosemary — drought-tolerant. Needs the soil to dry between deep waterings."},
  lavender:{size:"small",low:20,high:38,species:"lavender",why:"Mediterranean and drought-tolerant; excellent drainage is non-negotiable."},
  bay_laurel:{size:"medium",low:22,high:40,species:"bay-laurel",why:"Established bay laurel adapts to low water. Deep, infrequent watering."},
  star_jasmine:{size:"medium",low:30,high:50,species:"star-jasmine",why:"Established star jasmine needs modest, periodic irrigation."},
  boxwood:{size:"medium",low:28,high:50,species:"boxwood",why:"Boxwood prefers slow, deep watering over frequent shallow."},
  convolvulus:{size:"small",low:20,high:40,species:"convolvulus",why:"Silverbush — drought-tolerant once established. Sustained moisture above 40% causes root rot."},
  carrotwood:{size:"large",low:25,high:45,species:"carrotwood",why:"Moderate water use (WUCOLS), drought-tolerant once established. Deep, infrequent irrigation; above ~45% in clay risks root rot."},
  lemon:{size:"large",low:40,high:60,species:"lemon",why:"Moderate-water citrus, shallow roots. Keep evenly moist 40-60%; above ~60% in clay risks root/crown rot."},
  tomato:{size:"medium",low:45,high:65,species:"tomato",why:"Steady even moisture for fruit set; avoid drought stress and soggy soil."},
  rose:{size:"medium",low:40,high:60,species:"rose",why:"Deep regular water with good drainage; evenly moist, never waterlogged."},
  succulent:{size:"small",low:10,high:25,species:"succulent",why:"Let soil dry almost completely between waterings; low moisture is healthy."},
  fern:{size:"medium",low:50,high:70,species:"fern",why:"Consistently moist humus-rich soil; resents drying out."},
  olive:{size:"large",low:18,high:38,species:"olive",why:"Mediterranean, very drought-tolerant; dry well between deep infrequent waterings."},
  bougainvillea:{size:"large",low:20,high:40,species:"bougainvillea",why:"Blooms best on the dry side; deep but infrequent water."},
  japanese_maple:{size:"medium",low:40,high:60,species:"japanese_maple",why:"Cool, consistently moist (not soggy) soil; scorches if it dries out."},
  hibiscus:{size:"medium",low:40,high:60,species:"hibiscus",why:"Regular even moisture in warm weather with good drainage."},
  blueberry:{size:"medium",low:45,high:65,species:"blueberry",why:"Shallow roots; consistently moist acidic well-drained soil."},
  agave:{size:"small",low:8,high:22,species:"agave",why:"Xeric — deep but rare water; let soil dry completely."},
  unknown:{size:"medium",low:25,high:45,species:"unknown",why:"Species not yet set."},
};
const prof = (k) => profiles[k] || profiles.unknown;

async function getGw(appKey, apiKey, mac) {
  const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(mac)}&call_back=all`;
  // Retry on empty/failed responses so a transient Ecowitt blip can't falsely
  // mark sensors (or a whole gateway) offline.
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.ok) { const j = await r.json(); if (j.code === 0 && j.data && Object.keys(j.data).length) return j.data; } }
    catch (_) {}
    if (i < 2) await new Promise(res => setTimeout(res, 500 * (i + 1)));
  }
  return {};
}
function wateringPlan(p, m, low, high) {
  const ladder = { small:{light:{min:3,galLo:0.5,galHi:1},moderate:{min:7,galLo:1.5,galHi:3},deep:{min:12,galLo:3,galHi:5}},
    medium:{light:{min:5,galLo:1,galHi:2},moderate:{min:12,galLo:4,galHi:6},deep:{min:20,galLo:6,galHi:10}},
    large:{light:{min:8,galLo:2,galHi:4},moderate:{min:18,galLo:6,galHi:10},deep:{min:30,galLo:12,galHi:18}}};
  const tier = ladder[p.size]||ladder.medium; const gap=low-m; let lvl,lbl;
  if(gap>=10){lvl="deep";lbl="Deep slow soak";}else if(gap>=5){lvl="moderate";lbl="Moderate watering";}else if(gap>0){lvl="light";lbl="Light watering";}else return null;
  const w=tier[lvl]; const target=Math.round((low+high)/2);
  return `${lbl}: ~${w.min} min of drip or ~${w.galLo}-${w.galHi} gal. Aim for ~${target}%.`;
}
function advise(p,m,low,high){
  if(m<low){const gap=low-m,vd=gap>=12;let a;if(gap>=10)a="Deep-water today";else if(gap>=5)a="Water today";else a="Water lightly today";
    return {status:vd?"very_dry":"dry",headline:vd?"VERY DRY":"Dry",advice:`${a} — at ${Math.round(m)}% you're ${Math.round(gap)}% below the ${low}% floor.`};}
  if(m>high)return {status:"too_wet",headline:"Too wet",advice:`Hold off — at ${Math.round(m)}% you're ${Math.round(m-high)}% above the ${high}% ceiling.`};
  return {status:"good",headline:"Good",advice:`In range — at ${Math.round(m)}% you're inside the ideal ${low}-${high}% band.`};
}

// ── Sensor troubleshooting (WH51 soil sensors) ──────────────────────────────
// Thresholds key off soilbatt VOLTAGE (WH51 reports real volts).
const TH = { batt_good_min: 1.30, batt_critical_max: 1.10, batt_offline_floor: 1.00, stale_after_sec: 300, transmit_interval_sec: 70 };
function batteryClass(v) {
  if (v == null) return "unknown";
  if (v <= TH.batt_critical_max) return "critical";
  if (v < TH.batt_good_min) return "low";
  return "good";
}
const L91 = "Replace with an Energizer Ultimate Lithium L91 (AA). It holds a flat ~1.5V with low internal resistance from -40 to 60°C, so it won't sag and drop offline on hot afternoons like a partly-drained alkaline. Do NOT use rechargeable NiMH (~1.2V — trips the low-battery flag immediately).";

// Last valid reading time for an offline sensor (tiered Ecowitt history).
function laStamp(d){const p=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);const g=t=>p.find(x=>x.type===t).value;return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;}
async function lastValidTs(appKey,apiKey,mac,ch,days){try{const end=new Date(Date.now());const start=new Date(Date.now()-days*864e5);const url=`https://api.ecowitt.net/api/v3/device/history?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(mac)}&start_date=${encodeURIComponent(laStamp(start))}&end_date=${encodeURIComponent(laStamp(end))}&cycle_type=auto&call_back=soil_ch${ch}`;const r=await fetch(url);if(!r.ok)return null;const j=await r.json();const list=j?.data?.["soil_ch"+ch]?.soilmoisture?.list||{};let last=null;for(const k of Object.keys(list)){const val=list[k];if(val!==null&&val!=="-"&&val!==""){const t=parseInt(k,10);if(Number.isFinite(t)&&(last===null||t>last))last=t;}}return last?new Date(last*1000).toISOString():null;}catch{return null;}}

// Per-sensor diagnosis. First match wins.
function diagnose(r, gatewayDown) {
  const off = r.moisture == null;
  const bc = r.battery_class;
  const v = r.battery != null ? `${r.battery}V` : "unknown";
  if (gatewayDown) return { severity:"critical", category:"gateway_down",
    headline:"Gateway offline — every sensor on this hub is dark",
    detail:"All sensors on this gateway stopped at the same time. This is a hub-level outage (power / Wi-Fi), not a sensor fault — fix the gateway, don't dispatch per-sensor work.",
    fix_steps:["Check the gateway's Wi-Fi LED on site: off = no power/router; slow flash = on Wi-Fi but not reaching Ecowitt; solid = healthy.","Power-cycle the gateway (unplug 10s, replug). If it keeps dropping, swap the USB power brick + cable for a known-good 5V supply — a weak adapter is the #1 cause.","If the LED is off: reboot the router, confirm 2.4GHz is available (Ecowitt is 2.4GHz only), keep the hub away from metal.","Once back online, update firmware. On a GW3000B, the wired Ethernet port is the most reliable."],
    needs_battery:false };
  if (off) return { severity:"critical", category:"offline_sensor",
    headline:"Sensor offline — check battery, seating & signal",
    detail:`Channel ${r.channel} stopped reporting while the gateway and its other sensors are fine, so it's this one sensor. The battery can't be read while it's dark — for a WH51 the most common cause is a flat or poorly-contacting battery, then a dislodged probe or weak signal.`,
    fix_steps:["Bring a fresh Energizer Ultimate Lithium L91 (AA) — swap it in and watch the red LED blink. A flat/contact battery is the #1 WH51 dropout cause.","If the battery was fine: power-cycle (pull AA, wait 30s, reinsert), and clean any corrosion on the contacts; re-tension the spring.","If still dark after ~5 min, re-register the channel: Ecowitt / WS View app → Sensors ID → the WH51 channel → Re-register.","Still nothing? Move the gateway closer / higher and away from metal, then re-register — range/obstructions can drop a single sensor."],
    needs_battery:true };
  // Online from here.
  if (bc === "low" || bc === "critical") return { severity:"warning", category:"low_batt",
    headline: bc === "critical" ? "Battery critical — replace now before it drops offline" : "Battery getting low — replace soon",
    detail:`Still reporting, but battery is ${v}. WH51s brown out under ~1.0V, and a draining alkaline sags in afternoon heat and drops offline. Replace proactively.`,
    fix_steps:["Swap the AA for an Energizer Ultimate Lithium L91 — flat voltage that won't sag in heat.","Avoid rechargeable NiMH (~1.2V trips low-battery immediately)."],
    needs_battery:true };
  if (r.status === "too_wet") return { severity:"info", category:"welfare_wet",
    headline:"Overwatered — sensor is healthy", detail:`Moisture ${Math.round(r.moisture)}% is above the ideal band. A plant-care item, not a fault.`,
    fix_steps:["Hold/reduce irrigation for this zone.","If it stays high, check drainage or a stuck valve."], needs_battery:false };
  if (r.status === "very_dry") return { severity:"warning", category:"welfare_dry",
    headline:"Very dry — sensor is healthy", detail:`Moisture ${Math.round(r.moisture)}% is well below the ideal band. Hardware is fine; this is a watering item.`,
    fix_steps:["Water this zone / check the irrigation schedule.","If it doesn't track up after watering, confirm the probe is fully in soil (no air gap)."], needs_battery:false };
  if (r.status === "dry") return { severity:"info", category:"welfare_dry",
    headline:"Dry — sensor is healthy", detail:`Moisture ${Math.round(r.moisture)}% is below the ideal band.`,
    fix_steps:["Water this zone soon / check the schedule."], needs_battery:false };
  if (r.status === "unassigned") return { severity:"info", category:"unassigned",
    headline:"No plant type set", detail:"Reporting fine, but no plant type — so no watering advice yet.",
    fix_steps:["Set the plant type in the app to enable advice."], needs_battery:false };
  return { severity:"ok", category:"healthy", headline:"Healthy", detail:`Reporting normally; battery ${v}.`, fix_steps:[], needs_battery:false };
}
const SEV_RANK = { critical:0, warning:1, info:2, ok:3 };
const CAT_RANK = { gateway_down:0, offline_sensor:1, low_batt:2, welfare_dry:3, welfare_wet:4, unassigned:5, healthy:6 };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const SUPA = Deno.env.get("SUPABASE_URL");
    const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // Who is calling?
    const ur = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
    const user = ur.ok ? await ur.json() : null;
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    // Read helper (service role — read-only).
    const svc = async (path) => {
      const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      return r.ok ? await r.json() : [];
    };

    // Admin gate.
    const me = await svc(`profiles?id=eq.${user.id}&select=is_admin`);
    if (!me?.[0]?.is_admin) return json({ error: "Not authorized" }, 403);

    // Load everything (read-only).
    const [profs, accounts, gateways, zones, plants, customProfiles, shareRows] = await Promise.all([
      svc("profiles?select=id,email,garden_name,onboarded,is_admin,last_active_at&order=email"),
      svc("ecowitt_accounts?select=user_id,app_key,api_key"),
      svc("gateways?select=id,user_id,mac,name"),
      svc("zones?select=id,name"),
      svc("plants?select=user_id,gateway_id,channel,name,species,zone_id,ideal_low,ideal_high,display_order"),
      svc("species_profiles?select=user_id,key,label,ideal_low,ideal_high,why,size"),
      svc("garden_shares?select=owner_id,guest_id,expires_at,revoked_at"),
    ]);
    // Guest viewers (garden_shares): show them with the OWNER's garden — the
    // same sensors, names and order the owner's card shows — instead of an
    // empty "0 sensors / not set up" card.
    const aliasOf = {};
    for (const s of (shareRows || [])) {
      if (s.guest_id && !s.revoked_at && (!s.expires_at || new Date(s.expires_at) > new Date()))
        aliasOf[s.guest_id] = s.owner_id;
    }
    // Custom plant types, indexed by "<user_id>|<key>".
    const customByUserKey = {};
    for (const c of (customProfiles || [])) customByUserKey[`${c.user_id}|${c.key}`] = { size:c.size||"medium", low:c.ideal_low, high:c.ideal_high, species:c.label, why:c.why||"" };
    // App-usage info (joined / last active) from GoTrue admin.
    let authUsers = [];
    try {
      const r = await fetch(`${SUPA}/auth/v1/admin/users?per_page=200`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
      if (r.ok) { const j = await r.json(); authUsers = j.users || (Array.isArray(j) ? j : []); }
    } catch (_) {}
    const authBy = Object.fromEntries(authUsers.map(u => [u.id, u]));

    const acctBy = Object.fromEntries(accounts.map(a => [a.user_id, a]));
    const gwById = Object.fromEntries(gateways.map(g => [g.id, g]));
    const zoneById = Object.fromEntries(zones.map(z => [z.id, z]));

    // Cache Ecowitt real_time per (app_key|mac) so each gateway is fetched once.
    const ecoCache = {};
    const ecoFor = async (acct, mac) => {
      if (!acct || !mac) return {};
      const key = `${acct.app_key}|${mac}`;
      if (!(key in ecoCache)) ecoCache[key] = await getGw(acct.app_key, acct.api_key, mac);
      return ecoCache[key];
    };

    const users = [];
    const triage = [];
    for (const pf of profs) {
      // A guest renders the owner's garden; everyone else renders their own.
      const dataId = aliasOf[pf.id] || pf.id;
      const isGuestView = !!aliasOf[pf.id];
      const acct = acctBy[dataId];
      const mine = plants.filter(p => p.user_id === dataId)
                         .sort((a,b) => (a.display_order ?? a.channel) - (b.display_order ?? b.channel));

      // Pass 1: raw readings + status.
      const readings = [];
      for (const pl of mine) {
        const gw = gwById[pl.gateway_id];
        const data = await ecoFor(acct, gw?.mac);
        const node = data?.["soil_ch" + pl.channel];
        const moisture = node?.soilmoisture?.value != null ? num(node.soilmoisture.value) : null;
        const battery = data?.battery?.["soilmoisture_sensor_ch" + pl.channel]?.value != null ? num(data.battery["soilmoisture_sensor_ch" + pl.channel].value) : null;
        const zoneName = pl.zone_id ? (zoneById[pl.zone_id]?.name) : (gw?.name);
        const r = { gateway_id: pl.gateway_id, gateway_name: gw?.name, mac: gw?.mac, zone: gw?.name, physical_zone: zoneName,
          channel: pl.channel, name: pl.name, moisture, battery, battery_class: batteryClass(battery), is_offline: moisture === null,
          status: "no_reading", headline: "No reading", ideal_low: null, ideal_high: null, species: null, advice: "Sensor isn't reporting.", watering: null };
        if (moisture === null) { /* defaults above */ }
        else if (!pl.species || pl.species === "unknown") { r.status = "unassigned"; r.headline = "Set plant type"; r.advice = "Awaiting plant type."; }
        else {
          const p = profiles[pl.species] || customByUserKey[`${dataId}|${pl.species}`] || profiles.unknown;
          r.ideal_low = pl.ideal_low ?? p.low; r.ideal_high = pl.ideal_high ?? p.high; r.species = p.species;
          const a = advise(p, moisture, r.ideal_low, r.ideal_high);
          r.status = a.status; r.headline = a.headline; r.advice = a.advice; r.watering = wateringPlan(p, moisture, r.ideal_low, r.ideal_high);
        }
        readings.push(r);
      }

      // Gateway-down: every sensor on a gateway dark at once (need >= 2 to call it a hub outage).
      const byGw = {};
      for (const r of readings) { (byGw[r.gateway_id] = byGw[r.gateway_id] || []).push(r); }
      const gwDown = {};
      for (const gid in byGw) { const grp = byGw[gid]; gwDown[gid] = grp.length >= 2 && grp.every(x => x.is_offline); }

      // Pass 2: last-seen for offline (skip down-gateway sensors — they roll up) + diagnosis.
      for (const r of readings) {
        r.last_seen = null; r.offline_age_sec = null;
        if (r.is_offline && !gwDown[r.gateway_id] && acct && r.mac) {
          const iso = (await lastValidTs(acct.app_key, acct.api_key, r.mac, r.channel, 3)) || (await lastValidTs(acct.app_key, acct.api_key, r.mac, r.channel, 90));
          r.last_seen = iso;
          r.offline_age_sec = iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null;
        }
        r.diagnosis = diagnose(r, !!gwDown[r.gateway_id]);
        r.needs_battery = r.diagnosis.needs_battery;
      }

      const counts = { good:0, dry:0, too_wet:0, offline:0, unassigned:0, low_batt:0, critical_batt:0, gateway_down:0 };
      for (const r of readings) {
        if (r.status === "dry" || r.status === "very_dry") counts.dry++;
        else if (r.status === "too_wet") counts.too_wet++;
        else if (r.status === "good") counts.good++;
        else if (r.status === "no_reading") counts.offline++;
        else if (r.status === "unassigned") counts.unassigned++;
        if (r.battery_class === "low") counts.low_batt++;
        if (r.battery_class === "critical") counts.critical_batt++;
      }
      counts.needs_water = counts.dry;  // alias kept for existing UI
      for (const gid in gwDown) if (gwDown[gid]) counts.gateway_down++;

      // Triage entries (gateway-down grouped; its sensors suppressed).
      // Guests are skipped here: their readings are the owner's, and the
      // owner's card already contributes those issues — pushing them again
      // would double every triage row.
      const downGids = new Set();
      for (const gid in gwDown) {
        if (!gwDown[gid] || isGuestView) continue;
        downGids.add(gid);
        const grp = byGw[gid];
        triage.push({ scope:"gateway", severity:"critical", category:"gateway_down",
          client: pf.garden_name || pf.email, email: pf.email, gateway_name: grp[0].gateway_name, zone: null, plant: null, channel: null,
          headline: grp[0].diagnosis.headline, detail: grp[0].diagnosis.detail, fix_steps: grp[0].diagnosis.fix_steps,
          sensor_count: grp.length, moisture: null, battery: null, battery_class: null, last_seen: null, offline_age_sec: null, needs_battery: false });
      }
      for (const r of readings) {
        if (isGuestView) break;
        if (r.diagnosis.severity === "ok") continue;
        if (downGids.has(String(r.gateway_id))) continue;
        triage.push({ scope:"sensor", severity:r.diagnosis.severity, category:r.diagnosis.category,
          client: pf.garden_name || pf.email, email: pf.email, gateway_name: r.gateway_name, zone: r.physical_zone || r.zone, plant: r.name, channel: r.channel,
          headline: r.diagnosis.headline, detail: r.diagnosis.detail, fix_steps: r.diagnosis.fix_steps,
          moisture: r.moisture, battery: r.battery, battery_class: r.battery_class, last_seen: r.last_seen, offline_age_sec: r.offline_age_sec, needs_battery: r.needs_battery });
      }

      const au = authBy[pf.id] || {};
      users.push({
        user_id: pf.id, email: pf.email, garden_name: pf.garden_name || "PlantWatch",
        is_admin: !!pf.is_admin, onboarded: !!pf.onboarded, has_ecowitt: !!acct,
        gateway_count: gateways.filter(g => g.user_id === pf.id).length,
        created_at: au.created_at || null,
        last_sign_in_at: pf.last_active_at || au.last_sign_in_at || null,
        last_active_source: pf.last_active_at ? "activity" : "sign_in",
        counts, readings,
      });
    }

    // Sort triage: severity → category → longest-offline first → client.
    triage.sort((a,b) =>
      (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
      (CAT_RANK[a.category] - CAT_RANK[b.category]) ||
      ((b.offline_age_sec || 0) - (a.offline_age_sec || 0)) ||
      String(a.client).localeCompare(String(b.client)));

    return json({ generated_at: new Date().toISOString(), user_count: users.length, thresholds: TH, triage, users });
  } catch (err) {
    return json({ error: String(err?.message ?? err) }, 500);
  }
});
