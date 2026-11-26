# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk logik scoping addon (addon_manager._scoping_is_applicable).

Hermetik — logik tulen dengan data scoping sintetik (frappe._dict).
RECONDITION Nov 2026 — keterkaitan scoping kini Package Offer / Travel Date
(dahulu Trip Package / Trip Group Date).

Semantik row scoping:
- row package_offer → hanya booking dengan offer sama
- row travel_date  → hanya booking dengan travel date sama
- row trip SAHAJA  → SEMUA booking bagi trip tersebut
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.addon_manager import _scoping_is_applicable


def _row(trip=None, travel_date=None, package_offer=None):
	return frappe._dict({"trip": trip, "travel_date": travel_date, "package_offer": package_offer})


class AddonScopingTestCase(UnitTestCase):
	def test_all_trips_always_applicable(self):
		self.assertTrue(_scoping_is_applicable("All Trips", [], "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))
		self.assertTrue(_scoping_is_applicable(None, [], "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	def test_trip_only_scoping_matches_booking_of_that_trip(self):
		# Scoping "trip sahaja" mesti padan booking trip itu.
		scopings = [_row(trip="TRIP2620")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	def test_trip_only_scoping_blocked_for_other_trip(self):
		scopings = [_row(trip="TRIP2618")]
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	def test_travel_date_scoping(self):
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", [_row(travel_date="TD-2026-0006")], "OFF-2026-0069", "TD-2026-0006", "TRIP2620")
		)
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", [_row(travel_date="TD-2099-9999")], "OFF-2026-0069", "TD-2026-0006", "TRIP2620")
		)

	def test_package_offer_scoping(self):
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", [_row(package_offer="OFF-2026-0069")], "OFF-2026-0069", "TD-2026-0006", "TRIP2620")
		)
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", [_row(package_offer="OFF-2099-9999")], "OFF-2026-0069", "TD-2026-0006", "TRIP2620")
		)

	def test_row_with_trip_plus_travel_date_stays_specific(self):
		# Row trip + travel_date = "tarikh spesifik trip itu" — JANGAN padan
		# booking lain dalam trip sama (elak terlalu longgar).
		scopings = [_row(trip="TRIP2620", travel_date="TD-2099-9999")]
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	def test_any_matching_row_wins(self):
		scopings = [_row(trip="TRIP2618"), _row(trip="TRIP2620")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	def test_no_context_legacy_fallback(self):
		# Booking tanpa konteks langsung — row trip dianggap padanan (legacy).
		scopings = [_row(trip="TRIP2618")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, None, None, None))

	def test_no_scoping_rows_not_applicable(self):
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", [], "OFF-2026-0069", "TD-2026-0006", "TRIP2620"))

	# ── Row trip + offer TANPA travel date → addon sah untuk offer
	# tertentu PADA TRIP tersebut sahaja, merangkumi SEMUA tarikh yang
	# offer itu sah. ──

	def test_trip_plus_offer_row_matches_any_date_of_that_offer(self):
		# Booking pada offer sama, tarikh BERBEZA (TD-2099-9999) → masih sah.
		scopings = [_row(trip="TRIP2620", package_offer="OFF-2026-0069")]
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2099-9999", "TRIP2620")
		)

	def test_trip_plus_offer_row_blocked_for_other_offer(self):
		scopings = [_row(trip="TRIP2620", package_offer="OFF-2026-0069")]
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2099-9999", "TD-2026-0006", "TRIP2620")
		)

	def test_trip_plus_offer_row_requires_same_trip(self):
		# Guard data tak konsisten: row kata trip 2618 tapi offer milik
		# trip 2620 — booking trip 2620 TAK patut padan.
		scopings = [_row(trip="TRIP2618", package_offer="OFF-2026-0069")]
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", scopings, "OFF-2026-0069", "TD-2026-0006", "TRIP2620")
		)
