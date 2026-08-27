// species-catalog — authed. Returns the plant-type list for the picker:
// the built-in catalog plus this user's custom profiles. Lets the app build the
// picker dynamically so new built-ins / custom types appear with no app update.
const CORS = { "Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"GET, POST, OPTIONS" };
const SUPA = Deno.env.get("SUPABASE_URL"); const ANON = Deno.env.get("SUPABASE_ANON_KEY");
const json = (o,s=200) => new Response(JSON.stringify(o),{status:s,headers:{...CORS,"Content-Type":"application/json"}});

// Built-in plant types (labels + bands for the picker). Canonical ranges live in
// report-v2; these mirror them for display. Keep keys in sync with report-v2.
const BUILTIN = [
  { key:"citrus",        label:"Citrus (orange, lime…)",      low:35, high:55 },
  { key:"lemon",         label:"Lemon",                       low:40, high:60 },
  { key:"avocado",       label:"Avocado",                     low:40, high:60 },
  { key:"camellia",      label:"Camellia",                    low:35, high:50 },
  { key:"hydrangea",     label:"Hydrangea",                   low:40, high:60 },
  { key:"rosemary",      label:"Rosemary",                    low:18, high:35 },
  { key:"lavender",      label:"Lavender",                    low:20, high:38 },
  { key:"westringia",    label:"Westringia (coast rosemary)", low:20, high:38 },
  { key:"bay_laurel",    label:"Bay Laurel",                  low:22, high:40 },
  { key:"star_jasmine",  label:"Star Jasmine",                low:30, high:50 },
  { key:"boxwood",       label:"Boxwood",                     low:28, high:50 },
  { key:"convolvulus",   label:"Convolvulus (silverbush)",    low:20, high:40 },
  { key:"carrotwood",    label:"Carrotwood",                  low:25, high:45 },
  { key:"tomato",        label:"Tomato",                      low:45, high:65 },
  { key:"rose",          label:"Rose",                        low:40, high:60 },
  { key:"succulent",     label:"Succulent",                   low:10, high:25 },
  { key:"fern",          label:"Fern",                        low:50, high:70 },
  { key:"olive",         label:"Olive",                       low:18, high:38 },
  { key:"bougainvillea", label:"Bougainvillea",               low:20, high:40 },
  { key:"japanese_maple",label:"Japanese Maple",              low:40, high:60 },
  { key:"hibiscus",      label:"Hibiscus",                    low:40, high:60 },
  { key:"blueberry",     label:"Blueberry",                   low:45, high:65 },
  { key:"agave",         label:"Agave",                       low:8,  high:22 },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null,{headers:CORS});
  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({error:"Not signed in"},401);
    const ur = await fetch(`${SUPA}/auth/v1/user`,{headers:{apikey:ANON,Authorization:auth}});
    if (!ur.ok) return json({error:"Not signed in"},401);

    // The caller's custom profiles (RLS scopes to their own rows).
    let custom = [];
    const cr = await fetch(`${SUPA}/rest/v1/species_profiles?select=key,label,ideal_low,ideal_high&order=label`,{headers:{apikey:ANON,Authorization:auth}});
    if (cr.ok) { const rows = await cr.json(); custom = (rows||[]).map(r => ({ key:r.key, label:r.label, low:r.ideal_low, high:r.ideal_high, builtin:false })); }

    const species = [
      ...BUILTIN.map(b => ({ ...b, builtin:true })),
      ...custom,
      { key:"unknown", label:"Other / not sure (set later)", low:null, high:null, builtin:true },
    ];
    return json({ species });
  } catch (err) { return json({error:String(err?.message ?? err)},500); }
});
