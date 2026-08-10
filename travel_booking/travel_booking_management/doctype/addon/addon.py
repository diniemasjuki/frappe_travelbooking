# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class Addon(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		addon_organizer: DF.Link | None
		addon_title: DF.Data | None
		base_price: DF.Currency
		cover_image: DF.AttachImage | None
		currency: DF.Link | None
		description: DF.TextEditor | None
		disable: DF.Check
	# end: auto-generated types

	_DOCTYPE_NAME = "Addon"
