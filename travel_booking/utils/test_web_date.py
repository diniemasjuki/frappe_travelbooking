# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk web_date() — helper format tarikh pusat
(travel_booking.utils.website_config) yang didorong oleh konfigurasi
Travel Website → Date Display Format.
"""

import datetime
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.utils import website_config
from travel_booking.utils.website_config import web_date


class WebDateTestCase(UnitTestCase):
	def _with_format(self, fmt):
		return patch.object(
			website_config, "get_website_config",
			return_value={"date_format": fmt, "chat": {"enabled": False}},
		)

	def test_default_format(self):
		with self._with_format("dd MMM yyyy"):
			self.assertEqual(web_date("2026-10-03"), "03 Oct 2026")
			self.assertEqual(web_date(datetime.date(2026, 1, 5)), "05 Jan 2026")
			self.assertEqual(web_date(datetime.datetime(2026, 10, 3, 15, 30)), "03 Oct 2026")

	def test_slash_format(self):
		with self._with_format("dd/mm/yyyy"):
			self.assertEqual(web_date("2026-10-03"), "03/10/2026")

	def test_dash_format(self):
		with self._with_format("dd-mm-yyyy"):
			self.assertEqual(web_date("2026-10-03"), "03-10-2026")

	def test_full_month_format(self):
		with self._with_format("dd MMMM yyyy"):
			self.assertEqual(web_date("2026-10-03"), "03 October 2026")

	def test_iso_format(self):
		with self._with_format("yyyy-mm-dd"):
			self.assertEqual(web_date("2026-10-03"), "2026-10-03")

	def test_empty_and_invalid_fail_safe(self):
		with self._with_format("dd MMM yyyy"):
			self.assertEqual(web_date(None), "")
			self.assertEqual(web_date(""), "")
			# Nilai tak boleh diparse dipulangkan seadanya (fail-safe).
			self.assertEqual(web_date("not-a-date"), "not-a-date")

	def tearDown(self):
		frappe.cache().delete_value("travel_website_config")
