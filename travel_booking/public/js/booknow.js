// travel_booking/public/js/booking.js
// Public Booking Wizard — logic penuh (dipindah keluar dari www/booking.html
// untuk organisasi kod yang lebih kemas — markup & logic diasingkan, ikut
// pattern yang sama dengan portal.js/portal_booking.js/dsb untuk
// traveller_portal.html).
//
// Data dari Frappe (trip_group_dates, trip_packages, trip_master,
// trip_group_date) dibaca dari elemen <script id="pageData"> yang kekal
// inline dalam booking.html (perlu Jinja templating server-side, tak boleh
// dipindah ke fail static).

// ─── DATA FROM FRAPPE ─────────────────────────────────────
var _dataEl = document.getElementById("pageData");
if (!_dataEl) { window.location.href = "/trips"; }
var _data;
try { _data = JSON.parse(_dataEl.textContent); } catch(e) {
  alert("Unable to load booking data. Please refresh the page.");
  window.location.href = "/trips";
}
const trip_group_dateS    = _data.trip_group_dates;
const TRIP_PACKAGES = _data.trip_packages;
// {tripName: true|false} — cruise trip papar & susun tarikh ikut SAILING date
// (sailing_start), bukan departure_date. Sumber: trip_is_cruise di booking.py.
const TRIP_CRUISE_FLAGS = _data.trip_cruise_flags || {};
const INIT_TRIP   = _data.trip_master;
const INIT_DATE   = _data.trip_group_date;
// Kosong untuk Guest (customer biasa, tak login) — cookie kosong dah
// cukup selamat untuk endpoint allow_guest (rujuk apiCall()). Terisi
// HANYA kalau session semasa authenticated (repeat customer baru login
// /traveller_portal, atau admin/staff Desk) — rujuk www/booking.py.
const CSRF_TOKEN  = _data.csrf_token || "";

// ─── SELECTED PACKAGE (resolved from cart or wizard) ──
// Dideclare AWAL supaya available ke seluruh scope — elak implicit global.
// Diisi kemudian dalam block cart-read (line ~677) atau restoreWizard().
var selectedPackage = null;

// ─── PRICE CATEGORY LABELS (dari Travel Settings) ──
// Array of {price_key, display_label, display_note} — diisi oleh loadPriceLabels().
// Fallback ke defaults kalau API gagal / tiada config dalam Travel Settings.
var PRICE_LABELS = [];

// ─── PAYMENT STATE (declare awal untuk elak hoisting undefined) ──
// Nilai default ditetapkan di sini; di-overwrite oleh loadPaymentSettings()
// atau restoreWizard() bila ada data tersimpan.
var state_payment_amount = 0;
var state_voucher_code    = "";
var state_voucher_discount = 0;
var state_affiliate_code    = "";
var state_referral_percent  = 0;
var state_payment_method = "Online Payment";
var state_receipt_data   = null;
var state_receipt_file   = null; // File object asal untuk OCR (Tesseract.js perlu Blob/File)

// ─── STATE ────────────────────────────────────────────────
const state = {
  step:         0,
  trip_master:  INIT_TRIP,
  trip_group_date:    INIT_DATE,
  trip_package: "",
  trip_name:    "",
  group_name:   "",
  // SEMUA harga disimpan & dicaj dalam COMPANY CURRENCY. package_currency
  // /package_symbol kini HANYA hint display-default (Trip Package.currency)
  // — bukan lagi currency caj sebenar. fmt() guna company currency sebagai
  // asas, papar display currency (converted) bila customer pilih yang lain.
  company_currency: _data.company_currency || "MYR",
  company_symbol:   _data.company_symbol || "MYR",
  package_currency: "MYR",
  package_symbol:   "RM",
  // Display currency terpilih (converter). Null rate -> fallback company.
  display_currency: null,
  display_symbol:   null,
  display_rate:     null,
  cabins:       [],
  rooms:        [],
  selections:   {},
  is_cruise_trip: false,
  group_seats_left: null,
  billing:      {},
  otp_verified: false,
  booking:      null,
};

// ─── PAYMENT SETTINGS (default, di-overwrite oleh API kalau ada) ──
// Didefinisi AWAL supaya semua fungsi (getMinPay, updatePaymentUI, dsb)
// boleh akses tanpa undefined error — rujuk issue #4.
var state_payment_settings = {
  bank_accounts: {
    MYR: {
      bank_name:      "Maybank",
      account_name:   "Rarecation Sdn Bhd",
      account_number: "1234 5678 9012",
    }
  },
  cashback_enabled:          true,
  cashback_percent:          5,
  default_deposit_percent:   20,
};

// Kapasiti PERINGKAT TRIP (Trip Group Date.max_participants). group_seats_left
// = baki tempat (max_participants − SUM booked_pax booking lain, dari
// www/booking.py). null/undefined → UNLIMITED (max_participants = 0) → tiada
// had di frontend. Dipakai groupCapFor() (mkStepper) supaya jumlah guest SEMUA
// room tak melebihi baki kapasiti trip — sepadan dengan gate backend
// confirm_booking() yang juga guna seats_left (bukan max_participants mentah).
function syncGroupSeatsLeft() {
  var all = (typeof trip_group_dateS !== "undefined" && trip_group_dateS)
    ? (trip_group_dateS[state.trip_master] || []) : [];
  var tgd = all.find(function(g) { return g.name === state.trip_group_date; });
  state.group_seats_left = tgd ? tgd.seats_left : null;
}

// Jumlah guest (main_guests + extra_beds + infants) SEMUA room — dipakai
// groupCapFor() untuk kira baki kapasiti trip selepas tolak guest room lain.
function totalGuestsAllRooms() {
  return state.rooms.reduce(function(a, r) {
    return a + (r.main_guests || 0) + (r.extra_beds || 0) + (r.infants || 0);
  }, 0);
}

// Papar petunjuk kapasiti trip di header section 2 (cth "3 / 10 pax").
// Disembunyikan bila unlimited (max_participants = 0).
function updateGroupCapacityHint(pax) {
  var hint = document.getElementById("bnwGroupCapacityHint");
  if (!hint) return;
  var gs = state.group_seats_left;
  if (gs == null) {
    hint.style.display = "none";
    hint.textContent = "";
    hint.classList.remove("bnw-capacity-hint.full");
    return;
  }
  hint.style.display = "";
  hint.textContent = pax + " / " + gs + " pax";
  hint.title = "Selected / available trip capacity";
  hint.classList.toggle("bnw-capacity-hint.full", pax >= gs);
}

// ─── PRICE LABELS (Travel Settings) ───────────────────────
// Load pricing category labels (Adult/Children/Infant/Main Guest/Extra Bed)
// dari Travel Settings doctype. Fallback ke hardcoded defaults kalau
// tiada config / API gagal.
function getDefaultPriceLabels() {
  // Akan dipanggil selepas state.is_cruise_trip ditetapkan — guna nilai terkini.
  if (state.is_cruise_trip) {
    return [
      { price_key: "price_adult", display_label: "Main Guest", display_note: "Main Guest must be adult at 12 years old and above." },
      { price_key: "price_upperberth", display_label: "Extra Bed", display_note: "Additional bed such as sofa bed or upper-berth." },
      { price_key: "price_infant", display_label: "Infant", display_note: "Infant is only valid for 0-23 months on embarkation date." },
    ];
  }
  return [
    { price_key: "price_adult", display_label: "Adult", display_note: "12 years old and above." },
    { price_key: "price_children", display_label: "Children", display_note: "2 to 11 years old on departure date." },
    { price_key: "price_infant", display_label: "Infant", display_note: "Valid for 0-23 months on embarkation date." },
  ];
}

