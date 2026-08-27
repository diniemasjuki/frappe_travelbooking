# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

# import frappe
from frappe.model.document import Document
#
from frappe.utils import getdate, today


class Traveller(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		age: DF.Int
		age_category: DF.Literal["Adult", "Child", "Infant"]
		date_of_birth: DF.Date | None
		dietary_requirements: DF.Text | None
		document_verified: DF.Check
		email: DF.Data | None
		emergency_contact_name: DF.Data | None
		emergency_contact_phone: DF.Phone | None
		emergency_contact_relationship: DF.Data | None
		first_name: DF.Data
		full_name: DF.Data | None
		fullname_format: DF.Literal["First Name + Last Name", "Last Name + First Name"]
		gender: DF.Literal["Male", "Female"]
		ic_number: DF.Data
		ic_number_view: DF.Data | None
		last_name: DF.Data
		medical_conditions: DF.Text | None
		medicine_treatment: DF.Text | None
		nationality: DF.Link | None
		passport_expiry: DF.Date | None
		passport_image: DF.AttachImage | None
		passport_no: DF.Data | None
		phone: DF.Phone | None
		status: DF.Literal["Pending", "Verified", "Open for Update", "Rejected"]
		title: DF.Literal["Mr", "Mrs"]
		visa_photo: DF.Attach | None
		wheelchair_assistant: DF.Literal["", "Not Required", "Long Walk Only", "All Time"]
		# end: auto-generated types
	
		_DOCTYPE_NAME = "Traveller"
 


	def before_save(self):
		self.set_uppercase()
		self.set_full_name()
		self.set_age_from_dob()
		self.set_age_category()
		self.set_title_and_gender_from_name()
  
	def set_icnumber(self):
		self.ic_number = self.ic_number.replace(" ","").replace("-","")
  	

	def set_uppercase(self):
		text_fields = [
			"first_name", "last_name", "full_name",
			"ic_number", "passport_no",
			"emergency_contact_name", "emergency_contact_relationship",
		]
		for field in text_fields:
			val = getattr(self, field, None)
			if val:
				setattr(self, field, val.upper())

	def set_full_name(self):
		first = (self.first_name or "").strip()
		last  = (self.last_name or "").strip()
		if self.fullname_format == "Last Name + First Name":
			combined = " ".join(filter(None, [last, first]))
		else:
			# Default: "First Name + Last Name" — juga fallback kalau
			# fullname_format belum dipilih/kosong.
			combined = " ".join(filter(None, [first, last]))
		if combined:
			self.full_name = combined

	def set_age_from_dob(self):
		if not self.date_of_birth:
			return
		try:
			dob = getdate(self.date_of_birth)
			today_dt = getdate(today())
			age = today_dt.year - dob.year
			if (today_dt.month, today_dt.day) < (dob.month, dob.day):
				age -= 1
			self.age = age if age >= 0 else 0
		except Exception:
			self.age = 0

	def set_age_category(self):
		if self.age is None:
			return
		age = int(self.age)
		if age <= 1:
			self.age_category = "Infant"
		elif age <= 11:
			self.age_category = "Child"
		else:
			self.age_category = "Adult"

	def set_title_and_gender_from_name(self):
		name = (self.full_name or self.last_name or "").lower()
		if " binti " in name or name.startswith("binti "):
			if not self.title:  self.title = "Mrs"
			if not self.gender: self.gender = "Female"
		elif " bin " in name or name.startswith("bin "):
			if not self.title:  self.title = "Mr"
			if not self.gender: self.gender = "Male"