# travel_booking/www/booking_terms.py
#
# Page awam /booking-terms — papar dokumen "Terms and Conditions" yang
# DIPILIH untuk site ni (Travel Website → section "Booking Terms &
# Conditions" dalam tab Cruise/Tour Homepage — medan per-vertikal
# cruise_booking_terms / tour_booking_terms).
#
# Fungsi utama page ni sebagai SALURAN PENGHANTARAN T&C kepada pelanggan:
# wizard /booknow memang render kandungan T&C secara inline semasa checkout,
# tapi emel pengesahan booking perlukan PAUTAN STABIL yang boleh dibuka
# bila-bila masa (rujuk _terms_delivery_block() dalam api/email_service.py).
# Halaman ni boleh diakses Guest (tiada login) — customer yang terima emel
# boleh baca semula T&C yang mengikat booking mereka.

import frappe

from travel_booking.api.terms import get_active_terms_record


def get_context(context):
	# Kandungan bergantung pada pilihan Travel Website — jangan biarkan
	# cache lama menyembunyikan pertukaran dokumen T&C.
	context.no_cache = 1

	row = get_active_terms_record()
	context.booking_terms = row
	if row:
		context.terms_updated_on = frappe.utils.format_datetime(
			frappe.db.get_value("Terms and Conditions", row.name, "modified")
		)
	else:
		context.terms_updated_on = ""
	return context
