// ecowitt-devices — authenticated discovery of a user's Ecowitt gateways/sensors.
// Hardened against Ecowitt's flaky/rate-limited responses so onboarding "Discover
// my devices" works reliably (no raw "Unexpected end of JSON input" errors).
const CORS = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS" };
const SUPA = Deno.env.get("SUPABASE_URL"); const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };
const json = (o,s=200) => new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getUser(auth){ const r=await fetch(`${SUPA}/auth/v1/user`,{headers:{apikey:ANON,Authorization:auth}}); return r.ok?await r.json():null; }
async function rest(path,auth,opts={}){ const r=await fetch(`${SUPA}/rest/v1/${path}`,{headers:{apikey:ANON,Authorization:auth,"Content-Type":"application/json",...(opts.headers||{})},method:opts.method||"GET",body:opts.body}); return r.ok?(r.status===204?null:await r.json()):null; }

// Fetch an Ecowitt endpoint with retries. Ecowitt intermittently returns an
// empty body, non-JSON, or a transient code (-1 system / 45001 too-frequent).
// Returns parsed JSON on a definitive response, or { __transient } after retries.
async function ecoGet(url, tries=4){
  let last = "network error";
  for (let i=0; i<tries; i++){
    try {
      const r = await fetch(url);
      const text = await r.text();
      if (text && text.trim()){
        let j = null; try { j = JSON.parse(text); } catch { j = null; }
        if (j){
          if (j.code === -1 || j.code === 45001){ last = `ecowitt code ${j.code}`; }  // transient → retry
          else return j;                                                               // definitive (success or real error)
        } else { last = "non-JSON response"; }
      } else { last = "empty response"; }
    } catch(e){ last = String(e?.message ?? e); }
    if (i < tries-1) await sleep(700 * (i+1));   // 0.7s, 1.4s, 2.1s backoff
  }
  return { __transient: last };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null,{headers:CORS});
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({error:"Not signed in"},401);
    const user = await getUser(auth);
    if (!user?.id) return json({error:"Not signed in"},401);

    let appKey, apiKey, save=false;
    try { const b=await req.json(); appKey=b.app_key; apiKey=b.api_key; save=!!b.save; } catch(_){}
    // Trim stray spaces/newlines from pasted keys.
    appKey = (appKey ?? "").toString().trim();
    apiKey = (apiKey ?? "").toString().trim();
    if (!appKey || !apiKey) {
      const rows = await rest("ecowitt_accounts?select=app_key,api_key", auth);
      if (rows && rows[0]) { appKey=(rows[0].app_key||"").trim(); apiKey=(rows[0].api_key||"").trim(); }
    }
    if (!appKey || !apiKey) return json({error:"Enter your Ecowitt Application Key and API Key."},400);

    const lj = await ecoGet(`https://api.ecowitt.net/api/v3/device/list?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}`);
    if (lj.__transient) return json({error:"Ecowitt didn't respond just now (it limits how often we can check). Wait about 30 seconds, then tap Discover again."},503);
    if (lj.code !== 0) {
      const codeStr = String(lj.code || "");
      const keyIssue = codeStr.startsWith("4001") || /key/i.test(lj.msg||"");
      const msg = keyIssue
        ? "Those Ecowitt keys weren't accepted — double-check the Application Key and API Key (it's easy to swap them)."
        : `Ecowitt error: ${lj.msg || "could not read devices"}.`;
      return json({error: msg, ecowitt_code: lj.code}, 400);
    }
    const list = lj?.data?.list || [];
    if (!list.length) return json({error:"No gateways found on this Ecowitt account. Make sure the gateway is online and added to the Ecowitt app."},400);

    const gateways = [];
    for (const g of list) {
      let channels = [];
      const rj = await ecoGet(`https://api.ecowitt.net/api/v3/device/real_time?application_key=${encodeURIComponent(appKey)}&api_key=${encodeURIComponent(apiKey)}&mac=${encodeURIComponent(g.mac)}&call_back=all`);
      const d = rj.__transient ? {} : (rj?.data || {});
      for (let ch=1; ch<=16; ch++){ const n=d["soil_ch"+ch]; if(n?.soilmoisture?.value!=null) channels.push({channel:ch,moisture:num(n.soilmoisture.value),battery:num(d.battery?.["soilmoisture_sensor_ch"+ch]?.value)}); }
      gateways.push({mac:g.mac,name:g.name,station_type:g.stationtype,latitude:g.latitude,longitude:g.longitude,channels});
    }

    if (save) {
      await rest("ecowitt_accounts", auth, { method:"POST",
        headers:{ Prefer:"resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_id:user.id, app_key:appKey, api_key:apiKey, updated_at:new Date().toISOString() }) });
    }
    return json({ gateways });
  } catch(err){
    // Never surface a raw parse error to the user.
    return json({error:"Something went wrong reaching Ecowitt. Wait a moment and tap Discover again."},502);
  }
});
