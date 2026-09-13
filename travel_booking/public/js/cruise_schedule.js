// travel_booking/public/js/cruise_schedule.js
// Modal pemilihan pakej untuk page /cruise-schedule — butang "Book Now"
// kad TIDAK terus ke /booknow. Modal papar variant sailing (Cruise Only /
// Cruise + Flight) + pakej Active setiap variant; guest pilih SATU pakej, barulah
// proceed ke /booknow?trip_master=..&trip_group_date=..
//
// Data pilihan di-PRELOAD server-side dalam cruise_schedule.py — setiap kad
// ada <script type="application/json" class="rc-sched-data"> yang mengandungi
// {trip, trip_name, sailing, variants: [{tgd, label, duration, range,
// sailing_start, seats, packages: [{name, type, flight, symbol, currency,
// price}]}]}. Modal tak panggil API.
//
// PENTING: wizard /booknow TIDAK baca URL params secara langsung — dia baca
// add-to-cart sessionStorage "bnw_cart" (ditulis oleh trip_detail.js pada
// page detail). Jadi sebelum navigasi, kita tulis bnw_cart yang SAMA
// strukturnya supaya wizard terus masuk step pakej yang dipilih.
//
// Harga dipapar dalam currency NATIVE pakej (currency billing booking — sama
// model dengan wizard /booknow). Vanilla JS sahaja (tiada framework), corak
// sama dengan trip_detail.js.

