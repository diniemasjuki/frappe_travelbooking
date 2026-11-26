# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests GATE KAPASITI (hermetik — monkeypatch, tiada DB).

Model konsolidasi (Nov 2026):
  - Kolam TUNGGAL = cabin_rates pada Trip Cruise Schedule (child Trip
    Package Price): cabin_allotment (kontrak) − cabin_occupancy (kiraan
    live KABIN Booking Reservation — DISTINCT room_id, disegerak hooks).
  - Inventori mengira KABIN, bukan penumpang: setiap selection wizard
    (bilik) = SATU kabin kategori room_category; tetamu (main/extra
    bed/infant) berkongsi kabin dan TIDAK dihitung berasingan.
  - Gate: lock baris schedule (FOR UPDATE) → semak setiap kategori
    pilihan cukup KABIN.
  - Offer darat (tanpa cruise_schedule) → tiada had (jualan terbuka).
  - [BUANG] Sailing Inventory, apply/release_offer_booking, snapshot —
    cancel reservasi mengosongkan kuota melalui hook kiraan semula.
"""

from contextlib import ExitStack
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.utils.offer_factory import check_offer_capacity


def _rooms(n=1, category="CAT-BAL", main=2, extra=0, infants=0):
	"""`n` selection bilik — setiap satu = SATU kabin kategori berkenaan.
	Tetamu (main/extra bed/infant) berkongsi kabin; bilangan tetamu TIDAK
	mempengaruhi kiraan inventori."""
	return [{"room_category": category, "main_guests": main,
			  "extra_beds": extra, "infants": infants} for _ in range(n)]


def _pool_rows(rows):
	"""Baris cabin_rates schedule — pricing_for_class = docname kategori."""
	return [frappe._dict(pricing_for_class=name,
						 cabin_allotment=allot, cabin_occupancy=occ)
			for name, allot, occ in rows]


class _Env:
	"""Mock Frappe: schedule AC01 + kolam cabin_rates; kategori docname
	'Balcony Cabin' → kod 'BAL'."""

	def __init__(self, pool_rows):
		self.pool_rows = pool_rows
		self.locks = []

	def _gv(self, dt, name=None, f=None, as_dict=False, **k):
		if dt == "Package Offer":
			if f == "cruise_schedule":
				return "AC01"
			return "AC01"
		if dt == "Trip Price Category":
			# docname → kod; pilihan wizard membawa docname ATAU kod.
			return {"Balcony Cabin": "BAL", "CAT-BAL": "BAL",
					"CAT-SEA": "SEA"}.get(name, name)
		return None

	def _ga(self, dt, filters=None, fields=None, **k):
		if dt == "Trip Package Price":
			return self.pool_rows
		return []

	def patches(self):
		return [
			patch.object(frappe.db, "sql",
				side_effect=lambda q, v=None, **k: self.locks.append(q)
					if "FOR UPDATE" in q else None),
			patch.object(frappe.db, "get_value", side_effect=self._gv),
			patch.object(frappe.db, "exists", return_value=True),
			patch("frappe.get_all", side_effect=self._ga),
		]


class TestCabinRatesGate(UnitTestCase):
	"""Kolam tunggal cabin_rates — gate kapasiti cruise."""

	def _run(self, pool_rows, selections):
		env = _Env(pool_rows)
		with ExitStack() as stack:
			for p in env.patches():
				stack.enter_context(p)
			check_offer_capacity("OFF-1", selections)
		return env.locks

	def test_room_passes_and_locks_schedule(self):
		locks = self._run(_pool_rows([("Balcony Cabin", 10, 2)]),
						  _rooms(n=1))
		self.assertEqual(len(locks), 1)
		self.assertIn("tabTrip Cruise Schedule", locks[0])

	def test_full_rejects(self):
		# avail 0 — walau satu kabin pun tak muat.
		with self.assertRaises(frappe.ValidationError):
			self._run(_pool_rows([("Balcony Cabin", 10, 10)]), _rooms(n=1))

	def test_exact_fit_passes(self):
		# avail = 2 kabin, 2 bilik → lulus (sempadan).
		self._run(_pool_rows([("Balcony Cabin", 10, 8)]), _rooms(n=2))

	def test_over_capacity_rejects(self):
		# avail = 2 kabin, 3 bilik → tolak.
		with self.assertRaises(frappe.ValidationError):
			self._run(_pool_rows([("Balcony Cabin", 10, 8)]), _rooms(n=3))

	def test_pax_sharing_one_cabin_not_counted_per_head(self):
		# INTI MODEL: 1 bilik dgn 2 dewasa + 1 extra bed + 1 infant (4
		# penumpang) = SATU kabin — avail 1 pun cukup.
		self._run(_pool_rows([("Balcony Cabin", 10, 9)]),
				  _rooms(n=1, main=2, extra=1, infants=1))

	def test_empty_selection_not_counted(self):
		# Selection tanpa tetamu langsung bukan kabin — tak dihitung.
		self._run(_pool_rows([("Balcony Cabin", 10, 10)]),
				  [{"room_category": "CAT-BAL", "main_guests": 0}])

	def test_unknown_category_rejects(self):
		# Kategori pilihan tiada dalam kolam → tak boleh dijual.
		with self.assertRaises(frappe.ValidationError):
			self._run(_pool_rows([("Balcony Cabin", 10, 0)]),
					  _rooms(n=1, category="CAT-XX"))

	def test_land_offer_open_sale(self):
		"""Offer darat (tiada schedule) → tiada gate, jualan terbuka."""
		def _gv(dt, name=None, f=None, as_dict=False, **k):
			if dt == "Package Offer" and f == "cruise_schedule":
				return None
			return None

		with patch.object(frappe.db, "get_value", side_effect=_gv), \
			patch.object(frappe.db, "exists", return_value=False):
			# Tiada throw — jualan terbuka.
			check_offer_capacity("OFF-DARAT", _rooms(n=1, main=50))

	def test_multi_category_checks_each(self):
		# Dua kategori dipilih — kedua-dua disemak pada kolam masing-masing.
		sel = _rooms(n=1, category="CAT-BAL") + _rooms(n=1, category="CAT-SEA")
		env = _Env(_pool_rows([
			("Balcony Cabin", 10, 8),   # avail 2 — cukup utk 1 kabin
			("Seaview Cabin", 6, 6),    # avail 0 — TAK cukup
		]))
		with ExitStack() as stack:
			for p in env.patches():
				stack.enter_context(p)
			with self.assertRaises(frappe.ValidationError):
				check_offer_capacity("OFF-1", sel)
