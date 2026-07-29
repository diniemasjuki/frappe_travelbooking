// travel_booking/public/js/checkout.js
// Stripe Checkout page — logic penuh (dipindah keluar dari www/checkout.html
// untuk organisasi kod yang lebih kemas — markup & logic diasingkan, ikut
// pattern yang sama dengan booking.js/portal.js).
//
// Data dari Frappe (pr_name, source, ref) dibaca dari elemen
// <script id="pageData"> yang kekal inline dalam checkout.html (perlu
// Jinja templating server-side, tak boleh dipindah ke fail static).

(function() {
  var _data  = JSON.parse(document.getElementById("pageData").textContent);
  var PR_NAME = _data.pr_name;
  var SOURCE  = _data.source;
  var REF     = _data.ref;

  // Teks asal butang ("Pay RM XXX.XX") dah betul-betul dirender server-side
  // dalam HTML — tangkap terus dari DOM sebelum ditukar ke "Processing...",
  // supaya tak perlu ulang format currency/amount dalam JS.
  var submitBtnOriginalText = (document.getElementById("submit-btn") || {}).textContent || "Pay";

  var TIMEOUT_SECONDS = 300; // 5 minit
  var timeoutHandle = null;
  var paymentSettled = false; // true bila berjaya submit / dah "already_paid"

  function returnUrl() {
    var base = window.location.origin;
    if (SOURCE === "wizard" && REF) {
      return base + "/booking?ref=" + encodeURIComponent(REF) + "&step=confirm&pr=" + encodeURIComponent(PR_NAME);
    }
    return base + "/traveller_portal?paid=1";
  }

  function showPendingState() {
    if (paymentSettled) return; // elak race — bayaran sempat berjaya serentak
    document.querySelector(".co-card").innerHTML =
      '<div class="co-pending">' +
        '<div class="co-pending-title">Booking Pending</div>' +
        'Checkout ini telah tamat tempoh. Booking anda masih disimpan — ' +
        'sila log masuk ke portal untuk menyambung pembayaran.' +
        '<br><a href="/traveller_portal">Go to Portal &rarr;</a>' +
      '</div>';

    // Beritahu server supaya emel "Pending" dihantar (jika belum).
    fetch("/api/method/travel_booking.api.stripe_checkout.mark_checkout_timeout?pr=" + encodeURIComponent(PR_NAME))
      .catch(function() { /* senyap — UI dah papar pending walau apa pun */ });
  }

  function startTimeoutTimer() {
    timeoutHandle = setTimeout(showPendingState, TIMEOUT_SECONDS * 1000);
  }

  async function init() {
    var errBox = document.getElementById("co-error");
    try {
      var res = await fetch("/api/method/travel_booking.api.stripe_checkout.get_checkout_context?pr=" + encodeURIComponent(PR_NAME));
      var data = await res.json();
      var ctx = data.message || data;

      if (ctx.status === "already_paid") {
        paymentSettled = true;
        document.querySelector(".co-card").innerHTML = '<div class="co-paid">✓ Payment ini telah selesai.<br>Anda boleh tutup halaman ini.</div>';
        return;
      }
      if (ctx.status !== "ok") {
        throw new Error(ctx.message || "Gagal memuatkan borang pembayaran.");
      }

      var stripe   = Stripe(ctx.publishable_key);
      var elements = stripe.elements({ clientSecret: ctx.client_secret, appearance: {
        theme: 'stripe',
        variables: {
          colorPrimary: '#C9A84C',
          fontFamily: 'Archivo, sans-serif',
          borderRadius: '8px'
        }
      }});
      var paymentElement = elements.create("payment");
      paymentElement.mount("#payment-element");

      document.getElementById("loading-state").style.display = "none";
      document.getElementById("payment-form").style.display = "block";

      startTimeoutTimer();

      document.getElementById("payment-form").addEventListener("submit", async function(e) {
        e.preventDefault();
        var btn = document.getElementById("submit-btn");
        btn.disabled = true;
        btn.textContent = "Processing...";
        errBox.style.display = "none";

        var result = await stripe.confirmPayment({
          elements: elements,
          confirmParams: { return_url: returnUrl() }
        });

        if (result.error) {
          // Stripe confirm gagal (cth kad ditolak) — biar customer cuba
          // lagi di page yang sama. Emel "Pending" untuk kegagalan RASMI
          // (payment_intent.payment_failed) dihantar oleh webhook server-side,
          // bukan dari sini — elak spam emel setiap kali retry gagal.
          errBox.textContent = result.error.message || "Payment gagal. Sila cuba lagi.";
          errBox.style.display = "block";
          btn.disabled = false;
          btn.textContent = submitBtnOriginalText;
        } else {
          paymentSettled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        // Kalau berjaya, Stripe auto-redirect ke return_url — tiada else perlu.
      });
    } catch (err) {
      document.getElementById("loading-state").innerHTML =
        '<div style="color:#B3261E">Ralat: ' + (err.message || "Gagal memuatkan borang pembayaran.") + '</div>';
    }
  }

  init();
})();