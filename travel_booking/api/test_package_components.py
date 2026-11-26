# Copyright (c) 2026, WargaPrihatan and Contributors
# See license.txt

"""Unit tests untuk Fasa 2 — komposisi pakej (package_components) dan
validasi Trip Package Component.

Hermetik: logik baris komponen diuji dengan mock frappe.db (get_all /
get_value) supaya semantik qty × per_pax, pemilihan item code, dan
penyelesaian harga berlaku dalam FUNGSI sebenar tanpa data DB.
"""

import frappe
from frappe.tests import UnitTestCase
from unittest.mock import patch

from travel_booking.api import package_components


def _comp(component_type="Merchandise", inclusion_mode="Included", qty=1,
          per_pax=0, merchandise_item=None, trip_addon_package=None,
          misc_description=None, misc_amount=None, item_code_override=None):
	return frappe._dict({
		"name": "row-1", "component_type": component_type,
		"inclusion_mode": inclusion_mode, "qty": qty, "per_pax": per_pax,
		"merchandise_item": merchandise_item,
		"trip_addon_package": trip_addon_package,
		"misc_description": misc_description,
		"misc_amount": misc_amount,
		"item_code_override": item_code_override,
	})


class IncludedComponentLinesTestCase(UnitTestCase):
	"""get_included_component_lines — pembinaan SO line daripada komponen."""

	def _lines(self, rows, pax_count=4, currency="MYR"):
		# Mock get_all yang HORMATI filters — semantik penapis sebenar
		# (inclusion_mode == Included) berlaku dalam query; mock perlu
		# meniru tingkah laku itu supaya test tidak berbohong.
		def _get_all(doctype, filters=None, fields=None, order_by=None, **kw):
			if filters and filters.get("inclusion_mode") == "Included":
				return [r for r in rows
				        if r.get("inclusion_mode") == "Included"]
			return rows
		with patch.object(frappe.db, "get_all", side_effect=_get_all), \
		     patch.object(frappe.db, "get_value", side_effect=self._value_side_effect(rows)), \
		     patch.object(frappe.db, "exists", return_value=True):
			return package_components.get_included_component_lines("TP-TEST", pax_count, currency)

	def _value_side_effect(self, rows):
		def _value(*args, **kwargs):
			# frappe.db.get_value(doctype, name, field) / (doctype, filters, field)
			# / (doctype, filters, [fields], as_dict=True) — tangani semua bentuk.
			doctype = args[0] if args else None
			rest = args[1:] if len(args) > 1 else []
			field = rest[-1] if rest and isinstance(rest[-1], str) else None

			if doctype == "Item" and field == "item_name":
				return "Item " + str(rest[0])
			if doctype == "Item Price":
				return 25.0
			if doctype == "Trip Addon Package" and field == "addon_title":
				return "Snorkeling Trip"
			if doctype == "Trip Addon Package Rate":
				return 120.0
			return None
		return _value

	def test_merchandise_per_pax_multiplied_by_pax(self):
		rows = [_comp(component_type="Merchandise", qty=2, per_pax=1,
		              merchandise_item="MERCH-TSHIRT")]
		lines = self._lines(rows, pax_count=4)
		self.assertEqual(len(lines), 1)
		self.assertEqual(lines[0]["item_code"], "MERCH-TSHIRT")
		self.assertEqual(lines[0]["qty"], 8)  # 2 × 4 pax
		self.assertEqual(lines[0]["rate"], 25.0)

	def test_merchandise_booking_level_not_multiplied(self):
		rows = [_comp(component_type="Merchandise", qty=3, per_pax=0,
		              merchandise_item="MERCH-TAG")]
		lines = self._lines(rows, pax_count=4)
		self.assertEqual(lines[0]["qty"], 3)

	def test_misc_priced_line(self):
		rows = [_comp(component_type="Miscellaneous",
		              misc_description="Travel insurance upgrade",
		              misc_amount=45.0)]
		lines = self._lines(rows, pax_count=2)
		self.assertEqual(len(lines), 1)
		self.assertEqual(lines[0]["rate"], 45.0)
		self.assertEqual(lines[0]["qty"], 1)
		self.assertIn("insurance", lines[0]["description"])

	def test_misc_without_amount_skipped(self):
		rows = [_comp(component_type="Miscellaneous",
		              misc_description="Info only", misc_amount=None)]
		lines = self._lines(rows, pax_count=2)
		self.assertEqual(lines, [])

	def test_cruise_flight_not_component_types(self):
		# Patch v43: Cruise/Flight ialah properti TGD (derive), BUKAN
		# komponen pakej — options component_type tak lagi menawarkan
		# kedua-duanya; get_included_component_lines tak akan temui
		# sebarang baris sedemikian (padam di v43).
		rows = [
			_comp(component_type="Merchandise", merchandise_item="M1"),
		]
		lines = self._lines(rows, pax_count=2)
		self.assertEqual(len(lines), 1)
		# Elemen fizikal di-derive daripada TGD, bukan BOM pakej.
		from travel_booking.api.package_components import get_derived_components
		with patch.object(frappe.db, "exists", return_value=False), \
		     patch.object(frappe.db, "get_value", return_value=None):
			self.assertEqual(get_derived_components("TGD-X-TAK-WUJUD"), [])

	def test_non_included_modes_skipped(self):
		rows = [
			_comp(component_type="Merchandise", inclusion_mode="Post-booking Addon",
			      merchandise_item="MERCH-TSHIRT"),
			_comp(component_type="Merchandise", inclusion_mode="Optional (pre-trip selection)",
			      merchandise_item="MERCH-TAG"),
		]
		lines = self._lines(rows, pax_count=2)
		self.assertEqual(lines, [])

	def test_item_code_override_respected(self):
		rows = [_comp(component_type="Merchandise", merchandise_item="MERCH-X",
		              item_code_override="CUSTOM-ITEM")]
		lines = self._lines(rows, pax_count=1)
		self.assertEqual(lines[0]["item_code"], "CUSTOM-ITEM")

	def test_priced_addon_component_line(self):
		rows = [_comp(component_type="Excursion",
		              trip_addon_package="AP-SNORKEL", per_pax=1)]
		lines = self._lines(rows, pax_count=3)
		self.assertEqual(len(lines), 1)
		self.assertEqual(lines[0]["qty"], 3)
		self.assertEqual(lines[0]["rate"], 120.0)


class ComponentSummaryTestCase(UnitTestCase):
	"""get_component_summary — ringkasan paparan dengan label selesai."""

	def test_summary_maps_fields(self):
		rows = [_comp(component_type="Merchandise", merchandise_item="MERCH-TSHIRT")]
		with patch.object(frappe.db, "get_all", return_value=rows), \
		     patch.object(frappe.db, "get_value", return_value="T-Shirt"):
			out = package_components.get_component_summary("TP-TEST")
		self.assertEqual(len(out), 1)
		self.assertEqual(out[0]["component_type"], "Merchandise")
		self.assertEqual(out[0]["label"], "T-Shirt")
		self.assertEqual(out[0]["qty"], 1)
