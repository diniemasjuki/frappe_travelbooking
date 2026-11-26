# Copyright (c) 2026, WargaPrihatan and Contributors
# See license.txt

"""Unit tests untuk Fasa 4 — registry bilik (cabin_registry) dan
Booking Amendment.

Hermetik: logik tulen + mock frappe.db; semantik padanan kategori,
pengiraan kadar pax, dan snapshot diuji dalam FUNGSI sebenar.
"""

import json

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.api import cabin_registry
from travel_booking.api.booking_amendment_api import _rate_for_pax
from travel_booking.module_travel_booking.doctype.booking_amendment.booking_amendment import (
	BookingAmendment,
)


def _price(adult=100, single=150, upper=80, child=60, infant=10):
	return frappe._dict({
		"price_adult": adult, "price_adult_single": single,
		"price_upperberth": upper, "price_children": child,
		"price_infant": infant,
	})


class CategoryResolutionTestCase(UnitTestCase):
	"""_resolve_category — padanan longgar manifest Aroya → kategori
	schedule cabin_rates."""

	CATS = ["Interior Cabin", "Seaview Cabin", "Balcony Cabin",
	        "Deluxe Suite (Khuzama)"]

	def test_exact_loose_match(self):
		self.assertEqual(
			cabin_registry._resolve_category("balcony cabin", self.CATS),
			"Balcony Cabin")

	def test_substring_both_ways(self):
		# "Seaview" ⊂ "Seaview Cabin"
		self.assertEqual(
			cabin_registry._resolve_category("Seaview", self.CATS),
			"Seaview Cabin")
		# "Deluxe Suite (Khuzama) Cabin" ⊃ "Deluxe Suite (Khuzama)"
		self.assertEqual(
			cabin_registry._resolve_category("Deluxe Suite (Khuzama) Cabin", self.CATS),
			"Deluxe Suite (Khuzama)")

	def test_no_match_falls_back_to_first(self):
		# Tanpa padanan → kategori pertama (lebih baik daripada hilang bilik)
		self.assertEqual(
			cabin_registry._resolve_category("Presidential Penthouse", self.CATS),
			"Interior Cabin")

	def test_empty_manifest_category(self):
		self.assertEqual(
			cabin_registry._resolve_category("", self.CATS), "Interior Cabin")
		self.assertIsNone(cabin_registry._resolve_category("x", []))


class RegistryOverviewTestCase(UnitTestCase):
	"""get_registry_overview — registry_count mesti dijumlahkan per
	kategori dan entry kategori-tanpa-rate dicipta."""

	def _overview(self, registry, rates):
		def _get_all(doctype, filters=None, fields=None, **kw):
			if doctype == "Cruise Cabin":
				return registry
			if doctype == "Trip Package Price":
				return rates
			return []
		with patch.object(frappe, "get_all", side_effect=_get_all), \
		     patch.object(frappe.db, "get_all", side_effect=_get_all):
			return cabin_registry.get_registry_overview("TCS-X")

	def test_counts_by_category(self):
		registry = [
			frappe._dict({"room_category": "Interior Cabin", "status": "Assigned"}),
			frappe._dict({"room_category": "Interior Cabin", "status": "Available"}),
			frappe._dict({"room_category": "Balcony Cabin", "status": "Assigned"}),
		]
		rates = [
			frappe._dict({"pricing_for_class": "Interior Cabin",
			              "cabin_allotment": 40, "cabin_occupancy": 35,
			              "cabin_available": 5}),
			frappe._dict({"pricing_for_class": "Balcony Cabin",
			              "cabin_allotment": 20, "cabin_occupancy": 20,
			              "cabin_available": 0}),
		]
		out = self._overview(registry, rates)
		cats = {c["room_category"]: c for c in out["categories"]}
		self.assertEqual(out["registry_total"], 3)
		self.assertEqual(cats["Interior Cabin"]["registry_count"], 2)
		self.assertEqual(cats["Interior Cabin"]["registry_assigned"], 1)
		self.assertEqual(cats["Balcony Cabin"]["registry_assigned"], 1)
		self.assertEqual(cats["Interior Cabin"]["allotment"], 40)

	def test_registry_category_without_rate_included(self):
		registry = [frappe._dict({"room_category": "Suite X", "status": "Available"})]
		out = self._overview(registry, [])
		self.assertEqual(len(out["categories"]), 1)
		self.assertEqual(out["categories"][0]["allotment"], 0)


class AmendmentRateMappingTestCase(UnitTestCase):
	"""_rate_for_pax — model slot (cruise) vs umur (non-cruise)."""

	def test_cruise_slot_model(self):
		p = _price()
		self.assertEqual(_rate_for_pax(p, "Main Guest", True), 100)
		self.assertEqual(_rate_for_pax(p, "Main Guest (Single)", True), 150)
		self.assertEqual(_rate_for_pax(p, "Extra Bed", True), 80)
		self.assertEqual(_rate_for_pax(p, "Infant", True), 10)

	def test_tour_age_model(self):
		p = _price()
		self.assertEqual(_rate_for_pax(p, "Adult", False), 100)
		self.assertEqual(_rate_for_pax(p, "Children", False), 60)
		self.assertEqual(_rate_for_pax(p, "Infant", False), 10)


class AmendmentSnapshotTestCase(UnitTestCase):
	"""autofill_before_snapshot — struktur JSON yang dibekalkan."""

	def test_snapshot_shape(self):
		# Document(d) dengan dict termasuk "doctype" — bukan Document(dict)
		# sahaja (constructor perlu doctype string).
		am = BookingAmendment({
			"doctype": "Booking Amendment", "booking": "BK-TEST"})

		fake_booking = frappe._dict({
			"trip_date": "TGD-1", "trip_package": "TP-1",
			"booked_pax": 2, "status": "Processing",
			"payment_status": "Partially Paid",
			"total_amount": 1200.0, "balance_amount": 600.0,
		})
		def fake_get_all(doctype, filters=None, fields=None, **kw):
			if doctype == "Booking Reservation":
				return [frappe._dict({
					"name": "R1", "room_category": "Balcony",
					"cabin_no": 1, "pax_type": "Main Guest",
					"stateroom_no": "11252", "status": "Confirmed"})]
			return []
		with patch.object(frappe.db, "get_all", side_effect=fake_get_all), \
		     patch.object(frappe, "get_all", side_effect=fake_get_all), \
		     patch.object(frappe, "get_doc", return_value=fake_booking):
			am.autofill_before_snapshot()

		snap = json.loads(am.before_snapshot)
		self.assertEqual(snap["trip_date"], "TGD-1")
		self.assertEqual(snap["total_amount"], 1200.0)
		# paid = total − balance
		self.assertEqual(snap["paid_amount"], 600.0)
		self.assertEqual(len(snap["reservations"]), 1)
		self.assertEqual(snap["reservations"][0]["stateroom_no"], "11252")
