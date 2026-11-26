# Copyright (c) 2026, WargaPrihatan and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class FlightScheduleFlight(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		flight: DF.Link
		name: DF.Int | None
		note: DF.Data | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		role: DF.Literal["Outbound", "Return"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Schedule Flight"
