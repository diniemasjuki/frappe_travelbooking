# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk logik scoping addon (addon_manager._scoping_is_applicable).

Hermetik — logik tulen dengan data scoping sintetik (frappe._dict).
Semantik row scoping:
- row trip_package → hanya booking dengan package sama
- row group_date  → hanya booking dengan group date sama
- row trip SAHAJA → SEMUA booking bagi trip tersebut (bug lama: tak pernah
  padan kerana syarat "booking tanpa package & date")
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.addon_manager import _scoping_is_applicable


def _row(trip=None, group_date=None, trip_package=None):
	return frappe._dict({"trip": trip, "group_date": group_date, "trip_package": trip_package})


class AddonScopingTestCase(UnitTestCase):
	def test_all_trips_always_applicable(self):
		self.assertTrue(_scoping_is_applicable("All Trips", [], "TP260813", "RTRC2603", "TRIP2620"))
		self.assertTrue(_scoping_is_applicable(None, [], "TP260813", "RTRC2603", "TRIP2620"))  # legacy

	def test_trip_only_scoping_matches_booking_of_that_trip(self):
		# Kes bug utama: scoping "trip sahaja" mesti padan booking trip itu.
		scopings = [_row(trip="TRIP2620")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC2603", "TRIP2620"))

	def test_trip_only_scoping_blocked_for_other_trip(self):
		scopings = [_row(trip="TRIP2618")]
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC2603", "TRIP2620"))

	def test_group_date_scoping(self):
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", [_row(group_date="RTRC2603")], "TP260813", "RTRC2603", "TRIP2620")
		)
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", [_row(group_date="RTRC9999")], "TP260813", "RTRC2603", "TRIP2620")
		)

	def test_package_scoping(self):
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", [_row(trip_package="TP260813")], "TP260813", "RTRC2603", "TRIP2620")
		)
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", [_row(trip_package="TP999999")], "TP260813", "RTRC2603", "TRIP2620")
		)

	def test_row_with_trip_plus_group_date_stays_specific(self):
		# Row trip + group_date = "tarikh spesifik trip itu" — JANGAN padan
		# booking lain dalam trip sama (elak terlalu longgar).
		scopings = [_row(trip="TRIP2620", group_date="RTRC9999")]
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC2603", "TRIP2620"))

	def test_any_matching_row_wins(self):
		scopings = [_row(trip="TRIP2618"), _row(trip="TRIP2620")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC2603", "TRIP2620"))

	def test_no_context_legacy_fallback(self):
		# Booking tanpa konteks langsung — row trip dianggap padanan (legacy).
		scopings = [_row(trip="TRIP2618")]
		self.assertTrue(_scoping_is_applicable("Specific Trips Only", scopings, None, None, None))

	def test_no_scoping_rows_not_applicable(self):
		self.assertFalse(_scoping_is_applicable("Specific Trips Only", [], "TP260813", "RTRC2603", "TRIP2620"))

	# ── Peraturan tambahan (2026-09-05): row trip + package TANPA group
	# date → addon sah untuk package tertentu PADA TRIP tersebut sahaja,
	# merangkumi SEMUA tarikh group date yang package itu sah. ──

	def test_trip_plus_package_row_matches_any_date_of_that_package(self):
		# Booking pada package sama, tarikh BERBEZA (RTRC9999) → masih sah.
		scopings = [_row(trip="TRIP2620", trip_package="TP260813")]
		self.assertTrue(
			_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC9999", "TRIP2620")
		)

	def test_trip_plus_package_row_blocked_for_other_package(self):
		scopings = [_row(trip="TRIP2620", trip_package="TP260813")]
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", scopings, "TP999999", "RTRC2603", "TRIP2620")
		)

	def test_trip_plus_package_row_requires_same_trip(self):
		# Guard data tak konsisten: row kata trip 2618 tapi package milik
		# trip 2620 — booking trip 2620 TAK patut padan.
		scopings = [_row(trip="TRIP2618", trip_package="TP260813")]
		self.assertFalse(
			_scoping_is_applicable("Specific Trips Only", scopings, "TP260813", "RTRC2603", "TRIP2620")
		)
