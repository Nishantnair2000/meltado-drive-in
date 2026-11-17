// Shared data layer for the customer page and the counter dashboard.
// Two implementations with the same interface:
//   - Demo: localStorage + BroadcastChannel (same browser only, no setup)
//   - Live: Supabase (Postgres + Realtime + Auth)
(function () {
  "use strict";
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  const STATUSES = ["new", "entered_pos", "out_for_delivery", "delivered", "cancelled"];
  const ACTIVE = ["new", "entered_pos", "out_for_delivery"];
  const STAFF_STATUSES = ["new", "entered_pos", "out_for_delivery", "cancelled"]; // staff can't set "delivered"
  // Out-for-delivery stops blocking new orders after 45 min (customer may drive off without confirming).
  const isActive = (o) => o.status === "new" || o.status === "entered_pos" ||
    (o.status === "out_for_delivery" && Date.now() - Date.parse(o.updated_at) < 45 * 60e3);

  // ---------- helpers ----------
  const safeStore = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function deviceId() {
    let id = safeStore.get("meltado_device_id", null);
    if (!id) { id = uuid(); safeStore.set("meltado_device_id", id); }
    return id;
  }

  const normPhone = (p) => {
    let d = String(p || "").replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
    if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
    return d;
  };

  const Geo = {
    distanceM(lat1, lng1, lat2, lng2) {
      const R = 6371000, r = (d) => (d * Math.PI) / 180;
      const dLat = r(lat2 - lat1), dLng = r(lng2 - lng1);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(a));
    },
    // Watches GPS for up to `maxWaitMs`, resolving early once accuracy is good.
    // Handles slow GPS lock and cell-tower fallbacks (which report large accuracy).
    getBestPosition({ goodAccuracyM = 40, maxWaitMs = 12000 } = {}) {
      return new Promise((resolve, reject) => {
        if (!("geolocation" in navigator)) return reject(Object.assign(new Error("UNSUPPORTED"), { code: "UNSUPPORTED" }));
        let best = null, done = false, watchId = null;
        const finish = (fn, val) => {
          if (done) return; done = true;
          if (watchId != null) navigator.geolocation.clearWatch(watchId);
          clearTimeout(timer); fn(val);
        };
        const timer = setTimeout(() => {
          if (best) finish(resolve, best);
          else finish(reject, Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
        }, maxWaitMs);
        watchId = navigator.geolocation.watchPosition(
          (p) => {
            const fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
            if (!best || fix.accuracy < best.accuracy) best = fix;
            if (fix.accuracy <= goodAccuracyM) finish(resolve, best);
          },
          (e) => {
            const code = e.code === 1 ? "DENIED" : e.code === 3 ? "TIMEOUT" : "UNAVAILABLE";
            if (code === "DENIED" || !best) finish(reject, Object.assign(new Error(code), { code }));
          },
          { enableHighAccuracy: true, timeout: maxWaitMs, maximumAge: 0 }
        );
      });
    },
    mapsLink(lat, lng) { return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`; },
  };

  const ERRORS = {
    CLOSED: "The cafe isn't taking drive-in orders right now. Please try again in a little while.",
    OUT_OF_RANGE: "You seem to be outside our drive-in zone (500 m around the cafe). Please park closer and try again.",
    NO_LOCATION: "We need your location to find your car. Please allow location access and try again.",
    OTP_REQUIRED: "Please verify your phone number with the OTP before sending the order.",
    OTP_INVALID: "That OTP didn't work. Please check the code and try again.",
    ACTIVE_ORDER_EXISTS: "You already have 3 orders in progress. You can order again once one of them is received.",
    NOT_OUT_FOR_DELIVERY: "You can confirm once the waiter is on the way with your order.",
    RATE_LIMIT: "Too many orders from this phone number recently. Please ask a waiter for help.",
    BAD_ITEMS: "Something is wrong with the items in your cart. Please refresh and try again.",
    BAD_DETAILS: "Please check your name, phone number and car details.",
    NETWORK: "Couldn't reach the cafe. Check your internet connection and try again.",
    AUTH: "Login failed. Check the email and password.",
    NOT_STAFF: "This account is not registered as cafe staff.",
  };
  function toCode(err) {
    const msg = String((err && (err.code || err.message)) || err || "");
    for (const k of Object.keys(ERRORS)) if (msg.includes(k)) return k;
    if (/fetch|network|Failed to load/i.test(msg)) return "NETWORK";
    return "UNKNOWN";
  }
  const message = (err) => ERRORS[toCode(err)] || "Something went wrong. Please try again or ask a waiter.";

  // Validation shared by demo mode and the UI (server re-validates in live mode).
  function validateDetails(p) {
    const phone = normPhone(p.phone);
    if (!p.name || p.name.trim().length < 2 || p.name.length > 60) return "BAD_DETAILS";
    if (!/^[6-9]\d{9}$/.test(phone)) return "BAD_DETAILS";
    if (!/^[A-Z0-9]{4}$/.test(String(p.car_last4 || "").toUpperCase())) return "BAD_DETAILS";
    if ((p.car_model || "").length > 60 || (p.car_colour || "").length > 30) return "BAD_DETAILS";
    if (!Array.isArray(p.items) || !p.items.length || p.items.length > 40) return "BAD_ITEMS";
    if (p.items.some((i) => !i.name || !(i.qty >= 1 && i.qty <= 20))) return "BAD_ITEMS";
    return null;
  }

  // =====================================================================
  //  DEMO BACKEND
  // =====================================================================
  function makeDemo() {
    const KEY = "meltado_demo_orders", SKEY = "meltado_demo_settings";
    let mem = [];
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("meltado-demo") : null;
    const listeners = new Set();
    const load = () => safeStore.get(KEY, mem);
    const save = (orders) => { mem = orders; safeStore.set(KEY, orders); bc && bc.postMessage("changed"); listeners.forEach((f) => f()); };
    const settings = () => ({
      cafe_lat: cfg.CAFE_LAT, cafe_lng: cfg.CAFE_LNG, radius_m: cfg.RADIUS_M || 500,
      gps_slack_m: cfg.GPS_SLACK_M || 50, require_otp: false, accepting_orders: true,
      max_active_per_phone: 3, max_orders_per_phone_per_2h: 6,
      ...safeStore.get(SKEY, {}),
    });
    const fire = () => listeners.forEach((f) => f());
    bc && (bc.onmessage = fire);
    window.addEventListener("storage", (e) => { if (e.key === KEY || e.key === SKEY) fire(); });
    const fail = (code) => { throw Object.assign(new Error(code), { code }); };
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    return {
      mode: "demo",
      async getPublicSettings() { return settings(); },
      async placeOrder(p) {
        await delay(400);
        const s = settings();
        if (!s.accepting_orders) fail("CLOSED");
        if (p.lat == null || p.lng == null) fail("NO_LOCATION");
        const bad = validateDetails(p); if (bad) fail(bad);
        const dist = p.skipped_location ? 0 : Geo.distanceM(s.cafe_lat, s.cafe_lng, p.lat, p.lng);
        if (dist > s.radius_m + s.gps_slack_m) fail("OUT_OF_RANGE");
        const phone = normPhone(p.phone);
        const orders = load();
        if (orders.filter((o) => o.phone === phone && isActive(o)).length >= s.max_active_per_phone ||
            orders.filter((o) => o.device_id === p.device_id && isActive(o)).length >= s.max_active_per_phone) fail("ACTIVE_ORDER_EXISTS");
        const twoH = Date.now() - 2 * 3600e3;
        if (orders.filter((o) => o.phone === phone && Date.parse(o.created_at) > twoH).length >= s.max_orders_per_phone_per_2h) fail("RATE_LIMIT");
        const now = new Date().toISOString();
        const o = {
          id: uuid(), order_no: (orders.reduce((m, x) => Math.max(m, x.order_no), 100)) + 1, status: "new",
          status_token: uuid(), customer_name: p.name.trim(), phone, car_last4: p.car_last4.toUpperCase(),
          car_model: (p.car_model || "").trim(), car_colour: (p.car_colour || "").trim(), landmark: (p.landmark || "").trim(),
          notes: (p.notes || "").trim(), lat: p.lat, lng: p.lng, accuracy_m: p.accuracy, distance_m: Math.round(dist),
          items: p.items, est_total: p.est_total, device_id: p.device_id, phone_verified: false,
          created_at: now, updated_at: now, demo_location_skipped: !!p.skipped_location,
        };
        orders.push(o); save(orders);
        return { order_id: o.id, order_no: o.order_no, status_token: o.status_token };
      },
      async getOrderStatus(id, token) {
        const o = load().find((x) => x.id === id && x.status_token === token);
        return o ? { status: o.status, order_no: o.order_no } : null;
      },
      async confirmReceived(id, token) {
        const orders = load(); const o = orders.find((x) => x.id === id && x.status_token === token);
        if (!o) fail("NOT_OUT_FOR_DELIVERY");
        if (o.status === "delivered") return { status: "delivered" };
        if (o.status !== "out_for_delivery") fail("NOT_OUT_FOR_DELIVERY");
        o.status = "delivered"; o.received_at = o.updated_at = new Date().toISOString(); save(orders);
        return { status: "delivered", received_at: o.received_at };
      },
      async sendOtp() { return true; },
      async verifyOtp(_phone, code) { if (!/^\d{6}$/.test(code)) fail("OTP_INVALID"); return true; },
      // staff
      async staffSignIn() { safeStore.set("meltado_demo_staff", true); return true; },
      async staffSession() { return !!safeStore.get("meltado_demo_staff", false); },
      async staffSignOut() { safeStore.del("meltado_demo_staff"); },
      async listOrders() {
        const since = Date.now() - 16 * 3600e3;
        return load().filter((o) => Date.parse(o.created_at) > since);
      },
      async updateStatus(id, status) {
        if (!STAFF_STATUSES.includes(status)) throw new Error("bad status");
        const orders = load(); const o = orders.find((x) => x.id === id);
        if (o && o.status !== "delivered") { o.status = status; o.updated_at = new Date().toISOString(); save(orders); }
      },
      async getAccepting() { return settings().accepting_orders; },
      async setAccepting(v) { safeStore.set(SKEY, { ...safeStore.get(SKEY, {}), accepting_orders: !!v }); bc && bc.postMessage("changed"); fire(); },
      async clearDemo() { save([]); },
      subscribe(onEvent, onConn) {
        listeners.add(onEvent); onConn && onConn("SUBSCRIBED");
        return () => listeners.delete(onEvent);
      },
      onCustomerUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
  }

  // =====================================================================
  //  LIVE BACKEND (Supabase)
  // =====================================================================
  function makeLive() {
    let sb = null;
    async function client() {
      if (sb) return sb;
      if (!window.supabase) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
          s.onload = res; s.onerror = () => rej(new Error("NETWORK"));
          document.head.appendChild(s);
        });
      }
      sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      });
      return sb;
    }
    const unwrap = ({ data, error }) => { if (error) throw error; return data; };

    return {
      mode: "live",
      async getPublicSettings() { return unwrap(await (await client()).rpc("get_public_settings")); },
      async placeOrder(p) {
        const bad = validateDetails(p); if (bad) throw new Error(bad);
        const c = await client();
        return unwrap(await c.rpc("place_order", {
          p_name: p.name.trim(), p_phone: normPhone(p.phone), p_car_last4: p.car_last4.toUpperCase(),
          p_car_model: (p.car_model || "").trim() || null, p_car_colour: (p.car_colour || "").trim() || null,
          p_landmark: (p.landmark || "").trim() || null, p_notes: (p.notes || "").trim() || null,
          p_lat: p.lat, p_lng: p.lng, p_accuracy: p.accuracy, p_items: p.items,
          p_est_total: p.est_total, p_device_id: p.device_id,
        }));
      },
      async getOrderStatus(id, token) {
        return unwrap(await (await client()).rpc("get_order_status", { p_order_id: id, p_token: token }));
      },
      async confirmReceived(id, token) {
        return unwrap(await (await client()).rpc("confirm_received", { p_order_id: id, p_token: token }));
      },
      async sendOtp(phone) {
        const { error } = await (await client()).auth.signInWithOtp({ phone: "+91" + normPhone(phone) });
        if (error) throw error; return true;
      },
      async verifyOtp(phone, code) {
        const { error } = await (await client()).auth.verifyOtp({ phone: "+91" + normPhone(phone), token: code, type: "sms" });
        if (error) throw new Error("OTP_INVALID"); return true;
      },
      async staffSignIn(email, password) {
        const c = await client();
        const { error } = await c.auth.signInWithPassword({ email, password });
        if (error) throw new Error("AUTH");
        const ok = unwrap(await c.rpc("is_staff"));
        if (!ok) { await c.auth.signOut(); throw new Error("NOT_STAFF"); }
        return true;
      },
      async staffSession() {
        const c = await client();
        const { data } = await c.auth.getSession();
        if (!data.session) return false;
        try { return !!unwrap(await c.rpc("is_staff")); } catch { return false; }
      },
      async staffSignOut() { await (await client()).auth.signOut(); },
      async listOrders() {
        const since = new Date(Date.now() - 16 * 3600e3).toISOString();
        return unwrap(await (await client()).from("orders").select("*").gte("created_at", since).order("created_at", { ascending: true }));
      },
      async updateStatus(id, status) {
        if (!STAFF_STATUSES.includes(status)) throw new Error("bad status");
        unwrap(await (await client()).from("orders").update({ status }).eq("id", id));
      },
      async getAccepting() {
        const rows = unwrap(await (await client()).from("app_settings").select("accepting_orders").eq("id", 1));
        return rows[0] ? rows[0].accepting_orders : true;
      },
      async setAccepting(v) {
        unwrap(await (await client()).from("app_settings").update({ accepting_orders: !!v }).eq("id", 1));
      },
      subscribe(onEvent, onConn) {
        let ch = null, cancelled = false;
        client().then((c) => {
          if (cancelled) return;
          ch = c.channel("orders-feed")
            .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => onEvent())
            .on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_settings" }, () => onEvent())
            .subscribe((status) => onConn && onConn(status));
        }).catch(() => onConn && onConn("CHANNEL_ERROR"));
        return () => { cancelled = true; ch && sb.removeChannel(ch); };
      },
      onCustomerUpdate() { return () => {}; }, // customer polls instead
    };
  }

  window.App = {
    DEMO, STATUSES, ACTIVE, Geo, safeStore, deviceId, normPhone, validateDetails,
    errorMessage: message, errorCode: toCode,
    backend: DEMO ? makeDemo() : makeLive(),
    rupees: (n) => "₹" + Number(n || 0).toLocaleString("en-IN"),
    esc: (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
  };
})();
