# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Trip Category — master kategori perjalanan (cth. Cruise, Fly Package,
Ground Only) untuk pengelasan Travel Date. Master ringkas: nama kategori
(nama dokumen) + penerangan + tanda dedikasi cruise (is_cruise_trip —
[Nov 2026] dropdown kategori Travel Manager menapis ikut jenis trip:
kategori bertanda hanya untuk trip cruise, tidak bertanda untuk trip
darat). Dipaparkan sebagai column di datatable Travel Dates (Travel
Manager) & dipilih semasa cipta/edit tarikh."""

import frappe
from frappe.model.document import Document


class TripCategory(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		category_name: DF.Data
		description: DF.SmallText | None
		is_cruise_trip: DF.Check
	# end: auto-generated types

	pass
