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
  var pkgSel = document.getElementById("rcDetailPackage");
  var metaDurationEl = document.getElementById("rcMetaDuration");
  var cabinsEl = document.getElementById("rcDetailCabins");
  var bookBtn = document.getElementById("rcDetailBookBtn");
  var shareBtn = document.getElementById("rcDetailShareBtn");
  if (!gdSel || !pkgSel) return;

  // ── Parse ?trip_group_date=RC...&trip_package=TP...&sp=... from URL ──
  // 'sp' ialah affiliate referral code (Sales Partner) — dipasang oleh pautan
  // affiliate yang menuju terus ke page detail trip. Code ni dirambat ke
  // /booknow (via bnw_cart + URL param) supaya wizard boleh pre-fill &
  // atribut komisen affiliate pada booking.
  var _wishPkg = "", _wishGd = "", _sp = "";
  try {
    var qs = new URLSearchParams(window.location.search);
    _wishGd = qs.get("trip_group_date") || "";
    _wishPkg = qs.get("trip_package") || "";
    _sp = (qs.get("sp") || "").trim().toUpperCase();
  } catch (_e) {}

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

  // ── Pakej union untuk sesuatu tarikh ──
  // Cruise: semua pakej dari SEMUA TGD yang berkongsi sailing (peta
  // sailing_tgds) — sama logik dengan populatePackages(). Non-cruise: pakej
  // TGD terus. Guna untuk (a) union pakej ikut sailing, (b) kesan tarikh
  // yang ada pilihan penerbangan (ikon pesawat dalam date selector).
  function pkgsForDate(gdData) {
    var preloaded = DATA.trip_packages || {};
    if (is_cruise) {
      var sail = gdData.sailing_start || gdData.departure_date || "";
      var tgdList = (DATA.sailing_tgds || {})[sail] || [];
      var pkgs = [];
      tgdList.forEach(function (t) {
        (preloaded[t.name] || []).forEach(function (p) { pkgs.push(p); });
      });
      return pkgs;
    }
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
  // Cruise: sailing_start → sailing_end
  // Non-cruise: departure_date → return_date
  // >1 tarikh: senarai radio inline diganti BUTANG TRIGGER + POPUP MODAL
  // date selector (filter bulan + ikon pesawat pada tarikh yang ada pilihan
  // penerbangan). 1 tarikh: radio inline seperti sedia ada.
  function populateDates() {
    gdSel.innerHTML = "";
    if (!groupDatesData.length) {
      gdSel.innerHTML = '<p class="rc-muted">No dates available.</p>';
      return;
    }

    var multi = groupDatesData.length > 1;
    _allRadios = [];
    _dateMeta = [];

    groupDatesData.forEach(function (gdData, idx) {
      var radioId = "gd_" + idx;

      // value = actual dates (for SQL query: sailing_start:sailing_end or departure_date:return_date)
      var startDate = gdData.sailing_start || gdData.departure_date;
      var endDate = is_cruise ? gdData.sailing_end : gdData.return_date;
      var dateValue = startDate + ":" + (endDate || "");

      var radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "rc_group_date";
      radio.id = radioId;
      radio.value = dateValue;
      radio.setAttribute("data-gd-id", gdData.name);
      radio.className = "rc-date-radio";
      if (_wishGd && gdData.name === _wishGd) radio.checked = true;
      else if (!_wishGd && idx === 0) radio.checked = true;

      // Tarikh diformat ikut konfigurasi Travel Website (window.RC_DATE_FORMAT
      // dari base_travel.html) — bukan ISO mentah.
      var dateText = _fmtWebDate(startDate);
      if (is_cruise && gdData.sailing_end) {
        dateText += " → " + _fmtWebDate(gdData.sailing_end);
      } else if (gdData.return_date) {
        dateText += " → " + _fmtWebDate(gdData.return_date);
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
      renderDateTrigger();
      renderDateModal();
      updateDateTriggerLabel();
    } else {
      renderInlineDateLabel(0);
    }

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

  function updateDateTriggerLabel() {
    if (!_dateTrigger) return;
    var meta = _dateMeta[checkedDateIndex()] || { dateText: "", seatsHtml: "" };
    _dateTrigger.querySelector(".rc-date-trigger-text").innerHTML =
      esc(meta.dateText) + meta.seatsHtml;
  }

  // Pilih tarikh (dari modal) → sync radio hidden → refresh trigger + pakej
  function selectDate(idx) {
    Array.prototype.forEach.call(_allRadios, function (r, i) {
      r.checked = i === idx;
    });
    updateDateTriggerLabel();
    markModalActiveItem();
    populatePackages();
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
    _dateModal.classList.add("rc-datemodal-show");
  }

  function closeDateModal() {
    if (_dateModal) _dateModal.classList.remove("rc-datemodal-show");
  }

  function renderDateModal() {
    var existing = document.getElementById("rcDateModal");
    if (existing) existing.parentNode.removeChild(existing);

    var modal = document.createElement("div");
    modal.id = "rcDateModal";
    modal.className = "rc-datemodal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    var card = document.createElement("div");
    card.className = "rc-datemodal-card";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "rc-datemodal-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", closeDateModal);

    var title = document.createElement("h3");
    title.className = "rc-datemodal-title";
    title.textContent = is_cruise ? "Choose Sailing Date" : "Choose Departure Date";

    // ── Filter bulan: chip "All" + bulan unik (sisih kronologi) ──
    var filters = document.createElement("div");
    filters.className = "rc-datemodal-filters";
    var months = [];
    var _seenMonth = {};
    _dateMeta.forEach(function (meta) {
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
    _dateMeta.forEach(function (meta, idx) {
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

    card.appendChild(closeBtn);
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

    modal.appendChild(card);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) closeDateModal();
    });
    document.body.appendChild(modal);
    _dateModal = modal;
  }

  // Esc menutup popup date selector (overlay click ditangani dalam modal)
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDateModal();
  });

  // ════ STEP 3: Load packages for selected date ════
  // CRUISE: radio tarikh mewakili SAILING date (di-dedupe pelayan) — pakej
  // di-union dari SEMUA TGD yang berkongsi sailing itu (peta DATA.sailing_tgds),
  // dan setiap pakej kekal bawa trip_group_date SEBENAR pautannya. Ini
  // memastikan pakej Cruise Only dibawa bersama TGD Cruise Only (bukan TGD
  // Cruise + Flight yang disimpan semasa dedupe).
  // Non-cruise: pakej diambil terus dari TGD radio (tiada dedupe).
  function populatePackages() {
    pkgSel.innerHTML = '<p class="rc-muted">Loading packages…</p>';
    _selectedPkg = "";
    _selectedPkgGd = "";
    _selectedPkgData = null;
    cabinsEl.className = "rc-cabins-empty";
    cabinsEl.innerHTML = '<p class="rc-muted">Pick a package to see room options and prices.</p>';
    updateBookLink();

    var dateValue = getSelectedDateValue();
    if (!dateValue) {
      pkgSel.innerHTML = '<p class="rc-muted">Pick a date first.</p>';
      return;
    }

    var gdId = getSelectedGroupDateId();
    var preloaded = DATA.trip_packages || {};

    var pkgs = null;
    if (is_cruise) {
      // Union pakej semua TGD yang berkongsi sailing_start — TANPA dedupe
      // ikut nama pakej. Satu pakej boleh dipaut ke beberapa TGD dalam
      // sailing yang sama (tarikh berlepas penerbangan berbeza), jadi setiap
      // varian (pakej × TGD) dipapar sebagai butang sendiri dengan tarikh
      // "Departs" masing-masing — user pilih tarikh penerbangan terus dari
      // senarai butang, menggantikan popup pilihan departure di Book Now.
      var sailStart = dateValue.split(":")[0];
      pkgs = pkgsForDate({ sailing_start: sailStart });
    } else {
      pkgs = preloaded[gdId] || null;
    }

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
        pkgSel.innerHTML = '<p class="rc-muted">Couldn\x27t load packages. Please try again.</p>';
      });
  }

  function renderPackageButtons(pkgs) {
    pkgSel.innerHTML = "";
    if (!pkgs || !pkgs.length) {
      pkgSel.innerHTML = '<p class="rc-muted">No packages available for this date.</p>';
      return;
    }
    pkgs.forEach(function (p) {
      _pkgMap[p.name + "|" + p.trip_group_date] = p;
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
      // Meta varian dipapar DALAM setiap butang — departure/return, duration,
      // ground arrangement. Susunan ikut reka bentuk rujukan:
      //   [radio]  Tajuk pakej (bold)
      //            Departure          29 Sep 2026
      //            Return             12 Oct 2026
      //            Duration           1D/10N
      //            Ground Arrangement Not Included
      btn.innerHTML = '<span><div class="rc-pkg-title">' + labelHtml + '</div>' + pkgMetaHtml(p) + '</span>';
      btn.addEventListener("click", function () { selectPackage(p.name, p.trip_group_date, p); });
      pkgSel.appendChild(btn);
    });
    var _wishMatch = _wishPkg
      ? pkgs.find(function (p) { return p.name === _wishPkg && (!_wishGd || p.trip_group_date === _wishGd); })
      : null;
    if (!_wishMatch && _wishPkg) {
      _wishMatch = pkgs.find(function (p) { return p.name === _wishPkg; });
    }
    var _initPkg = _wishMatch || pkgs[0];
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
    Array.prototype.forEach.call(pkgSel.querySelectorAll(".rc-pkg-btn"), function (b) {
      var match = b.getAttribute("data-value") === name
        && b.getAttribute("data-gd-id") === (gd || "");
      b.classList.toggle("rc-pkg-active", match);
    });
    // MULTI-COMPANY: currency pakej = currency yang dicaj. Tukar simbol
    // harga kabin + nota "Charged in" ikut pakej yang dipilih.
    var pkgData = _selectedPkgData || {};
    if (pkgData.currency) {
      SYM = pkgData.currency_symbol || pkgData.currency;
      var note = document.getElementById("rcChargedCurrencyNote");
      if (note) note.textContent = "Charged in " + pkgData.currency;
    }
    updateMetaDuration();
    loadCabins();
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
    html += _metaRow("Ground Arrangement", p.ground_arrangement ? "Included" : "Not Included", p.ground_arrangement ? "rc-pkg-included" : "rc-pkg-not-included");
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
    var cabins = (data && data.cabins) || [];
    if (!cabins.length) {
      cabinsEl.className = "rc-cabins-empty";
      cabinsEl.innerHTML = '<p class="rc-muted">No room options for this package.</p>';
      return;
    }
    var priceMap = {};
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
    });
    var labels = PRICE_LABELS.length ? PRICE_LABELS : getDefaultPriceLabels();
    var html = '<div class="rc-price-summary">';
    labels.forEach(function(cfg) {
      var minPrice = priceMap[cfg.price_key];
      // Auto-hide price category if price is null or zero (0 = not applicable)
      if (minPrice != null && minPrice > 0) {
        html += '<div class="rc-price-row">';
        html += '<div class="rc-price-label">' + esc(cfg.display_label) + '</div>';
        var note = (cfg.display_note || "").replace(/<[^>]+>/g, "");
        html += '<div class="rc-price-value">from ' + fmt(minPrice) + '</div>';
        if (note.trim()) {
          html += '<div class="rc-price-note">' + esc(note.trim()) + '</div>';
        }
        html += '</div>';
      }
    });
    html += '</div>';
    cabinsEl.className = "rc-cabins-summary";
    cabinsEl.innerHTML = html;
  }

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
    overlay.classList.remove("rc-share-modal-show");
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 300);
  }

  function showShareModal(shareUrl, qrUri) {
    var existing = document.getElementById("rcShareModal");
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement("div");
    overlay.id = "rcShareModal";
    overlay.className = "rc-share-modal";

    var card = document.createElement("div");
    card.className = "rc-share-card";

    var closeBtn = document.createElement("button");
    closeBtn.className = "rc-share-close";
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", function () { closeShareModal(overlay); });

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
    overlay.appendChild(card);
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) closeShareModal(overlay);
    });
    document.body.appendChild(overlay);
    setTimeout(function () { overlay.classList.add("rc-share-modal-show"); }, 10);
  }

  function shareWish(e) {
    e.preventDefault();
    var gd = _selectedPkgGd, pkg = _selectedPkg;
    if (!gd || !pkg) return;

    var longUrl = window.location.origin + window.location.pathname
      + "?trip_group_date=" + encodeURIComponent(gd)
      + "&trip_package=" + encodeURIComponent(pkg);

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

    var sailingStart = "";
    if (is_cruise) {
      // Sailing yang dipilih user — direkodkan dalam cart untuk
      // reverse-trace di /booknow.
      sailingStart = (getSelectedDateValue() || "").split(":")[0];
    }

    proceedToBookNow(gd, pkg, sailingStart);
  }

  function proceedToBookNow(gd, pkg, sailingStart) {
    // Cari package data dari button attributes untuk label/currency
    var pkgBtn = pkgSel.querySelector(".rc-pkg-btn[data-value='" + pkg + "']");
    var pkgLabel = pkgBtn ? pkgBtn.textContent : "";

    // package_variant = "package_name:group_date" (combined format)
    var package_variant = pkg + ":" + gd;

    var cart = {
      trip_master: DATA.trip_master,
      trip_name: DATA.trip_name || "",
      is_cruise: !!DATA.is_cruise,
      trip_type: TRIP_TYPE,
      package_variant: package_variant,                 // "TP260817:RC2621"
      group_date: gd,                                   // backward compat
      sailing_start: sailingStart || "",                // cruise: sailing yang dipilih (untuk reverse-trace di /booknow)
      package_name: pkg,                                // backward compat
      package_label: pkgLabel,
      // Currency native pakej yang dipilih (paksi multi-company) — wizard
      // /booknow guna ni sebagai currency billing asas.
      package_currency: ((_pkgMap[pkg + "|" + gd] || {}).currency) || LISTING_CURRENCY,
      package_currency_symbol: SYM,
      company_currency: DATA.company_symbol || "RM",
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
    if (bookBtn) {
      bookBtn.addEventListener("click", addToCart);
    }
    if (shareBtn) {
      shareBtn.addEventListener("click", shareWish);
    }
  });
})();

