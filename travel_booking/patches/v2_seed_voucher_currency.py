"""Set currency voucher Fixed Amount sedia ada kepada currency company
default (keputusan: semua voucher fixed lama dianggap bernilai currency
company default — MYR pada site HQ Malaysia).

Voucher Percentage tidak disentuh (currency tidak relevan untuk %).
Voucher fixed yang currency-nya sudah terisi tidak diubah (idempotent).
"""

import frappe

from travel_booking.api._helpers import get_company_currency


def execute():
	company_currency = get_company_currency()

	frappe.db.sql(
		"""
		UPDATE `tabVoucher`
		SET currency = %s
		WHERE discount_type != 'Percentage'
		  AND (currency IS NULL OR currency = '')
		""",
		(company_currency,),
	)
