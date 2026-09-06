# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

import frappe
from frappe.tests import UnitTestCase

from travel_booking.api.inquiry import create_inquiry
from travel_booking.travel_booking_management.doctype.travel_inquiry.travel_inquiry import (
	derive_domain,
)


# GUNA UnitTestCase (BUKAN IntegrationTestCase): field "affiliate" link ke
# Sales Partner (ERPNext) — IntegrationTestCase akan cuba load test records
# untuk semua link dependencies dan mencetuskan crash BootStrapTestData
# ERPNext ("Duplicate entry 'Standard Buying'" Price List) pada site dengan
# master data sedia ada. Tiada auto-rollback — setiap test membersihkan
# rekodnya sendiri melalui addCleanup.
_TEST_REFERRAL_CODE = "TSTW1DG"


def _make_test_sales_partner() -> str:
	"""Cipta Sales Partner dengan referral_code untuk ujian attribution.

	Cukup sekadar Sales Partner — validate_affiliate_code() hanya menolak
	kod apabila Affiliate Profile berkaitan wujud dan berstatus selain
	"Verified" (tiada profile = kod diterima).
	"""
	name = "Test Inquiry Affiliate SP"
	if not frappe.db.exists("Sales Partner", name):
		frappe.get_doc(
			{
				"doctype": "Sales Partner",
				"partner_name": name,
				"referral_code": _TEST_REFERRAL_CODE,
				"commission_rate": 0,
			}
		).insert(ignore_permissions=True)
	return name


