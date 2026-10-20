// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

// Medan alamat tetamu (section Address) — dipasangkan dengan medan
// snapshot alamat billing pada Booking (cust_*).
const ADDRESS_FIELD_MAP = {
	guest_address_line1: "cust_address_line1",
	guest_city:          "cust_city",
	guest_postcode:      "cust_postcode",
	guest_state:         "cust_state",
	guest_country:       "cust_country",
};

function _copy_address_from_booking(frm) {
	if (!frm.doc.booking) return;
	// Supaya handler medan alamat di bawah TIDAK melontar source ke
	// "Custom" semasa nilai di-set secara programmatic (copy).
	frm._copying_address = true;
	frappe.db
		.get_value("Booking", frm.doc.booking, Object.values(ADDRESS_FIELD_MAP))
		.then((r) => {
			const b = r.message || {};
			let has_any = false;
			const sets = [];
			Object.entries(ADDRESS_FIELD_MAP).forEach(([res_field, booking_field]) => {
				const val = b[booking_field] || "";
				if ((val || "").trim()) has_any = true;
				sets.push(frm.set_value(res_field, val));
			});
			sets.push(frm.set_value("address_source", has_any ? "From Booking" : ""));
			return Promise.all(sets);
		})
		.finally(() => {
			frm._copying_address = false;
		});
}

frappe.ui.form.on("Booking Reservation", {
	refresh(frm) {
		// (a) Guest passport link (admin trigger) — corak "share me": jana link
		// utk co-traveller (guest, no login) dan kongsi (WhatsApp / salin).
		// Email opsional sebagai fallback hantar. Slot Verified (locked) tak boleh.
		if (frm.doc.__islocal) return;
		if (frm.doc.document_status === "Verified") return;

		frm.add_custom_button(__("Share Guest Passport Link"), function () {
			const d = new frappe.ui.Dialog({
				title: __("Share Guest Passport Link"),
				fields: [
					{
						fieldname: "link", fieldtype: "Data",
						label: __("Secure Link"), read_only: 1,
						description: __(
							"Click the field to select, then copy. Share it with your " +
							"co-traveller via WhatsApp — they can fill in their passport, " +
							"contact & health details without logging in."
						),
					},
					{ fieldname: "wa_html", fieldtype: "HTML" },
					{
						fieldname: "email", fieldtype: "Data", options: "Email",
						label: __("Also email to (optional)"),
						default: frm.doc.passport_link_email || "",
						description: __(
							"Leave empty to share the link yourself. Fill in to also email it."
						),
					},
				],
				primary_action_label: __("Generate Link"),
				primary_action(values) {
					frappe.call({
						method: "travel_booking.api.portal_traveller.request_guest_passport_link",
						args: { slot_name: frm.doc.name, email: values.email || "" },
						freeze: true,
						callback: (r) => {
							if (!r || !r.message) return;
							const msg = r.message;
							const link = msg.link || "";
							const exp = (msg.expires_on || "").slice(0, 10);
							d.set_value("link", link);

							const wa = "https://wa.me/?text=" + encodeURIComponent(
								"Please fill in your passport and travel details for our trip:\n" + link
							);
							$(d.fields_dict.wa_html.wrapper).html(
								'<a href="' + frappe.utils.escape_html(wa) + '" target="_blank" rel="noopener" ' +
								'class="btn btn-primary btn-sm" style="text-decoration:none;">' +
								__("Open WhatsApp") + "</a>" +
								'<div class="text-muted text-small" style="margin-top:6px;">' +
									(msg.status === "sent"
										? __("Link emailed to {0}.", [msg.masked_email]) + " "
										: "") +
									(exp ? __("Valid until {0}.", [exp]) : "") +
								"</div>"
							);
							d.set_primary_action_label(__("Regenerate Link"));
							frm.refresh();
						},
					});
				},
			});
			d.show();
		}).addClass("btn-primary");

		// (b) Address: import/copy alamat billing dari Booking induk —
		// pilihan admin; atau isi berasingan (field bebas, source jadi
		// "Custom" secara automatik bila ditaip manual).
		if (frm.doc.booking) {
			frm.add_custom_button(__("Copy Address from Booking"), function () {
				_copy_address_from_booking(frm);
			});
		}
	},

	// Pilih Booking pada reservation baru → auto-copy alamat (HANYA bila
	// semua medan alamat masih kosong — tak tutup nilai yang admin dah isi).
	booking(frm) {
		if (!frm.doc.booking) return;
		const empty = Object.keys(ADDRESS_FIELD_MAP)
			.every((f) => !(frm.doc[f] || "").trim());
		if (empty) _copy_address_from_booking(frm);
	},

	// Edit manual mana-mana medan alamat → source "Custom" (kecuali semasa
	// nilai sedang di-set oleh copy/autofill).
	guest_address_line1(frm) { if (!frm._copying_address) frm.set_value("address_source", "Custom"); },
	guest_city(frm)          { if (!frm._copying_address) frm.set_value("address_source", "Custom"); },
	guest_postcode(frm)      { if (!frm._copying_address) frm.set_value("address_source", "Custom"); },
	guest_state(frm)         { if (!frm._copying_address) frm.set_value("address_source", "Custom"); },
	guest_country(frm)       { if (!frm._copying_address) frm.set_value("address_source", "Custom"); },
});
