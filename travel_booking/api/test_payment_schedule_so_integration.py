# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Ujian INTEGRASI Fasa A (G1) — SO sebenar melalui validate ERPNext.

FrappeTestCase auto-rollback selepas setiap test — tiada data kekal.

Yang diuji: baris payment_schedule yang dibina oleh
_compute_schedule_rows() DITERIMA oleh Sales Order insert+submit penuh
ERPNext (PaymentScheduleService menghormati baris sedia ada;
validate_payment_schedule_amount menerima jumlah; validate_payment_
schedule_dates menerima due date baki). Jika ERPNext menu kelakuan
(versi naik taraf), test ni gagal — perlindungan regresi untuk corak
"kosongkan baris immediate auto + append baris travel" dalam
confirm_booking."""

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, getdate, today

from travel_booking.api.booking_engine import _compute_schedule_rows
from travel_booking.api.constants import TRAVEL_ITEM_CODE


class TestSOPaymentScheduleIntegration(FrappeTestCase):
	def test_so_accepts_travel_schedule_rows(self):
		if not frappe.db.exists("Item", TRAVEL_ITEM_CODE):
			self.skipTest("Item TRAVEL-PKG belum di-seed di site ujian")

		customer = frappe.get_all("Customer", limit=1)
		if not customer:
			self.skipTest("Site tiada Customer untuk ujian")
		company = frappe.get_all("Company", limit=1)[0].name
		company_currency = frappe.get_cached_value(
			"Company", company, "default_currency")

		departure = add_days(today(), 120)  # final window jauh → 2 baris
		delivery = add_days(today(), 1)

		so = frappe.get_doc({
			"doctype": "Sales Order",
			"customer": customer[0].name,
			"transaction_date": today(),
			"delivery_date": delivery,
			"order_type": "Sales",
			"company": company,
			"selling_price_list": "Standard Selling",
			"currency": company_currency,
			"conversion_rate": 1,
			"disable_rounded_total": 1,
			"items": [{
				"item_code": TRAVEL_ITEM_CODE,
				"qty": 2,
				"rate": 5000,
				"delivery_date": delivery,
			}],
		})
		so.insert(ignore_permissions=True)

		# Corak SAMA seperti confirm_booking: kosongkan baris immediate
		# auto-ERPNext, append baris travel, barulah submit.
		rows = _compute_schedule_rows(
			so.grand_total, 20, 60, departure, so.transaction_date)
		self.assertEqual(len(rows), 2, "Pra-syarat: kes ujian ialah 2 baris")
		so.payment_schedule = []
		for r in rows:
			so.append("payment_schedule", r)

		so.flags.ignore_permissions = True
		so.submit()  # tolak di sini = ERPNext tidak terima baris kita

		schedule = so.get("payment_schedule") or []
		self.assertEqual(len(schedule), 2)
		self.assertAlmostEqual(
			flt(sum(d.payment_amount for d in schedule), 2),
			flt(so.grand_total, 2), places=2,
			msg="Jumlah baris mesti == grand_total (ERPNext toleransi 0.1)")

		bal = next(d for d in schedule if d.description == "Balance Payment")
		self.assertEqual(str(getdate(bal.due_date)), str(add_days(getdate(departure), -60)),
			"Due date baki = departure − final_payment_days")