class TravelInquiryTestCase(UnitTestCase):
	"""
	Unit tests untuk Travel Inquiry + API floating chat widget.
	Merangkumi validasi borang, honeypot anti-bot, terbitan domain, dan
	attribution affiliate (Sales Partner).
	"""

	def _create(self, **kwargs):
		res = create_inquiry(**kwargs)
		self.addCleanup(self._delete_inquiry, res["name"])
		return res

	def _delete_inquiry(self, name):
		if name and frappe.db.exists("Travel Inquiry", name):
			frappe.delete_doc("Travel Inquiry", name, force=True, ignore_permissions=True)

	@classmethod
	def tearDownClass(cls):
		# Bersihkan sisa ujian (SP test + kaunter series) supaya run
		# berikutnya mula bersih.
		if frappe.db.exists("Sales Partner", "Test Inquiry Affiliate SP"):
			frappe.delete_doc(
				"Sales Partner", "Test Inquiry Affiliate SP", force=True, ignore_permissions=True
			)
		frappe.db.sql("DELETE FROM tabSeries WHERE name = 'INQ-2026-'")
		frappe.db.commit()
		super().tearDownClass()

	def test_create_inquiry_from_widget(self):
		res = self._create(
			prospect_name="Ali Bin Abu",
			phone="+60 12-345 6789",
			email="ali@example.com",
			message="Berapa harga cruise ke Langkawi?",
			source_page="https://cruise.rarecation.com/cruises",
		)
		self.assertTrue(res["ok"])
		self.assertTrue(res["name"].startswith("INQ"))

		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertEqual(doc.prospect_name, "Ali Bin Abu")
		self.assertEqual(doc.phone, "+60 12-345 6789")
		self.assertEqual(doc.email, "ali@example.com")
		self.assertEqual(doc.domain, "Cruise")
		self.assertEqual(doc.status, "New")

	def test_domain_derived_from_tour_page(self):
		res = self._create(
			prospect_name="Test Prospect",
			phone="+60123456789",
			source_page="https://rarecation.com/tours",
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertEqual(doc.domain, "Tour")

	def test_name_is_required(self):
		with self.assertRaises(frappe.ValidationError):
			create_inquiry(prospect_name="   ", phone="+60123456789")

	def test_phone_is_required(self):
		with self.assertRaises(frappe.ValidationError):
			create_inquiry(prospect_name="Ali", phone="")

	def test_invalid_phone_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			create_inquiry(prospect_name="Ali", phone="not-a-phone!!")

	def test_local_phone_without_country_code_rejected(self):
		# Phone fieldtype menguatkuasakan format INTERNATIONAL — nombor
		# tempatan tanpa country code (cth 0123456789) ditolak supaya data
		# sentiasa boleh dihubungi merentas negara.
		with self.assertRaises(frappe.ValidationError):
			create_inquiry(prospect_name="Ali", phone="0123456789")

	def test_invalid_email_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			create_inquiry(prospect_name="Ali", phone="+60123456789", email="bukan-email")

	def test_honeypot_silent_success_no_record(self):
		res = create_inquiry(
			prospect_name="Bot",
			phone="+60123456789",
			company_website="http://spam.example",
		)
		# Bot menerima respons "berjaya" tetapi tiada rekod dicipta.
		self.assertTrue(res["ok"])
		self.assertEqual(frappe.get_all("Travel Inquiry", filters={"prospect_name": "Bot"}), [])

	def test_success_message_returned(self):
		res = self._create(prospect_name="Ali", phone="+60123456789")
		self.assertTrue(res["ok"])
		self.assertTrue(res["message"])

	def test_derive_domain_helper(self):
		self.assertEqual(derive_domain("https://cruise.rarecation.com/"), "Cruise")
		self.assertEqual(derive_domain("https://rarecation.com/tours"), "Tour")
		self.assertEqual(derive_domain("https://trip.rarecation.com/some-slug"), "")
		self.assertEqual(derive_domain(""), "")

	def test_inquiry_with_valid_affiliate_code(self):
		sp_name = _make_test_sales_partner()
		res = self._create(
			prospect_name="Affiliate Prospect",
			phone="+60123456789",
			source_page="https://cruise.rarecation.com/cruises?sp=" + _TEST_REFERRAL_CODE,
			affiliate_code=_TEST_REFERRAL_CODE,
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertEqual(doc.affiliate, sp_name)
		self.assertEqual(doc.referral_code_used, _TEST_REFERRAL_CODE)

	def test_inquiry_with_invalid_affiliate_code_ignored(self):
		# Kod tak sah TIDAK menolak inquiry — attribution dibiarkan kosong.
		res = self._create(
			prospect_name="Bad Code Prospect",
			phone="+60123456789",
			source_page="https://cruise.rarecation.com/cruises",
			affiliate_code="NOSUCHCODE",
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertFalse(doc.affiliate)
		self.assertFalse(doc.referral_code_used)

	def test_inquiry_without_affiliate_code(self):
		res = self._create(
			prospect_name="Organic Prospect",
			phone="+60123456789",
			source_page="https://cruise.rarecation.com/cruise",
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertFalse(doc.affiliate)
		self.assertFalse(doc.referral_code_used)

	def test_inquiry_with_stale_trip_values_dropped(self):
		# Nilai session booknow yang korup/stale dibuang senyap —
		# lead tetap tersimpan, Link field dibiarkan kosong.
		res = self._create(
			prospect_name="Stale Session Prospect",
			phone="+60123456789",
			source_page="https://cruise.rarecation.com/booknow",
			trip="TRIP-9999-TAK-WUJUD",
			trip_group_date="RTRC-INVALID",
			trip_package="TP-INVALID",
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertFalse(doc.trip)
		self.assertFalse(doc.trip_group_date)
		self.assertFalse(doc.trip_package)

	def test_inquiry_without_trip_selection(self):
		# User luar wizard booknow — tiada pilihan trip, rekod tetap selamat.
		res = self._create(
			prospect_name="No Selection Prospect",
			phone="+60123456789",
			source_page="https://cruise.rarecation.com/cruises",
		)
		doc = frappe.get_doc("Travel Inquiry", res["name"])
		self.assertFalse(doc.trip)
		self.assertFalse(doc.trip_group_date)
		self.assertFalse(doc.trip_package)
