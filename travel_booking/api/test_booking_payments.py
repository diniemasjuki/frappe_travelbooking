# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian INTEGRASI — Payment Entry booking & navigasi prev/next pada page
Booking Info (Travel Manager).

Diuji E2E melalui whitelist endpoint (bukan fungsi dalaman):

- booking_payments.get_booking_payment_entries /
  submit_booking_payment_entries — butang "Submit Payment Entry".
- manage_trip_booking.get_booking_neighbours — butang Prev/Next: turutan
  & tapisan mesti TEPAT sama dengan senarai yang booking dibuka daripadanya.

Fixture pakej/harga/paksi currency diimport daripada
test_booking_amendments (satu sumber). Semua mutasi berlaku dalam
transaksi kelas IntegrationTestCase dan di-rollback — tiada data kekal.

KESAN SAMPINGAN DI-MOCK supaya ujian tidak menghantar apa-apa keluar:
notifikasi Telegram/SMS integrasi (hook "*" setiap dokumen) dan resit
emel booking (render PDF). db.commit() di-no-op-kan (corak
test_booking_amendments).
"""

from importlib import import_module
from unittest.mock import patch

import frappe
from frappe.tests import IntegrationTestCase
from frappe.utils import today

from travel_booking.api import booking_engine, booking_payments
from travel_booking.api import manage_trip_booking as mtb
from travel_booking.api.constants import TRAVEL_ITEM_CODE
from travel_booking.api.so_helpers import _item_spec
from travel_booking.api.test_booking_amendments import (
	_axis_default,
	_make_booking,
	_make_primary_so,
	_price_fixture,
)

_TG = "erpnext_telegram_integration.erpnext_telegram_integration.doctype."
_TELEGRAM = _TG + "telegram_notification.telegram_notification"
_SMS = _TG + "sms_notification.sms_notification"
OPERATOR = "test-pe-operator@example.test"


class BookingPaymentsTestCase(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.fx = _price_fixture()
		cls.axis = _axis_default()
		cls.tgd = frappe.db.get_value("Trip Group Date", {"is_a_cruise_trip": 1}, "name") \
			or frappe.db.get_value("Trip Group Date", {}, "name")
		cls.customers = frappe.get_all("Customer", limit=1, pluck="name")

	def _fixture_ok(self):
		return bool(self.fx and self.axis and self.tgd and self.customers)

	def _mock(self, target, attr, **kwargs):
		patcher = patch.object(target, attr, **kwargs)
		patcher.start()
		self.addCleanup(patcher.stop)

	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")
		# Tanpa commit & tanpa kesan keluar (Telegram / SMS / emel resit).
		self._mock(frappe.db, "commit", new=lambda *a, **kw: None)
		self._mock(import_module(_TELEGRAM), "run_telegram_notifications")
		self._mock(import_module(_SMS), "run_sms_notifications")
		self._mock(booking_engine, "_send_receipt_email")

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	# ── Fixture ───────────────────────────────────────────────

	def _make_draft_pe(self, so, amount):
		"""Payment Entry DRAFT (docstatus 0) — cermin portal_payment.
		submit_manual_payment: Receive, rujuk SO, diterbitkan oleh customer."""
		from erpnext.accounts.party import get_party_account

		paid_to = frappe.db.get_value(
			"Account", {"account_type": "Bank", "company": so.company,
						"is_group": 0, "account_currency": so.currency}, "name") \
			or frappe.db.get_value(
				"Account", {"account_type": "Bank", "company": so.company,
							"is_group": 0}, "name")
		if not paid_to:
			self.skipTest("tiada akaun Bank pada site ujian")
		party_account = get_party_account("Customer", so.customer, so.company)
		pe = frappe.get_doc({
			"doctype": "Payment Entry",
			"payment_type": "Receive",
			"company": so.company,
			"posting_date": today(),
			"party_type": "Customer",
			"party": so.customer,
			"party_account": party_account,
			"paid_from": party_account,
			"paid_to": paid_to,
			"paid_amount": amount,
			"received_amount": amount,
			"reference_no": "TEST-TRX-" + frappe.utils.random_string(4).upper(),
			"reference_date": today(),
			"references": [{
				"reference_doctype": "Sales Order",
				"reference_name": so.name,
				"allocated_amount": amount,
			}],
			"remarks": "Manual transfer for " + so.name + ". Pending verification.",
		})
		pe.insert(ignore_permissions=True)
		return pe

	def _make_case(self, booking_status="Accepted", pe_shares=(0.5,)):
		"""Booking 1 pax (SO submitted) + PE DRAFT bagi SO itu — satu untuk
		setiap pecahan (`pe_shares`) daripada grand_total SO."""
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		fx, axis = self.fx, self.axis
		customer = self.customers[0]
		lines = [{
			"item_code": TRAVEL_ITEM_CODE,
			"item_name": "{0} (Cabin 1) — Main Guest".format(fx.cat_low),
			"qty": 1,
			"rate": float(fx.adult_low),
			"uom": "Nos",
			"description": ("Test Trip | Test Group | {0} | Cabin 1 | "
							"Main Guest").format(fx.cat_low),
		}]
		so = _make_primary_so(customer, axis.get("currency"),
		                      axis.get("company"), axis.get("selling_price_list"), lines)
		b = _make_booking("RTESTPE" + frappe.utils.random_string(4).upper(),
		                  customer, fx.trip_package, self.tgd, so,
		                  [_item_spec(fx.cat_low, 1, "Main Guest", fx.adult_low)])
		if booking_status != "Accepted":
			frappe.db.set_value("Booking", b.name, "status", booking_status)
		pes = [self._make_draft_pe(so, round(float(so.grand_total) * share, 2))
		       for share in pe_shares]
		return b, so, pes

	# ══════════════════════════════════════════════
	# PREV / NEXT — get_booking_neighbours
	# ══════════════════════════════════════════════

	def test_neighbours_follow_flat_list_order(self):
		names = [b["name"] for b in mtb.get_all_bookings(limit=0)["bookings"]]
		if len(names) < 4:
			self.skipTest("site ujian kurang daripada 4 booking")
		mid = names[2]
		out = mtb.get_booking_neighbours(booking=mid, scope="all")
		self.assertTrue(out["found"])
		self.assertEqual(out["total"], len(names))
		self.assertEqual(out["index"], 3)                      # 1-based
		self.assertEqual(out["prev"]["name"], names[1])       # baris ATAS
		self.assertEqual(out["next"]["name"], names[3])       # baris BAWAH
		# Hujung senarai — butang masing-masing disabled.
		self.assertIsNone(mtb.get_booking_neighbours(
			booking=names[0], scope="all")["prev"])
		self.assertIsNone(mtb.get_booking_neighbours(
			booking=names[-1], scope="all")["next"])
		# Booking di luar senarai → found False (prev/next disembunyikan).
		missing = mtb.get_booking_neighbours(booking="NO-SUCH-BOOKING", scope="all")
		self.assertFalse(missing["found"])
		self.assertIsNone(missing["prev"])
		self.assertEqual(missing["index"], 0)

	def test_neighbours_honour_filters_and_scopes(self):
		b, _so, _pes = self._make_case(booking_status="Processing")

		# Tapisan status — hanya booking berstatus sama menjadi jiran.
		proc = [x["name"] for x in mtb.get_all_bookings(
			status="Processing", limit=0)["bookings"]]
		out = mtb.get_booking_neighbours(
			booking=b.name, scope="all", status="Processing")
		self.assertEqual(out["total"], len(proc))
		self.assertTrue(out["found"])
		i = proc.index(b.name)
		self.assertEqual(out["prev"]["name"] if i else None,
						 proc[i - 1] if i else None)
		self.assertEqual(out["next"]["name"] if i < len(proc) - 1 else None,
						 proc[i + 1] if i < len(proc) - 1 else None)
		# Tanpa tapisan, booking itu TIDAK lagi jiran booking Processing sahaja.
		self.assertGreater(mtb.get_booking_neighbours(
			booking=b.name, scope="all")["total"], len(proc))

		# Skop group — tepat booking trip_date itu, tidak lebih.
		in_group = [x["name"] for x in mtb.get_group_bookings(
			trip_groups=[b.trip_date], limit=0)["bookings"]]
		g = mtb.get_booking_neighbours(
			booking=b.name, scope="group", trip_groups=[b.trip_date])
		self.assertEqual(g["total"], len(in_group))
		self.assertTrue(g["found"])

		# Skop customer — susunan sama dengan senarai customer.
		mine = frappe.get_all("Booking", filters={"customer": b.customer},
			pluck="name", order_by="creation desc, name desc")
		c = mtb.get_booking_neighbours(
			booking=b.name, scope="customer", customer=b.customer)
		self.assertEqual(c["total"], len(mine))
		self.assertEqual(c["index"], mine.index(b.name) + 1)

		# Skop tak dikenali / argumen wajib kosong → ditolak.
		with self.assertRaises(frappe.ValidationError):
			mtb.get_booking_neighbours(booking=b.name, scope="nope")
		with self.assertRaises(frappe.ValidationError):
			mtb.get_booking_neighbours(booking=b.name, scope="customer")

	def test_neighbours_deterministic_on_creation_tie(self):
		b1, _so1, _ = self._make_case()
		b2, _so2, _ = self._make_case()
		ts = "2026-01-02 03:04:05.000000"
		frappe.db.set_value("Booking", b1.name, "creation", ts)
		frappe.db.set_value("Booking", b2.name, "creation", ts)
		# Susunan senarai & jiran mesti sepakat — nama menurun sebagai
		# tiebreaker bila dua booking dicipta dalam saat yang sama.
		names = [x["name"] for x in mtb.get_all_bookings(limit=0)["bookings"]]
		hi, lo = (b1, b2) if b1.name > b2.name else (b2, b1)
		self.assertLess(names.index(hi.name), names.index(lo.name))
		self.assertEqual(mtb.get_booking_neighbours(
			booking=lo.name, scope="all")["prev"]["name"], hi.name)
		self.assertEqual(mtb.get_booking_neighbours(
			booking=hi.name, scope="all")["next"]["name"], lo.name)

	# ══════════════════════════════════════════════
	# SUBMIT PAYMENT ENTRY — booking_payments
	# ══════════════════════════════════════════════

	def test_get_payment_entries_lists_draft_with_proof(self):
		b, so, (pe,) = self._make_case()
		# Baris lampiran (bukti bayaran) dimasukkan TERUS sebagai row DB —
		# rekod File melalui ORM membaca kandungan fail dari cakera; row
		# ini di-rollback bersama transaksi ujian & tiada fail ditulis.
		frappe.db.sql("""
			insert into tabFile
				(name, creation, modified, modified_by, owner, docstatus, idx,
				 file_name, file_url, file_type, attached_to_doctype,
				 attached_to_name, is_private)
			values (%s, now(), now(), 'Administrator', 'Administrator', 0, 0,
					'proof.png', '/private/files/booking-pe-test-proof.png',
					'image/png', 'Payment Entry', %s, 1)
		""", ("booking-pe-test-proof-" + frappe.utils.random_string(6).lower(), pe.name))

		out = booking_payments.get_booking_payment_entries(booking=b.name)
		self.assertEqual(out["booking_number"], b.booking_number)
		self.assertEqual(out["pending_count"], 1)
		self.assertTrue(out["booking_payable"])
		self.assertTrue(out["can_submit"])
		row = out["payment_entries"][0]
		self.assertEqual(row["name"], pe.name)
		self.assertTrue(row["pending"])
		self.assertEqual(row["docstatus"], 0)
		self.assertTrue(row["can_submit"])
		self.assertAlmostEqual(row["paid_amount"], float(pe.paid_amount), places=2)
		self.assertEqual(len(row["files"]), 1)
		ref = row["references"][0]
		self.assertEqual(ref["reference_name"], so.name)
		self.assertTrue(ref["in_booking"])

	def test_submit_verifies_draft_and_updates_booking(self):
		b, so, (pe,) = self._make_case()
		out = booking_payments.submit_booking_payment_entries(
			booking=b.name, payment_entries=[pe.name])

		self.assertEqual(out["submitted"], [pe.name])
		self.assertEqual(out["failed"], [])
		self.assertEqual(out["skipped"], [])
		self.assertEqual(frappe.db.get_value(
			"Payment Entry", pe.name, "docstatus"), 1)
		# advance_paid SO & status bayaran booking dikemas kini oleh hook
		# standard (bukan oleh endpoint ini).
		self.assertAlmostEqual(float(frappe.db.get_value(
			"Sales Order", so.name, "advance_paid")), float(pe.paid_amount), places=2)
		self.assertEqual(frappe.db.get_value(
			"Booking", b.name, "payment_status"), "Partially Paid")

	def test_submit_failure_is_isolated_per_entry(self):
		b, so, pes = self._make_case(pe_shares=(0.5, 0.1))
		good, bad = pes
		from erpnext.accounts.doctype.payment_entry.payment_entry import PaymentEntry

		orig = PaymentEntry.on_submit

		def boom(self, *args, **kwargs):
			if self.name == bad.name:
				frappe.throw("forced failure (test)")
			return orig(self, *args, **kwargs)

		with patch.object(PaymentEntry, "on_submit", boom):
			out = booking_payments.submit_booking_payment_entries(
				booking=b.name, payment_entries=[bad.name, good.name])

		# PE gagal di-rollback ke savepoint; PE yang lain kekal disubmit.
		self.assertEqual(out["submitted"], [good.name])
		self.assertEqual([f["name"] for f in out["failed"]], [bad.name])
		self.assertIn("forced failure", out["failed"][0]["reason"])
		self.assertEqual(frappe.db.get_value(
			"Payment Entry", bad.name, "docstatus"), 0)
		self.assertEqual(frappe.db.get_value(
			"Payment Entry", good.name, "docstatus"), 1)
		self.assertAlmostEqual(float(frappe.db.get_value(
			"Sales Order", so.name, "advance_paid")), float(good.paid_amount), places=2)
		# Mesej ralat PE gagal TIDAK bocor sebagai msgprint kedua.
		self.assertFalse([m for m in frappe.message_log if "forced failure" in str(m)])

	def test_submit_rejects_entry_of_another_booking(self):
		b, _so, (pe,) = self._make_case()
		_other, _so2, (other_pe,) = self._make_case()
		# PE milik booking lain dihantar atas nama booking `b`.
		with self.assertRaises(frappe.ValidationError):
			booking_payments.submit_booking_payment_entries(
				booking=b.name, payment_entries=[pe.name, other_pe.name])
		# Semakan dibuat SEBELUM sebarang submit → tiada yang berubah.
		self.assertEqual(frappe.db.get_value("Payment Entry", pe.name, "docstatus"), 0)
		self.assertEqual(frappe.db.get_value(
			"Payment Entry", other_pe.name, "docstatus"), 0)

	def test_submit_skips_non_draft(self):
		b, _so, (pe,) = self._make_case()
		booking_payments.submit_booking_payment_entries(
			booking=b.name, payment_entries=[pe.name])
		# Hantar semula PE yang sudah submitted → dilangkau, bukan gagal.
		out = booking_payments.submit_booking_payment_entries(
			booking=b.name, payment_entries=[pe.name])
		self.assertEqual(out["submitted"], [])
		self.assertEqual(out["failed"], [])
		self.assertEqual([s["name"] for s in out["skipped"]], [pe.name])
		# Pilihan kosong ditolak.
		with self.assertRaises(frappe.ValidationError):
			booking_payments.submit_booking_payment_entries(
				booking=b.name, payment_entries=[])

	def test_submit_rejects_cancelled_booking(self):
		b, _so, (pe,) = self._make_case(booking_status="Cancelled")
		out = booking_payments.get_booking_payment_entries(booking=b.name)
		self.assertFalse(out["booking_payable"])
		self.assertEqual(out["booking_status"], "Cancelled")
		with self.assertRaises(frappe.ValidationError):
			booking_payments.submit_booking_payment_entries(
				booking=b.name, payment_entries=[pe.name])
		self.assertEqual(frappe.db.get_value("Payment Entry", pe.name, "docstatus"), 0)

	def test_submit_requires_payment_entry_permission(self):
		b, _so, (pe,) = self._make_case()
		# Tour Operator: ada akses page (MANAGE_TRIP_ROLES) TANPA kebenaran
		# submit Payment Entry.
		frappe.set_user(self._make_operator())
		self.assertFalse(booking_payments.get_booking_payment_entries(
			booking=b.name)["can_submit"])
		with self.assertRaises(frappe.PermissionError):
			booking_payments.submit_booking_payment_entries(
				booking=b.name, payment_entries=[pe.name])
		self.assertEqual(frappe.db.get_value("Payment Entry", pe.name, "docstatus"), 0)

	# ══════════════════════════════════════════════
	# REGISTER PAYMENT — rekod bayaran baru dari page
	# ══════════════════════════════════════════════

	def _make_operator(self):
		"""Tour Operator: create Payment Entry ✓, submit ✗."""
		if not frappe.db.exists("Role", "Tour Operator"):
			frappe.get_doc({"doctype": "Role", "role_name": "Tour Operator"}).insert()
		if not frappe.db.exists("User", OPERATOR):
			frappe.get_doc({
				"doctype": "User", "email": OPERATOR, "first_name": "PE Operator",
				"roles": [{"role": "Tour Operator"}],
			}).insert(ignore_permissions=True)
		return OPERATOR

	def _test_bank_account(self, so):
		paid_to = frappe.db.get_value(
			"Account", {"company": so.company, "account_type": "Bank",
						"is_group": 0, "account_currency": so.currency,
						"disabled": 0}, "name")
		if not paid_to:
			self.skipTest("tiada akaun Bank utk currency ujian")
		return paid_to

	def test_registration_context_effective_balance(self):
		b, so, _ = self._make_case(pe_shares=())
		out = booking_payments.get_payment_registration_context(booking=b.name)
		self.assertTrue(out["booking_payable"])
		self.assertEqual(out["booking_number"], b.booking_number)
		self.assertEqual(out["customer"], so.customer)
		self.assertEqual([s["name"] for s in out["sos"]], [so.name])
		row = out["sos"][0]
		self.assertAlmostEqual(row["effective_balance"], float(so.grand_total), places=2)
		self.assertEqual(row["reserved"], 0)
		info = out["accounts_by_currency"][row["currency"]]
		self.assertTrue(info["default"] or info["options"])

	def test_register_draft_then_verify(self):
		b, so, _ = self._make_case(pe_shares=())
		paid_to = self._test_bank_account(so)
		reg = booking_payments.register_booking_payment(
			booking=b.name, allocations={so.name: 100.0}, paid_to=paid_to,
			reference_no="TELLER-1", remarks="walk-in deposit")
		self.assertEqual(reg["docstatus"], 0)
		self.assertFalse(reg["submitted"])
		pe = frappe.get_doc("Payment Entry", reg["name"])
		self.assertEqual(pe.party_type, "Customer")
		self.assertEqual(pe.party, so.customer)
		self.assertEqual(pe.company, so.company)
		self.assertEqual(pe.paid_to, paid_to)
		self.assertEqual(pe.reference_no, "TELLER-1")
		self.assertAlmostEqual(pe.paid_amount, 100.0, places=2)
		self.assertAlmostEqual(pe.received_amount, 100.0, places=2)
		self.assertEqual(pe.references[0].reference_name, so.name)
		self.assertAlmostEqual(pe.references[0].allocated_amount, 100.0, places=2)

		# Draf mengurangkan BAKI EFEKTIF (bukan balance SO) — dua draf tak
		# boleh melampaui baki sebenar bila kedua-duanya disahkan nanti.
		out = booking_payments.get_payment_registration_context(booking=b.name)
		self.assertAlmostEqual(out["sos"][0]["reserved"], 100.0, places=2)
		self.assertAlmostEqual(out["sos"][0]["effective_balance"],
							   float(so.grand_total) - 100.0, places=2)
		with self.assertRaises(frappe.ValidationError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: float(so.grand_total)},
				paid_to=paid_to, reference_no="TELLER-2")

		# Draf yang didaftar disahkan melalui endpoint submit sedia ada.
		res = booking_payments.submit_booking_payment_entries(
			booking=b.name, payment_entries=[reg["name"]])
		self.assertEqual(res["submitted"], [reg["name"]])
		self.assertAlmostEqual(float(frappe.db.get_value(
			"Sales Order", so.name, "advance_paid")), 100.0, places=2)
		self.assertEqual(frappe.db.get_value(
			"Booking", b.name, "payment_status"), "Partially Paid")

	def test_register_submit_now(self):
		b, so, _ = self._make_case(pe_shares=())
		paid_to = self._test_bank_account(so)
		reg = booking_payments.register_booking_payment(
			booking=b.name, allocations={so.name: 100.0}, paid_to=paid_to,
			reference_no="TELLER-3", submit_now=True)
		self.assertTrue(reg["submitted"])
		self.assertEqual(reg["docstatus"], 1)
		self.assertAlmostEqual(float(frappe.db.get_value(
			"Sales Order", so.name, "advance_paid")), 100.0, places=2)

	def test_register_rejects_cancelled_booking(self):
		b, so, _ = self._make_case(booking_status="Cancelled")
		paid_to = self._test_bank_account(so)
		with self.assertRaises(frappe.ValidationError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: 10.0},
				paid_to=paid_to, reference_no="X")

	def test_register_rejects_bad_account(self):
		b, so, _ = self._make_case()
		with self.assertRaises(frappe.ValidationError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: 10.0},
				paid_to="NoSuch Account", reference_no="X")
		# Pilihan kosong ditolak
		with self.assertRaises(frappe.ValidationError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={}, reference_no="X")

	def test_register_with_attachments_plumbing(self):
		# Saluran lampiran — helper _attach_payment_files di-patch supaya
		# ujian TIDAK menulis fail ke cakera; laluan GUI sebenar diuji berasingan.
		b, so, _ = self._make_case(pe_shares=())
		paid_to = self._test_bank_account(so)
		calls = []
		with patch.object(booking_payments, "_attach_payment_files",
						  lambda pe, att: calls.append((pe, att)) or 2):
			reg = booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: 50.0}, paid_to=paid_to,
				reference_no="TELLER-ATT",
				attachments=[{"filedata": "data:image/png;base64,iVBORw0KGgo=",
							  "filename": "proof.png"}])
		self.assertEqual(reg["files"], 2)
		self.assertEqual(len(calls), 1)
		self.assertEqual(calls[0][0], reg["name"])
		self.assertEqual(calls[0][1][0]["filename"], "proof.png")
		self.assertEqual(frappe.db.count("File", {"attached_to_doctype": "Payment Entry",
			"attached_to_name": reg["name"]}), 0)

	def test_set_booking_status(self):
		# TM/SM sahaja; doc.save() penuh — status tersimpan & di-kekalkan.
		b, _so, _pes = self._make_case(pe_shares=())
		out = booking_payments.set_booking_status(booking=b.name, status="Processing")
		self.assertTrue(out["changed"])
		self.assertEqual(out["status"], "Processing")
		self.assertEqual(frappe.db.get_value("Booking", b.name, "status"), "Processing")
		# status tak berubah → changed False (tiada save)
		out2 = booking_payments.set_booking_status(booking=b.name, status="Processing")
		self.assertFalse(out2["changed"])
		with self.assertRaises(frappe.ValidationError):
			booking_payments.set_booking_status(booking=b.name, status="Nope")

	def test_set_booking_status_requires_manager(self):
		# Tour Operator: akses page ada TAPI approval status = TM/SM sahaja.
		user = self._make_operator()
		b, _so, _pes = self._make_case(pe_shares=())
		frappe.set_user(user)
		with self.assertRaises(frappe.PermissionError):
			booking_payments.set_booking_status(booking=b.name, status="Confirmed")

	def test_register_requires_account_permission(self):
		# Tour Operator: PE create ✓ TAPI tiada kebenaran BACA Account —
		# ERPNext menolak validate akaun party/bank; endpoint membaling
		# PermissionError awal dengan mesej jelas (draf & submit_now).
		user = self._make_operator()
		b, so, _ = self._make_case(pe_shares=())
		paid_to = self._test_bank_account(so)
		frappe.set_user(user)
		with self.assertRaises(frappe.PermissionError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: 10.0}, paid_to=paid_to,
				reference_no="TELLER-OP")
		with self.assertRaises(frappe.PermissionError):
			booking_payments.register_booking_payment(
				booking=b.name, allocations={so.name: 10.0}, paid_to=paid_to,
				reference_no="TELLER-OP2", submit_now=True)
