// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// Butang "Resync & Regenerate" — kira semula snapshot Booking dari semua
// Sales Order berkaitan dan jana semula data terkait yang HILANG sahaja
// (reservation, invois, link Contact/Address, dsb). Backend:
// travel_booking.api.booking_hub.resync_booking()
//
// ALERT OVERWRITE: bila penciptaan reservation ditolak validasi (cth room
// capacity limitation / mismatch room category), backend pulangkan
// result.confirmation_required — frontend TIDAK cancel terus, tapi papar
// alert "Proceed with Overwrite / Abort". Overwrite = panggil semula API
// dengan force=1 (skip validate_cabin_capacity SAHAJA — validasi link /
// mandatory kekal). Abort = papar hasil fasa 1; langkah selamat yang lain
// (snapshot, contact, address, invois, dsb) tetap berjalan.

frappe.ui.form.on("Booking", {
	refresh(frm) {
		frm.add_custom_button(__("Resync & Regenerate"), () => {
			frappe.confirm(
				__(
					"Resync & regenerate all data linked to this booking?<br><br>\
					<b>Safe & idempotent</b> — existing submitted documents (Sales Order, \
					Payment Entry) are <b>never</b> recreated. This will:<br>\
					&#8226; Recompute booking snapshots (payment status, totals, pax) from all linked Sales Orders<br>\
					&#8226; Repair Contact &#8596; Customer link & Customer billing address<br>\
					&#8226; Recreate <b>missing</b> Booking Reservations & share traveller slots (if paid)<br>\
					&#8226; Generate <b>missing</b> Sales Invoices for fully paid Sales Orders<br>\
					&#8226; Refresh Booking Addon status, Trip Group Date pax count, cabin availability & flight seats<br><br>\
					If validation issues block reservation regeneration (e.g. room capacity \
					limitation), you will be asked to <b>proceed with overwrite or abort</b>."
				),
				() => travel_booking_resync(frm)
			);
		});
	},
});

function travel_booking_resync(frm, force) {
	force = force ? 1 : 0;
	frappe.call({
		method: "travel_booking.api.booking_hub.resync_booking",
		args: { booking_name: frm.doc.name, force: force },
		freeze: true,
		freeze_message: force
			? __("Overwriting & resyncing booking data...")
			: __("Resyncing booking data..."),
	}).then((r) => {
		const res = (r.message && r.message.result) || {};

		// Fasa 1 sahaja: ada error/mismatch yang BOLEH di-overwrite — jangan
		// cancel. Tanya admin dulu: proceed dengan overwrite ATAU abort.
		// (Tutup dialog dengan X / ESC turut dikira abort — reject_action
		// frappe.confirm dipanggil bila tiada primary action.)
		if (!force && res.confirmation_required) {
			const errs = (res.confirmable_errors || [])
				.map((e) => `<li>${frappe.utils.escape_html(e)}</li>`)
				.join("");
			frappe.confirm(
				`<b>${__("Resync found issues that block reservation regeneration")}:</b>` +
					`<ul style="margin:8px 0 8px 18px;">${errs}</ul>` +
					__(
						"Reservations were <b>not</b> created for these items.<br><br>\
						Proceed with overwrite? This bypasses cabin capacity & room \
						consistency validation for this booking only — other \
						validations still apply."
					),
				() => travel_booking_resync(frm, 1),
				() => travel_booking_show_result(frm, res),
				__("Proceed with Overwrite"),
				__("Abort")
			);
			return;
		}

		travel_booking_show_result(frm, res);
	});
}

function travel_booking_show_result(frm, res) {
	const rows = [];

	const add_row = (label, value) => {
		rows.push(
			`<tr><td style="padding:4px 12px;">${label}</td>` +
			`<td style="padding:4px 12px; text-align:right;"><b>${value}</b></td></tr>`
		);
	};

	add_row(__("Sales Orders scanned"), (res.sales_orders || []).length);
	add_row(__("Payment status"), res.payment_status || "-");
	add_row(__("Contact linked"), res.contact_linked || "-");
	add_row(__("Billing address synced"), res.address_synced || "-");
	add_row(__("Reservations created"), res.reservations_created || 0);
	add_row(__("Share slots created"), res.share_slots_created || 0);
	add_row(
		__("Sales Invoices generated"),
		(res.invoices_created || []).length
			? (res.invoices_created || []).join(", ")
			: "0"
	);
	add_row(
		__("Booking Addons refreshed"),
		(res.addons_refreshed || []).length
			? (res.addons_refreshed || []).length
			: "0"
	);
	add_row(__("Reservation money snapshots filled"), res.reservations_money_filled || 0);
	add_row(__("Trip Group Date refreshed"), res.trip_group_date_refreshed || "-");
	add_row(
		__("Cruise schedules refreshed"),
		(res.cruise_schedules_refreshed || []).length
	);
	add_row(__("Flights refreshed"), (res.flights_refreshed || []).length);

	let html = `<table class="table table-bordered" style="width:100%;">${rows.join("")}</table>`;

	if (res.forced_overwrites && res.forced_overwrites.length) {
		html +=
			`<div class="text-danger" style="margin-top:10px;"><b>${__("Forced overwrites")}:</b>` +
			`<ul style="margin-top:4px;">${res.forced_overwrites
				.map((w) => `<li>${frappe.utils.escape_html(w)}</li>`)
				.join("")}</ul></div>`;
	}

	// Kes abort — error yang ditahan menunggu keputusan overwrite admin.
	if (res.confirmable_errors && res.confirmable_errors.length) {
		html +=
			`<div class="text-danger" style="margin-top:10px;"><b>${__(
				"Blocked — reservations NOT created (overwrite aborted)"
			)}:</b>` +
			`<ul style="margin-top:4px;">${res.confirmable_errors
				.map((w) => `<li>${frappe.utils.escape_html(w)}</li>`)
				.join("")}</ul></div>`;
	}

	if (res.warnings && res.warnings.length) {
		html +=
			`<div class="text-warning" style="margin-top:10px;"><b>${__("Warnings")}:</b>` +
			`<ul style="margin-top:4px;">${res.warnings
				.map((w) => `<li>${frappe.utils.escape_html(w)}</li>`)
				.join("")}</ul></div>`;
	}

	const blocked = res.confirmable_errors && res.confirmable_errors.length;
	const forced = res.forced_overwrites && res.forced_overwrites.length;
	const has_warnings = res.warnings && res.warnings.length;

	frappe.msgprint({
		title: blocked
			? __("Resync Complete — Reservations Blocked")
			: forced
				? __("Resync Complete (Forced Overwrite)")
				: __("Resync Complete"),
		indicator: blocked
			? "red"
			: forced || has_warnings
				? "orange"
				: "green",
		message: html,
	});

	frm.reload_doc();
}