(function () {
	"use strict";

	var modal = document.getElementById("rcPkgModal");
	if (!modal) return;

	var bodyEl = document.getElementById("rcPkgModalBody");
	var titleEl = document.getElementById("rcPkgModalTitle");
	var subEl = document.getElementById("rcPkgModalSub");
	var goEl = document.getElementById("rcPkgModalGo");

	// Kad yang sedang dibuka: {trip, tgd (fallback), data (parsed JSON)}
	var current = null;
	// Pilihan semasa: {tgd, pkg} — satu pakej sahaja boleh dipilih
	var selection = null;

	// ─── INIT: bersihkan cart/wizard lama (corak trip_detail.js) ──
	// Elak restoreWizard() di /booknow tarik balik booking lama yang
	// belum siap dan abaikan pilihan baharu dari modal ni.
	try {
		sessionStorage.removeItem("bnw_cart");
		sessionStorage.removeItem("bnw_booking_wizard");
	} catch (_e) {}

	// Kod affiliate ?sp= dari URL semasa (cookie fallback dah dikutip oleh
	// affiliate_capture.js di base template).
	var AFFILIATE_CODE = "";
	try {
		var _m = window.location.search.match(/[?&]sp=([^&]+)/);
		AFFILIATE_CODE = _m ? decodeURIComponent(_m[1]).trim().toUpperCase() : "";
	} catch (_e) {}

	// ─── UTIL ─────────────────────────────────────────────────
	function esc(s) {
		return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
		});
	}

	function fmtPrice(price) {
		var n = Number(price);
		return isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "";
	}

	function seatsLabel(seats) {
		if (seats === null || seats === undefined) return ""; // UNLIMITED
		if (seats <= 0) return "Sold Out";
		if (seats <= 5) return "Only " + seats + " left";
		return seats + " seats left";
	}

	// Seats None/undefined/null = UNLIMITED (bukan sold out)
	function isSoldOut(seats) {
		return seats !== null && seats !== undefined && Number(seats) <= 0;
	}

	function parseCardData(card) {
		var el = card.querySelector("script.rc-sched-data");
		if (!el) return null;
		try {
			return JSON.parse(el.textContent);
		} catch (e) {
			return null;
		}
	}

	// ─── RENDER ───────────────────────────────────────────────
	function packageRow(pkg, tgd) {
		var priceHtml;
		if (pkg.price !== null && pkg.price !== undefined && pkg.price !== "") {
			priceHtml =
				'<span class="rc-pkg-price"><small>From</small> ' +
				esc(pkg.symbol) + fmtPrice(pkg.price) +
				"<small> / person</small></span>";
		} else {
			priceHtml = '<span class="rc-pkg-price rc-pkg-price-tba">On Request</span>';
		}

		// Detail pakej — label ikut jenis pakej: pakej penerbangan papar
		// tarikh penerbangan TGD-nya; cruise-only papar tarikh sailing
		var rows = [];
		if (pkg.cruise_only) {
			if (pkg.sail_start) rows.push(["Sailing Start", pkg.sail_start, ""]);
			if (pkg.sail_end) rows.push(["Sailing End", pkg.sail_end, ""]);
		} else {
			if (pkg.dep_date) rows.push(["Flight Departure", pkg.dep_date, ""]);
			if (pkg.ret_date) rows.push(["Flight Return Arrival", pkg.ret_date, ""]);
		}
		if (pkg.duration) rows.push(["Duration", pkg.duration, ""]);
		rows.push([
			"Ground Arrangement",
			pkg.ground ? "Included" : "Not Included",
			pkg.ground ? "is-ok" : "is-no",
		]);

		var detailHtml = rows.map(function (r) {
			return (
				'<div class="rc-pkg-drow">' +
				'<span class="rc-pkg-dlabel">' + esc(r[0]) + "</span>" +
				'<span class="rc-pkg-dval' + (r[2] ? " " + r[2] : "") + '">' +
				esc(r[1]) +
				"</span></div>"
			);
		}).join("");

		// Nama lapangan terbang hanya untuk pakej penerbangan ("No Flight"
		// untuk cruise-only tak perlu dipapar — detail tarikh dah cukup)
		var flightHtml =
			pkg.flight && !pkg.cruise_only
				? '<span class="rc-pkg-flight"><i class="ti ti-plane-departure"></i> ' +
					esc(pkg.flight) + "</span>"
				: "";

		return (
			'<button type="button" class="rc-pkg-item" data-tgd="' + esc(tgd) +
			'" data-pkg="' + esc(pkg.name) + '">' +
			'<span class="rc-pkg-top">' +
			'<span class="rc-pkg-check"><i class="ti ti-check"></i></span>' +
			'<span class="rc-pkg-type">' + esc(pkg.type) + "</span>" +
			priceHtml +
			"</span>" +
			(flightHtml || "") +
			'<span class="rc-pkg-details">' + detailHtml + "</span>" +
			"</button>"
		);
	}

	function render(data) {
		titleEl.textContent = data.trip_name || "Choose a package";
		// Sub tajuk: tarikh sailing PENUH kedua-dua hujung (cth
		// "Sailing 2 Nov 2026 – 9 Nov 2026") — sailing_full dari server;
		// fallback ke range_label ringkas bila medan tiada.
		var sailing = data.sailing_full || data.sailing || "";
		subEl.textContent = sailing ? "Sailing " + sailing : "";

		var html = "";
		var bookable = 0;
		var first = null; // {tgd, pkg} pertama — untuk pra-pilih satu pilihan

		// Senarai pakej FLAT — tiada subgroup variant (rc-pkg-vlabel
		// dibuang); jenis pakej ("Cruise Only"/"Cruise + Flight") kekal dipapar
		// pada setiap baris. Variant penuh / tanpa pakej dilangkau.
		(data.variants || []).forEach(function (v) {
			var pkgs = v.packages || [];
			if (!pkgs.length) return; // variant tanpa pakej tak boleh ditempah
			if (isSoldOut(v.seats)) return; // jangan papar variant yang dah penuh

			pkgs.forEach(function (p) {
				html += packageRow(p, v.tgd);
				if (!first) first = { tgd: v.tgd, pkg: p, sailingStart: v.sailing_start || "" };
				bookable++;
			});
		});

		if (!bookable) {
			html =
				'<div class="rc-pkg-none"><i class="ti ti-calendar-off"></i>' +
				"<p>No bookable packages for this sailing.</p>" +
				'<p class="rc-pkg-none-sub">Please contact us or check another date.</p></div>';
		}

		bodyEl.innerHTML = html;

		// Satu-satunya pilihan → pra-pilih (guest terus tekan Continue)
		selection = null;
		if (bookable === 1 && first) {
			var only = bodyEl.querySelector(".rc-pkg-item");
			if (only) {
				only.classList.add("is-selected");
				selection = { tgd: first.tgd, pkg: first.pkg, sailingStart: first.sailingStart };
			}
		}
		goEl.disabled = !selection;
	}

	// ─── OPEN / CLOSE ─────────────────────────────────────────
	function open(btn) {
		var card = btn.closest(".rc-sched-card");
		var data = card ? parseCardData(card) : null;
		// data-trip / data-tgd ada pada BUTANG (bukan kad)
		var fallbackTgd = btn.getAttribute("data-tgd") || "";
		var trip = btn.getAttribute("data-trip") || "";

		if (!data || !data.variants || !data.variants.length) {
			// Tiada data pilihan (edge) — kekalkan behavior lama: terus ke
			// wizard dengan TGD perwakilan kad.
			window.location.href =
				"/booknow?trip_master=" + encodeURIComponent(trip) +
				"&trip_group_date=" + encodeURIComponent(fallbackTgd);
			return;
		}

		// Index pakej mengikut nama — untuk bina bnw_cart semasa Continue
		var pkgByName = {};
		(data.variants || []).forEach(function (v) {
			(v.packages || []).forEach(function (p) { pkgByName[p.name] = p; });
		});

		current = { trip: trip, data: data, pkgByName: pkgByName };
		render(data);
		modal.hidden = false;
		document.body.classList.add("rc-modal-lock");
	}

	function close() {
		modal.hidden = true;
		document.body.classList.remove("rc-modal-lock");
		current = null;
		selection = null;
	}

	// ─── CONTINUE → /booknow ──────────────────────────────────
	// Wizard /booknow baca add-to-cart sessionStorage "bnw_cart" (bukan URL
	// params) — tulis cart yang sama strukturnya dengan trip_detail.js
	// proceedToBookNow(), kemudian navigate. URL params dikekalkan untuk
	// compatibility deep-link.
	function proceedToBookNow() {
		if (!current || !selection || !selection.tgd || !selection.pkg) return;
		goEl.disabled = true;

		var pkg = selection.pkg;
		var cart = {
			trip_master: current.trip,
			trip_name: current.data.trip_name || "",
			is_cruise: true,
			trip_type: "cruise",
			package_variant: pkg.name + ":" + selection.tgd,
			group_date: selection.tgd,
			sailing_start: selection.sailingStart || "",
			package_name: pkg.name,
			package_label: pkg.type,
			// Currency native pakej yang dipilih — currency billing wizard
			package_currency: pkg.currency || "MYR",
			package_currency_symbol: pkg.symbol || pkg.currency || "RM",
			company_currency: "",
			affiliate_code: AFFILIATE_CODE,
			added_at: new Date().toISOString(),
		};
		try {
			sessionStorage.setItem("bnw_cart", JSON.stringify(cart));
		} catch (e) {
			goEl.disabled = false;
			return;
		}

		// Referrer untuk Back button wizard — page schedule ni sendiri
		try { sessionStorage.setItem("bnw_referrer", window.location.href); } catch (e) {}

		window.location.href =
			"/booknow?trip_master=" + encodeURIComponent(current.trip) +
			"&trip_group_date=" + encodeURIComponent(selection.tgd);
	}

	goEl.addEventListener("click", proceedToBookNow);

	// ─── EVENTS ───────────────────────────────────────────────
	// Butang Book Now kad — delegasi (kad dirender Jinja, tak perlu bind
	// satu-satu)
	document.addEventListener("click", function (ev) {
		var btn = ev.target.closest(".rc-sched-book");
		if (btn) {
			open(btn);
			return;
		}

		// Pilih pakej dalam modal
		var item = ev.target.closest(".rc-pkg-item");
		if (item) {
			var prev = bodyEl.querySelector(".rc-pkg-item.is-selected");
			if (prev) prev.classList.remove("is-selected");
			item.classList.add("is-selected");
			var tgd = item.getAttribute("data-tgd");
			// sailing_start variant ni — dari data kad (untuk bnw_cart)
			var vStart = "";
			((current && current.data && current.data.variants) || []).forEach(function (v) {
				if (v.tgd === tgd) vStart = v.sailing_start || "";
			});
			selection = {
				tgd: tgd,
				pkg: current && current.pkgByName[item.getAttribute("data-pkg")],
				sailingStart: vStart,
			};
			goEl.disabled = false;
			return;
		}

		// Tutup: overlay, butang X, Cancel
		if (modal && !modal.hidden && ev.target.closest("[data-pkgmodal-close]")) {
			close();
		}
	});

	document.addEventListener("keydown", function (ev) {
		if (ev.key === "Escape" && !modal.hidden) close();
	});
})();
