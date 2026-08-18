// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

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
	},
});
