# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import validate_email_address


class TravelInquiry(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		affiliate: DF.Link | None
		attandee: DF.Link | None
		domain: DF.Literal["", "Cruise", "Tour"]
		email: DF.Data | None
		message: DF.Text | None
		naming_series: DF.Literal["INQ.YY.MM.DD.####"]
		phone: DF.Phone
		prospect_name: DF.Data
		referral_code_used: DF.Data | None
		source_page: DF.Data | None
		status: DF.Literal["New", "Contacted", "Converted", "Closed"]
		trip: DF.Link | None
		trip_group_date: DF.Link | None
		trip_package: DF.Link | None
	# end: auto-generated types

	def validate(self):
		# Normalisasi + semakan asas — rekod dari API awam (floating chat
		# widget) dan rekod manual di Desk melalui semakan yang sama.
		self.prospect_name = (self.prospect_name or "").strip()[:140]
		self.phone = (self.phone or "").strip()
		self.email = (self.email or "").strip()
		self.source_page = (self.source_page or "").strip()[:500]

		if not self.prospect_name:
			frappe.throw(_("Please enter your name."), frappe.MandatoryError)
		if not self.phone:
			frappe.throw(_("Please enter your phone number."), frappe.MandatoryError)
		# Format nombor INTERNATIONAL (E.164, cth +60123456789) disahkan oleh
		# fieldtype Phone (validate_phone_number_with_country_code) — nombor
		# tempatan tanpa country code ditolak dengan mesej jelas.
		if self.email:
			self.email = validate_email_address(self.email, throw=True)

		if not self.status:
			self.status = "New"
		if not self.domain:
			self.domain = derive_domain(self.source_page)


def derive_domain(source_page: str) -> str:
	"""Terbitkan domain site (Cruise/Tour) daripada URL source page.

	Cruise disemak dahulu — subdomain/host cruise (cruise.rarecation.com)
		mestinya menang walaupun path mengandungi perkataan 'tour'.
		Kosong dikembalikan jika URL tidak mengandungi mana-mana penanda.
	"""
	s = (source_page or "").lower()
	if "cruise" in s:
		return "Cruise"
	if "tour" in s:
		return "Tour"
	return ""
