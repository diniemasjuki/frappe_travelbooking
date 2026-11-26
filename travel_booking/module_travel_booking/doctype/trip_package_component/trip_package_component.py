# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TripPackageComponent(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		component_type: DF.Literal["Activity", "Excursion", "Transfer", "Merchandise", "Miscellaneous"]
		cruise_schedule: DF.Link | None
		flight: DF.Link | None
		inclusion_mode: DF.Literal["Included", "Optional (pre-trip selection)", "Post-booking Addon"]
		item_code_override: DF.Data | None
		merchandise_item: DF.Link | None
		misc_amount: DF.Currency | None
		misc_description: DF.SmallText | None
		notes: DF.SmallText | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		per_pax: DF.Check
		qty: DF.Int
		trip_addon_package: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Package Component"

	# Pemetaan component_type → field Link yang mesti diisi.
	# NOTE: Cruise Segment & Flight BUKAN komponen pakej — ia properti
	# Trip Group Date (cruise_schedule + flight_schedule, patch v43).
	# BOM pakej merangkumi elemen komposisi sahaja (merch/activity/
	# excursion/transfer/misc).
	LINK_FIELDS = {
		"Activity":       "trip_addon_package",
		"Excursion":      "trip_addon_package",
		"Transfer":       "trip_addon_package",
		"Merchandise":    "merchandise_item",
		"Miscellaneous":  None,  # guna misc_description
	}

	def validate(self):
		self.validate_link_for_type()
		self.validate_qty()

	def validate_link_for_type(self):
		"""Setiap component_type mesti ada Link yang sepadan terisi —
		melainkan Miscellaneous yang cukup dengan description. Ini elak
		komponen kosong / salah kolom pada BOM pakej."""
		link_field = self.LINK_FIELDS.get(self.component_type)
		if link_field is None:
			if not (self.misc_description or "").strip():
				frappe.throw("Miscellaneous component requires a description.")
			return
		if not self.get(link_field):
			frappe.throw(
				"Component type '{0}' requires the '{1}' field to be set.".format(
					self.component_type, self._meta.get_label(link_field)
				)
			)

	def validate_qty(self):
		if (self.qty or 0) < 1:
			self.qty = 1

	def before_save(self):
		# Elemen fizikal (cruise/flight) TIDAK lagi komponen pakej —
		# di-derive daripada Trip Group Date terpilih (cruise_schedule +
		# flight_schedule, patch v43). BOM pakej = komposisi sahaja.
		pass
