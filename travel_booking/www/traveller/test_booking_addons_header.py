# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk medan terbitan header page booking_addons
(www/traveller/booking_addons.py::_header_derived_fields).

Fungsi tulen (dict masuk → dict keluar) — hermetik tanpa data DB.
"""

from datetime import date

from frappe.tests import UnitTestCase

from travel_booking.www.traveller.booking_addons import _header_derived_fields


def _cruise_only():
	return {
		"trip_is_cruise": 1,
		"package_type": "Cruise Only",
		"airport_name": None,
		"sailing_start": date(2026, 10, 3),
		"sailing_end": date(2026, 10, 10),
		"embark_port_name": "Sharm El Sheikh",
		"disembark_port_name": "Istanbul",
		"departure_date": date(2026, 10, 3),
		"return_date": date(2026, 10, 10),
	}


class HeaderDerivedFieldsTestCase(UnitTestCase):
	def test_cruise_only_hides_departure(self):
		# Pakej cruise-only: tiada penerbangan — tarikh departure
		# menduplikasi tarikh pelayaran → seksyen disembunyikan.
		out = _header_derived_fields(_cruise_only())
		self.assertEqual(out["sailing_range"], "03 – 10 Oct 2026")
		self.assertEqual(out["route_display"], "Sharm El Sheikh → Istanbul")
		self.assertEqual(out["departure_display"], "")

	def test_fly_cruise_shows_departure_with_airport(self):
		raw = _cruise_only()
		raw["package_type"] = "Fly Cruise"
		raw["airport_name"] = "Kuala Lumpur International Airport"
		raw["departure_date"] = date(2026, 10, 2)
		out = _header_derived_fields(raw)
		self.assertEqual(
			out["departure_display"],
			"02 Oct 2026 → 10 Oct 2026 · Kuala Lumpur International Airport",
		)

	def test_same_port_round_trip(self):
		raw = _cruise_only()
		raw["disembark_port_name"] = "Sharm El Sheikh"
		out = _header_derived_fields(raw)
		self.assertEqual(out["route_display"], "Sharm El Sheikh (round trip)")

	def test_cross_month_range(self):
		raw = _cruise_only()
		raw["sailing_end"] = date(2026, 11, 2)
		out = _header_derived_fields(raw)
		self.assertEqual(out["sailing_range"], "03 Oct – 02 Nov 2026")

	def test_cross_year_range(self):
		raw = _cruise_only()
		raw["sailing_end"] = date(2027, 1, 5)
		out = _header_derived_fields(raw)
		self.assertEqual(out["sailing_range"], "03 Oct 2026 – 05 Jan 2027")

	def test_non_cruise_tour_shows_date_range_without_airport(self):
		raw = {
			"trip_is_cruise": 0,
			"package_type": "Ground Only",
			"airport_name": None,
			"departure_date": date(2026, 12, 1),
			"return_date": date(2026, 12, 8),
		}
		out = _header_derived_fields(raw)
		self.assertEqual(out["departure_display"], "01 Dec 2026 → 08 Dec 2026")
		self.assertNotIn("sailing_range", out)
