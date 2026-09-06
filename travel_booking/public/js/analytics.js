// travel_booking/public/js/analytics.js
//
// GA4 e-commerce per-site (Travel Website → tab Cruise/Tour Homepage →
// section "Google Analytics (GA4)"). Dulu snippet gtag.js hardcoded
// (G-NZ2WLPC597, satu ID untuk semua page) dalam base_travel.html — kini
// setiap site (cruise / tour) ada Measurement ID tersendiri yang
// dikonfigurasi di Desk dan diaktifkan di sini secara client-side.
//
// Kenapa client-side: page trip detail (/trip/<slug>), wizard /booknow dan
// /checkout TIDAK tahu site (tour/cruise) di server — maklumat itu hanya
// wujud dalam data page (#rcDetailData) atau cart (sessionStorage
// bnw_cart). Jadi base_travel.html render KEDUA-DUA konfigurasi sebagai
// JSON (#rcGaConfig) dan fail ni yang pilih site aktif:
//
//   1. <body data-rc-site="tour|cruise"> — homepage / katalog yang jelas
//      site-nya (di-set oleh base_travel.html dari active_nav)
//   2. #rcDetailData di page trip detail — medan is_cruise
//   3. sessionStorage bnw_cart (wizard) — medan is_cruise
//   4. RCGA.setSite() — page legacy /booking yang hanya tahu trip pilihan
//      customer SELEPAS page load (step Select Trip)
//   5. default "cruise" — konsisten dengan fallback nav/menu seluruh app
//
// Aktivasi LAZY: gtag.js hanya dimuat bila site pasti (dikenal semasa
// load, atau RCGA.setSite() dipanggil, atau event pertama masuk). Ini
// penting supaya page legacy /booking tidak hantar event ke property
// salah — sekali gtag('config') dijalankan untuk sesuatu ID, SEMUA event
// selepas itu pergi ke ID tersebut dan ia tidak boleh "ditukar".
//
// Helper terbuka: window.RCGA — selamat dipanggil bila-bila masa walau GA
// off (no-op senyap). Event GA4 e-commerce yang dihantar:
//   view_item_list (katalog/homepage), view_item (trip detail),
//   add_to_cart (Book Now di trip detail), begin_checkout (wizard),
//   add_payment_info (confirm), purchase (confirmation page).
//
// Fail ni dimuat oleh base_travel.html SEBELUM block footer_extra supaya
// page JS (trip_detail.js, booknow.js) dapat panggil window.RCGA.
(function () {
  "use strict";

  // ── 1. Baca konfigurasi per-site dari server ──
  var CONFIG = { cruise: null, tour: null };
  try {
    var cfgEl = document.getElementById("rcGaConfig");
    if (cfgEl) {
      var parsed = JSON.parse(cfgEl.textContent);
      if (parsed) {
        CONFIG.cruise = parsed.cruise || null;
        CONFIG.tour = parsed.tour || null;
      }
    }
  } catch (e) {
    /* JSON rosak → anggap GA off */
  }

  // ── 2. Tentukan site aktif (tour / cruise / null=belum pasti) ──
  function detectSite() {
    try {
      var hint = (document.body && document.body.getAttribute("data-rc-site")) || "";
      if (hint === "tour" || hint === "cruise") return hint;
    } catch (e) { /* no-op */ }

    // Page trip detail — is_cruise dalam #rcDetailData
    try {
      var d = document.getElementById("rcDetailData");
      if (d) {
        var data = JSON.parse(d.textContent);
        if (data && typeof data.is_cruise !== "undefined") {
          return data.is_cruise ? "cruise" : "tour";
        }
      }
    } catch (e) { /* no-op */ }

    // Wizard /booknow & /checkout — cart dihantar oleh trip_detail.js
    try {
      var raw = sessionStorage.getItem("bnw_cart");
      if (raw) {
        var cart = JSON.parse(raw);
        if (cart && typeof cart.is_cruise !== "undefined") {
          return cart.is_cruise ? "cruise" : "tour";
        }
      }
    } catch (e) { /* no-op */ }

    return null; // page legacy /booking — tunggu setSite() / event pertama
  }

  // ── 3. Aktivasi lazy — inject gtag.js sekali sahaja ──
  var SITE = null;        // site yang GA diaktifkan untuknya (selepas aktivasi)
  var ACTIVE = false;     // gtag dah dimuat & config dihantar?
  var ACTIVE_ENABLED = false; // site aktif ada GA enabled + ID sah?

  function settingsFor(site) {
    var s = (site === "tour" ? CONFIG.tour : CONFIG.cruise) || {};
    var id = (s.id || "").trim();
    // Validasi format G-XXXXXXXXXX — elak request sia-sia jika admin isi
    // GTM ID (GTM-XXXX) atau nilai separuh isi.
    var ok = !!s.enabled && /^G-[A-Z0-9]{6,}$/.test(id);
    return { id: id, ok: ok };
  }

  function activate(site) {
    if (ACTIVE) return; // tak boleh tukar property selepas config dihantar
    if (site !== "tour" && site !== "cruise") site = "cruise";
    SITE = site;
    var st = settingsFor(site);
    if (!st.ok) {
      // Site ini tak enable GA — tandai aktif supaya attempt setSite/event
      // selepas ini tak cuba muat gtag ke property salah. (Site tak boleh
      // bertukar selepas ni; ini kelemahan diterima untuk elak dual-config
      // yang lebih buruk: event bocor ke dua property serentak.)
      ACTIVE = true;
      ACTIVE_ENABLED = false;
      return;
    }
    ACTIVE = true;
    ACTIVE_ENABLED = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", st.id);
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(st.id);
    document.head.appendChild(s);
  }

  function ensureActivated() {
    if (!ACTIVE) activate(SITE_PENDING || detectSite() || "cruise");
  }

  var SITE_PENDING = null; // set oleh setSite() sebelum aktivasi

  // ── 4. Helper event — semua selamat dipanggil walau GA off ──
  function event(name, params) {
    ensureActivated();
    if (!ACTIVE_ENABLED || typeof window.gtag !== "function") return;
    try { window.gtag("event", name, params || {}); } catch (e) { /* no-op */ }
  }

  // Currency = company currency (amaun sebenar yang dicaj — bukan currency
  // paparan). Sumber sama dengan helper convertCurrency di page JS.
  function currency() {
    try {
      var el = document.getElementById("rcCurrencyData");
      if (el) {
        var d = JSON.parse(el.textContent);
        if (d && d.company_currency) return d.company_currency;
      }
    } catch (e) { /* no-op */ }
    return "MYR";
  }

  // ── 5. Dedupe purchase ikut booking_number (transaction_id) ──
  // Confirmation page BOLEH render lebih dari sekali untuk booking sama:
  //   - pulang dari Stripe → pollWizardConfirmation() re-render dengan
  //     data merge setiap poll selesai
  //   - wizard Back → re-confirm → booking BARU (nombor baharu = event
  //     baharu, betul) tapi laluan payment_setup_failed → showConfirmation
  //     juga dipanggil
  // Jadi purchase hanya dihantar SEKALI per booking_number per session.
  var DEDUPE_KEY = "rc_ga_purchase_sent";
  function purchaseAlreadySent(tid) {
    try {
      var list = JSON.parse(sessionStorage.getItem(DEDUPE_KEY) || "[]");
      return list.indexOf(tid) !== -1;
    } catch (e) {
      return false;
    }
  }
  function markPurchaseSent(tid) {
    try {
      var list = JSON.parse(sessionStorage.getItem(DEDUPE_KEY) || "[]");
      if (list.indexOf(tid) === -1) {
        list.push(tid);
        if (list.length > 50) list = list.slice(-50); // had saiz storage
        sessionStorage.setItem(DEDUPE_KEY, JSON.stringify(list));
      }
    } catch (e) { /* no-op */ }
  }

  // Item GA4 standard: {item_id, item_name, item_category, price?}
  function item(cat, id, name, price) {
    var it = {
      item_id: String(id || ""),
      item_name: String(name || ""),
      item_category: cat === "tour" ? "Tour" : "Cruise",
    };
    if (price !== null && price !== undefined && price !== "" && !isNaN(Number(price))) {
      it.price = Number(price);
    }
    return it;
  }

  window.RCGA = {
    // Sebelum aktivasi pulangkan true (benarkan cuba — event() akan buat
    // no-op senyap jika site akhirnya tak enable GA).
    enabled: function () { return ACTIVE ? ACTIVE_ENABLED : true; },
    site: function () { return SITE || SITE_PENDING || detectSite() || "cruise"; },
    measurementId: function () { return ACTIVE ? settingsFor(SITE).id : ""; },
    event: event,
    currency: currency,
    item: item,

    // setSite — untuk page yang hanya tahu site SELEPAS load (legacy
    // /booking: trip dipilih customer pada step 1). Mesti dipanggil
    // SEBELUM sebarang event; selepas aktivasi ia no-op selamat.
    setSite: function (site) {
      if (site !== "tour" && site !== "cruise") return;
      if (ACTIVE) return;
      SITE_PENDING = site;
      activate(site); // page_view (auto dgn config) keluar pada saat ni
    },

    // purchase — dedupe ikut transaction_id (booking_number).
    // Pulangkan true jika event betul-betul dihantar.
    purchase: function (payload) {
      payload = payload || {};
      var tid = String(payload.transaction_id || "");
      if (!tid || purchaseAlreadySent(tid)) return false;
      var params = {
        transaction_id: tid,
        value: Number(payload.value) || 0,
        currency: payload.currency || currency(),
        items: payload.items || [],
      };
      if (payload.payment_type) params.payment_type = payload.payment_type;
      event("purchase", params);
      markPurchaseSent(tid);
      return true;
    },
  };

  // ── 6. Auto-fire event page-load (hanya jika site diketahui) ──
  // Script ni berjalan di hujung <body> (sebelum footer_extra) — semua
  // elemen page_content (#rcDetailData / #rcItemListData) dah diparse.
  // Jika site belum pasti (legacy /booking) auto-fire dilangkau; aktivasi
  // ditangguhkan sehingga setSite()/event pertama.

  // 6.0 Aktivasi segera bila site dah pasti semasa load — supaya
  // page_view (auto oleh gtag config) sentiasa direkod walaupun page ni
  // tiada auto-event bawah (cth homepage featured kosong).
  try {
    var _bootSite = detectSite();
    if (_bootSite) activate(_bootSite);
  } catch (e) { /* no-op */ }

  // 6a. view_item — page trip detail. Harga "from" di-render server-side
  // dalam #rcItemPriceData.
  try {
    var detailEl = document.getElementById("rcDetailData");
    if (detailEl && detectSite()) {
      var dd = JSON.parse(detailEl.textContent);
      if (dd && dd.trip_master) {
        var priceEl = document.getElementById("rcItemPriceData");
        var fromPrice = null;
        if (priceEl) fromPrice = (JSON.parse(priceEl.textContent) || {}).price || null;
        event("view_item", {
          currency: currency(),
          items: [item(dd.is_cruise ? "cruise" : "tour", dd.trip_master, dd.trip_name, fromPrice)],
        });
      }
    }
  } catch (e) { /* no-op */ }

  // 6b. view_item_list — page katalog (/tours /cruises /trips) & section
  // featured homepage. Template render JSON {list_id, items:[...]}.
  try {
    var listEl = document.getElementById("rcItemListData");
    if (listEl && detectSite()) {
      var ld = JSON.parse(listEl.textContent);
      if (ld && ld.items && ld.items.length) {
        event("view_item_list", {
          item_list_id: ld.list_id || "",
          item_list_name: ld.list_name || "",
          items: ld.items,
        });
      }
    }
  } catch (e) { /* no-op */ }
})();
