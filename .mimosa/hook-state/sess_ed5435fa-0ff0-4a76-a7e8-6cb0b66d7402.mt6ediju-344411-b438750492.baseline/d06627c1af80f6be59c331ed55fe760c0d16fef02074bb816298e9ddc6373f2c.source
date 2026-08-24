// travel_booking/public/js/trips.js
//
// Progressive enhancement untuk page katalog /trips. Vanilla JS (tiada
// framework) — sepadan dengan portal sedia ada.
//
// Auto-submit bar penapis bila <select> atau <input type="date"> berubah
// — penapis terus apply tanpa perlu klik "Search". Input teks (q) kekal
// perlu Enter (elak reload setiap keystroke). Ikut pola IIFE portal.
(function () {
  "use strict";
  var form = document.getElementById("rcTripFilters");
  if (!form) return;

  form.addEventListener("change", function (e) {
    var el = e.target;
    if (el.tagName === "SELECT" || el.type === "date") {
      if (form.requestSubmit) form.requestSubmit();
      else form.submit();
    }
  });
})();