function loadPriceLabels() {
  var tripType = state.is_cruise_trip ? "cruise" : "non_cruise";
  return fetch("/api/method/travel_booking.api.price_config.fetch_price_labels?trip_type=" + encodeURIComponent(tripType),
    { headers: { "X-Requested-With": "XMLHttpRequest" } })
    .then(function(r) { if (!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
    .then(function(res) {
      var labels = (res && res.message) ? res.message : res;
      if (Array.isArray(labels) && labels.length) {
        PRICE_LABELS = labels;
      } else {
        PRICE_LABELS = getDefaultPriceLabels();
      }
    })
    .catch(function() {
      PRICE_LABELS = getDefaultPriceLabels();
    });
}

// Helper: dapat label untuk price_key tertentu
function getPriceLabel(priceKey) {
  var found = PRICE_LABELS.find(function(l) { return l.price_key === priceKey; });
  return found ? found.display_label : priceKey;
}

// Helper: dapat note/tooltip untuk price_key tertentu  
function getPriceNote(priceKey) {
  var found = PRICE_LABELS.find(function(l) { return l.price_key === priceKey; });
  return found ? found.display_note : "";
}

// ─── HELPERS ──────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "";
  var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  var parts = String(iso).split("-");
  if (parts.length !== 3) return iso;
  return parseInt(parts[2],10) + " " + (months[parseInt(parts[1],10)-1] || "") + " " + parts[0];
}

function fmt(n) {
  // PENTING: kedua-dua minimumFractionDigits DAN maximumFractionDigits
  // MESTI ditetapkan kepada 2 — hanya set minimumFractionDigits SAHAJA
  // tidak mencukupi, sebab toLocaleString() defaultkan maximumFractionDigits
  // ke max(minimumFractionDigits, 3) bila tak dinyatakan, jadi angka hasil
  // pengiraan discount % (floating-point, cth 5.486) masih boleh papar 3
  // titik perpuluhan di skrin — walhal jumlah SEBENAR yang dicaj (Stripe/
  // Payment Request) sentiasa dibundarkan ke 2 titik perpuluhan (sen) di
  // backend. Percanggahan paparan vs caj sebenar ni boleh buat customer
  // fikir mereka dicaj lebih/kurang dari yang sepatutnya.
  //
  // COMPANY-CURRENCY MODEL: harga disimpan & dicaj dalam company currency.
  // `n` sentiasa company currency. Bila customer pilih display currency
  // BERBEZA (converter), papar DUA: display (converted) utama + company
  // (caj sebenar) dalam kurungan. display_rate null / display == company ->
  // company sahaja. Ini PAPARAN; Stripe/Payment Entry caj company currency.
  var num = Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var coSym = state.company_symbol || "RM";
  var dCur  = state.display_currency;
  var dSym  = state.display_symbol;
  var rate  = state.display_rate;
  if (dCur && dCur !== state.company_currency && rate) {
    var converted = Number(n) * Number(rate);
    var convStr = converted.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return dSym + " " + convStr + " (" + coSym + " " + num + ")";
  }
  return coSym + " " + num;
}

function showLoading(msg) {
  var overlay = document.getElementById("bnwLoadingOverlay");
  if (overlay) overlay.style.display = "flex";
  var msgEl = document.getElementById("bnwLoadingMsg");
  if (msgEl) msgEl.textContent = msg || "Processing...";
}

function hideLoading() {
  var overlay = document.getElementById("bnwLoadingOverlay");
  if (overlay) overlay.style.display = "none";
}

function saveState() {
  try {
    if (!state.trip_group_date || !state.trip_package || state.step < 1 || state.step >= 4) return;
    var bn = document.getElementById("bnwBillingName");
    var be = document.getElementById("bnwBillingEmail");
    var bp = document.getElementById("bnwBillingPhone");
    var billing = state.billing || null;
    if (bn || be || bp) {
      billing = {
        full_name: bn ? bn.value.trim() : (billing ? billing.full_name : ""),
        email:     be ? be.value.trim() : (billing ? billing.email : ""),
        phone:     (bp && _getBillingPhoneFull()) ? _getBillingPhoneFull() : (billing ? billing.phone : ""),
      };
    }
    var snap = {
      step:         Math.min(state.step, 3),
      trip_master:  state.trip_master,
      trip_group_date:    state.trip_group_date,
      trip_package: state.trip_package,
      trip_name:    state.trip_name,
      group_name:   state.group_name,
      package_label: state.package_label,
      package_currency: state.package_currency,
      package_symbol:   state.package_symbol,
      // Save flight info for banner restore after refresh
      flight_code:   (typeof selectedPackage !== "undefined" && selectedPackage) ? (selectedPackage.flight || "") : "",
      flight_label:  (typeof selectedPackage !== "undefined" && selectedPackage) ? (selectedPackage.flight_label || "") : "",
      rooms:        state.rooms,
      billing:      billing,
      otp_verified: state.otp_verified,
      pay_method:   (typeof state_payment_method !== "undefined") ? state_payment_method : "Online Payment",
      pay_amount:   (typeof state_payment_amount !== "undefined") ? state_payment_amount : 0,
    };
    sessionStorage.setItem("bnw_booking_wizard", JSON.stringify(snap));
  } catch (e) {}
}

function clearWizardState() {
  try { sessionStorage.removeItem("bnw_booking_wizard"); } catch (e) {}
}

function showStep(n) {
  // Guard: hide all sections first (safe - forEach skips empty NodeList)
  // CSS uses .bnw-section--active (bukan .active) untuk display:block
  document.querySelectorAll(".bnw-section").forEach(s => s.classList.remove("bnw-section--active"));

  // Show target section - guard kalau elemen tak wujud
  var targetStep = document.getElementById("bnwStep" + n);
  if (targetStep) targetStep.classList.add("bnw-section--active");

  // Update step indicators
  document.querySelectorAll(".bnw-step").forEach(el => {
    const s   = parseInt(el.dataset.step);
    const num = el.querySelector(".bnw-step__num");
    el.classList.remove("active", "done");
    if (s < n) {
      el.classList.add("done");
      if (num) num.innerHTML = '<i class="ti ti-check"></i>';
    } else {
      if (num) num.textContent = s + 1;
      if (s === n) el.classList.add("active");
    }
  });
  state.step = n;
  saveState();
  window.scrollTo(0, 0);
}

// ─── API CALL ─────────────────────────────────────────────
// useGet = true  → untuk READ data (get_booking_details, send_otp)
// useGet = false → untuk WRITE data (verify_otp, confirm_booking)
async function apiCall(method, args, useGet) {
  let url     = "/api/method/" + method;
  let options = {};

  if (useGet) {
    // GET request — read only, no CSRF needed
    const params = new URLSearchParams(args);
    url     = url + "?" + params.toString();
    options = { method: "GET", headers: { "Accept": "application/json" } };
  } else {
    // POST request — urlencoded.
    //
    // Keutamaan token: CSRF_TOKEN (dari pageData, rujuk www/booking.py)
    // dulu — ini SATU-SATUNYA sumber yang boleh dipercayai bila session
    // semasa authenticated (repeat customer baru login /traveller_portal
    // dalam tab/session sama, atau admin/staff Desk buka /booking terus).
    // Tanpa ni, request POST akan kena reject "invalid request" (403 CSRF)
    // walaupun customer/staff tu sah — sebab Frappe WAJIBKAN token padan
    // untuk authenticated session, tak macam Guest yang di-skip terus.
    //
    // Fallback ke cookie 'csrftoken' (bukan 'csrf_token') kalau CSRF_TOKEN
    // kosong — ini kes Guest biasa (customer baru, tak login terus), cookie
    // kosong pun selamat sebab endpoint wizard semua allow_guest.
    const token = CSRF_TOKEN || (function() {
      const match = document.cookie.match(/csrftoken=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : "";
    })();
    const body  = Object.keys(args).map(function(k) {
      const v = typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k];
      return encodeURIComponent(k) + "=" + encodeURIComponent(v);
    }).join("&");
    options = {
      method:  "POST",
      headers: {
        "Content-Type":        "application/x-www-form-urlencoded",
        "X-Frappe-CSRF-Token": token,
        "Accept":              "application/json",
      },
      body: body,
    };
  }

  const res = await fetch(url, options);

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    // Respons bukan JSON (cth halaman error HTML) — tetap beri mesej jelas.
    throw new Error("Server error (" + res.status + "). Please try again or contact support.");
  }

  // PENTING: ralat SEBENAR ditentukan oleh status HTTP (!res.ok) ATAU
  // kewujudan data.exc/data.exception — BUKAN kewujudan data._server_messages
  // semata-mata. _server_messages boleh mengandungi msgprint() BIASA yang
  // ERPNext sendiri hantar semasa request BERJAYA (cth "Item Price updated
  // for X in Price List Y" bila Sales Order Item disave dengan rate
  // berbeza dari Item Price sedia ada — perkara normal untuk item generik
  // macam TRAVEL-PKG yang dikongsi merentasi banyak rate berlainan).
  // Sebelum ni, kewujudan _server_messages sahaja (walaupun res.ok=true,
  // tiada exc/exception) dianggap error — punca customer nampak "Booking
  // failed" walaupun booking tu SEBENARNYA berjaya tercipta di backend
  // (data.message ada, cuma tak sempat dibaca sebab throw berlaku dulu).
  //
  // NOTE: HTTP 417 (EXPECTATION FAILED) adalah respons normal dari Frappe
  // frappe.throw() — digunakan untuk validation errors, rate limiting, dll.
  // Ini BUKAN error sebenar yang perlu log ke console — ia adalah expected
  // behavior untuk user-facing errors (cth "Too many requests", "Please wait").
  // Log hanya untuk unexpected errors (bukan 417) supaya console bersih.
  if (!res.ok || data.exc || data.exception) {
    // Log to console ONLY for non-417 errors (truly unexpected failures)
    if (res.status !== 417) {
      console.error("[API Error]", method, "HTTP", res.status, data.exc || data.exception);
    }

    let msg = "";
    if (data.exc) {
      try {
        var excList = JSON.parse(data.exc);
        var lastLine = String(excList[excList.length - 1] || "").trim().split("\n").pop();
        msg = lastLine || String(excList[excList.length - 1] || "");
      } catch (e) {
        msg = String(data.exc);
      }
    } else if (data.exception) {
      msg = String(data.exception);
    } else if (data._server_messages) {
      // res.ok = false tapi tiada exc/exception — cuba _server_messages
      // sebagai fallback terakhir untuk mesej yang lebih membantu.
      try {
        var sm = JSON.parse(data._server_messages);
        msg = sm.map(function(x) { try { return JSON.parse(x).message; } catch (e) { return x; } }).join(" ");
      } catch (e) {
        msg = String(data._server_messages);
      }
    } else {
      msg = "Server error (" + res.status + "). Please try again.";
    }
    throw new Error(msg || "An unknown error occurred.");
  }

  return data.message;
}


function restoreWizard() {
  var raw;
  try { raw = sessionStorage.getItem("bnw_booking_wizard"); } catch (e) { return false; }
  if (!raw) return false;
  var snap;
  try { snap = JSON.parse(raw); } catch (e) { return false; }
  if (!snap || !snap.trip_group_date || !snap.trip_package || snap.step === undefined) return false;

  state.trip_master  = snap.trip_master || "";
  state.trip_group_date    = snap.trip_group_date;
  state.trip_package = snap.trip_package;
  state.trip_name    = snap.trip_name || "";
  state.group_name   = snap.group_name || "";
  state.package_label = snap.package_label || "";
  state.package_currency = snap.package_currency || "MYR";
  state.package_symbol   = snap.package_symbol || "RM";

  // Re-resolve selectedPackage dari TRIP_PACKAGES (available in pageData)
  // supaya selectedPackage.flight / .flight_label tersedia untuk banner
  var _restoredPkgs = (typeof TRIP_PACKAGES !== "undefined" && TRIP_PACKAGES[state.trip_group_date])
    ? TRIP_PACKAGES[state.trip_group_date] : [];
  selectedPackage = _restoredPkgs.find(function(p) { return p.name === state.trip_package; }) || (_restoredPkgs[0] || null);

  // SYNC: Override package_type dari restored state — elak mismatch bila fresh
  // TRIP_PACKAGES data berbeza dengan apa user pilih sebelum refresh
  if (selectedPackage && state.package_label) {
    selectedPackage.package_type = state.package_label;
  }

  // Fallback: kalau TRIP_PACKAGES tak ada (sepatutnya tak jadi), guna saved flight info
  if (!selectedPackage && (snap.flight_code || snap.flight_label)) {
    selectedPackage = {
      name: state.trip_package,
      package_type: state.package_label,
      flight: snap.flight_code || "",
      flight_label: snap.flight_label || "",
    };
  }

  if (snap.billing) state.billing = snap.billing;
  state.otp_verified = !!snap.otp_verified;

  // booknow: Tiada Step 0 — terus load cabins & restore rooms
  if (typeof renderPaymentSettingsUI === "function") renderPaymentSettingsUI();

  loadCabins().then(function() {
    if (snap.rooms && snap.rooms.length) {
      var isCompatible = snap.rooms.every(function(r) {
        return typeof r.main_guests !== "undefined";
      });
      if (isCompatible) {
        state.rooms = snap.rooms;
        roomSeq = snap.rooms.reduce(function(m, r) { return Math.max(m, r.uid || 0); }, 0);
        renderRooms();
      } else {
        clearWizardState();
        initRooms();
      }
    }
    if (snap.billing) {
      var bn = document.getElementById("bnwBillingName");   if (bn) bn.value = snap.billing.full_name || "";
      var be = document.getElementById("bnwBillingEmail");  if (be) be.value = snap.billing.email || "";
      if (snap.billing.phone) {
        if (_itiBillingPhone) _itiBillingPhone.setNumber(snap.billing.phone);
        else { var bp = document.getElementById("bnwBillingPhone"); if (bp) bp.value = snap.billing.phone; }
      }
      // Restore field email yang dah verified sebelum ni sebagai LOCKED
      // juga — UX konsisten dengan apa customer nampak sebelum refresh
      // (bukan keperluan keselamatan tambahan; "input" listener sendiri
      // dah cukup untuk elak edit tanpa disedari tak kira macam mana
      // nilai field tu ditetapkan).
      if (snap.otp_verified && be) {
        lockEmailField();
        setEmailStatus("verified", '<i class="ti ti-circle-check"></i> Verified');
      }
    }
    if (snap.pay_method) state_payment_method = snap.pay_method;
    if (snap.pay_amount) state_payment_amount = snap.pay_amount;

    var target = Math.min(snap.step, 3);
    if (target >= 2) {
      if (typeof buildBookingSummary === "function") buildBookingSummary();
      if (typeof checkStep2Ready === "function") checkStep2Ready();
    }
    if (target === 3) { buildOrderSummary(); updatePaymentUI(); }
    showStep(target);
  }).catch(function() {});

  return true;
}

// ─── STATUS BADGE & CTA (kongsi antara showConfirmation & renderStripeReturnConfirmation) ──
// Sama palet warna dengan emel notifikasi (_email_shell di backend) supaya
// konsisten visual across sistem.
var STATUS_BADGE_MAP = {
  "Pending":    { bg: "#F0EDE7", fg: "#5C5850", label: "Booking Received" },
  "Accepted":   { bg: "#FEF3C7", fg: "#92400E", label: "Accepted" },
  "Processing": { bg: "#FEF3C7", fg: "#92400E", label: "Processing" },
  "Confirmed":  { bg: "#DBEAFE", fg: "#1E40AF", label: "Confirmed" },
  "Completed":  { bg: "#DCFCE7", fg: "#166534", label: "Completed" },
};

function renderConfirmStatusBadge(bookingStatus) {
  var el = document.getElementById("bnwConfirmStatusBadge");
  if (!el) return;
  var b = STATUS_BADGE_MAP[bookingStatus];
  if (!b) { el.innerHTML = ""; return; }
  el.innerHTML =
    '<span style="display:inline-block;font-size:12px;margin-bottom:20px;font-weight:700;padding:5px 16px;' +
    'border-radius:20px;background:' + b.bg + ';color:' + b.fg + ';' +
    'letter-spacing:0.03em;text-transform:uppercase">' + b.label + '</span>';
}

// Butang CTA "Complete Traveller Details" — portal kini TERBUKA untuk semua
// status (Pending/Accepted/Processing/Confirmed/Completed), tak kira
// payment_status. Customer boleh terus akses & isi traveller details
// bila-bila masa selepas booking dicipta.
//
// "View Booking" terus ke /traveller_portal (login page — password yang
// dihantar dalam emel, atau Magic Link). booking_view (akses guna PIN)
// dah dibuang — satu sahaja "tempat" untuk customer lihat booking, elak
// kelirukan customer dengan dua laluan berasingan.
function renderConfirmActions(bookingStatus, bookingNumber) {
  var el = document.getElementById("bnwConfirmActions");
  if (!el) return;

  el.innerHTML =
    '<a href="/traveller" class="bnw-btn bnw-btn-primary">View Booking <i class="ti ti-arrow-right"></i></a>' +
    '<button type="button" class="bnw-btn bnw-btn-ghost" onclick="startNewBooking()">New Booking</button>';
}

// "New Booking" — kosongkan snapshot wizard (elak restoreWizard() tarik
// balik data booking yang BARU sahaja siap) dan redirect ke homepage
// (/trips) untuk booking baharu. Full page reload (bukan reset manual)
// — cara paling selamat untuk pastikan SEMUA state kosong.
function startNewBooking() {
  clearWizardState();
  window.location.href = "/trips";
}

// ─── STRIPE REDIRECT RETURN ────────────────────────────────
// Selepas bayar di checkout.html, Stripe redirect balik ke
// /booking?ref=<booking_number>&step=confirm&pr=<payment_request>.
// Ini FULL browser navigation (bukan SPA) — sessionStorage wizard state
// mungkin masih ada, tapi restoreWizard() clamp ke max Step 3, jadi kita
// perlu handle case ni secara eksplisit SEBELUM restoreWizard() jalan.
function checkStripeReturn() {
  var params = new URLSearchParams(window.location.search);
  if (params.get("step") !== "confirm") return false;

  var bookingNumber   = params.get("ref");
  var prName          = params.get("pr");
  var paymentIntentId = params.get("payment_intent"); // Stripe auto-append selepas redirect
  if (!bookingNumber) return false;

  showLoading("Confirming your payment...");

  // FALLBACK VERIFICATION — jangan bergantung pada webhook Stripe semata-
  // mata. get_payment_result() semak status PaymentIntent TERUS dari
  // Stripe dan (kalau 'succeeded' tapi Payment Request kita masih belum
  // 'Paid') trigger set_as_paid() server-side SEGERA. Tanpa ni, webhook
  // yang lambat >18 saat buat screen confirm papar "Pending" +
  // "Amount Paid RM 0.00" walaupun bayaran sebenar dah berjaya —
  // inilah punca paparan sifar pada screen pengesahan bayaran.
  // Silent-fail (catch kosong) — polling di bawah tetap jalan walau apa
  // pun hasil verification ni.
  var verifyFirst = paymentIntentId ? verifyPaymentIntent(paymentIntentId) : Promise.resolve();
  verifyFirst.then(function() {
    pollWizardConfirmation(bookingNumber, prName, 0);
  });
  return true;
}

// Sahkan PaymentIntent guna backend (bukan percaya redirect_status URL —
// parameter tu boleh dipalsukan). Endpoint ni sama yang portal guna,
// dah ada rate limiting + ownership check server-side.
function verifyPaymentIntent(paymentIntentId) {
  return apiCall(
    "travel_booking.api.stripe_checkout.get_payment_result",
    { payment_intent: paymentIntentId },
    true // GET
  ).catch(function() { /* senyap — polling get_wizard_confirmation sambung */ });
}

// Webhook Stripe berjalan server-to-server & mungkin ambil beberapa saat
// untuk sampai + proses selepas customer redirect balik ke sini. Poll
// beberapa kali (bukan sekali) supaya kita tak papar status "Pending" yang
// sebenarnya dah "Confirmed" tapi webhook belum sempat catch up.
function pollWizardConfirmation(bookingNumber, prName, attempt) {
  var MAX_ATTEMPTS = 6;   // ~18 saat kalau semua attempt guna delay penuh
  var DELAY_MS     = 3000;

  // CUBA load snapshot dari sessionStorage dahulu — ini data yang kita simpan
  // SEBELUM redirect ke Stripe, jadi ia sentiasa ada walaupun API gagal
  var _savedSnapshot = null;
  try {
    var _rawSnap = sessionStorage.getItem("bnw_confirm_snapshot");
    if (_rawSnap) {
      _savedSnapshot = JSON.parse(_rawSnap);
      // Hanya guna snapshot kalau booking_number match (elak stale data)
      if (_savedSnapshot && _savedSnapshot.booking_number !== bookingNumber) {
        _savedSnapshot = null;
      }
    }
  } catch(_e) {}

  // Jika ada snapshot, render SEGERA — jangan tunggu API
  if (_savedSnapshot) {
    renderStripeReturnConfirmation(bookingNumber, _savedSnapshot, false); // false = still polling
  }

  apiCall(
    "travel_booking.api.booking.get_wizard_confirmation",
    { booking_number: bookingNumber, pr: prName || "" },
    true // GET
  ).then(function(result) {
    if (!result || result.exc) {
      // API gagal — tapi kalau kita dah render dari snapshot, biar je
      // Kalau takde snapshot, render dengan null (minimal info)
      if (!_savedSnapshot) {
        renderStripeReturnConfirmation(bookingNumber, null);
      }
      return;
    }

    // PENTING: "settled" kini ditentukan oleh payment_status (Pending ->
    // Partially Paid/Paid), BUKAN booking_status. Dengan flow status baharu,
    // booking_status KEKAL "Accepted" selepas bayaran penuh (sehingga admin
    // assign stateroom/flight untuk trigger "Processing", kemudian verify
    // semua traveller untuk "Confirmed") — polling terhadap booking_status
    // akan habis semua attempt (18 saat) sia-sia walaupun webhook Stripe
    // dah settle bayaran serta-merta.
    var isSettled = result.payment_status === "Paid" ||
                    result.payment_status === "Partially Paid" ||
                    result.booking_status === "Cancelled";

    if (!isSettled && attempt < MAX_ATTEMPTS) {
      setTimeout(function() {
        pollWizardConfirmation(bookingNumber, prName, attempt + 1);
      }, DELAY_MS);
      return;
    }

    // Update dengan fresh data dari backend — MERGE dengan snapshot, jangan overwrite
    // API mungkin ada data yang kosong (trip_name, dates, dsb) tapi snapshot ada
    if (_savedSnapshot) {
      // Merge: guna API data, tapi fallback ke snapshot kalau kosong
      var _merged = Object.assign({}, _savedSnapshot, result);
      // Pasti critical fields dari snapshot tak overwritten oleh empty API values
      if (!_merged.trip_name && _savedSnapshot.trip_name) _merged.trip_name = _savedSnapshot.trip_name;
      if (!_merged.group_name && _savedSnapshot.group_name) _merged.group_name = _savedSnapshot.group_name;
      if (!_merged.departure_date && _savedSnapshot.departure_date) _merged.departure_date = _savedSnapshot.departure_date;
      if (!_merged.return_date && _savedSnapshot.return_date) _merged.return_date = _savedSnapshot.return_date;
      if (!_merged.sailing_start && _savedSnapshot.sailing_start) _merged.sailing_start = _savedSnapshot.sailing_start;
      if (!_merged.sailing_end && _savedSnapshot.sailing_end) _merged.sailing_end = _savedSnapshot.sailing_end;
      if (!_merged.flight_label && _savedSnapshot.flight_label) _merged.flight_label = _savedSnapshot.flight_label;
      if (!_merged.flight && _savedSnapshot.flight) _merged.flight = _savedSnapshot.flight;
      result = _merged;
    }
    renderStripeReturnConfirmation(bookingNumber, result, isSettled);

    // Bersihkan snapshot — tak perlu lagi
    try { sessionStorage.removeItem("bnw_confirm_snapshot"); } catch(_e) {}
  }).catch(function() {
    // API error — tapi kalau dah ada snapshot, user nampak confirmation
    if (!_savedSnapshot) {
      renderStripeReturnConfirmation(bookingNumber, null);
    }
  });
}

// Papar Step 4 khusus untuk kembali dari Stripe — TIDAK guna showConfirmation()
// standard sebab ia rujuk state.billing.email / state.selections yang mungkin
// kosong selepas full-page redirect (wizard state client-side hilang konteks).
// Semua maklumat di sini datang dari backend (get_wizard_confirmation), bukan
// dari state client yang tak boleh dipercayai selepas redirect luar.
function renderStripeReturnConfirmation(bookingNumber, result, isSettled) {
  hideLoading();
  document.getElementById("bnwConfirmRef").textContent = bookingNumber;

  var bookingStatus = result ? (result.booking_status || "") : "";
  renderConfirmStatusBadge(bookingStatus);
  renderConfirmActions(bookingStatus, bookingNumber);

  // === POPULATE STEP 4 BLACK TRIP BANNER FROM BACKEND DATA ===
  // Client-side state is lost after Stripe redirect, so we must fill
  // the banner entirely from the backend API response (result object).
  if (result) {
    // Trip Name (h2 heading)
    var bannerName4El = document.getElementById("bnwBannerTripName4");
    if (bannerName4El) bannerName4El.textContent = result.trip_name || "";

    // Group Summary line: "Group: 2026-09-13 : TRIP2613 : Fly Cruise"
    var bannerSum4El = document.getElementById("bnwBannerSummary4");
    if (bannerSum4El) {
      var groupText = "Group: " + (result.group_name || "");
      // Append package type if available
      if (result.package_label && !groupText.includes(result.package_label)) {
        groupText += " : " + result.package_label;
      }
      bannerSum4El.textContent = groupText;
    }

    // Departure/Return Dates line: "Departure: 13 Sep 2026 – 22 Sep 2026 ✈️"
    // Hide for Cruise Only — cruise only packages show Sailing date only
    var dep4El = document.getElementById("bnwBannerDeparture4");
    var depEmoji = "";
    var _pkgType = result.package_label || "";
    var _isCruiseOnly = (_pkgType === "Cruise Only");
    var _isGroundOnly = (_pkgType === "Ground Only");
    var _hasFlightComponent = !_isCruiseOnly && !_isGroundOnly;
    if (_hasFlightComponent && result.flight) depEmoji = " ✈️";

    if (dep4El && result.departure_date && !_isCruiseOnly) {
      dep4El.textContent = "Departure: " + fmtDate(result.departure_date) +
        (result.return_date ? " – " + fmtDate(result.return_date) : "") + depEmoji;
      dep4El.style.display = "";
    } else if (dep4El) {
      dep4El.style.display = "none";
    }

    // Depart From / Fly From line (only for packages with flight)
    var departFrom4El = document.getElementById("bnwBannerDepartFrom4");
    if (departFrom4El) {
      if (result.flight_label && !_isCruiseOnly && !_isGroundOnly) {
        departFrom4El.textContent = "Fly from " + result.flight_label;
        departFrom4El.style.display = "";
      } else {
        departFrom4El.style.display = "none";
      }
    }

    // Sailing Dates line (cruise trips only)
    // Show kalau: (is_cruise_trip flag) ATAU (package_label mengandungi "Cruise")
    var sail4El = document.getElementById("bnwBannerSailing4");
    if (sail4El) {
      var _isCruise = result.is_cruise_trip || (result.package_label && result.package_label.toLowerCase().includes("cruise"));
      if (_isCruise && result.sailing_start) {
        var sailEmoji = " ⚓";
        sail4El.textContent = "Sailing: " + fmtDate(result.sailing_start) +
          (result.sailing_end ? " – " + fmtDate(result.sailing_end) : "") + sailEmoji;
        sail4El.style.display = "";
      } else if (sail4El) {
        sail4El.style.display = "none";
      }
    }

    // Package Type Badge (yellow badge on right side of banner)
    var badge4El = document.getElementById("bnwBannerTripType4");
    if (badge4El) badge4El.textContent = result.package_label || "";

    // Fly From text below badge
    var flyFrom4El = document.getElementById("bnwBannerFlyFrom4");
    if (flyFrom4El) {
      if (result.flight && !_isCruiseOnly && !_isGroundOnly) {
        flyFrom4El.textContent = "Fly from " + result.flight;
        flyFrom4El.style.display = "";
      } else {
        flyFrom4El.style.display = "none";
      }
    }

    // Show the banner container itself (in case it was hidden)
    var banner4El = document.getElementById("bnwTripBanner4");
    if (banner4El) banner4El.style.display = "";

    // "Amount Paid" dipapar untuk SEMUA status settled (Paid & Partially
    // Paid) — bukan Partially Paid sahaja macam sebelum ni (bila customer
    // bayar penuh, row Amount Paid hilang terus — nampak macam tiada
    // pengesahan bayaran). Bila deposit (Partially Paid), tambah row
    // "Balance Due" supaya customer nampak baki tertunggak jelas.
    var amountPaidRow = "";
    var balanceDueRow = "";
    if (result.payment_status === "Paid" || result.payment_status === "Partially Paid") {
      amountPaidRow =
        '<div class="bnw-confirm-row"><span>Amount Paid</span><strong style="color:#166534">' +
        fmt(result.advance_paid || 0) + '</strong></div>';
      if (result.payment_status === "Partially Paid") {
        var balanceDue = Math.max(0, (result.grand_total || 0) - (result.advance_paid || 0));
        balanceDueRow =
          '<div class="bnw-confirm-row"><span>Balance Due</span><strong>' +
          fmt(balanceDue) + '</strong></div>';
      }
    }
    var paymentStatusRow = "";
    if (result.payment_status && bookingStatus !== "Accepted") {
      paymentStatusRow =
        '<div class="bnw-confirm-row"><span>Payment Status</span><strong>' + result.payment_status + '</strong></div>';
    }

    document.getElementById("bnwConfirmDetails").innerHTML =
      '<div class="bnw-confirm-row"><span>Trip</span><strong>' + (result.trip_name || "") + '</strong></div>' +
      '<div class="bnw-confirm-row"><span>Departure Group</span><strong>' + (result.group_name || "") + '</strong></div>' +
      '<div class="bnw-confirm-row"><span>Total</span><strong>' + fmt(result.grand_total || 0) + '</strong></div>' +
      amountPaidRow + balanceDueRow + paymentStatusRow +
      '<div class="bnw-confirm-row"><span>Booking Ref</span><strong>' + bookingNumber + '</strong></div>';
  } else {
    // Result is null — API failed or returned error
    // Show minimal info but still display the banner & basic details
    var banner4El = document.getElementById("bnwTripBanner4");
    if (banner4El) banner4El.style.display = "";

    var bannerName4El = document.getElementById("bnwBannerTripName4");
    if (bannerName4El) bannerName4El.textContent = "Booking Confirmed";

    document.getElementById("bnwConfirmDetails").innerHTML =
      '<div class="bnw-confirm-row"><span>Booking Ref</span><strong>' + bookingNumber + '</strong></div>' +
      '<div class="bnw-confirm-row" style="color:#666;"><span>Status</span><strong>Loading details...</strong></div>';
  }

  if (isSettled === false) {
    document.getElementById("bnwConfirmEmail").innerHTML =
      'Your payment is being confirmed. This can take up to a minute — ' +
      'you will receive an email confirmation shortly. No need to pay again.';
  } else {
    // Traveller details boleh diisi bila-bila masa (kunci dah dibuang) —
    // mesej sama untuk semua status lepas payment settled (Accepted ke atas).
    document.getElementById("bnwConfirmEmail").innerHTML =
      'A confirmation email has been sent with your booking details.<br>' +
      'Complete traveller details anytime in your portal.';
  }
  showStep(4);
}

// intl-tel-input — SAMA library dengan fieldtype "Phone" di Frappe Desk,
// gantikan prefix "+60" hardcode readonly sebelum ni. initialCountry "my"
// (Malaysia) sebagai default, tapi customer BOLEH tukar ke negara lain.
// PENTING: initialize SEBELUM restoreWizard() (di bawah) supaya
// _itiBillingPhone.setNumber() tersedia semasa pulihkan snapshot wizard.
var _itiBillingPhone = null;
(function() {
  if (typeof window.intlTelInput === "undefined") {
    return;
  }
  var el = document.getElementById("bnwBillingPhone");
  if (el) {
    _itiBillingPhone = window.intlTelInput(el, {
      initialCountry: "my",
      separateDialCode: true,
    });
  }
})();

// PENTING: iti.getNumber() boleh pulangkan STRING KOSONG walaupun customer
// dah taip sesuatu (digit belum lengkap ikut format negara, atau race
// condition semasa widget baru initialize) — tanpa fallback, nombor yang
// customer TAIP SEBENAR terbuang senyap (Contact.phone_nos jadi kosong
// walaupun nampak terisi di skrin wizard). Fallback ke raw input.value()
// kalau getNumber() kosong, sama corak dengan affiliate app punya
// getPhoneValue() dan portal_traveller.js punya _getFullPhoneNumber().
function _getBillingPhoneFull() {
  var el = document.getElementById("bnwBillingPhone");
  if (!_itiBillingPhone) return (el ? el.value : "").trim();
  var full = _itiBillingPhone.getNumber().trim();
  if (full) return full;
  return (el ? el.value : "").trim();
}

// ─── DEEP LINK: ?trip=PACKAGE_ID (jump terus dari marketing site) ──
// Satu Trip Package boleh SAH untuk BANYAK Trip Group Date (hubungan
// many-to-many melalui child table 'Trip Package Group Date Select' —
// rujuk trip_package.json/select_group_by_date) — jadi bagi satu Package
// ID sahaja, kita TAK semestinya dapat SATU sailing date secara unik.
// Strategi: kumpul SEMUA Trip Group Date yang package ni sah untuknya,
// utamakan sailing AKAN DATANG (>= hari ini) yang TERAWAL — kalau semua
// dah lepas tarikh, fallback ke yang terawal keseluruhan (lebih baik
// drpd gagal terus). Customer tetap boleh tukar tarikh sendiri di UI
// lepas ni.
//
// Data (TRIP_PACKAGES, trip_group_dateS) SUDAH dimuatkan penuh di
// client-side (JSON dari server, rujuk _data di atas) — tiada perlu
// panggilan API tambahan untuk resolve ni.

var _stripeReturn = checkStripeReturn();
var _restored = _stripeReturn ? true : restoreWizard();
window.addEventListener("beforeunload", saveState);


if (!_restored) {
  // ── Simpan referrer untuk Back button ──
  // User datang dari trip detail (/trip/xxx), simpan URL supaya
  // Back button boleh kembali ke page asal, bukan tetap /trips.
  try {
    var _ref = document.referrer || "";
    // Hanya simpan kalau referrer adalah trip detail page kita sendiri
    if (_ref && _ref.indexOf("/trip/") !== -1 && _ref.indexOf(window.location.origin) === 0) {
      sessionStorage.setItem("bnw_referrer", _ref);
    }
  } catch (_e) {}

  // booknow.js: Baca dari add-to-cart (sessionStorage) — bukan URL params
  // Cart disimpan oleh trip_detail.js bila user klik [Book Now]
  var _cart = null;
  try { var _r = sessionStorage.getItem("bnw_cart"); if (_r) _cart = JSON.parse(_r); } catch(e) {}

  if (_cart && _cart.trip_master && _cart.group_date) {
    // VALIDATION: Pastikan cart group_date wujud dalam TRIP_PACKAGES
    // Kalau tak wujud → mungkin data stale dari trip lain, clear cart
    var _cartPkgs = (TRIP_PACKAGES && TRIP_PACKAGES[_cart.group_date]) || [];
    if (!_cartPkgs.length) {
      try { sessionStorage.removeItem("bnw_cart"); } catch(e) {}
      _cart = null;
    }
    state.trip_master  = _cart.trip_master;
    state.trip_group_date = _cart.group_date;
    state.trip_name     = _cart.trip_name || "";
    state.is_cruise_trip = !!_cart.is_cruise;

    // Resolve selectedPackage dari TRIP_PACKAGES (diperlukan oleh loadCabins
    // dan fungsi lain seperti banner type display)
    var _pkgs = (typeof TRIP_PACKAGES !== "undefined" && TRIP_PACKAGES[state.trip_group_date])
      ? TRIP_PACKAGES[state.trip_group_date] : [];

    // Cari dalam current group date dulu
    selectedPackage = _cart.package_name
      ? (_pkgs.find(function(p) { return p.name === _cart.package_name; }) || null)
      : (_pkgs[0] || null);

    // FALLBACK: Kalau tak jumpa dalam current group date, cari dalam SEMUA group dates
    // (handle case mana package berkaitan dengan group date lain dalam database)
    if (!selectedPackage && _cart.package_name && typeof TRIP_PACKAGES !== "undefined") {
      var _allGroupDates = Object.keys(TRIP_PACKAGES);
      for (var _gi = 0; _gi < _allGroupDates.length; _gi++) {
        var _gPkgs = TRIP_PACKAGES[_allGroupDates[_gi]] || [];
        var _found = _gPkgs.find(function(p) { return p.name === _cart.package_name; });
        if (_found) {
          selectedPackage = _found;
          break;
        }
      }
    }

    // Gunakan selectedPackage sebagai fallback kalau cart.package_name kosong
    // (trip_detail.js mungkin simpan null bila tiada package selector)
    var _resolvedPkgName = (_cart.package_name || (selectedPackage && selectedPackage.name)) || "";
    state.trip_package   = _resolvedPkgName;
    state.package_label   = _cart.package_label || (selectedPackage && selectedPackage.package_type) || "";
    state.package_currency = _cart.package_currency || "MYR";
    state.package_symbol   = _cart.company_currency || "RM";


    var _allTds = (typeof trip_group_dateS !== "undefined" && trip_group_dateS)
      ? (trip_group_dateS[state.trip_master] || []) : [];
    var _td = _allTds.find(function(g) { return g.name === state.trip_group_date; });
    if (_td) {
      state.group_name = _td.trip_group_name || (fmtDate(_td.departure_date) + ' – ' + fmtDate(_td.return_date));
    }

    if (typeof renderPaymentSettingsUI === "function") renderPaymentSettingsUI();
    // booknow starts at Step 1 (Rooms) — no Step 0 (date selection removed)
    loadCabins().then(function() { showStep(1); });
  } else {
    // Tiada cart — redirect ke trips listing
    window.location.href = "/trips";
  }
}
// ─── STEP 1: ROOMS & PAX ──────────────────────────────────
var roomSeq = 0;
// Array KONGSI untuk refreshButtons() SEMUA stepper (SEMUA room). Reset di
// renderRooms() sebelum rebuild, supaya bila mana-mana counter berubah,
// refreshAll() refresh SEMUA stepper — perlu untuk had PERINGKAT TRIP
// (groupCapFor → state.group_seats_left) yang bergantung pada jumlah guest
// SEMUA room, bukan satu room sahaja.
var allStepperRefreshers = [];

async function loadCabins() {
  showLoading("Loading room options...");
  try {
    const data = await apiCall(
      "travel_booking.api.booking.get_booking_details",
      { trip_group_date: state.trip_group_date, trip_package: state.trip_package },
      true  // GET
    );

    state.cabins = data.cabins;
    // is_cruise_trip: penentu model harga/kapasiti — cruise=slot (Main Guest/
    // Extra Bed/Infant), non-cruise=umur (Adult/Children/Infant).
    state.is_cruise_trip = !!(data.trip && data.trip.is_a_cruise_trip);
    // Sync baki kapasiti trip (seats_left) untuk limiter groupCapFor() di
    // stage 2 — null = unlimited (max_participants = 0). Dipanggil di sini
    // (loadCabins) supaya kedua-dua flow — restoreWizard — dapat
    // nilai terkini tanpa duplikasi.
    syncGroupSeatsLeft();
    state.rooms  = [];

    // Load price category labels dari Travel Settings (dynamic, bukan hardcoded)
    // Mesti selepas state.is_cruise_trip ditetapkan supaya API tahu nak
    // return labels untuk cruise atau non-cruise.
    await loadPriceLabels();

    // Update banner info - dengan null checks (elemen mungkin tak wujud semasa init)
    var bannerNameEl = document.getElementById("bnwBannerTripName");
    if (bannerNameEl && data.trip) bannerNameEl.textContent = data.trip.trip_name;

    // ── Papar maklumat dari SELECTED TRIP GROUP DATE (②) ──
    // Gunakan state.trip_group_date (dari cart) untuk lookup Trip Group Date info.
    // Ini adalah group date yang USER PILIH dari dropdown di trip.html.
    var _selectedTgd = null;
    if (trip_group_dateS && trip_group_dateS[state.trip_master]) {
      _selectedTgd = trip_group_dateS[state.trip_master].find(function(g) {
        return g.name === state.trip_group_date;
      }) || null;
    }

    // Group Name (SKU format — full name dari Trip Group Date doctype)
    var bannerGroupEl = document.getElementById("bnwBannerGroupName");
    if (bannerGroupEl) {
      var _groupName = (_selectedTgd && _selectedTgd.trip_group_name) || (data.trip_group_date && data.trip_group_date.trip_group_name) || "";
      bannerGroupEl.textContent = "Group: " + state.trip_group_date + " / " + _groupName;
    }

    // ── Fly From note (outside badge, small text) ──
    // Source: selectedPackage.flight (airport code, e.g. "SIN") dan
    // selectedPackage.flight_label (full name, e.g. "Singapore Changi Airport")
    // Data ni dah ada dalam TRIP_PACKAGES dari trip_catalog.py / pricing.js
    var _pkgType = (selectedPackage && selectedPackage.package_type) || "";
    var _isCruiseOnly = _pkgType === "Cruise Only";
    var _isGroundOnly = _pkgType === "Ground Only";
    var _hasFlightComponent = !_isCruiseOnly && !_isGroundOnly;  // Fly Cruise, etc.

    var _flightCode = (typeof selectedPackage !== "undefined" && selectedPackage && selectedPackage.flight) || "";
    var _flightLabel = (typeof selectedPackage !== "undefined" && selectedPackage && selectedPackage.flight_label) || "";

    var bannerTypeEl = document.getElementById("bnwBannerTripType");
    // Priority: selectedPackage.package_type > state.package_label (dari cart)
    var _badgeText = "";
    if (typeof selectedPackage !== "undefined" && selectedPackage && selectedPackage.package_type) {
      _badgeText = selectedPackage.package_type;
    } else if (state.package_label) {
      _badgeText = state.package_label;
    }
    if (bannerTypeEl) bannerTypeEl.textContent = _badgeText;

    // Fly From note — papar di luar/bawah badge, kecuali kalau tiada flight info
    // (Cruise Only / Ground Only — package tanpa komponen flight)
    var flyFromEl = document.getElementById("bnwBannerFlyFrom");
    if (flyFromEl) {
      if (_flightCode && _hasFlightComponent) {
        flyFromEl.textContent = "Fly from " + _flightCode;
        flyFromEl.style.display = "";
      } else {
        flyFromEl.textContent = "";
        flyFromEl.style.display = "none";
      }
    }

    // ── Date Info: Separate lines for Departure & Sailing ──
    // Semua tarikh dari SELECTED TRIP GROUP DATE (user's choice), bukan dari package
    var _depText = "", _sailText = "", _departFromText = "";

    // Departure/Return dates — papar kecuali Cruise Only (cruise only ada Sailing sahaja)
    // ✈️ emoji HANYA kalau ada flight component (Fly Cruise, Fly Package, dsb)
    // Ground Only papar tarikh, tapi tanpa emoji
    if (_selectedTgd && !_isCruiseOnly) {
      if (_selectedTgd.departure_date) {
        var _depEmoji = _hasFlightComponent ? " ✈️ " : "";
        _depText = "Departure: " + fmtDate(_selectedTgd.departure_date) +
          (_selectedTgd.return_date ? " – " + fmtDate(_selectedTgd.return_date) : "") + _depEmoji;
      }
    }

    // Departure From: Airport Name (between departure date & sailing date)
    // Papar hanya kalau ada flight component + ada airport info
    if (_hasFlightComponent && _flightLabel) {
      _departFromText = "Depart From: " + _flightLabel;
    }

    // Sailing dates untuk cruise trips
    // Dari _selectedTgd (Trip Group Date yang user pilih)
    if (state.is_cruise_trip && _selectedTgd) {
      if (_selectedTgd.sailing_start) {
        _sailText = "Sailing: " + fmtDate(_selectedTgd.sailing_start) + " – " + fmtDate(_selectedTgd.sailing_end) + " ⛵";
      }
    }

    // Helper function untuk update semua banner instances (Step 1-4)
    function _updateBannerDates(suffix) {
      var depEl = document.getElementById("bnwBannerDeparture" + (suffix || ""));
      var departFromEl = document.getElementById("bnwBannerDepartFrom" + (suffix || ""));
      var sailEl = document.getElementById("bnwBannerSailing" + (suffix || ""));
      var flyFromEl = document.getElementById("bnwBannerFlyFrom" + (suffix || ""));
      if (depEl) { depEl.textContent = _depText; depEl.style.display = _depText ? "" : "none"; }
      if (departFromEl) { departFromEl.textContent = _departFromText; departFromEl.style.display = _departFromText ? "" : "none"; }
      if (sailEl) { sailEl.textContent = _sailText; sailEl.style.display = _sailText ? "" : "none"; }
      // Fly From note — same logic for all banners
      if (flyFromEl) {
        if (_flightCode && _hasFlightComponent) {
          flyFromEl.textContent = "Fly from " + _flightCode;
          flyFromEl.style.display = "";
        } else {
          flyFromEl.textContent = "";
          flyFromEl.style.display = "none";
        }
      }
    }

    // Update semua 4 banner instances
    _updateBannerDates("");    // Step 1
    _updateBannerDates("2");   // Step 2
    _updateBannerDates("3");   // Step 3
    _updateBannerDates("4");   // Step 4


    var bannerName2El = document.getElementById("bnwBannerTripName2");
    if (bannerName2El && data.trip) bannerName2El.textContent = data.trip.trip_name;

    // Update Steps 2-4 banners (Trip Name, Group, Badge, Fly From)
    function _updateBannerCore(suffix) {
      var nameEl = document.getElementById("bnwBannerTripName" + suffix);
      var groupEl = document.getElementById("bnwBannerSummary" + suffix);
      var badgeEl = document.getElementById("bnwBannerTripType" + suffix);
      var flyFromEl = document.getElementById("bnwBannerFlyFrom" + suffix);
      if (nameEl && data.trip) nameEl.textContent = data.trip.trip_name;

      // Display trip_group_name sepenuhnya (SKU format — jangan modify)
      if (groupEl && data.trip_group_date) {
        var _groupName2 = data.trip_group_date.trip_group_name || "";
        groupEl.textContent = "Group: " + _groupName2;
      }

      if (badgeEl) badgeEl.textContent = _badgeText;

      // Fly From note for Steps 2-4
      if (flyFromEl) {
        if (_flightCode && _hasFlightComponent) {
          flyFromEl.textContent = "Fly from " + _flightCode;
          flyFromEl.style.display = "";
        } else {
          flyFromEl.textContent = "";
          flyFromEl.style.display = "none";
        }
      }
    }
    _updateBannerCore("2");  // Step 2 (Billing)
    _updateBannerCore("3");  // Step 3 (Payment)
    _updateBannerCore("4");  // Step 4 (Confirmation)

    initRooms();
  } catch(e) {
    // Hanya alert untuk API/network error, bukan DOM error
    if (e.message && !e.message.includes("null")) {
      alert("Failed to load cabin data. Please try again.\n" + e.message);
    }
  }
  hideLoading();
}

function availableCabins() {
  return state.cabins.filter(function(c) { return c.is_available; });
}

function cabinByCategory(room_category) {
  return state.cabins.find(function(x) { return x.room_category === room_category; });
}

// Cermin EXACT logic backend _price_selection() (booking.py) — model SLOT
// (posisi bilik), bukan kategori umur:
//   main_guests == 1  -> price_adult_single
//   main_guests >= 2  -> price_adult x setiap org
//   extra_beds        -> price_upperberth x setiap org
//   infants           -> price_infant x setiap org (harga SEBENAR dari
//                        pakej, bukan percuma), tak masuk capacity bilik
function priceRoomSelection(pricing, mainGuests, extraBeds, infants, isCruise) {
  var mg  = Number(mainGuests) || 0;
  var eb   = Number(extraBeds)  || 0;
  var inf  = Number(infants)    || 0;
  var total = 0;

  // isCruise tak dihantar (caller lama) -> ambil dari state.is_cruise_trip
  // (sumber: data.trip.is_a_cruise_trip dari get_booking_details).
  if (isCruise === undefined) isCruise = state.is_cruise_trip;

  if (isCruise) {
    // Cruise: model SLOT — single occupancy (price_adult_single) atau twin
    // (price_adult x mg) + upper berth (price_upperberth).
    if (mg === 1) {
      total += Number(pricing.price_adult_single || 0);
    } else if (mg >= 2) {
      total += Number(pricing.price_adult || 0) * mg;
    }
    total += Number(pricing.price_upperberth || 0) * eb;
  } else {
    // Non-cruise: model UMUR — flat per pax (tiada single supplement).
    total += Number(pricing.price_adult || 0) * mg;
    total += Number(pricing.price_children || 0) * eb;
  }
  total += Number(pricing.price_infant || 0) * inf;
  return total;
}

function initRooms() {
  state.rooms = [];
  roomSeq = 0;
  if (availableCabins().length) addRoom();
  else renderRooms();
}

// Had maksimum cabin per booking — konsisten dengan validation backend
// (confirm_booking()) dan Booking Reservation.validate_cabin_capacity()
// untuk admin manual di Desk. Perubahan nilai ni MESTI disegerakkan di
// ketiga-tiga tempat.
var MAX_CABINS_PER_BOOKING = 8;

function addRoom() {
  var avail = availableCabins();
  if (!avail.length) return;
  if (state.rooms.length >= MAX_CABINS_PER_BOOKING) {
    alert("Maximum " + MAX_CABINS_PER_BOOKING + " cabins allowed per booking. Please contact us directly for larger reservations.");
    return;
  }
  // Collapse cabin sedia ada supaya customer fokus isi cabin baharu.
  state.rooms.forEach(function(r) { r.open = false; });
  // Non-cruise: kalau hanya 1 jenis bilik (pricing) tersenarai, auto-pilih
  // terus — customer tak perlu buka dropdown "Select rooming type".
  var _autoCat = (!state.is_cruise_trip && avail.length === 1) ? avail[0].room_category : "";
  state.rooms.push({
    uid:          ++roomSeq,
    room_category: _autoCat,
    main_guests:  0,
    extra_beds:   0,
    infants:      0,
    open:         true,
  });
  renderRooms();
}

function removeRoom(uid) {
  state.rooms = state.rooms.filter(function(r) { return r.uid !== uid; });
  renderRooms();
}

function renderRooms() {
  var list  = document.getElementById("bnwRoomList");
  list.innerHTML = "";
  var avail = availableCabins();

  // Reset array stepper kongsi — stepper dibina semula oleh forEach di bawah
  // dan akan mendaftar refreshButtons() masing-masing semula (rujuk mkStepper).
  allStepperRefreshers.length = 0;

  state.rooms.forEach(function(room, idx) {
    var card = document.createElement("div");
    card.className = "bnw-cabin-card";
    var isOpen = room.open !== false; // default terbuka kalau belum ditetapkan

    // Head: chevron + title (+ ringkasan bila collapsed) + remove.
    // Klik mana-mana bahagian head (kecuali butang Remove) toggle collapse.
    var head = document.createElement("div");
    head.className = "bnw-cabin-header";
    head.addEventListener("click", function(e) {
      if (e.target.closest(".bnw-cabin-remove")) return;
      room.open = !isOpen;
      renderRooms();
    });

    var headLeft = document.createElement("div");
    headLeft.className = "bnw-header-left";

    var chev = document.createElement("i");
    chev.className = "ti ti-chevron-down rc-room__chev" + (isOpen ? " rc-room__chev--open" : "");
    headLeft.appendChild(chev);

    var title = document.createElement("span");
    title.className = "bnw-cabin-type";
    title.textContent = (state.is_cruise_trip ? "Cabin " : "Room ") + (idx + 1);
    headLeft.appendChild(title);

    var c = cabinByCategory(room.room_category);
    if (!isOpen) {
      var pax      = room.main_guests + room.extra_beds + room.infants;
      var subtotal = c ? priceRoomSelection(c.pricing, room.main_guests, room.extra_beds, room.infants) : 0;
      var summary  = document.createElement("span");
      summary.className = "bnw-cabin-summary";
      // summary.textContent = "\u00b7 " + (room.room_category || "No cabin selected") + " \u00b7 " + pax + " pax \u00b7 " + fmt(subtotal);
      summary.textContent = "\u00b7 " + (room.room_category || "No cabin selected") + " \u00b7 " + pax + " pax";
      headLeft.appendChild(summary);
    }
    head.appendChild(headLeft);

    var rm = document.createElement("button");
    rm.className = "bnw-cabin-remove";
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", function(e) { e.stopPropagation(); removeRoom(room.uid); });
    head.appendChild(rm);

    card.appendChild(head);

    if (isOpen) {

      // Room Type dropdown
      var typeField = document.createElement("div");
      typeField.className = "bnw-field";
      
      var typeLbl = document.createElement("label");
      typeLbl.className = "bnw-label";
      typeLbl.textContent = state.is_cruise_trip ? "Select Cabin Type" : "Select Rooming Type";
      
      var selWrap = document.createElement("div");
      selWrap.className = "bnw-select-wrap";
      
      var sel = document.createElement("select");
      sel.className = "bnw-select";
      
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = state.is_cruise_trip ? " Select cabin type " : " Select rooming type ";
      
      if (!room.room_category) ph.selected = true;
      
      sel.appendChild(ph);
      
      avail.forEach(function(cab) {
        var opt = document.createElement("option");
        opt.value = cab.room_category;
        var rangeLabel = (cab.capacity === cab.max_capacity)
          ? cab.capacity + " Pax"
          : cab.capacity + "-" + cab.max_capacity + " Pax";
        opt.textContent = cab.room_category;
        if( cab.max_capacity > 0 )
        opt.textContent += " (" + rangeLabel + ")";
        if (cab.room_category === room.room_category) opt.selected = true;
        sel.appendChild(opt);
      });
      
      sel.addEventListener("change", function() {
        room.room_category = this.value;
        room.main_guests = 0;
        room.extra_beds  = 0;
        room.infants     = 0;
        renderRooms();
      });
      
      var typeChev = document.createElement("i");
      typeChev.className = "ti ti-chevron-down bnw-select-icon";
      selWrap.appendChild(sel);
      selWrap.appendChild(typeChev);
      typeField.appendChild(typeLbl);
      typeField.appendChild(selWrap);

      // Cabin Type Info — gambar (room_profile) + description dari Trip
      // Price Category, papar terus lepas customer pilih cabin type,
      // SEBELUM senarai counter pax. Refresh automatik bila room_category
      // ditukar (renderRooms() dipanggil semula pada 'change' listener
      // dropdown di atas), tiada API call tambahan diperlukan.
      var cabinInfo = null;
      if (c && (c.description || c.room_image)) {
        cabinInfo = document.createElement("div");
        cabinInfo.className = "bnw-cabin-info";
        
        if (c.room_image) {
          var cabinImg = document.createElement("img");
          cabinImg.className = "bnw-cabin-img";
          cabinImg.src = c.room_image;
          cabinImg.alt = c.room_name || "Cabin";
          cabinImg.loading = "lazy";
          cabinInfo.appendChild(cabinImg);
        }

        // ── Header Row: Title + More Info Button ──
        var headerRow = document.createElement("div");
        headerRow.className = "bnw-cabin-header-row cabin-title";

        cabinInfo.appendChild(headerRow);

        // Cabin Name heading (dari price category)
        var cabinTitle = document.createElement("h4");
        cabinTitle.className = "bnw-cabin-title";
        cabinTitle.textContent = c.room_name || c.room_category || "Cabin";
        headerRow.appendChild(cabinTitle);

        // More Info URL button (float-right, new tab) - hanya jika ada data
        if (c.read_more_url) {
          var infoBtn = document.createElement("a");
          infoBtn.className = "bnw-cabin-info-btn";
          infoBtn.href = c.read_more_url;
          infoBtn.target = "_blank";
          infoBtn.rel = "noopener noreferrer";
          infoBtn.innerHTML = '<i class="ti ti-external-link"></i> More Info';
          headerRow.appendChild(infoBtn);
        }

        if (c.description != null) {
          // PENTING: 'description' ialah Text Editor (rich text HTML),
          // BUKAN plain text — kena innerHTML supaya formatting admin
          // (bold/senarai/perenggan) dipapar betul, bukan tag mentah.
          // Content ditulis admin sendiri di Desk (bukan input customer),
          // sama risiko macam content CMS lain — tak perlu sanitize
          // tambahan.
          var descText = document.createElement("div");
          descText.className = "bnw-cabin-desc bnw-cabin-desc.clamped";
          descText.innerHTML = c.description;
          // cabinInfo.appendChild(descText);

          // "Read more" / "Read less" — cuma dipapar kalau teks BENAR-
          // BENAR terpotong (scrollHeight > clientHeight lepas clamp 2
          // baris). requestAnimationFrame supaya browser sempat render
          // dulu sebelum measurement diambil (elak baca 0/salah semasa
          // elemen baru di-attach).
          var readMoreBtn = document.createElement("span");
          readMoreBtn.className = "bnw-read-more";
          readMoreBtn.textContent = "Read more";
          readMoreBtn.style.display = "none";
          var descExpanded = false;
          readMoreBtn.addEventListener("click", function() {
            descExpanded = !descExpanded;
            descText.classList.toggle("bnw-cabin-desc.clamped", !descExpanded);
            readMoreBtn.textContent = descExpanded ? "Read less" : "Read more";
          });
          cabinInfo.appendChild(readMoreBtn);

          requestAnimationFrame(function() {
            if (descText.scrollHeight > descText.clientHeight + 1) {
              readMoreBtn.style.display = "inline-block";
            }
          });
        }
      }

      // Vertical counter list: Main Guest / Extra Bed / Infant. Had setiap
      // counter dikira SEMULA secara dinamik dalam mkStepper()'s capFor()
      // (Extra Bed & Infant kini berkongsi baki capacity yang sama), jadi
      // parameter 'max' di sini cuma placeholder — nilai sebenar diambil
      // terus dari cabinByCategory() semasa setiap render.
      var capacity = c ? (c.capacity || 0) : 0;
      var pricing  = c ? c.pricing : {};

      var counters = document.createElement("div");
      counters.className = "bnw-steppers";

      // Extra Bed & Infant berkongsi kapasiti (capFor() masing-masing
      // bergantung pada nilai counter SATU LAGI — rujuk capFor() dalam
      // mkStepper()) — array ni kumpul refreshButtons() SETIAP stepper
      // untuk room ni, supaya bila SALAH SATU counter berubah, kita boleh
      // refresh SEMUA stepper (bukan cuma yang diklik). Sebelum ni, setiap
      // stepper cuma refresh dirinya sendiri — punca bug: butang "+" Extra
      // Bed kekal disabled selepas Infant dikurangkan (walhal kapasiti dah
      // terbuka semula), sebab tiada apa trigger refresh Extra Bed punya
      // capFor() semula bila Infant yang berubah.
      var stepperRefreshers = allStepperRefreshers;  // kongsi array global (semua room)


      if (state.is_cruise_trip) {
        counters.appendChild(mkStepper(room, "main_guests", getPriceLabel("price_adult"), capacity, function() {
          if(!pricing.price_adult ){ pricing.price_adult = 0; }
          return room.main_guests === 1
            ? fmt(pricing.price_adult_single) + " /pax"
            : fmt(pricing.price_adult) + " /pax";
        }, stepperRefreshers, getPriceNote("price_adult")));

        counters.appendChild(mkStepper(room, "extra_beds", getPriceLabel("price_upperberth"), 0, function() {
          if(!pricing.price_upperberth ){ pricing.price_upperberth = 0; }
          return fmt(pricing.price_upperberth) + " /pax";
        }, stepperRefreshers, getPriceNote("price_upperberth")));
      } else {
        // Non-cruise (model UMUR): Adult (price_adult) + Children (price_children).
        counters.appendChild(mkStepper(room, "main_guests", getPriceLabel("price_adult"), capacity, function() {
          if(!pricing.price_adult ){ pricing.price_adult = 0; }
          return fmt(pricing.price_adult) + " /pax";
        }, stepperRefreshers, getPriceNote("price_adult")));

        counters.appendChild(mkStepper(room, "extra_beds", getPriceLabel("price_children"), 0, function() {
          if(!pricing.price_children ){ pricing.price_children = 0; }
          return fmt(pricing.price_children) + " /pax";
        }, stepperRefreshers, getPriceNote("price_children")));
      }

      counters.appendChild(mkStepper(room, "infants", getPriceLabel("price_infant"), 0, function() {
        if(!pricing.price_infant ){ pricing.price_infant = 0; }
        return fmt(pricing.price_infant) + " /pax";
      }, stepperRefreshers, getPriceNote("price_infant")));

      card.appendChild(typeField);
      if (cabinInfo) card.appendChild(cabinInfo);
      card.appendChild(counters);
    }

    list.appendChild(card);
  });

  // Disable "Add another room" secara VISUAL bila dah cecah had maksimum
  // — elak customer klik berulang tanpa tahu kenapa tak jadi apa-apa
  // (sebelum ni cuma block senyap dalam addRoom(), tiada isyarat visual).
  var addRoomBtnEl = document.getElementById("bnwAddRoomBtn");
  if (addRoomBtnEl) {
    var atMax = state.rooms.length >= MAX_CABINS_PER_BOOKING;
    addRoomBtnEl.disabled = atMax;
    addRoomBtnEl.title    = atMax
      ? "Maximum " + MAX_CABINS_PER_BOOKING + " cabins per booking"
      : "";
  }

  updateTotals();
}

function mkStepper(room, key, label, max, rateFn, refreshers, noteText) {
  // ------------------------------------------
  var row = document.createElement("div");
  row.className = "bnw-stepper";
  // ------------------------------------------

  // ── Declare button elements AWAL (sebelum refreshButtons) ──
  var minus = document.createElement("button");
  minus.className = "bnw-stepper-btn";
  minus.type = "button";
  minus.textContent = "\u2212";

  var val = document.createElement("span");
  val.className = "bnw-stepper-val";
  val.textContent = room[key];

  var plus = document.createElement("button");
  plus.className = "bnw-stepper-btn";
  plus.type = "button";
  plus.textContent = "+";

  // ── ROW: Info (label+price) + Controls ──
  var stepperRow = document.createElement("div");
  stepperRow.className = "bnw-stepper-row";

  // Col 1: Label + Price (flexible width)
  var infoCol = document.createElement("div");
  infoCol.className = "bnw-stepper-info";

  var lbl = document.createElement("div");
  lbl.className = "bnw-stepper-label";

  var lblText = document.createElement("span");
  lblText.className = "bnw-stepper-label-text";
  lblText.textContent = label;
  lbl.appendChild(lblText);

  infoCol.appendChild(lbl);

  var rate = document.createElement("div");
  rate.className = "bnw-stepper-rate";
  // ------------------------------------------
  function capFor() {

    var c = cabinByCategory(room.room_category);
    var capacity    = c ? (c.capacity || 0) : 0;
    // max_capacity === 0 (eksplisit) -> UNLIMITED: overbooking cabin
    // dibenarkan (pilihan user "per-cabin"). Server (get_booking_details)
    // kekal hantar 0 untuk unlimited, fallback `capacity` bila NULL —
    // jadi bezakan 0 di sini SEBELUM `|| capacity` (0 falsy akan ter-skip).
    var unlimited   = !!(c && c.max_capacity === 0);
    var maxCapacity = unlimited ? Infinity : (c ? (c.max_capacity || capacity) : 0);
    // capacity sendiri 0 (cth cabin tanpa had fizikal) -> main guest tak
    // limited secara struktur; treat sebagai Infinity juga (defensive,
    // padan dengan _validate_selection_capacity server).
    var mainCap     = capacity > 0 ? capacity : Infinity;

    // Non-cruise (model UMUR): adult+children+infant berkongsi max_capacity;
    // children dibenarkan bila-bila (tiada syarat "adult penuh") selagi ada
    // >=1 adult. capacity (min) tak dipakai — had utama ialah max_capacity.
    if (!state.is_cruise_trip) {
      if (key === "main_guests") {
        return unlimited ? Infinity : Math.max(0, maxCapacity - room.extra_beds - room.infants);
      }
      if (key === "extra_beds") {
        if (room.main_guests < 1) return 0;
        return unlimited ? Infinity : Math.max(0, maxCapacity - room.main_guests - room.infants);
      }
      if (key === "infants") {
        if (room.main_guests < 1) return 0;
        return unlimited ? Infinity : Math.max(0, maxCapacity - room.main_guests - room.extra_beds);
      }
      return 0;
    }

    if (key === "main_guests") {
      // PENTING: bukan cuma capped oleh 'capacity' sendiri — Main Guest
      // JUGA kena disable "+" kalau menambahnya akan exceed max_capacity
      // KESELURUHAN cabin, memandangkan Extra Bed/Infant boleh dah guna
      // sebahagian ruang WALAUPUN Main Guest belum sampai capacity lagi
      // (cth Infant enable bila Main Guest >= 1, bukan perlu === capacity).
      // Sebelum ni, capFor() Main Guest cuma pulangkan 'capacity' tetap,
      // tak pernah ambil kira Extra Bed/Infant sedia ada — punca bug:
      // Main Guest=1, Infant=3 (dah guna 4/4 ruang), tapi butang "+"
      // Main Guest MASIH enabled, boleh diklik jadi Main Guest=2 (jumlah
      // jadi 5, overbook kapasiti fizikal cabin). Sekarang: begitu total
      // pax dah sampai max_capacity, "+" terus disabled — customer KENA
      // kurangkan Extra Bed/Infant dulu secara eksplisit sebelum boleh
      // tambah Main Guest semula (bukan auto-clamp/kurangkan senyap).
      // Bila unlimited (max_capacity=0): maxCapacity=Infinity -> pulangkan
      // mainCap (capacity struktur) sahaja.
      return Math.min(mainCap, maxCapacity - room.extra_beds - room.infants);
    }

    if (key === "extra_beds") {
      // Extra Bed: perlu Main Guest sudah penuh (= capacity) bila capacity
      // terhad. capacity 0 (unlimited struktur) -> skip syarat ni, cuma
      // perlu main_guests >= 1. Infant turut dikira dalam capacity bilik
      // — Extra Bed & Infant berkongsi baki ruang (max_capacity -
      // main_guests - infants). unlimited -> Infinity.
      if (capacity > 0 && room.main_guests !== capacity) return 0;
      if (capacity === 0 && room.main_guests < 1) return 0;
      return Math.max(0, maxCapacity - room.main_guests - room.infants);
    }

    if (key === "infants") {
      // Infant: enable bila Main Guest sekurang-kurangnya 1 (bukan 2 lagi).
      // Infant dikira dalam capacity bilik — berkongsi baki ruang dengan
      // Extra Bed (max_capacity - main_guests - extra_beds). unlimited
      // -> Infinity.
      if (room.main_guests < 1) return 0;
      return Math.max(0, maxCapacity - room.main_guests - room.extra_beds);
    }

    return 0;
  }

  // Had PERINGKAT TRIP: jumlah guest SEMUA room tak boleh melebihi baki
  // kapasiti trip-group-date (state.group_seats_left). null → unlimited.
  // Diaplikasikan DI SINI (bukan dalam capFor) supaya logik per-cabin
  // capFor() yang telah disahkan tak diusik — groupCapFor() bungkus capFor()
  // dan constrain dengan baki kapasiti trip (seats_left − guest room lain).
  function groupCapFor() {
    var cap = capFor();
    var gs = state.group_seats_left;
    if (gs == null) return cap;
    var others = totalGuestsAllRooms() - room[key];
    return Math.min(cap, Math.max(0, gs - others));
  }

  function max_capacity_for_mg() {
    var c = cabinByCategory(room.room_category);
    return c ? (c.capacity || 0) : 0;
  }

  function refreshRate() {
    rate.textContent = rateFn ? rateFn() : "";
  }

  function refreshButtons() {
    minus.disabled = room[key] <= 0;
    plus.disabled  = room[key] >= groupCapFor();
    refreshRate();
  }
  refreshButtons();

  // Daftar refreshButtons() stepper ni ke senarai KONGSI (refreshers, sama
  // array dipassing untuk ketiga-tiga stepper Main Guest/Extra Bed/Infant
  // dalam SATU room — rujuk renderRooms()). refreshAll() di bawah guna
  // senarai ni untuk refresh SEMUA stepper (bukan cuma diri sendiri) bila
  // mana-mana satu counter berubah — supaya Extra Bed & Infant, yang
  // capFor() masing-masing bergantung pada nilai SATU LAGI, sentiasa
  // sepadan dengan kapasiti TERKINI tanpa perlu rebuild seluruh DOM
  // (renderRooms()) — flicker-free, sepadan Opsyen 2.
  if (refreshers) refreshers.push(refreshButtons);

  function refreshAll() {
    if (refreshers && refreshers.length) {
      refreshers.forEach(function(fn) { fn(); });
    } else {
      refreshButtons();
    }
  }

  // minus button action
  minus.addEventListener("click", function() {

    room[key] = Math.max(0, room[key] - 1);
    
    if (key === "main_guests") {
      
      // Cascade: turunkan Extra Bed / Infant kalau melanggar rule
      var cap = max_capacity_for_mg();
      if (room.main_guests !== cap) room.extra_beds = 0;
      if (room.main_guests < 1) room.infants = 0;
      
      renderRooms();
      return;
    }

    val.textContent = room[key];
    refreshAll();
    updateTotals();
  });

  // plus button action
  plus.addEventListener("click", function() {

    room[key] = Math.min(groupCapFor(), room[key] + 1);

    if (key === "main_guests") {
      renderRooms();
      return;
    }

    val.textContent = room[key];
    refreshAll();
    updateTotals();
  });

  // Add rate to info column
  infoCol.appendChild(rate);

  // Col 2: Stepper controls (fixed width)
  var stepper = document.createElement("div");
  stepper.className = "bnw-stepper-controls";

  stepper.appendChild(minus);
  stepper.appendChild(val);
  stepper.appendChild(plus);

  // Assemble row: Info | Controls
  stepperRow.appendChild(infoCol);
  stepperRow.appendChild(stepper);
  row.appendChild(stepperRow);

  // Note text (full width below) - if provided
  if (noteText) {
    var noteDiv = document.createElement("div");
    noteDiv.className = "bnw-stepper-note";
    noteDiv.innerHTML = noteText;  // HTML from Travel Settings
    row.appendChild(noteDiv);
  }

  return row;
}

// NOTA: state.selections (agregat ikut kategori, across semua cabin) HANYA
// dipakai untuk VALIDATION (contoh: adakah ada sebarang pax dipilih sebelum
// boleh Next). Kiraan harga sebenar guna priceRoomSelection() per-cabin dari
// state.rooms — model SLOT, sepadan dengan backend.
function aggregateSelections() {
  state.selections = {};
  state.rooms.forEach(function(r) {
    var c = cabinByCategory(r.room_category);
    if (!c) return;
    if (!state.selections[r.room_category]) {
      state.selections[r.room_category] = {
        room_category:  c.room_category,
        room_name:      c.room_category,
        main_guests:    0,
        extra_beds:     0,
        infants:        0,
        capacity:       c.capacity,
        cabins_needed:  0,
      };
    }
    var sel = state.selections[r.room_category];
    sel.main_guests += r.main_guests;
    sel.extra_beds  += r.extra_beds;
    sel.infants     += r.infants;
    if (r.main_guests > 0) sel.cabins_needed++;
  });
}

function updateTotals() {
  aggregateSelections();
  var pax = 0, amt = 0;
  state.rooms.forEach(function(r) {
    var c = cabinByCategory(r.room_category);
    if (!c) return;
    pax += r.main_guests + r.extra_beds + r.infants;
    amt += priceRoomSelection(c.pricing, r.main_guests, r.extra_beds, r.infants);
  });
  // Guard: Step 1 elements (Rooms section)
  var grandEl = document.getElementById("bnwTotalsGrand");
  if (grandEl) grandEl.textContent = fmt(amt);

  var depEl = document.getElementById("bnwTotalsDeposit");
  if (depEl) depEl.textContent = fmt(Math.round(amt * (state_payment_settings.default_deposit_percent / 100) * 100) / 100);

  var nextBtn = document.getElementById("bnwStep1Next");
  if (nextBtn) nextBtn.disabled = pax === 0;

  updateGroupCapacityHint(pax);
  buildStep1Summary();
}

// Kad "Payment Summary" di Step 1 (Rooms & Passengers) — live-sync setiap
// kali kaunter Main Guest/Extra Bed/Infant berubah. Format sama dengan
// buildOrderSummary() (Step 4), guna Cabin Fare + senarai Guest N: [label].
// NOTA: Total keseluruhan TIDAK dipaparkan di sini lagi — cuma SATU Total
// (di bawah grid, dalam #totalsBox) untuk elak nilai berulang.
function buildStep1Summary() {
  var lines    = document.getElementById("bnwStep1OrderLines");
  var guestsEl = document.getElementById("bnwStep1TotalGuests");
  if (!lines) return;
  lines.innerHTML = "";

  var activeRooms = state.rooms.filter(function(r) {
    return r.room_category && (r.main_guests + r.extra_beds + r.infants) > 0;
  });

  activeRooms.forEach(function(r, idx) {
    var c = cabinByCategory(r.room_category);
    if (!c) return;
    var p = c.pricing;
    var cabinFare = 0;
    var guestLines = [];
    var guestNo = 1;

    if (state.is_cruise_trip) {
      if (r.main_guests === 1) {
        var singleRate = Number(p.price_adult_single || 0);
        cabinFare += singleRate;
        guestLines.push(["Guest " + guestNo + ": Main Guest", singleRate]);
        guestNo++;
      } else if (r.main_guests >= 2) {
        var twinRate = Number(p.price_adult || 0);
        for (var i = 0; i < r.main_guests; i++) {
          cabinFare += twinRate;
          guestLines.push(["Guest " + guestNo + ": Main Guest", twinRate]);
          guestNo++;
        }
      }
      var upperRate = Number(p.price_upperberth || 0);
      for (var j = 0; j < r.extra_beds; j++) {
        cabinFare += upperRate;
        guestLines.push(["Guest " + guestNo + ": Extra Bed", upperRate]);
        guestNo++;
      }
    } else {
      // Non-cruise: Adult (price_adult) + Children (price_children), flat per pax.
      var adultRate = Number(p.price_adult || 0);
      for (var i = 0; i < r.main_guests; i++) {
        cabinFare += adultRate;
        guestLines.push(["Guest " + guestNo + ": Adult", adultRate]);
        guestNo++;
      }
      var childRate = Number(p.price_children || 0);
      for (var j = 0; j < r.extra_beds; j++) {
        cabinFare += childRate;
        guestLines.push(["Guest " + guestNo + ": Children", childRate]);
        guestNo++;
      }
    }
    var infantRate = Number(p.price_infant || 0);
    for (var k = 0; k < r.infants; k++) {
      cabinFare += infantRate;
      guestLines.push(["Guest " + guestNo + ": Infant", infantRate]);
      guestNo++;
    }

    lines.innerHTML +=
      '<div class="bnw-order-cabin">' +
        '<div class="bnw-order-cabin-title">' + c.room_category + ' (' + (idx + 1) + ')</div>' +
        '<div class="bnw-order-line bnw-order-line-fare"><span>Cabin Fare:</span><span>' + fmt(cabinFare) + '</span></div>' +
        guestLines.map(function(g) {
          return '<div class="bnw-order-line bnw-order-line-guest"><span>' + g[0] + '</span><span>' + fmt(g[1]) + '</span></div>';
        }).join("") +
      '</div>';
  });

  var totalPax = activeRooms.reduce(function(a, r) { return a + r.main_guests + r.extra_beds + r.infants; }, 0);
  if (guestsEl) guestsEl.textContent = totalPax;

  if (!activeRooms.length) {
    lines.innerHTML = '<div class="bnw-order-line bnw-order-line-muted"><span>Add a main guest to begin</span></div>';
  }
}

// Event listeners untuk Step 1 (Rooms) - dengan null checks
var addRoomBtnEl = document.getElementById("bnwAddRoomBtn");
if (addRoomBtnEl) addRoomBtnEl.addEventListener("click", addRoom);

var step1BackEl = document.getElementById("bnwStep1Back");
// Back button: kembali ke page asal (trip detail) kalau ada, fallback /trips
if (step1BackEl) step1BackEl.addEventListener("click", function() {
  try {
    sessionStorage.removeItem("bnw_cart");           // Clear trip selection cart
    sessionStorage.removeItem("bnw_booking_wizard"); // Clear wizard state
  } catch(e) {}

  // Cuba guna referrer yang disimpan (trip detail page asal)
  var _backUrl = "/trips"; // default fallback
  try {
    var _savedRef = sessionStorage.getItem("bnw_referrer");
    if (_savedRef && _savedRef.indexOf("/trip/") !== -1) {
      _backUrl = _savedRef;
      sessionStorage.removeItem("bnw_referrer"); // buang selepas diguna
    }
  } catch (_e) {}
  window.location.href = _backUrl;
});

var step1NextEl = document.getElementById("bnwStep1Next");
if (step1NextEl) step1NextEl.addEventListener("click", function() {
  aggregateSelections();
  var active = Object.values(state.selections).filter(function(s) { return s.main_guests + s.extra_beds + s.infants > 0; });
  if (!active.length) return;
  
  // Build booking summary untuk Section 2 sebelum show
  if (typeof buildBookingSummary === "function") buildBookingSummary();
  
  showStep(2);
});

		// ─── STEP 2: BILLING + OTP ────────────────────────────────
	var step2BackEl = document.getElementById("bnwStep2Back") || document.getElementById("step2Back");
	if (step2BackEl) step2BackEl.addEventListener("click", function() { showStep(1); });

	var emailInput   = document.getElementById("bnwBillingEmail") || document.getElementById("billingEmail");
	var emailStatus  = document.getElementById("bnwEmailStatus") || document.getElementById("emailStatus");
	var otpInline    = document.getElementById("bnwOtpInline") || document.getElementById("otpInline");
	var otpInput     = document.getElementById("bnwOtpInput") || document.getElementById("otpInput");
	var step2NextBtn = document.getElementById("bnwStep2Next") || document.getElementById("step2Next");

	// ─── TRIP DETAILS BUTTON (Step 2 + Step 3) ─────────────────
	// "Back to Product Info" — navigate ke trip detail page tanpa hilang wizard state.
	// User boleh resume booking bila balik (state disimpan dalam localStorage).
	function initProductInfoButtons() {
	  var tripInfoBtns = [
		document.getElementById("step2ProductInfo"),
		document.getElementById("step3ProductInfo")
	  ];

	  tripInfoBtns.forEach(function(btn) {
		if (!btn) return;

		// Set href ke trip detail page berdasarkan trip_master semasa
		btn.addEventListener("click", function(e) {
		  e.preventDefault();

		  // Simpan wizard state SEBELUM pergi ke product page
		  saveState();

		  // Bina URL ke trip detail page (/trips/<trip_name>)
		  var tripName = state.trip_master || "";
		  if (tripName) {
			// Tambah query param supaya tahu user datang dari wizard
			var productUrl = "/trips/" + encodeURIComponent(tripName);
			window.location.href = productUrl;
		  } else {
			// Fallback: pergi ke trips listing kalau tiada trip selected
			window.location.href = "/trips";
		  }
		});
	  });
	}

	// Panggil selepas DOM ready
	initProductInfoButtons();

	function setEmailStatus(type, msg) {
	  if (!emailStatus) return;
	  emailStatus.className = "bnw-email-status bnw-email-status--" + type;
	  emailStatus.innerHTML = msg;
	}

// PENTING: field email DIKUNCI (readonly) selepas verified — customer
// idea asal: kalau field tak boleh diedit langsung selepas verified,
// keseluruhan kelas bug "state.otp_verified lama terpakai untuk email
// baharu yang tak disahkan" jadi MUSTAHIL berlaku, sebab kandungan field
// tu sendiri tak boleh berubah. Kekal locked selama-lamanya sekali
// verified — tiada mekanisme unlock (customer refresh/mula semula
// wizard kalau perlu tukar email).
function lockEmailField() {
  emailInput.readOnly = true;
}

// Gmail recommendation hint — show when user focuses email field
// and hide once they type @gmail.com or a different domain
(function initGmailHint() {
  var gmailHint = document.getElementById("bnwGmailHint");
  if (!gmailHint || !emailInput) return;

  emailInput.addEventListener("focus", function() {
    if (!emailInput.value.includes("@")) {
      gmailHint.style.display = "flex";
    }
  });

  emailInput.addEventListener("input", function() {
    var val = emailInput.value.toLowerCase();
    if (val.includes("@") && !val.includes("@gmail")) {
      // User typed non-Gmail domain — hide hint
      gmailHint.style.display = "none";
    } else if (val.includes("@gmail")) {
      // Already using Gmail — hide hint
      gmailHint.style.display = "none";
    } else if (!val.includes("@") && emailInput === document.activeElement) {
      // Still typing domain part, show hint
      gmailHint.style.display = "flex";
    }
  });

  emailInput.addEventListener("blur", function() {
    // Auto-hide after 3 seconds when user moves away
    setTimeout(function() { gmailHint.style.display = "none"; }, 3000);
  });
})();

// Reset SERTA-MERTA bila email field diedit — elak state.otp_verified
// (dari email SEBELUM ni yang mungkin verified) kekal sah untuk kandungan
// email BAHARU yang belum pernah disahkan langsung. Tanpa ni, ada tingkap
// masa (dari customer mula taip sehingga blur+async check selesai) di
// mana butang "Continue" kekal enabled berdasarkan status email LAMA —
// isu keselamatan sebenar (customer boleh proceed dengan email tak
// disahkan asalkan mereka pernah taip email lain yang verified dulu).
if (emailInput) {
  emailInput.addEventListener("input", function() {
    state.otp_verified      = false;
    if (otpInline) otpInline.style.display = "none";
    setEmailStatus("", "");
    checkStep2Ready();
  });

  // Auto-check email bila keluar dari field
  // GUARD: Jangan trigger OTP semasa Stripe return — tiada wizard state yang sah
  emailInput.addEventListener("blur", async function() {
  if (_stripeReturn) return;  // Skip OTP semasa confirmation pasca-Stipe
  var email = this.value.trim();
  if (!email || !email.includes("@")) return;

  setEmailStatus("loading", '<i class="ti ti-loader-2 bnw-spin"></i> Checking...');

  try {
    var result = await apiCall(
      "travel_booking.api.booking.send_otp",
      { email: email },
      false  // POST — send_otp ada side-effect (hantar email), bukan GET
    );

    if (result.verified) {
      // Email ada dalam sistem — verified terus
      state.otp_verified      = true;
      otpInline.style.display = "none";
      lockEmailField();
      setEmailStatus("verified", '<i class="ti ti-circle-check"></i> Verified');

      // Auto-fill + lock Full Name & Phone Number sekali — customer
      // sedia ada tak perlu taip semula maklumat yang sistem SEBENARNYA
      // dah ada untuk mereka. Cuma auto-fill + lock field yang MEMANG
      // ada data (jangan overwrite dengan kosong/lock field yang
      // customer masih perlu isi sendiri, cth Contact tak lengkap).
      var nameInput = document.getElementById("bnwBillingName");
      if (result.full_name && nameInput) {
        nameInput.value    = result.full_name.toUpperCase();
        nameInput.readOnly = true;
      }
      if (result.phone) {
        if (_itiBillingPhone) {
          _itiBillingPhone.setNumber(result.phone);
        } else {
          var phoneInputEl = document.getElementById("bnwBillingPhone");
          if (phoneInputEl) phoneInputEl.value = result.phone;
        }
        var phoneInput = document.getElementById("bnwBillingPhone");
        if (phoneInput) phoneInput.readOnly = true;
      }
      checkStep2Ready();
    } else {
      // Email baru — tunjuk OTP field
      state.otp_verified      = false;
      otpInline.style.display = "block";
      document.getElementById("bnwOtpNoticeText").textContent =
        "A verification code has been sent to " + email + ". Please check your inbox.";
      setEmailStatus("pending", '<i class="ti ti-mail"></i> OTP sent');
    }
  } catch(e) {
    // PENTING: WAJIB reset ke false di sini — kalau tidak, state.otp_verified
    // dari email SEBELUM ni (cth verified=true) kekal terpakai untuk email
    // BAHARU yang gagal disahkan (cth rate-limit "Sila tunggu sebentar..."),
    // dan butang "Continue" akan silap kekal enabled untuk email yang
    // sebenarnya BELUM disahkan langsung.
    state.otp_verified = false;
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> ' +
      ((e && e.message) ? e.message : "Error"));
  }

	  checkStep2Ready();
});
} // end if (emailInput)

