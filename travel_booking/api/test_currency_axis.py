# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk paksi currency multi-company (api/currency_axis.py +
so_helpers._resolve_so_currency_and_rate + Trip Addon Package rate
resolution).

Hermetik — data sintetik (frappe._dict + monkeypatch get_currency_axis),
tiada fixture DB diperlukan. Semantik paksi:
- currency → company: throw bila currency tidak diisytiharkan (JANGAN
  fallback senyap — SO salah company lebih mahal dari error jelas).
- resolve_so_currency_context: (currency, company, price_list, rate=1.0).
- Fallback caller lama (currency=None): company default + price list
  default — behavior pra-multi-company kekal.
- Rate addon: baris rate ikut currency; fallback legacy BILA currency
  legacy sepadan; None (tak dijual) bila tiada — bukan convert.
"""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.api import currency_axis
from travel_booking.api.so_helpers import _resolve_so_currency_and_rate


def _axis_row(currency, company, price_list=None, is_default=False):
	return frappe._dict({
		"currency": currency,
		"symbol": currency,  # cukup untuk test — _currency_symbol dipatch
		"company": company,
		"selling_price_list": price_list,
		"bank_account": None,
		"manual_transfer_paid_to_account": None,
		"payment_gateway_account": None,
		"is_default": is_default,
	})


AXIS = [
	_axis_row("MYR", "HQ Malaysia Sdn Bhd", "Standard Selling", is_default=True),
	_axis_row("SGD", "Branch Singapore Pte Ltd", "Standard Selling SGD"),
	_axis_row("IDR", "Branch Indonesia PT", "Standard Selling IDR"),
]


class CurrencyAxisTestCase(UnitTestCase):
	def setUp(self):
		# Patch sumber axis — semua helper currency_axis membaca darinya.
		patcher = patch.object(currency_axis, "get_currency_axis", lambda: AXIS)
		patcher.start()
		self.addCleanup(patcher.stop)

	def test_options_reflect_declared_axis(self):
		opts = currency_axis.get_currency_options()
		self.assertEqual([o["currency"] for o in opts], ["MYR", "SGD", "IDR"])
		self.assertEqual(opts[0]["company"], "HQ Malaysia Sdn Bhd")
		self.assertTrue(opts[0]["is_default"])

	def test_declared_currencies_set(self):
		self.assertEqual(currency_axis.get_declared_currencies(), {"MYR", "SGD", "IDR"})

	def test_resolve_company_for_declared_currency(self):
		self.assertEqual(
			currency_axis.resolve_company_for_currency("SGD"), "Branch Singapore Pte Ltd"
		)

	def test_resolve_company_for_undeclared_currency_throws(self):
		with self.assertRaises(frappe.exceptions.ValidationError):
			currency_axis.resolve_company_for_currency("USD")

	def test_currency_to_price_list_declared(self):
		self.assertEqual(currency_axis.currency_to_price_list("SGD"), "Standard Selling SGD")

	def test_currency_to_price_list_fallback_default(self):
		# Baris tanpa price list → fallback price list default company.
		row_no_pl = _axis_row("BND", "Branch Brunei")
		with patch.object(currency_axis, "get_currency_axis", lambda: AXIS + [row_no_pl]):
			self.assertEqual(currency_axis.currency_to_price_list("BND"), "Standard Selling")

	def test_resolve_so_currency_context_native_rate(self):
		currency, company, price_list, rate = currency_axis.resolve_so_currency_context("SGD")
		self.assertEqual(currency, "SGD")
		self.assertEqual(company, "Branch Singapore Pte Ltd")
		self.assertEqual(price_list, "Standard Selling SGD")
		self.assertEqual(rate, 1.0)  # SO dalam company currency — tiada conversion

	def test_resolver_with_package_currency(self):
		# confirm_booking path: currency native pakej → company + price list.
		tup = _resolve_so_currency_and_rate("IDR")
		self.assertEqual(tup[0], "IDR")
		self.assertEqual(tup[1], "Branch Indonesia PT")
		self.assertEqual(tup[2], "Standard Selling IDR")
		self.assertEqual(tup[3], 1.0)

	def test_resolver_without_currency_falls_back_to_company_default(self):
		# Caller lama (tanpa currency) — JANGAN throw walaupun axis ada;
		# company default + price list default (behavior pra-multi-company).
		currency, company, price_list, rate = _resolve_so_currency_and_rate(None)
		self.assertEqual(rate, 1.0)
		self.assertTrue(currency)
		self.assertTrue(company)
		self.assertEqual(price_list, "Standard Selling")


class TripAddonPackageRateTestCase(UnitTestCase):
	"""Resolusi harga multi-currency pada Trip Addon Package (controller
	method get_rate_for_currency) — dokumen sintetik, tiada DB."""

	def _pkg(self, rates, legacy_currency="MYR", legacy_unit_price=100.0):
		from travel_booking.travel_booking_management.doctype.trip_addon_package.trip_addon_package import TripAddonPackage
		doc = TripAddonPackage({"doctype": "Trip Addon Package"})
		doc.currency = legacy_currency
		doc.unit_price = legacy_unit_price
		doc.currency_rates = [
			frappe._dict({"currency": r[0], "unit_price": r[1], "enabled": r[2] if len(r) > 2 else 1})
			for r in rates
		]
		return doc

	def test_rate_row_resolves(self):
		doc = self._pkg([("MYR", 100), ("SGD", 30)])
		price, source = doc.get_rate_for_currency("SGD")
		self.assertEqual(price, 30)
		self.assertEqual(source, "rates")

	def test_legacy_fallback_only_when_currency_matches(self):
		doc = self._pkg([], legacy_currency="MYR", legacy_unit_price=100)
		price, source = doc.get_rate_for_currency("MYR")
		self.assertEqual(price, 100)
		self.assertEqual(source, "legacy")

	def test_no_conversion_when_no_rate(self):
		# Inti model: BUKAN converter — tiada rate = tak dijual (None),
		# walaupun legacy price ada dalam currency lain.
		doc = self._pkg([("MYR", 100)], legacy_currency="MYR", legacy_unit_price=100)
		price, source = doc.get_rate_for_currency("SGD")
		self.assertIsNone(price)
		self.assertIsNone(source)

	def test_disabled_rate_row_skipped_falls_back_legacy(self):
		doc = self._pkg([("SGD", 30, 0)], legacy_currency="SGD", legacy_unit_price=28)
		price, source = doc.get_rate_for_currency("SGD")
		self.assertEqual(price, 28)
		self.assertEqual(source, "legacy")
