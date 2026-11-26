# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk resolver itinerary efektif (utils/itinerary_resolver.py)
— model "reuse + checkbox overwrite":

- Trip = template asal (fallback sentiasa);
- baris sendiri + overwrite_itinerary=1 → override aras itu;
- checkbox tanpa baris / baris tanpa checkbox → waris aras atas;
- offer mewarisi TD *efektif* (bukan terus Trip).

Hermetik — data sintetik (frappe._dict + fake frappe.get_all /
frappe.db.get_value / frappe.db.get_values), tiada fixture DB diperlukan
(corak test_currency_axis)."""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.utils import itinerary_resolver as ir


def _row(day, title=None, dp="", meals="", desc=""):
	return frappe._dict({
		"day": day,
		"day_title": title or f"Hari {day}",
		"destination_point": dp,
		"meals": meals,
		"day_image": "",
		"description": desc,
	})


class ItineraryResolverTestCase(UnitTestCase):

	def setUp(self):
		# (parenttype, parent) -> baris own (susunan idx seperti tersimpan).
		self.own: dict = {}
		# (doctype, name) -> nilai overwrite_itinerary.
		self.flags: dict = {}
		# name -> baris Trip Destination Point.
		self.dps: dict = {}

		def fake_get_all(doctype, filters=None, fields=None, order_by=None, **kw):
			self.assertEqual(doctype, "Trip Itinerary")
			return list(self.own.get((filters["parenttype"], filters["parent"]), []))

		def fake_get_value(doctype, name, fieldname=None, *a, **kw):
			return self.flags.get((doctype, name), 0)

		def fake_get_values(doctype, names=None, fields=None, as_dict=False, **kw):
			return [self.dps[n] for n in names if n in self.dps]

		for obj, attr, fake in (
			(frappe, "get_all", fake_get_all),
			(frappe.db, "get_value", fake_get_value),
			(frappe.db, "get_values", fake_get_values),
		):
			patcher = patch.object(obj, attr, fake)
			patcher.start()
			self.addCleanup(patcher.stop)

	def set_own(self, parenttype, parent, rows):
		self.own[(parenttype, parent)] = list(rows)

	# ── Rantaian warisan ──────────────────────────────────────────

	def test_trip_template_only(self):
		self.set_own("Trip", "T1", [_row(1), _row(2)])
		out = ir.get_effective_itinerary("T1")
		self.assertEqual(out["source"], "trip")
		self.assertEqual([r["day"] for r in out["rows"]], [1, 2])

	def test_travel_date_overrides_trip(self):
		self.set_own("Trip", "T1", [_row(1), _row(2)])
		self.set_own("Travel Date", "TD1", [_row(1, title="Pulang lambat")])
		self.flags[("Travel Date", "TD1")] = 1
		out = ir.get_effective_itinerary("T1", travel_date="TD1")
		self.assertEqual(out["source"], "travel_date")
		self.assertEqual(len(out["rows"]), 1)
		self.assertEqual(out["rows"][0]["day_title"], "Pulang lambat")

	def test_checkbox_without_rows_falls_back(self):
		# Checkbox ditanda tetapi table kosong → waris senyap.
		self.set_own("Trip", "T1", [_row(1), _row(2)])
		self.set_own("Travel Date", "TD1", [])
		self.flags[("Travel Date", "TD1")] = 1
		out = ir.get_effective_itinerary("T1", travel_date="TD1")
		self.assertEqual(out["source"], "trip")

	def test_rows_without_checkbox_falls_back(self):
		# Baris disimpan (draf) tetapi checkbox tidak ditanda → waris.
		self.set_own("Trip", "T1", [_row(1)])
		self.set_own("Travel Date", "TD1", [_row(1), _row(2), _row(3)])
		self.flags[("Travel Date", "TD1")] = 0
		out = ir.get_effective_itinerary("T1", travel_date="TD1")
		self.assertEqual(out["source"], "trip")

	def test_offer_overrides_travel_date(self):
		self.set_own("Trip", "T1", [_row(1)])
		self.set_own("Travel Date", "TD1", [_row(1), _row(2)])
		self.flags[("Travel Date", "TD1")] = 1
		self.set_own("Package Offer", "OFF1",
					 [_row(1, title="Flight + Hotel")])
		self.flags[("Package Offer", "OFF1")] = 1
		out = ir.get_effective_itinerary("T1", travel_date="TD1", offer="OFF1")
		self.assertEqual(out["source"], "package_offer")
		self.assertEqual(out["rows"][0]["day_title"], "Flight + Hotel")

	def test_offer_inherits_td_effective(self):
		# Offer tanpa override → warisi TD *efektif* (TD overwrite,
		# bukan template Trip).
		self.set_own("Trip", "T1", [_row(1), _row(2)])
		self.set_own("Travel Date", "TD1", [_row(1), _row(2), _row(3)])
		self.flags[("Travel Date", "TD1")] = 1
		self.set_own("Package Offer", "OFF1", [])
		self.flags[("Package Offer", "OFF1")] = 0
		out = ir.get_effective_itinerary("T1", travel_date="TD1", offer="OFF1")
		self.assertEqual(out["source"], "travel_date")
		self.assertEqual([r["day"] for r in out["rows"]], [1, 2, 3])

	def test_empty_everything(self):
		out = ir.get_effective_itinerary("T1")
		self.assertEqual(out["source"], "trip")
		self.assertEqual(out["rows"], [])

	# ── Normalisasi & enrich ─────────────────────────────────────

	def test_rows_sorted_by_day(self):
		# idx tersimpan tak semestinya ikut day — output mesti ikut day.
		self.set_own("Trip", "T1", [_row(3), _row(1), _row(2)])
		out = ir.get_effective_itinerary("T1")
		self.assertEqual([r["day"] for r in out["rows"]], [1, 2, 3])

	def test_enrich_destination_points(self):
		self.dps["DP1"] = frappe._dict(
			name="DP1", destination_name="Phuket", destination_country="Thailand")
		rows = [
			ir.normalize_itinerary_row(_row(1, dp="DP1")),
			ir.normalize_itinerary_row(_row(2, dp="UNKNOWN")),
		]
		ir.enrich_itinerary_rows(rows)
		self.assertEqual(rows[0]["destination_name"], "Phuket")
		self.assertEqual(rows[0]["country"], "Thailand")
		# DP tidak wujud → fallback ke nama Link, negara kosong.
		self.assertEqual(rows[1]["destination_name"], "UNKNOWN")
		self.assertEqual(rows[1]["country"], "")

	# ── Payload editor admin ─────────────────────────────────────

	def test_payload_composition_offer_level(self):
		self.set_own("Trip", "T1", [_row(1)])
		self.set_own("Travel Date", "TD1", [_row(1), _row(2)])
		self.flags[("Travel Date", "TD1")] = 1
		self.set_own("Package Offer", "OFF1", [_row(1, title="Pakej VIP")])
		self.flags[("Package Offer", "OFF1")] = 1
		self.dps["DP1"] = frappe._dict(
			name="DP1", destination_name="Phuket", destination_country="Thailand")

		out = ir.get_itinerary_payload("T1", travel_date="TD1", offer="OFF1")
		# Own = baris offer sahaja; flag offer dibaca aras offer.
		self.assertEqual(len(out["own_itinerary"]), 1)
		self.assertEqual(out["own_itinerary"][0]["day_title"], "Pakej VIP")
		self.assertEqual(out["overwrite_itinerary"], 1)
		# Efektif = offer (overwrite aktif), enriched.
		self.assertEqual(out["itinerary_source"], "package_offer")
		self.assertEqual(out["effective_itinerary"][0]["day_title"], "Pakej VIP")

	def test_payload_composition_travel_date_level(self):
		self.set_own("Trip", "T1", [_row(1), _row(2)])
		self.set_own("Travel Date", "TD1", [])
		self.flags[("Travel Date", "TD1")] = 0
		out = ir.get_itinerary_payload("T1", travel_date="TD1")
		self.assertEqual(out["own_itinerary"], [])
		self.assertEqual(out["overwrite_itinerary"], 0)
		# Tiada override → efektif = template Trip.
		self.assertEqual(out["itinerary_source"], "trip")
		self.assertEqual(len(out["effective_itinerary"]), 2)
