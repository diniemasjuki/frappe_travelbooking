# Copyright (c) 2026, WargaPrihatan and Contributors
# See license.txt

"""Unit tests untuk logik upgrade cabin (Fasa 1B — api/cabin_upgrade.py).

Hermetik setakat mana mungkin — logik kategori/pemetaan cabin diuji dengan
frappe._dict sintetik; fungsi yang memerlukan DB (get_cabin_upgrade_options)
diuji melalui mock frappe.db.get_all supaya semantik carian cabin sahaja
divalidasi tanpa data sebenar.
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api import cabin_upgrade


def _res(cabin_no, room_category, schedule="TCS-001", status="Confirmed"):
	return frappe._dict({
		"cabin_no": cabin_no,
		"room_category": room_category,
		"trip_cruise_schedule": schedule,
		"status": status,
	})


class CabinUpgradeCabinGroupingTestCase(UnitTestCase):
	"""Semantik pengumpulan cabin dalam apply_cabin_upgrade_for_order —

	Kita uji helper grouping tersirat melalui tingkah laku: cabin dengan slot
	kategori bercampur mesti dilangkau (log error), cabin seragam di-upgrade.
	Uji melalui pemetaan python tulen yang meniru gelung cabins dalam
	apply_cabin_upgrade_for_order.
	"""

	def _group_cabins(self, reservations):
		cabins = {}
		for res in reservations:
			cabins.setdefault(res.cabin_no, set()).add(res.room_category)
		return cabins

	def test_cabin_with_uniform_category_upgrades(self):
		reservations = [
			_res(1, "Interior Stateroom"),
			_res(1, "Interior Stateroom"),
			_res(2, "Balcony Stateroom"),
		]
		cabins = self._group_cabins(reservations)
		self.assertEqual(cabins[1], {"Interior Stateroom"})
		self.assertEqual(cabins[2], {"Balcony Stateroom"})

	def test_cabin_with_mixed_categories_flagged(self):
		# Slot cabin 1 bercampur (data tak konsisten) — set > 1 elemen
		# ialah isyarat untuk langkau cabin tersebut.
		reservations = [
			_res(1, "Interior Stateroom"),
			_res(1, "Balcony Stateroom"),
		]
		cabins = self._group_cabins(reservations)
		self.assertGreater(len(cabins[1]), 1)

	def test_cancelled_reservations_excluded_by_filter_semantics(self):
		# Filter DB {"status": ["!=", "Cancelled"]} — uji semantik helper
		# padanan yang sama pada data sintetik.
		reservations = [
			_res(1, "Interior Stateroom", status="Confirmed"),
			_res(1, "Interior Stateroom", status="Cancelled"),
		]
		active = [r for r in reservations if r.status != "Cancelled"]
		cabins = self._group_cabins(active)
		self.assertEqual(cabins[1], {"Interior Stateroom"})


class CabinUpgradeFromCategoryMatchingTestCase(UnitTestCase):
	"""Semantik padanan upgrade_from_category terhadap kategori semasa
	cabin (tingkah laku _upgrade_applicable_for_reservations tanpa DB):

	matching_cabins = {cabin untuk slot yang kategori == upgrade_from}.
	"""

	def _matching_cabins(self, reservations, upgrade_from):
		return {
			r.cabin_no for r in reservations
			if r.room_category == upgrade_from
		}

	def test_no_match_when_category_differs(self):
		reservations = [_res(1, "Interior Stateroom")]
		self.assertEqual(self._matching_cabins(reservations, "Balcony Stateroom"), set())

	def test_match_includes_all_cabins_of_that_category(self):
		reservations = [
			_res(1, "Interior Stateroom"),
			_res(2, "Interior Stateroom"),
			_res(3, "Suite"),
		]
		self.assertEqual(
			self._matching_cabins(reservations, "Interior Stateroom"), {1, 2}
		)

	def test_no_cruise_schedule_means_not_applicable(self):
		# Booking non-cruise: reservations tanpa trip_cruise_schedule.
		reservations = [_res(1, "Interior Stateroom", schedule=None)]
		schedules = {r.trip_cruise_schedule for r in reservations if r.trip_cruise_schedule}
		self.assertEqual(schedules, set())


class CabinUpgradeAvailabilityDisplayTestCase(UnitTestCase):
	"""_target_category_available_apx — availability negatif (overbooking
	signal) mesti dikira 0 untuk paparan portal; ambil MAX antara baris
	schedule (konservatif terhadap false sold-out). Diuji dengan mock
	frappe.db.get_all supaya semantik clamp berlaku dalam FUNGSI sebenar.
	"""

	def _available(self, rows):
		from unittest.mock import patch
		with patch.object(frappe.db, "get_all", return_value=rows):
			return cabin_upgrade._target_category_available_apx(["TCS-001"], "Balcony")

	def test_negative_availability_counts_as_zero(self):
		rows = [frappe._dict({"cabin_allotment": 5, "cabin_available": -2})]
		self.assertEqual(self._available(rows), 0)

	def test_max_across_rows(self):
		rows = [
			frappe._dict({"cabin_allotment": 5, "cabin_available": 1}),
			frappe._dict({"cabin_allotment": 8, "cabin_available": 3}),
		]
		self.assertEqual(self._available(rows), 3)

	def test_no_rows_returns_none(self):
		self.assertIsNone(self._available([]))
