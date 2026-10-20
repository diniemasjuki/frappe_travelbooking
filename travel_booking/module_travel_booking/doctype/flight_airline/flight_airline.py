# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
import re
from frappe.model.document import Document


class FlightAirline(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		airline_code: DF.Data
		airline_country_origin: DF.Link | None
		airline_name: DF.Data
		enabled: DF.Check
	# end: auto-generated types

	_DOCTYPE_NAME = "Flight Airline"

	def validate(self):
		
		# self.airline_name = (self.airline_name).title().strip()

		self.airline_code = (re.sub(r'[^a-zA-Z0-9]', '', self.airline_code)).upper().replace(" ","")

	def before_save(self):
		self.validate()

	def before_submit(self):
		self.validate()
	
	def before_insert(self):
		self.validate()