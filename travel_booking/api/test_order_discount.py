# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk model diskaun order-level (voucher/referral).

Model semasa: diskaun dibawa PADA SO sebagai additional discount
(grand_total NET) — Payment Entry rakam cash sahaja. Rekod lama (SO
GROSS) diserap melalui PE deduction. Guard `_so_carries_order_discount`
membezakan kedua-dua model; tests ni hermetik — frappe.db di-mock, tiada
state site diubah.
"""

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api import so_helpers


def _patch_db_get_value(mapping):
	"""Patch frappe.db.get_value dengan lookup kamus (args → nilai).

	mapping keys boleh jadi ("Sales Order", so, "custom_booking"),
	("Booking", bk, [fields...]) dan ("Sales Order", so, "discount_amount").
	"""

	def fake_get_value(doctype, name, fieldname=None, **_kwargs):
		# Normalise senarai fields → tuple supaya boleh jadi kunci kamus.
		fld = tuple(fieldname) if isinstance(fieldname, (list, tuple)) else fieldname
		key = (doctype, name, fld)
		if key in mapping:
			return mapping[key]
		# get_value dengan senarai fields → pulangkan None row default
		return None

	return patch.object(frappe.db, "get_value", side_effect=fake_get_value)


class TestSoCarriesOrderDiscount(UnitTestCase):
	"""Guard pembezakan model diskaun baharu (SO net) vs lama (SO gross)."""

	SO = "SO-TEST-001"
	BK = "BK-TEST-001"

	def test_no_booking_linked_is_new_model(self):
		# SO tanpa Booking (rekod manual/lama) → tiada diskaun order-level
		# → dilayan sebagai model baharu (cash sahaja).
		with _patch_db_get_value({("Sales Order", self.SO, "custom_booking"): None}):
			self.assertTrue(so_helpers._so_carries_order_discount(self.SO))

	def test_booking_without_discount_is_new_model(self):
		# Snapshot diskaun Booking sifar → kedua-dua model serupa → True.
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): (0, 0),
			("Sales Order", self.SO, "discount_amount"): 0,
		}
		with _patch_db_get_value(mapping):
			self.assertTrue(so_helpers._so_carries_order_discount(self.SO))

	def test_booking_row_missing_is_new_model(self):
		# Booking dipaut tapi row tak wujud → True (jangan sekat bayaran).
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): None,
		}
		with _patch_db_get_value(mapping):
			self.assertTrue(so_helpers._so_carries_order_discount(self.SO))

	def test_legacy_gross_so_is_old_model(self):
		# Ada snapshot diskaun pada Booking TAPI SO tanpa additional
		# discount → model lama (SO GROSS, serapan PE deduction).
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): (100.0, 0.0),
			("Sales Order", self.SO, "discount_amount"): 0,
		}
		with _patch_db_get_value(mapping):
			self.assertFalse(so_helpers._so_carries_order_discount(self.SO))

	def test_referral_only_legacy_is_old_model(self):
		# Snapshot referral sahaja (tanpa voucher) pada SO gross → lama.
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): (0.0, 27.5),
			("Sales Order", self.SO, "discount_amount"): 0,
		}
		with _patch_db_get_value(mapping):
			self.assertFalse(so_helpers._so_carries_order_discount(self.SO))

	def test_new_model_so_discount_on_so(self):
		# Snapshot diskaun Booking DAN SO bawa additional discount → baru.
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): (100.0, 18.0),
			("Sales Order", self.SO, "discount_amount"): 118.0,
		}
		with _patch_db_get_value(mapping):
			self.assertTrue(so_helpers._so_carries_order_discount(self.SO))

	def test_b2b_so_is_new_model(self):
		# SO B2B (discount_amount > 0, tiada snapshot voucher/referral)
		# → True tanpa perlu baca Booking lagi (shortcut snapshot sifar).
		mapping = {
			("Sales Order", self.SO, "custom_booking"): self.BK,
			("Booking", self.BK, ("voucher_discount", "referral_discount")): (0, 0),
			("Sales Order", self.SO, "discount_amount"): 200.0,
		}
		with _patch_db_get_value(mapping):
			self.assertTrue(so_helpers._so_carries_order_discount(self.SO))


class TestCashbackDeduction(UnitTestCase):
	"""Baris deduction cashback Manual Transfer — kekal untuk kedua-dua
	model diskaun (cashback bukan diskaun harga; ia benefit transaksional)."""

	def test_cashback_row_other_deductions_zero(self):
		# Model semasa: allocated = cash + cashback sahaja (tanpa ruang
		# diskaun). 20% atas allocated 200 dengan cash 180 → deduction 20.
		with patch.object(
			so_helpers, "_resolve_cashback_discount_account", return_value="Marketing Expenses - TC"
		), patch.object(frappe.db, "get_value", return_value="CC-DEF"), patch.object(
			frappe, "log_error"
		):
			row = so_helpers._resolve_cashback_deduction(
				"Test Company", "MYR", "SO-TEST", 10.0, 180.0, 200.0)
		self.assertIsNotNone(row)
		self.assertEqual(row["amount"], 20.0)
		self.assertEqual(row["account"], "Marketing Expenses - TC")
		self.assertIn("Cashback", row["description"])

	def test_no_room_means_no_row(self):
		# allocated == cash → tiada jurang untuk deduction → None (dan
		# tiada lookup akaun diperlukan).
		with patch.object(frappe.db, "get_value") as mock_gv:
			row = so_helpers._resolve_cashback_deduction(
				"Test Company", "MYR", "SO-TEST", 10.0, 100.0, 100.0)
		self.assertIsNone(row)
		mock_gv.assert_not_called()


class TestBuildDiscountDeductionRows(UnitTestCase):
	"""LEGACY: binaan baris deduction diskaun order-level (rekod lama)."""

	def test_non_positive_amounts_filtered(self):
		# Komponen <= 0 digugurkan → tiada baris, tiada total (tiada
		# lookup akaun diperlukan).
		with patch.object(frappe.db, "get_value") as mock_gv:
			rows, total = so_helpers._build_discount_deduction_rows(
				"Test Company", "MYR", "SO-TEST",
				[("Voucher X", 0), ("Referral Y", -5)])
		self.assertEqual(rows, [])
		self.assertEqual(total, 0.0)
		mock_gv.assert_not_called()

	def test_account_missing_returns_none(self):
		# Akaun marketing tak dikonfigurasi → (None, 0.0) — caller WAJIB
		# fallback allocate cash sahaja (error di-log untuk admin).
		with patch.object(so_helpers, "_resolve_cashback_discount_account", return_value=None), \
				patch.object(frappe, "log_error") as mock_log:
			rows, total = so_helpers._build_discount_deduction_rows(
				"Test Company", "MYR", "SO-TEST", [("Voucher X", 100.0)])
		self.assertIsNone(rows)
		self.assertEqual(total, 0.0)
		mock_log.assert_called_once()

	def test_rows_built_with_prefix(self):
		# Baris deduction dibina dengan prefix "Order Discount" — prefix
		# ni juga kunci pengiraan _get_absorbed_order_discount (legacy).
		with patch.object(
			so_helpers, "_resolve_cashback_discount_account", return_value="Marketing Expenses - TC"
		), patch.object(frappe.db, "get_value", return_value="CC-DEF"), patch.object(
			frappe, "log_error"
		):
			rows, total = so_helpers._build_discount_deduction_rows(
				"Test Company", "MYR", "SO-TEST",
				[("Voucher X", 100.0), ("Referral Y", 18.0)])
		self.assertEqual(len(rows), 2)
		self.assertEqual(total, 118.0)
		for r in rows:
			self.assertTrue(r["description"].startswith("Order Discount"))
			self.assertEqual(r["account"], "Marketing Expenses - TC")
			self.assertEqual(r["cost_center"], "CC-DEF")
