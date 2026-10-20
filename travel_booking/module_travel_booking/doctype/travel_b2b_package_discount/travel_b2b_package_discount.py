# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelB2BPackageDiscount(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		discount_percent: DF.Percent
		trip_package: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel B2B Package Discount"

	def validate(self):
		# Satu pakej satu baris sahaja — duplikasi menjadikan resolusi
		# diskaun pakej ambigu di booking_engine.
		dup = frappe.db.exists(
			"Travel B2B Package Discount",
			{"parent": self.parent, "parenttype": "Travel B2B Partner",
			 "trip_package": self.trip_package, "name": ["!=", self.name]},
		)
		if dup:
			frappe.throw(
				"Trip Package '{0}' already has a discount row for this partner.".format(self.trip_package)
			)
