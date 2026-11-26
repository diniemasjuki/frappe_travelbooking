# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests hierarki Travel Date (hermetik — monkeypatch, tiada DB fixture,
corak test_currency_axis / test_offer_capacity).

Yang diuji (controller travel_date.py + offer_factory.create_offer):
1. validate — trip cruise tanpa cruise_schedule → throw; dengan schedule →
   medan sailing/ship/port disinkron daripada schedule.
2. sync_to_offers — offer anak menerima medan salinan (db.set_value pukal,
   tanpa picu hook).
3. [BUANG] ensure_sailing_inventory — konsolidasi kolam ke cabin_rates.
4. create_offer mod travel_date — tarikh/schedule diambil DARIPADA Travel
   Date; nilai bertindih yang dihantar pemanggil dibuang (satu sumber).
5. Package Offer.validate — trip + medan salinan ops diwarisi DARIPADA
   Travel Date sahaja (bukan diambil terus dari mana-mana field lain);
   offer legacy tanpa travel_date tidak disentuh."""

from contextlib import ExitStack
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase


def _sched(ship="Aroya", start="2027-03-01", end="2027-03-08",
		   port_start="Jeddah", port_end="Jeddah"):
	return frappe._dict(ship_name=ship, ship_code="AC01",
						sail_start=start, sail_end=end,
						port_start=port_start, port_end=port_end)


def _td_doc(schedule="AC01263", trip_cruise=True):
	"""Instance Travel Date sintetik (bukan insert)."""
	from travel_booking.module_trip_management.doctype.travel_date.travel_date import TravelDate
	doc = TravelDate({"doctype": "Travel Date"})
	doc.name = "TD-2026-0001"
	doc.trip = "TRIP2622"
	doc.status_editorial = "Draft"
	doc.departure_date = "2027-02-28"
	doc.return_date = "2027-03-09"
	doc.cruise_schedule = schedule
	return doc


class TestTravelDateValidate(UnitTestCase):

	def test_cruise_trip_requires_schedule(self):
		doc = _td_doc(schedule=None)
		with patch.object(frappe.db, "get_value",
						side_effect=lambda dt, name, f=None, **k:
							1 if (dt == "Trip" and f == "is_a_cruise_trip") else None):
			with self.assertRaises(frappe.ValidationError):
				doc.validate()

	def test_schedule_syncs_ship_sailing_ports(self):
		doc = _td_doc()
		with patch.object(frappe.db, "get_value",
						side_effect=lambda dt, name, f=None, **k:
							_sched() if dt == "Trip Cruise Schedule" else
							("RC-SHADOW-1" if dt == "Trip Group Date" else None)):
			doc.validate()
		self.assertEqual(doc.ship_name, "Aroya")
		self.assertEqual(doc.ship_code, "AC01")
		self.assertEqual(doc.sailing_start, "2027-03-01")
		self.assertEqual(doc.sailing_end, "2027-03-08")
		self.assertEqual(doc.embarkation_port, "Jeddah")

	def test_return_before_departure_throws(self):
		doc = _td_doc()
		doc.departure_date = "2027-03-10"
		doc.return_date = "2027-03-01"
		with patch.object(frappe.db, "get_value", return_value=None):
			with self.assertRaises(frappe.ValidationError):
				doc.validate()

	def test_cruise_flag_inherited_from_trip(self):
		"""is_a_cruise_trip diwarisi read-only daripada Trip dalam validate
		(liputi ciptaan server-side; fetch_from hanya untuk form Desk)."""
		doc = _td_doc()
		with patch.object(frappe.db, "get_value",
						side_effect=lambda dt, name, f=None, **k:
							_sched() if dt == "Trip Cruise Schedule" else
							(1 if (dt == "Trip" and f == "is_a_cruise_trip") else
							 ("RC-SHADOW-1" if dt == "Trip Group Date" else None))):
			doc.validate()
		self.assertEqual(doc.is_a_cruise_trip, 1)
		# Anchor legacy: TGD shadow sedia ada → legacy_tgd di-set.
		self.assertEqual(doc.legacy_tgd, "RC-SHADOW-1")

	def test_non_cruise_flag_stays_zero(self):
		doc = _td_doc(schedule=None)
		doc.trip = "TOUR-REGULAR"
		with patch.object(frappe.db, "get_value",
						side_effect=lambda dt, name, f=None, **k:
							0 if (dt == "Trip" and f == "is_a_cruise_trip") else None):
			doc.validate()
		self.assertEqual(doc.is_a_cruise_trip, 0)


def _offer_doc(travel_date="TD-2026-0001"):
	"""Instance Package Offer sintetik (bukan insert)."""
	from travel_booking.module_trip_management.doctype.package_offer.package_offer import PackageOffer
	doc = PackageOffer({"doctype": "Package Offer"})
	doc.name = "OFF-2026-0001"
	doc.status_editorial = "Draft"
	doc.travel_date = travel_date
	doc.offer_name = "Seaview Suite : 28 Feb 2027"
	return doc


class TestPackageOfferInheritsTravelDate(UnitTestCase):

	def test_offer_derives_trip_and_copies_from_travel_date(self):
		"""trip + medan salinan ops diwarisi DARIPADA Travel Date dalam
		validate — satu sumber kebenaran, bukan fetch mana-mana field lain."""
		doc = _offer_doc()
		doc.departure_date = "1999-01-01"  # nilai hantu pemanggil — mesti diatasi
		td = frappe._dict(
			trip="TRIP2622", departure_date="2027-02-28",
			return_date="2027-03-09", days_before_closure=30,
			sailing_start="2027-03-01", sailing_end="2027-03-08",
			ship_name="Aroya", ship_code="AC01",
			embarkation_port="Jeddah", disembarkation_port="Jeddah",
			cruise_schedule="AC01263")
		with patch.object(frappe.db, "get_value", return_value=td):
			doc.validate()
		self.assertEqual(doc.trip, "TRIP2622")
		self.assertEqual(doc.departure_date, "2027-02-28")
		self.assertEqual(doc.sailing_start, "2027-03-01")
		self.assertEqual(doc.ship_name, "Aroya")
		self.assertEqual(doc.cruise_schedule, "AC01263")
		self.assertEqual(doc.days_before_closure, 30)

	def test_offer_without_travel_date_untouched(self):
		"""Offer legacy tanpa travel_date (v40): tiada derivation, nilai
		sedia ada dikekalkan."""
		doc = _offer_doc(travel_date=None)
		doc.departure_date = "2027-05-01"
		doc.cruise_schedule = "LEGACY-SCHED"
		with patch.object(frappe.db, "get_value", return_value=None):
			doc.validate()
		self.assertEqual(doc.departure_date, "2027-05-01")
		self.assertEqual(doc.cruise_schedule, "LEGACY-SCHED")
		self.assertFalse(doc.get("trip"))

	def test_offer_name_fallback_uses_inherited_trip(self):
		"""Fallback offer_name guna Trip diwarisi (Travel Package
		deprecated), bukan package lama."""
		doc = _offer_doc()
		doc.offer_name = None
		td = frappe._dict(
			trip="TRIP2622", departure_date="2027-02-28",
			return_date="2027-03-09", days_before_closure=30,
			sailing_start="2027-03-01", sailing_end="2027-03-08",
			ship_name="Aroya", ship_code="AC01",
			embarkation_port="Jeddah", disembarkation_port="Jeddah",
			cruise_schedule="AC01263")
		with patch.object(frappe.db, "get_value", return_value=td):
			doc.validate()
		self.assertEqual(doc.offer_name, "TRIP2622 : 2027-02-28")

	def test_offer_missing_departure_throws(self):
		"""Offer tanpa travel_date DAN tanpa tarikh pergi → throw jelas."""
		doc = _offer_doc(travel_date=None)
		with patch.object(frappe.db, "get_value", return_value=None):
			with self.assertRaises(frappe.ValidationError):
				doc.validate()


class TestSyncToOffers(UnitTestCase):

	def test_children_receive_sync_fields(self):
		doc = _td_doc()
		doc.ship_name = "Aroya"
		doc.sailing_start = "2027-03-01"
		sets = []
		with patch("frappe.get_all",
				return_value=["OFF-1", "OFF-2"]), \
			patch.object(frappe.db, "set_value",
				side_effect=lambda *a, **k: sets.append((a, k))):
			n = doc.sync_to_offers()
		self.assertEqual(n, 2)
		self.assertEqual(len(sets), 2)
		for a, k in sets:
			self.assertEqual(a[0], "Package Offer")
			self.assertEqual(a[2]["ship_name"], "Aroya")
			self.assertEqual(a[2]["cruise_schedule"], "AC01263")
			self.assertEqual(k.get("update_modified"), False)

	def test_no_children_is_noop(self):
		doc = _td_doc()
		with patch("frappe.get_all", return_value=[]), \
			patch.object(frappe.db, "set_value") as sv:
			self.assertEqual(doc.sync_to_offers(), 0)
		sv.assert_not_called()


# [BUANG Nov 2026] TestEnsureSailingInventory — kolam Sailing Inventory
# ditanggalkan (konsolidasi); kolam tunggal = cabin_rates schedule
# (occupancy live reservasi via hooks).

class TestCreateOfferTravelDateMode(UnitTestCase):

	def test_travel_date_overrides_caller_dates(self):
		"""create_offer mod travel_date: tarikh/schedule HANYA daripada
		Travel Date — nilai bertindih dari pemanggil dibuang."""
		captured = {}
		td_row = frappe._dict(
			name="TD-2026-0001", trip="TRIP2622",
			departure_date="2027-02-28", return_date="2027-03-09",
			sailing_start="2027-03-01", sailing_end="2027-03-08",
			ship_name="Aroya", ship_code="AC01",
			embarkation_port="Jeddah", disembarkation_port="Jeddah",
			cruise_schedule="AC01263", days_before_closure=30)
		pkg = frappe._dict(
			name="PKG-1", price_template=[], components=[],
			variant_axes=[], variant_options=[])

		class _FakeOffer:
			def __init__(self, data):
				self.__dict__.update(data)
				self.inventory, self.prices, self.components = [], [], []
				self.name = "OFF-X"
			def get(self, key, default=None):
				return getattr(self, key, default)
			def append(self, key, row):
				getattr(self, key).append(row)
			def insert(self, **kw):
				captured.update(self.__dict__)

		from travel_booking.utils.offer_factory import create_offer

		def _get_doc(dt, name=None):
			if isinstance(dt, dict):  # offer payload
				return _FakeOffer(dt)
			if dt == "Travel Package":
				return pkg
			return _FakeOffer({})

		with patch.object(frappe, "get_doc", side_effect=_get_doc), \
			patch.object(frappe.db, "get_value", return_value=td_row):
			# Pemanggil cuba hantar tarikh SALAH + schedule SALAH — mesti
			# diabaikan memihak kepada nilai Travel Date.
			create_offer("PKG-1", {
				"travel_date": "TD-2026-0001",
				"departure_date": "1999-01-01",
				"cruise_schedule": "WRONG",
			})
		self.assertEqual(captured["departure_date"], "2027-02-28")
		self.assertEqual(captured["return_date"], "2027-03-09")
		self.assertEqual(captured["cruise_schedule"], "AC01263")
		self.assertEqual(captured["ship_name"], "Aroya")
		self.assertEqual(captured["travel_date"], "TD-2026-0001")
