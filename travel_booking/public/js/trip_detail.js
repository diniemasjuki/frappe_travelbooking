// travel_booking/public/js/trip_detail.js
//
// Widget keberangkatan + pricing untuk page detail trip /trip/<slug>.
// Vanilla JS (sepadan portal, tiada frappe JS bundle diperlukan). Panggil
// pricing.get_booking_details (whitelist allow_guest) via /api/method.
//
// Aliran:
//   step 2: pilih date (sailing/departure) → radio dari DATA.group_dates
//   step 3: AJAX search_packages_by_date(start, end) → button dengan format package:group_date
//   step 4: [Book Now] → simpan package_variant = "package_name:group_date" ke session

// ── Block right-click pada gallery images ──
(function () {
  "use strict";
  var gallery = document.getElementById("rcGalleryGrid");
  if (!gallery) return;
  gallery.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    return false;
  });
})();

(function () {
  "use strict";
  var dataEl = document.getElementById("rcDetailData");
  if (!dataEl) return;
  var DATA;
  try { DATA = JSON.parse(dataEl.textContent); } catch (e) { return; }

  // ── Clear stale add-to-cart session ──
  try {
    sessionStorage.removeItem("bnw_cart");
    sessionStorage.removeItem("bnw_booking_wizard");
  } catch (_e) {}

  var SYM = DATA.currency_symbol || DATA.company_symbol || "RM";
  // Currency listing aktif (paksi multi-company) — harga "from"/nota
  // default guna ni; SYM bertukar kepada currency NATIVE pakej yang
  // dipilih (1 pakej = 1 currency — itulah currency yang dicaj).
  var LISTING_CURRENCY = DATA.currency || "";
  var _pkgMap = {};   // {"package_name|group_date": pkg_dict} — keyed per VARIAN
                      // (satu pakej boleh dipaut ke beberapa group date)
  var groupDatesData = DATA.group_dates || [];
  var is_cruise = !!DATA.is_cruise;
  var TRIP_TYPE = is_cruise ? "cruise" : "non_cruise";
  var PRICE_LABELS = [];

  // ── Date selector state (trigger + popup modal bila >1 tarikh) ──
  var _allRadios = [];    // radio hidden per tarikh — sumber state terpilih
  var _dateMeta = [];     // meta paparan per tarikh (text, seats, hasFlight)
  var _dateTrigger = null;
  var _dateModal = null;

  // NOTE: packages TIDAK di-preload. populatePackages() buat AJAX call
  // ke search_packages_by_date bila user pilih tarikh.

  var gdSel = document.getElementById("rcDetailGroupDate");
  // #rcDetailPackage TAK WUJUD pada page cruise (seksyen "Choose Package"
  // dibuang dari booking card — pakej dipilih via modal Change Date).
  var pkgSel = document.getElementById("rcDetailPackage");
  var metaDurationEl = document.getElementById("rcMetaDuration");
  var cabinsEl = document.getElementById("rcDetailCabins");
  var bookBtn = document.getElementById("rcDetailBookBtn");
  var shareBtn = document.getElementById("rcDetailShareBtn");
  if (!gdSel) return;

  // ── Seksyen showcase (layout utama, bukan sidebar) ──
  // #rcDateCards — kad per departure date (sinkron dengan radio sidebar);
  // #rcCabinCards — kad kategori kabin (render dari get_booking_details).
  var dateCardsEl = document.getElementById("rcDateCards");
  // Seksyen "Other Categories" selepas FAQ (cruise) — shell server-render;
  // JS papar bila ada kategori travel-date LAIN selain kategori terpilih.
  var otherCatsSection = document.getElementById("rcOtherCatsSection");
  var otherCatsEl = document.getElementById("rcOtherCats");
  var cabinSection = document.getElementById("rcCabinsSection");
  var cabinCardsEl = document.getElementById("rcCabinCards");

  // Seksi addon matrix offer → chip inklusi (padanan
  // utils/catalog_extras._INCLUSION_SECTIONS).
  var INCLUSION_META = {
    flight: { icon: "ti-plane", label: "Flight" },
    hotel: { icon: "ti-bed", label: "Hotel" },
    transport: { icon: "ti-bus", label: "Transport" },
    meal: { icon: "ti-tools-kitchen-2", label: "Meals" },
  };

  // ── Parse ?trip_group_date=RC...&trip_package=TP...&sp=... from URL ──
  // 'sp' ialah affiliate referral code (Sales Partner) — dipasang oleh pautan
  // affiliate yang menuju terus ke page detail trip. Code ni dirambat ke
  // /booknow (via bnw_cart + URL param) supaya wizard boleh pre-fill &
  // atribut komisen affiliate pada booking.
  var _wishPkg = "", _wishGd = "", _sp = "";
  try {
    var qs = new URLSearchParams(window.location.search);
    // ?date=<tgd|travel_date> — alias ringkas untuk deep-link kad pakej
    // khas homepage / chips tarikh kad trip (?trip_group_date= kekal
    // dibaca untuk pautan lama; share My Trip kini jana ?date=/?package=).
    _wishGd = qs.get("date") || qs.get("trip_group_date") || "";
    _wishPkg = qs.get("package") || qs.get("trip_package") || "";
    _sp = (qs.get("sp") || "").trim().toUpperCase();
  } catch (_e) {}

  // Selaraskan param tarikh/pakej pada URL semasa (history.replaceState —
  // tanpa reload). Param LAIN (utm_*, sp/affiliate, dsb.) kekal — hanya
  // date/package yang diset/dibuang, param legacy trip_group_date/
  // trip_package dibersihkan supaya tiada konflik bila page di-reload.
  function syncUrlParams(params) {
    try {
      var cur = new URLSearchParams(window.location.search);
      Object.keys(params).forEach(function (k) {
        if (params[k]) cur.set(k, params[k]);
        else cur.delete(k);
      });
      cur.delete("trip_group_date");
      cur.delete("trip_package");
      var qsStr = cur.toString();
      var next = window.location.pathname
        + (qsStr ? "?" + qsStr : "")
        + (window.location.hash || "");
      window.history.replaceState({}, "", next);
    } catch (_e) { /* URL sync tak boleh ganggu paparan */ }
  }

  // Format tarikh pusat (Travel Website → window.RC_DATE_FORMAT).
  var _RC_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var _RC_MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function _fmtWebDate(iso) {
    if (!iso) return '';
    var m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(iso);
    var y = m[1], mo = parseInt(m[2], 10), d = parseInt(m[3], 10);
    var fmt = window.RC_DATE_FORMAT || 'dd MMM yyyy';
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var out = fmt;
    out = out.replace('MMMM', _RC_MONTHS_FULL[mo - 1] || '');
    out = out.replace('MMM', _RC_MONTHS[mo - 1] || '');
    out = out.replace('yyyy', y);
    out = out.replace('mm', pad(mo));
    out = out.replace('dd', pad(d));
    return out;
  }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // ── Pakej untuk sesuatu tarikh ──
  // SATU pilihan tarikh = SATU Travel Date / TGD (kunci = ID dokumen) —
  // pakej diambil terus dari trip_packages[kunci]. Tiada union merentasi
  // tarikh: union sailing lama mencampurkan Travel Date berbeza yang
  // berkongsi sailing, union departure pula mencampurkan Travel Date
  // berbeza yang berkongsi tarikh berlepas (cth dua sailing durasi
  // berbeza berlepas hari yang sama).
  // Guna juga untuk kesan tarikh yang ada pilihan penerbangan (ikon
  // pesawat dalam date selector).
  function pkgsForDate(gdData) {
    var preloaded = DATA.trip_packages || {};
    return preloaded[gdData.name] || [];
  }
  // Tarikh ada pilihan "cruise/flight" bila SESUATU pakej dalam tarikh itu
  // membawa flight (airport_form) — cth pakej Cruise + Flight / Fly Package.
  function dateHasFlight(gdData) {
    return pkgsForDate(gdData).some(function (p) { return !!p.flight; });
  }
  // "2026-09-12" → "2026-09" (kunci filter bulan date selector)
  function monthKey(iso) {
    var m = String(iso || "").match(/^(\d{4})-(\d{2})/);
    return m ? m[1] + "-" + m[2] : "";
  }
  function monthLabel(key) {
    var p = String(key || "").split("-");
    var mo = parseInt(p[1], 10);
    if (!p[0] || !(mo >= 1 && mo <= 12)) return String(key || "");
    return _RC_MONTHS[mo - 1] + " " + p[0];
  }
  function fmt(a) {
    a = Number(a) || 0;
    return SYM + " " + Math.round(a).toLocaleString(undefined, {
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
  }
  // ── Selected package state ──
  // group_date datang dari API response (package's trip_group_date),
  // BUKAN dari date radio — ini memastikan data consistency.
  var _selectedPkg = "";
  // URL sync ditahan semasa BOOT (auto-select pakej pertama pada load
  // bukan navigasi user — URL kekal bersih); aktif selepas init.
  var _suppressUrlSync = true;
  var _selectedPkgGd = "";
  var _selectedPkgData = null;  // pkg_dict varian terpilih — sumber blok meta

  function getSelectedDateValue() {
    var checked = gdSel.querySelector("input[name='rc_group_date']:checked");
    return checked ? checked.value : "";
  }
  function getSelectedGroupDateId() {
    var checked = gdSel.querySelector("input[name='rc_group_date']:checked");
    return checked ? checked.getAttribute("data-gd-id") : "";
  }

  // ── Load price category labels dari Travel Settings config ──
  function loadPriceLabels() {
    return fetch("/api/method/travel_booking.api.price_config.fetch_price_labels?trip_type=" + encodeURIComponent(TRIP_TYPE),
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

  function getDefaultPriceLabels() {
    if (TRIP_TYPE === "cruise") {
      return [
        { price_key: "price_adult", display_label: "Main Adult", display_note: "Main Guest must be adult at 12 years old and above. Single Adult occupied in the cabin will result extra charge for single occupancy." },
        { price_key: "price_upperberth", display_label: "Extra Bed", display_note: "Extra Bed is an additional bed such as sofa bed or upper-berth configuration." },
        { price_key: "price_infant", display_label: "Infant", display_note: "Infant is only valid for 0-23 month on embarkation date." },
      ];
    }
    return [
      { price_key: "price_adult", display_label: "Adult", display_note: "12 years old and above" },
      { price_key: "price_children", display_label: "Children", display_note: "2 to 11 years old on departure date" },
      { price_key: "price_infant", display_label: "Infant", display_note: "Infant is only valid for 0-23 month on embarkation date." },
    ];
  }

  // ════ STEP 2: Populate date radios from DATA.group_dates ════
  // Default tarikh (tiada deep-link): tarikh BASIC package terdekat ikut
  // departure date — group_dates disusun kronologi oleh server, jadi
  // basic pertama = terdekat. Fallback index 0 bila semua tarikh special.
  function defaultBasicDateIdx() {
    for (var i = 0; i < groupDatesData.length; i++) {
      if (!groupDatesData[i].is_special) return i;
    }
    return 0;
  }

  // ── Default kategori cruise (Travel Website → default_cruise_category)
  // Tanpa deep-link: bila trip cruise ada ≥2 tarikh & kategori default
  // wujud dalam tarikh trip — pilih tarikh TERDEKAT (kronologi pertama)
  // dalam kategori itu. Kategori tiada dalam trip / <2 tarikh / bukan
  // cruise → fallback tarikh basic terdekat (defaultBasicDateIdx).
  function defaultCruiseCategoryIdx() {
    var defCat = DATA.default_cruise_category || "";
    if (TRIP_TYPE !== "cruise" || !defCat || groupDatesData.length < 2) {
      return defaultBasicDateIdx();
    }
    for (var i = 0; i < groupDatesData.length; i++) {
      if ((groupDatesData[i].trip_category || "") === defCat) return i;
    }
    return defaultBasicDateIdx();
  }

  // ── Tapisan kategori tarikh (cruise + deep-link ?date= sahaja) ──
  // Tarikh membawa kategori trip (Travel Date.trip_category). Deep-link
  // ke satu tarikh: pilihan tukar tarikh dikunci pada kategori tarikh ITU
  // — senarai tarikh papar kategori sama sahaja; bila tiada tarikh lain
  // dalam kategori itu, butang change date disembunyikan (tiada pilihan
  // bermakna). Tanpa deep-link (browse biasa) / bukan cruise / tarikh
  // terpilih tiada kategori / id deep-link lapuk → null = semua tarikh
  // (tingkah laku sedia ada).
  function categoryFilterIdxs() {
    if (TRIP_TYPE !== "cruise" || !_wishGd) return null;
    var selIdx = -1;
    groupDatesData.forEach(function (g, i) {
      if (g.name === _wishGd) selIdx = i;
    });
    if (selIdx < 0) return null; // deep-link lapuk → semua tarikh
    var cat = (groupDatesData[selIdx] || {}).trip_category || "";
    if (!cat) return null; // tarikh tiada kategori → tiada tapisan
    var idxs = [];
    groupDatesData.forEach(function (g, i) {
      if ((g.trip_category || "") === cat) idxs.push(i);
    });
    return idxs;
  }
  // Index tarikh boleh dipapar dalam UI (semua bila tiada tapisan).
  function visibleDateIdxs() {
    return categoryFilterIdxs()
      || groupDatesData.map(function (_, i) { return i; });
  }

  function populateDates() {
    gdSel.innerHTML = "";
    if (!groupDatesData.length) {
      gdSel.innerHTML = '<p class="rc-muted">No dates available.</p>';
      return;
    }

    // Deep-link kategori aktif → kira bilangan tarikh DALAM kategori
    // sahaja (radio hidden tetap dibina untuk SEMUA tarikh — sumber
    // state + lookup pakej tak berubah).
    var multi = visibleDateIdxs().length > 1;
    _allRadios = [];
    _dateMeta = [];

    // Default tarikh: deep-link ?date= (bila sah) → jika tiada, tarikh
    // BASIC package terdekat ikut departure date (group_dates sudah susun
    // kronologi oleh server — basic pertama = terdekat). Fallback index 0
    // bila semua tarikh special.
    var _wishIdx = -1;
    if (_wishGd) {
      groupDatesData.forEach(function (g, i) { if (g.name === _wishGd) _wishIdx = i; });
    }
    var _defaultIdx = _wishIdx >= 0 ? _wishIdx : defaultCruiseCategoryIdx();

    groupDatesData.forEach(function (gdData, idx) {
      var radioId = "gd_" + idx;

      // value = actual dates (for SQL query: departure_date:return_date —
      // cruise turut guna departure date selepas grouping berubah dari
      // sailing date; fallback sailing bila departure kosong)
      var startDate = gdData.departure_date || gdData.sailing_start;
      var endDate = gdData.return_date || (is_cruise ? gdData.sailing_end : "");
      var dateValue = startDate + ":" + (endDate || "");

      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "rc_group_date";
      radio.id = radioId;
      radio.value = dateValue;
      radio.setAttribute("data-gd-id", gdData.name);
      radio.className = "rc-date-radio";
      if (idx === _defaultIdx) radio.checked = true;

      // Tarikh diformat ikut konfigurasi Travel Website (window.RC_DATE_FORMAT
      // dari base_travel.html) — bukan ISO mentah.
      var dateText = _fmtWebDate(startDate);
      if (endDate) {
        dateText += " → " + _fmtWebDate(endDate);
      }
      var seatsHtml = "";
      if (gdData.seats_left != null) {
        if (gdData.seats_left === 0) {
          seatsHtml = " · <strong>Sold out</strong>";
        } else if (gdData.seats_left <= 3) {
          seatsHtml = " · " + gdData.seats_left + " left";
        }
      }

      // Radio sentiasa di-append (hidden via CSS .rc-date-radio) — sumber
      // state tarikh terpilih untuk getSelectedDateValue/getSelectedGroupDateId.
      gdSel.appendChild(radio);
      _allRadios.push(radio);
      _dateMeta.push({
        dateText: dateText,
        seatsHtml: seatsHtml,
        startIso: startDate || "",
        hasFlight: dateHasFlight(gdData),
      });
    });

    if (multi) {
      // Cruise: teks bold tarikh terpilih (tiada butang + tiada popup
      // sidebar — #rcDateModal dibina hanya bila ada trigger). Tour:
      // trigger + popup date selector kekal.
      if (TRIP_TYPE === "cruise") {
        renderChosenDateLabel();
      } else {
        renderDateTrigger();
        renderDateModal();
      }
      updateDateTriggerLabel();
    } else if (TRIP_TYPE === "cruise") {
      // Cruise 1 tarikh: teks bold juga (konsisten — tiada butang date di
      // booking card cruise).
      renderChosenDateLabel();
      updateDateTriggerLabel();
    } else {
      // Tour 1 tarikh: label inline tarikh terpilih (tingkah laku sedia ada).
      renderInlineDateLabel(_defaultIdx);
    }

    // Kad showcase tarikh (seksyen "Dates & Packages") — selari dengan
    // radio/popup sidebar; klik kad ⇄ selectDate() sync dua arah.
    renderDateCards();

    // Seksyen "Other Categories" selepas FAQ — kategori lain selain
    // tarikh terpilih (hidden bila tiada).
    renderOtherCats();

    // Auto-select first date → AJAX fetch packages
    populatePackages();
  }

  // ── 1 tarikh: label inline (tingkah laku sedia ada) ──
  function renderInlineDateLabel(idx) {
    var radio = _allRadios[idx];
    var meta = _dateMeta[idx];
    var label = document.createElement("label");
    label.htmlFor = radio.id;
    label.className = "rc-date-radio-label";
    label.innerHTML = '<span class="rc-date-radio-text">' + esc(meta.dateText) + meta.seatsHtml + '</span>';

    // Click handler — force update checked state, then AJAX fetch packages
    radio.addEventListener("click", function () {
      Array.prototype.forEach.call(_allRadios, function (r) {
        r.checked = false;
        r.removeAttribute("checked");
      });
      this.checked = true;
      this.setAttribute("checked", "checked");
      populatePackages();
    });

    label.addEventListener("click", function (e) {
      e.preventDefault();
      radio.click();
    });

    gdSel.appendChild(label);
  }

  // ── >1 tarikh: butang trigger (macam select) + popup date selector ──
  function checkedDateIndex() {
    for (var i = 0; i < _allRadios.length; i++) {
      if (_allRadios[i].checked) return i;
    }
    return 0;
  }

  function renderDateTrigger() {
    _dateTrigger = document.createElement("button");
    _dateTrigger.type = "button";
    _dateTrigger.id = "rcDateTrigger";
    _dateTrigger.className = "rc-date-trigger";
    _dateTrigger.setAttribute("aria-haspopup", "dialog");
    _dateTrigger.innerHTML =
      '<span class="rc-date-trigger-text"></span><i class="ti ti-chevron-down"></i>';
    _dateTrigger.addEventListener("click", openDateModal);
    gdSel.appendChild(_dateTrigger);
  }

  // ── Cruise: tarikh terpilih = teks BOLD statik (TIADA butang trigger) ──
  // Butang "select date" dibuang daripada booking card cruise — penukaran
  // tarikh hanya melalui modal Change Date (kad showcase). Struktur span
  // .rc-date-trigger-text dikekalkan supaya updateDateTriggerLabel() sama
  // guna bila tarikh bertukar.
  function renderChosenDateLabel() {
    _dateTrigger = document.createElement("div");
    _dateTrigger.className = "rc-date-chosen";
    _dateTrigger.innerHTML =
      '<strong><span class="rc-date-trigger-text"></span></strong>';
    gdSel.appendChild(_dateTrigger);
  }

  function updateDateTriggerLabel() {
    if (!_dateTrigger) return;
    var meta = _dateMeta[checkedDateIndex()] || { dateText: "", seatsHtml: "" };
    _dateTrigger.querySelector(".rc-date-trigger-text").innerHTML =
      esc(meta.dateText) + meta.seatsHtml;
  }

  // Pilih tarikh (dari modal / popup sidebar) → sync radio hidden →
  // refresh trigger + information card + pakej. Bila URL sedia bawa param
  // date/package, URL semasa turut dikemas kini (?date=).
  function selectDate(idx) {
    Array.prototype.forEach.call(_allRadios, function (r, i) {
      r.checked = i === idx;
    });
    updateDateTriggerLabel();
    markModalActiveItem();
    // URL sync SENTIASA pada navigasi user (params lain kekal): tarikh
    // kini + kosongkan package lama — auto-select pakej tarikh baharu
    // akan isi semula (syncUrlParams buang key bila value kosong).
    syncUrlParams({
      date: (groupDatesData[idx] || {}).name || "",
      package: "",
    });
    renderDateCards();
    // Kategori tarikh terpilih mungkin berubah — seksyen Other Categories
    // di-render semula (kategori baru hilang daripada senarai).
    renderOtherCats();
    populatePackages();
  }

  // ── Seksyen "Dates & Packages" — kad "selected departure" + penukar
  // pakej satu-langkah. Booking card sidebar kini paparan sahaja (tarikh
  // bold, tiada pemilih pakej), jadi kad INI ialah permukaan interaktif
  // tarikh/pakej untuk page cruise:
  //   header  : eyebrow "Selected Departure" + chip Trip Category + seats
  //   hero    : tarikh (besar) + badge duration
  //   sailing : blok sailing date/kapal/port (cruise)
  //   pakej   : BUTANG per pakej — row aktif = pakej terpilih; klik terus
  //             selectPackage() (tanpa buka modal)
  //   footer  : "Change Date (N)" bila ada pilihan bermakna; hint terkunci
  //             bila deep-link kategori pin tarikh tanpa sibling
  // Penukaran tarikh kekal melalui modal (senarai tapisan kategori). ──
  function renderDateCards() {
    if (!dateCardsEl) return;
    dateCardsEl.innerHTML = "";
    if (!groupDatesData.length) {
      dateCardsEl.innerHTML = '<p class="rc-muted">No dates available.</p>';
      return;
    }
    var idx = checkedDateIndex();
    var gdInfo = groupDatesData[idx] || {};
    var metaInfo = _dateMeta[idx] || { dateText: "", seatsHtml: "" };

    var durInfo = fmtDuration(gdInfo.total_days, gdInfo.total_nights);

    // Header: KIRI = eyebrow "Selected Departure" + tarikh hero di bawahnya;
    // KANAN-ATAS = stack badge [kategori → duration → seats] (chip kategori
    // float top-right, duration bawahnya — arahan pemilik, Nov 2026).
    var headLeft = '<span class="rc-datecard-eyebrow">Selected Departure</span>'
      + '<span class="rc-datecard-date">' + esc(metaInfo.dateText) + '</span>';
    var topRight = "";
    if (gdInfo.trip_category) {
      topRight += '<span class="rc-datecard-cat"><i class="ti ti-tag"></i> '
        + esc(gdInfo.trip_category) + '</span>';
    }
    if (durInfo) {
      topRight += '<span class="rc-datecard-duration"><i class="ti ti-clock-2"></i> '
        + esc(durInfo) + '</span>';
    }
    if (metaInfo.seatsHtml) {
      topRight += '<span class="rc-datecard-seats">' + metaInfo.seatsHtml + '</span>';
    }

    // Chips inklusi pakej khas (badge "Special Package" DIBUANG — chips
    // flight/hotel/transport/meal kekal sebagai maklumat inklusi).
    var headChips = "";
    if (gdInfo.is_special) {
      (gdInfo.inclusions || []).forEach(function (k) {
        var inc = INCLUSION_META[k];
        if (inc) {
          headChips += '<span class="rc-datecard-chip"><i class="ti ' + inc.icon + '"></i> ' + esc(inc.label) + '</span>';
        }
      });
    }

    // Seksyen Actual Sailing Date — hanya bila sailing date tersedia
    // (trip cruise): tarikh pelayaran sebenar + info kapal & port
    // embarkasi/disembarkasi. Bila tiada sailing (pakej darat), seksyen
    // ini tidak dipapar. (Wrapper col vestigial dibuang — blok penuh.)
    var sailHtml = "";
    if (gdInfo.sailing_start) {
      var sailShip = "";
      if (gdInfo.sailing_label && gdInfo.sailing_label.indexOf("·") >= 0) {
        sailShip = gdInfo.sailing_label.split("·").pop().trim();
      }
      var sailDates = _fmtWebDate(gdInfo.sailing_start)
        + (gdInfo.sailing_end ? " → " + _fmtWebDate(gdInfo.sailing_end) : "");
      var ports = [];
      if (gdInfo.embarkation_port) ports.push(gdInfo.embarkation_port);
      if (gdInfo.disembarkation_port) ports.push(gdInfo.disembarkation_port);
      sailHtml =
        '<div class="rc-sailinfo">'
        + '<div class="rc-sailinfo-title"><i class="ti ti-ship"></i> Sailing Date</div>'
        + '<div class="rc-sailinfo-dates">' + esc(sailDates) + '</div>'
        + (ports.length
          ? '<div class="rc-sailinfo-meta"><i class="ti ti-anchor"></i> '
            + esc(ports[0]) + (ports[1] ? " → " + esc(ports[1]) : "")
            + '</div>'
          : "")
        + (sailShip ? '<div class="rc-sailinfo-meta"><i class="ti ti-ship"></i> ' + esc(sailShip) + '</div>' : '')
        + '</div>';
    }

    // Pakej tarikh ini — BUTANG pilih terus (satu langkah, tanpa modal).
    // Row aktif = pakej terpilih semasa (padan _selectedPkg + TGD-nya —
    // varian pakej sama nama boleh wujud pada TGD berlainan).
    var pkgsInfo = (DATA.trip_packages || {})[gdInfo.name] || [];
    var pkgRows = pkgsInfo.map(function (p) {
      var type = (p.package_type || "").trim() || p.package_name || p.name;
      var cruiseOnly = !!p.is_cruise_only;
      var dep = cruiseOnly ? (p.sailing_start || p.departure_date) : (p.departure_date || p.sailing_start);
      var ret = cruiseOnly ? (p.sailing_end || p.return_date) : (p.return_date || p.sailing_end);
      var metaBits = [];
      if (dep) metaBits.push('<span><i class="ti ti-plane-departure"></i> ' + esc(_fmtWebDate(dep)) + '</span>');
      if (ret) metaBits.push('<span><i class="ti ti-plane-arrival"></i> ' + esc(_fmtWebDate(ret)) + '</span>');
      var d = pkgDuration(p);
      if (d) metaBits.push('<span><i class="ti ti-clock-2"></i> ' + esc(d) + '</span>');
      var curBadge = (p.currency && p.currency !== LISTING_CURRENCY)
        ? ' <span class="rc-pkg-badge rc-pkg-badge-cur">' + esc(p.currency_symbol || p.currency) + " " + esc(p.currency) + '</span>'
        : "";
      var isActive = _selectedPkg === p.name && _selectedPkgGd === p.trip_group_date;
      return '<button type="button" class="rc-dtpkg-row'
        + (isActive ? ' rc-dtpkg-row-active' : '')
        + '" aria-pressed="' + (isActive ? "true" : "false") + '">'
        + '<span class="rc-dtpkg-name">' + esc(type) + curBadge + '</span>'
        + (metaBits.length ? '<span class="rc-dtpkg-meta">' + metaBits.join("") + '</span>' : '')
        + '</button>';
    }).join("");

    // Footer kad: butang "Change Date" + kiraan tarikh boleh dipapar
    // (ikut tapisan kategori). Bila tiada pilihan bermakna:
    //   - deep-link kategori terpinned tanpa sibling → hint terkunci
    //     (jelaskan kenapa tiada butang)
    //   - trip memang 1 tarikh sahaja → tiada footer (modal 1 item = bising)
    var _catIdxs = categoryFilterIdxs();
    var _visCount = visibleDateIdxs().length;
    var showChangeBtn = _visCount > 1;
    var showLocked = !!_catIdxs && _catIdxs.length <= 1;
    var footerHtml = showChangeBtn
      ? '<div class="rc-dtpkg-footer">'
        +   '<button type="button" class="rc-datecard-change">'
        +     '<i class="ti ti-calendar-month"></i> Change Date'
        +     '<span class="rc-datecard-count">' + _visCount + '</span>'
        +   '</button>'
        + '</div>'
      : (showLocked
        ? '<div class="rc-dtpkg-footer"><p class="rc-datecard-locked">'
          +   '<i class="ti ti-lock"></i> Date pinned — no other departures in this category'
          + '</p></div>'
        : "");

    // Blok pakej (radio select): papar HANYA bila tarikh ini ada LEBIH
    // DARI 1 pakej. Satu pakej → auto-select senyap tanpa seksyen (tiada
    // maklumat pakej dipapar); tiada pakej → tiada seksyen.
    var pkgBlockHtml = pkgsInfo.length > 1
      ? '<div class="rc-dtpkg-block">'
        +   '<div class="rc-dtpkg-blocktitle"><i class="ti ti-luggage"></i> '
        +     'Packages (' + pkgsInfo.length + ')</div>'
        +   pkgRows
        + '</div>'
      : "";

    var info = document.createElement("article");
    info.className = "rc-datecard-info";
    info.innerHTML =
      '<span class="rc-datecard-head">'
      +   '<span class="rc-datecard-headleft">' + headLeft + '</span>'
      +   (topRight ? '<span class="rc-datecard-topright">' + topRight + '</span>' : '')
      + '</span>'
      + sailHtml
      + (headChips ? '<span class="rc-datecard-inclusions">' + headChips + '</span>' : '')
      + pkgBlockHtml
      + footerHtml;
    var changeBtn = info.querySelector(".rc-datecard-change");
    if (changeBtn) {
      changeBtn.addEventListener("click", function () {
        openChangeDateModal();
      });
    }
    // Pilih pakej terus dari kad (satu langkah) — selectPackage sync state
    // + URL (?package=) + highlight row (card re-render dalam hook-nya).
    // Row ikut SUSUNAN pkgsInfo — tiada data-attr interpolasi diperlukan.
    Array.prototype.forEach.call(
      info.querySelectorAll(".rc-dtpkg-row"),
      function (rowBtn, i) {
        var p = pkgsInfo[i];
        if (!p) return;
        rowBtn.addEventListener("click", function () {
          selectPackage(p.name, p.trip_group_date, p);
        });
      }
    );
    dateCardsEl.appendChild(info);
  }

  // ── Seksyen "Other Categories" (selepas FAQ, cruise sahaja) ──
  // Kategori travel-date LAIN selain kategori tarikh TERPILIH — cermun
  // DateCards + modal Change Date yang merangkumi kategori semasa.
  // >1 kategori lain → tab pill (label + kiraan tarikh); 1 → senarai
  // terus dengan eyebrow nama kategori. Tiada kategori lain → seksyen
  // kekal hidden. Tarikh TANPA kategori tidak digroup di sini (masih
  // boleh dicapai melalui modal Change Date tanpa tapisan).
  var _lastCatTab = "";  // tab aktif terakhir — dikekalkan merentasi render
  function renderOtherCats() {
    if (!otherCatsSection || !otherCatsEl) return;
    var curCat = (groupDatesData[checkedDateIndex()] || {}).trip_category || "";
    // Kategori ikut kemunculan pertama (group_dates sudah kronologi —
    // kategori tersusun ikut tarikh berlepas terawalnya).
    var seen = {};
    var cats = [];
    groupDatesData.forEach(function (g) {
      var c = g.trip_category || "";
      if (!c || seen[c]) return;
      seen[c] = 1;
      cats.push(c);
    });
    var others = cats.filter(function (c) { return c !== curCat; });
    if (!others.length) {
      otherCatsSection.hidden = true;
      otherCatsEl.innerHTML = "";
      return;
    }
    otherCatsSection.hidden = false;

    // Tab aktif: tab terakhir user (kalau masih wujud), else kategori
    // lain pertama. Bila kategori terpilih berubah, tab lama mungkin
    // jadi kategori semasa — fallback ke tab pertama.
    var activeCat = (_lastCatTab && others.indexOf(_lastCatTab) >= 0)
      ? _lastCatTab
      : others[0];
    _lastCatTab = activeCat;

    // Senarai tarikh per kategori — susunan kronologi kekal (filter
    // groupDatesData tanpa ubah susunan; index = index penuh senarai).
    function catListHtml(cat) {
      var rows = "";
      groupDatesData.forEach(function (g, idx) {
        if ((g.trip_category || "") !== cat) return;
        var meta = _dateMeta[idx] || { dateText: "", seatsHtml: "" };
        var pkgsCount = ((DATA.trip_packages || {})[g.name] || []).length;
        var dur = fmtDuration(g.total_days, g.total_nights);
        var metaBits = [];
        if (meta.seatsHtml) metaBits.push('<span class="rc-catdate-seats">' + meta.seatsHtml + '</span>');
        if (dur) metaBits.push('<span><i class="ti ti-clock-2"></i> ' + esc(dur) + '</span>');
        metaBits.push('<span><i class="ti ti-luggage"></i> '
          + pkgsCount + (pkgsCount === 1 ? " package" : " packages") + '</span>');
        rows +=
          '<button type="button" class="rc-catdate-item" data-idx="' + idx + '"'
          + ' aria-label="Select departure in ' + esc(cat) + '">'
          +   '<span class="rc-catdate-date">' + esc(meta.dateText) + '</span>'
          +   (g.is_special
            ? '<span class="rc-catdate-flag" title="Special Package">'
              + '<i class="ti ti-star-filled"></i></span>'
            : "")
          +   '<span class="rc-catdate-meta">' + metaBits.join("") + '</span>'
          +   '<span class="rc-catdate-go"><i class="ti ti-chevron-right"></i></span>'
          + '</button>';
      });
      return '<div class="rc-catlist" data-cat="' + esc(cat) + '"'
        + (cat === activeCat ? '' : ' hidden') + '>' + rows + '</div>';
    }

    var html = "";
    if (others.length > 1) {
      html += '<div class="rc-cattabs">';
      others.forEach(function (cat) {
        var count = groupDatesData.filter(function (g) {
          return (g.trip_category || "") === cat;
        }).length;
        html += '<button type="button" class="rc-cattab'
          + (cat === activeCat ? ' rc-cattab-active' : '')
          + '" data-cat="' + esc(cat) + '"'
          + ' aria-pressed="' + (cat === activeCat ? "true" : "false") + '">'
          + esc(cat) + ' <span class="rc-cattab-count">' + count + '</span>'
          + '</button>';
      });
      html += '</div>';
    } else {
      html += '<span class="rc-catlist-eyebrow">' + esc(others[0]) + '</span>';
    }
    others.forEach(function (cat) { html += catListHtml(cat); });
    otherCatsEl.innerHTML = html;

    // Tab click — toggel senarai (client-side sahaja; pilihan tarikh
    // tidak berubah sehingga row tarikh diklik).
    Array.prototype.forEach.call(
      otherCatsEl.querySelectorAll(".rc-cattab"),
      function (tab) {
        tab.addEventListener("click", function () {
          var cat = tab.getAttribute("data-cat");
          _lastCatTab = cat;
          Array.prototype.forEach.call(
            otherCatsEl.querySelectorAll(".rc-cattab"), function (t) {
              var on = t === tab;
              t.classList.toggle("rc-cattab-active", on);
              t.setAttribute("aria-pressed", on ? "true" : "false");
            });
          Array.prototype.forEach.call(
            otherCatsEl.querySelectorAll(".rc-catlist"), function (l) {
              var on = l.getAttribute("data-cat") === cat;
              if (on) l.removeAttribute("hidden");
              else l.setAttribute("hidden", "");
            });
        });
      });

    // Row click — pilih tarikh itu (selectDate sync radio + URL ?date= +
    // DateCards) dan gulung ke booking panel supaya user nampak kesan.
    var bookingCard = document.getElementById("rcBookingCard");
    Array.prototype.forEach.call(
      otherCatsEl.querySelectorAll(".rc-catdate-item"),
      function (row) {
        row.addEventListener("click", function () {
          selectDate(parseInt(row.getAttribute("data-idx"), 10));
          if (bookingCard && bookingCard.scrollIntoView) {
            bookingCard.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        });
      });
  }

  // ── Bootstrap modal helpers (fallback: toggle class legacy jika
  //    bootstrap bundle gagal dimuat) ──
  // Markup modal mesti struktur BS: .modal.fade > .modal-dialog >
  // .modal-content.rc-datemodal-card (skin jenama kekal di css).
  function rcModalInstance(modalEl) {
    if (window.bootstrap && window.bootstrap.Modal) {
      return window.bootstrap.Modal.getOrCreateInstance(modalEl);
    }
    return null;
  }
  function rcShowModal(modalEl) {
    var inst = rcModalInstance(modalEl);
    if (inst) { inst.show(); return; }
    modalEl.classList.add("rc-datemodal-show"); // fallback legacy
  }
  function rcHideModal(modalEl, onHidden) {
    var inst = rcModalInstance(modalEl);
    if (inst) {
      if (onHidden) {
        modalEl.addEventListener("hidden.bs.modal", function h() {
          modalEl.removeEventListener("hidden.bs.modal", h);
          onHidden();
        });
      }
      inst.hide();
      return;
    }
    modalEl.classList.remove("rc-datemodal-show"); // fallback legacy
    if (onHidden) onHidden();
  }
  // Bangun cangkang modal BS + pulangkan { modal, dialog, card }.
  // contentElClass = class visual kad (skin jenama di css).
  function rcBuildModal(id, contentElClass) {
    var modal = document.createElement("div");
    modal.id = id;
    modal.className = "modal fade rc-datemodal";
    modal.tabIndex = -1;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-hidden", "true");

    var dialog = document.createElement("div");
    dialog.className = "modal-dialog modal-dialog-centered";

    var card = document.createElement("div");
    card.className = "modal-content " + contentElClass;

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rc-datemodal-close";
    closeBtn.setAttribute("data-bs-dismiss", "modal");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = "&times;";

    dialog.appendChild(card);
    modal.appendChild(dialog);
    return { modal: modal, dialog: dialog, card: card, closeBtn: closeBtn };
  }

  function markModalActiveItem() {
    if (!_dateModal) return;
    var idx = checkedDateIndex();
    Array.prototype.forEach.call(_dateModal.querySelectorAll(".rc-datemodal-item"), function (item) {
      item.classList.toggle(
        "rc-datemodal-item-active",
        parseInt(item.getAttribute("data-idx"), 10) === idx
      );
    });
  }

  function openDateModal() {
    if (!_dateModal) return;
    markModalActiveItem();
    rcShowModal(_dateModal);
  }

  function closeDateModal() {
    if (_dateModal) rcHideModal(_dateModal);
  }

  // ── Modal "Change Date" (dibuka dari butang Change Date kad showcase) ──
  // TARIKH SAHAJA — tiada logik pakej (pakej dipilih pada row kad Dates &
  // Packages; peraturan kategori deep-link terus mengawal set tarikh via
  // visibleDateIdxs). LIST VIEW dua-bahagian (skrin lebar):
  //   kiri  — rail menegak pilihan bulan-tahun ("All Months" + setiap
  //           bulan, dengan kiraan tarikh);
  //   kanan — hasil tapisan bulan terpilih (baris tarikh, skin datemodal).
  // Skrin kecil (<641px): dropdown tapis + senarai (susunan menegak).
  // Klik item → selectDate (state page + URL ?date=) dan modal tutup
  // terus. Modal seluas wrap container (sedikit lebih kecil).
  var _changeModal = null;

  function openChangeDateModal() {
    closeChangeDateModal();
    var shell = rcBuildModal("rcChangeModal", "rc-datemodal-card rc-changemodal-card");
    shell.dialog.classList.add("rc-changemodal-dialog");
    var modal = shell.modal;
    var card = shell.card;
    card.appendChild(shell.closeBtn);

    // ── Data tarikh boleh papar (peraturan kategori sedia ada sahaja) ──
    var selIdx = checkedDateIndex();
    var selCat = (groupDatesData[selIdx] || {}).trip_category || "";
    function parseYMD(iso) {
      var m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
      return isNaN(d.getTime()) ? null : d;
    }
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    var items = visibleDateIdxs().map(function (idx) {
      var gd = groupDatesData[idx] || {};
      var meta = _dateMeta[idx] || { dateText: "", seatsHtml: "", startIso: "" };
      var start = parseYMD(gd.departure_date || gd.sailing_start || meta.startIso);
      if (!start) start = parseYMD(meta.startIso);
      if (!start) return null;
      var end = parseYMD(gd.return_date || (is_cruise ? gd.sailing_end : "")) || start;
      return {
        idx: idx, gd: gd, meta: meta,
        ymKey: start.getFullYear() + "-" + pad2(start.getMonth() + 1),
      };
    }).filter(Boolean);
    if (!items.length) return;  // tiada tarikh sah — jangan buka modal kosong

    // Label dewasa (price_adult) — dari PRICE_LABELS (Travel Settings);
    // fallback sama seperti getDefaultPriceLabels().
    var adultCfg = PRICE_LABELS.find(function (l) { return l.price_key === "price_adult"; });
    var adultLabel = (adultCfg && adultCfg.display_label)
      || (TRIP_TYPE === "cruise" ? "Main Adult" : "Adult");
    function fmtSym(sym, a) {
      a = Number(a) || 0;
      return (sym || "") + " " + Math.round(a).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      });
    }
    // Baris harga "from" per tarikh (price_adult termurah offer tarikh
    // itu — server new_catalog.get_trip_detail_new). Promo Travel Price
    // Rule → badge label + harga asal strikethrough. Tarikh tanpa harga
    // (trip legacy fallback) → tiada baris.
    function priceLineHtml(it) {
      var gd = it.gd;
      if (gd.price_from == null || !(Number(gd.price_from) > 0)) return "";
      var sym = gd.price_from_symbol || gd.price_from_currency || "";
      var orig = (gd.price_from_original != null
          && Number(gd.price_from_original) > Number(gd.price_from))
        ? '<s class="rc-price-was">' + esc(fmtSym(sym, gd.price_from_original)) + '</s>'
        : "";
      var promo = gd.price_from_promo_label
        ? '<span class="rc-promo-badge"><i class="ti ti-rosette-discount"></i> '
          + esc(gd.price_from_promo_label) + '</span>'
        : "";
      return '<span class="rc-changemodal-itemprice">'
        + '<span class="rc-changemodal-itemprice-label">' + esc(adultLabel) + '</span>'
        + '<span class="rc-changemodal-itemprice-value">from <b>'
        + esc(fmtSym(sym, gd.price_from)) + '</b>' + orig + '</span>'
        + promo
        + '</span>';
    }

    var months = [];
    items.forEach(function (it) {
      if (months.indexOf(it.ymKey) < 0) months.push(it.ymKey);
    });
    months.sort();

    // ── Header: kiri = title + subtitle (nama trip); KANAN-ATAS = badge
    // kategori (float top-right — selari kad Dates & Packages) ──
    var head = document.createElement("div");
    head.className = "rc-changemodal-head";
    var headLeft = document.createElement("div");
    headLeft.className = "rc-changemodal-headleft";
    var title = document.createElement("h3");
    title.className = "rc-datemodal-title";
    title.textContent = "Change Date";
    headLeft.appendChild(title);
    if (DATA.trip_name) {
      var subtitle = document.createElement("p");
      subtitle.className = "rc-changemodal-subtitle";
      subtitle.textContent = DATA.trip_name;
      headLeft.appendChild(subtitle);
    }
    head.appendChild(headLeft);
    if (selCat) {
      var catBadge = document.createElement("span");
      catBadge.className = "rc-datecard-cat rc-changemodal-cat";
      catBadge.innerHTML = '<i class="ti ti-tag"></i> ' + esc(selCat);
      head.appendChild(catBadge);
    }
    card.appendChild(head);

    // ── List view: rail bulan (kiri) + hasil tapisan (kanan) ──
    var filterYm = "__all__";

    var body = document.createElement("div");
    body.className = "rc-changemodal-body";

    // Dropdown tapis — SKRIN KECIL sahaja (CSS sembunyikan pada ≥641px)
    var filter = document.createElement("div");
    filter.className = "rc-changemodal-filter";
    var sel = document.createElement("select");
    sel.className = "rc-changemodal-select";
    sel.setAttribute("aria-label", "Filter by departure month");
    sel.appendChild(new Option("All months", "__all__"));
    months.forEach(function (ym) {
      var parts = ym.split("-");
      sel.appendChild(new Option(
        _RC_MONTHS_FULL[parseInt(parts[1], 10) - 1] + " " + parts[0], ym));
    });
    filter.appendChild(sel);

    // Dua kolum: rail menegak (kiri) + senarai tarikh (kanan)
    var columns = document.createElement("div");
    columns.className = "rc-changemodal-columns";

    var rail = document.createElement("div");
    rail.className = "rc-changemodal-rail";
    function railBtn(value, label, count) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rc-changemodal-railbtn";
      btn.setAttribute("data-ym", value);
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = '<span class="rc-changemodal-railbtn-label">' + esc(label) + '</span>'
        + '<span class="rc-changemodal-railbtn-count">' + count + '</span>';
      btn.addEventListener("click", function () {
        filterYm = value;
        applyFilter();
      });
      return btn;
    }
    rail.appendChild(railBtn("__all__", "All Months", items.length));
    months.forEach(function (ym) {
      var parts = ym.split("-");
      var count = items.filter(function (it) { return it.ymKey === ym; }).length;
      rail.appendChild(railBtn(ym,
        _RC_MONTHS_FULL[parseInt(parts[1], 10) - 1] + " " + parts[0], count));
    });

    var list = document.createElement("div");
    list.className = "rc-datemodal-list rc-changemodal-dates";
    items.forEach(function (it) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "rc-datemodal-item"
        + (it.idx === selIdx ? " rc-datemodal-item-active" : "");
      item.setAttribute("data-idx", it.idx);
      item.setAttribute("data-month", it.ymKey);
      item.innerHTML =
        '<span class="rc-datemodal-item-text"><b class="rc-datemodal-item-date">'
        + esc(it.meta.dateText) + '</b>' + it.meta.seatsHtml + '</span>'
        + (it.gd.is_special
          ? '<span class="rc-changemodal-flag"><i class="ti ti-star-filled"></i></span>'
          : "")
        + priceLineHtml(it);
      item.addEventListener("click", function () {
        selectDate(it.idx);
        closeChangeDateModal();
      });
      list.appendChild(item);
    });

    columns.appendChild(rail);
    columns.appendChild(list);
    body.appendChild(filter);
    body.appendChild(columns);
    card.appendChild(body);

    function applyFilter() {
      Array.prototype.forEach.call(
        rail.querySelectorAll(".rc-changemodal-railbtn"), function (btn) {
          var on = btn.getAttribute("data-ym") === filterYm;
          btn.classList.toggle("rc-changemodal-railbtn-active", on);
          btn.setAttribute("aria-pressed", on ? "true" : "false");
        });
      sel.value = filterYm;
      Array.prototype.forEach.call(
        list.querySelectorAll(".rc-datemodal-item"), function (item) {
          item.style.display =
            filterYm === "__all__" || item.getAttribute("data-month") === filterYm
              ? "" : "none";
        });
    }
    sel.addEventListener("change", function () {
      filterYm = sel.value;
      applyFilter();
    });
    applyFilter();

    document.body.appendChild(modal);
    _changeModal = modal;
    rcShowModal(modal);
  }

  function closeChangeDateModal() {
    if (_changeModal) {
      var _m = _changeModal;
      _changeModal = null;
      rcHideModal(_m, function () {
        if (window.bootstrap && window.bootstrap.Modal && _m.parentNode) {
          window.bootstrap.Modal.getInstance(_m).dispose();
        }
        if (_m.parentNode) _m.parentNode.removeChild(_m);
      });
    }
  }

  function renderDateModal() {
    var existing = document.getElementById("rcDateModal");
    if (existing) existing.parentNode.removeChild(existing);

    var shell = rcBuildModal("rcDateModal", "rc-datemodal-card");
    var modal = shell.modal;
    var card = shell.card;
    card.appendChild(shell.closeBtn);

    var title = document.createElement("h3");
    title.className = "rc-datemodal-title";
    title.textContent = "Choose Departure Date";

    // ── Filter bulan: chip "All" + bulan unik (sisih kronologi) ──
    var filters = document.createElement("div");
    filters.className = "rc-datemodal-filters";
    var months = [];
    var _seenMonth = {};
    // Bulan dari tarikh BOLEH PAPAR sahaja (deep-link kategori → bulan
    // kategori itu; tanpa tapisan = semua bulan seperti sedia ada).
    visibleDateIdxs().forEach(function (idx) {
      var meta = _dateMeta[idx];
      var key = monthKey(meta.startIso);
      if (key && !_seenMonth[key]) {
        _seenMonth[key] = 1;
        months.push({ key: key, label: monthLabel(key) });
      }
    });
    function makeChip(key, label) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "rc-datemodal-chip";
      chip.textContent = label;
      chip.setAttribute("data-month", key);
      chip.addEventListener("click", function () {
        Array.prototype.forEach.call(filters.querySelectorAll(".rc-datemodal-chip"), function (c) {
          c.classList.remove("rc-datemodal-chip-active");
        });
        chip.classList.add("rc-datemodal-chip-active");
        Array.prototype.forEach.call(modal.querySelectorAll(".rc-datemodal-item"), function (item) {
          item.style.display =
            key === "__all__" || item.getAttribute("data-month") === key ? "" : "none";
        });
      });
      return chip;
    }
    var chipAll = makeChip("__all__", "All");
    chipAll.classList.add("rc-datemodal-chip-active");
    filters.appendChild(chipAll);
    months.forEach(function (mo) { filters.appendChild(makeChip(mo.key, mo.label)); });

    // ── Senarai tarikh: butang per tarikh + ikon pesawat (pilihan flight) ──
    var list = document.createElement("div");
    list.className = "rc-datemodal-list";
    var anyFlight = false;
    // Deep-link kategori aktif → butang tarikh kategori sama SAHAJA
    // (data-idx kekal index penuh — selectDate/markModalActiveItem tak
    // berubah). Tanpa tapisan: semua tarikh seperti sedia ada.
    visibleDateIdxs().forEach(function (idx) {
      var meta = _dateMeta[idx];
      if (meta.hasFlight) anyFlight = true;
      var item = document.createElement("button");
      item.type = "button";
      item.className = "rc-datemodal-item";
      item.setAttribute("data-idx", idx);
      item.setAttribute("data-month", monthKey(meta.startIso));
      var flightTitle = is_cruise
        ? "Cruise with flight option available"
        : "Flight option available";
      item.innerHTML =
        '<span class="rc-datemodal-item-text">' + esc(meta.dateText) + meta.seatsHtml + '</span>'
        + (meta.hasFlight
          ? '<i class="ti ti-plane rc-datemodal-flight" title="' + esc(flightTitle)
            + '" aria-label="' + esc(flightTitle) + '"></i>'
          : "");
      item.addEventListener("click", function () {
        selectDate(idx);
        closeDateModal();
      });
      list.appendChild(item);
    });

    card.appendChild(title);
    // Filter bulan hanya bila tarikh merentasi >1 bulan (selain "All" tak
    // berguna bila semua tarikh dalam bulan sama).
    if (months.length > 1) card.appendChild(filters);
    card.appendChild(list);
    // Legend hanya dipapar bila ada sekurang-kurangnya satu tarikh flight.
    if (anyFlight) {
      var legend = document.createElement("p");
      legend.className = "rc-datemodal-legend";
      legend.innerHTML = '<i class="ti ti-plane"></i> '
        + esc(is_cruise ? "Cruise with flight available" : "Flight option available");
      card.appendChild(legend);
    }

    document.body.appendChild(modal);
    _dateModal = modal;
  }

  // ════ STEP 3: Load packages for selected date ════
  // SATU radio tarikh = SATU Travel Date / TGD (ID dokumen) — pakej
  // diambil terus dari trip_packages[kunci tarikh]. Varian pakej (fly
  // cruise / cruise only / durasi berbeza) dalam Travel Date yang sama
  // dipapar sebagai butang pakej sendiri; Travel Date lain — walaupun
  // berkongsi tarikh berlepas atau sailing — kekal pilihan tarikh
  // berasingan.
  function populatePackages() {
    if (pkgSel) pkgSel.innerHTML = '<p class="rc-muted">Loading packages…</p>';
    _selectedPkg = "";
    _selectedPkgGd = "";
    _selectedPkgData = null;
    cabinsEl.className = "rc-cabins-empty";
    cabinsEl.innerHTML = '<p class="rc-muted">Pick a package to see room options and prices.</p>';
    updateBookLink();

    var dateValue = getSelectedDateValue();
    if (!dateValue) {
      if (pkgSel) pkgSel.innerHTML = '<p class="rc-muted">Pick a date first.</p>';
      return;
    }

    var gdId = getSelectedGroupDateId();
    var preloaded = DATA.trip_packages || {};

    // Pakej terus dari kunci tarikh terpilih (Travel Date / TGD) —
    // satu tarikh = satu kumpulan berlepas; tiada union merentasi tarikh.
    var pkgs = preloaded[gdId] || null;

    if (pkgs && pkgs.length) {
      renderPackageButtons(pkgs);
      return;
    }

    // Fallback: AJAX fetch if preloaded data is missing
    var parts = dateValue.split(":");
    var startDate = parts[0];
    var endDate = parts[1] || "";

    var url = "/api/method/travel_booking.api.pricing.search_packages_by_date"
      + "?start_date=" + encodeURIComponent(startDate)
      + "&end_date=" + encodeURIComponent(endDate)
      + "&trip=" + encodeURIComponent(DATA.trip_master || "");

    fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (res) {
        var pkgs = (res && res.message) ? res.message : res;
        renderPackageButtons(pkgs);
      })
      .catch(function () {
        if (pkgSel) pkgSel.innerHTML = '<p class="rc-muted">Couldn\x27t load packages. Please try again.</p>';
      });
  }

  function renderPackageButtons(pkgs) {
    // Cruise (pkgSel null): butang pakej TIDAK dirender — auto-select di
    // bawah tetap jalan supaya Price Info + Book Now terus hidup; penukaran
    // pakej melalui modal Change Date. Tour (pkgSel ada): seperti sedia ada.
    if (pkgSel) {
      pkgSel.innerHTML = "";
      if (!pkgs || !pkgs.length) {
        pkgSel.innerHTML = '<p class="rc-muted">No packages available for this date.</p>';
        return;
      }
    } else if (!pkgs || !pkgs.length) {
      return;
    }
    pkgs.forEach(function (p) {
      _pkgMap[p.name + "|" + p.trip_group_date] = p;
      // Cruise: tiada butang pakej dirender (pkgSel null) — _pkgMap sahaja
      // diperlukan untuk lookup state pakej.
      if (!pkgSel) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rc-pkg-btn";
      btn.setAttribute("data-value", p.name);
      btn.setAttribute("data-gd-id", p.trip_group_date);
      // Tajuk butang = JENIS pakej sahaja ("Cruise + Flight" / "Cruise Only" /
      // "Ground Only" / "Fly Package" / "Customed") — BUKAN nama pakej penuh
      // (package_title/trip_group_name dah mengandungi nama trip + tarikh +
      // jenis yang bertindih). KECUALI: trip cruise yang BUKAN cruise-only —
      // jenis + " from " + kod lapangan terbang (p.flight = link airport_form,
      // namanya sendiri kod IATA cth "KUL"). Fallback nama pakej bila jenis
      // kosong.
      var type = (p.package_type || "").trim() || p.package_name || p.name;
      var labelHtml;
      if (is_cruise && !p.is_cruise_only && p.flight) {
        labelHtml = esc(type) + " from <b>" + esc(p.flight) + "</b>";
      } else {
        labelHtml = esc(type);
      }
      // Badge currency native pakej (paksi multi-company) — dipapar bila
      // currency pakej BERBEZA dari currency listing aktif (cth fallback
      // native page detail trip MYR semasa browse SGD).
      if (p.currency && p.currency !== LISTING_CURRENCY) {
        labelHtml += ' <span style="display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;background:rgba(0,0,0,.06);vertical-align:middle;">' + esc(p.currency_symbol || p.currency) + " " + esc(p.currency) + '</span>';
      }
      // [BUANG Nov 2026] Badge "Ground Arrangement Included/Not Included"
      // — dibuang daripada baris pakej (arahan pemilik); info GA tidak
      // lagi dipaparkan pada pemilih pakej.
      // Meta varian dipapar DALAM setiap butang — departure/return, duration.
      // Susunan ikut reka bentuk rujukan:
      //   [radio]  Tajuk pakej (bold)
      //            Departure          29 Sep 2026
      //            Return             12 Oct 2026
      //            Duration           1D/10N
      btn.innerHTML = '<span><div class="rc-pkg-head"><div class="rc-pkg-title">' + labelHtml + '</div></div>' + pkgMetaHtml(p) + '</span>';
      btn.addEventListener("click", function () { selectPackage(p.name, p.trip_group_date, p); });
      pkgSel.appendChild(btn);
    });
    // (auto-select di bawah jalan untuk tour DAN cruise)
    var _wishMatch = _wishPkg
      ? pkgs.find(function (p) { return p.name === _wishPkg && (!_wishGd || p.trip_group_date === _wishGd); })
      : null;
    if (!_wishMatch && _wishPkg) {
      _wishMatch = pkgs.find(function (p) { return p.name === _wishPkg; });
    }
    // Kekalkan pilihan semasa bila ia masih sah dalam senarai pakej tarikh
    // ini — penting selepas fetch populatePackages selesai LEBIH LAMBAT
    // dari pilihan user dalam modal Change Date (elak auto-select pkgs[0]
    // menulis guli pilihan yang baru dibuat).
    var _selMatch = (_selectedPkg && _selectedPkgGd)
      ? pkgs.find(function (p) {
          return p.name === _selectedPkg && p.trip_group_date === _selectedPkgGd;
        })
      : null;
    var _initPkg = _wishMatch || _selMatch || pkgs[0];
    _wishPkg = "";  // consume wish — only apply once
    selectPackage(_initPkg.name, _initPkg.trip_group_date, _initPkg);
  }

  // ── Select package — stores package name AND its group_date (varian) ──
  // group_date datang dari API response, bukan dari date radio. Untuk cruise,
  // beberapa varian (pakej × TGD) boleh berkongsi nama pakej — jadi butang
  // aktif dipadankan pada KEDUA-DUA name + group_date.
  function selectPackage(name, gd, p) {
    _selectedPkg = name;
    _selectedPkgGd = gd;
    _selectedPkgData = p || _pkgMap[name + "|" + gd] || null;
    if (pkgSel) {
      Array.prototype.forEach.call(pkgSel.querySelectorAll(".rc-pkg-btn"), function (b) {
        var match = b.getAttribute("data-value") === name
          && b.getAttribute("data-gd-id") === (gd || "");
        b.classList.toggle("rc-pkg-active", match);
      });
    }
    // URL sync SENTIASA pada navigasi user (?package= — ?date= dipastikan
    // sepadan; params lain kekal). DITAHAN semasa boot (auto-select awal
    // bukan navigasi — URL kekal bersih).
    if (!_suppressUrlSync) {
      syncUrlParams({
        date: (_selectedPkgData && _selectedPkgData.trip_group_date) || gd || "",
        package: name,
      });
    }
    // MULTI-COMPANY: currency pakej = currency yang dicaj. Tukar simbol
    // harga kabin + nota "Charged in" ikut pakej yang dipilih.
    var pkgData = _selectedPkgData || {};
    if (pkgData.currency) {
      SYM = pkgData.currency_symbol || pkgData.currency;
      var note = document.getElementById("rcChargedCurrencyNote");
      if (note) note.textContent = "Charged in " + pkgData.currency;
    }
    updateMetaDuration();
    // Kad showcase: highlight row pakej aktif (pilih terus dari kad —
    // render semula supaya .rc-dtpkg-row-active ikut pilihan terkini).
    renderDateCards();
    loadCabins();
    refreshItinerary();
  }

  // ── Itinerary efektif (Nov 2026) — bila tarikh/pakej dipilih, timeline
  // bertukar kepada itinerary EFektif pilihan itu (warisan Trip ← Travel
  // Date ← Package Offer — model overwrite per aras). Server render fragmen
  // dengan include YANG SAMA dengan page (1:1 markup); swap #rcItinList +
  // re-wire collapsible. Render awal (template Trip) dikekalkan bila trip
  // tiada override langsung / tarikh legacy tanpa Travel Date. ──
  var _itinHost = document.getElementById("rcItinList");
  var _itinOriginal = _itinHost ? _itinHost.innerHTML : "";
  var _itinSeq = 0;

  function refreshItinerary() {
    if (!_itinHost || !DATA.use_package_offers || !DATA.has_itinerary_override) return;
    var gd = groupDatesData.find(function (g) { return g.name === _selectedPkgGd; });
    var td = (gd && gd.travel_date) || "";
    var offer = (_selectedPkgData && _selectedPkgData.offer) || "";
    if (!td) {
      // Tarikh legacy (tiada Travel Date) / tiada pilihan — kekal Trip.
      _itinHost.innerHTML = _itinOriginal;
      if (window.RCItinInit) window.RCItinInit();
      return;
    }
    var url = "/api/method/travel_booking.api.package_catalog.get_effective_itinerary"
      + "?trip=" + encodeURIComponent(DATA.trip_master || "")
      + "&travel_date=" + encodeURIComponent(td);
    if (offer) url += "&offer=" + encodeURIComponent(offer);
    var seq = ++_itinSeq;
    fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (res) {
        if (seq !== _itinSeq) return;  // pilihan telah bertukar — abaikan
        var msg = res && res.message;
        if (!msg || !msg.html) return;
        _itinHost.innerHTML = msg.html;
        if (window.RCItinInit) window.RCItinInit();
      })
      .catch(function () { /* senyap — kekal paparan sedia ada */ });
  }

  // ── Meta pakej per VARIAN — dipapar dalam SETIAP butang pakej ──
  // Sumber: TGD sebenar setiap varian (pakej × group date).
  function fmtDuration(days, nights) {
    if (!days) return "";
    return days + "D" + (nights ? "/" + nights + "N" : "");
  }

  // Duration varian dikira daripada tarikh yang DIPAPAR pada butang yang sama
  // (Cruise Only: sailing start/end; pakej lain: departure/return flight).
  // total_days/total_nights TGD hanya fallback — nilai tersimpan boleh basi
  // (diisi manual, validate TGD hanya kira bila kosong) dan bertentangan
  // dengan tarikh pada butang yang sama.
  function pkgDuration(p) {
    var cruiseOnly = !!p.is_cruise_only;
    var start = cruiseOnly ? (p.sailing_start || p.departure_date) : (p.departure_date || p.sailing_start);
    var end = cruiseOnly ? (p.sailing_end || p.return_date) : (p.return_date || p.sailing_end);
    if (start && end) {
      var nights = Math.round((new Date(end) - new Date(start)) / 86400000);
      if (nights >= 0) return fmtDuration(nights + 1, nights);
    }
    return fmtDuration(p.total_days, p.total_nights);
  }

  function _metaRow(label, value, valueClass) {
    return '<div class="rc-pkg-meta-row"><span class="rc-pkg-meta-label">' + esc(label) + '</span><span class="rc-pkg-meta-value ' + (valueClass || "") + '">' + esc(value) + '</span></div>';
  }

  function pkgMetaHtml(p) {
    var cruiseOnly = !!p.is_cruise_only;
    // Cruise Only: guna "Sailing Start" / "Sailing End" (padan reka bentuk rujukan).
    // Pakej lain (Cruise + Flight dll): tarikh penerbangan sebenar TGD.
    // Fallback ke pasangan tarikh bertentangan bila satu medan kosong.
    var dep = cruiseOnly ? (p.sailing_start || p.departure_date) : (p.departure_date || p.sailing_start);
    var ret = cruiseOnly ? (p.sailing_end || p.return_date) : (p.return_date || p.sailing_end);
    var html = '<div class="rc-pkg-meta">';
    if (dep) {
      html += _metaRow(cruiseOnly ? "Sailing Start" : "Flight Departure", _fmtWebDate(dep));
    }
    if (ret) {
      html += _metaRow(cruiseOnly ? "Sailing End" : "Flight Return Arrival", _fmtWebDate(ret));
    }
    var dur = pkgDuration(p);
    if (dur) {
      html += _metaRow("Duration", dur);
    }
    html += '</div>';
    return html;
  }

  // ── Duration pada meta bar (#rcMetaDuration) — ikut pakej + group date
  // yang dipilih (Jinja default = group date pertama, diganti di sini) ──
  function updateMetaDuration() {
    if (!metaDurationEl) return;
    var p = _selectedPkgData || {};
    var dur = pkgDuration(p);
    if (dur) metaDurationEl.innerHTML = '<i class="ti ti-clock-2"></i> ' + esc(dur);
  }

  function loadCabins() {
    var gd = _selectedPkgGd, pkg = _selectedPkg;
    if (!gd || !pkg) { updateBookLink(); return; }
    cabinsEl.className = "rc-cabins-loading";
    cabinsEl.innerHTML = '<p class="rc-muted">Loading…</p>';
    var url = "/api/method/travel_booking.api.pricing.get_booking_details"
      + "?trip_group_date=" + encodeURIComponent(gd)
      + "&trip_package=" + encodeURIComponent(pkg);
    // F5 struktur baharu: pakej terpilih ialah Package Offer dengan Price
    // Matrix tersendiri — hantar package_offer supaya server baca mod
    // offer (harga matrix + tarikh Travel Date). trip_package legacy
    // mungkin kosong untuk offer identiti-sendiri.
    var _selOffer = (_selectedPkgData && _selectedPkgData.offer) || "";
    if (DATA.use_package_offers && _selOffer) {
      url += "&package_offer=" + encodeURIComponent(_selOffer);
    }
    fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (res) {
        renderCabins((res && res.message) ? res.message : res);
        updateBookLink();
      })
      .catch(function () {
        cabinsEl.className = "rc-cabins-error";
        cabinsEl.innerHTML = "<p class=\"rc-muted\">Couldn\x27t load pricing. Please try again.</p>";
      });
  }

  function renderCabins(data) {
    // Showcase "Cabin Categories" khusus trip CRUISE — trip darat/tour
    // sembunyikan terus (ringkasan harga sidebar kekal).
    if (!is_cruise) {
      cabinsEl.className = "rc-cabins-empty";
      cabinsEl.innerHTML = "";
      if (cabinSection) cabinSection.hidden = true;
      return;
    }
    var cabins = (data && data.cabins) || [];
    if (!cabins.length) {
      cabinsEl.className = "rc-cabins-empty";
      cabinsEl.innerHTML = '<p class="rc-muted">No room options for this package.</p>';
      // Sembunyikan showcase kabin bila pakej tiada room options.
      if (cabinSection) cabinSection.hidden = true;
      return;
    }
    var priceMap = {};
    // Harga asal (pra-promosi Travel Price Rule) — untuk strikethrough.
    var origPriceMap = {};
    var promoLabel = "";
    cabins.forEach(function (c) {
      var pr = c.pricing || {};
      Object.keys(pr).forEach(function(key) {
        if (key.indexOf("price_") === 0 && pr[key] != null) {
          var val = Number(pr[key]);
          if (!(key in priceMap) || val < priceMap[key]) {
            priceMap[key] = val;
          }
        }
      });
      if (c.original_pricing) {
        var opr = c.original_pricing || {};
        Object.keys(opr).forEach(function(key) {
          if (key.indexOf("price_") === 0 && opr[key] != null) {
            var oval = Number(opr[key]);
            if (!(key in origPriceMap) || oval < origPriceMap[key]) {
              origPriceMap[key] = oval;
            }
          }
        });
        if (!promoLabel && c.price_rule && c.price_rule.label) {
          promoLabel = c.price_rule.label;
        }
      }
    });
    var labels = PRICE_LABELS.length ? PRICE_LABELS : getDefaultPriceLabels();
    var html = '<div class="rc-price-summary">';
    if (promoLabel) {
      html += '<div class="rc-promo-badge"><i class="ti ti-rosette-discount"></i> ' + esc(promoLabel) + '</div>';
    }
    labels.forEach(function(cfg) {
      var minPrice = priceMap[cfg.price_key];
      // Auto-hide price category if price is null or zero (0 = not applicable)
      if (minPrice != null && minPrice > 0) {
        var note = (cfg.display_note || "").replace(/<[^>]+>/g, "").trim();
        html += '<div class="rc-price-row">';
        html += '<div class="rc-price-label">' + esc(cfg.display_label);
        if (note) {
          // Nota harga: caption DISEMBUNYIKAN — jadi tooltip berhias dari
          // butang "?" selepas label (papar bila hover / butang focus).
          // Nota dibawa sebagai <span> DALAM butang (bukan atribut) supaya
          // esc() content-escape cukup — tiada isu attribute-escape.
          html += '<button type="button" class="rc-price-info"'
            + ' aria-label="More info: ' + esc(cfg.display_label) + '"'
            + ' title="">?'
            + '<span class="rc-price-note rc-price-tip">' + esc(note) + '</span>'
            + '</button>';
        }
        html += '</div>';
        // Travel Price Rule: harga promo + strikethrough harga asal.
        var origPrice = origPriceMap[cfg.price_key];
        var slash = (origPrice != null && Number(origPrice) > Number(minPrice))
          ? ' <s class="rc-price-was">' + fmt(origPrice) + '</s>'
          : "";
        html += '<div class="rc-price-value">from ' + fmt(minPrice) + slash + '</div>';
        html += '</div>';
      }
    });
    html += '</div>';
    cabinsEl.className = "rc-cabins-summary";
    cabinsEl.innerHTML = html;
    // Showcase "Cabin Categories" — kad penuh per room category (img,
    // kapasiti, harga per guest type) di layout utama.
    renderCabinCards(cabins);
  }

  // ── Kad Kategori Kabin (seksyen showcase) — KHUSUS trip CRUISE (trip
  // darat/tour sembunyikan seksyen; ringkasan harga sidebar kekal). Kad
  // per room category: gambar room, kapasiti, harga per guest type (bukan
  // MIN merentasi kategori). Kad dikumpul ikut Category Group
  // (Cabin/Suite/Villa/Room) — bila ada >1 group, tab bar dipapar untuk
  // tukar antara group. Tiada CTA — tempahan melalui kad booking sahaja. ──
  var _CABIN_GROUP_ORDER = ["Cabin", "Suite", "Villa", "Room", "Addon"];

  function renderCabinCards(cabins) {
    if (!cabinCardsEl) return;
    cabinCardsEl.innerHTML = "";
    var tabsHost = document.getElementById("rcCabinTabs");
    if (!tabsHost) {
      tabsHost = document.createElement("div");
      tabsHost.id = "rcCabinTabs";
      tabsHost.className = "rc-cabin-tabs";
      cabinCardsEl.parentNode.insertBefore(tabsHost, cabinCardsEl);
    }
    tabsHost.innerHTML = "";
    // Gate cruise: trip bukan-cruise / tiada kabin → seksyen tersembunyi.
    if (!is_cruise || !cabins.length) {
      tabsHost.hidden = true;
      if (cabinSection) cabinSection.hidden = true;
      return;
    }
    if (cabinSection) cabinSection.hidden = false;
    tabsHost.hidden = true;
    var labels = PRICE_LABELS.length ? PRICE_LABELS : getDefaultPriceLabels();

    // Kumpul Category Group unik (fallback "Cabin" bila kosong) — susun
    // kanonik Cabin→Suite→Villa→Room; group luar senarai kekal di hujung.
    var groups = [];
    var _seenGrp = {};
    cabins.forEach(function (c) {
      var g = (c.category_group || "").trim() || "Cabin";
      if (!_seenGrp[g]) { _seenGrp[g] = 1; groups.push(g); }
    });
    groups.sort(function (a, b) {
      var ia = _CABIN_GROUP_ORDER.indexOf(a); if (ia < 0) ia = 99;
      var ib = _CABIN_GROUP_ORDER.indexOf(b); if (ib < 0) ib = 99;
      return ia - ib;
    });

    cabins.forEach(function (c) {
      var grp = (c.category_group || "").trim() || "Cabin";
      var pr = c.pricing || {};
      var opr = c.original_pricing || {};
      var priceRows = labels.map(function (cfg) {
        var v = pr[cfg.price_key];
        if (v == null || Number(v) <= 0) return "";
        var o = opr[cfg.price_key];
        var slash = (o != null && Number(o) > Number(v))
          ? ' <s class="rc-price-was">' + fmt(o) + '</s>'
          : "";
        return '<div class="rc-cabin-price-row"><span>' + esc(cfg.display_label)
          + '</span><b>' + fmt(v) + slash + '</b></div>';
      }).join("");

      var cap = c.capacity || c.max_capacity;
      var desc = c.description ? String(c.description).replace(/<[^>]+>/g, "").trim() : "";
      if (desc.length > 140) desc = desc.slice(0, 140) + "…";

      var card = document.createElement("article");
      card.className = "rc-cabin-card";
      card.setAttribute("data-group", grp);
      // Baki kabin kolam kontrak sailing (cruise ber-schedule) — badge
      // pada kad showcase: "Sold Out" bila kategori tak boleh dijual
      // (kolam habis / kategori tak dikonfigur dlm cabin_rates),
      // "N cabins left" bila hampir penuh. Inventori mengira KABIN bukan
      // penumpang. Kolam besar / offer darat (null) → tiada badge.
      var seatsBadge = "";
      if (!c.is_available) {
        seatsBadge = '<span class="rc-cabin-seats rc-cabin-seats--out"><i class="ti ti-ban"></i> Sold Out</span>';
      } else if (c.pool_cabins_left != null && c.pool_cabins_left <= 5) {
        seatsBadge = '<span class="rc-cabin-seats rc-cabin-seats--low'
          + (c.pool_cabins_left <= 3 ? " rc-cabin-seats--crit" : "")
          + '"><i class="ti ti-alert-circle"></i> ' + esc(String(c.pool_cabins_left))
          + (c.pool_cabins_left === 1 ? " cabin left" : " cabins left") + '</span>';
      }
      card.innerHTML =
        '<div class="rc-cabin-media">'
        +   '<img src="' + esc(c.room_image || "/assets/travel_booking/img/defaultaroya.jpg")
        +     '" alt="' + esc(c.room_name || c.room_category || "Cabin") + '" loading="lazy"'
        +     ' onerror="this.src=\'/assets/travel_booking/img/defaultaroya.jpg\'"/>'
        +   (cap ? '<span class="rc-cabin-cap"><i class="ti ti-users"></i> ' + esc(String(cap)) + ' pax</span>' : '')
        + '</div>'
        + '<div class="rc-cabin-body">'
        +   '<h3 class="rc-cabin-name">' + esc(c.room_name || c.room_category || "") + '</h3>'
        +   seatsBadge
        +   (priceRows ? '<div class="rc-cabin-prices">' + priceRows + '</div>' : '')
        +   (desc ? '<p class="rc-cabin-desc">' + esc(desc) + '</p>' : '')
        +   '<button type="button" class="rc-cabin-reserve"'
        +     (!c.is_available ? " disabled" : "")
        +     ' aria-label="Reserve ' + esc(c.room_name || c.room_category || "cabin") + '">'
        +     '<i class="ti ti-calendar-check"></i> Reserve'
        +   '</button>'
        + '</div>';
      // Reserve — aliran Book Now + pra-pilih kategori kabin kad ini
      // sebagai BILIK PERTAMA di wizard /booknow.
      card.querySelector(".rc-cabin-reserve").addEventListener("click", function () {
        reserveCabin(c);
      });
      // >1 group: semua kad dipapar awal — tab "All" aktif secara default.
      cabinCardsEl.appendChild(card);
    });

    // Tab bar — hanya bila ada >1 Category Group. Tab "All" dahulu
    // (default aktif — papar SEMUA group); tab group lain tapis ikut group.
    if (groups.length > 1) {
      tabsHost.hidden = false;
      var tabAll = document.createElement("button");
      tabAll.type = "button";
      tabAll.className = "rc-cabin-tab rc-cabin-tab-active";
      tabAll.textContent = "All";
      tabAll.setAttribute("data-group", "__all__");
      tabAll.addEventListener("click", function () {
        Array.prototype.forEach.call(tabsHost.querySelectorAll(".rc-cabin-tab"), function (t) {
          t.classList.remove("rc-cabin-tab-active");
        });
        tabAll.classList.add("rc-cabin-tab-active");
        Array.prototype.forEach.call(cabinCardsEl.querySelectorAll(".rc-cabin-card"), function (card) {
          card.classList.remove("rc-cabin-card-hidden");
        });
      });
      tabsHost.appendChild(tabAll);
      groups.forEach(function (g) {
        var tab = document.createElement("button");
        tab.type = "button";
        tab.className = "rc-cabin-tab";
        tab.textContent = g;
        tab.setAttribute("data-group", g);
        tab.addEventListener("click", function () {
          Array.prototype.forEach.call(tabsHost.querySelectorAll(".rc-cabin-tab"), function (t) {
            t.classList.remove("rc-cabin-tab-active");
          });
          tab.classList.add("rc-cabin-tab-active");
          Array.prototype.forEach.call(cabinCardsEl.querySelectorAll(".rc-cabin-card"), function (card) {
            card.classList.toggle("rc-cabin-card-hidden", card.getAttribute("data-group") !== g);
          });
        });
        tabsHost.appendChild(tab);
      });
    }
  }

  // Fokus widget booking — mobile: buka drawer; desktop: scroll ke kad.
  // PENTING: bar ialah position:fixed — offsetParent sentiasa null, jadi
  // keterlihatan disemak melalui getComputedStyle (display:none di desktop,
  // css trip_detail.css; ditunjukkan pada breakpoint ≤640px).
  // [Nov 2026] CTA "Reserve" kad kabin dibuang — handler kekal untuk
  // consumer lain yang mungkin fokus ke kad booking.

  function updateBookLink() {
    var ready = !!(_selectedPkg && _selectedPkgGd);
    if (bookBtn) {
      bookBtn.classList.toggle("rc-btn-disabled", !ready);
      bookBtn.disabled = !ready;
    }
    if (shareBtn) {
      shareBtn.classList.toggle("rc-btn-disabled", !ready);
      shareBtn.disabled = !ready;
    }
  }

  // ════ Share My Trip → copy link, modal with QR code ════
  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {});
    } else {
      var inp = document.createElement("input");
      inp.value = text;
      inp.style.position = "fixed";
      inp.style.opacity = "0";
      document.body.appendChild(inp);
      inp.select();
      try { document.execCommand("copy"); } catch (_e) {}
      document.body.removeChild(inp);
    }
  }

  function showToast(msg) {
    var t = document.createElement("div");
    t.className = "rc-share-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add("rc-share-toast-show"); }, 10);
    setTimeout(function () {
      t.classList.remove("rc-share-toast-show");
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2500);
  }

  function closeShareModal(overlay) {
    rcHideModal(overlay, function () {
      if (window.bootstrap && window.bootstrap.Modal && overlay.parentNode) {
        window.bootstrap.Modal.getInstance(overlay).dispose();
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    });
  }

  function showShareModal(shareUrl, qrUri) {
    var existing = document.getElementById("rcShareModal");
    if (existing) existing.parentNode.removeChild(existing);

    // Cangkang Bootstrap modal — kandungan kad share jenama di dalam.
    var overlay = document.createElement("div");
    overlay.id = "rcShareModal";
    overlay.className = "modal fade rc-share-modal";
    overlay.tabIndex = -1;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-hidden", "true");

    var dialog = document.createElement("div");
    dialog.className = "modal-dialog modal-dialog-centered";

    var card = document.createElement("div");
    card.className = "modal-content rc-share-card";

    var closeBtn = document.createElement("button");
    closeBtn.className = "rc-share-close";
    closeBtn.setAttribute("data-bs-dismiss", "modal");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = "&times;";

    var title = document.createElement("h3");
    title.className = "rc-share-title";
    title.textContent = "Share My Trip";

    if (qrUri) {
      var qrWrap = document.createElement("div");
      qrWrap.className = "rc-share-qr-wrap";
      var qrImg = document.createElement("img");
      qrImg.className = "rc-share-qr";
      qrImg.src = qrUri;
      qrImg.alt = "QR Code";
      qrWrap.appendChild(qrImg);
      card.appendChild(qrWrap);
    }

    var urlEl = document.createElement("div");
    urlEl.className = "rc-share-url";
    urlEl.textContent = shareUrl;

    var copyBtn = document.createElement("button");
    copyBtn.className = "rc-share-copy";
    copyBtn.textContent = "Copy Link";
    copyBtn.addEventListener("click", function () {
      copyToClipboard(shareUrl);
      showToast("Link copied!");
    });

    card.appendChild(closeBtn);
    card.appendChild(title);
    if (qrUri) card.appendChild(qrWrap);
    card.appendChild(urlEl);
    card.appendChild(copyBtn);
    dialog.appendChild(card);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    rcShowModal(overlay);
  }

  function shareWish(e) {
    e.preventDefault();
    var gd = _selectedPkgGd, pkg = _selectedPkg;
    if (!gd || !pkg) return;

    // Pautan share: ?date=/?package= (param lama trip_group_date/
    // trip_package dibersihkan). Param LAIN pada URL semasa — utm_*, sp/
    // affiliate, dsb. — KEKAL dengan nilainya supaya atribusi marketing
    // tidak hilang melalui pautan share.
    var shareQs;
    try {
      shareQs = new URLSearchParams(window.location.search);
    } catch (_e) {
      shareQs = new URLSearchParams();
    }
    shareQs.set("date", gd);
    shareQs.set("package", pkg);
    shareQs.delete("trip_group_date");
    shareQs.delete("trip_package");
    var shareQsStr = shareQs.toString();
    var longUrl = window.location.origin + window.location.pathname
      + (shareQsStr ? "?" + shareQsStr : "");

    var origText = shareBtn.textContent;
    shareBtn.textContent = "Generating…";
    shareBtn.disabled = true;

    var apiUrl = "/api/method/travel_booking.api.pricing.share_trip_link"
      + "?url=" + encodeURIComponent(longUrl);

    fetch(apiUrl, { headers: { "X-Requested-With": "XMLHttpRequest" } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (res) {
        var data = (res && res.message) ? res.message : res;
        var shareUrl = data.share_url || longUrl;
        var qrUri = data.qr_data_uri || "";
        copyToClipboard(shareUrl);
        showShareModal(shareUrl, qrUri);
      })
      .catch(function () {
        copyToClipboard(longUrl);
        showToast("Couldn\x27t generate QR code — link copied instead.");
      })
      .finally(function () {
        shareBtn.textContent = origText;
        shareBtn.disabled = false;
      });
  }

  // ════ STEP 4: Book Now → save package_variant ke session ════
  // CRUISE: TGD sebenar sudah terpilih secara eksplisit melalui butang
  // varian pakej (pakej × tarikh penerbangan dalam senarai butang) —
  // popup pilihan departure date tidak lagi diperlukan.

  function addToCart(e) {
    e.preventDefault();
    var gd = _selectedPkgGd;
    var pkg = _selectedPkg || null;

    if (!gd || !pkg) {
      gdSel.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    var departureStart = "";
    if (is_cruise) {
      // Tarikh berlepas yang dipilih user (kumpulan ikut departure date —
      // bukan sailing lagi) — direkodkan dalam cart untuk reverse-trace
      // di /booknow.
      departureStart = (getSelectedDateValue() || "").split(":")[0];
    }

    proceedToBookNow(gd, pkg, departureStart);
  }

  // ── Reserve dari kad kabin (showcase Cabin Categories) ──
  // Aliran SAMA dengan Book Now (addToCart → proceedToBookNow) — tambah
  // room_category kabin kad ini untuk pra-pilih BILIK PERTAMA di wizard
  // /booknow (initRooms baca bnw_cart.room_category — sah + available).
  function reserveCabin(cabin) {
    var gd = _selectedPkgGd;
    var pkg = _selectedPkg || null;
    if (!gd || !pkg) {
      gdSel.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    var departureStart = is_cruise
      ? (getSelectedDateValue() || "").split(":")[0]
      : "";
    proceedToBookNow(gd, pkg, departureStart, cabin.room_category);
  }

  function proceedToBookNow(gd, pkg, departureStart, roomCategory) {
    // Cari package data dari button attributes untuk label/currency
    // (pkgSel null pada cruise — fallback label dari varian terpilih).
    var pkgBtn = pkgSel ? pkgSel.querySelector(".rc-pkg-btn[data-value='" + pkg + "']") : null;
    var pkgLabel = pkgBtn
      ? pkgBtn.textContent
      : ((_selectedPkgData && (_selectedPkgData.package_type || _selectedPkgData.package_name)) || "");

    // package_variant = "package_name:group_date" (combined format)
    var package_variant = pkg + ":" + gd;

    var cart = {
      trip_master: DATA.trip_master,
      trip_name: DATA.trip_name || "",
      is_cruise: !!DATA.is_cruise,
      trip_type: TRIP_TYPE,
      package_variant: package_variant,                 // "TP260817:RC2621"
      group_date: gd,                                   // backward compat
      departure_date: departureStart || "",             // cruise: tarikh berlepas dipilih (untuk reverse-trace di /booknow)
      package_name: pkg,                                // backward compat
      package_label: pkgLabel,
      // Currency native pakej yang dipilih (paksi multi-company) — wizard
      // /booknow guna ni sebagai currency billing asas.
      package_currency: ((_pkgMap[pkg + "|" + gd] || {}).currency) || LISTING_CURRENCY,
      package_currency_symbol: SYM,
      company_currency: DATA.company_symbol || "RM",
      // F5 struktur baharu — identiti Package Offer untuk laluan tulis
      // baharu (confirm_booking baca Price Matrix offer bila flag ON).
      // Kosong untuk pakej legacy (cart lama tak terjejas).
      offer: ((_selectedPkgData && _selectedPkgData.offer) || ""),
      travel_package: ((_selectedPkgData && _selectedPkgData.travel_package) || ""),
      // Reserve dari kad kabin (showcase Cabin Categories): kategori kabin
      // pra-pilih untuk BILIK PERTAMA di wizard /booknow (initRooms baca
      // medan ni — sah + available; kosong = Book Now biasa).
      room_category: roomCategory || "",
      affiliate_code: _sp,                              // rambat ke /booknow
      added_at: new Date().toISOString()
    };

    try {
      sessionStorage.setItem("bnw_cart", JSON.stringify(cart));
    } catch (err) {
      return;
    }

    // Simpan URL page trip semasa supaya Back button di /booknow dapat
    // kembali ke sini — lebih reliable dari document.referrer (boleh
    // kosong ikut referrer policy browser).
    try {
      sessionStorage.setItem("bnw_referrer", window.location.href);
    } catch (err) {}

    // Event GA4 add_to_cart — sebelum redirect ke wizard. Per-site (GA
    // aktif ikut Travel Website); gagal hantar TIDAK halang aliran tempahan.
    try {
      if (window.RCGA && RCGA.enabled()) {
        var _gaItem = RCGA.item(
          cart.is_cruise ? "cruise" : "tour",
          cart.trip_master,
          cart.trip_name
        );
        _gaItem.item_variant = package_variant;  // "TP260817:RC2621"
        RCGA.event("add_to_cart", {
          currency: RCGA.currency(),
          items: [_gaItem],
        });
      }
    } catch (_gaErr) { /* analytics tak boleh ganggu tempahan */ }

    // Append ?sp= ke /booknow supaya prefillAffiliateCodeFromUrl() di wizard
    // terus apply kod affiliate — bnw_cart.affiliate_code ialah fallback.
    var bnwUrl = "/booknow";
    if (_sp) bnwUrl += "?sp=" + encodeURIComponent(_sp);
    window.location.href = bnwUrl;
  }

  // ════ Init: Load labels first, then populate dates ════
  // populateDates() → auto-select first date → populatePackages() (AJAX) → selectPackage() → loadCabins()
  loadPriceLabels().then(function() {
    populateDates();
    // Boot selesai (auto-select awal synchronize state tanpa URL) —
    // navigasi user selepas ini dikemas kini ke URL (?date=/?package=).
    _suppressUrlSync = false;
    if (bookBtn) {
      bookBtn.addEventListener("click", addToCart);
    }
    if (shareBtn) {
      shareBtn.addEventListener("click", shareWish);
    }
  });
})();

// ── FAQ accordion — DIMIGRASI ke Bootstrap accordion (markup accordion
// dalam trip.html; single-open diurus data-bs-parent). Tiada JS custom.

// ── Itinerary collapsible — teks more/hide kecil di bucu kanan bawah kad
// + butang global Collapse all / Expand all di header seksyen.
// querySelectorAll (bukan querySelector) supaya itinerary bersegmen cruise —
// beberapa <ol class="rc-itinerary"> — semuanya dapat handler.
// Lalai: semua hari open (terbuka).
// [Nov 2026] initItin() boleh dipanggil SEMULA: bila timeline diswap
// kepada itinerary efektif (tarikh/pakej dipilih pada widget booking),
// elemen baharu perlu wiring — elemen yang sudah wired (data-itin-wired)
// tidak disentuh lagi. ──
(function () {
  "use strict";
  var allBtn = document.getElementById("rcItinToggleAll");

  function daySet(li, open) {
    var btn = li.querySelector(".rc-itin-toggle");
    var head = li.querySelector(".rc-itin-head");
    li.classList.toggle("rc-itin-open", open);
    li.classList.toggle("rc-itin-collapsed", !open);
    if (btn) btn.textContent = open ? "hide" : "more";
    if (head) head.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncAllBtn() {
    if (!allBtn) return;
    var days = document.querySelectorAll(".rc-itin-day");
    var allOpen = true;
    Array.prototype.forEach.call(days, function (li) {
      if (!li.classList.contains("rc-itin-open")) allOpen = false;
    });
    allBtn.setAttribute("aria-expanded", allOpen ? "true" : "false");
    var label = allBtn.querySelector("span");
    var icon = allBtn.querySelector(".ti");
    if (label) label.textContent = allOpen ? "Collapse all" : "Expand all";
    if (icon) icon.className = "ti " + (allOpen ? "ti-chevrons-up" : "ti-chevrons-down");
  }

  function initItin() {
    var days = document.querySelectorAll(".rc-itin-day:not([data-itin-wired])");
    Array.prototype.forEach.call(days, function (li) {
      li.setAttribute("data-itin-wired", "1");
      var head = li.querySelector(".rc-itin-head");
      var btn = li.querySelector(".rc-itin-toggle");
      if (!head && !btn) return;
      li.classList.add("rc-itin-open");
      if (btn) btn.textContent = "hide";
      if (head) {
        head.setAttribute("role", "button");
        head.setAttribute("tabindex", "0");
        head.setAttribute("aria-expanded", "true");
      }
      function toggle() {
        daySet(li, !li.classList.contains("rc-itin-open"));
        syncAllBtn();
      }
      if (head) {
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        });
      }
      if (btn) btn.addEventListener("click", toggle);
    });
  }

  if (allBtn) {
    allBtn.addEventListener("click", function () {
      var expand = allBtn.getAttribute("aria-expanded") !== "true";
      Array.prototype.forEach.call(
        document.querySelectorAll(".rc-itin-day"),
        function (li) { daySet(li, expand); });
      syncAllBtn();
    });
  }

  initItin();
  // Dipanggil selepas swap #rcItinList (itinerary efektif) oleh widget
  // booking di atas — rujuk refreshItinerary().
  window.RCItinInit = initItin;
})();

// ── Sticky booking panel (position:sticky bottom — trip_detail.css) ──
// Card menunggang bawah viewport semasa scroll dan labuh di hujung sidebar.
// Sentinel di hujung sidebar menanda kedudukan labuh: bila sentinel tiada
// dalam viewport, card masih terlekat di bawah skrin → .rc-stuck (bayang
// lebih dalam; lihat .rc-booking-card.rc-stuck). Tinggi nav sticky diukur ke
// --rc-nav-h supaya max-height card tak luncur di bawah header, dan animasi
// kemasukan (.rc-entrance) dicetus pada kemunculan pertama card, bukan semasa
// page load (card masih di bawah fold).
(function () {
  "use strict";
  var card = document.querySelector(".rc-booking-card");
  var sentinel = document.querySelector(".rc-sticky-sentinel");
  if (!card) return;

  var nav = document.querySelector(".rc-public-nav");
  function syncNavH() {
    if (nav) {
      document.documentElement.style.setProperty("--rc-nav-h", nav.offsetHeight + "px");
    }
  }
  syncNavH();
  window.addEventListener("resize", syncNavH);

  if (typeof IntersectionObserver === "undefined") return;
  if (sentinel) {
    var io = new IntersectionObserver(function (entries) {
      card.classList.toggle("rc-stuck", !entries[0].isIntersecting);
    }, { threshold: 0 });
    io.observe(sentinel);
  }
  var entered = false;
  var ioEnter = new IntersectionObserver(function (entries) {
    if (entered || !entries[0].isIntersecting) return;
    entered = true;
    card.classList.add("rc-entrance");
    ioEnter.disconnect();
  }, { threshold: 0 });
  ioEnter.observe(card);
})();

// ── Mobile booking drawer (≤640px — trip_detail.css) ──
// Bar sticky "harga + Book Now" di bawah skrin membuka card sebagai bottom
// drawer (slide-up). Tutup: tap backdrop, butang X, Escape, atau leret card
// ke bawah. Melepasi breakpoint (rotate/resize) auto-tutup. Di desktop bar
// dan backdrop disembunyi CSS, jadi listener ini no-op.
(function () {
  "use strict";
  var card = document.querySelector(".rc-booking-card");
  var bar = document.getElementById("rcBookingBar");
  var backdrop = document.querySelector(".rc-drawer-backdrop");
  var closeBtn = document.querySelector(".rc-drawer-close");
  if (!card || !bar || !backdrop || !closeBtn) return;

  function isOpen() { return card.classList.contains("rc-drawer-open"); }

  function openDrawer() {
    card.classList.add("rc-drawer-open");
    backdrop.classList.add("rc-show");
    bar.classList.add("rc-hide");
    bar.setAttribute("aria-expanded", "true");
    document.documentElement.classList.add("rc-drawer-lock");
    if (typeof closeBtn.focus === "function") {
      try { closeBtn.focus({ preventScroll: true }); } catch (_e) {}
    }
  }

  function closeDrawer() {
    card.classList.remove("rc-drawer-open");
    card.classList.remove("rc-dragging");
    card.style.transform = "";
    backdrop.classList.remove("rc-show");
    bar.classList.remove("rc-hide");
    bar.setAttribute("aria-expanded", "false");
    document.documentElement.classList.remove("rc-drawer-lock");
  }

  bar.addEventListener("click", function () {
    if (isOpen()) closeDrawer(); else openDrawer();
  });
  closeBtn.addEventListener("click", closeDrawer);
  backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) closeDrawer();
  });

  // Rotate / resize melangkau breakpoint → reset supaya card tak kekal
  // fixed + body terkunci di desktop.
  var mq = window.matchMedia("(max-width: 640px)");
  function onMq(e) { if (!e.matches) closeDrawer(); }
  if (mq.addEventListener) mq.addEventListener("change", onMq);
  else if (mq.addListener) mq.addListener(onMq);

  // Leret ke bawah utk tutup — hanya bila card dah terbuka dan kandungan
  // berada di atas (scrollTop 0); tap biasa tak terganggu (tiada
  // preventDefault sebelum drag aktif).
  var startY = 0, dy = 0, dragging = false;
  card.addEventListener("touchstart", function (e) {
    if (!isOpen() || card.scrollTop > 0 || e.touches.length !== 1) {
      dragging = false;
      return;
    }
    dragging = true;
    startY = e.touches[0].clientY;
    dy = 0;
  }, { passive: true });
  card.addEventListener("touchmove", function (e) {
    if (!dragging) return;
    dy = e.touches[0].clientY - startY;
    if (dy <= 0) { card.style.transform = ""; return; }
    if (!card.classList.contains("rc-dragging")) card.classList.add("rc-dragging");
    card.style.transform = "translateY(" + dy + "px)";
  }, { passive: true });
  card.addEventListener("touchend", function () {
    if (!dragging) return;
    dragging = false;
    var shouldClose = dy > 90;
    card.classList.remove("rc-dragging");
    card.style.transform = "";
    if (shouldClose) closeDrawer();
  });
})();
