# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk Product Elements Restructure (patch v41/v42):

1. _get_pricing_map currency — fallback native sepenuhnya bila tiada
   matrix; baris currency menang per kategori.
2. get_public_merchandise — tapisan flag is_public_merchandise.

Hermetik: mock frappe.db (sql / get_value) supaya resolusi berlaku dalam
FUNGSI sebenar tanpa menulis data.
"""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.api import pricing as pricing_mod
from travel_booking.api import merchandise as merch_mod


def _row(cat="Balcony", adult=1000, currency=None):
	return frappe._dict({
		"room_category": cat, "currency": currency,
		"price_adult_single": adult * 1.5, "price_adult": adult,
		"price_upperberth": adult * 0.6, "price_children": adult * 0.5,
		"price_toddler": 0, "price_infant": 0,
	})


class PricingMapCurrencyTestCase(UnitTestCase):
	"""_get_pricing_map(trip_package, currency) — resolusi matrix."""

	def _map(self, rows, currency=None, review=False):
		def _get_value(doctype, name, field=None, *a, **kw):
			if doctype == "Trip Package" and field == "price_review_required":
				return 1 if review else 0
			return None
		def _sql(q, *a, **kw):
			if "tabTrip Package Price" in q:
				return rows
			return []
		with patch.object(frappe.db, "get_value", side_effect=_get_value), \
		     patch.object(frappe.db, "sql", side_effect=_sql):
			return pricing_mod._get_pricing_map("TP-TEST", currency)

	def test_no_currency_param_native_only(self):
		rows = [_row("Balcony"), _row("Suite", 2000)]
		m = self._map(rows)
		self.assertEqual(set(m.keys()), {"Balcony", "Suite"})
		self.assertEqual(m["Balcony"].price_adult, 1000)

	def test_currency_without_matrix_full_native_fallback(self):
		# 167 baris sedia ada semua native — minta SGD → pulangkan native
		# sepenuhnya (tingkah laku lama terpelihara).
		rows = [_row("Balcony"), _row("Suite", 2000)]
		m = self._map(rows, currency="SGD")
		self.assertEqual(set(m.keys()), {"Balcony", "Suite"})
		self.assertEqual(m["Balcony"].price_adult, 1000)

	def test_currency_row_wins_per_category(self):
		rows = [
			_row("Balcony", 1000),                 # native MYR
			_row("Balcony", 900, currency="SGD"),  # matrix SGD
			_row("Suite", 2000),                   # native sahaja
		]
		m = self._map(rows, currency="SGD")
		self.assertEqual(m["Balcony"].price_adult, 900)   # SGD menang
		self.assertEqual(m["Suite"].price_adult, 2000)    # fallback native

	def test_native_ignored_when_currency_matrix_exists_for_category(self):
		rows = [
			_row("Balcony", 1000),
			_row("Balcony", 900, currency="SGD"),
			_row("Balcony", 950, currency="USD"),  # currency lain — diabaikan
		]
		m = self._map(rows, currency="SGD")
		self.assertEqual(m["Balcony"].price_adult, 900)

	def test_review_guard_still_throws(self):
		try:
			self._map([_row("Balcony")], review=True)
			self.fail("expected throw")
		except Exception as e:
			self.assertIn("under review", str(e))


class PublicMerchandiseFilterTestCase(UnitTestCase):
	"""get_public_merchandise — tapisan flag, bukan item_group."""

	def test_only_flagged_items_listed(self):
		# Query SQL yang di-mock sudah bawa flag dalam WHERE — kita
		# sahkan SQL yang DIHANTAR mengandungi tapisan betul.
		captured = {}
		def _sql(q, *a, **kw):
			captured["q"] = q
			return [frappe._dict({
				"item_code": "M1", "item_name": "M1", "image": "",
				"description": "", "item_group": "Merchandise",
				"is_stock_item": 1})]
		with patch.object(frappe.db, "sql", side_effect=_sql), \
		     patch.object(frappe.db, "get_all", return_value=[
		         frappe._dict({"item_code": "M1", "price_list_rate": 25})]), \
		     patch.object(merch_mod, "_merch_in_stock", return_value=True), \
		     patch("travel_booking.api.currency_axis.currency_to_price_list",
		           return_value="Standard Selling"):
			out = merch_mod.get_public_merchandise(currency="MYR")
		self.assertIn("is_public_merchandise", captured["q"])
		self.assertNotIn("item_group = 'Products'", captured["q"])
		self.assertEqual(len(out["items"]), 1)
		self.assertEqual(out["items"][0]["price"], 25)

	def test_item_without_price_hidden(self):
		def _sql(q, *a, **kw):
			return [frappe._dict({
				"item_code": "M2", "item_name": "M2", "image": "",
				"description": "", "item_group": "Merchandise",
				"is_stock_item": 1})]
		with patch.object(frappe.db, "sql", side_effect=_sql), \
		     patch.object(frappe.db, "get_all", return_value=[]), \
		     patch("travel_booking.api.currency_axis.currency_to_price_list",
		           return_value="Standard Selling"):
			out = merch_mod.get_public_merchandise(currency="MYR")
		self.assertEqual(out["items"], [])


class BOMBackfillShapeTestCase(UnitTestCase):
	"""Sekuriti data backfill/backout (v42→v43) — invariant BOM selepas
	restrukturasi ownership: komponen pakej = komposisi sahaja
	(merch/activity/excursion/transfer/misc); elemen fizikal cruise/flight
	terletak pada TGD (cruise_schedule + flight_schedule)."""

	def test_no_cruise_or_flight_components(self):
		rows = frappe.db.get_all("Trip Package Component",
			filters={"component_type": ["in", ["Cruise Segment", "Flight"]]},
			pluck="name")
		self.assertEqual(rows, [],
			"komponen Cruise/Flight patut dipadam oleh v43 — semak!")

	def test_tgd_cruise_schedules_preserved(self):
		# Backout v43 TIDAK menyentuh TGD — semua rujukan cruise_schedule
		# kekal (data asal, bukan duplikat BOM).
		n = frappe.db.count("Trip Group Date",
			{"cruise_schedule": ["is", "set"]})
		self.assertGreater(n, 0, "TGD cruise_schedule hilang — semak v43!")


class TripManagerPageAPITestCase(UnitTestCase):
	"""API Trip Manager page — gate role + bentuk respons ringkas."""

	def test_guest_denied(self):
		from travel_booking.api import trip_manager_page as tm
		with patch.object(frappe, "get_roles", return_value=["Guest"]):
			with self.assertRaises(frappe.PermissionError):
				tm.get_trips_overview()

	def test_manager_allowed(self):
		from travel_booking.api import trip_manager_page as tm
		with patch.object(frappe, "get_roles", return_value=["Tour Manager"]):
			# get_trips_overview dijalankan — tetapi SQL DB sebenar perlu
			# session Administrator-ish; cukup sahkan gate lulus (tiada
			# PermissionError sebelum query).
			try:
				out = tm.get_trips_overview()
				self.assertIn("trips", out)
				self.assertIn("total", out)
			except frappe.PermissionError:
				self.fail("Tour Manager patut dibenarkan")