// ── FAQ accordion (single-open) ──
(function () {
  "use strict";
  var faq = document.getElementById("rcFaq");
  if (!faq) return;
  faq.addEventListener("click", function (e) {
    var btn = e.target.closest(".rc-faq-q");
    if (!btn) return;
    var item = btn.parentElement;
    var ans = btn.nextElementSibling;
    var open = btn.getAttribute("aria-expanded") === "true";
    Array.prototype.forEach.call(faq.querySelectorAll(".rc-faq-q"), function (q) {
      q.setAttribute("aria-expanded", "false");
      if (q.parentElement) q.parentElement.classList.remove("is-open");
      var a = q.nextElementSibling;
      if (a) a.style.maxHeight = null;
    });
    if (!open) {
      btn.setAttribute("aria-expanded", "true");
      item.classList.add("is-open");
      if (ans) ans.style.maxHeight = ans.scrollHeight + "px";
    }
  });
})();

// ── Itinerary collapsible — teks more/hide kecil di bucu kanan bawah kad
// + butang global Collapse all / Expand all di header seksyen.
// querySelectorAll (bukan querySelector) supaya itinerary bersegmen cruise —
// beberapa <ol class="rc-itinerary"> — semuanya dapat handler.
// Lalai: semua hari open (terbuka). ──
(function () {
  "use strict";
  var days = document.querySelectorAll(".rc-itin-day");
  if (!days.length) return;
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

  Array.prototype.forEach.call(days, function (li) {
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

  if (allBtn) {
    allBtn.addEventListener("click", function () {
      var expand = allBtn.getAttribute("aria-expanded") !== "true";
      Array.prototype.forEach.call(days, function (li) {
        daySet(li, expand);
      });
      syncAllBtn();
    });
  }
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
