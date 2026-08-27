// guest-report — READ-ONLY view of someone else's garden, for an invited guest.
//
// Why this exists as its own function rather than a flag on report-v2:
// report-v2 is called by every client (web + every shipped iOS binary) every 60
// seconds, and there is no CI, test suite or staging environment in this repo.
// A new endpoint has a blast radius of exactly zero for existing users — nothing
// they call changes. See 20260804000001_garden_shares.sql for the matching
// argument about why no RLS policy was added to any existing table.
//
// Safety properties:
//   * The caller's JWT is verified, then a LIVE row in garden_shares must name
//     them. No share → 403. Revoked/expired → 403, checked on every request.
//   * The owner's rows are read with the service role, so the guest never needs
//     (and never gets) any RLS reach into plants/zones/gateways/profiles.
//   * ecowitt_accounts is read ONLY to call Ecowitt server-side. The app_key /
//     api_key never appear in the response.
//   * Nothing is written to the owner's records. The only write is the guest's
//     own view telemetry on their share row (last_viewed_at / view_count), so
//     the owner's profiles.last_active_at is NOT touched — guest polling must
//     not make the owner look "active" in the admin dashboard.
//
// The species catalog + advice logic below is mirrored from report-v2 so the
// guest sees exactly what the owner sees. KEEP IN SYNC with report-v2/index.ts
// (admin-overview/index.ts carries the same warning).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };

// ── catalog mirrored from report-v2 ──────────────────────────────────────────
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

