// travel_booking/public/js/geo_currency.js
//
// Default currency by location — bahagian CLIENT-SIDE (dimuat di semua
// page awam melalui base_travel.html, corak sama affiliate_capture.js).
// Bahagian server (default render mengikut IP) ada dalam
// travel_booking/utils/geo_currency.py.
//
// Dua tanggungjawab:
//
// 1. SYNC PILIHAN USER (?currency= → cookie + localStorage).
//    Setiap kali URL bawa ?currency=X (selector currency, form filter
//    katalog, link berkongsi), pilihan disimpan sebagai cookie
//    first-party `rc_currency` (setahun) supaya SERVER boleh render
//    pilihan user pada kunjungan seterusnya TANPA reload bootstrap —
//    cookie dibaca oleh utils/geo_currency.py resolve_website_currency.
//    localStorage["rc_currency"] kekal diguna oleh selector sedia ada.
//
// 2. BROWSER GEOLOCATION (sekali sahaja, hanya jika user belum pernah
//    pilih currency). Server dah render default mengikut IP; kalau
//    user benarkan lokasi browser (lebih tepat dari IP — VPN/roaming),
//    koordinat di-reverse-geocode (BigDataCloud client API — free, no
//    key) ke kod negara, dipetakan ikut config Travel Website
//    (#rcGeoCurrency). Kalau currency hasil GPS BERBEZA dari yang
//    dirender, simpan sebagai pilihan + reload SEKALI. Kalau ditolak /
//    gagal — tiada tindakan (default IP kekal), dan tidak diminta lagi
//    (flag rc_geo_prompted).
//
// Config di-embed oleh base_travel.html:
//   <script id="rcGeoCurrency" type="application/json">
//     {"enabled": true, "map": {"MY": "MYR", "SG": "SGD"},
//      "currency": "MYR"}   ← currency yang dirender server semasa
//   </script>
(function () {
  "use strict";

  var COOKIE = "rc_currency";
  var ONE_YEAR = 31536000;
  var PROMPT_FLAG = "rc_geo_prompted";

  function readConfig() {
    try {
      var el = document.getElementById("rcGeoCurrency");
      if (!el) return null;
      return JSON.parse(el.textContent || "{}");
    } catch (e) {
      return null;
    }
  }

  function saveChoice(currency) {
    try {
      window.localStorage.setItem(COOKIE, currency);
    } catch (e) {
      /* storage disekat — cookie sahaja cukup untuk server */
    }
    document.cookie =
      COOKIE + "=" + encodeURIComponent(currency) +
      "; path=/; max-age=" + ONE_YEAR + "; SameSite=Lax";
  }

  function reloadWithCurrency(currency) {
    var u = new URL(window.location.href);
    u.searchParams.set("currency", currency);
    window.location.replace(u.toString());
  }

  // ── 1. Sync pilihan eksplisit dari URL ──
  try {
    var chosen = new URLSearchParams(window.location.search).get("currency");
    if (chosen) {
      chosen = chosen.trim().toUpperCase();
      if (chosen) saveChoice(chosen);
      return; // pilihan eksplisit baru saja dibuat — jangan minta lokasi
    }
  } catch (e) {
    /* URL parse gagal — terus bahagian 2 */
  }

  // ── 2. Browser geolocation (sekali sahaja) ──
  var cfg = readConfig();
  if (!cfg || !cfg.enabled) return;
  if (!cfg.currency) return; // page tanpa currency listing (cth wizard)
  if (!cfg.map || !Object.keys(cfg.map).length) return;
  if (!navigator.geolocation) return;

  try {
    if (window.localStorage.getItem(PROMPT_FLAG)) return; // sudah dicuba
    window.localStorage.setItem(PROMPT_FLAG, "1");
  } catch (e) {
    return; // storage disekat — elak prompt berulang tanpa flag
  }

  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var lat = pos && pos.coords && pos.coords.latitude;
      var lng = pos && pos.coords && pos.coords.longitude;
      if (lat == null || lng == null) return;
      // Reverse geocode client-side (free, no key, CORS). Respons:
      // {"countryCode": "MY", ...}
      fetch(
        "https://api.bigdatacloud.net/data/reverse-geocode-client" +
          "?latitude=" + encodeURIComponent(lat) +
          "&longitude=" + encodeURIComponent(lng) +
          "&localityLanguage=en"
      )
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var code = ((d && d.countryCode) || "").toUpperCase();
          var currency = code && cfg.map[code];
          if (currency && currency !== cfg.currency) {
            saveChoice(currency);
            reloadWithCurrency(currency);
          }
        })
        .catch(function () { /* gagal reverse geocode — default IP kekal */ });
    },
    function () {
      /* ditolak / gagal / timeout — default IP kekal; flag halang prompt lagi */
    },
    { timeout: 8000, maximumAge: 600000 }
  );
})();