// Auto verify bila 6 digit OTP diisi
if (otpInput) {
  otpInput.addEventListener("input", async function() {
  if (this.value.length !== 6) return;

  showLoading("Verifying OTP...");
  try {
    await apiCall(
      "travel_booking.api.booking.verify_otp",
      { email: emailInput.value.trim(), otp: this.value },
      false  // POST
    );
    state.otp_verified  = true;
    otpInline.innerHTML =
      '<div class="bnw-field" ><div class="bnw-notice bnw-notice-success">' +
        '<i class="ti ti-circle-check"></i>' +
        '<span>Email verified successfully!</span>' +
      '</div></div>';
    lockEmailField();
    setEmailStatus("verified", '<i class="ti ti-circle-check"></i> Verified');
    checkStep2Ready();
  } catch(e) {
    this.value = "";
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> Invalid OTP');
    document.getElementById("bnwOtpNoticeText").textContent = "Invalid OTP. Please try again or resend.";
  }
  hideLoading();
	});
} // end if (otpInput)

// Resend OTP button
var resendOtpEl = document.getElementById("bnwResendOtp");
if (resendOtpEl) resendOtpEl.addEventListener("click", async function() {
  showLoading("Resending OTP...");
  try {
    await apiCall(
      "travel_booking.api.booking.send_otp",
      { email: emailInput.value.trim() },
      false  // POST — sama sebab macam blur handler di atas
    );
    setEmailStatus("pending", '<i class="ti ti-mail"></i> OTP resent');
    document.getElementById("bnwOtpNoticeText").textContent =
      "A new code has been sent to " + emailInput.value.trim();
  } catch(e) {
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> Failed to resend');
    document.getElementById("bnwOtpNoticeText").textContent =
      (e && e.message) ? e.message : "Failed to resend OTP. Please try again.";
	  }
	  hideLoading();
	}); // end if (resendOtpEl)

