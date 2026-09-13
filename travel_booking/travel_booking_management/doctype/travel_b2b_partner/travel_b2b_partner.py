# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class TravelB2BPartner(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.travel_booking_management.doctype.travel_b2b_package_discount.travel_b2b_package_discount import TravelB2BPackageDiscount
		from travel_booking.travel_booking_management.doctype.travel_b2b_partner_user.travel_b2b_partner_user import TravelB2BPartnerUser

		contact_email: DF.Data | None
		customer: DF.Link
		default_discount_percent: DF.Percent
		naming_series: DF.Literal["B2BP.YY.###"]
		package_discounts: DF.Table[TravelB2BPackageDiscount]
		partner_name: DF.Data
		status: DF.Literal["Active", "Disabled"]
		users: DF.Table[TravelB2BPartnerUser]
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel B2B Partner"

	def validate(self):
		self._validate_customer_is_b2b_group()
		self._validate_user_not_shared_across_active_partners()

	def _validate_customer_is_b2b_group(self):
		"""Cadangan (bukan paksaan) — Customer bil partner patut berada dalam
		Customer Group "B2B" supaya laporan jualan ERPNext boleh asingkan
		jualan runcit vs jualan agen. Kalau group tu tak wujud langsung
		(site belum di-patch), langkau semakan — jangan sekat konfigurasi.
		"""
		if not self.customer:
			return
		if not frappe.db.exists("Customer Group", "B2B"):
			return
		group = frappe.db.get_value("Customer", self.customer, "customer_group")
		if group != "B2B":
			frappe.msgprint(
				_("Billing Customer {0} is not in Customer Group 'B2B'. "
				  "Recommended so B2B sales are separable in ERPNext reports.")
				.format(self.customer),
				indicator="orange",
			)

	def _validate_user_not_shared_across_active_partners(self):
		"""Satu user hanya milik SATU partner Active — kalau tidak, resolusi
		partner semasa booking on-behalf (resolve_booking_actor) ambigu.
		"""
		for row in (self.users or []):
			if self.status != "Active":
				continue
			other = frappe.db.sql("""
				SELECT p.name, p.partner_name
				FROM `tabTravel B2B Partner User` pu
				JOIN `tabTravel B2B Partner` p ON p.name = pu.parent
				WHERE pu.user = %s AND p.name != %s AND p.status = 'Active'
				LIMIT 1
			""", (row.user, self.name), as_dict=True)
			if other:
				frappe.throw(
					_("User {0} already belongs to active partner {1}. "
					  "A portal user may only be linked to one active B2B partner.")
					.format(row.user, other[0].partner_name)
				)
