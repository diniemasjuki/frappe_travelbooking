// Featured Cruise Packages — Builder page client script (Fasa 5B).
//
// Fetch travel_booking.utils.featured_catalog.api_featured_packages
// (guest-accessible) dan bina kad pakej dalam #rc-featured-grid.
// Guna token brand rarecation_* (Builder Tokens sedia ada).

(function () {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtPrice(cur, amount) {
    if (amount == null) return "";
    var n = Number(amount);
    var s = n % 1 === 0 ? String(n) : n.toFixed(2);
    return esc(cur || "") + " " + s;
  }

  function cardHtml(p) {
    var gds = p.group_dates || [];
    var datesLine = "";
    if (gds.length) {
      datesLine = '<div class="rcp-dates">&#128197; ' + esc(gds[0].label || "");
      if (gds.length > 1) {
        datesLine += ' <span style="color:#999;">+' + (gds.length - 1) +
          " more date" + (gds.length > 2 ? "s" : "") + "</span>";
      }
      datesLine += "</div>";
    }
    var img = p.trip_image
      ? '<div class="rcp-img"><img src="' + esc(p.trip_image) +
        '" alt="' + esc(p.package_title) + '" loading="lazy"></div>'
      : "";
    var price = p.from_price != null
      ? '<div class="rcp-price"><span class="rcp-from">From</span>' +
        '<span class="rcp-amount">' + fmtPrice(p.currency, p.from_price) + "</span></div>"
      : "";
    return (
      '<a class="rcp-card" href="' + esc(p.trip_route || "/cruises") + '">' +
      img +
      '<div class="rcp-body">' +
      '<div class="rcp-type">' + esc(p.package_type || "Package") + "</div>" +
      '<div class="rcp-title">' + esc(p.package_title) + "</div>" +
      '<div class="rcp-trip">' + esc(p.trip_name) + "</div>" +
      datesLine +
      '<div class="rcp-foot">' + price +
      '<span class="rcp-view">View &rarr;</span></div>' +
      "</div></a>"
    );
  }

  function injectCss() {
    if (document.getElementById("rcp-style")) return;
    var css = [
      "#rc-featured-grid{box-sizing:border-box;}",
      ".rcp-card{display:flex;flex-direction:column;width:340px;max-width:100%;",
      "background:#fff;border:1px solid #E5E0D5;border-radius:14px;overflow:hidden;",
      "text-decoration:none;color:inherit;transition:transform .15s,box-shadow .15s;}",
      ".rcp-card:hover{transform:translateY(-3px);box-shadow:0 10px 28px rgba(30,28,24,.12);}",
      ".rcp-img{height:170px;overflow:hidden;}",
      ".rcp-img img{width:100%;height:100%;object-fit:cover;}",
      ".rcp-body{display:flex;flex-direction:column;gap:7px;padding:16px 18px 18px;flex:1;}",
      ".rcp-type{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#B0862A;}",
      ".rcp-title{font-size:16.5px;font-weight:600;color:#1E1C18;line-height:1.35;}",
      ".rcp-trip{font-size:12.5px;color:#7D7A70;}",
      ".rcp-dates{font-size:12.5px;color:#555;}",
      ".rcp-foot{margin-top:auto;padding-top:12px;display:flex;align-items:baseline;",
      "justify-content:space-between;border-top:1px solid #F0EDE6;}",
      ".rcp-from{font-size:11px;color:#999;margin-right:6px;}",
      ".rcp-amount{font-size:17px;font-weight:700;color:#C47900;}",
      ".rcp-view{font-size:13px;color:#C47900;font-weight:600;}"
    ].join("");
    var el = document.createElement("style");
    el.id = "rcp-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  function render(pkgs) {
    injectCss();
    var grid = document.getElementById("rc-featured-grid");
    var empty = document.getElementById("rc-featured-empty");
    if (!grid) return;
    if (!pkgs || !pkgs.length) {
      grid.innerHTML = "";
      if (empty) {
        empty.querySelector("p").textContent =
          "No featured packages right now — check back soon.";
      }
      return;
    }
    if (empty) empty.style.display = "none";
    grid.innerHTML = pkgs.map(cardHtml).join("");
  }

  function fetchCsrf() {
    try {
      var el = document.getElementById("pageData");
      if (el) return JSON.parse(el.textContent).csrf_token || "";
    } catch (e) {}
    return "";
  }

  function load() {
    var currency = "";
    try {
      currency = localStorage.getItem("rc_currency") || "";
    } catch (e) {}
    var body = { vertical: "cruise", limit: 12 };
    if (currency) body.currency = currency;

    fetch("/api/method/travel_booking.utils.featured_catalog.api_featured_packages", {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "X-Frappe-CSRF-Token": fetchCsrf() },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        render((res.message || {}).packages || []);
      })
      .catch(function () {
        render([]);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
