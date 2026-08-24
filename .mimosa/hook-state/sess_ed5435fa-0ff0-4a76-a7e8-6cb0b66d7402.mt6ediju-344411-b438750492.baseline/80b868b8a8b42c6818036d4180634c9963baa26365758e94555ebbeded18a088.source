/* travel_booking/public/js/tour.js
   Interactions for /tour homepage:
   - Testimonial auto-slider with dots
   - Smooth scroll for anchor links
   - Hero search widget enhancement */

(function () {
  "use strict";

  /* ── Testimonial Slider ── */
  var slider = document.getElementById("rcTestimonialSlider");
  if (slider) {
    var track = slider.querySelector(".rc-track");
    var dotsContainer = document.getElementById("rcSliderDots");
    var cards = track ? track.querySelectorAll(".rc-testi-card") : [];
    var current = 0;
    var total = cards.length;
    var autoInterval;

    if (total > 0 && dotsContainer) {
      // Create dots
      for (var i = 0; i < total; i++) {
        (function (idx) {
          var dot = document.createElement("button");
          dot.setAttribute("type", "button");
          dot.setAttribute("aria-label", "Go to testimonial " + (idx + 1));
          dot.addEventListener("click", function () { goTo(idx); });
          dotsContainer.appendChild(dot);
        })(i);
      }

      function updateDots() {
        var dots = dotsContainer.querySelectorAll("button");
        for (var j = 0; j < dots.length; j++) {
          dots[j].classList.toggle("active", j === current);
        }
      }

      function goTo(idx) {
        current = idx;
        var cardWidth = cards[0] ? cards[0].offsetWidth : 300;
        var gap = 24;
        if (track) {
          track.style.transform = "translateX(-" + (current * (cardWidth + gap)) + "px)";
        }
        updateDots();
        resetAuto();
      }

      function next() {
        goTo((current + 1) % total);
      }

      function resetAuto() {
        clearInterval(autoInterval);
        autoInterval = setInterval(next, 5000);
      }

      // Initialize
      updateDots();
      resetAuto();

      // Pause on hover
      slider.addEventListener("mouseenter", function () { clearInterval(autoInterval); });
      slider.addEventListener("mouseleave", resetAuto);

      // Touch/swipe support for mobile
      var startX = 0;
      var isDragging = false;

      if (track) {
        track.addEventListener("touchstart", function (e) {
          startX = e.touches[0].clientX;
          isDragging = true;
        }, { passive: true });

        track.addEventListener("touchend", function (e) {
          if (!isDragging) return;
          isDragging = false;
          var diff = startX - e.changedTouches[0].clientX;
          if (Math.abs(diff) > 50) {
            if (diff > 0) next();
            else goTo((current - 1 + total) % total);
          }
        }, { passive: true });
      }
    }
  }

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