// ══════════════════════════════════════════════
// GOOGLE SIGN-IN (Social Login — faster & more secure than OTP)
// ══════════════════════════════════════════════
var googleSignInBtn = document.getElementById("googleSignInBtn");
if (googleSignInBtn) googleSignInBtn.addEventListener("click", async function() {
  showLoading("Connecting to Google...");
  try {
    // Simpan wizard state SEBELUM redirect supaya tak hilang bila user balik
    saveState();

    // Dapatkan OAuth URL dari server (include redirect back to booking page)
    var currentUrl = window.location.pathname + window.location.search;
    var result = await apiCall(
      "travel_booking.api.portal_auth.get_google_login_url",
      { redirect_to: currentUrl },
      true  // GET
    );

    if (result && result.url) {
      // Redirect ke Google OAuth — user akan balik sini dengan session aktif
      window.location.href = result.url;
    } else {
      // Fallback: guna return value terus sebagai URL (legacy format)
      window.location.href = result;
    }
  } catch(e) {
    hideLoading();
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> ' +
      ((e && e.message) ? e.message : "Failed to connect to Google. Please try again."));
  }
});

// ─── Check untuk post-OAuth session on page load ──
// Bila user balik dari Google OAuth redirect, session dah authenticated.
// Function ni auto-verify email + hide OTP/social login, isi nama dari Frappe User.
function checkPostGoogleAuth() {
  // CSRF_TOKEN terisi HANYA bila session authenticated (rujuk www/booking.py)
  // — ini penanda paling reliable bahawa user baru login via Google/portal.
  var wasGuest = !CSRF_TOKEN || CSRF_TOKEN === "";

  // Jika pageData ada `user` field dan bukan Guest → user dah login
  var userData = _data.user || null;
  var isLoggedIn = userData && userData !== "Guest";

  if (isLoggedIn && state.step >= 1 && !state.otp_verified) {
    // User baru login via Google tapi belum verify di wizard ni
    var emailInput = document.getElementById("bnwBillingEmail");
    var userEmail  = (userData && userData.email) || "";

    // Isi email dari Frappe User kalau field kosong
    if (emailInput && !emailInput.value.trim() && userEmail) {
      emailInput.value = userEmail;
    }

    // Auto-verify — Google OAuth sudah sahkan identiti email
    state.otp_verified = true;

    // Hide OTP + social login section
    var otpInline     = document.getElementById("otpInline");
    var socialSection = document.getElementById("socialLoginSection");
    if (otpInline) otpInline.style.display = "none";
    if (socialSection) socialSection.classList.add("verified");

    lockEmailField();
    setEmailStatus("verified", '<i class="ti ti-circle-check"></i> Verified via Google');

    // Cuba ambil nama dari Frappe User profile
    if (userData && (userData.full_name || userData.first_name)) {
      var nameInput = document.getElementById("bnwBillingName");
      var displayName = userData.full_name ||
        (userData.first_name + " " + (userData.last_name || "")).trim();
      if (nameInput && displayName) {
        nameInput.value    = displayName.toUpperCase();
        nameInput.readOnly = true;
      }
    }

    checkStep2Ready();
  }
}

