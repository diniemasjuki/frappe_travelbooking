# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk inversi aliran produk (package-first) — index
package_dates / package_meta dalam trip_catalog.get_trip_detail.

Fokus: logik dedupe sailing per pakej + susunan tarikh + from_price,
diuji pada bahagian yang boleh diasingkan tanpa DB penuh.
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.utils.trip_catalog import get_trip_detail


class PackageFirstIndexTestCase(UnitTestCase):
	"""Integrasi ringan terhadap data sebenar site (sahaja bila trip
	contoh wujud) — sahkan shape index package-first."""

	def _detail(self, trip="TRIP2622", currency="MYR"):
		return get_trip_detail(trip, currency=currency)

	def test_index_keys_exist(self):
		d = self._detail()
		self.assertIn("package_dates", d)
		self.assertIn("package_meta", d)
		self.assertIsInstance(d["package_dates"], dict)
		self.assertIsInstance(d["package_meta"], dict)

	def test_every_package_has_dates_and_meta(self):
		d = self._detail()
		for pkg, meta in (d.get("package_meta") or {}).items():
			self.assertIn(pkg, d["package_dates"],
				"setiap pakej meta mesti ada senarai tarikh")
			self.assertTrue(len(d["package_dates"][pkg]) >= 1)
			# Meta shape untuk render butang pakej sebelum tarikh dipilih.
			for field in ("package_type", "currency", "currency_symbol",
			              "is_cruise_only", "ground_arrangement"):
				self.assertIn(field, meta)
			self.assertIn("from_price", meta)

	def test_cruise_dates_deduped_by_sailing(self):
		"""Pakej cruise yang dipaut ke beberapa TGD pada sailing sama
		mesti dipaparkan satu tarikh sahaja per sailing."""
		d = self._detail()
		for pkg, gds in (d.get("package_dates") or {}).items():
			sails = [g.get("sailing_start") for g in gds if g.get("sailing_start")]
			self.assertEqual(len(sails), len(set(sails)),
				"duplicate sailing dalam senarai tarikh pakej " + pkg)

	def test_dates_sorted_chronologically(self):
		d = self._detail()
		for pkg, gds in (d.get("package_dates") or {}).items():
			keys = [g.get("sailing_start") or g.get("departure_date") or "" for g in gds]
			self.assertEqual(keys, sorted(keys),
				"tarikh pakej " + pkg + " tak berurutan")

	def test_gd_entry_shape_matches_group_dates(self):
		"""Entry tarikh dalam package_dates mesti bawa medan yang
		populateDates (JS) perlukan — padankan shape group_dates."""
		d = self._detail()
		for pkg, gds in (d.get("package_dates") or {}).items():
			for g in gds:
				for field in ("name", "trip_group_name", "departure_date",
				              "return_date", "sailing_start", "sailing_end",
				              "seats_left"):
					self.assertIn(field, g)
			break  # satu pakej cukup untuk shape check

	def test_from_price_populated_when_priced(self):
		"""Pakej yang ada pricing mesti bawa from_price (MIN price_adult)."""
		d = self._detail()
		priced = [m for m in (d.get("package_meta") or {}).values()
		          if m.get("from_price") is not None]
		if priced:
			for m in priced:
				self.assertGreater(m["from_price"], 0)


class TripRouteWithPackageTestCase(UnitTestCase):
	"""_trip_route_with_package — deep-link ?trip_package=."""

	def test_with_package(self):
		from travel_booking.utils.featured_catalog import _trip_route_with_package
		self.assertEqual(
			_trip_route_with_package("trip2622", "TP260905"),
			"/trip2622?trip_package=TP260905")

	def test_without_package(self):
		from travel_booking.utils.featured_catalog import _trip_route_with_package
		self.assertEqual(_trip_route_with_package("trip2622", None), "/trip2622")
		self.assertEqual(_trip_route_with_package("", "TP1"), "")
		self.assertEqual(_trip_route_with_package("/x/", None), "/x/")
