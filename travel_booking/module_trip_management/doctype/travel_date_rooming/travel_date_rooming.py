# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Travel Date Rooming — child table Travel Date (model SLICE berlapis).

Satu sailing (kapal bertolak) BOLEH dijual oleh beberapa Travel Date/group.
Lapisan kapasiti:
  1. SLICE group (baris ini) — kuota group date ini sahaja.
  2. POOL sailing (Sailing Inventory) — blok kontrak kapal; penghad keras
     merentas SEMUA group pada sailing sama.
Gate booking (offer_factory) menguatkuasa KEDUA-DUANYA."""

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint


class TravelDateRooming(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		allotment: DF.Int
		available: DF.Int
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		room_category: DF.Link
		sold: DF.Int
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Date Rooming"

	def validate(self):
		if not self.room_category:
			frappe.throw(_("Room Category is required."))
		# Satu kategori sekali sahaja per Travel Date.
		if self.parent and self.parenttype == "Travel Date":
			for row in frappe.get_all("Travel Date Rooming", filters={
				"parent": self.parent, "parenttype": "Travel Date",
				"room_category": self.room_category,
				"name": ["!=", self.name],
			}, limit=1):
				frappe.throw(_(
					"Category {0} is already on this travel date.").format(
						self.room_category))
		self.sold = cint(self.sold)
		if cint(self.allotment) < self.sold:
			frappe.throw(_(
				"Group quota ({0}) cannot be less than sold ({1}) for {2}.").format(
					self.allotment, self.sold, self.room_category))
		self.available = cint(self.allotment) - self.sold
