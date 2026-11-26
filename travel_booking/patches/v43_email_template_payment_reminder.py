import frappe


def execute():
	"""Fasa A (G4): seed Email Template "Final Payment Reminder" untuk site
	sedia ada (site BAHARU dapatnya terus dari install.py — entri sama).

	Template dihantar oleh scheduler booking_engine.
	send_payment_schedule_reminders() pada T-30/T-7/T-1 sebelum due date
	baris 'Balance Payment' SO. Idempoten: skip jika template dengan nama
	tersebut sudah wujud (termasuk varian yang admin sudah edit)."""
	from travel_booking.install import _TPL_PAYMENT_REMINDER

	if frappe.db.exists("Email Template", "Final Payment Reminder"):
		return
	frappe.get_doc({
		"doctype":       "Email Template",
		"name":          "Final Payment Reminder",
		"subject":       "Payment Due {{ due_date }} — {{ booking_number }}",
		"use_html":      1,
		"response_html": _TPL_PAYMENT_REMINDER,
	}).insert(ignore_permissions=True)
	frappe.db.commit()
