// Copyright (c) 2026, WargaPrihatin and contributors
// For license information, please see license.txt

frappe.ui.form.on("Booking Cancellation Request", {
	refresh(frm) {
		if (frm.doc.status !== "Requested") return;

		// Keputusan permohonan — Approve menjalankan cancel penuh
		// (status Booking → Cancelled + cascade SO/reservation/voucher),
		// Reject menutup permohonan dengan emel sebab kepada customer.
		frm.add_custom_button(__("Approve & Cancel Booking"), () => {
			frappe.prompt(
				{
					fieldname: "decision_reason",
					fieldtype: "Small Text",
					label: __("Decision Notes (optional)"),
				},
				(values) => {
					frappe.call({
						method:
							"travel_booking.api.portal_cancellation.decide_cancellation_request",
						args: {
							request: frm.doc.name,
							decision: "Approved",
							decision_reason: values.decision_reason || "",
						},
						freeze: true,
						freeze_message: __("Cancelling booking..."),
					}).then(() => {
						frappe.show_alert({
							message: __("Booking cancelled."),
							indicator: "green",
						});
						frm.reload_doc();
					});
				},
				__("Approve Cancellation"),
			);
		}).addClass("btn-danger");

		frm.add_custom_button(__("Reject Request"), () => {
			frappe.prompt(
				{
					fieldname: "decision_reason",
					fieldtype: "Small Text",
					label: __("Rejection Reason (sent to customer)"),
					reqd: 1,
				},
				(values) => {
					frappe.call({
						method:
							"travel_booking.api.portal_cancellation.decide_cancellation_request",
						args: {
							request: frm.doc.name,
							decision: "Rejected",
							decision_reason: values.decision_reason,
						},
					}).then(() => {
						frappe.show_alert({
							message: __("Request rejected."),
							indicator: "orange",
						});
						frm.reload_doc();
					});
				},
				__("Reject Cancellation"),
			);
		});
	},
});
