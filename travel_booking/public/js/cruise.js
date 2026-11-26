/* travel_booking/public/js/cruise.js
   Interactions for /cruise homepage — DIMIGRASI ke Bootstrap 5:
   - Hero banner + testimonial slider kini komponen Bootstrap
     carousel (data-bs-ride) — tiada JS slider custom lagi.
   Yang kekal di sini:
   - Pecahan Sailing Month gabungan ke month=&year= semasa submit
   - Smooth scroll untuk anchor links */

(function () {
  "use strict";

  /* ── Search bar homepage (rcHomeFilters) — pecahkan Sailing Month
     gabungan "YYYY-MM" ke hidden month= & year= semasa submit (GET →
     /cruises yang terima bulan/tahun berasingan). ── */
  var homeForm = document.getElementById("rcHomeFilters");
  if (homeForm) {
    homeForm.addEventListener("submit", function () {
      var sel = document.getElementById("rcHomeMonthYear");
      var m = homeForm.querySelector('input[name="month"]');
      var y = homeForm.querySelector('input[name="year"]');
      var v = (sel && sel.value) ? sel.value.split("-") : null;
      if (m) m.value = v ? String(parseInt(v[1], 10) || "") : "";
      if (y) y.value = v ? v[0] : "";
    });
  }

  /* ── Smooth Scroll for internal anchor links ── */
  document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
    anchor.addEventListener("click", function (e) {
      var targetId = this.getAttribute("href");
      if (targetId.length > 1) {
        var target = document.querySelector(targetId);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    });
  });

})();
