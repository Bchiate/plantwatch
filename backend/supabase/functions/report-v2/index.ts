// report-v2 — authenticated, per-user report built from the caller's DB config.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// Shared species knowledge (ranges + care + sources). Per-plant overrides win.
const profiles = {
  citrus:{size:"large",low:35,high:55,species:"citrus",why:"Citrus prefers consistent moisture but tolerates moderate drying (UC IPM: 4–6 inches/month in summer). Chronic saturation invites root and crown rot.",source_label:"UC IPM — Citrus Watering",source_url:"https://ipm.ucanr.edu/PMG/GARDEN/FRUIT/CULTURAL/citruswatering.html"},
  avocado:{size:"large",low:40,high:60,species:"avocado",why:"Avocados have very shallow feeder roots: they hate drought AND wet feet (CA Avocado Comm.: ~2 inches/week in summer). Sustained high moisture = Phytophthora root rot.",source_label:"California Avocado Commission",source_url:"https://www.californiaavocadogrowers.com/cultural-management-library/irrigating-avocado-trees"},
  camellia:{size:"medium",low:35,high:50,species:"camellia",why:"Camellias are more often killed by over-watering than under (UC MG). Moderate, even moisture; protect from hot afternoon sun.",source_label:"UC Master Gardeners SLO — Camellia",source_url:"https://ucanr.edu/blog/uc-master-gardeners-diggin-it-slo/article/camellia"},
  hydrangea:{size:"medium",low:40,high:60,species:"hydrangea",why:"Hydrangea macrophylla needs consistently moist, well-drained soil and wilts visibly when dry.",source_label:"Missouri Botanical Garden — Hydrangea macrophylla",source_url:"https://www.missouribotanicalgarden.org/PlantFinder/PlantFinderDetails.aspx?taxonid=286874"},
  rosemary:{size:"small",low:18,high:35,species:"rosemary",why:"Mediterranean drought-adapted shrub (UC MG Sonoma: no summer water once established). Roots need air between waterings; sustained moisture above ~35% suffocates roots.",source_label:"UC MG Sonoma — Rosemary",source_url:"http://sonomamg.ucanr.edu/Plant_of_the_Month/Rosemary"},
  westringia:{size:"small",low:20,high:38,species:"westringia",why:"Australian coast rosemary — drought-tolerant. Needs the soil to dry between deep waterings; sustained 40%+ is a long-term mortality risk.",source_label:"UC Marin Master Gardeners — Westringia",source_url:"https://ucanr.edu/site/uc-marin-master-gardeners/article/westringia-every-garden"},
  lavender:{size:"small",low:20,high:38,species:"lavender",why:"Mediterranean and drought-tolerant; excellent drainage is non-negotiable. The dry/wet cycle keeps it healthy, not constant moisture.",source_label:"UC MG Sonoma — Lavandula",source_url:"https://ucanr.edu/site/uc-master-gardener-program-sonoma-county/lavandula-lavender"},
  bay_laurel:{size:"medium",low:22,high:40,species:"bay-laurel",why:"Established (2+ yr) bay laurel adapts to low water. Sustained high moisture in clay is the biggest risk — deep, infrequent watering.",source_label:"UC MG Sonoma — Laurus nobilis",source_url:"https://sonomamg.ucanr.edu/Plant_of_the_Month/Laurus_nobilis_Saratoga/"},
  star_jasmine:{size:"medium",low:30,high:50,species:"star-jasmine",why:"Established star jasmine needs modest, periodic irrigation; bumps in extreme heat. Well-drained soil only.",source_label:"UC IPM — Star Jasmine",source_url:"http://ipm.ucanr.edu/PMG/GARDEN/PLANTS/starjasmine.html"},
  boxwood:{size:"medium",low:28,high:50,species:"boxwood",why:"Boxwood prefers slow, deep watering over frequent shallow. Drip only — overhead water spreads boxwood blight.",source_label:"UC MG Alameda — Drought Watering",source_url:"https://ucanr.edu/site/uc-master-gardener-program-alameda-county/thirsty-plants-and-watering-times-drought"},
  convolvulus:{size:"small",low:20,high:40,species:"convolvulus",why:"Convolvulus cneorum (Silverbush) is a Mediterranean groundcover; drought-tolerant once established. Sustained moisture above 40% causes root rot.",source_label:"UC IPM — Bush Morning Glory",source_url:"https://ipm.ucanr.edu/PMG/GARDEN/PLANTS/bushmorngl.html"},
  carrotwood:{size:"large",low:25,high:45,species:"carrotwood",why:"Carrotwood (Cupaniopsis anacardioides) is rated Moderate water use (WUCOLS) and is markedly drought-tolerant once established. In Calabasas it prefers deep, infrequent irrigation: let the soil dry toward ~25% between waterings, then soak the whole root zone. Hold it in the 25-45% band — sustained moisture above ~45% in clay risks root rot, while it shrugs off short dry spells far better than citrus. Established trees often need water only every 2-3 weeks in peak summer and none in the rainy season.",source_label:"WUCOLS III (UC ANR) + Cal Poly SelecTree",source_url:"https://selectree.calpoly.edu/tree-detail/cupaniopsis-anacardioides"},
  lemon:{size:"large",low:40,high:60,species:"lemon",why:"Lemons are moderate-water citrus with shallow feeder roots. In hot, inland Calabasas summers keep the root zone evenly moist (40-60%): below ~40% the tree heat-stresses — leaf-fold, fruit drop and split fruit — while in Calabasas's heavier clay soils the bigger danger is overwatering, since sustained wetness above ~60% drives root and crown rot (Phytophthora). Water deeply, then let the top 2 inches dry before the next soak; in practice that is a deep soak about twice a week in peak summer and little to none from December through March.",source_label:"UC ANR Master Gardeners — Citrus (CA)",source_url:"https://ucanr.edu/site/uc-marin-master-gardeners/document/citrus"},
  tomato:{size:"medium",low:45,high:65,species:"tomato",why:"Tomatoes need steady, even moisture for fruit set; let the top inch dry but avoid drought stress (causes blossom-end rot and cracking) and avoid soggy soil.",source_label:null,source_url:null},
  rose:{size:"medium",low:40,high:60,species:"rose",why:"Roses like deep, regular watering with good drainage — keep the root zone evenly moist, never waterlogged.",source_label:null,source_url:null},
  succulent:{size:"small",low:10,high:25,species:"succulent",why:"Succulents store water and rot easily — let the soil dry out almost completely between waterings; low moisture is healthy.",source_label:null,source_url:null},
  fern:{size:"medium",low:50,high:70,species:"fern",why:"Ferns want consistently moist, humus-rich soil and resent drying out; keep the root zone damp but not waterlogged.",source_label:null,source_url:null},
  olive:{size:"large",low:18,high:38,species:"olive",why:"Olives are Mediterranean and very drought-tolerant once established; let the soil dry well between deep, infrequent waterings.",source_label:null,source_url:null},
  bougainvillea:{size:"large",low:20,high:40,species:"bougainvillea",why:"Bougainvillea blooms best kept on the dry side once established — deep but infrequent water; avoid constant moisture.",source_label:null,source_url:null},
  japanese_maple:{size:"medium",low:40,high:60,species:"japanese_maple",why:"Japanese maples like cool, consistently moist (not soggy) soil and scorch if they dry out; mulch and avoid hot dry spells.",source_label:null,source_url:null},
  hibiscus:{size:"medium",low:40,high:60,species:"hibiscus",why:"Hibiscus likes regular, even moisture in warm weather with good drainage; don't let it dry out while blooming.",source_label:null,source_url:null},
  blueberry:{size:"medium",low:45,high:65,species:"blueberry",why:"Blueberries have shallow roots and need consistently moist, acidic, well-drained soil; they dislike both drought and waterlogging.",source_label:null,source_url:null},
  agave:{size:"small",low:8,high:22,species:"agave",why:"Agaves are xeric — water deeply but rarely and let the soil dry out completely; sustained moisture causes rot.",source_label:null,source_url:null},
  unknown:{size:"medium",low:25,high:45,species:"unknown",why:"Species not yet set; treated as a generic moderate-water shrub.",source_label:null,source_url:null},
};
const prof = (k) => profiles[k] || profiles.unknown;

