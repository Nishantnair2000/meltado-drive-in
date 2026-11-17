(function () {
  "use strict";
  const { backend, Geo, safeStore, esc, rupees, DEMO } = window.App;
  const cfg = window.APP_CONFIG || {};
  const MENU = window.MENU || [];
  const $ = (s, r = document) => r.querySelector(s);

  const ITEMS = new Map();
  MENU.forEach((c) => c.items.forEach((i) => ITEMS.set(i.id, { ...i, category: c.name })));

  const state = {
    settings: null,
    pos: null, // {lat,lng,accuracy,distance,skipped}
    cart: new Map(safeStore.get("meltado_cart", [])),
    details: safeStore.get("meltado_details", {}),
    notes: "",
    orders: loadOrders(), // one entry per order sent from this phone, newest first
    pollTimer: null,
  };

  function loadOrders() {
    let list = safeStore.get("meltado_orders", null);
    if (!list) { // migrate from the single-order version
      const old = safeStore.get("meltado_active_order", null);
      list = old ? [{ ...old, status: "new", items: [], total: 0 }] : [];
      safeStore.del("meltado_active_order");
    }
    return list.filter((o) => Date.now() - (o.at || 0) < 12 * 3600e3);
  }
  const saveOrders = () => safeStore.set("meltado_orders", state.orders);

  // ---------- small UI helpers ----------
  function toast(msg, isError) {
    document.querySelectorAll(".toast").forEach((t) => t.remove());
    const t = document.createElement("div");
    t.className = "toast" + (isError ? " error" : "");
    t.setAttribute("role", "alert");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), isError ? 5500 : 2600);
  }
  // ---- popups/sheets ----
  // Each open sheet adds one browser-history entry, so the phone's back
  // gesture/button closes the sheet instead of leaving the page.
  let modalHist = false;     // a history entry exists for the open sheet
  let modalBack = null;      // what "back" does for the open sheet
  let ignorePop = false;     // our own history.back() from closeModal()
  function clearModal() { $("#modalRoot").innerHTML = ""; document.body.style.overflow = ""; }
  function openModal(html, { onClose, dismissable = true, onBack } = {}) {
    clearModal();
    document.querySelectorAll(".toast:not(.error)").forEach((t) => t.remove());
    const ov = document.createElement("div");
    ov.className = "overlay";
    ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${dismissable ? '<span class="sheet-grip" aria-hidden="true"></span><button class="sheet-x" type="button" aria-label="Close"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>' : ""}${html}</div>`;
    const sheet = ov.firstElementChild;
    const dismiss = () => { closeModal(); onClose && onClose(); };
    if (dismissable) {
      ov.addEventListener("click", (e) => { if (e.target === ov) dismiss(); });
      sheet.querySelector(".sheet-x").addEventListener("click", dismiss);
      enableSwipeDown(sheet, dismiss);
    }
    modalBack = onBack || (dismissable ? () => { onClose && onClose(); } : null);
    $("#modalRoot").appendChild(ov);
    document.body.style.overflow = "hidden";
    if (!modalHist) { history.pushState({ meltadoSheet: true }, ""); modalHist = true; }
    return sheet;
  }
  function closeModal() {
    clearModal(); modalBack = null;
    if (modalHist) { modalHist = false; ignorePop = true; history.back(); }
  }
  window.addEventListener("popstate", () => {
    if (ignorePop) { ignorePop = false; return; }
    if (!modalHist) return; // no sheet open: normal browser back
    modalHist = false;
    if (state.sending) { history.pushState({ meltadoSheet: true }, ""); modalHist = true; return; } // don't interrupt a send
    const fn = modalBack; clearModal(); modalBack = null;
    fn && fn();
  });
  // Drag a sheet down (when scrolled to its top) to close it.
  function enableSwipeDown(sheet, onDismiss) {
    let y0 = null, dy = 0;
    sheet.addEventListener("touchstart", (e) => { y0 = sheet.scrollTop <= 0 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 0) { sheet.style.transform = `translateY(${dy}px)`; sheet.style.transition = "none"; }
    }, { passive: true });
    sheet.addEventListener("touchend", () => {
      if (y0 == null) return;
      sheet.style.transition = "transform .18s ease-out";
      if (dy > 110) onDismiss(); else sheet.style.transform = "";
      y0 = null;
    });
  }
  function show(id) {
    $("#cartbar").classList.toggle("hidden", id !== "menu" || cartCount() === 0);
  }
  const saveCart = () => safeStore.set("meltado_cart", [...state.cart.entries()]);

  // =====================================================================
  //  LOCATION — asked only when the customer taps "Review order"
  // =====================================================================
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  const POS_FRESH_MS = 2 * 60e3; // reuse a fix taken in the last 2 minutes

  function updatePill() {
    if (!state.pos) { $("#locPill").classList.add("hidden"); return; }
    $("#locPill").textContent = state.pos.skipped ? "Demo location" : `${fmtDist(state.pos.distance)} from cafe`;
    $("#locPill").classList.remove("hidden");
  }

  // Resolves {ok:true} or {ok:false, kind:"warn"|"bad", html}
  async function locateCustomer() {
    try {
      if (!state.settings) state.settings = await backend.getPublicSettings();
    } catch { return { ok: false, kind: "bad", html: window.App.errorMessage("NETWORK") }; }
    const s = state.settings;
    if (!s.accepting_orders) return { ok: false, kind: "bad", html: window.App.errorMessage("CLOSED") };
    if (state.pos && (state.pos.skipped || Date.now() - state.pos.at < POS_FRESH_MS)) return { ok: true };
    try {
      const pos = await Geo.getBestPosition();
      const d = Geo.distanceM(s.cafe_lat, s.cafe_lng, pos.lat, pos.lng);
      if (d <= s.radius_m + s.gps_slack_m) {
        state.pos = { ...pos, distance: Math.round(d), at: Date.now() };
        updatePill();
        return { ok: true };
      }
      if (pos.accuracy > 150 && d - pos.accuracy <= s.radius_m) {
        return { ok: false, kind: "warn", html: `Your location is only approximate (±${fmtDist(pos.accuracy)}), so we can't confirm you're near the cafe.
          <ol><li>Turn on GPS / <b>Precise location</b> for your browser.</li><li>Step out of covered parking if you can.</li><li>Tap <b>Review order</b> again.</li></ol>` };
      }
      return { ok: false, kind: "bad", html: `You're about <b>${fmtDist(d)}</b> from Meltado. Drive-in orders are accepted only when you're parked within <b>${fmtDist(s.radius_m)}</b> of the cafe.` };
    } catch (e) {
      const code = e.code || window.App.errorCode(e);
      if (code === "DENIED") {
        return { ok: false, kind: "bad", html: `Location access is blocked. We need it so the waiter can find your car.
          <ol><li><b>iPhone:</b> Settings → Privacy &amp; Security → Location Services → Safari Websites → <i>While Using</i>.</li>
          <li><b>Android (Chrome):</b> tap the lock icon next to the address → Permissions → Location → <i>Allow</i>.</li>
          <li>Come back and tap <b>Review order</b> again.</li></ol>` };
      }
      if (code === "TIMEOUT" || code === "UNAVAILABLE") return { ok: false, kind: "warn", html: "We couldn't get your location. Turn on GPS / location services and tap <b>Review order</b> again." };
      if (code === "UNSUPPORTED") return { ok: false, kind: "bad", html: "This browser can't share location. Please open the link in Chrome or Safari." };
      return { ok: false, kind: "bad", html: window.App.errorMessage(e) };
    }
  }

  function useDemoLocation() {
    const s = state.settings || { cafe_lat: cfg.CAFE_LAT, cafe_lng: cfg.CAFE_LNG };
    state.pos = { lat: s.cafe_lat, lng: s.cafe_lng, accuracy: 0, distance: 0, skipped: true, at: Date.now() };
    updatePill();
  }

  // =====================================================================
  //  MENU
  // =====================================================================
  function itemQty(itemId) {
    let n = 0;
    state.cart.forEach((l) => { if (l.itemId === itemId) n += l.qty; });
    return n;
  }
  const cartCount = () => [...state.cart.values()].reduce((s, l) => s + l.qty, 0);
  const cartTotal = () => [...state.cart.values()].reduce((s, l) => s + l.qty * l.unitPrice, 0);

  function renderMenu() {
    $("#cats").innerHTML = MENU.map((c, i) => `<button data-cat="${c.id}" class="${i === 0 ? "on" : ""}">${esc(c.name)}</button>`).join("");
    $("#menuList").innerHTML = MENU.map((c) => `
      <section class="cat" id="cat-${c.id}" data-search="${esc(normalize(c.name + " " + c.group))}">
        <div class="cat-head"><h2>${esc(c.name)}</h2><span class="eyebrow">${esc(c.group)}</span></div>
        ${c.note ? `<div class="cat-note">${esc(c.note)}</div>` : ""}
        ${c.items.map((i) => `
          <div class="item" data-item="${i.id}" data-search="${esc(normalize([i.name, i.desc, (i.aliases || []).join(" "), i.whipped ? "whipped cream" : ""].join(" ")))}">
            <div class="info">
              <div class="name">${esc(i.name)}${i.whipped ? '<span class="tag">· whipped cream</span>' : ""}</div>
              ${i.desc ? `<div class="desc">${esc(i.desc)}</div>` : ""}
              <div class="price">${rupees(i.price)}</div>
              <div class="incart" data-incart="${i.id}"></div>
            </div>
            <div class="ctrl" data-ctrl="${i.id}"></div>
          </div>`).join("")}
      </section>`).join("");
    MENU.forEach((c) => c.items.forEach((i) => renderCtrl(i.id)));

    // Tapping a category scrolls its section to just under the pinned header.
    // We scroll the page and the chip row with separate scrollTo calls (never
    // scrollIntoView), because a second scrollIntoView cancels the first one's
    // smooth scroll in some browsers and the page stopped short.
    let jumping = false, jumpTimer = null;
    const centreChip = (b, smooth) => {
      const row = $("#cats");
      row.scrollTo({ left: b.offsetLeft - (row.clientWidth - b.offsetWidth) / 2, behavior: smooth ? "smooth" : "auto" });
    };
    const markChip = (id, smooth) => {
      document.querySelectorAll("#cats button").forEach((b) => {
        const on = b.dataset.cat === id; b.classList.toggle("on", on);
        if (on) centreChip(b, smooth);
      });
    };
    const stickyOffset = () => document.querySelector(".view-tabs").offsetHeight + document.querySelector(".menu-head").offsetHeight;
    $("#cats").onclick = (e) => {
      const b = e.target.closest("button[data-cat]"); if (!b) return;
      const sec = document.getElementById("cat-" + b.dataset.cat);
      const top = sec.getBoundingClientRect().top + window.scrollY - stickyOffset() + 1;
      jumping = true; clearTimeout(jumpTimer);
      markChip(b.dataset.cat, true);
      window.scrollTo({ top, behavior: "smooth" });
      const done = () => { jumping = false; window.removeEventListener("scrollend", done); };
      window.addEventListener("scrollend", done);
      jumpTimer = setTimeout(done, 1200); // fallback for browsers without "scrollend"
    };
    // Highlight the category you're looking at while scrolling by hand.
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        if (jumping) return;
        entries.forEach((en) => { if (en.isIntersecting) markChip(en.target.id.replace("cat-", ""), false); });
      }, { rootMargin: "-180px 0px -60% 0px" });
      document.querySelectorAll(".cat").forEach((s) => io.observe(s));
    }
    $("#menuList").onclick = (e) => {
      const t = e.target.closest("button[data-act]"); if (!t) return;
      const id = t.dataset.id, item = ITEMS.get(id);
      if (t.dataset.act === "open") return openOptions(item);
      if (t.dataset.act === "add") changeLine(id, +1, item);
      if (t.dataset.act === "inc") changeLine(id, +1, item);
      if (t.dataset.act === "dec") changeLine(id, -1, item);
    };
  }

  // ---------- search ----------
  // Accent- and case-insensitive: "creme" matches "Crème", "cafe" matches "Café".
  function normalize(str) {
    return String(str || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function applySearch(raw) {
    const terms = normalize(raw).split(" ").filter(Boolean);
    const searching = terms.length > 0;
    let count = 0;
    document.querySelectorAll("#menuList .cat").forEach((sec) => {
      const catText = sec.dataset.search;
      let shown = 0;
      sec.querySelectorAll(".item").forEach((it) => {
        // every word typed must appear in the item (or its category name)
        const hay = it.dataset.search + " " + catText;
        const ok = !searching || terms.every((t) => hay.includes(t));
        it.classList.toggle("hidden", !ok);
        if (ok) shown++;
      });
      sec.classList.toggle("hidden", shown === 0);
      count += shown;
    });
    $("#cats").classList.toggle("hidden", searching);
    $("#searchClear").classList.toggle("hidden", !raw);
    const info = $("#searchInfo");
    info.classList.toggle("hidden", !searching || count === 0);
    $("#noResults").classList.toggle("hidden", !searching || count > 0);
    if (searching) {
      info.textContent = `${count} item${count === 1 ? "" : "s"} found`;
      $("#noResults").innerHTML = `No items match “${esc(raw.trim())}”.<br>Try a shorter word, like “mocha” or “fries”.`;
    }
  }
  function setupSearch() {
    const input = $("#searchInput");
    let t = null;
    input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { applySearch(input.value); window.scrollTo(0, 0); }, 120); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur(); // hide the phone keyboard to show results
      if (e.key === "Escape") { input.value = ""; applySearch(""); }
    });
    $("#searchClear").onclick = () => { input.value = ""; applySearch(""); input.focus(); };
  }

  function renderCtrl(itemId) {
    const item = ITEMS.get(itemId), q = itemQty(itemId);
    const ctrl = document.querySelector(`[data-ctrl="${itemId}"]`);
    const inc = document.querySelector(`[data-incart="${itemId}"]`);
    if (!ctrl) return;
    if (item.options && item.options.length) {
      ctrl.innerHTML = `<button class="add-btn" data-act="open" data-id="${itemId}">Add +</button>`;
      inc.textContent = q ? `${q} in cart` : "";
    } else if (q === 0) {
      ctrl.innerHTML = `<button class="add-btn" data-act="add" data-id="${itemId}">Add</button>`;
      inc.textContent = "";
    } else {
      ctrl.innerHTML = `<div class="stepper"><button data-act="dec" data-id="${itemId}" aria-label="Remove one">−</button><span>${q}</span><button data-act="inc" data-id="${itemId}" aria-label="Add one">+</button></div>`;
      inc.textContent = "";
    }
  }

  // simple items: line key = item id
  function changeLine(key, delta, item) {
    const l = state.cart.get(key);
    if (!l && delta > 0) state.cart.set(key, { key, itemId: item.id, name: item.name, base: item.price, unitPrice: item.price, options: [], qty: 1 });
    else if (l) { l.qty = Math.min(20, l.qty + delta); if (l.qty <= 0) state.cart.delete(key); }
    saveCart();
    renderCtrl(l ? l.itemId : item.id);
    updateCartBar();
  }

  function updateCartBar() {
    const n = cartCount();
    $("#cartCount").textContent = `${n} item${n === 1 ? "" : "s"}`;
    $("#cartTotal").textContent = rupees(cartTotal());
    $("#cartbar").classList.toggle("hidden", n === 0 || $("#menu").classList.contains("hidden"));
  }

  // ---------- options sheet ----------
  function openOptions(item) {
    let qty = 1;
    const sheet = openModal(`
      <h2>${esc(item.name)}</h2>
      <p class="sub">${esc(item.desc || item.category)} · ${rupees(item.price)}</p>
      <form id="optForm">
        ${item.options.map((g) => `
          <div class="opt-group">
            <h4>${esc(g.label)} ${g.required ? "<em>Required</em>" : ""}</h4>
            ${g.type === "single" && !g.required ? `<label class="opt"><input type="radio" name="${g.id}" value="" checked><span>None</span></label>` : ""}
            ${g.choices.map((c, i) => `
              <label class="opt"><input type="${g.type === "single" ? "radio" : "checkbox"}" name="${g.id}" value="${i}">
                <span>${esc(c.name)}</span>${c.price ? `<b>+${rupees(c.price)}</b>` : ""}</label>`).join("")}
          </div>`).join("")}
      </form>
      <div class="sheet-foot">
        <div class="stepper light"><button type="button" id="oDec">−</button><span id="oQty">1</span><button type="button" id="oInc">+</button></div>
        <button class="btn orange" id="oAdd" disabled>Add · <span id="oPrice"></span></button>
      </div>`);
    const form = $("#optForm", sheet);
    const read = () => {
      const chosen = []; let ok = true;
      item.options.forEach((g) => {
        const vals = [...form.querySelectorAll(`[name="${g.id}"]:checked`)].map((x) => x.value).filter((v) => v !== "");
        if (g.required && !vals.length) ok = false;
        vals.forEach((v) => { const c = g.choices[+v]; chosen.push({ group: g.label.replace(/\s*\(.*\)/, ""), name: c.name, price: c.price }); });
      });
      return { chosen, ok };
    };
    const refresh = () => {
      const { chosen, ok } = read();
      const unit = item.price + chosen.reduce((s, c) => s + c.price, 0);
      $("#oPrice", sheet).textContent = rupees(unit * qty);
      $("#oQty", sheet).textContent = qty;
      $("#oAdd", sheet).disabled = !ok;
    };
    form.addEventListener("change", refresh);
    $("#oDec", sheet).onclick = () => { qty = Math.max(1, qty - 1); refresh(); };
    $("#oInc", sheet).onclick = () => { qty = Math.min(20, qty + 1); refresh(); };
    $("#oAdd", sheet).onclick = () => {
      const { chosen, ok } = read(); if (!ok) return;
      const key = item.id + "|" + chosen.map((c) => c.name).sort().join("+");
      const unit = item.price + chosen.reduce((s, c) => s + c.price, 0);
      const l = state.cart.get(key);
      if (l) l.qty = Math.min(20, l.qty + qty);
      else state.cart.set(key, { key, itemId: item.id, name: item.name, base: item.price, unitPrice: unit, options: chosen, qty });
      saveCart(); closeModal(); renderCtrl(item.id); updateCartBar();
      toast(`Added ${qty} × ${item.name}`);
    };
    refresh();
  }

  const optText = (l) => l.options.map((o) => (o.price ? `${o.name} (+${rupees(o.price)})` : `${o.group}: ${o.name}`)).join(", ");

  // ---------- cart + details ----------
  function openCart() {
    const d = state.details;
    const sheet = openModal(`
      <h2>Your cart</h2>
      <p class="sub">Review items, then tell us how to find your car.</p>
      <div id="lines"></div>
      <div class="total-row"><span>Estimated total</span><span id="cTotal"></span></div>
      <p class="pay-note">No online payment. Pay by UPI to the waiter when your order and printed bill arrive.</p>

      <label class="field"><span>Special instructions <small>(optional)</small></span>
        <textarea id="fNotes" rows="2" maxlength="280" placeholder="e.g. less ice, no onions">${esc(state.notes)}</textarea></label>

      <div class="section-title">Your details</div>
      <form id="detailsForm" novalidate>
        <label class="field" data-f="name"><span>Name</span>
          <input id="fName" autocomplete="name" maxlength="60" value="${esc(d.name || "")}" placeholder="Your name">
          <div class="err">Please enter your name.</div></label>
        <label class="field" data-f="phone"><span>Phone number</span>
          <div class="prefix"><b>+91</b><input id="fPhone" type="tel" inputmode="numeric" autocomplete="tel-national" maxlength="10" value="${esc(d.phone || "")}" placeholder="10-digit mobile"></div>
          <div class="err">Enter a valid 10-digit mobile number.</div></label>

        <div class="section-title">Your car</div>
        <label class="field" data-f="last4"><span>Last 4 characters of car number</span>
          <input id="fLast4" maxlength="4" autocapitalize="characters" value="${esc(d.car_last4 || "")}" placeholder="e.g. 4521" style="text-transform:uppercase;letter-spacing:.3em;font-weight:800">
          <div class="err">Enter the last 4 characters of your number plate.</div></label>
        <div class="row2">
          <label class="field" data-f="model"><span>Car model <small>(optional)</small></span>
            <input id="fModel" maxlength="60" value="${esc(d.car_model || "")}" placeholder="e.g. Swift"></label>
          <label class="field" data-f="colour"><span>Colour <small>(optional)</small></span>
            <input id="fColour" maxlength="30" value="${esc(d.car_colour || "")}" placeholder="e.g. White"></label>
        </div>
        <label class="field"><span>Where are you parked? <small>(optional landmark)</small></span>
          <input id="fLandmark" maxlength="140" value="${esc(d.landmark || "")}" placeholder="e.g. opposite the pharmacy"></label>
      </form>
      <p class="loc-note">When you tap <b>Review order</b>, we'll ask for your location so the waiter can find your car. Orders are accepted only within 500 m of the cafe.</p>
      <div id="locBox" class="loc-box hidden" role="status"></div>
      <button class="btn orange block" id="reviewBtn">Review order</button>`);

    const renderLines = () => {
      if (!state.cart.size) { closeModal(); show("menu"); updateCartBar(); return; }
      $("#lines", sheet).innerHTML = [...state.cart.values()].map((l) => `
        <div class="line">
          <div class="info"><b>${esc(l.name)}</b>${l.options.length ? `<div class="opts">${esc(optText(l))}</div>` : ""}</div>
          <div class="stepper light"><button data-k="${esc(l.key)}" data-d="-1" aria-label="Remove one">−</button><span>${l.qty}</span><button data-k="${esc(l.key)}" data-d="1" aria-label="Add one">+</button></div>
          <div class="lp">${rupees(l.qty * l.unitPrice)}</div>
        </div>`).join("");
      $("#cTotal", sheet).textContent = rupees(cartTotal());
    };
    $("#lines", sheet).onclick = (e) => {
      const b = e.target.closest("button[data-k]"); if (!b) return;
      const l = state.cart.get(b.dataset.k); if (!l) return;
      l.qty = Math.min(20, l.qty + Number(b.dataset.d));
      if (l.qty <= 0) state.cart.delete(l.key);
      saveCart(); renderCtrl(l.itemId); updateCartBar(); renderLines();
    };
    $("#fPhone", sheet).addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10); });
    $("#fLast4", sheet).addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4); });
    $("#reviewBtn", sheet).onclick = async (e) => {
      const v = readDetails(sheet);
      if (!v) return;
      const btn = e.currentTarget, box = $("#locBox", sheet);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Checking your location…';
      box.className = "loc-box info";
      box.textContent = "Getting an accurate GPS fix. This can take up to 10 seconds, so keep this page open.";
      const r = await locateCustomer();
      btn.disabled = false; btn.textContent = "Review order";
      if (!sheet.isConnected) return; // customer closed the cart meanwhile
      if (r.ok) { openConfirm(v); return; }
      box.className = "loc-box " + r.kind;
      box.innerHTML = r.html + (DEMO ? '<button type="button" class="btn link" id="demoSkip">Demo only: continue without location</button>' : "");
      box.scrollIntoView({ behavior: "smooth", block: "center" });
      const skip = $("#demoSkip", sheet);
      if (skip) skip.onclick = () => { useDemoLocation(); openConfirm(v); };
    };
    renderLines();
  }

  function readDetails(sheet) {
    const get = (id) => $(id, sheet).value.trim();
    const d = {
      name: get("#fName"), phone: get("#fPhone"), car_last4: get("#fLast4").toUpperCase(),
      car_model: get("#fModel"), car_colour: get("#fColour"), landmark: get("#fLandmark"),
    };
    state.notes = get("#fNotes");
    const checks = {
      name: d.name.length >= 2, phone: /^[6-9]\d{9}$/.test(d.phone), last4: /^[A-Z0-9]{4}$/.test(d.car_last4),
    };
    let first = null;
    Object.entries(checks).forEach(([k, ok]) => {
      const f = sheet.querySelector(`[data-f="${k}"]`); f.classList.toggle("invalid", !ok);
      if (!ok && !first) first = f;
    });
    state.details = d; safeStore.set("meltado_details", d);
    if (first) { first.scrollIntoView({ behavior: "smooth", block: "center" }); return null; }
    return d;
  }

  async function refreshPosition() {
    if (state.pos && (state.pos.skipped || Date.now() - state.pos.at < 60e3)) return state.pos;
    const s = state.settings;
    const pos = await Geo.getBestPosition({ maxWaitMs: 7000 });
    const d = Geo.distanceM(s.cafe_lat, s.cafe_lng, pos.lat, pos.lng);
    if (d > s.radius_m + s.gps_slack_m) throw Object.assign(new Error("OUT_OF_RANGE"), { code: "OUT_OF_RANGE" });
    state.pos = { ...pos, distance: Math.round(d), at: Date.now() };
    return state.pos;
  }

  // ---------- confirm popup ----------
  function openConfirm(d) {
    const lines = [...state.cart.values()];
    const sheet = openModal(`
      <h2>Confirm your order</h2>
      <p class="sub">Please check everything before sending it to the counter.</p>
      <ul class="confirm-list">
        ${lines.map((l) => `<li><div><span class="q">${l.qty}×</span>${esc(l.name)}${l.options.length ? `<small>${esc(optText(l))}</small>` : ""}</div><b>${rupees(l.qty * l.unitPrice)}</b></li>`).join("")}
      </ul>
      <div class="total-row"><span>Estimated total</span><span>${rupees(cartTotal())}</span></div>
      ${state.notes ? `<p class="pay-note"><b>Note:</b> ${esc(state.notes)}</p>` : ""}
      <dl class="kv">
        <dt>Name</dt><dd>${esc(d.name)}</dd>
        <dt>Phone</dt><dd>+91 ${esc(d.phone)}</dd>
        <dt>Car</dt><dd>${[d.car_colour, d.car_model].filter(Boolean).map(esc).join(" ")}${d.car_colour || d.car_model ? " · " : ""}<b>…${esc(d.car_last4)}</b></dd>
        ${d.landmark ? `<dt>Landmark</dt><dd>${esc(d.landmark)}</dd>` : ""}
      </dl>
      <p class="pay-note">Pay by UPI to the waiter on delivery.</p>
      <div class="sheet-foot">
        <button class="btn ghost" id="backBtn">Edit</button>
        <button class="btn orange" id="sendBtn">Confirm &amp; send</button>
      </div>`, { dismissable: false, onBack: openCart });
    $("#backBtn", sheet).onclick = openCart;
    $("#sendBtn", sheet).onclick = async (e) => {
      const btn = e.currentTarget;
      if (state.settings && state.settings.require_otp && !state.otpVerifiedFor) {
        return openOtp(d);
      }
      await submitOrder(d, btn);
    };
  }

  // ---------- OTP (only when enabled in settings) ----------
  function openOtp(d) {
    const sheet = openModal(`
      <h2>Verify your phone</h2>
      <p class="sub">We'll send a 6-digit code to +91 ${esc(d.phone)}.</p>
      <button class="btn block" id="sendOtp">Send OTP</button>
      <div id="otpBox" class="hidden" style="margin-top:16px">
        <label class="field"><span>Enter code</span><input id="otp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="letter-spacing:.4em;font-size:22px;text-align:center"></label>
        <button class="btn orange block" id="verifyOtp">Verify &amp; send order</button>
      </div>
      <button class="btn link" id="otpBack" style="margin-top:8px">Back</button>`, { dismissable: false, onBack: () => openConfirm(d) });
    $("#otpBack", sheet).onclick = () => openConfirm(d);
    $("#sendOtp", sheet).onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
      try { await backend.sendOtp(d.phone); $("#otpBox", sheet).classList.remove("hidden"); b.textContent = "Resend OTP"; toast("OTP sent"); $("#otp", sheet).focus(); }
      catch (err) { toast(window.App.errorMessage(err), true); b.textContent = "Send OTP"; }
      setTimeout(() => { b.disabled = false; }, 20000);
    };
    $("#verifyOtp", sheet).onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        await backend.verifyOtp(d.phone, $("#otp", sheet).value.trim());
        state.otpVerifiedFor = d.phone;
        await submitOrder(d, b);
      } catch (err) { toast(window.App.errorMessage(err), true); b.disabled = false; }
    };
  }

  // ---------- send ----------
  async function submitOrder(d, btn) {
    state.sending = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending…';
    try {
      try { await refreshPosition(); } catch (e) {
        if (e.code === "OUT_OF_RANGE") throw e;
        // keep the earlier fix if a fresh one isn't available
      }
      const lines = [...state.cart.values()];
      const payload = {
        ...d, notes: state.notes,
        lat: state.pos.lat, lng: state.pos.lng, accuracy: state.pos.accuracy, skipped_location: !!state.pos.skipped,
        items: lines.map((l) => ({ id: l.itemId, name: l.name, qty: l.qty, unit_price: l.unitPrice, options: l.options.map((o) => (o.price ? `${o.name} (+₹${o.price})` : `${o.group}: ${o.name}`)) })),
        est_total: cartTotal(), device_id: window.App.deviceId(),
      };
      const res = await backend.placeOrder(payload);
      state.orders.unshift({
        order_id: res.order_id, order_no: res.order_no, status_token: res.status_token, at: Date.now(),
        status: "new", items: lines.map((l) => ({ name: l.name, qty: l.qty })), total: cartTotal(),
      });
      saveOrders();
      state.cart.clear(); saveCart();
      MENU.forEach((c) => c.items.forEach((i) => renderCtrl(i.id)));
      updateCartBar();
      state.sending = false;
      showSent(res.order_no);
    } catch (e) {
      state.sending = false;
      const code = window.App.errorCode(e);
      toast(window.App.errorMessage(e), true);
      btn.disabled = false; btn.innerHTML = "Confirm &amp; send";
      if (code === "OUT_OF_RANGE" || code === "CLOSED") { state.pos = null; state.settings = null; updatePill(); openCart(); }
      if (code === "ACTIVE_ORDER_EXISTS") { closeModal(); showOrders(); }
    }
  }

  function showSent(no) {
    const sheet = openModal(`
      <div class="sent">
        <div class="tick"><svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><path d="M8 17.5l6 6L26 11" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <h2>Order sent</h2>
        <p class="sub">The counter has received your order.</p>
        <div class="eyebrow">Order number</div>
        <div class="ordno">#${esc(no)}</div>
        <p class="pay-note">Stay parked where you are. A waiter will bring this order and its bill to your car. You can follow it under <b>Your orders</b>, and keep ordering if you'd like more.</p>
        <button class="btn orange block" id="okBtn">OK</button>
      </div>`, { dismissable: false, onBack: () => showOrders() });
    $("#okBtn", sheet).onclick = () => { closeModal(); showOrders(); };
  }

  // =====================================================================
  //  YOUR ORDERS — each order has its own card, status and receipt confirmation
  // =====================================================================
  const STEPS = ["new", "entered_pos", "out_for_delivery", "delivered"];
  const LABEL = {
    new: ["Order received", "The counter has your order"],
    entered_pos: ["Being prepared", "It's in the kitchen"],
    out_for_delivery: ["On the way", "A waiter is walking to your car with this order"],
    delivered: ["Received", "Thanks for confirming. Enjoy!"],
    cancelled: ["Cancelled", "The cafe cancelled this order. Please call us or wave a waiter."],
  };
  const isFinal = (st) => st === "delivered" || st === "cancelled";
  const timeText = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  // ---------- two screens: Menu | Your orders ----------
  state.view = "menu";
  const scrollPos = { menu: 0, orders: 0 };
  function setView(v) {
    if (v === state.view) return;
    scrollPos[state.view] = window.scrollY;
    state.view = v;
    $("#menu").classList.toggle("hidden", v !== "menu");
    $("#myOrders").classList.toggle("hidden", v !== "orders");
    ["tabMenu", "tabOrders"].forEach((id) => {
      const on = $("#" + id).dataset.view === v;
      $("#" + id).classList.toggle("on", on); $("#" + id).setAttribute("aria-selected", on);
    });
    if (v === "orders") $("#ordersDot").classList.add("hidden");
    updateCartBar();
    window.scrollTo(0, scrollPos[v]);
  }
  document.querySelector(".view-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view);
  });

  function renderOrders() {
    const box = $("#myOrders");
    const list = state.orders;
    const active = list.filter((o) => !isFinal(o.status)).length;
    $("#ordersCount").textContent = active;
    $("#ordersCount").classList.toggle("hidden", !active);
    if (!list.length) {
      box.innerHTML = `<div class="orders-empty"><h3>No orders yet</h3>Orders you send will show up here, each with its own status.<br><br><button class="btn" data-goto="menu">Browse the menu</button></div>`;
      return;
    }
    box.innerHTML = `
      ${cfg.CAFE_PHONE ? `<div class="mo-head"><span></span><a href="tel:${esc(cfg.CAFE_PHONE)}">Call cafe ${esc(cfg.CAFE_PHONE)}</a></div>` : ""}
      ${list.map((o) => {
        const idx = STEPS.indexOf(o.status);
        const [label, hint] = LABEL[o.status] || LABEL.new;
        const items = (o.items || []).map((i) => `${i.qty}× ${esc(i.name)}`).join(" · ");
        return `<article class="ocard s-${o.status}" data-id="${esc(o.order_id)}">
          <div class="ohead"><b>Order #${esc(o.order_no)}</b><span class="ostatus">${label}</span></div>
          ${items ? `<div class="oitems">${items}</div>` : ""}
          <div class="obar" aria-hidden="true">${STEPS.map((_, i) => `<i class="${o.status === "delivered" || i < idx ? "done" : i === idx ? "cur" : ""}"></i>`).join("")}</div>
          <div class="ohint">${hint}</div>
          ${o.status === "out_for_delivery" ? `<button class="btn orange block" data-act="received">I've received order #${esc(o.order_no)}</button>` : ""}
          <div class="ometa"><span>Placed ${timeText(o.at)}${o.total ? " · " + rupees(o.total) : ""}</span>
            ${isFinal(o.status) ? `<button data-act="hide">Hide</button>` : ""}</div>
        </article>`;
      }).join("")}
      <p class="pay-note">Each order is brought and billed separately. Pay by UPI to the waiter for each one.</p>`;
  }

  function showOrders() {
    renderOrders();
    scrollPos.orders = 0;
    setView("orders");
    window.scrollTo(0, 0);
    startPolling();
  }

  async function pollOrders() {
    const open = state.orders.filter((o) => !isFinal(o.status));
    if (!open.length) { stopPolling(); return; }
    let changed = false;
    await Promise.all(open.map(async (o) => {
      try {
        const r = await backend.getOrderStatus(o.order_id, o.status_token);
        if (r && r.status !== o.status) {
          o.status = r.status; changed = true;
          if (r.status === "out_for_delivery") {
            toast(`Order #${o.order_no} is on the way to your car`);
            if ("vibrate" in navigator) navigator.vibrate(150);
          }
        }
      } catch { /* keep last known status; retry next tick */ }
    }));
    if (changed) {
      saveOrders(); renderOrders();
      if (state.view !== "orders") $("#ordersDot").classList.remove("hidden"); // something changed on the other screen
    }
  }
  function stopPolling() { clearInterval(state.pollTimer); state.pollTimer = null; }
  function startPolling() {
    if (state.pollTimer) return;
    pollOrders();
    state.pollTimer = setInterval(pollOrders, 8000);
  }

  $("#myOrders").addEventListener("click", (e) => {
    if (e.target.closest("[data-goto=menu]")) { setView("menu"); return; }
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const o = state.orders.find((x) => x.order_id === b.closest(".ocard").dataset.id); if (!o) return;
    if (b.dataset.act === "hide") {
      state.orders = state.orders.filter((x) => x !== o); saveOrders(); renderOrders(); return;
    }
    if (b.dataset.act === "received") confirmReceived(o);
  });

  function confirmReceived(o) {
    const items = (o.items || []).map((i) => `<li><span class="q">${i.qty}×</span>${esc(i.name)}</li>`).join("");
    const sheet = openModal(`
      <h2>Got order #${esc(o.order_no)}?</h2>
      <p class="sub">Confirm only after the waiter has handed you this order. Please pay by UPI to the waiter.</p>
      ${items ? `<ul class="confirm-list">${items}</ul>` : ""}
      <div class="sheet-foot">
        <button class="btn ghost" id="rNo">Not yet</button>
        <button class="btn orange" id="rYes">Yes, received</button>
      </div>`);
    $("#rNo", sheet).onclick = closeModal;
    $("#rYes", sheet).onclick = async (e) => {
      const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spinner"></span>';
      try {
        await backend.confirmReceived(o.order_id, o.status_token);
        o.status = "delivered"; saveOrders();
        closeModal(); renderOrders(); toast(`Thanks! Order #${o.order_no} marked as received.`);
      } catch (err) {
        toast(window.App.errorMessage(err), true); b.disabled = false; b.textContent = "Yes, received";
        pollOrders();
      }
    };
  }
  backend.onCustomerUpdate(pollOrders);

  // =====================================================================
  //  INIT
  // =====================================================================
  $("#cartBtn").onclick = openCart;
  if (DEMO) $("#demoBanner").classList.remove("hidden");

  backend.getPublicSettings().then((s) => {
    state.settings = s;
    $("#closedBanner").classList.toggle("hidden", !!s.accepting_orders);
  }).catch(() => {});
  renderMenu();
  setupSearch();
  updateCartBar();
  renderOrders();
  if (state.orders.some((o) => !isFinal(o.status))) startPolling();
})();
