// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.ui.form.on("Travel Price Rule", {
	refresh(frm) {
		toggle_discount_fields(frm);
		set_currency_filter(frm);
	},
	discount_type(frm) {
		toggle_discount_fields(frm);
	},
});

function toggle_discount_fields(frm) {
	const is_pct = frm.doc.discount_type === "Percentage";
	frm.toggle_display("discount_percent", is_pct);
	frm.toggle_display("discount_amounts", !is_pct);
	frm.toggle_reqd("discount_percent", is_pct);
}

// Currency row dalam Discount Amounts difilter kepada currency yang
// diisytiharkan dalam paksi axis (Travel Settings > Multi Currency
// Account) — selari dengan guard server-side _validate_amount_currencies.
function set_currency_filter(frm) {
	frappe
		.call({
			method: "travel_booking.api.pricing.get_display_currencies",
		})
		.then((r) => {
			const codes = (r.message || []).map((c) => c.code).filter(Boolean);
			if (!codes.length) return;
			frm.set_query("currency", "discount_amounts", () => ({
				filters: { name: ["in", codes] },
			}));
		});
}
