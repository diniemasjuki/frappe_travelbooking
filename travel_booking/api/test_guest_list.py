# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk itemized guests (Stage 1 wizard — compile-to-aggregate).

Hermetik — logik tulen dengan selection sintetik (dict biasa), selari
corak test_addon_scoping. Dua lapisan diuji:

1. _validate_guest_list (pricing.py) — konsistensi medan additive 'guests'
   dengan kaunter agregat. Payload tanpa 'guests' (klien lama) mesti lalus.
2. _guest_categories + _build_item_specs (so_helpers.py) — pemetaan
   kategori umur ke spec per-traveller (age_category) TANPA mengubah
   pax_type/rate_basis/harga (model slot/umur kekal).
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.pricing import _validate_guest_list
from travel_booking.api.so_helpers import _build_item_specs, _guest_categories


def _price(**kw):
	"""Baris harga sintetik — cermin Trip Package Price slot columns."""
	defaults = {
		"price_adult_single": 3000.0,
		"price_adult":        2000.0,
		"price_upperberth":   1200.0,
		"price_children":      800.0,
		"price_infant":         50.0,
	}
	defaults.update(kw)
	return frappe._dict(defaults)


class ValidateGuestListTestCase(UnitTestCase):
	# ── Backward compatibility ────────────────────────────────────────────

	def test_no_guests_field_passes(self):
		# Klien lama (stepper kaunter) — tiada 'guests', terus sah.
		sel = {"room_category": "BALCONY", "main_guests": 2, "extra_beds": 1, "infants": 1}
		_validate_guest_list([sel], is_cruise=True)
		_validate_guest_list([sel], is_cruise=False)

	def test_empty_guests_list_passes(self):
		sel = {"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0,
			   "infants": 0, "guests": []}
		_validate_guest_list([sel], is_cruise=True)

	# ── Cruise (model SLOT) ───────────────────────────────────────────────

	def test_cruise_consistent_list_passes(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 2, "extra_beds": 1, "infants": 1,
			"guests": [
				{"slot": "main", "category": "adult"},
				{"slot": "main", "category": "child"},
				{"slot": "extra_bed", "category": "adult"},
				{"slot": "infant", "category": "infant"},
			],
		}
		_validate_guest_list([sel], is_cruise=True)

	def test_cruise_length_mismatch_throws(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 2, "extra_beds": 0, "infants": 0,
			"guests": [{"slot": "main", "category": "adult"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_cruise_slot_counts_mismatch_throws(self):
		# 2 baris guests tapi slot main=1 / extra_bed=1 ≠ kaunter 2/0.
		sel = {
			"room_category": "BALCONY", "main_guests": 2, "extra_beds": 0, "infants": 0,
			"guests": [
				{"slot": "main", "category": "adult"},
				{"slot": "extra_bed", "category": "adult"},
			],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_cruise_missing_slot_throws(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": [{"category": "adult"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_cruise_first_guest_must_be_main(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 1, "infants": 0,
			"guests": [
				{"slot": "extra_bed", "category": "adult"},
				{"slot": "main", "category": "adult"},
			],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	# ── Non-cruise (model UMUR) ───────────────────────────────────────────

	def test_non_cruise_consistent_list_passes_without_slot(self):
		# Wizard non-cruise tak hantar slot — kategori cukup (slot diderive).
		sel = {
			"room_category": "DELUXE", "main_guests": 1, "extra_beds": 2, "infants": 1,
			"guests": [
				{"category": "adult"},
				{"category": "child"},
				{"category": "child"},
				{"category": "infant"},
			],
		}
		_validate_guest_list([sel], is_cruise=False)

	def test_non_cruise_category_counts_mismatch_throws(self):
		sel = {
			"room_category": "DELUXE", "main_guests": 1, "extra_beds": 1, "infants": 0,
			"guests": [
				{"category": "adult"},
				{"category": "adult"},
			],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], False)

	def test_non_cruise_slot_category_conflict_throws(self):
		# Slot dihantar tapi bercanggah dengan kategori (adult mesti main).
		sel = {
			"room_category": "DELUXE", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": [{"slot": "extra_bed", "category": "adult"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], False)

	def test_non_cruise_first_guest_must_be_adult(self):
		sel = {
			"room_category": "DELUXE", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": [{"category": "child"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], False)

	# ── Kategori/slot haram ───────────────────────────────────────────────

	def test_toddler_category_rejected(self):
		# price_toddler belum beroperasi — kontrak ditutup rapat.
		sel = {
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": [{"slot": "main", "category": "toddler"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_invalid_slot_rejected(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": [{"slot": "sofa", "category": "adult"}],
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_guests_not_a_list_throws(self):
		sel = {
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"guests": "adult",
		}
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [sel], True)

	def test_selection_not_a_dict_throws(self):
		# Guard bentuk payload — elemen selections mesti dict.
		self.assertRaises(frappe.ValidationError, _validate_guest_list, [["BALCONY"]], True)


class GuestCategoriesMappingTestCase(UnitTestCase):
	def test_partition_by_slot(self):
		sel = {"guests": [
			{"slot": "main", "category": "adult"},
			{"slot": "extra_bed", "category": "child"},
			{"slot": "main", "category": "child"},
			{"slot": "infant", "category": "infant"},
		]}
		main, extra, infant = _guest_categories(sel, is_cruise=True)
		# Title case — padan options Select Booking Item.age_category
		# (payload frontend lowercase, storan Title — Frappe Select menolak
		# case mismatch).
		self.assertEqual(main, ["Adult", "Child"])
		self.assertEqual(extra, ["Child"])
		self.assertEqual(infant, ["Infant"])

	def test_derived_slot_when_missing(self):
		# Non-cruise: slot kosong diderive daripada kategori.
		sel = {"guests": [{"category": "adult"}, {"category": "child"}]}
		main, extra, infant = _guest_categories(sel, is_cruise=False)
		self.assertEqual(main, ["Adult"])
		self.assertEqual(extra, ["Child"])
		self.assertEqual(infant, [])

	def test_no_guests_returns_empty(self):
		main, extra, infant = _guest_categories({"main_guests": 2}, is_cruise=True)
		self.assertEqual((main, extra, infant), ([], [], []))

	def test_storage_form_matches_select_options(self):
		# Bentuk STORAN mesti padan options Select Booking Item.age_category
		# ("Adult\nChild\nToddler\nInfant") — nilai lowercase payload akan
		# ditolak _validate_selects semasa insert Booking Item.
		sel = {"guests": [
			{"slot": "main", "category": "adult"},
			{"slot": "main", "category": "child"},
			{"slot": "extra_bed", "category": "child"},
			{"slot": "infant", "category": "infant"},
		]}
		main, extra, infant = _guest_categories(sel, is_cruise=True)
		for cat in main + extra + infant:
			self.assertIn(cat, ("Adult", "Child", "Toddler", "Infant", ""))


class BuildItemSpecsAgeCategoryTestCase(UnitTestCase):
	def _map(self):
		return {"BALCONY": _price(), "DELUXE": _price()}

	def test_cruise_solo_single_with_age_category(self):
		sel = [{
			"room_category": "BALCONY", "main_guests": 1, "extra_beds": 0, "infants": 0,
			"room_privacy": "Private",
			"guests": [{"slot": "main", "category": "adult"}],
		}]
		specs = _build_item_specs(sel, self._map(), is_cruise=True)
		self.assertEqual(len(specs), 1)
		self.assertEqual(specs[0]["pax_type"], "Main Guest")
		self.assertEqual(specs[0]["rate_basis"], "Single")
		self.assertEqual(specs[0]["unit_price"], 3000.0)
		self.assertEqual(specs[0]["age_category"], "Adult")

	def test_cruise_twin_with_child_main_berth(self):
		# Child main berth: kadar KEKAL dewasa (price_adult) — kategori
		# hanyalah metadata.
		sel = [{
			"room_category": "BALCONY", "main_guests": 2, "extra_beds": 1, "infants": 1,
			"guests": [
				{"slot": "main", "category": "adult"},
				{"slot": "main", "category": "child"},
				{"slot": "extra_bed", "category": "child"},
				{"slot": "infant", "category": "infant"},
			],
		}]
		specs = _build_item_specs(sel, self._map(), is_cruise=True)
		self.assertEqual(len(specs), 4)
		self.assertEqual([s["pax_type"] for s in specs],
			["Main Guest", "Main Guest", "Extra Bed", "Infant"])
		self.assertEqual([s["unit_price"] for s in specs],
			[2000.0, 2000.0, 1200.0, 50.0])
		self.assertEqual([s["age_category"] for s in specs],
			["Adult", "Child", "Child", "Infant"])

	def test_non_cruise_age_model(self):
		sel = [{
			"room_category": "DELUXE", "main_guests": 1, "extra_beds": 1, "infants": 0,
			"guests": [{"category": "adult"}, {"category": "child"}],
		}]
		specs = _build_item_specs(sel, self._map(), is_cruise=False)
		self.assertEqual([s["pax_type"] for s in specs], ["Adult", "Children"])
		self.assertEqual([s["unit_price"] for s in specs], [2000.0, 800.0])
		self.assertEqual([s["age_category"] for s in specs], ["Adult", "Child"])

	def test_legacy_payload_without_guests(self):
		# Klien lama: age_category kosong, pax_type/harga sepadan model lama.
		sel = [{"room_category": "BALCONY", "main_guests": 1,
				"extra_beds": 0, "infants": 0}]
		specs = _build_item_specs(sel, self._map(), is_cruise=True)
		self.assertEqual(specs[0]["age_category"], "")
		self.assertEqual(specs[0]["rate_basis"], "Single")
