# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
import re


class FlightAirport(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		airport_city: DF.Data | None
		airport_code: DF.Data
		airport_country: DF.Link | None
		airport_name: DF.Data
		currency: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Airport"

	def validate(self):
		
		self.airport_name = (self.airport_name).upper().strip()

		self.airport_code = (re.sub(r'[^a-zA-Z0-9]', '', self.airport_code)).upper().replace(" ","")

		self.airport_city = (self.airport_city).title()

	def before_save(self):
		self.validate()

	def before_submit(self):
		self.validate()
	
	def before_insert(self):
		self.validate()