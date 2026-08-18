# travel_booking/api/constants.py
#
# Sumber tunggal (single source of truth) untuk pemalar dan nilai boleh
# konfigurasi yang dikongsi merentasi modul-modul api/*.py.
#
# Sebelum ni, MAX_CABINS_PER_BOOKING (8) diduplikasi di TIGA tempat:
# booking.py, booking_reservation.py, dan booking.js — setiap kali nilai
# perlu berubah, tiga fail perlu dikemas kini secara manual. PRINT_FORMAT_RECEIPT
# pula diduplikasi di booking.py dan portal_payment.py. Modul ni menyatukan
# kedua-duanya di satu tempat sahaja.

import frappe


# ── Pemalar tetap (hardcoded) ──────────────────────────────────────

# Had maksimum cabin per booking — MESTI disegerakkan dengan
# MAX_CABINS_PER_BOOKING dalam booking.js (frontend) dan
# validate_cabin_capacity() dalam booking_reservation.py (admin manual
# di Desk), supaya konsisten merentasi ketiga-tiga laluan.
MAX_CABINS_PER_BOOKING = 8

# Nama Print Format untuk resit — dikongsi oleh email_service.py
# (_receipt_pdf) dan portal_payment.py (get_document_pdf).
PRINT_FORMAT_RECEIPT = "Rarecation Receipt"

# Nama Print Format untuk proforma (Sales Order) — dipaparkan sebagai
# "PROFORMA INVOICE — NOT A TAX INVOICE" untuk customer download dari
# page Billing portal sebelum Sales Invoice rasmi wujud.
PRINT_FORMAT_PROFORMA = "Rarecation Proforma Invoice"

# Item code untuk baris-baris Sales Order (pax dari semua jenis guna
# item yang sama, kadar berbeza per baris).
TRAVEL_ITEM_CODE = "TRAVEL-PKG"

# Item code berasingan untuk SO addon (excursion/extras) dan SO insurance —
# supaya laporan jualan admin (Item Group report ERPNext) boleh split ikut
# jenis, bukan bercampur dengan TRAVEL_ITEM_CODE (cabin booking). Rujuk
# api/addon_manager.py checkout_addons().
ADDON_ITEM_CODE = "TRAVEL-ADDON"
INSURANCE_ITEM_CODE = "TRAVEL-INSURANCE"

# Prefix nombor booking ("RC" + 6 aksara rawak, rujuk _generate_booking_number).
BOOKING_NUMBER_PREFIX = "RC"

# Currency lalai untuk paparan fallback.
DEFAULT_CURRENCY = "MYR"


# ── Pemalar boleh konfigurasi (dibaca dari Travel Settings) ─────────

def get_max_cabins():
	"""Had maksimum cabin per booking — dibaca dari Travel Settings jika
	field 'max_cabins_per_booking' wujud pada doctype itu, JATUH BALIK
	kepada MAX_CABINS_PER_BOOKING (8) jika tiada/belum dikonfigurasikan.

	PENGGUNAAN: panggil fungsi ini di tempat yang sebelum ini hardcoded
	MAX_CABINS_PER_BOOKING — backend (_validate_selection_capacity di
	pricing.py) dan doctype controller (booking_reservation.py). Frontend
	(booking.js) kekal hardcoded (8) buat masa ni sebab ia dimuat sebelum
	sebarang panggilan API; admin yang tukar nilai di Travel Settings
	perlu kemaskini booking.js sekali buat sementara.
	"""
	try:
		settings = frappe.get_cached_doc("Travel Settings")
		val = getattr(settings, "max_cabins_per_booking", None)
		if val:
			return int(val)
	except Exception:
		pass
	return MAX_CABINS_PER_BOOKING