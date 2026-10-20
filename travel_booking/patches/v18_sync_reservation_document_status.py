"""Selaraskan document_status Booking Reservation dengan Traveller.status.

document_status kembali kepada field Select tersimpan yang BOLEH diedit
terus dari form reservation (bukan virtual/fetch_from), dengan
penyegerakan dua hala dalam controller — rujuk
BookingReservation.sync_document_status dan
Traveller.sync_status_to_reservations.

Data sedia ada diselaraskan di sini: Traveller ialah sumber kebenaran,
jadi hanya rekod reservation yang BERPASANGAN traveller ditarik semula
nilainya. Reservation tanpa traveller (tiada sumber untuk
diselaraskan) dibiarkan seperti sedia ada.

Idempoten — selamat dijalankan berulang.
"""

import frappe


def execute():
    frappe.db.sql(
        """
        UPDATE `tabBooking Reservation` r
        JOIN `tabTraveller` t ON t.name = r.traveller
        SET r.document_status = t.status
        WHERE COALESCE(r.document_status, '') <> COALESCE(t.status, '')
        """
    )
