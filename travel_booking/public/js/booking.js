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
const _data       = JSON.parse(document.getElementById("pageData").textContent);
const trip_group_dateS    = _data.trip_group_dates;
const TRIP_PACKAGES = _data.trip_packages;
const INIT_TRIP   = _data.trip_master;
const INIT_DATE   = _data.trip_group_date;

// ─── STATE ────────────────────────────────────────────────
const state = {
  step:         0,
  trip_master:  INIT_TRIP,
  trip_group_date:    INIT_DATE,
  trip_package: "",
  trip_name:    "",
  group_name:   "",
  cabins:       [],
  rooms:        [],
  selections:   {},
  billing:      {},
  otp_verified: false,
  booking:      null,
};

// ─── HELPERS ──────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return "";
  var months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
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
  return "RM " + Number(n).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showLoading(msg) {
  document.getElementById("loadingOverlay").style.display = "flex";
  document.getElementById("loadingMsg").textContent = msg || "Processing...";
}

function hideLoading() {
  document.getElementById("loadingOverlay").style.display = "none";
}

function saveState() {
  try {
    if (!state.trip_group_date || !state.trip_package || state.step < 1 || state.step >= 4) return;
    var bn = document.getElementById("billingName");
    var be = document.getElementById("billingEmail");
    var bp = document.getElementById("billingPhone");
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
      rooms:        state.rooms,
      billing:      billing,
      otp_verified: state.otp_verified,
      pay_method:   (typeof state_payment_method !== "undefined") ? state_payment_method : "Online Payment",
      pay_amount:   (typeof state_payment_amount !== "undefined") ? state_payment_amount : 0,
    };
    sessionStorage.setItem("rc_booking_wizard", JSON.stringify(snap));
  } catch (e) {}
}

function clearWizardState() {
  try { sessionStorage.removeItem("rc_booking_wizard"); } catch (e) {}
}

