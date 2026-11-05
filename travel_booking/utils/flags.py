# travel_booking/utils/flags.py
# Suis cutover F4 — dibaca oleh kod yang perlu bezakan struktur lama vs
# baharu (cth katalog wizard masa dwi-baca). get_single_value ber-cache —
# selamat dipanggil dalam loop.

import frappe


def use_package_offers() -> bool:
	"""F4 suis: 1 = struktur baharu (Travel Package / Package Offer)
	aktif untuk laluan baca (katalog). Default 0 — JANGAN hidupkan
	sebelum aliran tulis booking menggunakan struktur baharu (F5)."""
	return bool(frappe.db.get_single_value("Travel Settings", "use_package_offers"))
