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
  var hint = document.getElementById("groupCapacityHint");
  if (!hint) return;
  var gs = state.group_seats_left;
  if (gs == null) {
    hint.style.display = "none";
    hint.textContent = "";
    hint.classList.remove("rc-capacity-hint--full");
    return;
  }
  hint.style.display = "";
  hint.textContent = pax + " / " + gs + " pax";
  hint.title = "Selected / available trip capacity";
  hint.classList.toggle("rc-capacity-hint--full", pax >= gs);
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
      package_currency: state.package_currency,
      package_symbol:   state.package_symbol,
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
let selectedGroup   = null;   // objek sailing {key, isCruise, tds:[...], ...}
let selectedPackage = null;
let currentSailings  = [];    // senarai sailing trip semasa (deep-link/restore: td → sailing.key)

function renderPackages(sailing) {
  // Gabung pakej dari SEMUA td dalam sailing (cruise: Fly Cruise + Cruise
  // Only digabung jadi satu senarai pilih), dedup ikut nama pakej. Setiap
  // pakej bawa trip_group_date (td) masing-masing supaya booking boleh
  // selesaikan td betul dari pakej yang dipilih (rujak step0Next).
  var seen = {};
  var pkgs = [];
  (sailing.tds || []).forEach(function(td) {
    ((TRIP_PACKAGES && TRIP_PACKAGES[td.name]) || []).forEach(function(p) {
      if (!seen[p.name]) { seen[p.name] = true; pkgs.push(p); }
    });
  });
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

    if (p.flight_label === "No Flight"){
      var label = p.package_type + " (" + p.currency + ")";
    }else{
      var label = "<p class=\"rc-date-btn__dates\" style=\"font-weight:100; font-size: 10px;\">" + p.flight_label + "</p><p class=\"rc-date-btn__name\">Fly from <b>" + p.flight + "</b></p>";
    }

    btn.innerHTML = '<span class="rc-date-btn__name">' + label + '</span>';
    btn.addEventListener("click", function() {
      packageGrid.querySelectorAll(".rc-date-btn").forEach(function(b) { b.classList.remove("selected"); });
      this.classList.add("selected");
      selectedPackage    = p;
      step0Next.disabled = false;
    });
    packageGrid.appendChild(btn);
  });
}

// Bina senarai "sailing" untuk trip. Cruise → kumpul td yang berkongsi
// cruise_schedule (pelayaran sama: Fly Cruise + Cruise Only) jadi SATU
// butang sailing; bukan-cruise → setiap td jadi sailing sendiri (tak merge,
// paparan + seats kekal sedia ada).
function buildSailings(trip, tds) {
  if (!TRIP_CRUISE_FLAGS[trip]) {
    return tds.map(function(g) {
      return {
        key: g.name,
        isCruise: false,
        tds: [g],
        displayStart: g.departure_date,
        displayEnd: g.return_date,
        trip_group_name: g.trip_group_name,
        seats_left: g.seats_left,
      };
    });
  }
  var buckets = {};
  var order = [];
  tds.forEach(function(g) {
    // td tanpa cruise_schedule (tidak terlink) → grup sendiri, tak merge.
    var k = g.cruise_schedule || g.name;
    if (!buckets[k]) { buckets[k] = []; order.push(k); }
    buckets[k].push(g);
  });
  return order.map(function(k) {
    var tdsIn = buckets[k];
    var ref = tdsIn[0];
    // Label komposisi pakej dalam sailing: kumpul jenis cruise (Fly Cruise /
    // Cruise Only) dari segmen ke-3 trip_group_name setiap td. Kedua-dua ada →
    // "Fly Cruise & Cruise Only"; satu sahaja → jenis itu. Sumber: sama ada
    // td Fly Cruise difilter (tarikh penerbangan dah lepas) tinggal Cruise
    // Only, atau sailing memang satu jenis sahaja.
    var _types = {};
    tdsIn.forEach(function(g) {
      var _seg = (g.trip_group_name || "").split(" : ");
      var _t = _seg.length === 3 ? _seg[2] : "";
      if (_t === "Fly Cruise" || _t === "Cruise Only") _types[_t] = true;
    });
    var compositionLabel = "";
    if (_types["Fly Cruise"] && _types["Cruise Only"]) compositionLabel = "Fly Cruise & Cruise Only";
    else if (_types["Cruise Only"]) compositionLabel = "Cruise Only";
    else if (_types["Fly Cruise"]) compositionLabel = "Fly Cruise";
    return {
      key: k,
      isCruise: true,
      tds: tdsIn,
      displayStart: ref.sailing_start || ref.departure_date,
      displayEnd: ref.sailing_end || ref.return_date,
      trip_group_name: ref.trip_group_name,
      compositionLabel: compositionLabel,
    };
  });
}