const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };
const cToF = (c) => c * 9/5 + 32;
const mmToIn = (mm) => mm / 25.4;

async function getGw(appKey, apiKey, mac) {
  const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(mac)}&call_back=all`;
  // Retry Ecowitt's transient failures (HTTP error, empty/non-JSON body, code
  // -1 system busy / 45001 too-frequent) — one blip must not render a whole
  // gateway "No reading" on a 60s auto-refresh and spam offline alerts. Same
  // posture as guest-report / admin-overview / ecowitt-devices.
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.code === 0 && j.data && Object.keys(j.data).length) return j.data;
        if (j && j.code !== 0 && j.code !== -1 && j.code !== 45001) return {};   // definitive error (bad key/mac) — don't retry
      }
    } catch (_) {}
    if (i < 2) await new Promise(res => setTimeout(res, 500 * (i + 1)));
  }
  return {};
}
async function getWx(lat, lon) {
  if (lat == null || lon == null) return null;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_min&timezone=America/Los_Angeles&forecast_days=2&temperature_unit=fahrenheit&precipitation_unit=inch`);
    return r.ok ? r.json() : null;
  } catch { return null; }
}
function wateringPlan(p, m, low, high) {
  const ladder = { small:{light:{min:3,galLo:0.5,galHi:1},moderate:{min:7,galLo:1.5,galHi:3},deep:{min:12,galLo:3,galHi:5}},
    medium:{light:{min:5,galLo:1,galHi:2},moderate:{min:12,galLo:4,galHi:6},deep:{min:20,galLo:6,galHi:10}},
    large:{light:{min:8,galLo:2,galHi:4},moderate:{min:18,galLo:6,galHi:10},deep:{min:30,galLo:12,galHi:18}}};
  const tier = ladder[p.size]||ladder.medium; const gap=low-m; let lvl,lbl;
  if(gap>=10){lvl="deep";lbl="Deep slow soak";}else if(gap>=5){lvl="moderate";lbl="Moderate watering";}else if(gap>0){lvl="light";lbl="Light watering";}else return null;
  const w=tier[lvl]; const target=Math.round((low+high)/2);
  return {text:`${lbl}: ~${w.min} min of drip irrigation or ~${w.galLo}–${w.galHi} gallons. Aim to bring moisture to ~${target}%.`,target_pct:target};
}
function ratingExplanation(sp,m,low,high,status){
  m=Math.round(m);
  if(status==="very_dry"||status==="dry"){const gap=low-m;return `At ${m}% you're ${Math.round(gap)}% below the ${low}% floor for ${sp}, so this reads as ${status==="very_dry"?"very dry":"dry"}. The ${low}–${high}% band is the research-backed range.`;}
  if(status==="too_wet")return `At ${m}% you're ${Math.round(m-high)}% above the ${high}% ceiling for ${sp}. Above this band, ${sp} can suffer root issues.`;
  return `At ${m}% you're inside the ideal ${low}–${high}% band for ${sp}. No action needed.`;
}
function advise(p,m,low,high){
  if(m<low){const gap=low-m,vd=gap>=12;let a;if(gap>=10)a="Deep-water today";else if(gap>=5)a="Water today";else a="Water lightly today";
    return {status:vd?"very_dry":"dry",headline:vd?"VERY DRY":"Dry",advice:`${a} — at ${Math.round(m)}% you're ${Math.round(gap)}% below the ${low}% floor. ${p.why}`,needsWater:true};}
  if(m>high)return {status:"too_wet",headline:"Too wet",advice:`Hold off — at ${Math.round(m)}% you're ${Math.round(m-high)}% above the ${high}% ceiling. ${p.why}`,needsWater:false};
  return {status:"good",headline:"Good",advice:`In range — at ${Math.round(m)}% you're inside the ideal ${low}–${high}% band. ${p.why}`,needsWater:false};
}
function laStamp(d){const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(d);const g=(t)=>parts.find(p=>p.type===t).value;return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;}
async function lastValidTs(appKey,apiKey,mac,ch,days){try{const end=new Date();const start=new Date(end.getTime()-days*864e5);const url=`https://api.ecowitt.net/api/v3/device/history?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(mac)}&start_date=${encodeURIComponent(laStamp(start))}&end_date=${encodeURIComponent(laStamp(end))}&cycle_type=auto&call_back=soil_ch${ch}`;const r=await fetch(url);if(!r.ok)return null;const j=await r.json();const list=j?.data?.["soil_ch"+ch]?.soilmoisture?.list||{};let last=null;for(const k of Object.keys(list)){const v=list[k];if(v!==null&&v!=="-"&&v!==""){const t=parseInt(k,10);if(Number.isFinite(t)&&(last===null||t>last))last=t;}}return last?new Date(last*1000).toISOString():null;}catch{return null;}}

