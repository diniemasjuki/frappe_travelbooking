# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class TravelB2BPartnerUser(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		access_level: DF.Literal["View", "Docs", "Full"]
		user: DF.Link
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel B2B Partner User"

	def validate(self):
		# Satu user satu baris per partner — pendua menjadikan resolusi
		# access level ambigu (walaupun resolver ambil tahap tertinggi,
		# baris pendua hanyalah bising konfigurasi).
		dup = frappe.db.exists(
			"Travel B2B Partner User",
			{"parent": self.parent, "parenttype": "Travel B2B Partner",
			 "user": self.user, "name": ["!=", self.name]},
		)
		if dup:
			frappe.throw(
				"User '{0}' is already added to this partner.".format(self.user)
			)
