// travel_booking/public/js/trip_detail.js
//
// Widget keberangkatan + pricing untuk page detail trip /trip/<slug>.
// Vanilla JS (sepadan portal, tiada frappe JS bundle diperlukan). Panggil
// pricing.get_booking_details (whitelist allow_guest) via /api/method.
//
// Aliran: pilih group date -> isi package <select> -> pilih package ->
// fetch get_booking_details -> render jadual kabin/harga -> enable Book Now
// (deep-link /booking?trip_master=&trip_group_date=). Bila group date
// berubah, label setiap hari itinerary dikemaskini ikut tarikh sebenar

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
// (base_date + day-1).
(function () {
  "use strict";
  var dataEl = document.getElementById("rcDetailData");
  if (!dataEl) return;
  var DATA;
  try { DATA = JSON.parse(dataEl.textContent); } catch (e) { return; }
  var SYM = DATA.company_symbol || "RM";
  var packages = DATA.trip_packages || {};

  var gdSel = document.getElementById("rcDetailGroupDate");
  var pkgSel = document.getElementById("rcDetailPackage");
  var cabinsEl = document.getElementById("rcDetailCabins");
  var bookBtn = document.getElementById("rcDetailBookBtn");
  if (!gdSel) return; // tiada departures — widget tak dirender

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

  var _selectedPkg = "";

  function populatePackages() {
    var gd = gdSel.value;
    pkgSel.innerHTML = "";
    var pkgs = packages[gd] || [];
    if (!pkgs.length) {
      pkgSel.innerHTML = '<p class="rc-muted">No packages available.</p>';
      _selectedPkg = "";
      cabinsEl.className = "rc-cabins-empty";
      cabinsEl.innerHTML = '<p class="rc-muted">Pick a package to see room options and prices.</p>';
      updateBookLink();
      refreshItineraryDates();
      return;
    }
    pkgs.forEach(function (p) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rc-pkg-btn";
      btn.setAttribute("data-value", p.name);
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
      btn.addEventListener("click", function () { selectPackage(p.name); });
      pkgSel.appendChild(btn);
    });
    selectPackage(pkgs[0].name);
    refreshItineraryDates();
  }

  function selectPackage(name) {
    _selectedPkg = name;
    Array.prototype.forEach.call(pkgSel.querySelectorAll(".rc-pkg-btn"), function (b) {
      b.classList.toggle("rc-pkg-active", b.getAttribute("data-value") === name);
    });
    loadCabins();
  }
  function loadCabins() {
    var gd = gdSel.value, pkg = _selectedPkg;
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
        cabinsEl.innerHTML = '<p class="rc-muted">Couldn’t load pricing. Please try again.</p>';
      });
  }

  function renderCabins(data) {
    var cabins = (data && data.cabins) || [];
    if (!cabins.length) {
      cabinsEl.className = "rc-cabins-empty";
      cabinsEl.innerHTML = '<p class="rc-muted">No room options for this package.</p>';
      return;
    }
    // Cari harga terendah merentasi semua kabin
    var minAdult = Infinity, minChild = Infinity;
    cabins.forEach(function (c) {
      var pr = c.pricing || {};
      if (pr.price_adult != null && Number(pr.price_adult) < minAdult) {
        minAdult = Number(pr.price_adult);
      }
      if (pr.price_children != null && Number(pr.price_children) < minChild) {
        minChild = Number(pr.price_children);
      }
    });
    var html = '<div class="rc-price-summary">';
    html += '<div class="rc-price-row"><span class="rc-price-label">Adult from</span><span class="rc-price-value">' + fmt(minAdult) + '</span></div>';
    if (minChild < Infinity) {
      html += '<div class="rc-price-row"><span class="rc-price-label">Child from</span><span class="rc-price-value">' + fmt(minChild) + '</span></div>';
    }
    html += '</div>';
    cabinsEl.className = "rc-cabins-summary";
    cabinsEl.innerHTML = html;
  }

  function updateBookLink() {
    if (!bookBtn) return;
    var gd = gdSel.value;
    var base = "/booking?trip_master=" + encodeURIComponent(DATA.trip_master);
    if (!gd) { bookBtn.href = base; bookBtn.classList.add("rc-btn-disabled"); return; }
    bookBtn.href = base + "&trip_group_date=" + encodeURIComponent(gd);
    bookBtn.classList.remove("rc-btn-disabled"); // gd cukup; package dipakai di step-2
  }

  function refreshItineraryDates() {
    var opt = gdSel.options[gdSel.selectedIndex];
    var base = opt && opt.getAttribute("data-base");
    Array.prototype.forEach.call(document.querySelectorAll(".rc-itin-day"), function (li) {
      var day = parseInt(li.getAttribute("data-day"), 10) || 1;
      var mk = li.querySelector(".rc-itin-marker span");
      if (!mk) return;
      mk.textContent = base ? ("Day " + day + " · " + addDaysLabel(base, day - 1)) : ("Day " + day);
    });
  }

  gdSel.addEventListener("change", populatePackages);
  populatePackages(); // init (isi package utk group date pertama)
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
    // tutup semua (accordion single-buka)
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
