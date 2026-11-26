# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian INTEGRASI Fasa 1d/1e — pindaan booking SELEPAS diterima.

Ujian E2E melalui endpoint booking_edit (bukan fungsi dalaman):

- create_cabin_upgrade_order (Fasa 1d): kes PENUH + BERINVOIS — SO
  utama kekal, delta ditanggung SO tambahan "Upgrade" (registri
  purpose "Upgrade", item TRAVEL-UPG), Booking Item tukar kategori,
  audit Communication ditulis.
- get_roommate_match_state + apply_roommate_match (Fasa 1e): dua solo
  "Open Sharing" dipadankan — penempatan room_id merentas booking,
  kadar single → twin in-place pada KEDUA-DUA SO, credit_balance
  dilaporkan tanpa auto-refund (payment_status "Request Refund").

Fixture: pakej + harga + Customer + axis currency sedia ada pada site
ujian — skip senyap bila fixture tiada. db.commit() endpoint
di-no-op-kan dalam test supaya semua data kekal dalam transaksi dan
di-rollback oleh pembersihan kelas.
"""

import frappe
from frappe.tests import IntegrationTestCase
from unittest.mock import patch

from travel_booking.api import booking_edit
from travel_booking.api.constants import TRAVEL_ITEM_CODE, UPGRADE_ITEM_CODE
from travel_booking.api.currency_axis import get_currency_axis
from travel_booking.api.so_helpers import (
	_item_spec,
	_link_booking_sales_order,
	_write_booking_items,
)


def _price_fixture():
	"""(trip_package, cat_low, cat_high + kadar) — SATU pakej dengan dua
	kategori ber-harga: cat_high lebih mahal (kes upgrade), cat_low
	berkadar single > twin (kes roommate match)."""
	row = frappe.db.sql("""
		select p1.parent as trip_package,
		       p1.pricing_for_class as cat_low,
		       p1.price_adult as adult_low,
		       p1.price_adult_single as single_low,
		       p2.pricing_for_class as cat_high,
		       p2.price_adult as adult_high
		from `tabTrip Package Price` p1
		join `tabTrip Package Price` p2
		     on p2.parent = p1.parent and p2.parenttype = 'Trip Package'
		where p1.parenttype = 'Trip Package'
		  and p1.price_adult > 0
		  and p1.price_adult_single > p1.price_adult
		  and p2.price_adult > p1.price_adult
		  and p2.pricing_for_class != p1.pricing_for_class
		order by p1.parent, p1.pricing_for_class
		limit 1
	""", as_dict=True)
	return row[0] if row else None


def _axis_default():
	"""Baris paksi currency default (currency → company + price list) —
	sama resolusi _resolve_so_currency_and_rate untuk SO tambahan."""
	axis = get_currency_axis()
	for r in axis:
		if r.get("is_default"):
			return r
	return axis[0] if axis else None


def _make_primary_so(customer, currency, company, price_list, lines):
	so = frappe.get_doc({
		"doctype": "Sales Order",
		"customer": customer,
		"company": company,
		"transaction_date": frappe.utils.today(),
		"delivery_date": frappe.utils.add_days(frappe.utils.today(), 60),
		"order_type": "Sales",
		"selling_price_list": price_list or "Standard Selling",
		"currency": currency,
		"conversion_rate": 1,
		"disable_rounded_total": 1,
		"items": [dict(l, delivery_date=frappe.utils.add_days(
			frappe.utils.today(), 60)) for l in lines],
	})
	so.insert(ignore_permissions=True)
	so.flags.ignore_permissions = True
	so.submit()
	return so


def _make_booking(booking_number, customer, trip_package, trip_date, so, specs):
	"""Booking + registri SO utama + baris Booking Item — cermin kabelan
	confirm_booking selepas SO disubmit."""
	b = frappe.get_doc({
		"doctype": "Booking",
		"booking_number": booking_number,
		"status": "Accepted",
		"payment_status": "Pending",
		"customer": customer,
		"trip_package": trip_package,
		"trip_date": trip_date,
		"is_a_cruise_trip": 1,
		"checkout_method": "Manual Transfer",
	}).insert(ignore_permissions=True)
	_link_booking_sales_order(b.name, so.name, "Main Booking")
	_write_booking_items(b.name, so.name, specs, so.currency)
	return b


def _make_reservation(booking_name, room_category):
	return frappe.get_doc({
		"doctype": "Booking Reservation",
		"booking": booking_name,
		"room_category": room_category,
		"cabin_no": 1,
		"pax_type": "Main Guest",
		"room_privacy": "Open Sharing",
		"is_a_cruise": 1,
	}).insert(ignore_permissions=True)


class BookingAmendmentsTestCase(IntegrationTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.fx = _price_fixture()
		cls.axis = _axis_default()
		cls.tgd = frappe.db.get_value("Trip Group Date", {"is_a_cruise_trip": 1}, "name") \
			or frappe.db.get_value("Trip Group Date", {}, "name")
		cls.customer = frappe.get_all("Customer", limit=1, pluck="name")

	def _fixture_ok(self):
		return bool(self.fx and self.axis and self.tgd and self.customer)

	def setUp(self):
		super().setUp()
		# Endpoint pindaan melakukan db.commit() (corak request) — no-op-kan
		# supaya semua mutasi kekal dalam transaksi kelas dan di-rollback.
		patcher = patch.object(frappe.db, "commit", lambda *a, **kw: None)
		patcher.start()
		self.addCleanup(patcher.stop)

	# ══════════════════════════════════════════════
	# FASA 1d — CABIN UPGRADE (kes PENUH + BERINVOIS)
	# ══════════════════════════════════════════════

	def _make_upgrade_case(self):
		"""Booking 2 traveller kategori rendah, dibayar penuh + berinvois."""
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		fx, axis = self.fx, self.axis
		customer = self.customer[0]
		lines = [{
			"item_code": TRAVEL_ITEM_CODE,
			"item_name": "{0} (Cabin 1) \u2014 Main Guest".format(fx.cat_low),
			"qty": 2,
			"rate": float(fx.adult_low),
			"uom": "Nos",
			"description": ("Test Trip | Test Group | {0} | Cabin 1 | "
			                "Main Guest").format(fx.cat_low),
		}]
		so = _make_primary_so(customer, axis.get("currency"),
		                      axis.get("company"), axis.get("selling_price_list"), lines)
		# Simulasi bayaran penuh (tanpa PE — cukup untuk _so_state).
		frappe.db.set_value("Sales Order", so.name, "advance_paid", so.grand_total)

		b = _make_booking("RTESTUP" + frappe.utils.random_string(4).upper(),
		                  customer, fx.trip_package, self.tgd, so,
		                  [_item_spec(fx.cat_low, 1, "Main Guest", fx.adult_low),
		                   _item_spec(fx.cat_low, 1, "Main Guest", fx.adult_low)])

		# Invois kan SO utama → keadaan paid_invoiced.
		# (corak import sama _maybe_auto_invoice_so)
		from erpnext.selling.doctype.sales_order.mapper import make_sales_invoice
		si = frappe.get_doc(make_sales_invoice(so.name))
		si.insert(ignore_permissions=True)
		si.flags.ignore_permissions = True
		si.submit()
		self.assertEqual(booking_edit._so_state(so.name)["state"], "paid_invoiced")
		return b, so

	def test_create_cabin_upgrade_order_paid_invoiced(self):
		b, so = self._make_upgrade_case()
		fx = self.fx
		billed = round(2 * float(fx.adult_low), 2)
		expected_delta = round(2 * float(fx.adult_high) - billed, 2)

		result = booking_edit.create_cabin_upgrade_order(
			booking=b.name, cabin_no=1, new_category=fx.cat_high,
			reason="customer requested balcony upgrade")

		self.assertTrue(result["success"])
		self.assertAlmostEqual(result["delta"], expected_delta, places=2)

		# SO tambahan "Upgrade": item TRAVEL-UPG, rate = delta, submitted.
		uso = frappe.get_doc("Sales Order", result["upgrade_sales_order"])
		self.assertEqual(uso.docstatus, 1)
		self.assertEqual(uso.items[0].item_code, UPGRADE_ITEM_CODE)
		self.assertAlmostEqual(float(uso.items[0].rate), expected_delta, places=2)
		self.assertIn(fx.cat_high, (uso.items[0].description or ""))

		# SO utama KEKAL sepenuhnya (tiada cancel-amend).
		so.reload()
		self.assertEqual(so.docstatus, 1)
		self.assertAlmostEqual(float(so.grand_total), billed, places=2)

		# Registri: purpose "Upgrade" berdaftar pada booking.
		purposes = frappe.get_all(
			"Booking Sales Order",
			filters={"parent": b.name, "parenttype": "Booking"},
			pluck="purpose")
		self.assertIn("Upgrade", purposes)

		# Booking Item: kategori baharu, unit_price BEKU (SO utama kekal).
		items = frappe.get_all(
			"Booking Item",
			filters={"parent": b.name, "parenttype": "Booking"},
			fields=["room_category", "unit_price"])
		self.assertEqual(len(items), 2)
		for i in items:
			self.assertEqual(i.room_category, fx.cat_high)
			self.assertAlmostEqual(float(i.unit_price), float(fx.adult_low), places=2)

		# Baki agregat booking == delta (delta tertunggak).
		self.assertAlmostEqual(result["balance"], expected_delta, places=2)

		# Audit Communication ditulis pada Booking.
		self.assertTrue(frappe.db.exists("Communication", {
			"reference_doctype": "Booking", "reference_name": b.name,
			"subject": "Booking Edit: Cabin Upgrade Order"}))

	def test_create_cabin_upgrade_order_rejects_not_invoiced(self):
		b, so = self._make_upgrade_case()
		# Batalkan invois → keadaan bukan paid_invoiced.
		si_name = frappe.db.get_value("Sales Invoice Item",
			{"sales_order": so.name}, "parent")
		if not si_name:
			self.skipTest("invois ujian tidak wujud")
		si = frappe.get_doc("Sales Invoice", si_name)
		si.flags.ignore_permissions = True
		si.cancel()
		self.assertNotEqual(booking_edit._so_state(so.name)["state"], "paid_invoiced")

		with self.assertRaises(frappe.ValidationError):
			booking_edit.create_cabin_upgrade_order(
				booking=b.name, cabin_no=1, new_category=self.fx.cat_high,
				reason="should reject — not invoiced")

	# ══════════════════════════════════════════════
	# FASA 1e — ROOMMATE MATCH (solo Open Sharing → twin)
	# ══════════════════════════════════════════════

	def _make_solo(self, gender):
		"""Satu booking solo cruise — kadar single, Open Sharing, berbayar
		penuh (tanpa invois), reservation aktif + gender diisytiharkan."""
		fx, axis = self.fx, self.axis
		customer = self.customer[0]
		single_rate = float(fx.single_low)
		lines = [{
			"item_code": TRAVEL_ITEM_CODE,
			"item_name": "{0} (Cabin 1) \u2014 Main Guest (Single)".format(fx.cat_low),
			"qty": 1,
			"rate": single_rate,
			"uom": "Nos",
			"description": ("Test Trip | Test Group | {0} | Cabin 1 | "
			                "Main Guest (Single)").format(fx.cat_low),
			"custom_room_privacy": "Open Sharing",
			"custom_roommate_gender": gender,
		}]
		so = _make_primary_so(customer, axis.get("currency"),
		                      axis.get("company"), axis.get("selling_price_list"), lines)
		frappe.db.set_value("Sales Order", so.name, "advance_paid", single_rate)

		b = _make_booking(
			"RTESTRM" + frappe.utils.random_string(4).upper(),
			customer, fx.trip_package, self.tgd, so,
			[_item_spec(fx.cat_low, 1, "Main Guest", single_rate,
			            rate_basis="Single", room_privacy="Open Sharing")])
		res = _make_reservation(b.name, fx.cat_low)
		return b, so, res

	def test_get_roommate_match_state_finds_candidate(self):
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		b1, _so1, _res1 = self._make_solo("Female")
		b2, _so2, _res2 = self._make_solo("Female")
		fx = self.fx

		state = booking_edit.get_roommate_match_state(b1.name)

		self.assertTrue(state["eligible"], state.get("reason"))
		solo = state["solo"]
		self.assertEqual(solo["room_category"], fx.cat_low)
		self.assertAlmostEqual(solo["single_rate"], float(fx.single_low), places=2)
		self.assertAlmostEqual(solo["twin_rate"], float(fx.adult_low), places=2)
		self.assertAlmostEqual(
			solo["excess"],
			round(float(fx.single_low) - float(fx.adult_low), 2), places=2)
		cand_names = [c["booking"] for c in state["candidates"]]
		self.assertIn(b2.name, cand_names)

	def test_apply_roommate_match_twin_share(self):
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		b1, so1, res1 = self._make_solo("Female")
		b2, so2, res2 = self._make_solo("Female")
		fx = self.fx
		single_rate = float(fx.single_low)
		adult_rate = float(fx.adult_low)
		expected_credit = round(single_rate - adult_rate, 2)

		result = booking_edit.apply_roommate_match(
			booking=b1.name, partner_booking=b2.name, reason="matched by operator")

		self.assertTrue(result["success"])

		# KEDUA-DUA SO: baris single diharga semula in-place kepada kadar
		# twin — label "(Single)" dibuang, nombor SO KEKAL (tiada
		# cancel-amend).
		for so_name in (so1.name, so2.name):
			it = frappe.get_value("Sales Order Item",
				{"parent": so_name, "item_code": TRAVEL_ITEM_CODE},
				["name", "rate", "description", "item_name"], as_dict=True)
			self.assertAlmostEqual(float(it.rate or 0), adult_rate, places=2)
			self.assertNotIn("(Single)", it.description or "")
			self.assertNotIn("(Single)", it.item_name or "")
		so1.reload(); so2.reload()
		self.assertEqual(so1.docstatus, 1)
		self.assertEqual(so2.docstatus, 1)
		self.assertAlmostEqual(float(so1.grand_total), adult_rate, places=2)
		self.assertAlmostEqual(float(so2.grand_total), adult_rate, places=2)

		# Booking Item kedua-dua sisi: Standard + kadar twin.
		for bn in (b1.name, b2.name):
			row = frappe.get_value("Booking Item",
				{"parent": bn, "parenttype": "Booking"},
				["rate_basis", "unit_price"], as_dict=True)
			self.assertEqual(row.rate_basis, "Standard")
			self.assertAlmostEqual(float(row.unit_price or 0), adult_rate, places=2)

		# Penempatan: joiner membawa room_id bilik pemilik, kedua-dua
		# reservation → Private (corak _activate_share_traveller_reservation).
		r1 = frappe.get_doc("Booking Reservation", res1.name)
		r2 = frappe.get_doc("Booking Reservation", res2.name)
		self.assertTrue(r1.room_id)
		self.assertEqual(r2.room_id, r1.room_id)
		self.assertEqual(r1.room_privacy, "Private")
		self.assertEqual(r2.room_privacy, "Private")

		# Credit dilaporkan TANPA auto-refund — payment_status
		# "Request Refund" (dilindungi REFUND_PAYMENT_STATES).
		for side in (result["owner"], result["joiner"]):
			self.assertAlmostEqual(side["credit_balance"], expected_credit, places=2)
			self.assertEqual(side["payment_status"], "Request Refund")
		for bn in (b1.name, b2.name):
			self.assertEqual(frappe.db.get_value("Booking", bn, "payment_status"),
			                 "Request Refund")

		# Audit Communication ditulis pada KEDUA-DUA booking.
		for bn in (b1.name, b2.name):
			self.assertTrue(frappe.db.exists("Communication", {
				"reference_doctype": "Booking", "reference_name": bn,
				"subject": "Booking Edit: Roommate Matched \u2014 Twin Share"}))

	def test_apply_roommate_match_rejects_same_booking(self):
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		b1, _so1, _res1 = self._make_solo("Female")

		with self.assertRaises(frappe.ValidationError):
			booking_edit.apply_roommate_match(
				booking=b1.name, partner_booking=b1.name, reason="invalid pair")

	def test_apply_roommate_match_rejects_gender_mismatch(self):
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		b1, _so1, _res1 = self._make_solo("Female")
		b3, _so3, _res3 = self._make_solo("Male")

		with self.assertRaises(frappe.ValidationError):
			booking_edit.apply_roommate_match(
				booking=b1.name, partner_booking=b3.name, reason="gender mismatch")

	def test_apply_roommate_match_rejects_no_reason(self):
		if not self._fixture_ok():
			self.skipTest("fixture site ujian tidak lengkap")
		b1, _so1, _res1 = self._make_solo("Female")
		b2, _so2, _res2 = self._make_solo("Female")

		with self.assertRaises(frappe.ValidationError):
			booking_edit.apply_roommate_match(
				booking=b1.name, partner_booking=b2.name, reason="  ")