// ── Guest access ────────────────────────────────────────────────────────────
// Resolve a live garden_shares row for this caller and return the OWNER'S
// config, read with the service role. Returns null when the caller has no
// share, which makes the caller fall through to the unchanged onboarding path.
//
// This is only ever called for a caller who has no Ecowitt account or no plants
// of their own, i.e. someone who would otherwise be sent to onboarding. A
// configured customer never reaches it, so their request is unchanged.
//
// Read-only by construction: the guest's own JWT still cannot touch the owner's
// rows (RLS owner_all pins every table to user_id = auth.uid()), so a guest in
// the iOS app can view this data but cannot rename, reorder or delete any of it.
async function guestGarden(SUPA, SERVICE, user) {
  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
  const svc = async (p) => { const r = await fetch(`${SUPA}/rest/v1/${p}`, { headers: h }); return r.ok ? await r.json() : []; };
  const patch = (p, body) => fetch(`${SUPA}/rest/v1/${p}`, {
    method: "PATCH", headers: { ...h, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  }).catch(() => {});

  const now = new Date().toISOString();
  const nowQ = encodeURIComponent(now);
  const em = String(user.email ?? "").trim().toLowerCase();

  // Bound share first, then an invitation addressed to this account.
  let rows = await svc(`garden_shares?select=*&guest_id=eq.${user.id}&revoked_at=is.null&expires_at=gt.${nowQ}`);
  if (!rows.length && em) {
    rows = await svc(`garden_shares?select=*&guest_id=is.null&invitee_email=eq.${encodeURIComponent(em)}&revoked_at=is.null&expires_at=gt.${nowQ}`);
    // Claim it once, so the link is by user id from here on.
    if (rows.length) await patch(`garden_shares?id=eq.${rows[0].id}&guest_id=is.null`, { guest_id: user.id, accepted_at: now });
  }
  const share = rows.find((s) => s.role === "viewer");
  if (!share) return null;

  const o = share.owner_id;
  const [ecoRows, gateways, zones, plants, prefRows, customRows, ownerProf] = await Promise.all([
    svc(`ecowitt_accounts?select=app_key,api_key&user_id=eq.${o}`),
    svc(`gateways?select=*&user_id=eq.${o}`),
    svc(`zones?select=*&user_id=eq.${o}&order=sort`),
    svc(`plants?select=*&user_id=eq.${o}&hidden=eq.false`),
    svc(`user_prefs?select=*&user_id=eq.${o}`),
    svc(`species_profiles?select=key,label,ideal_low,ideal_high,why,size&user_id=eq.${o}`),
    svc(`profiles?select=garden_name&id=eq.${o}`),
  ]);
  if (!ecoRows?.[0] || !plants?.length) return null;   // owner not set up — fail closed

  // Telemetry on the GUEST'S OWN share row. The owner's profiles.last_active_at
  // is deliberately not touched: guest polling must not make the owner look
  // active in admin-overview.
  patch(`garden_shares?id=eq.${share.id}`, { last_viewed_at: now, view_count: (share.view_count || 0) + 1, updated_at: now });

  // The shipped iOS build titles the screen from the SIGNED-IN user's own
  // profiles row (PlantReportService.swift:61-65), which is empty for a guest.
  // Mirror the owner's garden name onto the guest's own row so the app reads
  // "Craig PlantWatch" instead of falling back. Touches only the guest's record.
  const gname = ownerProf?.[0]?.garden_name;
  if (gname) patch(`profiles?id=eq.${user.id}`, { garden_name: gname });

  return {
    eco: ecoRows[0], gateways, zones, plants, prefs: prefRows?.[0], customRows,
    viewing: { owner_id: o, garden_name: ownerProf?.[0]?.garden_name || "Garden" },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const SUPA = Deno.env.get("SUPABASE_URL"); const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const getUser = async () => { const r = await fetch(`${SUPA}/auth/v1/user`, { headers:{ apikey:ANON, Authorization:auth } }); return r.ok ? await r.json() : null; };
    const rest = async (path) => { const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers:{ apikey:ANON, Authorization:auth } }); return r.ok ? await r.json() : null; };
    const user = await getUser();
    if (!user?.id) return json({ error: "Not signed in" }, 401);

    // Record real app activity (a report load = the app is open) so the admin
    // dashboard's "last active" reflects usage, not stale sign-in events. Written
    // with the service role so it can't be forged and isn't blocked by RLS grants.
    if (SERVICE) {
      try { await fetch(`${SUPA}/rest/v1/profiles?id=eq.${user.id}`, { method: "PATCH",
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ last_active_at: new Date().toISOString() }) }); } catch (_) {}
    }

    let [ecoRows, gateways, zones, plants, prefRows, customRows] = await Promise.all([
      rest("ecowitt_accounts?select=app_key,api_key"),
      rest("gateways?select=*"),
      rest("zones?select=*&order=sort"),
      rest("plants?select=*&hidden=eq.false"),
      rest("user_prefs?select=*"),
      rest("species_profiles?select=key,label,ideal_low,ideal_high,why,size"),
    ]);
    let eco = ecoRows && ecoRows[0]; let prefs = prefRows && prefRows[0];

    // Someone with no garden of their own may have been invited to watch another
    // person's (see guestGarden). Gated on the caller being empty, so a
    // configured customer never runs this lookup and their request is unchanged.
    let viewing = null;
    if ((!eco || !plants?.length) && SERVICE) {
      const g = await guestGarden(SUPA, SERVICE, user);
      if (g) {
        eco = g.eco; gateways = g.gateways; zones = g.zones;
        plants = g.plants; prefs = g.prefs; customRows = g.customRows;
        viewing = g.viewing;
      }
    }

    // Merge the user's custom plant types over the built-in catalog.
    const customProf = {};
    for (const c of (customRows||[])) customProf[c.key] = { size:c.size||"medium", low:c.ideal_low, high:c.ideal_high, species:c.label, why:c.why||"", source_label:null, source_url:null };
    const resolveProf = (k) => profiles[k] || customProf[k] || profiles.unknown;

    if (!eco) return json({ error: "No Ecowitt credentials set", needs_onboarding: true }, 200);
    if (!plants?.length) return json({ error: "No plants configured", needs_onboarding: true }, 200);

    const gwById = Object.fromEntries((gateways||[]).map(g => [g.id, g]));
    const zoneById = Object.fromEntries((zones||[]).map(z => [z.id, z]));

    // Fetch each gateway's live data once.
    const macSet = [...new Set((gateways||[]).map(g => g.mac))];
    const dataByMac = {};
    await Promise.all(macSet.map(async (mac) => { dataByMac[mac] = await getGw(eco.app_key, eco.api_key, mac); }));

    const wxRaw = await getWx(prefs?.weather_lat, prefs?.weather_lon);
    const daily = wxRaw?.daily || {}, cur = wxRaw?.current || {};

    const readings = (plants||[]).map(pl => {
      const gw = gwById[pl.gateway_id]; const data = gw ? dataByMac[gw.mac] : null;
      const node = data?.["soil_ch" + pl.channel];
      const moisture = node?.soilmoisture?.value != null ? num(node.soilmoisture.value) : null;
      const battery = data?.battery?.["soilmoisture_sensor_ch" + pl.channel]?.value != null ? num(data.battery["soilmoisture_sensor_ch" + pl.channel].value) : null;
      const p = resolveProf(pl.species);
      const low = pl.ideal_low ?? p.low, high = pl.ideal_high ?? p.high;
      const zoneName = pl.zone_id ? (zoneById[pl.zone_id]?.name) : (gw?.name);
      const base = {
        // Fallback so a transient gateways read can never emit a null zone (the
        // iOS model requires a non-null zone; a null would fail the whole decode).
        zone: gw?.name ?? "Unknown", channel: pl.channel, display_order: pl.display_order,
        physical_zone: zoneName, physical_zone_verified: true,
        name: pl.name, species: p.species, type: p.species, verified: true,
        pair: null, pair_role: null, ideal_low: low, ideal_high: high,
        battery, species_note: p.why, source_label: p.source_label, source_url: p.source_url,
        last_seen: null, last_battery: null, offline_cause: null, notify: pl.notify,
      };
      if (moisture === null) {
        return { ...base, moisture: null, status: "no_reading", headline: "No reading",
          advice: "Sensor isn't reporting — check battery / placement.",
          rating_explanation: "Sensor isn't reporting.", watering_recommendation: null, watering_target_pct: null, needs_water: false };
      }
      // No plant type assigned yet → show the reading but withhold any watering
      // advice/judgement until a real species is set.
      const unassigned = !pl.species || pl.species === "unknown";
      if (unassigned) {
        // Keep `type` a non-null string ("unknown") — the iOS model requires it.
        return { ...base, moisture, type: "unknown",
          ideal_low: null, ideal_high: null, species_note: null, source_label: null, source_url: null,
          status: "unassigned", headline: "Set plant type",
          advice: "Assign a plant type to get watering advice.",
          rating_explanation: null, watering_recommendation: null, watering_target_pct: null, needs_water: false };
      }
      const a = advise(p, moisture, low, high); const plan = wateringPlan(p, moisture, low, high);
      return { ...base, moisture, status: a.status, headline: a.headline, advice: a.advice, needs_water: a.needsWater,
        rating_explanation: ratingExplanation(p.species, moisture, low, high, a.status),
        watering_recommendation: plan?.text ?? null, watering_target_pct: plan?.target_pct ?? null };
    });

    // Last-seen enrichment for offline sensors — bounded so a hub outage
    // (every sensor on a gateway "offline" at once) can't fan out into dozens
    // of slow Ecowitt history calls, time the report out, and trip Ecowitt's
    // rate limit right when it's already struggling.
    const offline = readings.filter(r => r.status === "no_reading");
    const offlineByGw = {}, totalByGw = {};
    for (const r of readings) totalByGw[r.zone] = (totalByGw[r.zone] || 0) + 1;
    for (const r of offline) (offlineByGw[r.zone] ??= []).push(r);
    await Promise.all(Object.entries(offlineByGw).map(async ([gwName, rs]) => {
      const gw = (gateways||[]).find(g => g.name === gwName); if (!gw) return;
      // Whole gateway dark (>=2 sensors, all offline) → hub-level outage: one
      // shared lookup, since every sensor stopped at the same moment.
      if (rs.length >= 2 && rs.length === totalByGw[gwName]) {
        const ts = await lastValidTs(eco.app_key, eco.api_key, gw.mac, rs[0].channel, 3);
        for (const r of rs) r.last_seen = ts;
        return;
      }
      // Individual dropouts: cap the fan-out; sensors past the cap just show
      // no last-seen rather than slowing the whole report.
      await Promise.all(rs.slice(0, 6).map(async (r) => {
        r.last_seen = (await lastValidTs(eco.app_key, eco.api_key, gw.mac, r.channel, 3)) || (await lastValidTs(eco.app_key, eco.api_key, gw.mac, r.channel, 90));
      }));
    }));

    const counts = { needs_water:0, too_wet:0, good:0, missing:0 };
    for (const r of readings) { if (r.needs_water) counts.needs_water++; else if (r.status==="too_wet") counts.too_wet++; else if (r.status==="good") counts.good++; else if (r.status==="no_reading") counts.missing++; }

    return json({
      // No milliseconds: JSONDecoder(.iso8601) on older iOS uses
      // ISO8601DateFormatter without .withFractionalSeconds and returns nil for
      // "…​.655Z", failing the WHOLE report decode ("data couldn't be read…").
      // Newer devices parse both, web new Date() parses both — so
      // seconds-precision is the only format every client accepts. This is the
      // same gotcha the iOS model already dodges for last_seen by keeping it a
      // String and trying two formatters (PlantReport.swift).
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      weather: {
        temp_now_f: num(cur.temperature_2m)!=null?Math.round(num(cur.temperature_2m)):null,
        humidity_now: num(cur.relative_humidity_2m)!=null?Math.round(num(cur.relative_humidity_2m)):null,
        high_today_f: num((daily.temperature_2m_max||[])[0])!=null?Math.round(num((daily.temperature_2m_max||[])[0])):null,
        low_today_f: num((daily.temperature_2m_min||[])[0])!=null?Math.round(num((daily.temperature_2m_min||[])[0])):null,
        min_humidity_today: num((daily.relative_humidity_2m_min||[])[0])!=null?Math.round(num((daily.relative_humidity_2m_min||[])[0])):null,
        rain_today_in: num((daily.precipitation_sum||[])[0]),
        high_tomorrow_f: num((daily.temperature_2m_max||[])[1])!=null?Math.round(num((daily.temperature_2m_max||[])[1])):null,
        rain_tomorrow_in: num((daily.precipitation_sum||[])[1]),
        available: num((daily.temperature_2m_max||[])[0])!=null,
      },
      counts, pair_notes:{}, readings,
      user: { email: user.email, prefs: prefs || {} },
      // NOTE: no guest-specific keys are emitted here, deliberately. A guest's
      // payload is structurally identical to an owner's — same keys, same types
      // — so the already-shipped iOS binary, which we cannot change or inspect,
      // decodes a shared garden through exactly the code path that already
      // works for the owner. `viewing` is resolved but kept server-side; the
      // app gets the garden's name from the guest's own profiles row instead
      // (see the garden_name mirror in guestGarden).
    });
  } catch (err) { return json({ error: String(err?.message ?? err) }, 500); }
});
function json(o,s=200){return new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});}
