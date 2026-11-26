# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian hermetik katalog dwi-baca baharu (Stage 2 — tarikh/ops dibaca
DARIPADA Travel Date; bentuk bundle kekal IDENTIK dengan get_ready_bundle
untuk aliran wizard legacy).

Corak: monkeypatch frappe.db.sql (offers + inventori) & frappe.get_all
(Currency) — tiada DB fixture."""

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase


def _offer(name, legacy_tgd, currency="MYR", package="PKG-1",
		   departure="2027-04-08", return_="2027-04-15",
		   template="Cruise Only", travel_date=None):
	return frappe._dict(
		name=name, package=package, travel_date=travel_date,
		offer_name="{} : {}".format(template, departure),
		currency=currency, max_pax=0, current_pax=0,
		legacy_tgd=legacy_tgd, legacy_trip_package="TP-" + name,
		departure_date=departure, return_date=return_,
		sailing_start="2027-04-09", sailing_end="2027-04-14",
		embarkation_port="Jeddah", disembarkation_port="Jeddah",
		cruise_schedule="AC01263", trip="TRIP-X",
		trip_name="Trip X", is_a_cruise_trip=1,
		package_name="Pakej X", package_template=template,
		default_currency="MYR")


class TestGetBundleNew(UnitTestCase):

	def _run(self, offers, pool_rows=None):
		# PENTING (pelajaran racun cache Nov 2026): mock mesti DELEGATE —
		# hanya pertanyaan katalog yang diketahui diberi fixture; pertanyaan
		# dalaman Frappe (cth. SHOW COLUMNS get_table_columns — di-cache ke
		# REDIS!) mesti sampai ke frappe.db.sql / frappe.get_all sebenar.
		# Mock luas return_value pernah menulis fixture ke dalam
		# table_columns::tabDocField dan meracuni seluruh site.
		# [Nov 2026] seats_left kini daripada kolam cabin_rates schedule
		# (Sailing Inventory & Offer Inventory ditanggalkan).
		real_sql = frappe.db.sql
		real_get_all = frappe.get_all

		def _sql(q, *args, **kwargs):
			if "FROM `tabPackage Offer` o" in q:
				return offers
			if "FROM `tabTrip Package Price`" in q and "cabin_allotment" in q:
				return pool_rows or []
			return real_sql(q, *args, **kwargs)

		def _get_all(doctype, *args, **kwargs):
			if doctype == "Currency":
				return [frappe._dict(name="MYR", symbol="RM"),
						frappe._dict(name="SGD", symbol="S$")]
			return real_get_all(doctype, *args, **kwargs)

		with patch.object(frappe.db, "sql", side_effect=_sql), \
			patch("frappe.get_all", side_effect=_get_all):
			from travel_booking.utils.new_catalog import get_bundle_new
			return get_bundle_new()

	def test_bundle_shape_and_travel_date_source(self):
		trips, tgd, pkgs, cruise = self._run([
			_offer("OFF-1", "RTRC-1", currency="SGD"),
			_offer("OFF-2", "RTRC-1", currency="MYR"),
		])
		# Bentuk compat: 4 struktur, kunci nama warisan.
		self.assertEqual([t["name"] for t in trips], ["TRIP-X"])
		self.assertTrue(cruise["TRIP-X"])
		self.assertIn("RTRC-1", pkgs)
		# Satu kumpulan per legacy_tgd walaupun dua offer berkongsi tarikh.
		self.assertEqual(len(tgd["TRIP-X"]), 1)
		group = tgd["TRIP-X"][0]
		self.assertEqual(group["name"], "RTRC-1")
		# total_days/nights DIKIRA (formula TGD), bukan salinan basi.
		self.assertEqual(group["total_days"], 8)
		self.assertEqual(group["total_nights"], 7)
		# Nama kumpulan daripada offer PERTAMA (order deterministik o.name).
		self.assertEqual(group["trip_group_name"],
						 "Cruise Only : 2027-04-08")
		# Kedua-dua offer hadir sebagai item pakej dengan kunci F5.
		self.assertEqual(len(pkgs["RTRC-1"]), 2)
		self.assertEqual({p["offer"] for p in pkgs["RTRC-1"]},
						 {"OFF-1", "OFF-2"})
		# Currency: identiti offer dahulu.
		by_offer = {p["offer"]: p for p in pkgs["RTRC-1"]}
		self.assertEqual(by_offer["OFF-1"]["currency"], "SGD")
		self.assertEqual(by_offer["OFF-1"]["currency_symbol"], "S$")
		self.assertEqual(by_offer["OFF-2"]["currency"], "MYR")

	def test_standalone_offer_uses_travel_date_key(self):
		"""[Nov 2026 anchor-legacy] offer standalone (tiada legacy_tgd)
		TIDAK lagi di-skip — kunci tarikh = nama Travel Date supaya cart
		wizard terus sah (shadow TGD dijana controller Travel Date)."""
		trips, tgd, pkgs, cruise = self._run([
			_offer("OFF-1", "RTRC-1"),
			_offer("OFF-9", None, travel_date="TD-999"),
		])
		self.assertIn("TRIP-X", {t["name"] for t in trips})
		# Dua kunci tarikh: legacy + travel_date offer standalone.
		self.assertEqual({g["name"] for g in tgd["TRIP-X"]},
						 {"RTRC-1", "TD-999"})
		self.assertIn("OFF-9", {p["offer"] for p in pkgs["TD-999"]})
		self.assertNotIn("OFF-9", {p["offer"] for p in pkgs["RTRC-1"]})

	def test_seats_left_none_when_allotment_unconfigured(self):
		# Kolam sailing kosong/belum konfigur → seats_left None.
		trips, tgd, pkgs, cruise = self._run(
			[_offer("OFF-1", "RTRC-1")],
			pool_rows=[frappe._dict(cruise_schedule="AC01263",
									avail=0, max_allot=0)])
		self.assertIsNone(tgd["TRIP-X"][0]["seats_left"])

	def test_seats_left_from_sailing_pool(self):
		# Kolam sailing ada allotment → seats = avail kolam (dikongsi).
		trips, tgd, pkgs, cruise = self._run(
			[_offer("OFF-1", "RTRC-1")],
			pool_rows=[frappe._dict(cruise_schedule="AC01263",
									avail=7, max_allot=12)])
		self.assertEqual(tgd["TRIP-X"][0]["seats_left"], 7)
