# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests untuk default currency by location (utils/geo_currency.py).

Hermetik — tiada panggilan HTTP sebenar: provider geo-IP, konfigurasi
Travel Website dan axis currency semuanya di-monkeypatch. Semantik:

- get_geo_default_currency: mapping negara → currency (MY→MYR, SG→SGD),
  fallback currency default axis untuk negara lain / disabled / lookup
  gagal / currency tidak diisytiharkan dalam axis.
- resolve_website_currency: keutamaan ?currency= param > cookie
  rc_currency (pilihan tersimpan) > geo default.
- get_request_country: header CF-IPCountry diutamakan, IP private
  di-skip, kod negara dinormalize uppercase.
"""

from unittest.mock import MagicMock, patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.utils import geo_currency


GEO_CONFIG = {"enabled": True, "map": {"MY": "MYR", "SG": "SGD"}}
DECLARED = {"MYR", "SGD"}


class GeoCurrencyTestCase(UnitTestCase):
	def setUp(self):
		# Sumber config + axis + default — semua dipatch supaya test
		# tidak bergantung pada Travel Website / Travel Settings DB.
		cfg = patch.object(geo_currency, "_geo_config", lambda: dict(GEO_CONFIG))
		cfg.start()
		self.addCleanup(cfg.stop)

		declared = patch.object(geo_currency, "get_declared_currencies", lambda: set(DECLARED))
		declared.start()
		self.addCleanup(declared.stop)

		default = patch.object(geo_currency, "get_default_currency", lambda: "MYR")
		default.start()
		self.addCleanup(default.stop)

		# Request context neutral — test set semula bila perlu. Simpan &
		# pulangkan keadaan asal frappe.local (form_dict/request mungkin
		# tidak wujud dalam konteks run-tests).
		self._orig_form_dict = getattr(frappe.local, "form_dict", None)
		self._orig_request = getattr(frappe.local, "request", None)
		frappe.local.form_dict = frappe._dict()
		frappe.local.request = frappe._dict(cookies={})
		self.addCleanup(self._restore_request_context)

	def _restore_request_context(self):
		for attr, orig in (
			("form_dict", self._orig_form_dict),
			("request", self._orig_request),
		):
			if orig is not None:
				setattr(frappe.local, attr, orig)
			else:
				try:
					delattr(frappe.local, attr)
				except AttributeError:
					pass

	def _set_cookie(self, currency):
		frappe.local.request = frappe._dict(
			cookies={"rc_currency": currency} if currency else {}
		)

	# ── get_geo_default_currency: mapping + fallback ──

	def test_geo_default_malaysia(self):
		with patch.object(geo_currency, "get_request_country", lambda: "MY"):
			self.assertEqual(geo_currency.get_geo_default_currency(), "MYR")

	def test_geo_default_singapore(self):
		with patch.object(geo_currency, "get_request_country", lambda: "SG"):
			self.assertEqual(geo_currency.get_geo_default_currency(), "SGD")

	def test_geo_default_other_country_falls_back_to_axis_default(self):
		with patch.object(geo_currency, "get_request_country", lambda: "US"):
			self.assertEqual(geo_currency.get_geo_default_currency(), "MYR")

	def test_geo_default_lookup_failed_falls_back(self):
		with patch.object(geo_currency, "get_request_country", lambda: None):
			self.assertEqual(geo_currency.get_geo_default_currency(), "MYR")

	def test_geo_default_disabled_falls_back(self):
		with patch.object(
			geo_currency, "_geo_config", lambda: {"enabled": False, "map": {"MY": "MYR"}}
		):
			with patch.object(geo_currency, "get_request_country", MagicMock(return_value="MY")) as geo:
				self.assertEqual(geo_currency.get_geo_default_currency(), "MYR")
				geo.assert_not_called()  # disabled — jangan lookup langsung

	def test_geo_default_currency_not_declared_falls_back(self):
		# SG ada mapping tapi SGD tidak dijual (tiada baris axis) —
		# jangan hantar pelawat ke currency yang tak boleh ditempah.
		with patch.object(geo_currency, "get_declared_currencies", lambda: {"MYR"}):
			with patch.object(geo_currency, "get_request_country", lambda: "SG"):
				self.assertEqual(geo_currency.get_geo_default_currency(), "MYR")

	# ── resolve_website_currency: keutamaan ──

	def test_resolve_param_wins_over_cookie_and_geo(self):
		frappe.local.form_dict = frappe._dict(currency="usd")
		self._set_cookie("SGD")
		with patch.object(geo_currency, "get_request_country", lambda: "MY"):
			self.assertEqual(geo_currency.resolve_website_currency(), "USD")

	def test_resolve_cookie_wins_over_geo(self):
		self._set_cookie("sgd")
		with patch.object(geo_currency, "get_request_country", lambda: "MY"):
			self.assertEqual(geo_currency.resolve_website_currency(), "SGD")

	def test_resolve_geo_when_no_explicit_choice(self):
		self._set_cookie(None)
		with patch.object(geo_currency, "get_request_country", lambda: "SG"):
			self.assertEqual(geo_currency.resolve_website_currency(), "SGD")

	def test_resolve_falls_back_to_axis_default(self):
		self._set_cookie(None)
		with patch.object(geo_currency, "get_request_country", lambda: None):
			self.assertEqual(geo_currency.resolve_website_currency(), "MYR")

	# ── get_request_country: header CF / IP / cache ──

	def test_cf_header_wins_without_lookup(self):
		with patch.object(frappe, "get_request_header", lambda *a, **k: "sg"):
			with patch.object(geo_currency, "_lookup_country") as lookup:
				self.assertEqual(geo_currency.get_request_country(), "SG")
				lookup.assert_not_called()

	def test_cf_header_unknown_values_ignored(self):
		for sentinel in ("XX", "T1", ""):
			with patch.object(frappe, "get_request_header", lambda *a, s=sentinel, **k: s):
				with patch.object(geo_currency, "_client_ip", lambda: None):
					self.assertIsNone(geo_currency.get_request_country())

	def test_private_ip_skipped(self):
		for ip in ("127.0.0.1", "10.0.0.5", "192.168.1.10", "::1", "bukan-ip"):
			frappe.local.request_ip = ip
			try:
				with patch.object(geo_currency, "_cf_country", lambda: None):
					with patch.object(geo_currency, "_lookup_country") as lookup:
						self.assertIsNone(geo_currency.get_request_country(), ip)
						lookup.assert_not_called()
			finally:
				try:
					del frappe.local.request_ip
				except AttributeError:
					pass

	def test_lookup_result_cached(self):
		with patch.object(geo_currency, "_cf_country", lambda: None):
			with patch.object(geo_currency, "_client_ip", lambda: "203.0.113.9"):
				with patch.object(geo_currency, "_cached_country", lambda ip: "MY"):
					with patch.object(geo_currency, "_lookup_country") as lookup:
						self.assertEqual(geo_currency.get_request_country(), "MY")
						lookup.assert_not_called()

	# ── _lookup_country: parsing respons provider ──

	def test_lookup_country_parses_provider_response(self):
		class _Resp:
			def raise_for_status(self):
				pass

			def json(self):
				return {"success": True, "country_code": "sg"}

		with patch.object(geo_currency.requests, "get", lambda *a, **k: _Resp()):
			self.assertEqual(geo_currency._lookup_country("203.0.113.9"), "SG")

	def test_lookup_country_provider_error_returns_none(self):
		class _Resp:
			def raise_for_status(self):
				pass

			def json(self):
				return {"success": False, "message": "Invalid IP"}

		with patch.object(geo_currency.requests, "get", lambda *a, **k: _Resp()):
			self.assertIsNone(geo_currency._lookup_country("203.0.113.9"))

	def test_lookup_country_network_error_returns_none(self):
		with patch.object(
			geo_currency.requests, "get", side_effect=Exception("timeout")
		):
			self.assertIsNone(geo_currency._lookup_country("203.0.113.9"))
