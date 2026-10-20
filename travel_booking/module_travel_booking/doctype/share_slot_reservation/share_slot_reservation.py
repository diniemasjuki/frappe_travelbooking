# Copyright (c) 2026, travel_booking
# Junction Sales Order ↔ Booking Reservation untuk slot traveller
# tambahan/cabin baharu — dicipta oleh _activate_share_traveller_reservation
# (api/cabin_sharing.py). Bukan dokumen pengguna; wujud untuk
# idempotensi aktivasi + jejak audit slot.
from typing import TYPE_CHECKING

from frappe.model.document import Document

if TYPE_CHECKING:
    from frappe.types import DF


class ShareSlotReservation(Document):
    if TYPE_CHECKING:
        booking: DF.Link | None
        booking_reservation: DF.Link
        sales_order: DF.Link
