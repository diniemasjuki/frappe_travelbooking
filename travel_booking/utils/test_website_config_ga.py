# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk blok konfigurasi `ga` dalam website_config — dedahan
Google Analytics per-site (Travel Website → tab Cruise/Tour Homepage)
yang dibaca oleh templates/base_travel.html (#rcGaConfig) dan
public/js/analytics.js.
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.utils.website_config import _empty_config, _homepage_block


class WebsiteConfigGaTestCase(UnitTestCase):
	def test_homepage_block_ga_enabled_with_id(self):
		doc = frappe._dict(
			cruise_ga_enabled=1,
			cruise_ga_measurement_id="  G-ABC123  ",
		)
		block = _homepage_block(doc, "cruise")
		self.assertTrue(block["ga"]["enabled"])
		# ID di-strip supaya ruang kosong tak merosakkan regex client-side
		self.assertEqual(block["ga"]["measurement_id"], "G-ABC123")

	def test_homepage_block_ga_disabled(self):
		doc = frappe._dict(tour_ga_enabled=0, tour_ga_measurement_id="G-XYZ9")
		block = _homepage_block(doc, "tour")
		self.assertFalse(block["ga"]["enabled"])
		self.assertEqual(block["ga"]["measurement_id"], "G-XYZ9")

	def test_homepage_block_ga_missing_fields(self):
		# Field belum wujud dalam DB (pre-migrate) — fallback selamat
		block = _homepage_block(frappe._dict(), "cruise")
		self.assertFalse(block["ga"]["enabled"])
		self.assertEqual(block["ga"]["measurement_id"], "")

	def test_empty_config_ga_keys(self):
		# Fallback pre-install mesti ada kunci ga supaya template tak Undefined
		for prefix in ("cruise", "tour"):
			self.assertEqual(
				_empty_config()[prefix]["ga"],
				{"enabled": False, "measurement_id": ""},
			)