// Panggil check selepas init selesai (delay sedikit pastikan DOM ready)
setTimeout(checkPostGoogleAuth, 500);

function checkStep2Ready() {
  var nameEl = document.getElementById("bnwBillingName");
  var name  = nameEl ? nameEl.value.trim() : "";
  var phone = _getBillingPhoneFull();
  step2NextBtn.disabled = !(name && phone && state.otp_verified);
}

// Full Name dipaksa UPPERCASE semasa customer menaip — bukan sekadar
// CSS visual (text-transform), tapi nilai SEBENAR yang disimpan, sebab
// billing.full_name ni terus jadi Customer.customer_name, Contact.first_name,
// DAN User.first_name/last_name (rujuk _create_customer()/_ensure_portal_user()
// dalam booking.py) — uppercase di sini automatik mengalir ke ketiga-tiga
// rekod tanpa perlu ubah backend. Cursor position dikekalkan (setSelectionRange)
// supaya tak "terlonjak" ke hujung setiap kali menaip huruf tengah-tengah nama.
var billingNameEl = document.getElementById("bnwBillingName");
if (billingNameEl) billingNameEl.addEventListener("input", function() {
  var start = this.selectionStart;
  var end   = this.selectionEnd;
  this.value = this.value.toUpperCase();
  this.setSelectionRange(start, end);
});

["billingName", "billingPhone"].forEach(function(id) {
  var el = document.getElementById("bnw" + id.charAt(0).toUpperCase() + id.slice(1));
  if (el) el.addEventListener("input", checkStep2Ready);
});

var step2NextEl = document.getElementById("bnwStep2Next");
if (step2NextEl) step2NextEl.addEventListener("click", function() {
  var phone = _getBillingPhoneFull();
  // Validate SEBELUM proceed — sama ketat dengan library Python
  // 'phonenumbers' yang Frappe check server-side, elak customer sampai
  // ke Step 3/pembayaran dengan nombor telefon yang tak sah.
  if (typeof libphonenumber === "undefined" || !libphonenumber.isValidPhoneNumber(phone)) {
    alert('Phone number "' + phone + '" does not look like a valid number. Please check the country code and number.');
    return;
  }
  state.billing = {
    full_name: document.getElementById("bnwBillingName").value.trim(),
    email:     emailInput.value.trim(),
    phone:     phone,
  };
  buildOrderSummary();
  showStep(3);
}); // end if (step2NextEl)

