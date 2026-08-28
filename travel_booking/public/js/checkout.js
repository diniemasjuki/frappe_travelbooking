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
  var RET     = _data.ret || "";   // laluan pulangan portal (cth booking_billing?ref=...)

  // Teks asal butang ("Pay RM XXX.XX") dah betul-betul dirender server-side
  // dalam HTML — tangkap terus dari DOM sebelum ditukar ke "Processing...",
  // supaya tak perlu ulang format currency/amount dalam JS.
  var submitBtnOriginalText = (document.getElementById("submit-btn") || {}).textContent || "Pay";

  var TIMEOUT_SECONDS = 300; // 5 minit
  var timeoutHandle = null;
  var paymentSettled = false; // true bila berjaya submit / dah "already_paid"

  // ── Display-currency indicative line ──────────────
  // Caj sebenar sentiasa company currency (.co-amount-value, di atas).
  // Jika user pilih display currency lain di halaman marketing, tunjuk
  // anggaran dalam currency itu di bawah jumlah caj — INDAKATIF sahaja
  // (rate dari ERPnext get_exchange_rate for_selling, BUKAN kadar dicas).
  // Pilihan dibaca dari localStorage 'rc_display_currency' yang ditulis
  // oleh converter di trip.html / trips.html.
  function initConvertedDisplay() {
    var coConverted = document.getElementById('coConverted');
    if (!coConverted) return;

    var conf = {};
    try {
      var rc = document.getElementById('rcCurrencyData');
      conf = rc ? JSON.parse(rc.textContent || '{}') : {};
    } catch (e) {}
    var companyCurrency = conf.company_currency || 'MYR';

    var cached = null;
    try { cached = JSON.parse(localStorage.getItem('rc_display_currency') || 'null'); } catch (e) {}
    // Tiada pilihan, atau company → biar kosong (caj dah papar company).
    if (!cached || !cached.currency || cached.currency === companyCurrency) {
      return;
    }

    // Amaun caj dibaca terus dari .co-amount-value (format "CCY 1234.50",
    // %.2f tiada pemisah ribuan) — elak tambah medan context tambahan.
    var amtText = (document.querySelector('.co-amount-value') || {}).textContent || '';
    var amt = parseFloat(amtText.replace(/^[^\d.-]*/, '')) || 0;
    var fmt = function (n) {
      return Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    fetch('/api/method/travel_booking.api.pricing.get_currency_rate?from_currency=' + encodeURIComponent(companyCurrency) + '&to_currency=' + encodeURIComponent(cached.currency))
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var rate = (res && res.message && res.message.rate) ? res.message.rate : null;
        if (!rate) return; // rate unavailable → biar kosong
        var sym = cached.symbol || cached.currency;
        coConverted.textContent = '\u2248 ' + sym + ' ' + fmt(amt * rate) + ' (indicative)';
      })
      .catch(function () { /* senyap — biar kosong */ });
  }
  initConvertedDisplay();

  function returnUrl() {
    var base = window.location.origin;
    // Redirect ke booknow untuk confirmation (bukan /booking)
    if (SOURCE === "wizard" && REF) {
      return base + "/booknow?ref=" + encodeURIComponent(REF) + "&step=confirm&pr=" + encodeURIComponent(PR_NAME);
    }
    // Pulangan portal — honori laluan asal customer
    // (portal lama /traveller_portal/ + portal baharu /traveller/)
    if (RET && RET.indexOf("//") !== 0 &&
        (RET.indexOf("/traveller_portal/") === 0 || RET.indexOf("/traveller/") === 0)) {
      return base + RET;
    }
    return base + "/traveller_portal/transactions";
  }

  function showPendingState() {
    if (paymentSettled) return; // elak race — bayaran sempat berjaya serentak
    document.querySelector(".co-card").innerHTML =
      '<div class="co-pending">' +
        '<div class="co-pending-title">Booking Pending</div>' +
        'This checkout session has expired. Your booking is still saved — ' +
        'please log in to the portal to continue your payment.' +
        '<br><a href="/traveller_portal">Go to Portal &rarr;</a>' +
      '</div>';

    // Beritahu server supaya emel "Pending" dihantar (jika belum).
    fetch("/api/method/travel_booking.api.stripe_checkout.mark_checkout_timeout?pr=" + encodeURIComponent(PR_NAME))
      .catch(function() { /* senyap — UI dah papar pending walau apa pun */ });
  }

  function startTimeoutTimer() {
    timeoutHandle = setTimeout(showPendingState, TIMEOUT_SECONDS * 1000);
  }

  // ── Back button — batalkan Payment Request & kembali ke booknow/portal ──
  // Dipasang AWAL (di luar init() async) supaya berfungsi walaupun Stripe
  // Payment Element gagal dimuat. Klik → cancel PR di server, kemudian
  // redirect balik ke booknow (wizard) atau portal (ret).
  //
  // Wizard state (bnw_booking_wizard) TIDAK dibuang — ia tersimpan di
  // sessionStorage sebelum redirect ke checkout. Bila customer kembali ke
  // /booknow, restoreWizard() pulihkan Step 3 (payment step) supaya
  // customer boleh tukar kaedah bayaran (cth Online → Manual Transfer)
  // dan re-confirm. Backend cancel booking lama (elak duplicate) bila
  // booking_number dihantar semula.
  var backBtn = document.getElementById("co-back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", function() {
      // Kalau bayaran dah settle (succeeded/already_paid), tak perlu cancel —
      // just kembali ke halaman sebelumnya.
      if (paymentSettled) {
        window.history.back();
        return;
      }
      backBtn.disabled = true;
      backBtn.textContent = "Cancelling...";
      if (timeoutHandle) clearTimeout(timeoutHandle);

      fetch("/api/method/travel_booking.api.stripe_checkout.cancel_checkout_payment?pr=" + encodeURIComponent(PR_NAME))
        .then(function() { /* hasil tak penting — redirect tetap jalan */ })
        .catch(function() { /* senyap — redirect tetap jalan walau gagal */ })
        .then(function() {
          var base = window.location.origin;
          // Portal flow — honori laluan asal customer (ret).
          if (RET && RET.indexOf("//") !== 0 &&
              (RET.indexOf("/traveller_portal/") === 0 || RET.indexOf("/traveller/") === 0)) {
            window.location.href = base + RET;
            return;
          }
          // Wizard flow — kembali ke /booknow (plain, tanpa step=confirm)
          // supaya restoreWizard() jalan & pulihkan Step 3. Customer boleh
          // tukar kaedah bayaran & re-confirm. booking_number tersimpan dalam
          // wizard state supaya backend tahu untuk cancel booking lama.
          window.location.href = base + "/booknow";
        });
    });
  }

  async function init() {
    var errBox = document.getElementById("co-error");
    try {
      var res = await fetch("/api/method/travel_booking.api.stripe_checkout.get_checkout_context?pr=" + encodeURIComponent(PR_NAME));
      var data = await res.json();
      var ctx = data.message || data;

      if (ctx.status === "already_paid") {
        paymentSettled = true;
        document.querySelector(".co-card").innerHTML = '<div class="co-paid">✓ This payment has already been completed.<br>You can close this page.</div>';
        return;
      }
      if (ctx.status !== "ok") {
        throw new Error(ctx.message || "Failed to load the payment form.");
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
      // paymentMethodOrder: "card" (online payment gateway) dahulukan supaya
      // ia menjadi pilihan default terpilih dalam Stripe Payment Element.
      var paymentElement = elements.create("payment", { paymentMethodOrder: ["card"] });
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
          errBox.textContent = result.error.message || "Payment failed. Please try again.";
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
        '<div style="color:#B3261E">Error: ' + (err.message || "Failed to load the payment form.") + '</div>';
    }
  }

  init();
})();