async function getGw(appKey, apiKey, mac) {
  const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(mac)}&call_back=all`;
  // Same retry posture as admin-overview: a transient Ecowitt blip must not
  // report the owner's sensors as offline to the person covering for them.
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.ok) { const j = await r.json(); if (j.code === 0 && j.data && Object.keys(j.data).length) return j.data; } }
    catch (_) {}
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Not signed in" }, 401);
    const SUPA = Deno.env.get("SUPABASE_URL");
    const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!SERVICE) return json({ error: "Server misconfigured" }, 500);

    // 1) Who is calling? (verify the JWT against GoTrue, don't trust the body)
    const ur = await fetch(`${SUPA}/auth/v1/user`, { headers: { apikey: ANON, Authorization: auth } });
    const user = ur.ok ? await ur.json() : null;
    if (!user?.id) return json({ error: "Not signed in" }, 401);
    const callerEmail = String(user.email || "").trim().toLowerCase();

    // Service-role helpers. Reads are scoped by explicit owner filters below —
    // never by RLS, which the service role bypasses.
    const svcHeaders = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
    const svc = async (path) => {
      const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: svcHeaders });
      return r.ok ? await r.json() : [];
    };
    const svcWrite = (path, method, body) => fetch(`${SUPA}/rest/v1/${path}`, {
      method, headers: { ...svcHeaders, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    }).catch(() => {});

    // 2) Which gardens may this caller read? Live = not revoked, not expired.
    //    Matched by bound guest_id, or by the address they were invited at.
    const nowIso = new Date().toISOString();
    const esc = (s) => encodeURIComponent(s);
    const byId = user.id
      ? await svc(`garden_shares?select=*&guest_id=eq.${esc(user.id)}&revoked_at=is.null&expires_at=gt.${esc(nowIso)}`)
      : [];
    const byEmail = callerEmail
      ? await svc(`garden_shares?select=*&guest_id=is.null&invitee_email=eq.${esc(callerEmail)}&revoked_at=is.null&expires_at=gt.${esc(nowIso)}`)
      : [];

    // Claim any invitation addressed to this account (binds guest_id once).
    for (const s of byEmail) {
      await svcWrite(`garden_shares?id=eq.${esc(s.id)}&guest_id=is.null`, "PATCH",
        { guest_id: user.id, accepted_at: nowIso });
      s.guest_id = user.id;
    }
    const shares = [...byId, ...byEmail].filter(s => s.role === "viewer");
    if (!shares.length) return json({ error: "No garden has been shared with this account", no_shares: true }, 403);

    // 3) Which garden is being viewed? ?garden=<owner_id>, else the only one.
    const wanted = new URL(req.url).searchParams.get("garden");
    const share = wanted ? shares.find(s => s.owner_id === wanted) : shares[0];
    if (!share) return json({ error: "Not authorized for that garden" }, 403);
    const ownerId = share.owner_id;

    // 4) Read the OWNER's config with the service role, filtered to that owner.
    const [ownerProf, ecoRows, gateways, zones, plants, prefRows, customRows] = await Promise.all([
      svc(`profiles?select=garden_name,email&id=eq.${esc(ownerId)}`),
      svc(`ecowitt_accounts?select=app_key,api_key&user_id=eq.${esc(ownerId)}`),
      svc(`gateways?select=*&user_id=eq.${esc(ownerId)}`),
      svc(`zones?select=*&user_id=eq.${esc(ownerId)}&order=sort`),
      svc(`plants?select=*&user_id=eq.${esc(ownerId)}&hidden=eq.false`),
      svc(`user_prefs?select=*&user_id=eq.${esc(ownerId)}`),
      svc(`species_profiles?select=key,label,ideal_low,ideal_high,why,size&user_id=eq.${esc(ownerId)}`),
    ]);
    const eco = ecoRows && ecoRows[0]; const prefs = prefRows && prefRows[0];

    // The list of gardens this guest may view (for a picker when >1).
    const gardenNames = await svc(`profiles?select=id,garden_name&id=in.(${shares.map(s => s.owner_id).join(",")})`);
    const nameById = Object.fromEntries((gardenNames || []).map(p => [p.id, p.garden_name]));
    const gardens = shares.map(s => ({ owner_id: s.owner_id, garden_name: nameById[s.owner_id] || "Garden", label: s.label, expires_at: s.expires_at }));
    const viewing = { owner_id: ownerId, garden_name: ownerProf?.[0]?.garden_name || "Garden", expires_at: share.expires_at };

    if (!eco) return json({ error: "That garden isn't set up yet.", gardens, viewing, read_only: true }, 200);
    if (!plants?.length) return json({ error: "That garden has no plants configured yet.", gardens, viewing, read_only: true }, 200);

    const customProf = {};
    for (const c of (customRows||[])) customProf[c.key] = { size:c.size||"medium", low:c.ideal_low, high:c.ideal_high, species:c.label, why:c.why||"", source_label:null, source_url:null };
    const resolveProf = (k) => profiles[k] || customProf[k] || profiles.unknown;

    const gwById = Object.fromEntries((gateways||[]).map(g => [g.id, g]));
    const zoneById = Object.fromEntries((zones||[]).map(z => [z.id, z]));

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
      const unassigned = !pl.species || pl.species === "unknown";
      if (unassigned) {
        return { ...base, moisture, type: "unknown",
          ideal_low: null, ideal_high: null, species_note: null, source_label: null, source_url: null,
          status: "unassigned", headline: "Set plant type",
          advice: "No plant type set, so there's no watering advice for this one.",
          rating_explanation: null, watering_recommendation: null, watering_target_pct: null, needs_water: false };
      }
      const a = advise(p, moisture, low, high); const plan = wateringPlan(p, moisture, low, high);
      return { ...base, moisture, status: a.status, headline: a.headline, advice: a.advice, needs_water: a.needsWater,
        rating_explanation: ratingExplanation(p.species, moisture, low, high, a.status),
        watering_recommendation: plan?.text ?? null, watering_target_pct: plan?.target_pct ?? null };
    });

    await Promise.all(readings.filter(r => r.status === "no_reading").map(async (r) => {
      const gw = (gateways||[]).find(g => g.name === r.zone); if (!gw) return;
      r.last_seen = (await lastValidTs(eco.app_key, eco.api_key, gw.mac, r.channel, 3)) || (await lastValidTs(eco.app_key, eco.api_key, gw.mac, r.channel, 90));
    }));

    const counts = { needs_water:0, too_wet:0, good:0, missing:0 };
    for (const r of readings) { if (r.needs_water) counts.needs_water++; else if (r.status==="too_wet") counts.too_wet++; else if (r.status==="good") counts.good++; else if (r.status==="no_reading") counts.missing++; }

    // View telemetry on the GUEST'S OWN share row. Deliberately not the owner's
    // profiles.last_active_at — guest polling must not distort the owner's
    // "last active" in admin-overview.
    svcWrite(`garden_shares?id=eq.${esc(share.id)}`, "PATCH",
      { last_viewed_at: nowIso, view_count: (share.view_count || 0) + 1, updated_at: nowIso });

    return json({
      generated_at: new Date().toISOString(),
      read_only: true, viewing, gardens,
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
    });
  } catch (err) { return json({ error: String(err?.message ?? err) }, 500); }
});
