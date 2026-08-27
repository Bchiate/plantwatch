/* ─────────────────────────────────────────────────────────────
   PlantWatch — GUEST dashboard (read-only view of a shared garden).

   Deliberately standalone: it shares only styles.css and config.js with the
   owner app. index.html / app.js / auth.js are untouched, so nothing here can
   change what an existing customer sees in their own dashboard.

   Differences from the owner app, all intentional:
     * Talks to `guest-report`, never `report-v2`.
     * No onboarding path — a guest has no Ecowitt account of their own and
       must never be asked to set one up.
     * Writes nothing: no renaming, reordering, range overrides or zone moves.
       (The owner app keeps those in localStorage; a guest editing them would
       desync the two people's vocabulary for the same plant.)
     * Its own session key, so signing in here never clobbers an owner session
       already stored in the same browser.
     * Refreshes every 5 minutes rather than every 60 seconds — each load hits
       the OWNER'S Ecowitt account, and their own app is already polling it.
   ───────────────────────────────────────────────────────────── */
(function () {
  const cfg = window.PLANTWATCH_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const SKEY = "pw-guest-session";                     // never "pw-session"
  const ENDPOINT = cfg.guestEndpoint ||
    (cfg.supabaseUrl ? `${cfg.supabaseUrl}/functions/v1/guest-report` : null);
  const REFRESH_MS = 5 * 60 * 1000;

  let session = null;
  try { session = JSON.parse(localStorage.getItem(SKEY) || "null"); } catch (_) {}
  let lastData = null, currentGarden = null, refreshTimer = null;

  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const relTime = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return s <= 5 ? "just now" : `${s} seconds ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString();
  };

  // Same emoji rules as the owner app so both people see the same plant icons.
  const emojiFor = (name, type) => {
    const n = String(name || "").toLowerCase();
    if (n.includes("lemon")) return "🍋";
    if (n.includes("lime")) return "🍐";
    if (n.includes("grapefruit") || n.includes("oro blanco")) return "🍈";
    if (n.includes("tangerine") || n.includes("mandarin") || n.includes("orange") || n.includes("cara cara")) return "🍊";
    if (n.includes("avocado")) return "🥑";
    if (n.includes("hydrangea")) return "💐";
    if (n.includes("camelia") || n.includes("camellia") || n.includes("jasmine")) return "🌸";
    if (n.includes("rosemary")) return "🌿";
    if (n.includes("lavender")) return "💜";
    if (n.includes("westringia")) return "🌾";
    if (n.includes("bay laurel") || n.includes("boxwood")) return "🌳";
    if (n.includes("convolvulus") || n.includes("convovulos")) return "🌱";
    switch (type) {
      case "citrus": return "🍊";
      case "avocado": return "🥑";
      case "mediterranean": return "🌿";
      case "broadleaf": return "🌸";
      case "hydrangea": return "💐";
      case "boxwood": return "🌳";
      case "groundcover": return "🌱";
    }
    return "🪴";
  };

  /* ── session ──────────────────────────────────────────────── */
  function saveSession(s) { session = s; localStorage.setItem(SKEY, JSON.stringify(s)); }
  function clearSession() { session = null; localStorage.removeItem(SKEY); }

  async function gotrue(path, body) {
    const r = await fetch(`${cfg.supabaseUrl}/auth/v1/${path}`, {
      method: "POST",
      headers: { apikey: cfg.supabaseAnonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error_description || d.msg || d.error || `Error ${r.status}`);
    return d;
  }
  async function refreshToken() {
    if (!session?.refresh_token) return false;
    try { saveSession(await gotrue("token?grant_type=refresh_token", { refresh_token: session.refresh_token })); return true; }
    catch (_) { clearSession(); return false; }
  }
  async function getAccessToken() {
    if (!session) return null;
    if (Date.now() > (session.expires_at || 0) * 1000 - 60_000) { if (!(await refreshToken())) return null; }
    return session.access_token;
  }
  function signOut() { clearSession(); location.reload(); }

  /* ── sign-in screen ───────────────────────────────────────── */
  function showApp(show) { const a = document.querySelector(".app"); if (a) a.style.display = show ? "" : "none"; }
  function overlay() {
    let el = document.getElementById("pw-auth-overlay");
    if (!el) { el = document.createElement("div"); el.id = "pw-auth-overlay"; document.body.appendChild(el); }
    return el;
  }
  function renderSignIn(onSuccess) {
    showApp(false);
    const el = overlay();
    el.innerHTML = `
      <div class="auth-card">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a7 7 0 0 0-7 7c0 3.5 2.5 6 7 13 4.5-7 7-9.5 7-13a7 7 0 0 0-7-7z"/><path d="M12 11v11"/>
            </svg>
          </span>
          <h1>PlantWatch</h1>
        </div>
        <p class="auth-sub">Sign in to see the garden you're watching</p>
        <form id="g-form" class="auth-form">
          <label class="auth-field"><span>Email</span>
            <input type="email" id="g-email" autocomplete="email" inputmode="email" required placeholder="you@example.com"/></label>
          <label class="auth-field"><span>Password</span>
            <input type="password" id="g-pass" autocomplete="current-password" required placeholder="••••••••"/></label>
          <div id="g-error" class="auth-error" hidden></div>
          <button type="submit" id="g-submit" class="auth-submit">Sign in</button>
        </form>
      </div>`;
    const errEl = el.querySelector("#g-error");
    el.querySelector("#g-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const btn = el.querySelector("#g-submit");
      btn.disabled = true; btn.textContent = "Signing in…";
      try {
        saveSession(await gotrue("token?grant_type=password", {
          email: el.querySelector("#g-email").value.trim(),
          password: el.querySelector("#g-pass").value,
        }));
        el.remove(); showApp(true); onSuccess();
      } catch (err) {
        errEl.textContent = err.message || "Couldn't sign in.";
        errEl.hidden = false; btn.disabled = false; btn.textContent = "Sign in";
      }
    });
  }

  /* ── renderers ────────────────────────────────────────────── */
  function renderBanner(data) {
    const name = data.viewing?.garden_name || "a shared garden";
    return `<div class="guest-banner">
      <span class="guest-banner-dot" aria-hidden="true"></span>
      <span>You're viewing <strong>${escape(name)}</strong> — read-only. Nothing you do here changes their setup.</span>
    </div>`;
  }

  function renderHero(data) {
    const c = data.counts;
    const dry = data.readings.filter(r => r.needs_water)
      .sort((a, b) => (b.ideal_low - b.moisture) - (a.ideal_low - a.moisture));

    let eyebrow, title, sub;
    if (c.needs_water === 0 && c.too_wet === 0 && c.missing === 0) {
      eyebrow = "All set"; title = "Nothing needs watering.";
      sub = `All ${c.good} plants are in their ideal range.`;
    } else if (c.needs_water > 0) {
      const list = dry.slice(0, 3).map(r => r.name).join(", ");
      eyebrow = "Action needed";
      title = `${c.needs_water} plant${c.needs_water === 1 ? "" : "s"} need${c.needs_water === 1 ? "s" : ""} water`;
      sub = list + (dry.length > 3 ? ` +${dry.length - 3} more` : "");
    } else if (c.too_wet > 0) {
      eyebrow = "Heads up"; title = `${c.too_wet} plant${c.too_wet === 1 ? "" : "s"} too wet`;
      sub = "Skip these — don't water them.";
    } else {
      eyebrow = "Heads up"; title = `${c.missing} sensor${c.missing === 1 ? "" : "s"} not reporting`;
      sub = "The plants are probably fine — the sensor just isn't sending data.";
    }

    const wx = data.weather; let weatherChip = "";
    if (wx?.available) {
      const parts = [];
      if (wx.temp_now_f != null) parts.push(`Now ${wx.temp_now_f}°F`);
      if (wx.high_today_f != null) parts.push(`Today ${wx.high_today_f}°F`);
      if (wx.rain_today_in && wx.rain_today_in >= 0.05) parts.push(`${wx.rain_today_in.toFixed(2)}" rain today`);
      if (wx.high_tomorrow_f != null) {
        let t = `Tomorrow ${wx.high_tomorrow_f}°F`;
        if (wx.rain_tomorrow_in && wx.rain_tomorrow_in >= 0.05) t += `, ${wx.rain_tomorrow_in.toFixed(2)}" rain`;
        parts.push(t);
      }
      weatherChip = `<span class="hero-weather">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17.5 19a4.5 4.5 0 1 0-3.4-7.5A6 6 0 1 0 7 19h10.5z"/>
        </svg>${escape(parts.join(" · "))}</span>`;
    }

    return `<section class="hero-card fade-in">
      <div class="h-eyebrow">${escape(eyebrow)}</div>
      <h2 class="h-title">${escape(title)}</h2>
      <p class="h-sub">${escape(sub)}</p>
      ${weatherChip}
      <div class="h-stats">
        <div class="hero-stat"><div class="num">${c.needs_water}</div><div class="lbl">NEED WATER</div></div>
        <div class="hero-stat"><div class="num">${c.too_wet}</div><div class="lbl">TOO WET</div></div>
        <div class="hero-stat"><div class="num">${c.good}</div><div class="lbl">DOING FINE</div></div>
        ${c.missing ? `<div class="hero-stat"><div class="num">${c.missing}</div><div class="lbl">OFFLINE</div></div>` : ""}
      </div>
    </section>`;
  }

  // The guest's actual job: a plain checklist of what to water and how much.
  // The owner app has no equivalent — it assumes you already know the garden.
  function renderTodo(data) {
    const dry = data.readings.filter(r => r.needs_water)
      .sort((a, b) => (b.ideal_low - b.moisture) - (a.ideal_low - a.moisture));
    if (!dry.length) return "";
    const items = dry.map(r => `
      <article class="card fade-in" data-status="${escape(r.status)}">
        <div class="card-head">
          <div class="card-name-wrap">
            <div class="card-emoji" aria-hidden="true">${emojiFor(r.name, r.type)}</div>
            <div class="card-name-text">
              <div class="card-name">${escape(r.name)}</div>
              <div class="card-sub">${escape(r.physical_zone || r.zone)} · CH${r.channel}</div>
            </div>
          </div>
          <div class="card-head-right">
            <span class="badge badge--${escape(r.status)}">${escape(r.headline)}</span>
          </div>
        </div>
        <div class="advice">${escape(r.watering_recommendation || r.advice)}</div>
      </article>`).join("");
    return `<section class="zone">
      <div class="zone-head">
        <h2>What to water today</h2>
        <span class="zone-count">${dry.length} plant${dry.length === 1 ? "" : "s"}</span>
      </div>
      <div class="grid grid--grid">${items}</div>
    </section>`;
  }

  function renderCard(r) {
    const battery = r.battery != null ? ` · ${r.battery.toFixed(1)}V` : "";
    const hasRange = r.ideal_low != null && r.ideal_high != null;
    let block = `<div class="moisture-row"><div class="moisture-val" style="color:var(--ink-3);font-size:18px">No reading</div></div>`;
    if (r.moisture != null && hasRange) {
      const clamp = (n) => Math.max(0, Math.min(100, n));
      const pct = clamp(r.moisture), lo = clamp(r.ideal_low), hi = clamp(r.ideal_high);
      block = `
        <div class="moisture-row">
          <div class="moisture-val">${Math.round(r.moisture)}<span class="pct">%</span></div>
          <div class="moisture-range">Ideal ${r.ideal_low}–${r.ideal_high}%</div>
        </div>
        <div class="gauge" aria-hidden="true">
          <div class="gauge-ideal" style="left:${lo}%;width:${hi - lo}%"></div>
          <div class="gauge-bar" style="width:${pct}%"></div>
          <div class="gauge-mark" style="left:${pct}%"></div>
        </div>`;
    } else if (r.moisture != null) {
      block = `<div class="moisture-row">
          <div class="moisture-val">${Math.round(r.moisture)}<span class="pct">%</span></div>
          <div class="moisture-range">No range set</div>
        </div>`;
    }
    const advice = r.status === "no_reading"
      ? (r.last_seen ? `Last reported ${relTime(r.last_seen)}. ` : "") + "Not reporting — probably a sensor battery, not the plant."
      : (r.advice || "");
    return `<article class="card fade-in" data-status="${escape(r.status)}">
      <div class="card-head">
        <div class="card-name-wrap">
          <div class="card-emoji" aria-hidden="true">${emojiFor(r.name, r.type)}</div>
          <div class="card-name-text">
            <div class="card-name" title="${escape(r.name)}">${escape(r.name)}</div>
            <div class="card-sub">CH${r.channel}${escape(battery)}</div>
          </div>
        </div>
        <div class="card-head-right">
          <span class="badge badge--${escape(r.status)}">${escape(r.headline)}</span>
        </div>
      </div>
      ${block}
      <div class="advice">${escape(advice)}</div>
    </article>`;
  }

  function renderReport(data) {
    // Group by the owner's own zone names — no hardcoded zone list, so this
    // works for any shared garden, not just one laid out like Craig's.
    const zones = {};
    for (const r of data.readings) {
      const z = r.physical_zone || r.zone || "Garden";
      (zones[z] = zones[z] || []).push(r);
    }
    let html = renderBanner(data) + renderHero(data) + renderTodo(data);
    for (const z of Object.keys(zones)) {
      const list = zones[z].slice().sort((a, b) => (a.display_order ?? a.channel) - (b.display_order ?? b.channel));
      html += `
        <section class="zone">
          <div class="zone-head">
            <h2>${escape(z)}</h2>
            <span class="zone-count">${list.length} plant${list.length === 1 ? "" : "s"}</span>
          </div>
          <div class="grid grid--grid">${list.map(renderCard).join("")}</div>
        </section>`;
    }
    $("main").innerHTML = html;
  }

  function showError(title, msg) {
    $("main").innerHTML = `<section class="hero-card fade-in">
      <div class="h-eyebrow">Heads up</div>
      <h2 class="h-title">${escape(title)}</h2>
      <p class="h-sub">${msg}</p>
    </section>`;
  }

  /* ── load ─────────────────────────────────────────────────── */
  async function load() {
    if (!ENDPOINT) { showError("Setup needed", "No guest endpoint configured."); return; }
    const btn = $("refresh");
    btn.dataset.spinning = "true"; btn.disabled = true;
    $("meta").textContent = "Fetching the latest readings…";
    try {
      const token = await getAccessToken();
      if (!token) { renderSignIn(() => load()); return; }
      const url = ENDPOINT + (currentGarden ? `?garden=${encodeURIComponent(currentGarden)}` : "");
      const r = await fetch(url, {
        headers: { Accept: "application/json", apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (r.status === 401) { clearSession(); renderSignIn(() => load()); return; }
      const data = await r.json().catch(() => ({}));
      if (r.status === 403 || data.no_shares) {
        showError("No garden shared with this account",
          `You're signed in as <strong>${escape(session?.user?.email || "")}</strong>, but nobody has shared a garden with this address yet.`);
        $("meta").textContent = "Nothing to show";
        return;
      }
      if (!r.ok) throw new Error(`Backend returned HTTP ${r.status}`);
      if (data.error) throw new Error(data.error);

      lastData = data;
      currentGarden = data.viewing?.owner_id || currentGarden;
      if (data.viewing?.garden_name) {
        $("garden-title").textContent = data.viewing.garden_name;
        document.title = `${data.viewing.garden_name} — PlantWatch`;
      }
      $("meta").textContent = `Updated ${relTime(data.generated_at)}`;
      $("counts-meta").textContent = `${data.readings.length} sensors · read-only`;
      renderReport(data);
    } catch (e) {
      showError("Couldn't load the garden", `${escape(e.message)}.`);
    } finally {
      btn.dataset.spinning = "false"; btn.disabled = false;
    }
  }

  function startAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && lastData &&
        Date.now() - new Date(lastData.generated_at).getTime() > REFRESH_MS) load();
  });
  $("refresh").addEventListener("click", load);
  $("signout").addEventListener("click", signOut);
  setInterval(() => { if (lastData) $("meta").textContent = `Updated ${relTime(lastData.generated_at)}`; }, 30_000);

  // Boot: signed in → load; otherwise show the sign-in card.
  (async () => {
    if (session && (await getAccessToken())) { showApp(true); load(); startAutoRefresh(); }
    else renderSignIn(() => { load(); startAutoRefresh(); });
  })();
})();
