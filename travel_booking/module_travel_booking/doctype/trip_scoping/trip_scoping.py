# Copyright (c) 2026, Rarecation
# For license information, see license.txt

# License: GNU General Public License v3. See license.txt

import frappe

from frappe.model.document import Document


class TripScoping(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		name: DF.Int | None
		offer_name: DF.Data | None
		package_offer: DF.Link | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		travel_date: DF.Link | None
		travel_date_name: DF.Data | None
		trip: DF.Link | None
		trip_name: DF.Data | None
	# end: auto-generated types

	def validate(self):
		# At least one scoping field must be filled
		if not self.trip and not self.travel_date and not self.package_offer:
			frappe.throw("Please select at least one: Trip, Travel Date, or Package Offer")

	def before_save(self):
		# Auto-fetch names if linked fields are set
		if self.trip and not self.trip_name:
			self.trip_name = frappe.db.get_value("Trip", self.trip, "trip_name")

		if self.travel_date and not self.travel_date_name:
			self.travel_date_name = frappe.db.get_value("Travel Date", self.travel_date, "travel_date_name")

		if self.package_offer and not self.offer_name:
			self.offer_name = frappe.db.get_value("Package Offer", self.package_offer, "offer_name")