// Mapping td.name → sailing.key untuk deep-link & restoreWizard. Bukan-cruise
// → key === td.name (tiada merge), jadi fallback pulangkan td.name sendiri.
function sailingKeyForTd(tdName) {
  for (var i = 0; i < currentSailings.length; i++) {
    var tds = currentSailings[i].tds || [];
    for (var j = 0; j < tds.length; j++) {
      if (tds[j].name === tdName) return currentSailings[i].key;
    }
  }
  return tdName;
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

  // Cruise trip → tajuk section "Select Sailing Date"; sebaliknya "Select
  // Departure Date". Grid juga papar & susun ikut sailing date untuk cruise
  // (rujak render butang di bawah + susunan server-side di booking.py).
  var isCruiseTrip = !!TRIP_CRUISE_FLAGS[trip];
  var _dateLabel = document.getElementById("dateLabel");
  if (_dateLabel) _dateLabel.textContent = isCruiseTrip ? "Select Sailing Date" : "Select Departure Date";

  const groups = trip_group_dateS[trip] || [];
  if (!groups.length) { dateGroup.style.display = "none"; currentSailings = []; return; }

  dateGroup.style.display = "block";
  currentSailings = buildSailings(trip, groups);

  currentSailings.forEach(function(sailing) {
    var btn = document.createElement("button");
    btn.className    = "rc-date-btn";
    btn.dataset.name = sailing.key;

    if (sailing.isCruise) {
      // ---- Sailing cruise (gabungan Fly Cruise + Cruise Only) ----
      // Durasi pelayaran sebenar dari td cruise-only (departure == sailing_start,
      // tak termasuk hari penerbangan); fallback td pertama dalam sailing.
      var durTd = sailing.tds.find(function(g) {
        return g.sailing_start && g.departure_date === g.sailing_start;
      }) || sailing.tds[0];
      var durTxt = (durTd.total_days ? (durTd.total_days + " Day ") : "") + (durTd.total_nights ? (" " + durTd.total_nights + " Night") : "");
      // Label komposisi (Fly Cruise & Cruise Only / Cruise Only / Fly Cruise)
      // dipaparkan bersama durasi pelayaran di baris atas butang sailing.
      var _comp = sailing.compositionLabel || "";
      var _topLine = _comp ? (_comp + (durTxt ? (" \u00b7 " + durTxt) : "")) : durTxt;
      // Seats DIABAIKAN untuk sailing cruise — admin tutup tarikh pelayaran
      // sendiri via status bila sudah penuh (rujak keputusan reka bentuk).
      btn.innerHTML =
        (_topLine ? '<span class="rc-date-btn__dates">' + _topLine + '</span>' : '')
        + '<span class="rc-date-btn__name">' + fmtDate(sailing.displayStart) + '  \u2013  ' + fmtDate(sailing.displayEnd) + '</span>';
    } else {
      // ---- Bukan-cruise: setiap td satu butang (paparan + seats sedia ada) ----
      var g = sailing.tds[0];
      var a = g.trip_group_name.split(" : ");
      if(a.length == 3){
        var cruise = a[2] ;
        if(cruise == "Cruise Only" || cruise == "Fly Cruise") { cruise = cruise + " for ";  }
        else{ cruise = ""; }
      } else { var cruise = ""; }
      if (cruise==""){
        var this_is_group_no = " for group : " + a[2];
      }else{
        var this_is_group_no = "";
      }
      var durTxt = (g.total_days ? (g.total_days + " Day ") : "") + (g.total_nights ? (" " + g.total_nights + " Night") : "");

      // seats_left: null/undefined -> UNLIMITED (max_participants=0) ->
      // "Available". 0 -> sold out (button disabled). <=10 -> "N seats left".
      // Sumber seats_left ialah SUM(booked_pax) semua booking tak-cancelled
      // (sepadan dengan gate overbooking di confirm_booking).
      var seatsLeft = g.seats_left;
      var seatsBadge = "";
      var soldOut = (seatsLeft !== null && seatsLeft !== undefined && seatsLeft <= 0);
      if (seatsLeft === null || seatsLeft === undefined) {
        seatsBadge = '<span class="rc-date-btn__seats rc-date-btn__seats--ok">Available</span>';
      } else if (seatsLeft <= 0) {
        seatsBadge = '<span class="rc-date-btn__seats rc-date-btn__seats--out">Sold Out</span>';
      } else if (seatsLeft <= 10) {
        seatsBadge = '<span class="rc-date-btn__seats rc-date-btn__seats--few">' + seatsLeft + ' seats left</span>';
      } else {
        seatsBadge = '<span class="rc-date-btn__seats rc-date-btn__seats--ok">Available</span>';
      }

      btn.innerHTML    =
        (durTxt ? '<span class="rc-date-btn__dates">' + cruise + durTxt + this_is_group_no + '</span>' : '')
        + '<span class="rc-date-btn__name">' + fmtDate(sailing.displayStart) + '  \u2013  ' + fmtDate(sailing.displayEnd) + '</span>'
        + seatsBadge;

      if (soldOut) {
        btn.disabled = true;
        btn.classList.add("is-soldout");
      }
    }

    btn.addEventListener("click", function() {
      if (this.disabled) return;
      dateGrid.querySelectorAll(".rc-date-btn").forEach(function(b) { b.classList.remove("selected"); });
      this.classList.add("selected");
      selectedGroup = sailing;
      renderPackages(sailing);
    });
    dateGrid.appendChild(btn);
  });
});

