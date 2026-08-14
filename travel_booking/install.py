# travel_booking/install.py
#
# before_install — Frappe panggil ni SEBELUM travel_booking dipasang ke site.
# after_install  — Frappe panggil ni SELEPAS travel_booking dipasang.
#
# Kedua-duanya idempotent (selamat dipanggil berulang — cth semama `bench
# --site xxx migrate` selepas upgrade Frappe/ERPNext). Setiap langkah
# semak kewujudan rekod dulu sebelum cipta, jadi tak akan duplikat.
#
# PENTING: TIDAK ubah/migrate mana-mana DocType JSON di sini — install hook
# cuma cipta DATA lalai (rekod-rekod individual) yang app bergantung untuk
# berfungsi penuh, BUKAN perubahan schema.

import frappe


def before_install():
	"""Sahkan ERPNext sedia ada sebelum travel_booking dipasang.

	travel_booking bergantung penuh kepada ERPNext — Customer, Sales Order,
	Payment Entry, Sales Invoice, Item, Currency Exchange, Price List, dsb.

	GUNA frappe.get_installed_apps() — BUKAN frappe.db.exists("Installed
	Application", ...) — sebab query DB terus ke Installed Application
	boleh pulangkan False palsu semasa konteks install (timing/naming
	berbeza merentasi versi Frappe), walhal ERPNext memang dah dipasang.
	frappe.get_installed_apps() baca dari cache/session yang dah stabil.

	NOTA: required_apps = ["erpnext"] dalam hooks.py dah enforce check ni
	di peringkat framework Frappe. before_install ni cuma fallback tambahan
	untuk mesej yang lebih jelas kalau somehow check framework lepas.
	"""
	if "erpnext" not in frappe.get_installed_apps():
		frappe.throw(
			"ERPNext must be installed before installing Travel Booking. "
			"Please run: bench --site <site> install-app erpnext"
		)


def after_install():
	"""Cipta rekod-rekod lalai yang travel_booking bergantung untuk berfungsi.

	Semua langkah idempotent — selamat dipanggil berulang (migrate/upgrade)
	tanpa cipta duplikat. Tidak sentuh schema DocType langsung.
	"""
	_create_traveller_role()
	_create_travel_item()
	_create_default_travel_settings()
	_create_email_templates()
	_create_print_format()


# ══════════════════════════════════════════════
# 1. ROLE — "Traveller"
# ══════════════════════════════════════════════

def _create_traveller_role():
	"""Role untuk pengguna portal (Website User) yang buat booking.
	Role ni di-assign kepada setiap User yang dicipta oleh
	_ensure_portal_user() dalam booking_engine.py.
	"""
	if frappe.db.exists("Role", "Traveller"):
		return

	role = frappe.get_doc({
		"doctype":           "Role",
		"role_name":         "Traveller",
		"home_page":         "/traveller_portal",
		"desk_access":       0,  # portal-only — tiada akses Desk
		"disabled":          0,
	})
	role.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 2. ITEM — "TRAVEL-PKG"
# ══════════════════════════════════════════════

def _create_travel_item():
	"""Item service "TRAVEL-PKG" yang guna untuk SEMUA baris Sales Order
	booking (pax dari semua jenis — Main Guest/Extra Bed/Infant/Voucher/
	Referral — kongsi item yang sama, rate berbeza per baris).

	Ini sama dengan _get_or_create_travel_item() di so_helpers.py — cipta di
	sini sekali gus semasa install supaya SO pertama tak perlu cipta on-the-
	fly (lebih bersih untuk audit awal).
	"""
	from travel_booking.api.constants import TRAVEL_ITEM_CODE

	if frappe.db.exists("Item", TRAVEL_ITEM_CODE):
		return

	frappe.get_doc({
		"doctype":                       "Item",
		"item_code":                     TRAVEL_ITEM_CODE,
		"item_name":                     "Travel Package",
		"item_group":                    "Services",
		"stock_uom":                     "Nos",
		"is_stock_item":                 0,
		"is_sales_item":                 1,
		"include_item_in_manufacturing": 0,
	}).insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 3. TRAVEL SETTINGS — lalai
# ══════════════════════════════════════════════

def _create_default_travel_settings():
	"""Travel Settings adalah Single doctype (satu rekod sahaja). Cipta
	rekod kosong lalai supaya admin boleh terus buka & konfigurasi di
	Desk tanpa crash (beberapa field dibaca oleh app guna getattr()
	dengan fallback, jadi rekod kosong masih selamat).
	"""
	if frappe.db.exists("Travel Settings", "Travel Settings"):
		return

	settings = frappe.get_doc({
		"doctype":                   "Travel Settings",
		# Lalai-lalai yang paling selamat/umum:
		"default_deposit_percent":   20,
		"otp_expiry_minutes":        10,
		"email_verified_session_minutes": 30,
	})
	settings.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 4. EMAIL TEMPLATES — lalai (boleh edit di Desk)
# ══════════════════════════════════════════════