function buildOrderSummary() {
  var lines   = document.getElementById("bnwOrderLines");
  var totalEl = document.getElementById("bnwOrderGrandTotal");
  lines.innerHTML = "";
  var grand = 0;

  // Iterate PER-CABIN dari state.rooms — model SLOT (Main Guest/Extra Bed/
  // Infant), format ikut "Cabin Fare:" + senarai "Guest N: [label]" sepadan
  // dengan Payment Summary rujukan.
  var activeRooms = state.rooms.filter(function(r) {
    return r.room_category && (r.main_guests + r.extra_beds + r.infants) > 0;
  });

  activeRooms.forEach(function(r, idx) {
    var c = cabinByCategory(r.room_category);
    if (!c) return;
    var p = c.pricing;
    var cabinFare = 0;
    var guestLines = [];
    var guestNo = 1;

    if (state.is_cruise_trip) {
      if (r.main_guests === 1) {
        var singleRate = Number(p.price_adult_single || 0);
        cabinFare += singleRate;
        guestLines.push(["Guest " + guestNo + " : Main Guest", singleRate]);
        guestNo++;
      } else if (r.main_guests >= 2) {
        var twinRate = Number(p.price_adult || 0);
        for (var i = 0; i < r.main_guests; i++) {
          cabinFare += twinRate;
          guestLines.push(["Guest " + guestNo + " : Main Guest", twinRate]);
          guestNo++;
        }
      }
      var upperRate = Number(p.price_upperberth || 0);
      for (var j = 0; j < r.extra_beds; j++) {
        cabinFare += upperRate;
        guestLines.push(["Guest " + guestNo + " : Extra Bed", upperRate]);
        guestNo++;
      }
    } else {
      // Non-cruise: Adult (price_adult) + Children (price_children), flat per pax.
      var adultRate = Number(p.price_adult || 0);
      for (var i = 0; i < r.main_guests; i++) {
        cabinFare += adultRate;
        guestLines.push(["Guest " + guestNo + " : Adult", adultRate]);
        guestNo++;
      }
      var childRate = Number(p.price_children || 0);
      for (var j = 0; j < r.extra_beds; j++) {
        cabinFare += childRate;
        guestLines.push(["Guest " + guestNo + " : Children", childRate]);
        guestNo++;
      }
    }
    var infantRate = Number(p.price_infant || 0);
    for (var k = 0; k < r.infants; k++) {
      cabinFare += infantRate;
      guestLines.push(["Guest " + guestNo + " : Infant", infantRate]);
      guestNo++;
    }

    grand += cabinFare;

    // Use room_name (consistent with Step 1 & 2)
    var cabinDisplayName = c.room_name || c.room_category || "Cabin";
    lines.innerHTML +=
      '<div class="bnw-order-cabin">' +
        '<div class="bnw-order-cabin-title">' + cabinDisplayName + ' (' + (idx + 1) + ')</div>' +
        '<div class="bnw-order-line bnw-order-line-fare"><span>Cabin Fare:</span><span>' + fmt(cabinFare) + '</span></div>' +
        '<div class="bnw-order-guests">' +
          guestLines.map(function(g) {
            return '<div class="bnw-order-guest-detail"><span>' + g[0] + '</span> : <span>' + fmt(g[1]) + '</span></div>';
          }).join("") +
        '</div>' +
      '</div>';
  });

  totalEl.textContent = fmt(grand);

  var totalPax = activeRooms.reduce(function(a, r) { return a + r.main_guests + r.extra_beds + r.infants; }, 0);

  // Maklumat trip (Trip / Tarikh Berlepas / Jenis Package) — sentiasa
  // kelihatan supaya customer tahu dia bayar untuk trip yang mana.
  //
  // PENTING: SENGAJA tak guna state.group_name / state.package_label
  // terus — dua-dua field admin-authored tu (Trip Group Date.trip_group_name,
  // Trip Package.package_title) masing-masing DAH mengandungi nama trip +
  // tarikh + jenis package bertindih sendiri (cth "2026-09-30 : TRIP12 :
  // Fly Cruise" dan "3N Yanbu Cruise / Fly Cruise / KUL") — gabung
  // ketiga-tiga terus jadi keliru/berulang untuk customer (nama trip &
  // "Fly Cruise" muncul 2-3 kali, kod dalaman "TRIP12" tak bermakna untuk
  // customer). Sebaliknya bina terus dari field ATOMIC yang bersih:
  // trip_name (dropdown), departure_date (Trip Group Date), package_type
  // (Trip Package — enum bersih: "Fly Cruise"/"Cruise Only"/dsb).
  var tripEl = document.getElementById("bnwOrderSummaryTrip");
  if (tripEl) {
    var grpForSummary = (trip_group_dateS[state.trip_master] || []).find(function(g) {
      return g.name === state.trip_group_date;
    });
    var pkgForSummary = (TRIP_PACKAGES[state.trip_group_date] || []).find(function(p) {
      return p.name === state.trip_package;
    });
    var tripParts = [
      state.trip_name,
      grpForSummary ? fmtDate(grpForSummary.departure_date) : "",
      pkgForSummary ? pkgForSummary.package_type : "",
    ].filter(Boolean);
    tripEl.textContent = tripParts.join(" \u00b7 ");
  }

  // Ringkasan untuk header (bila collapsed) — cth "Balcony cabin \u00b7 2 guests"
  var subEl = document.getElementById("bnwOrderSummarySub");
  if (subEl) {
    var uniqueCabins = [];
    activeRooms.forEach(function(r) {
      if (uniqueCabins.indexOf(r.room_category) === -1) uniqueCabins.push(r.room_category);
    });
    subEl.textContent = (uniqueCabins.join(", ") || "No cabin selected") +
      " \u00b7 " + totalPax + " guest" + (totalPax === 1 ? "" : "s");
  }

  updatePaymentUI();
  document.getElementById("bnwBannerSummary2").textContent =
    activeRooms.length + " cabin(s) \u00b7 " + totalPax + " pax \u00b7 " + fmt(grand);
}

// ── Booking Summary untuk Section 2 (Billing) ──
// Sama detail dengan Step 1 Payment Summary — cabin fare + senarai guest
function buildBookingSummary() {
  var tripEl = document.getElementById("bnwBookingSummaryTrip");
  var subEl = document.getElementById("bnwBookingSummarySub");
  var linesEl = document.getElementById("bnwBookingSummaryLines");
  var totalEl = document.getElementById("bnwBookingGrandTotal");

  if (!tripEl) return;

  // Trip info (same logic as order summary)
  var grpForSumm = (trip_group_dateS[state.trip_master] || []).find(function(g) {
    return g.name === state.trip_group_date;
  });
  var pkgForSumm = (TRIP_PACKAGES[state.trip_group_date] || []).find(function(p) {
    return p.name === state.trip_package;
  });
  var tripParts = [
    state.trip_name,
    grpForSumm ? fmtDate(grpForSumm.departure_date) : "",
    pkgForSumm ? pkgForSumm.package_type : "",
  ].filter(Boolean);
  tripEl.textContent = tripParts.join(" \u00b7 ");

  // Active rooms dengan guests
  var activeRooms = state.rooms.filter(function(r) {
    return r.room_category && (r.main_guests + r.extra_beds + r.infants) > 0;
  });
  var totalPax = 0;
  activeRooms.forEach(function(r) { totalPax += (r.main_guests + r.extra_beds + r.infants); });

  // Subtitle: cabin summary
  var uniqueCabins = [];
  activeRooms.forEach(function(r) {
    if (uniqueCabins.indexOf(r.room_category) === -1) uniqueCabins.push(r.room_category);
  });
  if (subEl) {
    subEl.textContent = (uniqueCabins.join(", ") || "No cabin selected") +
      " \u00b7 " + totalPax + " guest" + (totalPax === 1 ? "" : "s");
  }

  // Detailed room lines — sama format dengan buildStep1Summary()
  if (linesEl) {
    linesEl.innerHTML = "";
    var grandTotal = 0;

    activeRooms.forEach(function(r, idx) {
      var c = cabinByCategory(r.room_category);
      if (!c) return;
      var p = c.pricing;
      var cabinFare = 0;
      var guestLines = [];
      var guestNo = 1;

      // Same logic as buildStep1Summary() — cruise vs non-cruise
      if (state.is_cruise_trip) {
        if (r.main_guests === 1) {
          var singleRate = Number(p.price_adult_single || 0);
          cabinFare += singleRate;
          guestLines.push(["Guest " + guestNo + ": Main Guest", singleRate]);
          guestNo++;
        } else if (r.main_guests >= 2) {
          var twinRate = Number(p.price_adult || 0);
          for (var i = 0; i < r.main_guests; i++) {
            cabinFare += twinRate;
            guestLines.push(["Guest " + guestNo + ": Main Guest", twinRate]);
            guestNo++;
          }
        }
        var upperRate = Number(p.price_upperberth || 0);
        for (var j = 0; j < r.extra_beds; j++) {
          cabinFare += upperRate;
          guestLines.push(["Guest " + guestNo + ": Extra Bed", upperRate]);
          guestNo++;
        }
      } else {
        // Non-cruise: Adult + Children
        var adultRate = Number(p.price_adult || 0);
        for (var i = 0; i < r.main_guests; i++) {
          cabinFare += adultRate;
          guestLines.push(["Guest " + guestNo + ": Adult", adultRate]);
          guestNo++;
        }
        var childRate = Number(p.price_children || 0);
        for (var j = 0; j < r.extra_beds; j++) {
          cabinFare += childRate;
          guestLines.push(["Guest " + guestNo + ": Children", childRate]);
          guestNo++;
        }
      }
      var infantRate = Number(p.price_infant || 0);
      for (var k = 0; k < r.infants; k++) {
        cabinFare += infantRate;
        guestLines.push(["Guest " + guestNo + ": Infant", infantRate]);
        guestNo++;
      }

      grandTotal += cabinFare;

      // Build HTML — sama structure dengan Step 1
      var cabinDiv = document.createElement("div");
      cabinDiv.className = "bnw-order-cabin";
      cabinDiv.innerHTML =
        '<div class="bnw-order-cabin-title">' + (c.room_name || c.room_category || "Cabin") + ' (' + (idx + 1) + ')</div>' +
        '<div class="bnw-order-line bnw-order-line-fare"><span>Cabin Fare:</span><span>' + fmt(cabinFare) + '</span></div>' +
        guestLines.map(function(g) {
          return '<div class="bnw-order-line bnw-order-line-guest"><span>' + g[0] + '</span><span>' + fmt(g[1]) + '</span></div>';
        }).join("");
      linesEl.appendChild(cabinDiv);
    });

    if (!activeRooms.length) {
      linesEl.innerHTML = '<div class="bnw-order-line bnw-order-line-muted"><span>No rooms selected</span></div>';
    }
  }

  // Total
  if (totalEl) {
    totalEl.textContent = fmt(calcGrandTotal());
  }
}

// Kemaskini "Total" dalam Order Summary supaya konsisten dengan calcDiscountedTotal()
// (nilai sebenar yang dipakai untuk kira bayaran) — dipanggil bila voucher/referral
// diguna atau bila payment method ditukar (kerana cashback bergantung padanya).
function refreshOrderSummaryTotal() {
  var totalEl = document.getElementById("bnwOrderGrandTotal");
  if (!totalEl) return;
  totalEl.textContent = fmt(calcDiscountedTotal());

  // Cashback row — papar hanya bila Manual Transfer dipilih & cashback aktif
  var cashbackRow = document.getElementById("bnwCashbackDiscountRow");
  if (!cashbackRow) return;

  var isManual = state_payment_method === "Manual Transfer";
  var s = state_payment_settings;
  if (isManual && s.cashback_enabled && s.cashback_percent > 0) {
    var afterVoucher  = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
    var referralAmt   = afterVoucher * ((state_referral_percent || 0) / 100);
    var afterReferral = Math.max(0, afterVoucher - referralAmt);
    var cashbackAmt   = afterReferral * (s.cashback_percent / 100);

    var cbPctEl = document.getElementById("bnwCashbackPercentApplied");
    var cbAmtEl = document.getElementById("bnwCashbackDiscountAmt");
    if (cbPctEl) cbPctEl.textContent = s.cashback_percent;
    if (cbAmtEl) cbAmtEl.textContent = "-" + fmt(cashbackAmt);
    cashbackRow.style.display = "flex";
  } else {
    cashbackRow.style.display = "none";
  }
}

// ─── STEP 3: PAYMENT ──────────────────────────────────────
// Diisi oleh loadPaymentSettings() dari Travel Settings — nilai default dah
// ditetapkan di awal file (selepas state object) untuk elak undefined error.
// MULTI-CURRENCY: bank_accounts ialah dict {currency: {bank_name,
// account_name, account_number}} — dipilih ikut state.package_currency
// bila render (rujuk renderPaymentSettingsUI()), sebab currency sebenar
// booking BELUM diketahui semasa loadPaymentSettings() jalan (page load,
// sebelum customer pilih Trip/Package).
async function loadPaymentSettings() {
  try {
    var result = await apiCall("travel_booking.api.booking.get_payment_settings", {}, true);
    if (result && !result.exc) {
      state_payment_settings = {
        bank_accounts:           (result.bank_accounts && Object.keys(result.bank_accounts).length)
                                    ? result.bank_accounts : state_payment_settings.bank_accounts,
        cashback_enabled:        !!result.cashback_enabled,
        cashback_percent:        result.cashback_percent || 0,
        default_deposit_percent: result.default_deposit_percent || 20
      };
    }
  } catch (e) {
    // Diam-diam guna fallback di atas — booking tetap boleh diteruskan.
  }
  renderPaymentSettingsUI();
}

// Sales Person — optional, staff dalaman RareCruise. Customer boleh tambah
// lebih dari SATU (butang "+ Add another"); setiap satu disimpan sebagai
// row berasingan dalam SO's child table Sales Team bila confirm_booking()
// dipanggil (cuma nama — Contribution %/Commission Rate/Incentives biarkan
// kosong, admin isi sendiri di Desk kalau perlu, ini sekadar tracking).
var state_sales_persons_available = [];
var state_sales_person_rows       = [];
var salesPersonRowSeq = 0;

async function loadSalesPersons() {
  try {
    var list = await apiCall("travel_booking.api.booking.get_sales_persons", {}, true);
    if (Array.isArray(list)) state_sales_persons_available = list;
  } catch (e) {
    // Diam-diam gagal — field ni optional, tak patut sekat wizard.
  }
  if (!state_sales_person_rows.length) addSalesPersonRow();
  renderSalesPersonRows();
}

function addSalesPersonRow() {
  state_sales_person_rows.push({ uid: ++salesPersonRowSeq, value: "" });
  renderSalesPersonRows();
}

function removeSalesPersonRow(uid) {
  state_sales_person_rows = state_sales_person_rows.filter(function(r) { return r.uid !== uid; });
  renderSalesPersonRows();
}