function showStep(n) {
  document.querySelectorAll(".rc-section").forEach(s => s.classList.remove("active"));
  document.getElementById("step" + n).classList.add("active");
  document.querySelectorAll(".rc-wstep").forEach(el => {
    const s   = parseInt(el.dataset.step);
    const num = el.querySelector(".rc-wstep__num");
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
    // POST request — urlencoded. Cookie Frappe sebenar dipanggil
    // 'csrftoken' (bukan 'csrf_token') — kosong untuk guest baru (tiada
    // session lagi), yang selamat sebab endpoint wizard semua allow_guest.
    const match = document.cookie.match(/csrftoken=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : "";
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
  if (!res.ok || data.exc || data.exception) {
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

// ─── STEP 0: TRIP SELECTOR ────────────────────────────────
const tripSelect  = document.getElementById("tripSelect");
const dateGrid    = document.getElementById("dateGrid");
const dateGroup   = document.getElementById("dateGroup");
const tripPreview = document.getElementById("tripPreview");
const step0Next    = document.getElementById("step0Next");
const packageGroup = document.getElementById("packageGroup");
const packageGrid  = document.getElementById("packageGrid");
let selectedGroup   = null;
let selectedPackage = null;

function renderPackages(TripGroupDate) {
  const pkgs = (TRIP_PACKAGES && TRIP_PACKAGES[TripGroupDate]) || [];
  packageGrid.innerHTML = "";
  selectedPackage    = null;
  step0Next.disabled = true;
  if (!pkgs.length) {
    packageGroup.style.display = "none";
    return;
  }
  packageGroup.style.display = "block";
  pkgs.forEach(function(p) {
    var btn = document.createElement("button");
    btn.className    = "rc-date-btn";
    btn.dataset.name = p.name;
    btn.innerHTML = '<span class="rc-date-btn__name"> From: ' + p.flight_label + '</span>';
    btn.addEventListener("click", function() {
      packageGrid.querySelectorAll(".rc-date-btn").forEach(function(b) { b.classList.remove("selected"); });
      this.classList.add("selected");
      selectedPackage    = p;
      step0Next.disabled = false;
    });
    packageGrid.appendChild(btn);
  });
}

tripSelect.addEventListener("change", function() {
  const opt  = this.options[this.selectedIndex];
  const trip = this.value;
  selectedGroup      = null;
  selectedPackage    = null;
  step0Next.disabled = true;
  dateGrid.innerHTML = "";
  packageGroup.style.display = "none";

  if (!trip) {
    tripPreview.style.display = "none";
    dateGroup.style.display   = "none";
    return;
  }

  tripPreview.style.display = "none";

  const groups = trip_group_dateS[trip] || [];
  if (!groups.length) { dateGroup.style.display = "none"; return; }

  dateGroup.style.display = "block";
  groups.forEach(function(g) {
    
    var btn = document.createElement("button");
    btn.className    = "rc-date-btn";
    btn.dataset.name = g.name;

    //detecting Cruise Trip Package
    var a = g.trip_group_name.split(" : ");
    if(a.length == 3){ var cruise = a[2] ; 
      if(cruise == "Tour Trip") { cruise = ""; } else { cruise = " <br/>(" + cruise + ")"; }
    } else { var cruise = ""; }
    
    var durTxt = (g.total_days ? (g.total_days + "D") : "") + (g.total_nights ? (" " + g.total_nights + "N") : "");
    btn.innerHTML    =
      '<span class="rc-date-btn__name">' + fmtDate(g.departure_date) + ' \u2013 ' + fmtDate(g.return_date) + cruise + '</span>' +
      (durTxt ? '<span class="rc-date-btn__dates">' + durTxt + '</span>' : '');    
      btn.addEventListener("click", function() {
      dateGrid.querySelectorAll(".rc-date-btn").forEach(function(b) { b.classList.remove("selected"); });
      this.classList.add("selected");
      selectedGroup = g;
      renderPackages(g.name);
    });

    dateGrid.appendChild(btn);
  });
});

step0Next.addEventListener("click", async function() {
  if (!tripSelect.value || !selectedGroup || !selectedPackage) return;
  state.trip_master  = tripSelect.value;
  state.trip_group_date    = selectedGroup.name;
  state.trip_package = selectedPackage.name;
  state.trip_name    = tripSelect.options[tripSelect.selectedIndex].text;
  state.group_name   = selectedGroup.trip_group_name;
  state.package_label = selectedPackage.package_name;
  await loadCabins();
  showStep(1);
});

function restoreWizard() {
  var raw;
  try { raw = sessionStorage.getItem("rc_booking_wizard"); } catch (e) { return false; }
  if (!raw) return false;
  var snap;
  try { snap = JSON.parse(raw); } catch (e) { return false; }
  if (!snap || !snap.trip_group_date || !snap.trip_package || !snap.step || snap.step < 1) return false;

  state.trip_master  = snap.trip_master || "";
  state.trip_group_date    = snap.trip_group_date;
  state.trip_package = snap.trip_package;
  state.trip_name    = snap.trip_name || "";
  state.group_name   = snap.group_name || "";
  state.package_label = snap.package_label || "";
  if (snap.billing) state.billing = snap.billing;
  state.otp_verified = !!snap.otp_verified;
  if (tripSelect) {
    tripSelect.value = snap.trip_master || "";
    tripSelect.dispatchEvent(new Event("change"));
    var _d = dateGrid.querySelector('[data-name="' + snap.trip_group_date + '"]');
    if (_d) _d.click();
    var _p = packageGrid ? packageGrid.querySelector('[data-name="' + snap.trip_package + '"]') : null;
    if (_p) _p.click();
  }

  loadCabins().then(function() {
    if (snap.rooms && snap.rooms.length) {
      // Safety: sesi lama (sebelum patch model SLOT) mungkin simpan struktur
      // room lama (adults/children/toddlers) — kesan dan abaikan supaya
      // tidak crash renderRooms()/priceRoomSelection() dengan field undefined.
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
      var bn = document.getElementById("billingName");   if (bn) bn.value = snap.billing.full_name || "";
      var be = document.getElementById("billingEmail");  if (be) be.value = snap.billing.email || "";
      if (snap.billing.phone) {
        if (_itiBillingPhone) _itiBillingPhone.setNumber(snap.billing.phone);
        else { var bp = document.getElementById("billingPhone"); if (bp) bp.value = snap.billing.phone; }
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
    if (target >= 2 && typeof checkStep2Ready === "function") checkStep2Ready();
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
  var el = document.getElementById("confirmStatusBadge");
  if (!el) return;
  var b = STATUS_BADGE_MAP[bookingStatus];
  if (!b) { el.innerHTML = ""; return; }
  el.innerHTML =
    '<span style="display:inline-block;font-size:12px;font-weight:700;padding:5px 16px;' +
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
  var el = document.getElementById("confirmActions");
  if (!el) return;

  el.innerHTML =
    '<a href="/traveller_portal" class="rc-btn rc-btn--primary">View Booking <i class="ti ti-arrow-right"></i></a>' +
    '<button type="button" class="rc-btn rc-btn--ghost" onclick="startNewBooking()">New Booking</button>';
}

// "New Booking" — kosongkan snapshot wizard (elak restoreWizard() tarik
// balik data booking yang BARU sahaja siap) dan reload page /booking
// bersih. Full page reload (bukan reset manual puluhan state variable
// satu-satu) — cara paling selamat untuk pastikan SEMUA state (rooms,
// billing, payment amount, voucher/referral, dsb) betul-betul kosong
// untuk booking baharu, tiada risiko baki data lama tercicir.
function startNewBooking() {
  clearWizardState();
  window.location.href = "/booking";
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

  var bookingNumber = params.get("ref");
  var prName        = params.get("pr");
  if (!bookingNumber) return false;

  showLoading("Confirming your payment...");
  pollWizardConfirmation(bookingNumber, prName, 0);
  return true;
}

// Webhook Stripe berjalan server-to-server & mungkin ambil beberapa saat
// untuk sampai + proses selepas customer redirect balik ke sini. Poll
// beberapa kali (bukan sekali) supaya kita tak papar status "Pending" yang
// sebenarnya dah "Confirmed" tapi webhook belum sempat catch up.
function pollWizardConfirmation(bookingNumber, prName, attempt) {
  var MAX_ATTEMPTS = 6;   // ~18 saat kalau semua attempt guna delay penuh
  var DELAY_MS     = 3000;

  apiCall(
    "travel_booking.api.booking.get_wizard_confirmation",
    { booking_number: bookingNumber, pr: prName || "" },
    true // GET
  ).then(function(result) {
    if (!result || result.exc) {
      renderStripeReturnConfirmation(bookingNumber, null);
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

    renderStripeReturnConfirmation(bookingNumber, result, isSettled);
  }).catch(function() {
    renderStripeReturnConfirmation(bookingNumber, null);
  });
}

// Papar Step 4 khusus untuk kembali dari Stripe — TIDAK guna showConfirmation()
// standard sebab ia rujuk state.billing.email / state.selections yang mungkin
// kosong selepas full-page redirect (wizard state client-side hilang konteks).
// Semua maklumat di sini datang dari backend (get_wizard_confirmation), bukan
// dari state client yang tak boleh dipercayai selepas redirect luar.
function renderStripeReturnConfirmation(bookingNumber, result, isSettled) {
  hideLoading();
  document.getElementById("confirmRef").textContent = bookingNumber;

  var bookingStatus = result ? (result.booking_status || "") : "";
  renderConfirmStatusBadge(bookingStatus);
  renderConfirmActions(bookingStatus, bookingNumber);

  if (result) {
    var amountPaidRow = "";
    if (result.payment_status === "Partially Paid") {
      amountPaidRow =
        '<div class="rc-confirm-row"><span>Amount Paid</span><strong style="color:#166534">' +
        fmt(result.advance_paid || 0) + '</strong></div>';
    }
    var paymentStatusRow = "";
    if (result.payment_status && bookingStatus !== "Accepted") {
      paymentStatusRow =
        '<div class="rc-confirm-row"><span>Payment Status</span><strong>' + result.payment_status + '</strong></div>';
    }

    document.getElementById("confirmDetails").innerHTML =
      '<div class="rc-confirm-row"><span>Trip</span><strong>' + (result.trip_name || "") + '</strong></div>' +
      '<div class="rc-confirm-row"><span>Departure</span><strong>' + (result.group_name || "") + '</strong></div>' +
      '<div class="rc-confirm-row"><span>Total</span><strong>' + fmt(result.grand_total || 0) + '</strong></div>' +
      amountPaidRow + paymentStatusRow +
      '<div class="rc-confirm-row"><span>Booking Ref</span><strong>' + bookingNumber + '</strong></div>';
  } else {
    document.getElementById("confirmDetails").innerHTML =
      '<div class="rc-confirm-row"><span>Booking Ref</span><strong>' + bookingNumber + '</strong></div>';
  }

  if (isSettled === false) {
    document.getElementById("confirmEmail").innerHTML =
      'Your payment is being confirmed. This can take up to a minute — ' +
      'you will receive an email confirmation shortly. No need to pay again.';
  } else {
    // Traveller details boleh diisi bila-bila masa (kunci dah dibuang) —
    // mesej sama untuk semua status lepas payment settled (Accepted ke atas).
    document.getElementById("confirmEmail").innerHTML =
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
    console.warn("intl-tel-input tidak dimuatkan; billingPhone jatuh balik ke <input> biasa.");
    return;
  }
  var el = document.getElementById("billingPhone");
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
  var el = document.getElementById("billingPhone");
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
// lepas ni (dateGrid tetap papar semua tarikh sah untuk Trip tu).
//
// Data (TRIP_PACKAGES, trip_group_dateS) SUDAH dimuatkan penuh di
// client-side (JSON dari server, rujuk _data di atas) — tiada perlu
// panggilan API tambahan untuk resolve ni.
function resolvePackageDeepLink(packageId) {
  if (!packageId) return null;

  var candidates = []; // { groupDateName, tripName, departureDate }

  Object.keys(TRIP_PACKAGES).forEach(function(groupDateName) {
    var pkgs  = TRIP_PACKAGES[groupDateName] || [];
    var found = pkgs.some(function(p) { return p.name === packageId; });
    if (!found) return;

    Object.keys(trip_group_dateS).forEach(function(tripName) {
      var dates = trip_group_dateS[tripName] || [];
      var match = dates.find(function(d) { return d.name === groupDateName; });
      if (match) {
        candidates.push({
          groupDateName: groupDateName,
          tripName:      tripName,
          departureDate: match.departure_date || ""
        });
      }
    });
  });

  if (!candidates.length) return null;  // package tak wujud/tak aktif

  var today    = new Date().toISOString().slice(0, 10);
  var upcoming = candidates.filter(function(c) { return c.departureDate >= today; });
  var pool     = upcoming.length ? upcoming : candidates;

  pool.sort(function(a, b) { return a.departureDate.localeCompare(b.departureDate); });

  var chosen = pool[0];
  return { tripName: chosen.tripName, groupDateName: chosen.groupDateName, packageId: packageId };
}

// ─── DEEP LINK: ?date=GROUP_DATE_ID (jump ke sailing tertentu) ──
// Berbeza dengan resolvePackageDeepLink() (many-to-many, perlu teka),
// hubungan Trip Group Date -> Trip TAK ambiguous — satu Group Date
// SENTIASA milik SATU Trip sahaja (parent-child straightforward). Jadi
// bagi satu Group Date ID, Trip dia boleh derive dengan yakin 100%,
// tiada keperluan "teka sailing terawal" macam resolvePackageDeepLink().
//
// Guna kes: campaign yang promote SAILING/TARIKH tertentu (cth "Book the
// August Sailing"), tanpa peduli jenis cabin/package — customer landing
// terus di step pilih package sendiri, dengan Trip + Date dah auto-terisi.
//
// NOTA PENAMAAN: guna 'date' (bukan 'trip_master'/'trip') sengaja — 'trip'
// dah dipakai untuk deep link Package ID (resolvePackageDeepLink), dan
// 'trip_master' dikekalkan untuk mekanisme LAMA 2-parameter (backward
// compat). Guna nama sama untuk maksud berbeza akan cetus konflik (rujuk
// bug serupa yang pernah kita fix untuk parameter '?ref=').
function resolveDateDeepLink(groupDateId) {
  if (!groupDateId) return null;

  var tripName = null;
  Object.keys(trip_group_dateS).forEach(function(t) {
    var dates = trip_group_dateS[t] || [];
    var match = dates.some(function(d) { return d.name === groupDateId; });
    if (match) tripName = t;
  });

  if (!tripName) return null;  // Group Date tak wujud/tak aktif
  return { tripName: tripName, groupDateName: groupDateId };
}

// ─── DEEP LINK: ?trip=PACKAGE_ID&date=GROUP_DATE_ID (GABUNGAN, spesifik 100%) ──
// Bila KEDUA-DUA parameter dihantar SEKALI, kita boleh elak "teka" sailing
// terawal sepenuhnya (yang resolvePackageDeepLink() terpaksa buat bila
// package tu valid untuk banyak Group Date) — sebab customer/marketer
// dah nyatakan SENDIRI kombinasi Package + Group Date yang tepat.
//
// Kita tetap SAHKAN dulu (validate) yang Package ni memang valid untuk
// Group Date yang diberi — pautan luar boleh sengaja/tak sengaja hantar
// kombinasi yang tak wujud (cth package dan tarikh dari trip berlainan).
// Kalau tak sah, pulangkan null — caller (di bawah) akan fallback ke
// resolvePackageDeepLink() (teka ikut package sahaja) sebagai langkah
// selamat, bukan terus gagal/kosongkan wizard.
function resolveExactDeepLink(packageId, groupDateId) {
  if (!packageId || !groupDateId) return null;

  var pkgs  = TRIP_PACKAGES[groupDateId] || [];
  var valid = pkgs.some(function(p) { return p.name === packageId; });
  if (!valid) return null;  // kombinasi TAK SAH — package ni bukan untuk date ni

  var tripName = null;
  Object.keys(trip_group_dateS).forEach(function(t) {
    var dates = trip_group_dateS[t] || [];
    if (dates.some(function(d) { return d.name === groupDateId; })) tripName = t;
  });
  if (!tripName) return null;

  return { tripName: tripName, groupDateName: groupDateId, packageId: packageId };
}

var _stripeReturn = checkStripeReturn();
var _restored = _stripeReturn ? true : restoreWizard();
window.addEventListener("beforeunload", saveState);

if (!_restored) {
  var _urlParamsDeepLink = new URLSearchParams(window.location.search);
  var _deepPackageId     = _urlParamsDeepLink.get("trip");
  var _deepDateId        = _urlParamsDeepLink.get("date");

  // Urutan priority (paling spesifik dahulu):
  //   1. trip + date SEKALI, kombinasi SAH -> tiada teka langsung
  //   2. trip sahaja -> teka sailing terawal (resolvePackageDeepLink)
  //   3. date sahaja -> auto Trip+Date, Package customer pilih sendiri
  //   4. mekanisme LAMA 2-parameter (trip_master/trip_group_date)
  var _resolvedExact     = (_deepPackageId && _deepDateId) ? resolveExactDeepLink(_deepPackageId, _deepDateId) : null;
  var _resolvedDeepLink  = _resolvedExact ? null : (_deepPackageId ? resolvePackageDeepLink(_deepPackageId) : null);
  var _resolvedDateLink  = (!_resolvedExact && !_resolvedDeepLink && _deepDateId) ? resolveDateDeepLink(_deepDateId) : null;
  var _finalPackageLink  = _resolvedExact || _resolvedDeepLink;

  if (_finalPackageLink) {
    // Trip + Group Date + Package ketiga-tiga auto-pilih — sama ada
    // dari kombinasi SAH tepat (_resolvedExact) atau teka (_resolvedDeepLink).
    tripSelect.value = _finalPackageLink.tripName;
    tripSelect.dispatchEvent(new Event("change"));
    setTimeout(function() {
      var dateBtn = dateGrid.querySelector('[data-name="' + _finalPackageLink.groupDateName + '"]');
      if (dateBtn) dateBtn.click();
      setTimeout(function() {
        var pkgBtn = packageGrid.querySelector('[data-name="' + _finalPackageLink.packageId + '"]');
        if (pkgBtn) pkgBtn.click();
      }, 100);
    }, 100);
  } else if (_resolvedDateLink) {
    // Deep link Date (?date=) — auto-pilih Trip + Group Date, TAK
    // auto-pilih Package (customer pilih sendiri jenis cabin).
    tripSelect.value = _resolvedDateLink.tripName;
    tripSelect.dispatchEvent(new Event("change"));
    setTimeout(function() {
      var dateBtn = dateGrid.querySelector('[data-name="' + _resolvedDateLink.groupDateName + '"]');
      if (dateBtn) dateBtn.click();
    }, 100);
  } else if (INIT_TRIP && INIT_DATE) {
    // Mekanisme LAMA (2 parameter: ?trip_master=&trip_group_date=) —
    // dikekalkan untuk pautan/bookmark sedia ada yang mungkin dah wujud
    // di luar sana. Tak auto-pilih Package (customer pilih sendiri).
    tripSelect.value = INIT_TRIP;
    tripSelect.dispatchEvent(new Event("change"));
    setTimeout(function() {
      var btn = dateGrid.querySelector('[data-name="' + INIT_DATE + '"]');
      if (btn) btn.click();
    }, 100);
  }
}

// ─── STEP 1: ROOMS & PAX ──────────────────────────────────
var roomSeq = 0;

async function loadCabins() {
  showLoading("Loading room options...");
  try {
    const data = await apiCall(
      "travel_booking.api.booking.get_booking_details",
      { trip_group_date: state.trip_group_date, trip_package: state.trip_package },
      true  // GET
    );

    state.cabins = data.cabins;
    state.rooms  = [];

    document.getElementById("bannerTripName").textContent  = data.trip.trip_name;
    document.getElementById("bannerGroupName").textContent = data.trip_group_date.trip_group_name;
    // document.getElementById("bannerGroupName").textContent = data.trip_group_date.trip_group_name;
    document.getElementById("bannerTripType").textContent  = (selectedPackage && selectedPackage.package_type) || "";
    document.getElementById("bannerTripName2").textContent = data.trip.trip_name;

    initRooms();
  } catch(e) {
    alert("Failed to load cabin data. Please try again.\n" + e.message);
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
function priceRoomSelection(pricing, mainGuests, extraBeds, infants) {
  var mg  = Number(mainGuests) || 0;
  var eb   = Number(extraBeds)  || 0;
  var inf  = Number(infants)    || 0;
  var total = 0;

  if (mg === 1) {
    total += Number(pricing.price_adult_single || 0);
  } else if (mg >= 2) {
    total += Number(pricing.price_adult || 0) * mg;
  }
  total += Number(pricing.price_upperberth || 0) * eb;
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
    alert("Maksimum " + MAX_CABINS_PER_BOOKING + " cabin dibenarkan untuk satu booking. Sila hubungi kami terus untuk tempahan lebih besar.");
    return;
  }
  // Collapse cabin sedia ada supaya customer fokus isi cabin baharu.
  state.rooms.forEach(function(r) { r.open = false; });
  state.rooms.push({
    uid:          ++roomSeq,
    room_category: "",
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
  var list  = document.getElementById("roomList");
  list.innerHTML = "";
  var avail = availableCabins();

  state.rooms.forEach(function(room, idx) {
    var card = document.createElement("div");
    card.className = "rc-room";
    var isOpen = room.open !== false; // default terbuka kalau belum ditetapkan

    // Head: chevron + title (+ ringkasan bila collapsed) + remove.
    // Klik mana-mana bahagian head (kecuali butang Remove) toggle collapse.
    var head = document.createElement("div");
    head.className = "rc-room__head";
    head.addEventListener("click", function(e) {
      if (e.target.closest(".rc-room__remove")) return;
      room.open = !isOpen;
      renderRooms();
    });

    var headLeft = document.createElement("div");
    headLeft.className = "rc-room__head-left";

    var chev = document.createElement("i");
    chev.className = "ti ti-chevron-down rc-room__chev" + (isOpen ? " rc-room__chev--open" : "");
    headLeft.appendChild(chev);

    var title = document.createElement("span");
    title.className = "rc-room__title";
    title.textContent = "Cabin " + (idx + 1);
    headLeft.appendChild(title);

    var c = cabinByCategory(room.room_category);
    if (!isOpen) {
      var pax      = room.main_guests + room.extra_beds + room.infants;
      var subtotal = c ? priceRoomSelection(c.pricing, room.main_guests, room.extra_beds, room.infants) : 0;
      var summary  = document.createElement("span");
      summary.className = "rc-room__summary";
      summary.textContent = "\u00b7 " + (room.room_category || "No cabin selected") + " \u00b7 " + pax + " pax \u00b7 " + fmt(subtotal);
      headLeft.appendChild(summary);
    }
    head.appendChild(headLeft);

    var rm = document.createElement("button");
    rm.className = "rc-room__remove";
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", function(e) { e.stopPropagation(); removeRoom(room.uid); });
    head.appendChild(rm);

    card.appendChild(head);

    if (isOpen) {
      // Room Type dropdown
      var typeField = document.createElement("div");
      typeField.className = "rc-field";
      var typeLbl = document.createElement("label");
      typeLbl.className = "rc-field__label";
      typeLbl.textContent = "Cabin Type";
      var selWrap = document.createElement("div");
      selWrap.className = "rc-select-wrapper";
      var sel = document.createElement("select");
      sel.className = "rc-select";
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "\u2014 Select cabin type \u2014";
      if (!room.room_category) ph.selected = true;
      sel.appendChild(ph);
      avail.forEach(function(cab) {
        var opt = document.createElement("option");
        opt.value = cab.room_category;
        var rangeLabel = (cab.capacity === cab.max_capacity)
          ? cab.capacity + " Pax"
          : cab.capacity + "-" + cab.max_capacity + " Pax";
        opt.textContent = cab.room_category + " (" + rangeLabel + ")";
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
      typeChev.className = "ti ti-chevron-down";
      selWrap.appendChild(sel);
      selWrap.appendChild(typeChev);
      typeField.appendChild(typeLbl);
      typeField.appendChild(selWrap);

      // Vertical counter list: Main Guest / Extra Bed / Infant. Had setiap
      // counter dikira SEMULA secara dinamik dalam mkStepper()'s capFor()
      // (Extra Bed & Infant kini berkongsi baki capacity yang sama), jadi
      // parameter 'max' di sini cuma placeholder — nilai sebenar diambil
      // terus dari cabinByCategory() semasa setiap render.
      var capacity = c ? (c.capacity || 0) : 0;
      var pricing  = c ? c.pricing : {};

      var counters = document.createElement("div");
      counters.className = "rc-counter-list";

      // Extra Bed & Infant berkongsi kapasiti (capFor() masing-masing
      // bergantung pada nilai counter SATU LAGI — rujuk capFor() dalam
      // mkStepper()) — array ni kumpul refreshButtons() SETIAP stepper
      // untuk room ni, supaya bila SALAH SATU counter berubah, kita boleh
      // refresh SEMUA stepper (bukan cuma yang diklik). Sebelum ni, setiap
      // stepper cuma refresh dirinya sendiri — punca bug: butang "+" Extra
      // Bed kekal disabled selepas Infant dikurangkan (walhal kapasiti dah
      // terbuka semula), sebab tiada apa trigger refresh Extra Bed punya
      // capFor() semula bila Infant yang berubah.
      var stepperRefreshers = [];

      counters.appendChild(mkStepper(room, "main_guests", "Main Guest", capacity, function() {
        return room.main_guests === 1
          ? fmt(pricing.price_adult_single) + " /pax"
          : fmt(pricing.price_adult) + " /pax";
      }, stepperRefreshers));
      counters.appendChild(mkStepper(room, "extra_beds", "Extra Bed", 0, function() {
        return fmt(pricing.price_upperberth) + " /pax";
      }, stepperRefreshers));
      counters.appendChild(mkStepper(room, "infants", "Infant", 0, function() {
        return fmt(pricing.price_infant) + " /pax";
      }, stepperRefreshers));

      card.appendChild(typeField);
      card.appendChild(counters);
    }

    list.appendChild(card);
  });

  // Disable "Add another room" secara VISUAL bila dah cecah had maksimum
  // — elak customer klik berulang tanpa tahu kenapa tak jadi apa-apa
  // (sebelum ni cuma block senyap dalam addRoom(), tiada isyarat visual).
  var addRoomBtnEl = document.getElementById("addRoomBtn");
  if (addRoomBtnEl) {
    var atMax = state.rooms.length >= MAX_CABINS_PER_BOOKING;
    addRoomBtnEl.disabled = atMax;
    addRoomBtnEl.title    = atMax
      ? "Maksimum " + MAX_CABINS_PER_BOOKING + " cabin setiap booking"
      : "";
  }

  updateTotals();
}

function mkStepper(room, key, label, max, rateFn, refreshers) {
  // ------------------------------------------
  var row = document.createElement("div");
  row.className = "rc-counter-row";
  // ------------------------------------------
  var lbl = document.createElement("span");
  lbl.className = "rc-counter-row__label";
  lbl.textContent = label;
  // ------------------------------------------
  var stepper = document.createElement("div");
  stepper.className = "rc-stepper";
  // ------------------------------------------
  var minus = document.createElement("button");
  minus.className = "rc-stepper__btn";
  minus.type = "button";
  minus.textContent = "\u2212";
  // ------------------------------------------
  var val = document.createElement("span");
  val.className = "rc-stepper__val";
  val.textContent = room[key];
  // ------------------------------------------
  var plus = document.createElement("button");
  plus.className = "rc-stepper__btn";
  plus.type = "button";
  plus.textContent = "+";
  // ------------------------------------------
  var rate = document.createElement("span");
  rate.className = "rc-counter-row__rate";
  // ------------------------------------------
  function capFor() {

    var c = cabinByCategory(room.room_category);
    var capacity    = c ? (c.capacity || 0) : 0;
    var maxCapacity = c ? (c.max_capacity || capacity) : 0;

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
      return Math.min(capacity, maxCapacity - room.extra_beds - room.infants);
    }

    if (key === "extra_beds") {
      // Extra Bed: perlu Main Guest sudah penuh (= capacity). Infant kini
      // turut dikira dalam capacity bilik — Extra Bed & Infant berkongsi
      // baki ruang yang sama (max_capacity - main_guests - infants).
      if (room.main_guests !== capacity) return 0;
      return Math.max(0, maxCapacity - room.main_guests - room.infants);
    }

    if (key === "infants") {
      // Infant: enable bila Main Guest sekurang-kurangnya 1 (bukan 2 lagi).
      // Infant dikira dalam capacity bilik — berkongsi baki ruang dengan
      // Extra Bed (max_capacity - main_guests - extra_beds).
      if (room.main_guests < 1) return 0;
      return Math.max(0, maxCapacity - room.main_guests - room.extra_beds);
    }

    return 0;
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
    plus.disabled  = room[key] >= capFor();
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

    room[key] = Math.min(capFor(), room[key] + 1);

    if (key === "main_guests") {
      renderRooms();
      return;
    }

    val.textContent = room[key];
    refreshAll();
    updateTotals();
  });

  stepper.appendChild(minus);
  stepper.appendChild(val);
  stepper.appendChild(plus);
  stepper.appendChild(rate);

  row.appendChild(lbl);
  row.appendChild(stepper);
  
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
  document.getElementById("totalsGrand").textContent    = fmt(amt);
  document.getElementById("totalsDeposit").textContent  = fmt(Math.round(amt * (state_payment_settings.default_deposit_percent / 100) * 100) / 100);
  document.getElementById("step1Next").disabled = pax === 0;
  buildStep1Summary();
}

// Kad "Payment Summary" di Step 1 (Rooms & Passengers) — live-sync setiap
// kali kaunter Main Guest/Extra Bed/Infant berubah. Format sama dengan
// buildOrderSummary() (Step 4), guna Cabin Fare + senarai Guest N: [label].
// NOTA: Total keseluruhan TIDAK dipaparkan di sini lagi — cuma SATU Total
// (di bawah grid, dalam #totalsBox) untuk elak nilai berulang.
function buildStep1Summary() {
  var lines    = document.getElementById("step1OrderLines");
  var guestsEl = document.getElementById("step1TotalGuests");
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
    var infantRate = Number(p.price_infant || 0);
    for (var k = 0; k < r.infants; k++) {
      cabinFare += infantRate;
      guestLines.push(["Guest " + guestNo + ": Infant", infantRate]);
      guestNo++;
    }

    lines.innerHTML +=
      '<div class="rc-order-cabin">' +
        '<div class="rc-order-cabin__title">' + c.room_category + ' (' + (idx + 1) + ')</div>' +
        '<div class="rc-order-line rc-order-line--fare"><span>Cabin Fare:</span><span>' + fmt(cabinFare) + '</span></div>' +
        guestLines.map(function(g) {
          return '<div class="rc-order-line rc-order-line--guest"><span>' + g[0] + '</span><span>' + fmt(g[1]) + '</span></div>';
        }).join("") +
      '</div>';
  });

  var totalPax = activeRooms.reduce(function(a, r) { return a + r.main_guests + r.extra_beds + r.infants; }, 0);
  if (guestsEl) guestsEl.textContent = totalPax;

  if (!activeRooms.length) {
    lines.innerHTML = '<div class="rc-order-line rc-order-line--muted"><span>Add a main guest to begin</span></div>';
  }
}

document.getElementById("addRoomBtn").addEventListener("click", addRoom);
document.getElementById("step1Back").addEventListener("click", function() { showStep(0); });

document.getElementById("step1Next").addEventListener("click", function() {
  aggregateSelections();
  var active = Object.values(state.selections).filter(function(s) { return s.main_guests + s.extra_beds + s.infants > 0; });
  if (!active.length) return;
  showStep(2);
});

// ─── STEP 2: BILLING + OTP ────────────────────────────────
document.getElementById("step2Back").addEventListener("click", function() { showStep(1); });

var emailInput   = document.getElementById("billingEmail");
var emailStatus  = document.getElementById("emailStatus");
var otpInline    = document.getElementById("otpInline");
var otpInput     = document.getElementById("otpInput");
var step2NextBtn = document.getElementById("step2Next");

function setEmailStatus(type, msg) {
  emailStatus.className = "rc-email-status rc-email-status--" + type;
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

// Reset SERTA-MERTA bila email field diedit — elak state.otp_verified
// (dari email SEBELUM ni yang mungkin verified) kekal sah untuk kandungan
// email BAHARU yang belum pernah disahkan langsung. Tanpa ni, ada tingkap
// masa (dari customer mula taip sehingga blur+async check selesai) di
// mana butang "Continue" kekal enabled berdasarkan status email LAMA —
// isu keselamatan sebenar (customer boleh proceed dengan email tak
// disahkan asalkan mereka pernah taip email lain yang verified dulu).
emailInput.addEventListener("input", function() {
  state.otp_verified      = false;
  otpInline.style.display = "none";
  setEmailStatus("", "");
  checkStep2Ready();
});

// Auto-check email bila keluar dari field
emailInput.addEventListener("blur", async function() {
  var email = this.value.trim();
  if (!email || !email.includes("@")) return;

  setEmailStatus("loading", '<i class="ti ti-loader-2 rc-spin"></i> Checking...');

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
      var nameInput = document.getElementById("billingName");
      if (result.full_name && nameInput) {
        nameInput.value    = result.full_name.toUpperCase();
        nameInput.readOnly = true;
      }
      if (result.phone) {
        if (_itiBillingPhone) {
          _itiBillingPhone.setNumber(result.phone);
        } else {
          var phoneInputEl = document.getElementById("billingPhone");
          if (phoneInputEl) phoneInputEl.value = result.phone;
        }
        var phoneInput = document.getElementById("billingPhone");
        if (phoneInput) phoneInput.readOnly = true;
      }
      checkStep2Ready();
    } else {
      // Email baru — tunjuk OTP field
      state.otp_verified      = false;
      otpInline.style.display = "block";
      document.getElementById("otpNoticeText").textContent =
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

// Auto verify bila 6 digit OTP diisi
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
      '<div class="rc-notice rc-notice--success">' +
        '<i class="ti ti-circle-check"></i>' +
        '<span>Email verified successfully!</span>' +
      '</div>';
    lockEmailField();
    setEmailStatus("verified", '<i class="ti ti-circle-check"></i> Verified');
    checkStep2Ready();
  } catch(e) {
    this.value = "";
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> Invalid OTP');
    document.getElementById("otpNoticeText").textContent = "Invalid OTP. Please try again or resend.";
  }
  hideLoading();
});

document.getElementById("resendOtp").addEventListener("click", async function() {
  showLoading("Resending OTP...");
  try {
    await apiCall(
      "travel_booking.api.booking.send_otp",
      { email: emailInput.value.trim() },
      false  // POST — sama sebab macam blur handler di atas
    );
    setEmailStatus("pending", '<i class="ti ti-mail"></i> OTP resent');
    document.getElementById("otpNoticeText").textContent =
      "A new code has been sent to " + emailInput.value.trim();
  } catch(e) {
    setEmailStatus("error", '<i class="ti ti-alert-circle"></i> Failed to resend');
    document.getElementById("otpNoticeText").textContent =
      (e && e.message) ? e.message : "Failed to resend OTP. Please try again.";
  }
  hideLoading();
});

function checkStep2Ready() {
  var name  = document.getElementById("billingName").value.trim();
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
document.getElementById("billingName").addEventListener("input", function() {
  var start = this.selectionStart;
  var end   = this.selectionEnd;
  this.value = this.value.toUpperCase();
  this.setSelectionRange(start, end);
});

["billingName", "billingPhone"].forEach(function(id) {
  document.getElementById(id).addEventListener("input", checkStep2Ready);
});

document.getElementById("step2Next").addEventListener("click", function() {
  var phone = _getBillingPhoneFull();
  // Validate SEBELUM proceed — sama ketat dengan library Python
  // 'phonenumbers' yang Frappe check server-side, elak customer sampai
  // ke Step 3/pembayaran dengan nombor telefon yang tak sah.
  if (typeof libphonenumber === "undefined" || !libphonenumber.isValidPhoneNumber(phone)) {
    alert('Phone number "' + phone + '" does not look like a valid number. Please check the country code and number.');
    return;
  }
  state.billing = {
    full_name: document.getElementById("billingName").value.trim(),
    email:     emailInput.value.trim(),
    phone:     phone,
  };
  buildOrderSummary();
  showStep(3);
});

function buildOrderSummary() {
  var lines   = document.getElementById("orderLines");
  var totalEl = document.getElementById("orderGrandTotal");
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

    if (r.main_guests === 1) {
      var singleRate = Number(p.price_adult_single || 0);
      cabinFare += singleRate;
      guestLines.push(["Guest " + guestNo + " \u00b7 Main Guest", singleRate]);
      guestNo++;
    } else if (r.main_guests >= 2) {
      var twinRate = Number(p.price_adult || 0);
      for (var i = 0; i < r.main_guests; i++) {
        cabinFare += twinRate;
        guestLines.push(["Guest " + guestNo + " \u00b7 Main Guest", twinRate]);
        guestNo++;
      }
    }
    var upperRate = Number(p.price_upperberth || 0);
    for (var j = 0; j < r.extra_beds; j++) {
      cabinFare += upperRate;
      guestLines.push(["Guest " + guestNo + " \u00b7 Extra Bed", upperRate]);
      guestNo++;
    }
    var infantRate = Number(p.price_infant || 0);
    for (var k = 0; k < r.infants; k++) {
      cabinFare += infantRate;
      guestLines.push(["Guest " + guestNo + " \u00b7 Infant", infantRate]);
      guestNo++;
    }

    grand += cabinFare;

    lines.innerHTML +=
      '<div class="rc-order-cabin">' +
        '<div class="rc-order-cabin__title">' + c.room_category + ' (' + (idx + 1) + ')</div>' +
        '<div class="rc-order-line rc-order-line--fare"><span>Cabin Fare</span><span>' + fmt(cabinFare) + '</span></div>' +
        '<div class="rc-order-cabin__guests">' +
          guestLines.map(function(g) {
            return '<div class="rc-order-guest-line"><span>' + g[0] + '</span><span>' + fmt(g[1]) + '</span></div>';
          }).join("") +
        '</div>' +
      '</div>';
  });

  totalEl.textContent = fmt(grand);

  var totalPax = activeRooms.reduce(function(a, r) { return a + r.main_guests + r.extra_beds + r.infants; }, 0);

  // Maklumat trip (Trip / Trip Group Date / Trip Package) — sentiasa
  // kelihatan (walaupun collapsed) supaya customer tahu dia bayar untuk
  // trip yang mana, sebab kad ni jauh dari banner navy di Step 1/2.
  var tripEl = document.getElementById("orderSummaryTrip");
  if (tripEl) {
    var tripParts = [state.trip_name, state.group_name, state.package_label].filter(Boolean);
    tripEl.textContent = tripParts.join(" \u00b7 ");
  }

  // Ringkasan untuk header (bila collapsed) — cth "Balcony cabin \u00b7 2 guests"
  var subEl = document.getElementById("orderSummarySub");
  if (subEl) {
    var uniqueCabins = [];
    activeRooms.forEach(function(r) {
      if (uniqueCabins.indexOf(r.room_category) === -1) uniqueCabins.push(r.room_category);
    });
    subEl.textContent = (uniqueCabins.join(", ") || "No cabin selected") +
      " \u00b7 " + totalPax + " guest" + (totalPax === 1 ? "" : "s");
  }

  updatePaymentUI();
  document.getElementById("bannerSummary2").textContent =
    activeRooms.length + " cabin(s) \u00b7 " + totalPax + " pax \u00b7 " + fmt(grand);
}

// Kemaskini "Total" dalam Order Summary supaya konsisten dengan calcDiscountedTotal()
// (nilai sebenar yang dipakai untuk kira bayaran) — dipanggil bila voucher/referral
// diguna atau bila payment method ditukar (kerana cashback bergantung padanya).
function refreshOrderSummaryTotal() {
  var totalEl = document.getElementById("orderGrandTotal");
  if (!totalEl) return;
  totalEl.textContent = fmt(calcDiscountedTotal());

  // Cashback row — papar hanya bila Manual Transfer dipilih & cashback aktif
  var cashbackRow = document.getElementById("cashbackDiscountRow");
  if (!cashbackRow) return;

  var isManual = state_payment_method === "Manual Transfer";
  var s = state_payment_settings;
  if (isManual && s.cashback_enabled && s.cashback_percent > 0) {
    var afterVoucher  = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
    var referralAmt   = afterVoucher * ((state_referral_percent || 0) / 100);
    var afterReferral = Math.max(0, afterVoucher - referralAmt);
    var cashbackAmt   = afterReferral * (s.cashback_percent / 100);

    document.getElementById("cashbackPercentApplied").textContent = s.cashback_percent;
    document.getElementById("cashbackDiscountAmt").textContent    = "-" + fmt(cashbackAmt);
    cashbackRow.style.display = "flex";
  } else {
    cashbackRow.style.display = "none";
  }
}

// ─── STEP 3: PAYMENT ──────────────────────────────────────
// ─── PAYMENT TYPE & METHOD ────────────────────────────────────
var state_payment_amount = 0;
var state_voucher_code    = "";
var state_voucher_discount = 0;
var state_affiliate_code    = "";
var state_referral_percent  = 0;
var state_payment_method = "Online Payment";
var state_receipt_data   = null;

// Diisi oleh loadPaymentSettings() dari Travel Settings — nilai default di
// bawah ni hanya fallback sekiranya API gagal (network/server error).
var state_payment_settings = {
  bank_name:                 "Maybank",
  account_name:              "Rarecation Sdn Bhd",
  account_number:            "1234 5678 9012",
  cashback_enabled:          true,
  cashback_percent:          5,
  default_deposit_percent:   20,
};

async function loadPaymentSettings() {
  try {
    var result = await apiCall("travel_booking.api.booking.get_payment_settings", {}, true);
    if (result && !result.exc) {
      state_payment_settings = {
        bank_name:               result.bank_name || state_payment_settings.bank_name,
        account_name:            result.account_name || state_payment_settings.account_name,
        account_number:          result.account_number || state_payment_settings.account_number,
        cashback_enabled:        !!result.cashback_enabled,
        cashback_percent:        result.cashback_percent || 0,
        default_deposit_percent: result.default_deposit_percent || 20
      };
    }
  } catch (e) {
    // Diam-diam guna fallback di atas — booking tetap boleh diteruskan.
    console.warn("Gagal muat Travel Settings, guna nilai default.", e);
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
    console.warn("Gagal muat senarai Sales Person.", e);
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
  var list = document.getElementById("salesPersonList");
  if (!list) return;
  list.innerHTML = "";

  state_sales_person_rows.forEach(function(row) {
    var rowEl = document.createElement("div");
    rowEl.className = "rc-sales-person-row";

    var selWrap = document.createElement("div");
    selWrap.className = "rc-select-wrapper";
    var sel = document.createElement("select");
    sel.className = "rc-select";
    var ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "— None —";
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
    chev.className = "ti ti-chevron-down";
    selWrap.appendChild(sel);
    selWrap.appendChild(chev);
    rowEl.appendChild(selWrap);

    if (state_sales_person_rows.length > 1) {
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rc-sales-person-row__remove";
      rm.textContent = "Remove";
      rm.addEventListener("click", function() { removeSalesPersonRow(row.uid); });
      rowEl.appendChild(rm);
    }

    list.appendChild(rowEl);
  });
}

document.getElementById("addSalesPersonBtn").addEventListener("click", addSalesPersonRow);

// Order Summary collapse toggle — collapsed by default (ringkasan + Total
// sahaja); klik head untuk expand/collapse breakdown + voucher/referral.
document.getElementById("orderSummaryHead").addEventListener("click", function() {
  var body = document.getElementById("orderSummaryBody");
  var chev = document.getElementById("orderSummaryChev");
  var open = body.style.display === "block";
  body.style.display = open ? "none" : "block";
  chev.classList.toggle("rc-order-summary__chev--open", !open);
});

function renderPaymentSettingsUI() {
  var s = state_payment_settings;

  // Bank transfer details
  var bankNameEl = document.getElementById("bankNameDisplay");
  var acctNameEl = document.getElementById("bankAccountNameDisplay");
  var acctNoEl   = document.getElementById("bankAccountNumberDisplay");
  if (bankNameEl) bankNameEl.textContent = s.bank_name;
  if (acctNameEl) acctNameEl.textContent = s.account_name;
  if (acctNoEl)   acctNoEl.textContent   = s.account_number;

  // Cashback badge — sembunyi terus kalau admin matikan cashback
  var badge = document.getElementById("cashbackBadge");
  var note  = document.getElementById("cashbackNote");
  var labelManualEl = document.getElementById("labelManual");
  if (s.cashback_enabled && s.cashback_percent > 0) {
    if (badge) { badge.textContent = s.cashback_percent + "% cashback"; badge.style.display = ""; }
    if (note)  { note.textContent  = "Get " + s.cashback_percent + "% cashback when you pay via bank transfer"; note.style.display = ""; }
  } else {
    if (badge) badge.style.display = "none";
    if (note)  note.style.display = "none";
    if (labelManualEl) labelManualEl.classList.add("rc-no-cashback");
  }

  // Deposit % label — ganti "Deposit (20%)" hardcoded dengan nilai sebenar
  var depositLabelStep1 = document.getElementById("totalsDepositLabel");
  var depositLabelStep3 = document.getElementById("payDepositChipLabel");
  var depositLabelText  = "Deposit (" + s.default_deposit_percent + "%)";
  if (depositLabelStep1) depositLabelStep1.textContent = depositLabelText;
  if (depositLabelStep3) depositLabelStep3.textContent = depositLabelText;

  // Refresh total/pay summary sekiranya method dah dipilih dan cashback berbeza dari fallback
  if (typeof updatePaymentUI === "function") updatePaymentUI();
  // Refresh anggaran deposit Step 1 sekiranya cabin dah dipilih sebelum settings sampai
  if (typeof updateTotals === "function") updateTotals();
}

async function applyVoucher() {
  var code = document.getElementById("voucherInput").value.trim().toUpperCase();
  if (!code) return;

  var btn = document.getElementById("voucherBtn");
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
      },
      true  // GET
    );

    if (result.valid) {
      state_voucher_code     = code;
      state_voucher_discount = result.discount_amount;

      // Show discount row
      document.getElementById("voucherDiscountRow").style.display = "flex";
      document.getElementById("voucherCodeApplied").textContent   = code;
      document.getElementById("voucherDiscountAmt").textContent    = "-" + fmt(result.discount_amount);

      // Show success message
      showVoucherMsg("success", "✓ " + result.message);

      // Update totals
      updatePaymentUI();
    } else {
      state_voucher_code     = "";
      state_voucher_discount = 0;
      document.getElementById("voucherDiscountRow").style.display = "none";
      showVoucherMsg("error", result.message);
      updatePaymentUI();
    }
  } catch(e) {
    showVoucherMsg("error", "Failed to validate voucher. Please try again.");
  }

  btn.disabled = false;
  btn.textContent = "Apply";
}

function showVoucherMsg(type, msg) {
  var el = document.getElementById("voucherMsg");
  el.style.display = "block";
  el.style.color   = type === "success" ? "var(--rc-green)" : "#CC0000";
  el.textContent   = msg;
}

async function applyAffiliateCode() {
  var code = document.getElementById("affiliateInput").value.trim().toUpperCase();
  if (!code) return;

  var btn = document.getElementById("affiliateBtn");
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
        document.getElementById("affiliateDiscountRow").style.display = "flex";
        document.getElementById("affiliateCodeApplied").textContent   = code;
        // Amount papar dikira dari baki SELEPAS voucher (tier B) — sepadan backend.
        var afterVoucher   = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
        var referralAmount = Math.round(afterVoucher * (state_referral_percent / 100) * 100) / 100;
        document.getElementById("affiliateDiscountAmt").textContent = "-" + fmt(referralAmount);
      } else {
        // Kod SAH (affiliate tetap dapat commission bila SO/SI dibayar
        // penuh) tapi admin belum konfigurasikan % discount customer di
        // Travel Settings — jangan papar row discount dengan "-RM 0.00"
        // yang mengelirukan; state_affiliate_code tetap disimpan untuk
        // dihantar ke confirm_booking() (attribution affiliate kekal).
        document.getElementById("affiliateDiscountRow").style.display = "none";
      }

      showAffiliateMsg("success", "✓ " + result.message);
      updatePaymentUI();
    } else {
      state_affiliate_code   = "";
      state_referral_percent = 0;
      document.getElementById("affiliateDiscountRow").style.display = "none";
      showAffiliateMsg("error", result.message);
      updatePaymentUI();
    }
  } catch (e) {
    showAffiliateMsg("error", "Failed to validate referral code. Please try again.");
  }

  btn.disabled = false;
  btn.textContent = "Apply";
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

  var input = document.getElementById("affiliateInput");
  if (!input) return;

  input.value = ref.trim().toUpperCase();
  applyAffiliateCode();
}

function showAffiliateMsg(type, msg) {
  var el = document.getElementById("affiliateMsg");
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
  document.getElementById("depositNotice").style.display = isPartial ? "flex" : "none";
  document.getElementById("balanceAmt").textContent = fmt(balance);
  document.getElementById("payNowAmount").textContent = " — " + fmt(state_payment_amount);
  document.getElementById("payDepositChip").classList.toggle("active", Math.abs(state_payment_amount - min) < 0.001);
  document.getElementById("payFullChip").classList.toggle("active", Math.abs(state_payment_amount - max) < 0.001);
}

function validatePay() {
  var err = document.getElementById("payAmountError");
  var btn = document.getElementById("payNowBtn");

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
  document.getElementById("payAmountInput").value = v;
  validatePay();
  refreshPaySummary();
}

function updatePaymentUI() {
  var isPayLater = state_payment_method === "Pay Later";

  var min = getMinPay(), max = getMaxPay();
  document.getElementById("chipDeposit").textContent = fmt(min);
  document.getElementById("chipFull").textContent    = fmt(max);

  var inp = document.getElementById("payAmountInput");
  inp.min = min; inp.max = max;

  if (isPayLater) {
    // Pay Later: tiada bayaran sekarang — amount sentiasa 0, tiada
    // Deposit/Full toggle relevan.
    state_payment_amount = 0;
  } else if (!state_payment_amount || state_payment_amount > max || state_payment_amount < min) {
    // Default to full payment, or clamp an existing amount into the new range
    state_payment_amount = max;
  }
  inp.value = state_payment_amount;

  // Sembunyikan seluruh card "Payment Amount" untuk Pay Later — tiada
  // Deposit/Full/custom amount relevan bila tiada bayaran dibuat sekarang.
  var amountCard = document.getElementById("paymentAmountCard");
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

  document.getElementById("labelOnline").classList.toggle("selected", state_payment_method === "Online Payment");
  document.getElementById("labelManual").classList.toggle("selected", state_payment_method === "Manual Transfer");
  var labelPayLaterEl = document.getElementById("labelPayLater");
  if (labelPayLaterEl) labelPayLaterEl.classList.toggle("selected", isPayLater);

  var isManual = state_payment_method === "Manual Transfer";
  document.getElementById("manualTransferCard").style.display = isManual ? "block" : "none";
  document.getElementById("payNowLabel").textContent = isPayLater ? "Confirm Booking" : (isManual ? "Submit Booking" : "Pay Now");

  validatePay();
  refreshPaySummary();
  refreshOrderSummaryTotal();
}

// Payment-amount input wiring
document.getElementById("payAmountInput").addEventListener("input", function() {
  state_payment_amount = parseFloat(this.value);
  if (isNaN(state_payment_amount)) state_payment_amount = 0;
  validatePay();
  refreshPaySummary();
});
document.getElementById("payAmountInput").addEventListener("blur", function() {
  setPayAmount(parseFloat(this.value));
});
document.getElementById("payDepositChip").addEventListener("click", function() { setPayAmount(getMinPay()); });
document.getElementById("payFullChip").addEventListener("click", function() { setPayAmount(getMaxPay()); });

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
  var reader = new FileReader();
  reader.onload = function(e) {
    state_receipt_data = e.target.result; // base64
    document.getElementById("receiptFileName").style.display = "block";
    document.getElementById("receiptFileNameText").textContent = file.name;
  };
  reader.readAsDataURL(file);
}

document.getElementById("step3Back").addEventListener("click", function() { showStep(2); });

document.getElementById("payNowBtn").addEventListener("click", async function() {
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
    bankTransferRef = document.getElementById("bankTransferRefInput").value.trim();
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
  document.getElementById("confirmRef").textContent = booking.booking_number;

  var bookingStatus = booking.booking_status || "Accepted";
  renderConfirmStatusBadge(bookingStatus);
  renderConfirmActions(bookingStatus, booking.booking_number);

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
      '<div class="rc-confirm-row"><span>Voucher (' + state_voucher_code + ')</span><strong>-' + fmt(state_voucher_discount) + '</strong></div>';
  }
  var referralRowHtml = "";
  if (state_referral_percent > 0) {
    var afterVoucherAmt = Math.max(0, calcGrandTotal() - (state_voucher_discount || 0));
    var referralAmt     = afterVoucherAmt * (state_referral_percent / 100);
    referralRowHtml =
      '<div class="rc-confirm-row"><span>Referral (' + state_referral_percent + '%)</span><strong>-' + fmt(referralAmt) + '</strong></div>';
  }
  var cashbackRowHtml = "";
  if (booking.cashback_percent > 0 && booking.cashback_amount > 0) {
    cashbackRowHtml =
      '<div class="rc-confirm-row"><span>Cashback (' + booking.cashback_percent + '%)</span><strong>-' + fmt(booking.cashback_amount) + '</strong></div>';
  }

  document.getElementById("confirmDetails").innerHTML =
    '<div class="rc-confirm-row"><span>Trip</span><strong>' + state.trip_name + '</strong></div>' +
    '<div class="rc-confirm-row"><span>Departure</span><strong>' + state.group_name + '</strong></div>' +
    '<div class="rc-confirm-row"><span>Subtotal</span><strong>' + fmt(calcGrandTotal()) + '</strong></div>' +
    voucherRowHtml + referralRowHtml + cashbackRowHtml +
    '<div class="rc-confirm-row"><span>Total</span><strong>' + fmt(totalAmt) + '</strong></div>' +
    '<div class="rc-confirm-row"><span>Booking Ref</span><strong>' + booking.booking_number + '</strong></div>';

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
  document.getElementById("confirmEmail").innerHTML = confirmMsg;
}

// ─── BOOTSTRAP ─────────────────────────────────────────────
// Muat Travel Settings (bank account, cashback %) lebih awal supaya sedia
// bila user sampai ke Step 3 (Payment). Tidak menghalang render page lain.
loadPaymentSettings();
loadSalesPersons();

// Auto-fill + auto-apply referral code if the customer arrived via an
// affiliate's shareable link (?ref=CODE). Manual entry via the Apply
// button / Enter key continues to work exactly as before.
prefillAffiliateCodeFromUrl();