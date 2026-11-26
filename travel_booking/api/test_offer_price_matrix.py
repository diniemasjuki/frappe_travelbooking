# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian hermetik Price Matrix offer (Stage pricing Nov 2026 — child
Trip Package Price ialah SUMBER HARGA UTAMA; Offer Price hanya fallback
legacy bagi offer warisan).

Yang diuji (_get_offer_pricing_map):
1. Matrix wujud → baca TERUS (lajur slot penuh termasuk price_upperberth
   & price_adult_single sebenar — bukan lagi hack single=dewasa).
2. Matrix kosong → THROW walaupun Offer Price legacy wujud (medan dibuang).
3. Kedua-dua kosong → throw jelas (jangan jual offer kosong).
4. Kod kategori kanonik v47 di-resolve ke docname Trip Price Category.

Corak: monkeypatch frappe.get_all (DELEGATE — pertanyaan asing diserahkan
ke implementasi sebenar; lihat pelajaran racun cache test_new_catalog)."""

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase


def _cat(name="Seaview Suite", code="SVS"):
	return frappe._dict(name=name, category_code=code)


def _matrix_rows(upper=150.0):
	return [frappe._dict(
		pricing_for_class="Seaview Suite",
		price_adult=520.0, price_adult_single=640.0,
		price_upperberth=upper, price_children=320.0,
		price_toddler=180.0, price_infant=60.0)]


class TestOfferPricingMapMatrixFirst(UnitTestCase):

	def _run(self, offer, matrix_rows, offer_price_rows, cats):
		real_get_all = frappe.get_all

		def _get_all(doctype, *args, **kwargs):
			if doctype == "Trip Package Price" and kwargs.get(
					"filters", {}).get("parent") == offer:
				return matrix_rows
			if doctype == "Offer Price" and kwargs.get(
					"filters", {}).get("parent") == offer:
				return offer_price_rows
			if doctype == "Trip Price Category":
				return cats
			return real_get_all(doctype, *args, **kwargs)

		with patch("frappe.get_all", side_effect=_get_all):
			from travel_booking.api.pricing import _get_offer_pricing_map
			return _get_offer_pricing_map(offer)

	def test_matrix_read_directly_with_upperberth(self):
		"""Sumber UTAMA: lajur slot penuh dibaca terus — upper & single
		sebenar tersokong (bug harga extra-bed model lama selesai)."""
		map_ = self._run("OFF-1", _matrix_rows(), [
			frappe._dict(opt1="SVS", age_option="ADULT", price=1.0),
		], [_cat()])
		self.assertIn(_cat().name, map_)
		row = map_["Seaview Suite"]
		self.assertEqual(row.price_adult, 520.0)
		self.assertEqual(row.price_adult_single, 640.0)  # bukan hack dewasa
		self.assertEqual(row.price_upperberth, 150.0)    # bukan lagi 0
		self.assertEqual(row.price_children, 320.0)
		self.assertEqual(row.price_toddler, 180.0)
		self.assertEqual(row.price_infant, 60.0)

	def test_matrix_empty_throws_even_with_legacy_rows(self):
		"""[Nov 2026] Offer Price legacy DITANGGALKAN — matrix kosong →
		throw walaupun baris Offer Price lama masih wujud (tak di fallback)."""
		legacy = [
			frappe._dict(opt1="SVS", age_option="ADULT", price=520.0,
						 price_key="SVS|ADULT"),
		]
		with self.assertRaises(frappe.ValidationError):
			self._run("OFF-2", [], legacy, [_cat()])

	def test_category_code_resolved_to_docname(self):
		"""Kod kanonik v47 pada baris matrix di-resolve ke docname
		Trip Price Category sebagai kunci map."""
		map_ = self._run("OFF-3", _matrix_rows(), [], [_cat()])
		self.assertIn("Seaview Suite", map_)
		self.assertNotIn("SVS", map_)

	def test_empty_both_throws(self):
		with self.assertRaises(frappe.ValidationError):
			self._run("OFF-4", [], [], [_cat()])


class _FakeMatrixRow:
	def __init__(self, pricing_for_class):
		self.pricing_for_class = pricing_for_class


class _FakeOfferDoc:
	"""Dokumen offer palsu untuk import_offer_prices — append ke senarai
	price_matrix; save no-op."""

	def __init__(self):
		self.price_matrix = []
		self.currency = "MYR"
		self.saved = False

	def append(self, fieldname, row):
		self.price_matrix.append(_FakeMatrixRow(row["pricing_for_class"]))
		last = self.price_matrix[-1]
		for k, v in row.items():
			if k != "pricing_for_class":
				setattr(last, k, v)

	def save(self, **kw):
		self.saved = True


class TestImportRounding(UnitTestCase):
	"""Import dengan faktor (kurs/markup) → BUNDAR KE ATAS ke integer
	(arahan pemilik Nov 2026); tanpa faktor → nilai mentah."""

	def _import(self, rows, markup=None):
		from travel_booking.api import package_admin
		doc = _FakeOfferDoc()
		real_get_all = frappe.get_all

		def _ga(doctype, *a, **k):
			if doctype == "Trip Price Category":
				return [frappe._dict(name="Seaview Suite",
									 category_code="SVS")]
			return real_get_all(doctype, *a, **k)

		with patch.object(frappe.db, "exists", return_value=True), \
			patch("frappe.get_all", side_effect=_ga), \
			patch("frappe.get_doc", return_value=doc), \
			patch("erpnext.setup.utils.get_exchange_rate",
				  return_value=3.2):
			import json as _json
			res = package_admin.import_offer_prices(
				"OFF-1", _json.dumps(rows), markup_percent=markup)
		return doc, res

	def test_markup_ceils_to_integer(self):
		# 33 × 3.2 (kurs SGD→MYR) × 1.10 = 116.16 → ceil 117
		doc, res = self._import(
			[{"category_code": "SVS", "currency": "SGD",
			  "price_adult": 33}], markup="10")
		row = doc.price_matrix[0]
		self.assertEqual(row.price_adult, 117)
		self.assertIsInstance(row.price_adult, int)

	def test_no_factor_keeps_raw(self):
		# Tiada kurs/markup → salinan mentah (perpuluhan kekal).
		doc, res = self._import(
			[{"category_code": "SVS", "currency": "MYR",
			  "price_adult": 53.5}])
		self.assertEqual(doc.price_matrix[0].price_adult, 53.5)

	def test_exact_integer_unchanged(self):
		# 100 × 3.2 × 1.1 = 352.0 → ceil = 352 (tak naik).
		doc, res = self._import(
			[{"category_code": "SVS", "currency": "SGD",
			  "price_adult": 100}], markup="10")
		self.assertEqual(doc.price_matrix[0].price_adult, 352)


class TestOfferAddonsMap(UnitTestCase):
	"""[Rombakan Nov 2026] addons dipisahkan daripada base —
	_get_offer_addons_map baca parentfield addon_price_matrix;
	_get_offer_pricing_map baca price_matrix (base) sahaja."""

	def _run(self, offer, base_rows, addon_rows):
		from travel_booking.api.pricing import (_get_offer_pricing_map,
											   _get_offer_addons_map)
		real_get_all = frappe.get_all

		def _ga(doctype, *args, **kwargs):
			if doctype == "Trip Package Price":
				pf = kwargs.get("filters", {}).get("parentfield")
				return base_rows if pf == "price_matrix" else addon_rows
			if doctype == "Trip Price Category":
				return [_cat(), frappe._dict(name="Economy Seat",
											 category_code="FLE")]
			return real_get_all(doctype, *args, **kwargs)

		with patch("frappe.get_all", side_effect=_ga):
			return (_get_offer_pricing_map(offer),
					_get_offer_addons_map(offer))

	def test_base_and_addon_split(self):
		base = [frappe._dict(pricing_for_class="Seaview Suite",
							 price_adult=520.0, price_adult_single=640.0,
							 price_upperberth=150.0, price_children=320.0,
							 price_toddler=180.0, price_infant=60.0)]
		addon = [frappe._dict(pricing_for_class="Economy Seat",
							  price_adult=800.0, price_adult_single=800.0,
							  price_upperberth=None, price_children=600.0,
							  price_toddler=400.0, price_infant=100.0)]
		base_map, addon_map = self._run("OFF-1", base, addon)
		self.assertIn("Seaview Suite", base_map)
		self.assertNotIn("Economy Seat", base_map)
		self.assertIn("Economy Seat", addon_map)
		self.assertNotIn("Seaview Suite", addon_map)
		self.assertEqual(addon_map["Economy Seat"].price_adult, 800.0)

	def test_addons_empty_is_ok_not_throw(self):
		"""Addon kosong TIDAK throw (pakej boleh dijual tanpa addon);
		base kosong masih throw (harga asas wajib)."""
		base = [frappe._dict(pricing_for_class="Seaview Suite",
							 price_adult=520.0)]
		base_map, addon_map = self._run("OFF-2", base, [])
		self.assertEqual(addon_map, {})
		with self.assertRaises(frappe.ValidationError):
			self._run("OFF-3", [], [])


class TestOfferAddonTotals(UnitTestCase):
	"""[Isu harga total Nov 2026] Total pakej = base + Σ addon —
	_get_offer_addon_totals jumlahkan lajur slot merentasi SEMUA baris
	addon (None → 0); _apply_addon_totals campurkan surcaj ke SETIAP
	baris map harga (dipakai bersama di titik paparan get_booking_details
	dan titik caj confirm_booking supaya paparan == jumlah dicas)."""

	def _run(self, offer, addon_rows):
		from travel_booking.api.pricing import (
			_get_offer_addon_totals, _apply_addon_totals,
		)
		real_get_all = frappe.get_all

		def _ga(doctype, *args, **kwargs):
			if doctype == "Trip Package Price":
				pf = kwargs.get("filters", {}).get("parentfield")
				return addon_rows if pf == "addon_price_matrix" else []
			if doctype == "Trip Price Category":
				return [_cat(), frappe._dict(name="Economy Seat",
											 category_code="FLE"),
						frappe._dict(name="Hotel KLIA",
									 category_code="HTLKLIA")]
			return real_get_all(doctype, *args, **kwargs)

		with patch("frappe.get_all", side_effect=_ga):
			totals = _get_offer_addon_totals(offer)
			base = {"SVS": frappe._dict(
				price_adult=520.0, price_adult_single=640.0,
				price_upperberth=150.0, price_children=320.0,
				price_toddler=180.0, price_infant=60.0)}
			_apply_addon_totals(base, totals)
			return totals, base

	def test_totals_sum_all_addon_rows_per_column(self):
		"""Σ addon merentasi baris Flight + Hotel; None dikira 0; map base
		dibawa surcaj pada setiap lajur slot."""
		addon = [
			frappe._dict(pricing_for_class="Economy Seat",
						 price_adult=800.0, price_adult_single=800.0,
						 price_upperberth=None, price_children=600.0,
						 price_toddler=400.0, price_infant=100.0),
			frappe._dict(pricing_for_class="Hotel KLIA",
						 price_adult=120.0, price_adult_single=120.0,
						 price_upperberth=60.0, price_children=0.0,
						 price_toddler=0.0, price_infant=0.0),
		]
		totals, base = self._run("OFF-1", addon)
		self.assertAlmostEqual(totals["price_adult"], 920.0)
		self.assertAlmostEqual(totals["price_adult_single"], 920.0)
		self.assertAlmostEqual(totals["price_upperberth"], 60.0)
		self.assertAlmostEqual(totals["price_children"], 600.0)
		self.assertAlmostEqual(base["SVS"].price_adult, 520.0 + 920.0)
		self.assertAlmostEqual(base["SVS"].price_upperberth, 150.0 + 60.0)
		self.assertAlmostEqual(base["SVS"].price_infant, 60.0 + 100.0)

	def test_no_addons_totals_empty_and_map_unchanged(self):
		"""Offer tanpa addon → totals {} dan map harga TIDAK diubah
		(pakej biasa kekal harga base)."""
		totals, base = self._run("OFF-2", [])
		self.assertEqual(totals, {})
		self.assertAlmostEqual(base["SVS"].price_adult, 520.0)
		self.assertAlmostEqual(base["SVS"].price_upperberth, 150.0)
