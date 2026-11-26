# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian hermetik auto-job status operasional Package Offer (Stage 2 —
tarikh/sailing dibaca DARIPADA Travel Date melalui COALESCE SQL; ujian
memberi baris sebagaimana keluaran SQL itu).

Corak: monkeypatch frappe.db.sql / frappe.db.set_value / frappe.utils.today
(tiada DB fixture — sama seperti test_travel_date)."""

from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase


def _row(name, status="Scheduled", departure=None, return_=None,
		 sailing_start=None, sailing_end=None, closure=None):
	return frappe._dict(
		name=name, status_operational=status, departure_date=departure,
		return_date=return_, sailing_start=sailing_start,
		sailing_end=sailing_end, days_before_closure=closure)


class TestAutoUpdateOfferStatuses(UnitTestCase):

	def _run(self, rows, today):
		sets = []
		# Mock DELEGATE (pelajaran racun cache Nov 2026): hanya pertanyaan
		# status auto-job diberi fixture; pertanyaan dalaman Frappe mesti
		# sampai ke frappe.db.sql sebenar — get_table_columns meng-cache
		# hasilnya ke REDIS dan mock luas pernah meracuni site.
		real_sql = frappe.db.sql

		def _sql(q, *args, **kwargs):
			if "tabPackage Offer" in q and "status_editorial" in q:
				return rows
			return real_sql(q, *args, **kwargs)

		with patch("frappe.utils.today", return_value=today), \
			patch.object(frappe.db, "sql", side_effect=_sql), \
			patch.object(frappe.db, "set_value",
					side_effect=lambda *a, **k: sets.append(a)):
			from travel_booking.module_trip_management.doctype.package_offer.package_offer import (
				auto_update_offer_statuses,
			)
			out = auto_update_offer_statuses()
		return out, sets

	def test_sailing_window_from_travel_date(self):
		out, sets = self._run(
			[_row("OFF-1", sailing_start="2027-03-01",
				  sailing_end="2027-03-08", departure="2027-02-28",
				  return_="2027-03-09")],
			today="2027-03-05")
		self.assertEqual(out["tally"].get("Sailing"), 1)
		self.assertEqual(sets[0][3], "Sailing")

	def test_completed_when_return_past(self):
		out, sets = self._run(
			[_row("OFF-1", status="Running", departure="2027-02-28",
				  return_="2027-03-01")],
			today="2027-03-05")
		self.assertEqual(out["tally"].get("Completed"), 1)
		self.assertEqual(sets[0][3], "Completed")

	def test_closed_within_closure_window(self):
		out, sets = self._run(
			[_row("OFF-1", departure="2027-04-01", closure=30)],
			today="2027-03-20")
		self.assertEqual(out["tally"].get("Closed"), 1)
		self.assertEqual(sets[0][3], "Closed")

	def test_no_more_full_status(self):
		"""[Nov 2026] Status Full dibuang daripada offer — keadaan penuh
		dilihat pada kolam cabin_rates schedule; offer jauh → Scheduled."""
		out, sets = self._run(
			[_row("OFF-1", departure="2027-12-01")],
			today="2027-03-20")
		self.assertNotIn("Full", out["tally"])
		self.assertEqual(out["tally"].get("Scheduled"), 1)
		self.assertEqual(sets, [])  # status sama — tiada tulis

	def test_scheduled_far_future_no_write(self):
		"""Status sama (Scheduled) → tiada db.set_value (idempoten)."""
		out, sets = self._run(
			[_row("OFF-1", departure="2027-12-01")],
			today="2027-03-20")
		self.assertEqual(out["tally"].get("Scheduled"), 1)
		self.assertEqual(out["changed"], 0)
		self.assertEqual(sets, [])
