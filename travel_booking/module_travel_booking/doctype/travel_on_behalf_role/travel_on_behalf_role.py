# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelOnBehalfRole(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		access_level: DF.Literal["View", "Docs", "Full"]
		booking_channel: DF.Literal["Affiliate", "Staff"]
		role: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel On Behalf Role"

	def validate(self):
		# Satu role sahaja satu baris — duplicate baris menyebabkan channel
		# pertangan (map role→channel jadi ambigu). Guard murah di sini
		# supaya resolver tak perlu tangani kes duplikasi.
		dup = frappe.db.exists(
			"Travel On Behalf Role",
			{"parent": self.parent, "parenttype": "Travel Settings",
			 "role": self.role, "name": ["!=", self.name]},
		)
		if dup:
			frappe.throw(
				"Role '{0}' is already configured in the on-behalf roles list.".format(self.role)
			)

	pass