function renderSalesPersonRows() {
  var list = document.getElementById("bnwSalesPersonList");
  if (!list) return;
  list.innerHTML = "";

  state_sales_person_rows.forEach(function(row) {
    var rowEl = document.createElement("div");
    rowEl.className = "bnw-sales-row";

    var selWrap = document.createElement("div");
    selWrap.className = "bnw-select-wrap";
    var sel = document.createElement("select");
    sel.className = "bnw-select";
    var ph = document.createElement("option");
    ph.value = "";
    ph.textContent = " Select Sales Person ";
    if (!row.value) ph.selected = true;
    sel.appendChild(ph);
    state_sales_persons_available.forEach(function(sp) {
      var opt = document.createElement("option");
      opt.value = sp.name;
      opt.textContent = sp.sales_person_name || sp.name;
      if (sp.name === row.value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", function() { row.value = this.value; });
    var chev = document.createElement("i");
    chev.className = "ti ti-chevron-down bnw-select-icon";
    selWrap.appendChild(sel);
    selWrap.appendChild(chev);
    rowEl.appendChild(selWrap);

    if (state_sales_person_rows.length > 1) {
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "bnw-sales-remove";
      rm.textContent = "Remove";
      rm.addEventListener("click", function() { removeSalesPersonRow(row.uid); });
      rowEl.appendChild(rm);
    }

    list.appendChild(rowEl);
  });
}

document.getElementById("bnwAddSalesPersonBtn").addEventListener("click", addSalesPersonRow);

function renderPaymentSettingsUI() {
  // Guard: state_payment_settings mungkin belum di-initialize kalau fungsi ini
  // dipanggil awal (sebelum declaration sampai ke line tersebut). Gunakan
  // default values sebagai fallback.
  var s = state_payment_settings || {
    bank_accounts: {
      MYR: { bank_name: "Maybank", account_name: "Rarecation Sdn Bhd", account_number: "1234 5678 9012" }
    },
    cashback_enabled: true,
    cashback_percent: 5,
    default_deposit_percent: 20
  };

  // COMPANY-CURRENCY: bank details (Manual Transfer) ikut COMPANY currency
  // — customer dicaj dalam company currency (SO/Stripe/Payment Entry semua
  // company currency), jadi mereka kena transfer ke bank account company.
  // Bukan state.package_currency (itu cuma hint paparan converter sekarang).
  var currency = state.company_currency || "MYR";
  var bankInfo = (s.bank_accounts && s.bank_accounts[currency]) || null;

  // Bank transfer details
  var bankNameEl = document.getElementById("bnwBankNameDisplay");
  var acctNameEl = document.getElementById("bnwBankAccountNameDisplay");
  var acctNoEl   = document.getElementById("bnwBankAccountNumberDisplay");
  if (bankNameEl) bankNameEl.textContent = bankInfo ? bankInfo.bank_name : "";
  if (acctNameEl) acctNameEl.textContent = bankInfo ? bankInfo.account_name : "";
  if (acctNoEl)   acctNoEl.textContent   = bankInfo ? bankInfo.account_number : "";

  // Sembunyikan pilihan "Manual Bank Transfer" sepenuhnya kalau admin
  // belum konfigurasikan Bank Account untuk currency package ni (rujuk
  // dokumen reka bentuk multi-currency: "sembunyikan pilihan payment,
  // bukan fallback senyap ke MYR" — elak customer transfer duit currency
  // asing ke bank yang salah/tak ditrack betul).
  var labelManualEl = document.getElementById("bnwLabelManual");
  if (labelManualEl) {
    if (bankInfo) {
      labelManualEl.style.display = "";
    } else {
      labelManualEl.style.display = "none";
      // Kalau customer TERLANJUR dah pilih Manual Transfer sebelum tukar
      // ke currency yang tiada Manual Transfer — paksa balik ke Online
      // Payment (satu-satunya pilihan yang pasti sah untuk semua currency,
      // rujuk "Pilihan A" — satu akaun Stripe untuk semua currency).
      var manualRadio = labelManualEl.querySelector("input[type=radio]");
      if (manualRadio && manualRadio.checked) {
        var onlineRadio = document.querySelector('input[name="paymentMethod"][value="Online Payment"]');
        if (onlineRadio) {
          onlineRadio.checked = true;
          onPaymentMethodChange(onlineRadio);
        }
      }
    }
  }

  // Cashback badge — sembunyi terus kalau admin matikan cashback ATAU
  // Manual Transfer sendiri tak available untuk currency ni (tiada bank
  // untuk terima transfer = tiada cashback untuk ditawarkan).
  var badge = document.getElementById("bnwCashbackBadge");
  var note  = document.getElementById("bnwCashbackNote");
  if (bankInfo && s.cashback_enabled && s.cashback_percent > 0) {
    if (badge) { badge.textContent = s.cashback_percent + "% cashback"; badge.style.display = ""; }
    if (note)  { note.textContent  = "Get " + s.cashback_percent + "% cashback when you pay via bank transfer"; note.style.display = ""; }
  } else {
    if (badge) badge.style.display = "none";
    if (note)  note.style.display = "none";
    if (labelManualEl) labelManualEl.classList.add("bnw-no-cashback");
  }

  // Deposit % label — ganti "Deposit (20%)" hardcoded dengan nilai sebenar
  var depositLabelStep1 = document.getElementById("bnwTotalsDepositLabel");
  var depositLabelStep3 = document.getElementById("bnwPayDepositChipLabel");
  var depositLabelText  = "Deposit (" + s.default_deposit_percent + "%)";
  if (depositLabelStep1) depositLabelStep1.textContent = depositLabelText;
  if (depositLabelStep3) depositLabelStep3.textContent = depositLabelText;

  // Refresh total/pay summary sekiranya method dah dipilih dan cashback berbeza dari fallback
  if (typeof updatePaymentUI === "function") updatePaymentUI();
  // Refresh anggaran deposit Step 1 sekiranya cabin dah dipilih sebelum settings sampai
  if (typeof updateTotals === "function") updateTotals();
}

function onVoucherBtnClick() {
  // Butang TUNGGAL — toggle ikut state semasa. Bila voucher tak aktif,
  // klik = "Apply" (validate & apply kod dari input). Bila voucher DAH
  // aktif, klik SAMA butang tu (teks dah bertukar "Remove") = buang kod,
  // reset totals, unlock input untuk kod baharu.
  if (state_voucher_code) {
    removeVoucher();
  } else {
    applyVoucher();
  }
}

async function applyVoucher() {
  var code = document.getElementById("bnwVoucherInput").value.trim().toUpperCase();
  if (!code) return;

  var btn = document.getElementById("bnwVoucherBtn");
  btn.disabled = true;
  btn.textContent = "Checking...";

  var grand = calcGrandTotal();

  // Hantar breakdown per-cabin (sama struktur dengan payload confirm_booking)
  // supaya backend boleh kira diskaun ikut SCOPE voucher (subtotal cabin
  // yang match sahaja), bukan grand_total keseluruhan.
  var activeSelectionsForVoucher = state.rooms
    .filter(function(r) { return r.room_category && (r.main_guests + r.extra_beds + r.infants) > 0; })
    .map(function(r) {
      return {
        room_category: r.room_category,
        main_guests:   r.main_guests,
        extra_beds:    r.extra_beds,
        infants:       r.infants,
      };
    });

  try {
    var result = await apiCall(
      "travel_booking.api.booking.validate_voucher",
      {
        code:            code,
        trip_group_date: state.trip_group_date,
        grand_total:     grand,
        email:           state.billing ? state.billing.email : "",
        selections:      JSON.stringify(activeSelectionsForVoucher),
        trip_package:    state.trip_package,
        is_cruise:       state.is_cruise_trip,
      },
      true  // GET
    );

    if (result.valid) {
      state_voucher_code     = code;
      state_voucher_discount = result.discount_amount;

      // Show discount row
      document.getElementById("bnwVoucherDiscountRow").style.display = "flex";
      document.getElementById("bnwVoucherCodeApplied").textContent   = code;
      document.getElementById("bnwVoucherDiscountAmt").textContent    = "-" + fmt(result.discount_amount);

      // Kunci input (elak edit kod yang dah aktif) — butang sendiri TAK
      // dikunci, sebaliknya bertukar fungsi jadi "✕" (buang kod, rujuk
      // onVoucherBtnClick() — satu butang, dua peranan ikut state).
      document.getElementById("bnwVoucherInput").disabled = true;
      btn.textContent = "\u2715";
      btn.classList.add("bnw-btn-voucher-applied");

      // Show success message
      showVoucherMsg("success", "✓ " + result.message);

      // Update totals
      updatePaymentUI();
    } else {
      state_voucher_code     = "";
      state_voucher_discount = 0;
      document.getElementById("bnwVoucherDiscountRow").style.display = "none";
      btn.textContent = "Apply";
      showVoucherMsg("error", result.message);
      updatePaymentUI();
    }
  } catch(e) {
    btn.textContent = "Apply";
    showVoucherMsg("error", "Failed to validate voucher. Please try again.");
  }

  btn.disabled = false;
}

function removeVoucher() {
  state_voucher_code     = "";
  state_voucher_discount = 0;

  document.getElementById("bnwVoucherDiscountRow").style.display = "none";
  document.getElementById("bnwVoucherMsg").style.display = "none";

  var input = document.getElementById("bnwVoucherInput");
  input.disabled = false;
  input.value = "";

  var btn = document.getElementById("bnwVoucherBtn");
  btn.textContent = "Apply";
  btn.classList.remove("bnw-btn-voucher-applied");

  updatePaymentUI();
}



function showVoucherMsg(type, msg) {
  var el = document.getElementById("bnwVoucherMsg");
  el.style.display = "block";
  el.style.color   = type === "success" ? "var(--rc-green)" : "#CC0000";
  el.textContent   = msg;
}

function onAffiliateBtnClick() {
  // Butang TUNGGAL — sama pattern dengan onVoucherBtnClick().
  if (state_affiliate_code) {
    removeAffiliateCode();
  } else {
    applyAffiliateCode();
  }
}

async function applyAffiliateCode() {
  var code = document.getElementById("bnwAffiliateInput").value.trim().toUpperCase();
  if (!code) return;

  var btn = document.getElementById("bnwAffiliateBtn");
  btn.disabled = true;
  btn.textContent = "Checking...";

  try {
    var result = await apiCall(
      "travel_booking.api.booking.validate_affiliate_code",
      { code: code, trip_group_date: state.trip_group_date },
      true  // GET
    );

    if (result.valid) {
      state_affiliate_code   = code;
      state_referral_percent = result.discount_percent;

      if (state_referral_percent > 0) {
        // Ada discount sebenar untuk customer — papar row + amount.
        document.getElementById("bnwAffiliateDiscountRow").style.display = "flex";
        document.getElementById("bnwAffiliateCodeApplied").textContent   = code;
        // Amount papar dikira dari baki SELEPAS voucher (tier B) — sepadan backend.
        var afterVoucher   = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
        var referralAmount = Math.round(afterVoucher * (state_referral_percent / 100) * 100) / 100;
        document.getElementById("bnwAffiliateDiscountAmt").textContent = "-" + fmt(referralAmount);
      } else {
        // Kod SAH (affiliate tetap dapat commission bila SO/SI dibayar
        // penuh) tapi admin belum konfigurasikan % discount customer di
        // Travel Settings — jangan papar row discount dengan "-RM 0.00"
        // yang mengelirukan; state_affiliate_code tetap disimpan untuk
        // dihantar ke confirm_booking() (attribution affiliate kekal).
        document.getElementById("bnwAffiliateDiscountRow").style.display = "none";
      }

      // Kunci input (elak edit kod yang dah aktif) — butang sendiri TAK
      // dikunci, sebaliknya bertukar fungsi jadi "✕" (buang kod, rujuk
      // onAffiliateBtnClick() — satu butang, dua peranan ikut state).
      document.getElementById("bnwAffiliateInput").disabled = true;
      btn.textContent = "\u2715";
      btn.classList.add("bnw-btn-voucher-applied");

      showAffiliateMsg("success", "✓ " + result.message);
      updatePaymentUI();
    } else {
      state_affiliate_code   = "";
      state_referral_percent = 0;
      document.getElementById("bnwAffiliateDiscountRow").style.display = "none";
      btn.textContent = "Apply";
      showAffiliateMsg("error", result.message);
      updatePaymentUI();
    }
  } catch (e) {
    btn.textContent = "Apply";
    showAffiliateMsg("error", "Failed to validate referral code. Please try again.");
  }

  btn.disabled = false;
}

function removeAffiliateCode() {
  state_affiliate_code   = "";
  state_referral_percent = 0;

  document.getElementById("bnwAffiliateDiscountRow").style.display = "none";
  document.getElementById("bnwAffiliateMsg").style.display = "none";

  var input = document.getElementById("bnwAffiliateInput");
  input.disabled = false;
  input.value = "";

  var btn = document.getElementById("bnwAffiliateBtn");
  btn.textContent = "Apply";
  btn.classList.remove("bnw-btn-voucher-applied");

  updatePaymentUI();
}


function prefillAffiliateCodeFromUrl() {
  // PENTING: guna parameter 'sp' (sales partner), BUKAN 'ref'. 'ref' sudah
  // digunakan checkStripeReturn() untuk booking_number selepas redirect
  // Stripe (?ref=RCXXXXXX&step=confirm&pr=...) — kalau function ni turut
  // baca 'ref' untuk affiliate code, customer yang balik dari bayaran
  // Stripe akan tersalah dapat booking_number diproses SEBAGAI kod
  // affiliate (dua maksud berlainan berkongsi satu nama parameter). 'sp'
  // parameter baharu yang tak bertembung dengan mana-mana penggunaan lain.
  var params = new URLSearchParams(window.location.search);
  var ref = params.get("sp");
  if (!ref) return;

  var input = document.getElementById("bnwAffiliateInput");
  if (!input) return;

  input.value = ref.trim().toUpperCase();
  applyAffiliateCode();
}

function showAffiliateMsg(type, msg) {
  var el = document.getElementById("bnwAffiliateMsg");
  el.style.display = "block";
  el.style.color   = type === "success" ? "var(--rc-green)" : "#CC0000";
  el.textContent   = msg;
}

function onPaymentMethodChange(radio) {
  state_payment_method = radio.value;
  updatePaymentUI();
}

function getDiscounted() { return calcDiscountedTotal(); }
function getMinPay()    { return Math.round(getDiscounted() * (state_payment_settings.default_deposit_percent / 100) * 100) / 100; }
function getMaxPay()    { return Math.round(getDiscounted() * 100) / 100; }

function refreshPaySummary() {
  var min = getMinPay(), max = getMaxPay();
  var balance = Math.max(0, Math.round((max - state_payment_amount) * 100) / 100);
  var isPartial = state_payment_amount < max - 0.001;

  // Guard: semua elemen Step 3 (Payment)
  var noticeEl = document.getElementById("bnwDepositNotice");
  if (noticeEl) noticeEl.style.display = isPartial ? "flex" : "none";

  var balEl = document.getElementById("bnwBalanceAmt");
  if (balEl) balEl.textContent = fmt(balance);

  var payAmtEl = document.getElementById("bnwPayNowAmount");
  if (payAmtEl) payAmtEl.textContent = " — " + fmt(state_payment_amount);

  var depChipEl = document.getElementById("bnwPayDepositChip");
  if (depChipEl) depChipEl.classList.toggle("active", Math.abs(state_payment_amount - min) < 0.001);

  var fullChipEl = document.getElementById("bnwPayFullChip");
  if (fullChipEl) fullChipEl.classList.toggle("active", Math.abs(state_payment_amount - max) < 0.001);
}

function validatePay() {
  var err = document.getElementById("bnwPayAmountError");
  var btn = document.getElementById("bnwPayNowBtn");

  // Guard: kalau elemen error tak wujud (Step 3 belum render), skip validation UI
  if (!err) return true;

  // Pay Later: tiada bayaran dibuat sekarang (amount sentiasa 0) — skip
  // sepenuhnya validation min/max deposit/full, sebab tiada "amount"
  // untuk disahkan langsung dalam kes ni.
  if (state_payment_method === "Pay Later") {
    err.style.display = "none";
    if (btn) btn.disabled = false;
    return true;
  }

  var min = getMinPay(), max = getMaxPay();
  var ok  = true;
  if (state_payment_amount < min) {
    err.style.display = "block";
    err.textContent = "Minimum payment is " + fmt(min) + " (" + state_payment_settings.default_deposit_percent + "% deposit).";
    ok = false;
  } else if (state_payment_amount > max) {
    err.style.display = "block";
    err.textContent = "Maximum payment is " + fmt(max) + " (full amount).";
    ok = false;
  } else {
    err.style.display = "none";
  }
  if (btn) btn.disabled = !ok;
  return ok;
}

function setPayAmount(v) {
  var min = getMinPay(), max = getMaxPay();
  if (isNaN(v)) v = max;
  v = Math.max(min, Math.min(max, Math.round(v * 100) / 100));
  state_payment_amount = v;
  document.getElementById("bnwPayAmountInput").value = v;
  validatePay();
  refreshPaySummary();
}

function updatePaymentUI() {
  var isPayLater = state_payment_method === "Pay Later";

  var min = getMinPay(), max = getMaxPay();

  // Guard: elemen Step 3 (Payment) mungkin belum wujud bila fungsi ini
  // dipanggil awal (semasa init dari cart, user masih di Step 1).
  var chipDepEl = document.getElementById("bnwChipDeposit");
  var chipFullEl = document.getElementById("bnwChipFull");
  if (chipDepEl) chipDepEl.textContent = fmt(min);
  if (chipFullEl) chipFullEl.textContent = fmt(max);

  // COMPANY-CURRENCY: prefix input "Payment Amount" — amaun yang customer
  // BAYAR (deposit/full) sentiasa dalam company currency (dicaj Stripe /
  // Payment Entry), jadi prefix mesti company_symbol, BUKAN package_symbol
  // (itu cuma hint paparan converter sekarang). fmt() pada chip Deposit/
  // Pay-in-full sebelah guna company currency juga (display currency hanya
  // paparan tambahan dalam kurungan).
  var prefixEl = document.getElementById("bnwPayAmountPrefix");
  if (prefixEl) prefixEl.textContent = state.company_symbol || "RM";

  var inp = document.getElementById("bnwPayAmountInput");
  if (inp) { inp.min = min; inp.max = max; }

  if (isPayLater) {
    // Pay Later: tiada bayaran sekarang — amount sentiasa 0, tiada
    // Deposit/Full toggle relevan.
    state_payment_amount = 0;
  } else if (!state_payment_amount || state_payment_amount > max || state_payment_amount < min) {
    // Default to full payment, or clamp an existing amount into the new range
    state_payment_amount = max;
  }
  if (inp) inp.value = state_payment_amount;

  // Sembunyikan seluruh card "Payment Amount" untuk Pay Later — tiada
  // Deposit/Full/custom amount relevan bila tiada bayaran dibuat sekarang.
  var amountCard = document.getElementById("bnwPaymentAmountCard");
  if (amountCard) amountCard.style.display = isPayLater ? "none" : "block";

  // Payment method cards
  //
  // PENTING: kedua-dua card LABEL (.selected class, untuk warna/border
  // highlight) DAN radio input SEBENAR (.checked, untuk dot visual
  // browser native) MESTI disegerakkan dengan state_payment_method di
  // SINI. Sebelum ni, function ni cuma toggle .selected class — radio
  // input's .checked property (yang datang dari attribute HTML statik
  // "checked" pada radio "Online Payment") TAK PERNAH dikemas kini bila
  // state_payment_method direstore dari snapshot (cth selepas refresh
  // page dengan Manual Transfer dipilih sebelum ni) — punca bug radio
  // dot papar "Online Payment" walhal Bank Transfer Details/fields
  // Manual Transfer yang sebenarnya aktif di bawah.
  var radioOnline = document.querySelector('input[name="paymentMethod"][value="Online Payment"]');
  var radioManual = document.querySelector('input[name="paymentMethod"][value="Manual Transfer"]');
  var radioPayLater = document.querySelector('input[name="paymentMethod"][value="Pay Later"]');
  if (radioOnline) radioOnline.checked = state_payment_method === "Online Payment";
  if (radioManual) radioManual.checked = state_payment_method === "Manual Transfer";
  if (radioPayLater) radioPayLater.checked = isPayLater;

  // Guard: label elements (Step 3) mungkin belum wujud
  var labelOnlineEl = document.getElementById("bnwLabelOnline");
  var labelManualEl = document.getElementById("bnwLabelManual");
  if (labelOnlineEl) labelOnlineEl.classList.toggle("selected", state_payment_method === "Online Payment");
  if (labelManualEl) labelManualEl.classList.toggle("selected", state_payment_method === "Manual Transfer");
  var labelPayLaterEl = document.getElementById("bnwLabelPayLater");
  if (labelPayLaterEl) labelPayLaterEl.classList.toggle("selected", isPayLater);

  var isManual = state_payment_method === "Manual Transfer";
  var manualCardEl = document.getElementById("bnwManualTransferCard");
  if (manualCardEl) manualCardEl.style.display = isManual ? "block" : "none";
  var payNowLabelEl = document.getElementById("bnwPayNowLabel");
  if (payNowLabelEl) payNowLabelEl.textContent = isPayLater ? "Confirm Booking" : (isManual ? "Submit Booking" : "Pay Now");

  validatePay();
  refreshPaySummary();
  refreshOrderSummaryTotal();
}

// Payment-amount input wiring
var payInputEl = document.getElementById("bnwPayAmountInput");
if (payInputEl) {
  payInputEl.addEventListener("input", function() {
    state_payment_amount = parseFloat(this.value);
    if (isNaN(state_payment_amount)) state_payment_amount = 0;
    validatePay();
    refreshPaySummary();
  });
  payInputEl.addEventListener("blur", function() {
    setPayAmount(parseFloat(this.value));
  });
} // end if (payInputEl)

// Payment chip buttons (Step 3)
var depositChipEl = document.getElementById("bnwPayDepositChip");
var fullChipEl = document.getElementById("bnwPayFullChip");
if (depositChipEl) depositChipEl.addEventListener("click", function() { setPayAmount(getMinPay()); });
if (fullChipEl) fullChipEl.addEventListener("click", function() { setPayAmount(getMaxPay()); });

function calcGrandTotal() {
  // Kira PER-CABIN dari state.rooms — model SLOT (Main Guest/Extra Bed/
  // Infant), cermin EXACT backend _build_so_items() / _price_selection().
  var total = 0;
  state.rooms.forEach(function(r) {
    if ((r.main_guests + r.extra_beds + r.infants) === 0) return;
    var c = cabinByCategory(r.room_category);
    if (!c) return;
    total += priceRoomSelection(c.pricing, r.main_guests, r.extra_beds, r.infants);
  });
  return total;
}

function calcDiscountedTotal() {
  // Tier B: voucher dulu (dari jumlah asal), referral % kemudian (dari baki selepas voucher).
  // PENTING: round ke 2 titik perpuluhan pada SETIAP langkah — sepadan
  // tepat dengan backend (booking.py: referral_discount = round(grand_total
  // * (referral_percent / 100), 2)) — elak nilai floating-point tak
  // dibundarkan (cth 5.486) terbawa ke pengiraan seterusnya/paparan.
  var afterVoucher = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
  var referralAmt  = Math.round(afterVoucher * ((state_referral_percent || 0) / 100) * 100) / 100;
  var afterReferral = Math.max(0, Math.round((afterVoucher - referralAmt) * 100) / 100);

  // Manual Transfer cashback — dikira di UI untuk paparan sahaja; jumlah
  // sebenar yang dicaj tetap dikira & disahkan semula di backend (booking.py)
  // melalui Sales Order Additional Discount, supaya tiada jurang UI vs invoice.
  if (state_payment_method === "Manual Transfer" &&
      state_payment_settings.cashback_enabled &&
      state_payment_settings.cashback_percent > 0) {
    var cashbackAmt = Math.round(afterReferral * (state_payment_settings.cashback_percent / 100) * 100) / 100;
    return Math.max(0, Math.round((afterReferral - cashbackAmt) * 100) / 100);
  }
  return afterReferral;
}

function onReceiptSelected(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];
  if (file.size > 5 * 1024 * 1024) {
    alert("File too large. Maximum 5MB.");
    input.value = "";
    return;
  }
  // Simpan File asal untuk OCR + baca base64 untuk submission
  state_receipt_file = file;
  var reader = new FileReader();
  reader.onload = function(e) {
    state_receipt_data = e.target.result; // base64
    document.getElementById("bnwReceiptFileName").style.display = "block";
    document.getElementById("bnwReceiptFileNameText").textContent = file.name;
    // Auto-analyze resit guna OCR (gambar sahaja — PDF tak boleh di-OCR client-side)
    if (file.type && file.type.startsWith("image/")) {
      analyzeReceipt(file);
    } else {
      var ocrBox = document.getElementById("bnwReceiptOCR");
      if (ocrBox) ocrBox.style.display = "none";
    }
  };
  reader.readAsDataURL(file);
}

/* ══════════════════════════════════════════════════
   RECEIPT OCR — Extract text dari bank slip (Tesseract.js)
   Corak sama macam traveller/billing: auto-isi Reference No,
   banding jumlah resit vs jumlah diisytiharkan.
   ══════════════════════════════════════════════════ */

var _ocrWorker = null; // Tesseract worker (lazy init)

/* Lazy-initialize Tesseract worker */
async function initReceiptOCR() {
  if (_ocrWorker) return _ocrWorker;
  if (typeof Tesseract === 'undefined') {
    console.warn('Tesseract.js not loaded — OCR unavailable');
    return null;
  }
  try {
    _ocrWorker = await Tesseract.createWorker('eng', 1, {
      logger: function (m) {
        if (m.status === 'recognizing text') {
          var pct = Math.round(m.progress * 100);
          var el = document.getElementById('bnwReceiptOCRStatus');
          if (el) el.textContent = 'Reading receipt... ' + pct + '%';
        }
      }
    });
  } catch (e) {
    console.warn('Failed to init Tesseract:', e);
    _ocrWorker = null;
  }
  return _ocrWorker;
}

/* Parse Malaysian bank slip text for date, reference & amount */
function parseBankSlip(text) {
  if (!text) return { date: null, reference: null, amount: null, rawText: '' };
  var clean = text.replace(/\s+/g, ' ').trim();
  var date = null, reference = null;

  // Date patterns — DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, D MMM YYYY
  var datePatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})/,
    /(\d{1,2})\.(\d{1,2})\.(\d{4})/,
    /(\d{1,2})\.(\d{1,2})\.(\d{2})/,
    /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i
  ];
  var months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
               jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'};
  for (var i = 0; i < datePatterns.length; i++) {
    var m = clean.match(datePatterns[i]);
    if (m) {
      if (m[2].length === 3) {
        date = m[3] + '-' + months[m[2].toLowerCase()] + '-' + m[1].padStart(2,'0');
      } else if (m[3].length === 2) {
        date = '20' + m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
      } else {
        date = m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
      }
      break;
    }
  }

  // Reference number patterns — MY bank slip formats
  var refPatterns = [
    /(?:Ref(?:erence)?|No\.?|Transaction\s*(?:ID|No\.?)?)\s*[:\.\-\s]*([A-Z0-9]{6,20})/i,
    /M2U\s*([A-Z0-9]{10,15})/i,
    /(FPX\d{7})/i,
    /(?:CIMB|RHB|PBB?|HLB)\s*([A-Z0-9]{8,16})/i,
    /\b([A-Z]{2,5}\d{8,12})\b/i
  ];
  for (var j = 0; j < refPatterns.length; j++) {
    var rm = clean.match(refPatterns[j]);
    if (rm) { reference = rm[1]; break; }
  }

  // Amount extraction — RM/MYR formats
  var amount = null;
  var amtPatterns = [
    /(?:RM\s*|MYR\s*)?(?:\$?\s*)([\d,]+\.?\d{0,2})\s*(?:RM|MYR)?/i,
    /(?:Total|Amount|Paid)\s*[:\.]*\s*\$?\s*([\d,]+\.?\d{0,2})/i
  ];
  for (var k = 0; k < amtPatterns.length; k++) {
    var am = clean.match(amtPatterns[k]);
    if (am) {
      amount = parseFloat(am[1].replace(/,/g, ''));
      if (!isNaN(amount)) break;
      else amount = null;
    }
  }

  return { date: date, reference: reference, amount: amount, rawText: clean };
}

