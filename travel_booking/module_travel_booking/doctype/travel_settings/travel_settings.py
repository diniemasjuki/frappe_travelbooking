# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class TravelSettings(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.price_category_label.price_category_label import PriceCategoryLabel
		from travel_booking.module_travel_booking.doctype.travel_currency_account.travel_currency_account import TravelCurrencyAccount
		from travel_booking.module_travel_booking.doctype.travel_email_notification.travel_email_notification import TravelEmailNotification

		account_name: DF.Data | None
		account_number: DF.Data | None
		ai_ocr_api_key: DF.Data | None
		ai_ocr_base_url: DF.Data | None
		ai_ocr_model: DF.Data | None
		bank_name: DF.Link | None
		cashback_discount_account: DF.Link | None
		currency_accounts: DF.Table[TravelCurrencyAccount]
		default_currency: DF.Link | None
		default_deposit_percent: DF.Percent
		default_referral_discount_percent: DF.Percent
		email_notifications: DF.Table[TravelEmailNotification]
		email_verified_session_minutes: DF.Int
		enable_ai_receipt_ocr: DF.Check
		manual_transfer_cashback_enabled: DF.Check
		manual_transfer_cashback_percent: DF.Percent
		manual_transfer_paid_to_account: DF.Link | None
		online_payment_min_amount: DF.Float
		otp_expiry_minutes: DF.Int
		payment_gateway: DF.Link | None
		pending_abandoned_days: DF.Int
		price_category_labels: DF.Table[PriceCategoryLabel]
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Settings"

	def validate(self):
		# currency_accounts ialah paksi multi-currency/multi-company app:
		# satu baris per currency, setiap satu menunjuk company yang
		# mengeluarkan SO/bil. Mesti unik ikut currency — dua baris currency
		# sama menjadikan resolusi company ambiguous.
		seen = set()
		for row in (self.currency_accounts or []):
			if not row.currency:
				continue
			if row.currency in seen:
				frappe.throw(
					"Currency '{0}' appears more than once in Multi Currency "
					"Account — only one row per currency is allowed.".format(row.currency),
					title="Duplicate Currency",
				)
			seen.add(row.currency)

		# Default Display Currency — bila di-set, MESTI tersenarai dalam
		# paksi currency (Multi Currency Account) supaya ia memang currency
		# yang boleh dijual/dipapar app; typo di sini mengubah jumlah
		# gabungan semua page admin. self.get() (bukan attribute access)
		# supaya site yang belum migrate field ni kekal selamat (None).
		if self.get("default_currency"):
			axis_currencies = {
				row.currency for row in (self.currency_accounts or []) if row.currency
			}
			if axis_currencies and self.get("default_currency") not in axis_currencies:
				frappe.throw(
					"Default Display Currency '{0}' is not listed in Multi "
					"Currency Account. Add it there first, or leave the "
					"field empty to use the default company currency.".format(
						self.get("default_currency")
					),
					title="Currency Not Available",
				)

		self._validate_email_notifications()

	def _validate_email_notifications(self):
		"""Tab Email Notifications: (1) kunci notifikasi mesti unik — dua
		baris same key menjadikan resolusi enabled/template ambiguous; (2)
		toggle baris "Passport Submission" diselaraskan kepada rekod
		Notification standard yang mencetuskannya (notifikasi ni frame-
		work-driven — tiada kod app melaluinya, jadi satu-satunya jalan
		kawal ialah flag `enabled` rekod Notification tersebut)."""
		seen = set()
		passport_row = None
		for row in (self.email_notifications or []):
			if not row.notification_key:
				continue
			if row.notification_key in seen:
				frappe.throw(
					"Notification '{0}' appears more than once in Email "
					"Notifications — only one row per notification is "
					"allowed.".format(row.notification_key),
					title="Duplicate Notification",
				)
			seen.add(row.notification_key)
			if row.notification_key == "passport_submission":
				passport_row = row

		if passport_row and frappe.db.exists("Notification", "Passport Submission"):
			current = frappe.db.get_value("Notification", "Passport Submission", "enabled")
			if int(bool(current)) != int(bool(passport_row.enabled)):
				frappe.db.set_value(
					"Notification", "Passport Submission",
					"enabled", 1 if passport_row.enabled else 0,
				)


# Nama-nama template lalai yang di-seed oleh install.py (KEEP IN SYNC) +
# doctype rujukan yang template app biasa guna — asas senarai "Templates"
# di tab Email Notifications. Template lain dengan reference_doctype ni
# juga tersenarai automatik.
_SEEDED_TEMPLATE_NAMES = (
	"Set Your Password",
	"Booking Pending", "Booking Accepted", "Booking Processing",
	"Booking Confirmed", "Booking Completed", "Payment Receipt",
	"Booking Pending (Traveller)", "Booking Accepted (Traveller)",
	"Booking Processing (Traveller)", "Booking Confirmed (Traveller)",
	"Booking Completed (Traveller)",
)
_APP_TEMPLATE_REFERENCE_DOCTYPES = ("Booking", "Payment Entry", "Traveller", "User")


@frappe.whitelist()
def get_app_email_templates():
	"""Senarai Email Template untuk tab Email Notifications di Travel
	Settings — union template lalai app + mana-mana template yang
	merujuk doctype app (Booking/Payment Entry/Traveller/User). Dirender
	oleh travel_settings.js sebagai senarai dengan butang Edit."""
	# Selaraskan dengan kebenaran buka Travel Settings sendiri — method ni
	# tak patut lebih terbuka daripada halaman yang memanggilnya.
	if not frappe.has_permission("Travel Settings", "read"):
		frappe.throw(_("Insufficient Permission"), frappe.PermissionError)

	return frappe.get_all(
		"Email Template",
		or_filters=[
			["Email Template", "name", "in", list(_SEEDED_TEMPLATE_NAMES)],
			["Email Template", "reference_doctype", "in", list(_APP_TEMPLATE_REFERENCE_DOCTYPES)],
		],
		fields=["name", "subject", "reference_doctype", "use_html", "modified"],
		order_by="name",
	)
