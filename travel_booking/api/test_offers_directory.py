# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests utk endpoint direktori Package Offers (package_admin —
halaman Package Offers, Travel Manager, Nov 2026).

Lingkup: katalog medan BULK edit, penghuraian senarai nama bulk &
validasi nilai bulk (semakan yang boleh lari tanpa menulis rekod).
Laluan ber-DB penuh (SQL join direktori, guard padam ber-jualan,
gate peranan per-batch) disempurnakan melalui ujian E2E browser —
corak sama dgn test_addon_scoping.py (unit hermetik dulu, E2E kemudian).
"""

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.package_admin import (
	OFFER_BULK_EDIT_FIELDS,
	_offer_delete_block_reason,
	_parse_bulk_names,
	_validate_bulk_offer_value,
)


class OffersDirectoryTestCase(UnitTestCase):
	# ── Katalog bulk edit: tawaran medan terkawal sahaja ──

	def test_bulk_fields_catalog_whitelist(self):
		# Arahan pemilik: editorial status, offer_name, currency, flight
		# (+ sale_mode kekal) — medan lain tidak ditawarkan.
		self.assertEqual(set(OFFER_BULK_EDIT_FIELDS),
			{"currency", "status_editorial", "sale_mode",
			 "offer_name", "flight"})

	def test_offer_name_passes_through(self):
		# offer_name tiada semakan tambahan (bukan kosong disemak di
		# endpoint) — nilai dipulangkan apa adanya.
		self.assertEqual(
			_validate_bulk_offer_value("offer_name", "Pakej Baru"),
			"Pakej Baru")

	def test_unknown_flight_throws(self):
		# Semakan frappe.db.exists — rekod Flight rekaan tidak wujud.
		with self.assertRaises(frappe.ValidationError):
			_validate_bulk_offer_value("flight", "BUKAN-FLIGHT")

	# ── _parse_bulk_names: list / JSON string / dedupe kekalkan susunan ──

	def test_parse_names_accepts_list_and_dedupes(self):
		self.assertEqual(
			_parse_bulk_names(["OFF-2026.-0002", "OFF-2026.-0001",
							   "OFF-2026.-0002", ""]),
			["OFF-2026.-0002", "OFF-2026.-0001"])

	def test_parse_names_accepts_json_string(self):
		self.assertEqual(
			_parse_bulk_names('["OFF-2026.-0001", "OFF-2026.-0002"]'),
			["OFF-2026.-0001", "OFF-2026.-0002"])

	def test_parse_names_invalid_json_throws(self):
		with self.assertRaises(frappe.ValidationError):
			_parse_bulk_names("bukan json")

	def test_parse_names_empty_returns_empty_list(self):
		# Kosong → list kosong; endpoint masing-masing throw
		# "No offers selected" selepas panggilan ini.
		self.assertEqual(_parse_bulk_names(None), [])
		self.assertEqual(_parse_bulk_names([]), [])

	# ── _validate_bulk_offer_value: status editorial & sale_mode ──

	def test_editorial_status_valid_values_pass(self):
		# Ujian berjalan sbg Administrator (dalam _MANAGER_ONLY) — gate
		# status Active/Cancelled lulus; nilai sah dipulangkan.
		for ok in ("Draft", "Active", "Cancelled"):
			self.assertEqual(
				_validate_bulk_offer_value("status_editorial", ok), ok)

	def test_editorial_status_invalid_throws(self):
		for bad in ("Retired", "aktif", "Draft "):
			with self.assertRaises(frappe.ValidationError):
				_validate_bulk_offer_value("status_editorial", bad)

	def test_sale_mode_valid_values_pass(self):
		for ok in ("Public", "Group Block", "Full Charter", "Private"):
			self.assertEqual(_validate_bulk_offer_value("sale_mode", ok), ok)

	def test_sale_mode_invalid_throws(self):
		with self.assertRaises(frappe.ValidationError):
			_validate_bulk_offer_value("sale_mode", "Wholesale")

	def test_unknown_currency_throws(self):
		# Semakan frappe.db.exists — mata wang rekaan tidak wujud.
		with self.assertRaises(frappe.ValidationError):
			_validate_bulk_offer_value("currency", "ZZZZ")

	# ── _offer_delete_block_reason (laluan tidak wujud — tanpa tulis) ──

	def test_delete_block_reason_missing_offer(self):
		self.assertEqual(_offer_delete_block_reason("OFF-2099.-9999"),
			"Offer not found.")
