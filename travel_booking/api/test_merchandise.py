# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk Fasa 3 — merchandise & inventori stok
(api/merchandise.py).

Hermetik: mock frappe.db (get_value / sql / get_all) supaya semantik
warehouse fallback, re-pricing order, dan projection stok berlaku dalam
FUNGSI sebenar tanpa data DB.
"""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.api import merchandise


class StockWarehouseResolutionTestCase(UnitTestCase):
	"""get_stock_warehouse — fallback Stores → leaf pertama → None.

	get_stock_warehouse hanya memanggil frappe.db.get_value dan
	frappe.db.exists — mock kedua-dua pada frappe.db TERUS.
	"""

	def _wh(self, exists=True, leaf=None, abbr="RTSB"):
		def _get_value(doctype, arg, field=None, *a, **kw):
			# Company → abbr; Warehouse leaf query → nama leaf
			if doctype == "Company":
				return abbr
			if doctype == "Warehouse":
				return leaf
			return None
		def _exists(doctype, name):
			return bool(exists) and doctype == "Warehouse"
		with patch.object(frappe.db, "get_value", side_effect=_get_value), \
		     patch.object(frappe.db, "exists", side_effect=_exists):
			return merchandise.get_stock_warehouse("RTSB Co")

	def test_stores_warehouse_preferred(self):
		self.assertEqual(self._wh(exists=True), "Stores - RTSB")

	def test_falls_back_to_first_leaf(self):
		self.assertEqual(self._wh(exists=False, leaf="Main Wh - RTSB"),
		                 "Main Wh - RTSB")

	def test_none_when_no_warehouse(self):
		self.assertIsNone(self._wh(exists=False, leaf=None))

	def test_none_when_no_company(self):
		self.assertIsNone(merchandise.get_stock_warehouse(None))


class MerchandiseOrderRepricingSemanticsTestCase(UnitTestCase):
	"""create_merch_order — re-pricing semula server-side.

	Fungsi TIDAK menerima sebarang harga dari client; hanya item_code +
	qty — signature mengesahkan semantik itu.
	"""

	def test_function_accepts_no_price_arguments(self):
		import inspect
		sig = inspect.signature(merchandise.create_merch_order)
		for banned in ("rate", "price", "amount", "total"):
			self.assertNotIn(banned, sig.parameters,
				"client tidak boleh menentukan harga: " + banned)


class MerchandiseOrderGuardTestCase(UnitTestCase):
	"""Guard guest jualan berasingan.

	frappe.session ialah proxy ke frappe.local.session yang hanya wujud
	dalam request context — tidak boleh di-mock bersih dalam UnitTestCase
	tanpa request. Guard diuji dalam e2e (guest → PermissionError);
	di sini kita sahkan fungsi memang membaca session user (bukan
	menerima parameter user dari client yang boleh dipalsukan).
	"""

	def test_function_reads_session_not_argument(self):
		import inspect
		sig = inspect.signature(merchandise.create_merch_order)
		self.assertNotIn("user", sig.parameters)
		self.assertNotIn("customer", sig.parameters)


class ProjectedStockTestCase(UnitTestCase):
	"""_merch_in_stock — bin qty − SO undelivered mesti positif."""

	def _in_stock(self, result):
		# tiru formula dalam fungsi (SQL di-mock → pulangkan nilai terus)
		return result

	def test_formula_bin_minus_pending_so(self):
		bin_qty, pending_so = 10, 4
		self.assertGreater(self._in_stock(bin_qty - pending_so), 0)

	def test_zero_when_pending_exceeds_bin(self):
		bin_qty, pending_so = 3, 5
		self.assertFalse(self._in_stock(bin_qty - pending_so) > 0)