def _create_email_templates():
	"""Template lalai untuk semua e-mel yang app hantar. Semua nama
	telegram dipanggil terus dalam email_service.py — kalau nama template
	berubah di sini, kemas kini pemetaan di _send_status_email() juga.

	Template ni cuma lalai — admin boleh (dan patut) edit/replace di Desk
	(Settings > Email Template) dengan HTML/branding sebenar Rarecruise.
	"""
	templates = [
		{
			"name":    "Set Your Password",
			"subject": "Set Your Password — Rarecruise",
			"use_html": 1,
			"response_html": _TPL_SET_PASSWORD,
		},
		{
			"name":    "Booking Pending",
			"subject": "Booking Pending — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_PENDING,
		},
		{
			"name":    "Booking Accepted",
			"subject": "Booking Confirmed — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_ACCEPTED,
		},
		{
			"name":    "Booking Processing",
			"subject": "Booking Update — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_PROCESSING,
		},
		{
			"name":    "Booking Confirmed",
			"subject": "Trip Confirmed — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_CONFIRMED,
		},
		{
			"name":    "Booking Completed",
			"subject": "Thank You for Travelling — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_COMPLETED,
		},
		{
			"name":    "Payment Receipt",
			"subject": "Payment Receipt — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_RECEIPT,
		},
	]

	for tpl in templates:
		if frappe.db.exists("Email Template", tpl["name"]):
			continue
		doc = frappe.get_doc({
			"doctype":    "Email Template",
			"name":       tpl["name"],
			"subject":    tpl["subject"],
			"use_html":   tpl.get("use_html", 1),
			"response_html": tpl["response_html"],
		})
		doc.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 5. PRINT FORMAT — "Rarecation Receipt"
# ══════════════════════════════════════════════

def _create_print_format():
	"""Print Format untuk PDF resit — dipanggil oleh _receipt_pdf() di
	email_service.py dan get_document_pdf() di portal_payment.py.

	Cipta sebagai Custom Print Format (html-based) supaya admin boleh
	edit langsung di Desk (Print Format > Rarecation Receipt).
	"""
	from travel_booking.api.constants import PRINT_FORMAT_RECEIPT

	if frappe.db.exists("Print Format", PRINT_FORMAT_RECEIPT):
		return

	frappe.get_doc({
		"doctype":         "Print Format",
		"name":            PRINT_FORMAT_RECEIPT,
		"doc_type":        "Payment Entry",
		"print_format_type": "Jinja",
		"html": _PF_RECEIPT_HTML,
	}).insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# TEMPLATE HTML CONSTANTS (lalai ringkas — ganti dengan branding sebenar)
# ══════════════════════════════════════════════

# Setiap template guna Jinja variable yang disediakan oleh
# _send_status_email() / _send_set_password_email() di email_service.py.
# Rujuk context dict di situ untuk senarai variable yang tersedia.

_TPL_SET_PASSWORD = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Set Your Password</h2>
  <p>Hi {{ first_name }},</p>
  <p>Welcome to Rarecruise! Your portal account is ready. Please set your password to access your bookings and traveller details.</p>
  <p style="margin: 24px 0;">
    <a href="{{ set_password_url }}" style="display: inline-block; padding: 12px 32px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">Set Your Password</a>
  </p>
  <p style="color: #666; font-size: 12px;">If you did not create a booking, please ignore this email.</p>
</div>
"""

_TPL_PENDING = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Pending — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>We've received your booking for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>.</p>
  <p>Your booking is currently pending payment. You can complete your payment at any time through the portal.</p>
  <p><strong>Total:</strong> {{ total_fmt }}</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_ACCEPTED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Confirmed — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Great news! We've received your payment for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>.</p>
  <p><strong>Amount Paid:</strong> {{ amount_paid_fmt }}<br><strong>Payment Status:</strong> {{ payment_status }}</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_PROCESSING = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Update — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Your booking for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong> is now being processed. Our team is arranging your flights and cabin assignments.</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_CONFIRMED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Trip Confirmed — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Your trip <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong> has been fully confirmed! Flight and cabin details are finalized.</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_COMPLETED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Thank You for Travelling — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>We hope you enjoyed your trip <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>!</p>
  <p>Thank you for choosing Rarecruise. We look forward to seeing you on your next adventure.</p>
</div>
"""

_TPL_RECEIPT = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Payment Receipt</h2>
  <p>Hi {{ first_name }},</p>
  <p>We've received your payment of <strong>{{ amount_fmt }}</strong> for booking <strong>{{ booking_number }}</strong>.</p>
  <p>A detailed PDF receipt is attached to this email for your records.</p>
</div>
"""

_PF_RECEIPT_HTML = """\
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #B8860B; text-align: center;">Rarecruise — Payment Receipt</h2>
  <hr>
  <p><strong>Receipt No:</strong> {{ doc.name }}</p>
  <p><strong>Date:</strong> {{ frappe.format_date(doc.posting_date) }}</p>
  <p><strong>Customer:</strong> {{ doc.party }}</p>
  <hr>
  <h3>Payment Details</h3>
  <p><strong>Amount:</strong> {{ frappe.format_value(doc.paid_amount, currency=doc.paid_to_account_currency) }}</p>
  <p><strong>Mode of Payment:</strong> {{ doc.mode_of_payment or 'N/A' }}</p>
  <p><strong>Reference No:</strong> {{ doc.reference_no or 'N/A' }}</p>
  <hr>
  <p style="color: #999; font-size: 12px; text-align: center;">This is a computer-generated receipt.</p>
</div>
"""
