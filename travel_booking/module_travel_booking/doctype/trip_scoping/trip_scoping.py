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

		group_date: DF.Link | None
		group_date_name: DF.Data | None
		name: DF.Int | None
		package_title: DF.Data | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		trip: DF.Link | None
		trip_name: DF.Data | None
		trip_package: DF.Link | None
	# end: auto-generated types

	def validate(self):
		# At least one scoping field must be filled
		if not self.trip and not self.group_date and not self.trip_package:
			frappe.throw("Please select at least one: Trip, Group Date, or Package")

	def before_save(self):
		# Auto-fetch names if linked fields are set
		if self.trip and not self.trip_name:
			self.trip_name = frappe.db.get_value("Trip", self.trip, "trip_name")
		
		if self.group_date and not self.group_date_name:
			self.group_date_name = frappe.db.get_value("Trip Group Date", self.group_date, "trip_group_name")
		
		if self.trip_package and not self.package_title:
			self.package_title = frappe.db.get_value("Trip Package", self.trip_package, "package_title")
