# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document


class TripOrganizer(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		is_a_cruise_line: DF.Check
		org_logo: DF.AttachImage | None
		org_name: DF.Data | None
		org_series: DF.Data
		website: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Trip Organizer"

	def validate(self):

		self.org_series = (self.org_series).upper().strip()
		self.name = (self.name).upper().strip()
		

	def before_save(self):
		self.validate()

	def before_submit(self):
		self.validate()
	
	def before_insert(self):
		self.validate()