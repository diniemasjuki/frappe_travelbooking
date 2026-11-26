/* travel_booking/public/js/tour.js
   Interactions for /tour homepage — DIMIGRASI ke Bootstrap 5:
   - Testimonial slider kini komponen Bootstrap carousel
     (data-bs-ride) — tiada JS slider custom lagi.
   Yang kekal di sini:
   - Hero search widget enhancement (focus glow)
   - Smooth scroll untuk anchor links */

(function () {
  "use strict";

  /* ── Hero Search Enhancement ── */
  var heroSearch = document.querySelector(".rc-hero-search");
  if (heroSearch) {
    var inputs = heroSearch.querySelectorAll("input, select");
    inputs.forEach(function (input) {
      input.addEventListener("focus", function () {
        heroSearch.style.boxShadow = "0 24px 70px rgba(201,168,76,.18)";
      });
      input.addEventListener("blur", function () {
        heroSearch.style.boxShadow = "";
      });
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
