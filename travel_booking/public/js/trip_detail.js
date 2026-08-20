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

  function populatePackages() {
    var gd = gdSel.value;
    pkgSel.innerHTML = '<option value="">Select a package</option>';
    (packages[gd] || []).forEach(function (p) {
      var o = document.createElement("option");
      o.value = p.name;
      var label = p.package_name;
      if (p.flight_label && p.flight_label !== "No Flight") label += " · " + p.flight_label;
      o.textContent = label;
      pkgSel.appendChild(o);
    });
    cabinsEl.className = "rc-cabins-empty";
    cabinsEl.innerHTML = '<p class="rc-muted">Pick a package to see room options and prices.</p>';
    updateBookLink();
    refreshItineraryDates();
  }

  function loadCabins() {
    var gd = gdSel.value, pkg = pkgSel.value;
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
    var rows = cabins.map(function (c) {
      var pr = c.pricing || {};
      var ch = pr.price_children ? fmt(pr.price_children) : '<span class="rc-muted">—</span>';
      return '<tr>'
        + '<td><strong>' + esc(c.room_name) + '</strong>'
        + (c.room_type ? '<span class="rc-cabin-type">' + esc(c.room_type) + '</span>' : '')
        + '</td>'
        + '<td>' + (c.capacity || 2) + ' pax</td>'
        + '<td>' + fmt(pr.price_adult) + '</td>'
        + '<td>' + ch + '</td>'
        + '</tr>';
    }).join("");
    cabinsEl.className = "rc-cabins-table";
    cabinsEl.innerHTML = '<table class="rc-cabin-tbl"><thead><tr>'
      + '<th>Room</th><th>Capacity</th><th>Adult</th><th>Child</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table>';
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
  pkgSel.addEventListener("change", loadCabins);
  populatePackages(); // init (isi package utk group date pertama)
})();

// ── Hero gallery slider ──
(function () {
  "use strict";
  var hero = document.getElementById("rcHero");
  if (!hero) return;
  var slides = hero.querySelectorAll(".rc-hero-slide");
  if (slides.length < 2) return; // satu gambar — tiada kawalan slider
  var dots = hero.querySelectorAll(".rc-hero-dot");
  var prev = hero.querySelector(".rc-hero-prev");
  var next = hero.querySelector(".rc-hero-next");
  var idx = 0;
  function show(n) {
    idx = (n + slides.length) % slides.length;
    Array.prototype.forEach.call(slides, function (s, i) {
      s.classList.toggle("is-active", i === idx);
    });
    Array.prototype.forEach.call(dots, function (d, i) {
      d.classList.toggle("is-active", i === idx);
    });
  }
  if (prev) prev.addEventListener("click", function () { show(idx - 1); });
  if (next) next.addEventListener("click", function () { show(idx + 1); });
  Array.prototype.forEach.call(dots, function (d) {
    d.addEventListener("click", function () { show(parseInt(d.getAttribute("data-i"), 10) || 0); });
  });
  // auto-advance 6s, jeda bila hover
  var timer = setInterval(function () { show(idx + 1); }, 6000);
  hero.addEventListener("mouseenter", function () { clearInterval(timer); });
  hero.addEventListener("mouseleave", function () {
    timer = setInterval(function () { show(idx + 1); }, 6000);
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
