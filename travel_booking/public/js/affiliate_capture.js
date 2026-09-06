// travel_booking/public/js/affiliate_capture.js
//
// Capture kod affiliate dari URL (?sp=<kod referral>) ke cookie first-party
// `rc_aff` (30 hari) — berjalan di SEMUA page awam cruise/tour, tak kira
// widget chat aktif atau tidak.
//
// Kenapa cookie: attribution affiliate mesti bertahan BERHARI-HARI sehingga
// customer benar-benar buat tempahan. Aliran sebenar pelanggan:
//   hari 1: mendarat dari link affiliate di mana-mana page (?sp=CODE)
//         → cookie disimpan di sini
//   hari 1-30: browse trip, tutup tab, balik esok (sessionStorage hilang,
//         cookie kekal)
//   hari N: Book Now → wizard /booknow — prefillAffiliateCodeFromUrl()
//         baca cookie ni sebagai fallback → kod di-apply → confirm_booking
//         hantar affiliate_code → attribution Sales Partner + commission.
//
// Cookie juga dibaca oleh widget chat (chat_widget.html) untuk attribution
// Travel Inquiry, dan dikosongkan oleh removeAffiliateCode() dalam wizard
// bila customer buang kod secara sengaja.
//
// Param 'sp' (bukan 'ref') — 'ref' dikhaskan untuk booking_number
// selepas redirect Stripe (rujuk prefillAffiliateCodeFromUrl()).
(function () {
  try {
    var m = window.location.search.match(/[?&]sp=([^&]+)/);
    if (!m) return;
    var code = decodeURIComponent(m[1]).trim().toUpperCase();
    if (!code) return;
    document.cookie =
      "rc_aff=" + encodeURIComponent(code) + "; path=/; max-age=2592000; SameSite=Lax";
  } catch (e) {
    /* cookie disekat browser — attribution URL sahaja diguna */
  }
})();
