(function () {
  "use strict";
  const { backend, Geo, esc, rupees, DEMO, safeStore } = window.App;
  const $ = (s, r = document) => r.querySelector(s);

  const COLS = [
    { id: "new", title: "New", next: "entered_pos", nextLabel: "Entered in POS" },
    { id: "entered_pos", title: "Entered in POS", next: "out_for_delivery", nextLabel: "Out for delivery", prev: "new" },
    { id: "out_for_delivery", title: "Out for delivery", prev: "entered_pos" },
    { id: "delivered", title: "Received by customer" }, // set only by the customer tapping "I've received my order"
  ];
  const LATE_MIN = 3, VERY_LATE_MIN = 6; // minutes an order may sit in "New"
  const UNCONFIRMED_MIN = 15;            // flag deliveries the customer hasn't confirmed

  const state = {
    orders: [],
    seen: new Set(),
    fresh: new Set(),
    tab: "new",
    sound: safeStore.get("meltado_counter_sound", true),
    accepting: true,
    connected: false,
    audio: null,
    wakeLock: null,
    unsub: null,
    loading: false,
    pending: false,
  };

  // In-page confirm dialog (works on tablets and inside embedded frames).
  function ask(message, okLabel = "Yes", danger = false) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "overlay";
      ov.innerHTML = `<div class="sheet" role="alertdialog" aria-modal="true" style="max-width:420px">
        <h2 style="font-size:19px;margin-bottom:16px">${esc(message)}</h2>
        <div style="display:flex;gap:10px"><button class="btn ghost" style="flex:1" data-a="no">Go back</button>
        <button class="btn ${danger ? "orange" : ""}" style="flex:1" data-a="yes">${esc(okLabel)}</button></div></div>`;
      ov.addEventListener("click", (e) => {
        const a = e.target.closest("[data-a]"); if (!a && e.target !== ov) return;
        ov.remove(); resolve(!!a && a.dataset.a === "yes");
      });
      $("#modalRoot").appendChild(ov);
    });
  }

  function toast(msg, isError) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // =====================================================================
  //  AUTH
  // =====================================================================
  async function init() {
    if (DEMO) {
      $("#demoBanner").classList.remove("hidden");
      $("#clearDemo").classList.remove("hidden");
      $("#loginSub").textContent = "Demo mode: no account needed.";
      $("#emailField").classList.add("hidden"); $("#pwField").classList.add("hidden");
      $("#email").required = false; $("#pw").required = false;
      $("#loginBtn").textContent = "Open demo dashboard";
    }
    let ok = false;
    try { ok = await backend.staffSession(); } catch { /* show login */ }
    ok ? enterDash() : $("#login").classList.remove("hidden");
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const b = $("#loginBtn"); b.disabled = true; const label = b.textContent; b.innerHTML = '<span class="spinner"></span>';
    try { await backend.staffSignIn($("#email").value.trim(), $("#pw").value); $("#login").classList.add("hidden"); enterDash(); }
    catch (err) { toast(window.App.errorMessage(err), true); }
    finally { b.disabled = false; b.textContent = label; }
  });
  $("#logoutBtn").onclick = async () => {
    if (!(await ask("Log out of the counter? New orders will not alert on this screen.", "Log out", true))) return;
    state.unsub && state.unsub();
    await backend.staffSignOut(); location.reload();
  };

  // =====================================================================
  //  DASHBOARD
  // =====================================================================
  function enterDash() {
    $("#dash").classList.remove("hidden");
    $("#start").classList.remove("hidden");
    renderSoundBtn();
    $("#tabs").innerHTML = COLS.map((c) => `<button data-tab="${c.id}" class="${c.id === state.tab ? "on" : ""}">${c.title} <span data-tabn="${c.id}"></span></button>`).join("");
    $("#tabs").onclick = (e) => {
      const b = e.target.closest("[data-tab]"); if (!b) return;
      state.tab = b.dataset.tab; render();
    };
    state.unsub = backend.subscribe(scheduleRefresh, onConn);
    refresh();
    setInterval(refresh, 20000);            // safety net in case a realtime event is missed
    setInterval(tick, 1000);                // clock + order ages
    setInterval(alarm, 4000);               // repeating alert while any order is New
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") { refresh(); requestWakeLock(); }
    });
  }

  $("#startBtn").onclick = async () => {
    // Browsers only allow sound after a tap, so we unlock audio here.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audio = new Ctx(); await state.audio.resume();
    } catch { /* no audio */ }
    await requestWakeLock();
    if ("Notification" in window && Notification.permission === "default") { try { await Notification.requestPermission(); } catch { /* ignore */ } }
    $("#start").classList.add("hidden");
    chime();
  };

  function onConn(status) {
    state.connected = status === "SUBSCRIBED";
    $("#connDot").className = "dot " + (state.connected ? "ok" : "bad");
    $("#connText").textContent = state.connected ? (DEMO ? "Live (demo)" : "Live") : "Reconnecting… (checking every 20s)";
    if (state.connected) refresh();
  }

  let refreshTimer = null;
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 250); }

  async function refresh() {
    if (state.loading) { state.pending = true; return; }
    state.loading = true;
    try {
      const [orders, accepting] = await Promise.all([backend.listOrders(), backend.getAccepting().catch(() => state.accepting)]);
      const firstLoad = !state.loadedOnce;
      state.loadedOnce = true;
      orders.forEach((o) => {
        if (!state.seen.has(o.id)) {
          state.seen.add(o.id);
          if (!firstLoad && o.status === "new") { state.fresh.add(o.id); notify(o); }
        }
      });
      state.orders = orders;
      state.accepting = accepting;
      render();
    } catch (err) {
      const code = window.App.errorCode(err);
      if (/JWT|auth|401|permission/i.test(String(err && err.message))) { toast("Session expired — please log in again.", true); }
      else if (code === "NETWORK") { onConn("CHANNEL_ERROR"); }
    } finally {
      state.loading = false;
      if (state.pending) { state.pending = false; refresh(); }
    }
  }

  function notify(o) {
    chime();
    if ("vibrate" in navigator) navigator.vibrate([200, 100, 200]);
    if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
      try { new Notification(`New order #${o.order_no}`, { body: `${o.customer_name} · car …${o.car_last4}`, tag: o.id }); } catch { /* ignore */ }
    }
  }

  // ---------- sound ----------
  function chime() {
    if (!state.sound || !state.audio) return;
    const ctx = state.audio, t0 = ctx.currentTime;
    [[880, 0], [1175, 0.18], [880, 0.36], [1175, 0.54]].forEach(([f, dt]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
      o.connect(g).connect(ctx.destination); o.start(t0 + dt); o.stop(t0 + dt + 0.17);
    });
  }
  function alarm() {
    const n = state.orders.filter((o) => o.status === "new").length;
    document.title = n ? `(${n}) NEW ORDER · Meltado` : "Meltado · Counter";
    if (n) chime(); // keeps ringing until every new order is marked "Entered in POS"
  }
  function renderSoundBtn() { $("#soundBtn").textContent = state.sound ? "Sound on" : "Sound off"; }
  $("#soundBtn").onclick = () => {
    state.sound = !state.sound; safeStore.set("meltado_counter_sound", state.sound); renderSoundBtn();
    if (state.sound) chime();
  };

  // ---------- wake lock ----------
  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) { $("#wakeText").textContent = "Screen lock: not supported — set display to never sleep"; return; }
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      $("#wakeText").textContent = "Screen stays on";
      state.wakeLock.addEventListener("release", () => { $("#wakeText").textContent = "Screen lock: off"; });
    } catch { $("#wakeText").textContent = "Screen lock: off (tap Start)"; }
  }

  // ---------- accepting toggle ----------
  $("#acceptBtn").onclick = async () => {
    const next = !state.accepting;
    if (!next && !(await ask("Pause new drive-in orders? Customers will see that the cafe isn't taking orders.", "Pause orders", true))) return;
    try { await backend.setAccepting(next); state.accepting = next; render(); }
    catch (err) { toast("Couldn't change: " + window.App.errorMessage(err), true); }
  };
  $("#clearDemo").onclick = async () => { if (await ask("Delete all demo orders?", "Delete", true)) { await backend.clearDemo(); state.seen.clear(); refresh(); } };

  // =====================================================================
  //  RENDER
  // =====================================================================
  const minutesSince = (iso) => (Date.now() - Date.parse(iso)) / 60000;
  function ageText(iso) {
    const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  const timeText = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function render() {
    const a = $("#acceptBtn");
    a.textContent = state.accepting ? "Accepting orders" : "Orders paused";
    a.classList.toggle("off", !state.accepting);

    $("#board").innerHTML = COLS.map((c) => {
      let list = state.orders.filter((o) => o.status === c.id);
      if (c.id === "delivered") list = list.sort((x, y) => Date.parse(y.received_at || y.updated_at) - Date.parse(x.received_at || x.updated_at)).slice(0, 15);
      else list = list.sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at)); // first come, first served
      return `<div class="col ${state.tab === c.id ? "on" : ""}" data-col="${c.id}">
        <h3>${c.title} <span class="n">${state.orders.filter((o) => o.status === c.id).length}</span></h3>
        ${list.length ? list.map((o) => card(o, c)).join("") : `<div class="empty">${c.id === "new" ? "No new orders. Alerts are on." : "Nothing here."}</div>`}
      </div>`;
    }).join("");
    COLS.forEach((c) => {
      const el = document.querySelector(`[data-tabn="${c.id}"]`);
      if (el) el.textContent = `(${state.orders.filter((o) => o.status === c.id).length})`;
      const t = document.querySelector(`[data-tab="${c.id}"]`); if (t) t.classList.toggle("on", state.tab === c.id);
    });
    state.fresh.clear();
    tick();
  }

  function card(o, col) {
    const items = Array.isArray(o.items) ? o.items : [];
    const late = o.status === "new" ? minutesSince(o.created_at) : 0;
    const cls = ["card", "s-" + o.status, state.fresh.has(o.id) ? "fresh" : "",
      late >= VERY_LATE_MIN ? "very-late" : late >= LATE_MIN ? "late" : ""].join(" ");
    const phone = String(o.phone || "");
    const sameCar = o.status === "delivered" || o.status === "cancelled" ? [] : state.orders.filter((x) => x.id !== o.id && x.phone === o.phone && ["new", "entered_pos", "out_for_delivery"].includes(x.status));
    return `<article class="${cls}" data-id="${o.id}">
      <div class="c-head">
        <span class="c-no">#${esc(o.order_no)}</span>
        ${o.phone_verified ? '<span class="badge ok">OTP verified</span>' : ""}
        ${o.demo_location_skipped ? '<span class="badge warn">demo pin</span>' : ""}
        ${sameCar.length ? `<span class="badge" title="Separate orders from the same customer">Same car: ${sameCar.map((x) => "#" + esc(x.order_no)).join(", ")}</span>` : ""}
        <span class="c-age" data-age="${esc(o.status === "delivered" ? "" : o.created_at)}" title="Placed at ${timeText(o.created_at)}">${o.status === "delivered" ? "Received " + timeText(o.received_at || o.updated_at) : ""}</span>
      </div>
      <div class="car">
        <span class="plate">${esc(o.car_last4)}</span>
        <span class="car-desc">${[o.car_colour, o.car_model].filter(Boolean).map(esc).join(" ") || '<span class="total">Model/colour not given</span>'}</span>
      </div>
      <div class="meta">
        <b>${esc(o.customer_name)}</b> · <a href="tel:+91${esc(phone)}">${esc(phone.slice(0, 5))} ${esc(phone.slice(5))}</a><br>
        ${o.landmark ? esc(o.landmark) + " · " : ""}${o.distance_m != null ? Math.round(o.distance_m) + " m away" : ""}
        ${o.accuracy_m ? `<span class="total">(±${Math.round(o.accuracy_m)} m)</span>` : ""}
        · <a href="${Geo.mapsLink(o.lat, o.lng)}" target="_blank" rel="noopener">Open in Maps</a>
      </div>
      <ul class="items">
        ${items.map((i) => `<li><span class="q">${esc(i.qty)}×</span>${esc(i.name)}${i.options && i.options.length ? `<span class="o">${i.options.map(esc).join(" · ")}</span>` : ""}</li>`).join("")}
      </ul>
      ${o.notes ? `<div class="note"><b>Note:</b> ${esc(o.notes)}</div>` : ""}
      <div class="total">Menu estimate ${rupees(o.est_total)} · placed ${timeText(o.created_at)}</div>
      <div class="c-foot">
        ${col.next ? `<button class="btn ${o.status === "new" ? "orange" : ""}" data-act="set" data-status="${col.next}">${col.nextLabel}</button>`
          : o.status === "out_for_delivery" ? waitingText(o)
          : `<span class="received">Customer confirmed receipt at ${timeText(o.received_at || o.updated_at)}</span>`}
        ${col.prev ? `<button class="icon-btn" data-act="set" data-status="${col.prev}" title="Move back a step">Back</button>` : ""}
        ${o.status !== "delivered" ? `<button class="icon-btn danger" data-act="cancel" title="Cancel order">Cancel</button>` : ""}
      </div>
    </article>`;
  }

  function waitingText(o) {
    const m = minutesSince(o.updated_at);
    return m >= UNCONFIRMED_MIN
      ? `<span class="waiting late-confirm">Not confirmed by customer for ${Math.floor(m)} min — check with the waiter</span>`
      : `<span class="waiting">Waiting for customer to confirm receipt</span>`;
  }

  function tick() {
    $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    document.querySelectorAll("[data-age]").forEach((el) => {
      if (!el.dataset.age) return;
      el.textContent = ageText(el.dataset.age);
      const card = el.closest(".card");
      if (card.classList.contains("s-new")) {
        const m = minutesSince(el.dataset.age);
        card.classList.toggle("late", m >= LATE_MIN && m < VERY_LATE_MIN);
        card.classList.toggle("very-late", m >= VERY_LATE_MIN);
      }
    });
  }

  $("#board").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const id = b.closest(".card").dataset.id;
    const o = state.orders.find((x) => x.id === id); if (!o) return;
    let status = b.dataset.status;
    if (b.dataset.act === "cancel") {
      if (!(await ask(`Cancel order #${o.order_no} for ${o.customer_name}? The customer will see it as cancelled.`, "Cancel order", true))) return;
      status = "cancelled";
    }
    b.disabled = true;
    const prev = o.status;
    o.status = status; o.updated_at = new Date().toISOString(); render(); // optimistic
    try { await backend.updateStatus(id, status); }
    catch (err) { o.status = prev; render(); toast("Couldn't update order: " + window.App.errorMessage(err), true); }
  });

  init();
})();
