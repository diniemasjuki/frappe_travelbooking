# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class RoomCategory(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		capacity: DF.Int
		category_name: DF.Data
		description: DF.TextEditor | None
		room_type: DF.Literal["Cabin", "Hotel", "Room", "Dormitory"]
	# end: auto-generated types

	_DOCTYPE_NAME = "Room Category"