step0Next.addEventListener("click", async function() {
  if (!tripSelect.value || !selectedGroup || !selectedPackage) return;
  state.trip_master  = tripSelect.value;
  // td (Trip Group Date) sebenar di TERBITKAN dari pakej yang dipilih. Untuk
  // sailing cruise gabungan (Fly Cruise + Cruise Only), pakej fly → td fly-
  // cruise, pakej cruise-only → td cruise-only. Backend confirm_booking guna
  // trip_group_date terus (tak terbit dari pakej), jadi kena hantar td betul,
  // bukan key sailing. Fallback td pertama kalau pakej tak bawa td (lama).
  state.trip_group_date    = selectedPackage.trip_group_date || (selectedGroup.tds[0] && selectedGroup.tds[0].name) || selectedGroup.key;
  state.trip_package = selectedPackage.name;
  state.trip_name    = tripSelect.options[tripSelect.selectedIndex].text;
  state.group_name   = selectedGroup.isCruise
    ? (fmtDate(selectedGroup.displayStart) + '  \u2013  ' + fmtDate(selectedGroup.displayEnd))
    : selectedGroup.trip_group_name;
  state.package_label = selectedPackage.package_name;
  // MULTI-CURRENCY: simpan currency package yang dipilih — dipakai untuk
  // paparan harga (fmt) DAN pilih bank details/pilihan payment method
  // yang betul di Step Payment (rujuk renderPaymentSettingsUI()/
  // dokumen reka bentuk multi-currency). Fallback "MYR" untuk package
  // lama yang mungkin belum diisi currency-nya.
  state.package_currency = selectedPackage.currency || "MYR";
  state.package_symbol   = selectedPackage.currency_symbol || state.package_currency;
  // Marketing hint: kalau customer BELUM pilih display currency sendiri
  // (tiada keutamaan localStorage), defaultkan paparan ke currency pakej
  // (cth trip SGD papar SGD). Kalau ada keutamaan tersimpan, kekal pilihan
  // customer. Harga sentiasa dicaj company currency — ini cuma paparan.
  var _savedPref = null;
  try { _savedPref = localStorage.getItem("rc_display_currency"); } catch (e) {}
  if (!_savedPref && state.package_currency && state.package_currency !== state.display_currency) {
    var sel = document.getElementById("displayCurrency");
    if (sel) {
      // hanya tukar kalau currency pakej ada dalam senarai converter
      var hasOpt = Array.prototype.some.call(sel.options, function(o) { return o.value === state.package_currency; });
      if (hasOpt) {
        sel.value = state.package_currency;
        setDisplayCurrency(state.package_currency, false);
      }
    }
  }
  if (typeof renderPaymentSettingsUI === "function") renderPaymentSettingsUI();
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
  state.package_currency = snap.package_currency || "MYR";
  state.package_symbol   = snap.package_symbol || "RM";
  if (snap.billing) state.billing = snap.billing;
  state.otp_verified = !!snap.otp_verified;
  if (tripSelect) {
    tripSelect.value = snap.trip_master || "";
    tripSelect.dispatchEvent(new Event("change"));
    var _d = dateGrid.querySelector('[data-name="' + sailingKeyForTd(snap.trip_group_date) + '"]');
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
    // "Amount Paid" dipapar untuk SEMUA status settled (Paid & Partially
    // Paid) — bukan Partially Paid sahaja macam sebelum ni (bila customer
    // bayar penuh, row Amount Paid hilang terus — nampak macam tiada
    // pengesahan bayaran). Bila deposit (Partially Paid), tambah row
    // "Balance Due" supaya customer nampak baki tertunggak jelas.
    var amountPaidRow = "";
    var balanceDueRow = "";
    if (result.payment_status === "Paid" || result.payment_status === "Partially Paid") {
      amountPaidRow =
        '<div class="rc-confirm-row"><span>Amount Paid</span><strong style="color:#166534">' +
        fmt(result.advance_paid || 0) + '</strong></div>';
      if (result.payment_status === "Partially Paid") {
        var balanceDue = Math.max(0, (result.grand_total || 0) - (result.advance_paid || 0));
        balanceDueRow =
          '<div class="rc-confirm-row"><span>Balance Due</span><strong>' +
          fmt(balanceDue) + '</strong></div>';
      }
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
      amountPaidRow + balanceDueRow + paymentStatusRow +
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

  var candidates = []; // { groupDateName, tripName, departureDate, sailingDate }

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
          departureDate: match.departure_date || "",
          sailingDate:   match.sailing_start || ""
        });
      }
    });
  });

  if (!candidates.length) return null;  // package tak wujud/tak aktif

  var today    = new Date().toISOString().slice(0, 10);
  // Cruise: banding sailing date; sebaliknya departure. sailingDate kosong
  // (non-cruise) → fallback departureDate, jadi satu ungkapan handle kedua-dua
  // kes — sepadan dengan susunan grid (booking.py susun cruise ikut sailing).
  var upcoming = candidates.filter(function(c) { return (c.sailingDate || c.departureDate) >= today; });
  var pool     = upcoming.length ? upcoming : candidates;

  pool.sort(function(a, b) { return (a.sailingDate || a.departureDate).localeCompare(b.sailingDate || b.departureDate); });

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
      var dateBtn = dateGrid.querySelector('[data-name="' + sailingKeyForTd(_finalPackageLink.groupDateName) + '"]');
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
      var dateBtn = dateGrid.querySelector('[data-name="' + sailingKeyForTd(_resolvedDateLink.groupDateName) + '"]');
      if (dateBtn) dateBtn.click();
    }, 100);
  } else if (INIT_TRIP && INIT_DATE) {
    // Mekanisme LAMA (2 parameter: ?trip_master=&trip_group_date=) —
    // dikekalkan untuk pautan/bookmark sedia ada yang mungkin dah wujud
    // di luar sana. Tak auto-pilih Package (customer pilih sendiri).
    tripSelect.value = INIT_TRIP;
    tripSelect.dispatchEvent(new Event("change"));
    setTimeout(function() {
      var btn = dateGrid.querySelector('[data-name="' + sailingKeyForTd(INIT_DATE) + '"]');
      if (btn) btn.click();
    }, 100);
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
    // (loadCabins) supaya kedua-dua flow — step0Next & restoreWizard — dapat
    // nilai terkini tanpa duplikasi.
    syncGroupSeatsLeft();
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
  var list  = document.getElementById("roomList");
  list.innerHTML = "";
  var avail = availableCabins();

  // Reset array stepper kongsi — stepper dibina semula oleh forEach di bawah
  // dan akan mendaftar refreshButtons() masing-masing semula (rujuk mkStepper).
  allStepperRefreshers.length = 0;

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
    title.textContent = (state.is_cruise_trip ? "Cabin " : "Room ") + (idx + 1);
    headLeft.appendChild(title);

    var c = cabinByCategory(room.room_category);
    if (!isOpen) {
      var pax      = room.main_guests + room.extra_beds + room.infants;
      var subtotal = c ? priceRoomSelection(c.pricing, room.main_guests, room.extra_beds, room.infants) : 0;
      var summary  = document.createElement("span");
      summary.className = "rc-room__summary";
      // summary.textContent = "\u00b7 " + (room.room_category || "No cabin selected") + " \u00b7 " + pax + " pax \u00b7 " + fmt(subtotal);
      summary.textContent = "\u00b7 " + (room.room_category || "No cabin selected") + " \u00b7 " + pax + " pax";
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
      typeLbl.textContent = state.is_cruise_trip ? "Cabin Type" : "Rooming Type";
      
      var selWrap = document.createElement("div");
      selWrap.className = "rc-select-wrapper";
      
      var sel = document.createElement("select");
      sel.className = "rc-select";
      
      var ph = document.createElement("option");
      ph.value = "";
      ph.textContent = state.is_cruise_trip ? " Select cabin type " : " Select rooming type ";
      
      if (!room.room_category) ph.selected = true;
      
      sel.appendChild(ph);
      
      avail.forEach(function(cab) {
        console.log(cab);
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
      typeChev.className = "ti ti-chevron-down";
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
        cabinInfo.className = "rc-cabin-type-info";

        if (c.room_image) {
          var cabinImg = document.createElement("img");
          cabinImg.className = "rc-cabin-type-info__image";
          cabinImg.src = c.room_image;
          cabinImg.alt = c.room_name || "Cabin";
          cabinImg.loading = "lazy";
          cabinInfo.appendChild(cabinImg);
        }

        if (c.description) {
          // PENTING: 'description' ialah Text Editor (rich text HTML),
          // BUKAN plain text — kena innerHTML supaya formatting admin
          // (bold/senarai/perenggan) dipapar betul, bukan tag mentah.
          // Content ditulis admin sendiri di Desk (bukan input customer),
          // sama risiko macam content CMS lain — tak perlu sanitize
          // tambahan.
          var descText = document.createElement("div");
          descText.className = "rc-cabin-type-info__desc rc-cabin-type-info__desc--clamped";
          descText.innerHTML = c.description;
          cabinInfo.appendChild(descText);

          // "Read more" / "Read less" — cuma dipapar kalau teks BENAR-
          // BENAR terpotong (scrollHeight > clientHeight lepas clamp 2
          // baris). requestAnimationFrame supaya browser sempat render
          // dulu sebelum measurement diambil (elak baca 0/salah semasa
          // elemen baru di-attach).
          var readMoreBtn = document.createElement("span");
          readMoreBtn.className = "rc-cabin-type-info__readmore";
          readMoreBtn.textContent = "Read more";
          readMoreBtn.style.display = "none";
          var descExpanded = false;
          readMoreBtn.addEventListener("click", function() {
            descExpanded = !descExpanded;
            descText.classList.toggle("rc-cabin-type-info__desc--clamped", !descExpanded);
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
      var stepperRefreshers = allStepperRefreshers;  // kongsi array global (semua room)


      if (state.is_cruise_trip) {
        counters.appendChild(mkStepper(room, "main_guests", "Main Guest (Adults 12 years old and above)", capacity, function() {
          if(!pricing.price_adult ){ pricing.price_adult = 0; }
          return room.main_guests === 1
            ? fmt(pricing.price_adult_single) + " /pax"
            : fmt(pricing.price_adult) + " /pax";
        }, stepperRefreshers));

        counters.appendChild(mkStepper(room, "extra_beds", "Extra Bed ", 0, function() {
          if(!pricing.price_upperberth ){ pricing.price_upperberth = 0; }
          return fmt(pricing.price_upperberth) + " /pax";
        }, stepperRefreshers));
      } else {
        // Non-cruise (model UMUR): Adult (price_adult) + Children (price_children).
        counters.appendChild(mkStepper(room, "main_guests", "Adult (12 years old and above)", capacity, function() {
          if(!pricing.price_adult ){ pricing.price_adult = 0; }
          return fmt(pricing.price_adult) + " /pax";
        }, stepperRefreshers));

        counters.appendChild(mkStepper(room, "extra_beds", "Children (2-11 years old)", 0, function() {
          if(!pricing.price_children ){ pricing.price_children = 0; }
          return fmt(pricing.price_children) + " /pax";
        }, stepperRefreshers));
      }

      counters.appendChild(mkStepper(room, "infants", "Infant (6-23 months old)", 0, function() {
        if(!pricing.price_infant ){ pricing.price_infant = 0; }
        return fmt(pricing.price_infant) + " /pax";
      }, stepperRefreshers));

      card.appendChild(typeField);
      if (cabinInfo) card.appendChild(cabinInfo);
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
      ? "Maximum " + MAX_CABINS_PER_BOOKING + " cabins per booking"
      : "";
  }

  updateTotals();
}

function mkStepper(room, key, label, max, rateFn, refreshers, tooltipText) {
  // ------------------------------------------
  var row = document.createElement("div");
  row.className = "rc-counter-row";
  // ------------------------------------------
  var lblWrap = document.createElement("span");
  lblWrap.className = "rc-counter-row__label-wrap";

  var lbl = document.createElement("span");
  lbl.className = "rc-counter-row__label";
  lbl.textContent = label;
  lblWrap.appendChild(lbl);

  // Tooltip info (cth had umur "Main Guest"/"Infant") — opsyenal, cuma
  // dipapar kalau tooltipText dibekalkan. tabindex="0" supaya boleh
  // diakses papan kekunci/tap-focus (bukan cuma hover tetikus).
  if (tooltipText) {
    var tip = document.createElement("span");
    tip.className = "rc-tooltip";
    tip.tabIndex = 0;
    tip.setAttribute("role", "img");
    tip.setAttribute("aria-label", tooltipText);
    var tipIcon = document.createElement("i");
    tipIcon.className = "ti ti-info-circle";
    var tipBubble = document.createElement("span");
    tipBubble.className = "rc-tooltip__bubble";
    tipBubble.textContent = tooltipText;
    tip.appendChild(tipIcon);
    tip.appendChild(tipBubble);
    lblWrap.appendChild(tip);
  }
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

  // lblWrap.appendChild(rate);
  stepper.appendChild(minus);
  stepper.appendChild(val);
  stepper.appendChild(plus);

  row.appendChild(lblWrap);
  row.appendChild(rate);
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
  updateGroupCapacityHint(pax);
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

    if (state.is_cruise_trip) {
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
    } else {
      // Non-cruise: Adult (price_adult) + Children (price_children), flat per pax.
      var adultRate = Number(p.price_adult || 0);
      for (var i = 0; i < r.main_guests; i++) {
        cabinFare += adultRate;
        guestLines.push(["Guest " + guestNo + " \u00b7 Adult", adultRate]);
        guestNo++;
      }
      var childRate = Number(p.price_children || 0);
      for (var j = 0; j < r.extra_beds; j++) {
        cabinFare += childRate;
        guestLines.push(["Guest " + guestNo + " \u00b7 Children", childRate]);
        guestNo++;
      }
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
  var tripEl = document.getElementById("orderSummaryTrip");
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
// MULTI-CURRENCY: bank_accounts ialah dict {currency: {bank_name,
// account_name, account_number}} — dipilih ikut state.package_currency
// bila render (rujuk renderPaymentSettingsUI()), sebab currency sebenar
// booking BELUM diketahui semasa loadPaymentSettings() jalan (page load,
// sebelum customer pilih Trip/Package).
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

function renderPaymentSettingsUI() {
  var s = state_payment_settings;

  // COMPANY-CURRENCY: bank details (Manual Transfer) ikut COMPANY currency
  // — customer dicaj dalam company currency (SO/Stripe/Payment Entry semua
  // company currency), jadi mereka kena transfer ke bank account company.
  // Bukan state.package_currency (itu cuma hint paparan converter sekarang).
  var currency = state.company_currency || "MYR";
  var bankInfo = (s.bank_accounts && s.bank_accounts[currency]) || null;

  // Bank transfer details
  var bankNameEl = document.getElementById("bankNameDisplay");
  var acctNameEl = document.getElementById("bankAccountNameDisplay");
  var acctNoEl   = document.getElementById("bankAccountNumberDisplay");
  if (bankNameEl) bankNameEl.textContent = bankInfo ? bankInfo.bank_name : "";
  if (acctNameEl) acctNameEl.textContent = bankInfo ? bankInfo.account_name : "";
  if (acctNoEl)   acctNoEl.textContent   = bankInfo ? bankInfo.account_number : "";

  // Sembunyikan pilihan "Manual Bank Transfer" sepenuhnya kalau admin
  // belum konfigurasikan Bank Account untuk currency package ni (rujuk
  // dokumen reka bentuk multi-currency: "sembunyikan pilihan payment,
  // bukan fallback senyap ke MYR" — elak customer transfer duit currency
  // asing ke bank yang salah/tak ditrack betul).
  var labelManualEl = document.getElementById("labelManual");
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
  var badge = document.getElementById("cashbackBadge");
  var note  = document.getElementById("cashbackNote");
  if (bankInfo && s.cashback_enabled && s.cashback_percent > 0) {
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
        is_cruise:       state.is_cruise_trip,
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

      // Kunci input (elak edit kod yang dah aktif) — butang sendiri TAK
      // dikunci, sebaliknya bertukar fungsi jadi "✕" (buang kod, rujuk
      // onVoucherBtnClick() — satu butang, dua peranan ikut state).
      document.getElementById("voucherInput").disabled = true;
      btn.textContent = "\u2715";
      btn.classList.add("rc-btn--voucher-applied");

      // Show success message
      showVoucherMsg("success", "✓ " + result.message);

      // Update totals
      updatePaymentUI();
    } else {
      state_voucher_code     = "";
      state_voucher_discount = 0;
      document.getElementById("voucherDiscountRow").style.display = "none";
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

  document.getElementById("voucherDiscountRow").style.display = "none";
  document.getElementById("voucherMsg").style.display = "none";

  var input = document.getElementById("voucherInput");
  input.disabled = false;
  input.value = "";

  var btn = document.getElementById("voucherBtn");
  btn.textContent = "Apply";
  btn.classList.remove("rc-btn--voucher-applied");

  updatePaymentUI();
}



function showVoucherMsg(type, msg) {
  var el = document.getElementById("voucherMsg");
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

      // Kunci input (elak edit kod yang dah aktif) — butang sendiri TAK
      // dikunci, sebaliknya bertukar fungsi jadi "✕" (buang kod, rujuk
      // onAffiliateBtnClick() — satu butang, dua peranan ikut state).
      document.getElementById("affiliateInput").disabled = true;
      btn.textContent = "\u2715";
      btn.classList.add("rc-btn--voucher-applied");

      showAffiliateMsg("success", "✓ " + result.message);
      updatePaymentUI();
    } else {
      state_affiliate_code   = "";
      state_referral_percent = 0;
      document.getElementById("affiliateDiscountRow").style.display = "none";
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

  document.getElementById("affiliateDiscountRow").style.display = "none";
  document.getElementById("affiliateMsg").style.display = "none";

  var input = document.getElementById("affiliateInput");
  input.disabled = false;
  input.value = "";

  var btn = document.getElementById("affiliateBtn");
  btn.textContent = "Apply";
  btn.classList.remove("rc-btn--voucher-applied");

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

  // COMPANY-CURRENCY: prefix input "Payment Amount" — amaun yang customer
  // BAYAR (deposit/full) sentiasa dalam company currency (dicaj Stripe /
  // Payment Entry), jadi prefix mesti company_symbol, BUKAN package_symbol
  // (itu cuma hint paparan converter sekarang). fmt() pada chip Deposit/
  // Pay-in-full sebelah guna company currency juga (display currency hanya
  // paparan tambahan dalam kurungan).
  var prefixEl = document.getElementById("payAmountPrefix");
  if (prefixEl) prefixEl.textContent = state.company_symbol || "RM";

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

// ─── DISPLAY CURRENCY CONVERTER ───────────────────────────
// SEMUA harga dicaj dalam company currency; pilihan currency di sini cuma
// tukar PAPARAN (rate exchange ERPNext for_selling, indicative). fmt()
// baca state.display_rate live, jadi re-render step semasa selepas tukar.
var DISPLAY_CURRENCIES = [];

async function initDisplayCurrency() {
  var sel = document.getElementById("displayCurrency");
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
  try { saved = localStorage.getItem("rc_display_currency"); } catch (e) {}
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
    try { localStorage.setItem("rc_display_currency", code); } catch (e) {}
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
  var note = document.getElementById("currencyNote");
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
      if (typeof renderRooms === "function") renderRooms();
      if (typeof updateTotals === "function") updateTotals();
    } else if (state.step === 3) {
      if (typeof buildOrderSummary === "function") buildOrderSummary();
      if (typeof refreshOrderSummaryTotal === "function") refreshOrderSummaryTotal();
      if (typeof refreshPaySummary === "function") refreshPaySummary();
    }
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