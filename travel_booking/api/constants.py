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

# Had maksimum cabin per booking — kini BOLEH KONFIGURASI melalui
# Travel Settings > Max Cabins Per Booking (rujuk get_max_cabins()
# di bawah; 0 = unlimited). Nilai ni hanya fallback terakhir bila
# Travel Settings gagal dimuatkan. Frontend (booknow.js) terima
# nilai sebenar melalui pageData — tiada lagi sync manual 3 tempat.
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

# Item code + name untuk SEMUA baris Sales Order addon (sama ada Per Pax
# atau Per Booking). User request: setiap SO line guna item "Trip Addon
# Package" — bukan TRAVEL-ADDON/TRAVEL-INSURAN yang lama. Item ni dicipta
# auto oleh _get_or_create_travel_item() kali pertama addon dicheckout.
ADDON_PACKAGE_ITEM_CODE = "Trip Addon Package"

# Prefix nombor booking ("RC" + 6 aksara rawak, rujuk _generate_booking_number).
BOOKING_NUMBER_PREFIX = "RC"

# Currency lalai untuk paparan fallback.
DEFAULT_CURRENCY = "MYR"

# Price List selling lalai — digunakan bila baris paksi currency
# (Travel Settings > Multi Currency Account) tidak set selling_price_list.
# Item Price dalam price list auto-seed oleh insert_item_price ERPNext pada
# SO pertama setiap currency; rate SO item sentiasa di-set eksplisit dari
# Trip Package Price / addon rate, jadi price list di sini mekanikal.
DEFAULT_SELLING_PRICE_LIST = "Standard Selling"


# ── Pemalar boleh konfigurasi (dibaca dari Travel Settings) ─────────

def get_max_cabins():
	"""Had maksimum cabin per booking — dibaca dari Travel Settings
	field 'max_cabins_per_booking' (tab App Configurations > Booking
	Automation). SEMANTIK: 0 = TANPA HAD (unlimited); nilai NULL
	(field belum ada nilai dalam tabSingles,cth selepas tambah field
	tapi Travel Settings belum pernah di-save semula) juga dikira
	unlimited supaya default baharu terus berkesan.

	Fallback terakhir MAX_CABINS_PER_BOOKING (8) hanya bila Travel
	Settings gagal dimuatkan sama sekali (cth doctype belum migrate) —
	nilai lama konservatif.

	PENGGUNAAN: panggil fungsi ini di semua titik had cabin — backend
	(_validate_selection_capacity di pricing.py, create_new_cabin_order
	di cabin_sharing.py), doctype controller (booking_reservation.py),
	dan www/booknow.py yang menyuntik nilai ke pageData untuk frontend
	(booknow.js). SEMUA caller mesti treat 0 sebagai unlimited
	(gate dengan `if max_cabins and ...`).
	"""
	try:
		settings = frappe.get_cached_doc("Travel Settings")
		val = getattr(settings, "max_cabins_per_booking", None)
		if val is None:
			return 0
		return max(int(val), 0)
	except Exception:
		pass
	return MAX_CABINS_PER_BOOKING