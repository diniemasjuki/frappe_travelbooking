"""Seed baris paksi currency (Travel Settings > Multi Currency Account)
untuk company default, dan pastikan Trip Package.currency / Trip Addon
Package.currency terisi.

Model baharu: paksi multi-currency/multi-company — setiap baris TCA
mengisytiharkan SATU currency yang boleh dijual, menunjuk company yang
mengeluarkan SO/bil untuk currency itu. Patch ni hanya menjamin baris
ASAS wujud (currency company default -> company default), supaya laman
terus berfungsi (behavior hari ini) sebaik sahaja selepas migrate.

Baris currency branch (SGD/IDR/...) TIDAK di-auto-cipta — ia memerlukan
Company + Chart of Accounts + Price List wujud dahulu (kerja persediaan
admin dalam Desk). Arahan persediaan didokumenkan dalam plan upgrade.

Tiga langkah (semua idempotent):
1. Baris TCA company default — cipta jika tiada; jika wujud tapi company
   kosong, isikan company default + price list default (migrate baris
   lama yang hanya bawa bank/gateway account).
2. Trip Package.currency NULL -> currency company default (pakej lama
   sebelum field wujud; harga dianggap company currency).
3. Trip Addon Package.currency NULL -> currency company default.
"""

import frappe

from travel_booking.api._helpers import get_company_currency
from travel_booking.api.constants import DEFAULT_SELLING_PRICE_LIST


def execute():
	default_company = frappe.db.get_single_value("Global Defaults", "default_company")
	if not default_company:
		return  # pemasangan baru tanpa company — tiada apa boleh di-seed

	company_currency = (
		frappe.db.get_value("Company", default_company, "default_currency")
		or get_company_currency()
	)

	ts = frappe.get_doc("Travel Settings")

	# 1. Baris TCA untuk company default.
	existing = None
	for row in (ts.currency_accounts or []):
		if row.currency == company_currency:
			existing = row
			break

	changed = False
	if not existing:
		ts.append("currency_accounts", {
			"currency": company_currency,
			"company": default_company,
			"selling_price_list": DEFAULT_SELLING_PRICE_LIST,
		})
		changed = True
	elif not existing.company:
		# Baris lama (hanya bank/gateway) — naik taraf dengan company +
		# price list tanpa sentuh medan pembayaran yang sudah diisi.
		existing.company = default_company
		if not existing.selling_price_list:
			existing.selling_price_list = DEFAULT_SELLING_PRICE_LIST
		changed = True

	if changed:
		ts.flags.ignore_permissions = True
		ts.save()

	# 2. Trip Package.currency NULL -> company default currency.
	frappe.db.sql(
		"""
		UPDATE `tabTrip Package`
		SET currency = %s
		WHERE currency IS NULL OR currency = ''
		""",
		(company_currency,),
	)

	# 3. Trip Addon Package.currency NULL -> company default currency.
	frappe.db.sql(
		"""
		UPDATE `tabTrip Addon Package`
		SET currency = %s
		WHERE currency IS NULL OR currency = ''
		""",
		(company_currency,),
	)
