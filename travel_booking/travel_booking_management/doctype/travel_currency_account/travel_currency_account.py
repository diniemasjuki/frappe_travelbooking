# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils.data import flt


class TravelCurrencyAccount(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		bank_account: DF.Link | None
		company: DF.Link | None
		currency: DF.Link | None
		manual_transfer_paid_to_account: DF.Link | None
		parent: DF.Data
		parentfield: DF.Data
		parenttype: DF.Data
		payment_gateway_account: DF.Link | None
		selling_price_list: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Travel Currency Account"

	def validate(self):
		# Baris TCA kini paksi "currency axis" multi-company: currency ->
		# company + price list + payment accounts. Validasi ketat di sini
		# supaya misconfiguration ketara semasa admin save Travel Settings,
		# bukan pecah semasa customer confirm booking.
		if not self.currency:
			return  # baris kosong — biar Travel Settings handle

		if not self.company:
			frappe.throw(
				"Row currency '{0}': Company is required — set the company that "
				"issues Sales Orders/bills for this currency.".format(self.currency),
				title="Currency Axis Incomplete",
			)

		company_currency = frappe.get_cached_value("Company", self.company, "default_currency")
		if company_currency and company_currency != self.currency:
			frappe.throw(
				"Company '{0}' default currency is '{1}' but this row's currency is "
				"'{2}'. Each currency row must point to a company whose default "
				"currency matches.".format(self.company, company_currency, self.currency),
				title="Company Currency Mismatch",
			)

		if self.selling_price_list:
			pl_currency = frappe.get_cached_value("Price List", self.selling_price_list, "currency")
			if pl_currency and pl_currency != self.currency:
				frappe.throw(
					"Price List '{0}' currency is '{1}' but this row's currency is "
					"'{2}'. Use a price list whose currency matches the row."
					.format(self.selling_price_list, pl_currency, self.currency),
					title="Price List Currency Mismatch",
				)

		# bank_account (legacy display field) dimiliki oleh company tertentu —
		# sahkan ia milik company baris ini supaya nombor akaun yang
		# dipaparkan kepada customer konsisten dengan company yang bil.
		if self.bank_account:
			ba_company = frappe.get_cached_value("Bank Account", self.bank_account, "company")
			if ba_company and ba_company != self.company:
				frappe.throw(
					"Bank Account '{0}' belongs to company '{1}' but this row's "
					"company is '{2}'.".format(self.bank_account, ba_company, self.company),
					title="Bank Account Company Mismatch",
				)