/* Main orchestrator — jalankan OCR pada fail resit & auto-isi medan */
async function analyzeReceipt(file) {
  if (!file || !file.type.startsWith('image/')) return false;

  var ocrBox = document.getElementById('bnwReceiptOCR');
  var statusEl = document.getElementById('bnwReceiptOCRStatus');
  var resultEl = document.getElementById('bnwReceiptOCRResult');
  if (ocrBox) ocrBox.style.display = 'block';
  if (resultEl) resultEl.style.display = 'none';
  if (statusEl) statusEl.textContent = 'Reading receipt...';

  try {
    var worker = await initReceiptOCR();
    if (!worker) {
      if (statusEl) statusEl.textContent = 'OCR unavailable — please fill reference manually.';
      return false;
    }

    var result = await worker.recognize(file);
    var parsed = parseBankSlip(result.data.text);

    // Auto-isi Bank Transfer Reference No.
    if (parsed.reference) {
      var refInput = document.getElementById('bnwBankTransferRefInput');
      if (refInput) {
        refInput.value = parsed.reference;
        refInput.style.borderColor = 'var(--bnw-success,#2e7d32)';
        setTimeout(function () { refInput.style.borderColor = ''; }, 2000);
      }
    }

    // Banding jumlah resit vs jumlah diisytiharkan (state_payment_amount)
    var declared = parseFloat(state_payment_amount) || 0;
    var amtStatus, amtColor, amtDetail = '';
    if (parsed.amount && parsed.amount > 0 && declared > 0) {
      var diff = Math.abs(parsed.amount - declared);
      var isMatch = diff <= 0.5; // 50 sen tolerance
      if (isMatch) {
        amtStatus = '✓ Amounts match';
        amtColor = 'var(--bnw-success,#2e7d32)';
      } else {
        amtStatus = '⚠ Amount differs by ' + fmt(diff);
        amtColor = 'var(--bnw-error,#c62828)';
        var amtInput = document.getElementById('bnwPayAmountInput');
        if (amtInput) {
          amtInput.style.borderColor = 'var(--bnw-error,#c62828)';
          setTimeout(function () { amtInput.style.borderColor = ''; }, 4000);
        }
      }
      amtDetail = 'Document: ' + fmt(parsed.amount) + ' · Declared: ' + fmt(declared);
    } else if (parsed.amount === null && declared > 0) {
      amtStatus = '✓ Extracted (amount not detected)';
      amtColor = 'var(--bnw-gold,#C9A84C)';
    } else {
      amtStatus = '✓ Receipt read';
      amtColor = 'var(--bnw-success,#2e7d32)';
    }

    // Bina result card
    var html = '<div style="font-weight:600;color:' + amtColor + ';margin-bottom:6px;">' + amtStatus + '</div>';
    if (amtDetail) html += '<div style="color:var(--bnw-text-muted,#6E6A5F);margin-bottom:4px;">' + amtDetail + '</div>';
    if (parsed.reference) html += '<div style="color:var(--bnw-text-muted,#6E6A5F);">Reference: <strong style="color:var(--bnw-text,#1E1C18);">' + parsed.reference + '</strong> → auto-filled</div>';
    if (parsed.date) html += '<div style="color:var(--bnw-text-muted,#6E6A5F);">Date: ' + parsed.date + '</div>';
    if (!parsed.reference && !parsed.date && !parsed.amount) {
      html = '<div style="color:var(--bnw-gold,#C9A84C);">⚠ Could not extract details. Please fill reference manually.</div>';
    }
    if (resultEl) {
      resultEl.innerHTML = html;
      resultEl.style.display = 'block';
    }
    if (statusEl) statusEl.textContent = '';

    return true;
  } catch (e) {
    console.warn('OCR failed:', e);
    if (statusEl) statusEl.textContent = 'OCR failed — please fill reference manually.';
    return false;
  }
}

(document.getElementById("bnwStep3Back") || document.getElementById("step3Back")).addEventListener("click", function() { showStep(2); });

document.getElementById("bnwPayNowBtn").addEventListener("click", async function() {
  if (!validatePay()) {
    alert("Please enter a payment amount between " + fmt(getMinPay()) + " and " + fmt(getMaxPay()) + ".");
    return;
  }
  if (state_payment_method === "Manual Transfer" && !state_receipt_data) {
    alert("Please upload your payment receipt before submitting.");
    return;
  }
  var bankTransferRef = "";
  if (state_payment_method === "Manual Transfer") {
    bankTransferRef = document.getElementById("bnwBankTransferRefInput").value.trim();
    if (!bankTransferRef) {
      alert("Please enter your bank transfer reference number before submitting.");
      return;
    }
  }
  var payment_type = state_payment_method === "Pay Later"
    ? "Deposit"  // amount_paid=0 dihantar terus di bawah — nilai ni tak
                 // ubah kelakuan (deposit_amount = amount_paid bila
                 // amount_paid diberi eksplisit), cuma untuk kejelasan.
    : (state_payment_amount >= getMaxPay() - 0.001 ? "Full Payment" : "Deposit");
  showLoading(state_payment_method === "Manual Transfer" ? "Submitting booking..." :
              state_payment_method === "Pay Later" ? "Confirming your booking..." :
              "Creating your booking...");
  
  try {
    // Hantar PER-CABIN (setiap room = satu cabin) — bukan agregat.
    // Ini kekalkan susunan cabin dalam SO + model SLOT (Main Guest/Extra Bed/Infant).
    var activeSelections = state.rooms
      .filter(function(r) { return r.room_category && (r.main_guests + r.extra_beds + r.infants) > 0; })
      .map(function(r) {
        return {
          room_category: r.room_category,
          main_guests:   r.main_guests,
          extra_beds:    r.extra_beds,
          infants:       r.infants,
        };
      });

    var selectedSalesPersons = state_sales_person_rows
      .map(function(r) { return r.value; })
      .filter(function(v) { return v; });

    var result = await apiCall(
      "travel_booking.api.booking.confirm_booking",
      {
        trip_group_date:      state.trip_group_date,
        trip_package:   state.trip_package,
        selections:     activeSelections,
        billing:        state.billing,
        payment_type:   payment_type,
        amount_paid:    state_payment_amount,
        payment_method: state_payment_method,
        voucher_code:   state_voucher_code,
        affiliate_code: state_affiliate_code,
        receipt:        state_receipt_data || "",
        bank_transfer_ref: bankTransferRef,
        sales_persons:  JSON.stringify(selectedSalesPersons),
      },
      false  // POST
    );

    if (!result) {
      throw new Error("No response from server. Please try again.");
    }

    state.booking = result;

    clearWizardState();

    // Online Payment → redirect ke Stripe checkout
    if (result.payment_url) {
      // SAVE confirmation snapshot sebelum redirect — data ni hilang
      // selepas full-page redirect ke Stripe, jadi kita simpan dalam
      // sessionStorage supaya boleh restore bila user balik ke /booknow
      try {
        var _snapTgd = null;
        if (trip_group_dateS && trip_group_dateS[state.trip_master]) {
          _snapTgd = trip_group_dateS[state.trip_master].find(function(g) {
            return g.name === state.trip_group_date;
          }) || null;
        }
        var _confirmSnapshot = {
          booking_number:  result.booking_number || "",
          trip_name:       state.trip_name || "",
          group_name:      state.group_name || "",
          package_label:   state.package_label || (selectedPackage && selectedPackage.package_type) || "",
          departure_date:  (_snapTgd && _snapTgd.departure_date) || "",
          return_date:     (_snapTgd && _snapTgd.return_date) || "",
          sailing_start:   (_snapTgd && _snapTgd.sailing_start) || "",
          sailing_end:     (_snapTgd && _snapTgd.sailing_end) || "",
          is_cruise_trip:  !!state.is_cruise_trip,
          flight:          (selectedPackage && selectedPackage.flight) || "",
          flight_label:    (selectedPackage && selectedPackage.flight_label) || "",
          grand_total:     result.grand_total || 0,
          advance_paid:    result.advance_paid || 0,
          timestamp:       Date.now()
        };
        sessionStorage.setItem("bnw_confirm_snapshot", JSON.stringify(_confirmSnapshot));
      } catch(_e) { /* silent fail — API will be used as fallback */ }

      showLoading("Redirecting to secure payment...");
      window.location.href = result.payment_url;
      return;
    }

    // Manual Transfer → terus ke halaman confirmation
    showConfirmation(result);
    showStep(4);
  } catch(e) {
    alert("Booking failed. Please try again.\n" + e.message);
  }
  hideLoading();
});

// ─── STEP 4: CONFIRMATION ─────────────────────────────────
function showConfirmation(booking) {
  document.getElementById("bnwConfirmRef").textContent = booking.booking_number;

  var bookingStatus = booking.booking_status || "Accepted";
  renderConfirmStatusBadge(bookingStatus);
  renderConfirmActions(bookingStatus, booking.booking_number);

  // ── Update Step 4 Banner with full trip info ──
  // Same data as Steps 1-3 banners — papar trip details di confirmation
  var bannerName4El = document.getElementById("bnwBannerTripName4");
  if (bannerName4El) bannerName4El.textContent = state.trip_name;

  var bannerSum4El = document.getElementById("bnwBannerSummary4");
  if (bannerSum4El) bannerSum4El.textContent = "Group: " + state.group_name;

  // Departure / Sailing / Depart From dates
  var _selectedTgd4 = null;
  if (trip_group_dateS && trip_group_dateS[state.trip_master]) {
    _selectedTgd4 = trip_group_dateS[state.trip_master].find(function(g) {
      return g.name === state.trip_group_date;
    }) || null;
  }

  var dep4El = document.getElementById("bnwBannerDeparture4");
  if (dep4El && _selectedTgd4 && _selectedTgd4.departure_date && !_isCruiseOnly4) {
    // ✈️ emoji HANYA untuk package dengan flight component
    // Hide for Cruise Only — cruise only packages show Sailing date only
    var _depEmoji4 = _hasFlightComponent4 ? " ✈️ " : "";
    dep4El.textContent = "Departure: " + fmtDate(_selectedTgd4.departure_date) +
      (_selectedTgd4.return_date ? " – " + fmtDate(_selectedTgd4.return_date) : "") + _depEmoji4;
    dep4El.style.display = "";
  } else if (dep4El) { dep4El.style.display = "none"; }

  var departFrom4El = document.getElementById("bnwBannerDepartFrom4");
  var _flightLabel4 = (typeof selectedPackage !== "undefined" && selectedPackage && selectedPackage.flight_label) || "";
  var _pkgType4 = (selectedPackage && selectedPackage.package_type) || "";
  var _isCruiseOnly4 = _pkgType4 === "Cruise Only";
  var _isGroundOnly4 = _pkgType4 === "Ground Only";
  var _hasFlightComponent4 = !_isCruiseOnly4 && !_isGroundOnly4;

  if (departFrom4El) {
    if (_hasFlightComponent4 && _flightLabel4) {
      departFrom4El.textContent = "Departure From: " + _flightLabel4;
      departFrom4El.style.display = "";
    } else {
      departFrom4El.style.display = "none";
    }
  }

  var sail4El = document.getElementById("bnwBannerSailing4");
  if (sail4El && state.is_cruise_trip && _selectedTgd4 && _selectedTgd4.sailing_start) {
    sail4El.textContent = "Sailing: " + fmtDate(_selectedTgd4.sailing_start) + " – " + fmtDate(_selectedTgd4.sailing_end) + " ⛵";
    sail4El.style.display = "";
  } else if (sail4El) { sail4El.style.display = "none"; }

  // Badge (package type)
  var badge4El = document.getElementById("bnwBannerTripType4");
  if (badge4El) badge4El.textContent = state.package_label || "";

  // Fly From note
  var flyFrom4El = document.getElementById("bnwBannerFlyFrom4");
  var _flightCode4 = (typeof selectedPackage !== "undefined" && selectedPackage && selectedPackage.flight) || "";
  if (flyFrom4El) {
    if (_flightCode4 && _hasFlightComponent4) {
      flyFrom4El.textContent = "Fly from " + _flightCode4;
      flyFrom4El.style.display = "";
    } else {
      flyFrom4El.style.display = "none";
    }
  }

  // PENTING: guna calcDiscountedTotal() — function SAMA yang dipakai untuk
  // papar Total di Order Summary & Payment Amount (Step 3). Sebelum ni,
  // fungsi ni kira totalAmt semula dari kosong (calcGrandTotal manual, tanpa
  // voucher/referral), lalu tolak cashback SAHAJA — jadi Total di sini jadi
  // lebih tinggi dari yang customer nampak di Step 3 bila voucher/referral
  // digunakan (kedua-dua tu tak pernah ditolak di sini).
  var totalAmt = calcDiscountedTotal();

  var voucherRowHtml = "";
  if (state_voucher_discount > 0) {
    voucherRowHtml =
      '<div class="bnw-confirm-row"><span>Voucher (' + state_voucher_code + ')</span><strong>-' + fmt(state_voucher_discount) + '</strong></div>';
  }
  var referralRowHtml = "";
  if (state_referral_percent > 0) {
    var afterVoucherAmt = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
    var referralAmt     = afterVoucherAmt * (state_referral_percent / 100);
    referralRowHtml =
      '<div class="bnw-confirm-row"><span>Referral (' + state_referral_percent + '%)</span><strong>-' + fmt(referralAmt) + '</strong></div>';
  }
  var cashbackRowHtml = "";
  if (booking.cashback_percent > 0 && booking.cashback_amount > 0) {
    cashbackRowHtml =
      '<div class="bnw-confirm-row"><span>Cashback (' + booking.cashback_percent + '%)</span><strong>-' + fmt(booking.cashback_amount) + '</strong></div>';
  }

  // Payment Method label untuk confirmation
  var payMethodLabel = state_payment_method || "Online Payment";
  var payAmountDisplay = state_payment_method === "Pay Later"
    ? "Pay later via portal"
    : fmt(state_payment_amount);

  document.getElementById("bnwConfirmDetails").innerHTML =
    '<div class="bnw-confirm-row"><span>Trip</span><strong>' + state.trip_name + '</strong></div>' +
    '<div class="bnw-confirm-row"><span>Departure Group</span><strong>' + state.group_name + '</strong></div>' +
    '<div class="bnw-confirm-row"><span>Payment Method</span><strong>' + payMethodLabel + '</strong></div>' +
    (state_payment_method !== "Pay Later" ? '<div class="bnw-confirm-row"><span>Amount Paid</span><strong>' + payAmountDisplay + '</strong></div>' : '') +
    voucherRowHtml + referralRowHtml + cashbackRowHtml +
    '<div class="bnw-confirm-row"><span>Total</span><strong>' + fmt(totalAmt) + '</strong></div>' +
    '<div class="bnw-confirm-row"><span>Booking Ref</span><strong>' + booking.booking_number + '</strong></div>';

  // Booking baru selalu "Accepted" di titik ini (Manual Transfer — PE masih
  // draft, menunggu admin verify) — portal masih locked, jadi jangan janji
  // "complete traveller details" yang belum boleh dibuat.
  //
  // Pay Later: TIADA bayaran/resit dihantar untuk "disahkan" — mesej
  // "payment verified" tak masuk akal di sini (mengelirukan, seolah-olah
  // ada sesuatu dalam proses semakan). Guna mesej berbeza — arah customer
  // terus ke portal untuk bayar bila-bila mereka nak.
  var confirmMsg = state_payment_method === "Pay Later"
    ? 'Confirmation sent to <strong>' + state.billing.email + '</strong>.<br>' +
      'Log in to your portal anytime to complete payment for this booking.'
    : 'Confirmation sent to <strong>' + state.billing.email + '</strong>.<br>' +
      'We\'ll notify you by email once your payment is verified — traveller details can be completed after that.';
  document.getElementById("bnwConfirmEmail").innerHTML = confirmMsg;
}

// ─── DISPLAY CURRENCY CONVERTER ───────────────────────────
// SEMUA harga dicaj dalam company currency; pilihan currency di sini cuma
// tukar PAPARAN (rate exchange ERPNext for_selling, indicative). fmt()
// baca state.display_rate live, jadi re-render step semasa selepas tukar.
var DISPLAY_CURRENCIES = [];

async function initDisplayCurrency() {
  var sel = document.getElementById("bnwDisplayCurrency");
  if (!sel) return;
  try {
    var list = await apiCall("travel_booking.api.pricing.get_display_currencies", {}, true);
    DISPLAY_CURRENCIES = list || [];
  } catch (e) {
    DISPLAY_CURRENCIES = [];
  }
  sel.innerHTML = "";
  if (!DISPLAY_CURRENCIES.length) {
    // fallback: company currency sahaja (endpoint gagal — jangan pecah wizard)
    var fo = document.createElement("option");
    fo.value = state.company_currency;
    fo.textContent = state.company_currency;
    sel.appendChild(fo);
    sel.disabled = true;
  } else {
    DISPLAY_CURRENCIES.forEach(function(c) {
      var opt = document.createElement("option");
      opt.value = c.code;
      opt.textContent = c.code + " (" + (c.symbol || c.code) + ")" + (c.is_company ? " \u2014 charged" : "");
      sel.appendChild(opt);
    });
  }
  // Default: keutamaan localStorage, lain company currency.
  var saved = null;
  try { saved = localStorage.getItem("bnw_display_currency"); } catch (e) {}
  var def = saved || state.company_currency;
  sel.value = def;
  sel.addEventListener("change", function() {
    setDisplayCurrency(this.value, true);
  });
  setDisplayCurrency(def, false);
}

function lookupCurrencySymbol(code) {
  for (var i = 0; i < DISPLAY_CURRENCIES.length; i++) {
    if (DISPLAY_CURRENCIES[i].code === code) return DISPLAY_CURRENCIES[i].symbol || code;
  }
  return code;
}

async function setDisplayCurrency(code, persist) {
  code = code || state.company_currency;
  state.display_currency = code;
  state.display_symbol = lookupCurrencySymbol(code);
  if (persist) {
    try { localStorage.setItem("bnw_display_currency", code); } catch (e) {}
  }
  if (code === state.company_currency) {
    state.display_rate = null;
    updateCurrencyNote();
    refreshCurrencyDisplay();
    return;
  }
  // Fetch rate company -> display (cached 5 minit di server).
  try {
    var r = await apiCall("travel_booking.api.pricing.get_currency_rate",
      { from_currency: state.company_currency, to_currency: code }, true);
    state.display_rate = (r && r.rate) ? Number(r.rate) : null;
  } catch (e) {
    state.display_rate = null;
  }
  updateCurrencyNote();
  refreshCurrencyDisplay();
}

function updateCurrencyNote() {
  var note = document.getElementById("bnwCurrencyNote");
  if (!note) return;
  var parts = ["Charged in " + state.company_symbol + " (" + state.company_currency + ")"];
  if (state.display_currency && state.display_currency !== state.company_currency) {
    if (state.display_rate) {
      parts.push("1 " + state.company_currency + " = " + state.display_rate + " " + state.display_currency + " (indicative)");
    } else {
      parts.push("Rate unavailable \u2014 showing " + state.company_currency);
    }
  }
  note.textContent = parts.join(" \u00b7 ");
}

// Re-render step semasa supaya fmt() dikira semula dengan rate baharu.
function refreshCurrencyDisplay() {
  try {
    if (state.step === 1) {
      // Step 1: Rooms & Passengers — re-render rooms + update totals
      if (typeof renderRooms === "function") renderRooms();
      if (typeof updateTotals === "function") updateTotals();
    } else if (state.step === 2) {
      // Step 2: Billing Details — rebuild booking summary with new currency
      if (typeof buildBookingSummary === "function") buildBookingSummary();
    } else if (state.step === 3) {
      // Step 3: Payment — rebuild order summary + payment UI
      if (typeof buildOrderSummary === "function") buildOrderSummary();
      if (typeof refreshOrderSummaryTotal === "function") refreshOrderSummaryTotal();
      if (typeof refreshPaySummary === "function") refreshPaySummary();
    }
    // Note: Step 4 (Confirmation) prices are static from booking time,
    // no need to refresh currency display after confirmation
  } catch (e) { /* jangan pecah flow utama */ }
}

// ─── BOOTSTRAP ─────────────────────────────────────────────
// Muat Travel Settings (bank account, cashback %) lebih awal supaya sedia
// bila user sampai ke Step 3 (Payment). Tidak menghalang render page lain.
loadPaymentSettings();
loadSalesPersons();
initDisplayCurrency();

// Auto-fill + auto-apply referral code if the customer arrived via an
// affiliate's shareable link (?ref=CODE). Manual entry via the Apply
// button / Enter key continues to work exactly as before.
prefillAffiliateCodeFromUrl();