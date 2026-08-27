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

  var SYM = DATA.company_symbol || "RM";
  var groupDatesData = DATA.group_dates || [];
  var is_cruise = !!DATA.is_cruise;
  var TRIP_TYPE = is_cruise ? "cruise" : "non_cruise";
  var PRICE_LABELS = [];

  // NOTE: packages TIDAK di-preload. populatePackages() buat AJAX call
  // ke search_packages_by_date bila user pilih tarikh.

  var gdSel = document.getElementById("rcDetailGroupDate");
  var pkgSel = document.getElementById("rcDetailPackage");
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

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }
  function fmt(a) {
    a = Number(a) || 0;
    return SYM + " " + Math.round(a).toLocaleString(undefined, {
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
  }
  function addDaysLabel(iso, n) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // ── Selected package state ──
  // group_date datang dari API response (package's trip_group_date),
  // BUKAN dari date radio — ini memastikan data consistency.
  var _selectedPkg = "";
  var _selectedPkgGd = "";

  function getSelectedDateValue() {
    var checked = gdSel.querySelector("input[name='rc_group_date']:checked");
    return checked ? checked.value : "";
  }
  function getSelectedGroupDateBase() {
    var checked = gdSel.querySelector("input[name='rc_group_date']:checked");
    return checked ? checked.getAttribute("data-base") : "";
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
  function populateDates() {
    gdSel.innerHTML = "";
    if (!groupDatesData.length) {
      gdSel.innerHTML = '<p class="rc-muted">No dates available.</p>';
      return;
    }

    var allRadios = [];
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
      radio.setAttribute("data-base", startDate);
      radio.className = "rc-date-radio";
      if (_wishGd && gdData.name === _wishGd) radio.checked = true;
      else if (!_wishGd && idx === 0) radio.checked = true;

      var label = document.createElement("label");
      label.htmlFor = radioId;
      label.className = "rc-date-radio-label";

      var dateText = startDate;
      if (is_cruise && gdData.sailing_end) {
        dateText += " → " + gdData.sailing_end;
      } else if (gdData.return_date) {
        dateText += " → " + gdData.return_date;
      }
      var seatsHtml = "";
      if (gdData.seats_left != null) {
        if (gdData.seats_left === 0) {
          seatsHtml = " · <strong>Sold out</strong>";
        } else if (gdData.seats_left <= 3) {
          seatsHtml = " · " + gdData.seats_left + " left";
        }
      }
      label.innerHTML = '<span class="rc-date-radio-text">' + esc(dateText) + seatsHtml + '</span>';

      // Click handler — force update checked state, then AJAX fetch packages
      radio.addEventListener("click", function () {
        Array.prototype.forEach.call(allRadios, function (r) {
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

      gdSel.appendChild(radio);
      gdSel.appendChild(label);
      allRadios.push(radio);
    });

    // Auto-select first date → AJAX fetch packages
    populatePackages();
    refreshItineraryDates();
  }

  // ════ STEP 3: Load packages for selected date ════
  // Preloaded from get_trip_detail (cruise-deduped) — avoids
  // search_packages_by_date returning packages from deduped group
  // dates with mismatched trip_group_date. Falls back to AJAX if
  // preloaded data is missing for the selected group date.
  function populatePackages() {
    pkgSel.innerHTML = '<p class="rc-muted">Loading packages…</p>';
    _selectedPkg = "";
    _selectedPkgGd = "";
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
    var pkgs = preloaded[gdId];

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
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rc-pkg-btn";
      btn.setAttribute("data-value", p.name);
      btn.setAttribute("data-gd-id", p.trip_group_date);
      var pt = (p.package_type || "").toLowerCase();
      var flight = p.flight || "";
      if (pt === "cruise only") {
        btn.innerHTML = "Cruise Only";
      } else if (pt === "ground only") {
        btn.innerHTML = "Ground Only";
      } else if ((pt === "fly cruise" || pt.indexOf("fly") >= 0) && flight) {
        btn.innerHTML = "Fly Cruise from <b>" + esc(flight) + "</b>";
      } else if ((pt === "fly package" || pt.indexOf("fly") >= 0) && flight) {
        btn.innerHTML = "Fly Package from <b>" + esc(flight) + "</b>";
      } else {
        btn.innerHTML = esc(p.package_name || p.name);
      }
      btn.addEventListener("click", function () { selectPackage(p.name, p.trip_group_date); });
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
    selectPackage(_initPkg.name, _initPkg.trip_group_date);
  }

  // ── Select package — stores BOTH package name AND its group_date ──
  // group_date datang dari API response, bukan dari date radio
  function selectPackage(name, gd) {
    _selectedPkg = name;
    _selectedPkgGd = gd;
    Array.prototype.forEach.call(pkgSel.querySelectorAll(".rc-pkg-btn"), function (b) {
      b.classList.toggle("rc-pkg-active", b.getAttribute("data-value") === name);
    });
    loadCabins();
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

  // ════ STEP 4: Book Now → save package_variant to session ════
  function addToCart(e) {
    e.preventDefault();
    var gd = _selectedPkgGd;
    var pkg = _selectedPkg || null;

    if (!gd || !pkg) {
      gdSel.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

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
      package_name: pkg,                                // backward compat
      package_label: pkgLabel,
      company_currency: DATA.company_symbol || "RM",
      affiliate_code: _sp,                              // rambat ke /booknow
      added_at: new Date().toISOString()
    };

    try {
      sessionStorage.setItem("bnw_cart", JSON.stringify(cart));
    } catch (err) {
      return;
    }

    // Append ?sp= ke /booknow supaya prefillAffiliateCodeFromUrl() di wizard
    // terus apply kod affiliate — bnw_cart.affiliate_code ialah fallback.
    var bnwUrl = "/booknow";
    if (_sp) bnwUrl += "?sp=" + encodeURIComponent(_sp);
    window.location.href = bnwUrl;
  }

  function refreshItineraryDates() {
    var base = getSelectedGroupDateBase();
    Array.prototype.forEach.call(document.querySelectorAll(".rc-itin-day"), function (li) {
      var day = parseInt(li.getAttribute("data-day"), 10) || 1;
      var mk = li.querySelector(".rc-itin-marker span");
      if (!mk) return;
      mk.textContent = base ? ("Day " + day + " · " + addDaysLabel(base, day - 1)) : ("Day " + day);
    });
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
