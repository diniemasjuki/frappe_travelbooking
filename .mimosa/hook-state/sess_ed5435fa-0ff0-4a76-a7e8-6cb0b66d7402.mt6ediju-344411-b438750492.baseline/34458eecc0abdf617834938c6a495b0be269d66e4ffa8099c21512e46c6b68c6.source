"""Flag Trip Package yang perlu semakan semula harga selepas migrasi currency.

Selepas workflow jualan/booking ditukar kepada company currency, harga pada
`Trip Package Price` dianggap dalam company currency. Pakej yang sebelum ini
menggunakan currency BUKAN company (field `Trip Package.currency` jadi hint
paparan) berkemungkinan tersalah tafsir — harga sedia ada mungkin masih
nilai lama dalam currency asal.

Patch ini TIDAK auto-convert harga (nilai jualan ialah keputusan bisnes).
Sebaliknya ia menandakan pakej terbabit dengan `price_review_required = 1`
supaya admin semak & isi semula harga dalam company currency, kemudian
uncheck flag tersebut. Sementara flag terpasang, `_get_pricing_map` akan
halang sebarang kiraan harga/booking atas pakej berkenaan (guardrail).
"""

import frappe

from travel_booking.api._helpers import get_company_currency


def execute():
	company_currency = get_company_currency()

	# Pakej yang currency-nya berbeza dari company currency DAN belum
	# berflag. Termasuk pakej tanpa currency (NULL) TIDAK diflag — pakej
	# sedemikian tiada hint currency asal, dianggap sudah company currency.
	packages = frappe.db.sql_list(
		"""
		SELECT name FROM `tabTrip Package`
		WHERE currency IS NOT NULL
		  AND currency != %s
		  AND IFNULL(price_review_required, 0) = 0
		""",
		(company_currency,),
	)
	if not packages:
		return

	for name in packages:
		frappe.db.set_value(
			"Trip Package",
			name,
			"price_review_required",
			1,
			update_modified=False,
		)
