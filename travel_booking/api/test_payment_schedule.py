# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Unit tests Fasa A (hermetik — tiada fixture DB, corak test_currency_axis):

1. _compute_schedule_rows  — G1: jadual deposit/baki SO.
   - 0% deposit → [] (ciri mati, kelakuan pra-Fasa A)
   - normal → [Deposit, Balance], jumlah == grand_total, due baki =
     departure − final_days
   - dalam tetingkap final payment / deposit ≥ jumlah / tiada departure →
     satu baris Full Payment (amalan cruise line)
   - pembundaran: baris baki = grand − deposit (jumlah MESTI tepat —
     validate_payment_schedule_amount ERPNext toleransi 0.1 sahaja)
2. _effective_payment_terms — G1: override offer → fallback global.
3. release_offer_booking    — G2: songsangan apply (cap 0, kunci asing skip).
4. [BUANG Nov 2026] _release_offer_quota / release kuota — kapasiti
   kini kolam cabin_rates (occupancy live reservasi; cancel mengosongkan
   automatik melalui hook).
   rosos → dibersihkan, kegagalan release → snapshot KEKAL untuk sweep
   seterusnya.
"""

import json
from unittest.mock import patch

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.booking_engine import (
	_compute_schedule_rows,
	_effective_payment_terms,
)


def _row(rows, desc):
	return next((r for r in rows if r["description"] == desc), None)


class TestComputeScheduleRows(UnitTestCase):
	"""G1 — jadual payment_schedule (PURE, tiada DB)."""

	def test_deposit_disabled_returns_empty(self):
		# 0% = ciri dimatikan (settings & offer) — SO kekal kelakuan lama.
		self.assertEqual(_compute_schedule_rows(1000, 0, 30, "2027-03-01", "2026-11-08"), [])
		self.assertEqual(_compute_schedule_rows(0, 20, 30, "2027-03-01", "2026-11-08"), [])

	def test_normal_two_rows(self):
		rows = _compute_schedule_rows(10000, 20, 60, "2027-03-08", "2026-11-08")
		self.assertEqual(len(rows), 2)
		dep, bal = rows
		self.assertEqual(dep["description"], "Deposit")
		self.assertEqual(dep["due_date"], "2026-11-08")          # semasa booking
		self.assertEqual(dep["payment_amount"], 2000.0)
		self.assertEqual(bal["description"], "Balance Payment")
		self.assertEqual(bal["due_date"], "2027-01-07")          # 2027-03-08 − 60
		self.assertEqual(bal["payment_amount"], 8000.0)
		# Kekangan ERPNext: jumlah baris MESTI == grand_total.
		self.assertEqual(
			round(sum(r["payment_amount"] for r in rows), 2), 10000.0)

	def test_inside_final_window_full_payment(self):
		# Booking dibuat 30 hari sebelum berlepas, baki due 60 hari sebelum →
		# dalam tetingkap final: bayar penuh serta-merta (amalan semua line).
		rows = _compute_schedule_rows(10000, 20, 60, "2026-12-08", "2026-11-08")
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["description"], "Full Payment")
		self.assertEqual(rows[0]["payment_amount"], 10000.0)

	def test_deposit_covers_total_full_payment(self):
		rows = _compute_schedule_rows(1000, 100, 60, "2027-03-08", "2026-11-08")
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["description"], "Full Payment")

	def test_no_departure_full_payment(self):
		# TGD tanpa departure_date — jangan janji tarikh akhir yang tiada.
		rows = _compute_schedule_rows(1000, 20, 60, None, "2026-11-08")
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["description"], "Full Payment")

	def test_no_final_days_full_payment(self):
		# final_payment_days tidak dikonfigur (0 di mana-mana) — deposit
		# sahaja tak cukup untuk menjamin tarikh akhir; bayar penuh.
		rows = _compute_schedule_rows(1000, 20, 0, "2027-03-08", "2026-11-08")
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["description"], "Full Payment")

	def test_rounding_balance_absorbs_remainder(self):
		# Jumlah baris mesti TEPAT sama dengan grand_total walaupun deposit
		# dibundar — baki menyerap baki pembundaran (bukan dibundar bebas).
		rows = _compute_schedule_rows(999.99, 33, 60, "2027-03-08", "2026-11-08")
		self.assertEqual(len(rows), 2)
		self.assertEqual(round(sum(r["payment_amount"] for r in rows), 2), 999.99)
		self.assertEqual(
			_row(rows, "Deposit")["payment_amount"] + _row(rows, "Balance Payment")["payment_amount"],
			999.99)

	def test_balance_due_never_before_transaction_date(self):
		# validate_payment_schedule_dates ERPNext: due >= transaction_date.
		# Kes sempadan: departure − final_days == SEMALAM → full payment.
		rows = _compute_schedule_rows(1000, 20, 61, "2027-01-08", "2026-11-08")
		self.assertEqual(len(rows), 1)
		self.assertEqual(rows[0]["description"], "Full Payment")


class TestEffectivePaymentTerms(UnitTestCase):
	"""G1 — keutamaan offer → global (monkeypatch DB)."""

	def test_offer_overrides_global(self):
		with patch.object(frappe.db, "exists", return_value=True), \
			patch.object(frappe.db, "get_value", return_value=frappe._dict(
				deposit_percent=35, final_payment_days=90)), \
			patch.object(frappe.db, "get_single_value", return_value=5):
			pct, days = _effective_payment_terms("OFF-2026-0001")
		self.assertEqual(pct, 35.0)
		self.assertEqual(days, 90)

	def test_offer_blank_falls_back_to_global(self):
		# Offer ialah OVERRIDE, bukan pintu mati — kosong = global.
		with patch.object(frappe.db, "exists", return_value=True), \
			patch.object(frappe.db, "get_value", return_value=frappe._dict(
				deposit_percent=None, final_payment_days=0)), \
			patch.object(frappe.db, "get_single_value", return_value=5):
			pct, days = _effective_payment_terms("OFF-2026-0001")
		self.assertEqual(pct, 5.0)

	def test_no_offer_uses_global(self):
		with patch.object(frappe.db, "get_single_value", side_effect=[5, 30]):
			pct, days = _effective_payment_terms(None)
		self.assertEqual(pct, 5.0)
		self.assertEqual(days, 30)


# [BUANG Nov 2026] TestReleaseOfferQuota — apply/release/snapshot
# ditanggalkan bersama Sailing Inventory; kuota = kiraan live reservasi.

