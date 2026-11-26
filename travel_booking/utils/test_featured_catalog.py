# Copyright (c) 2026, WargaPrihatan and Contributors
# See license.txt

"""Unit tests untuk Fasa 5A — featured_catalog (highlight homepage).

Hermetik: mock trip_catalog.get_catalog_trips + frappe.db supaya
semantik susunan featured & pembinaan kad pakej diuji dalam FUNGSI
sebenar tanpa data DB.
"""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.utils import featured_catalog


def _trip(name, featured=False):
	return frappe._dict({
		"name": name, "trip_name": name,
		"featured_trip": 1 if featured else 0,
	})


class FeaturedTripsOrderingTestCase(UnitTestCase):
	"""get_featured_trips — trip berbendera DIUTAMAKAN, baki mengikut
	susunan katalog (tarikh); jumlah di-cap limit."""

	def _featured(self, trips, limit=6):
		# get_featured_trips return (list, catalog_data) — buka tuple.
		data = {"trips": trips, "trip_group_dates": {},
		        "company_currency": "MYR", "company_symbol": "RM"}
		with patch.object(featured_catalog, "get_catalog_trips",
		                  return_value=data):
			out, _data = featured_catalog.get_featured_trips(
				"cruise", limit=limit)
			return out

	def test_flagged_first_then_others(self):
		trips = [_trip("A"), _trip("B", featured=True), _trip("C"),
		         _trip("D", featured=True)]
		out = self._featured(trips)
		self.assertEqual([t["name"] for t in out], ["B", "D", "A", "C"])

	def test_limit_respected(self):
		trips = [_trip("T%d" % i) for i in range(10)]
		out = self._featured(trips, limit=6)
		self.assertEqual(len(out), 6)

	def test_flagged_beyond_limit_kept_first(self):
		# 4 berbendera + 10 biasa, limit 6 → 4 berbendera + 2 teratas.
		trips = ([_trip("F%d" % i, featured=True) for i in range(4)]
		         + [_trip("O%d" % i) for i in range(10)])
		out = self._featured(trips, limit=6)
		self.assertEqual([t["name"] for t in out[:4]],
		                 ["F0", "F1", "F2", "F3"])
		self.assertEqual(len(out), 6)

	def test_no_flags_falls_back_to_top(self):
		trips = [_trip("A"), _trip("B"), _trip("C")]
		out = self._featured(trips)
		self.assertEqual([t["name"] for t in out], ["A", "B", "C"])


class FeaturedPackagesBuildTestCase(UnitTestCase):
	"""get_featured_packages — kad pakej dibina daripada row berbendera
	yang trip-nya ada group date ready; currency menapis.

	db.sql dipanggil DUA kali dalam fungsi: (1) query rows pakej
	berbendera (FROM `tabTrip Package`, as_dict), (2) harga termurah
	(SELECT MIN(...)). Mock bezakan melalui kandungan query.
	"""

	def _run(self, row_list, gds_by_trip, currency=None,
	         pkg_currency="MYR"):
		for r in row_list:
			r.currency = pkg_currency
		data = {
			"trips": [], "trip_group_dates": gds_by_trip,
			"trip_packages": [], "company_currency": currency or "MYR",
			"company_symbol": "RM",
		}
		def _sql(q, *a, **kw):
			if "FROM `tabTrip Package`" in q:
				return row_list
			if "MIN" in q:
				return [[1200.0]]
			return []
		with patch.object(frappe.db, "sql", side_effect=_sql), \
		     patch.object(featured_catalog, "get_catalog_trips",
		                  return_value=data):
			return featured_catalog.get_featured_packages(
				"cruise", currency=currency)

	def _row(self, pkg="TP1", trip="TRIP1"):
		return frappe._dict({
			"trip_package": pkg, "package_title": "Pkg " + pkg,
			"package_type": "Cruise + Flight", "currency": "MYR",
			"trip_link": trip, "trip_name": "Trip One",
			"is_a_cruise_trip": 1, "route": "trip-one", "trip_image": "",
		})

	def _gds(self, label="Dec 2026 Sailing"):
		return {"TRIP1": [frappe._dict({
			"name": "RTRC1", "trip_group_name": label,
			"departure_date": "2026-12-10", "return_date": "2026-12-15"})]}

	def test_package_with_ready_gds_included(self):
		out = self._run([self._row()], self._gds(), currency="MYR")
		self.assertEqual(len(out["packages"]), 1)
		p = out["packages"][0]
		self.assertEqual(p["trip_package"], "TP1")
		self.assertEqual(p["from_price"], 1200.0)
		self.assertEqual(p["group_dates"][0]["label"], "Dec 2026 Sailing")
		# Route mock ialah "trip-one" (route Trip published sebenar cth
		# "trip2622") — helper hanya prepend "/" + append param.
		self.assertEqual(p["trip_route"], "/trip-one?trip_package=TP1")

	def test_package_without_ready_gds_skipped(self):
		out = self._run([self._row()], {}, currency="MYR")
		self.assertEqual(out["packages"], [])

	def test_currency_mismatch_filtered(self):
		# Row package SGD diminta MYR → tersaring keluar.
		out = self._run([self._row()], self._gds(),
		                currency="MYR", pkg_currency="SGD")
		self.assertEqual(out["packages"], [])

	def test_multiple_packages_same_gds(self):
		# Dua pakej share group date sama → dua kad berasingan.
		out = self._run(
			[self._row("TP1"), self._row("TP2", trip="TRIP1")],
			self._gds(), currency="MYR")
		self.assertEqual(len(out["packages"]), 2)
		self.assertEqual({p["trip_package"] for p in out["packages"]},
		                 {"TP1", "TP2"})
