"""DIHENTIKAN — reka bentuk junction Share Slot Reservation dibuang balik
(rujuk patch v34_remove_share_slot_reservation): idempotensi aktivasi slot
traveller tambahan kembali ke stamp Booking Reservation.sales_order (reka
bentuk v15). Patch ni no-op — entri dalam patches.txt dikekalkan sebagai
rekod sejarah; site yang dah execute tidak terjejas, site yang belum
execute tidak perlu jalan apa-apa lagi.
"""

import frappe


def execute():
	return
