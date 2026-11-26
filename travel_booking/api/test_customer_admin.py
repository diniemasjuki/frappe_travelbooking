# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Integration tests untuk API direktori Customer (customer_admin.py).

Corak IntegrationTestCase (rollback automatik antara test — data ujian
tidak kekal dalam site):
- Bentuk respons direktori + carian server-side (nama/email kontak).
- Bentuk respons detail (contacts ber-flag portal-user, bookings,
  kewangan per currency, loyalty_enabled).
- Gate bacaan: Guest ditolak (PermissionError).
- Gate struktur: tukar customer_type/group/disabled = Tour Manager /
  System Manager sahaja — Operator (write role contact/address) ditolak
  untuk medan struktur.
- Mutasi: save_customer_info, save_customer_contact (row email LAMA
  kekal — resolusi portal tidak putus), save_customer_address (upsert
  Billing + pointer customer_primary_address).
"""

import frappe
from frappe.tests import IntegrationTestCase

from travel_booking.api import customer_admin


class CustomerAdminDirectoryTestCase(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")
		# Customer autoname = naming_series → docname dijana; tangkap nama
		# SEBENAR selepas insert (rollback antara test memadamkan ia).
		doc = frappe.get_doc({
			"doctype": "Customer",
			"customer_name": "Test Customer Directory",
			"customer_type": "Individual",
			"customer_group": frappe.db.get_value(
				"Customer Group", {"is_group": 0}, "name") or "Individual",
			"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
		})
		doc.insert(ignore_permissions=True)
		self.customer_name = doc.name
		# Contact + link Customer (resolver portal bergantung padanya).
		contact = frappe.get_doc({
			"doctype": "Contact",
			"first_name": "Test",
			"last_name": "Customer Directory",
			"email_ids": [{"email_id": "old@example.test", "is_primary": 1}],
			"phone_nos": [{"phone": "+60-111111111", "is_primary_phone": 1}],
			"links": [{"link_doctype": "Customer",
				"link_name": self.customer_name}],
		})
		contact.insert(ignore_permissions=True)
		self.contact_name = contact.name

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	def test_directory_shape_and_row_fields(self):
		out = customer_admin.get_customers_directory()
		self.assertIsInstance(out, dict)
		for key in ("customers", "total", "loyalty_enabled"):
			self.assertIn(key, out)
		self.assertIsInstance(out["loyalty_enabled"], bool)
		self.assertGreaterEqual(out["total"], 1)
		# Row ujian mesti hadir dengan medan yang dijanakan server.
		row = next((c for c in out["customers"]
			if c["name"] == self.customer_name), None)
		self.assertIsNotNone(row, "row test customer tiada dalam direktori")
		for key in ("email", "phone", "bookings", "balances",
				"outstanding_total", "credit_total", "customer_group"):
			self.assertIn(key, row)
		self.assertEqual(row["email"], "old@example.test")
		self.assertEqual(row["bookings"], 0)
		self.assertEqual(row["balances"], [])

	def test_directory_search_matches_email_and_name(self):
		# Carian email kontak (Contact Email → Dynamic Link).
		out = customer_admin.get_customers_directory(search="old@example.test")
		self.assertTrue(any(c["name"] == self.customer_name
			for c in out["customers"]))
		# Carian nama customer.
		out = customer_admin.get_customers_directory(search="Test Customer Directory")
		self.assertTrue(any(c["name"] == self.customer_name
			for c in out["customers"]))
		# Carian yang tiada padanan → kosong, total 0.
		out = customer_admin.get_customers_directory(search="zzz-no-match-zzz")
		self.assertEqual(out["customers"], [])
		self.assertEqual(out["total"], 0)

	def test_guest_is_rejected(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			customer_admin.get_customers_directory()
		with self.assertRaises(frappe.PermissionError):
			customer_admin.get_customer_detail(self.customer_name)

	def test_detail_shape(self):
		out = customer_admin.get_customer_detail(self.customer_name)
		self.assertEqual(out["customer"]["name"], self.customer_name)
		self.assertIn("loyalty_enabled", out)
		# Contacts: 1 contact, email lama primary, tiada portal user.
		self.assertEqual(len(out["contacts"]), 1)
		ct = out["contacts"][0]
		self.assertFalse(ct["is_portal_user"])
		self.assertEqual(ct["emails"][0]["email"], "old@example.test")
		self.assertTrue(ct["emails"][0]["is_primary"])
		# Struktur wajib untuk paparan detail.
		for key in ("addresses", "bookings", "bookings_total", "channel_split",
				"finance", "b2b"):
			self.assertIn(key, out)
		self.assertIsNone(out["b2b"])

	def test_detail_not_found_throws(self):
		with self.assertRaises(frappe.DoesNotExistError):
			customer_admin.get_customer_detail("ZZZ-NO-SUCH-CUSTOMER")


class CustomerAdminSaveTestCase(IntegrationTestCase):
	def setUp(self):
		super().setUp()
		frappe.set_user("Administrator")
		# Autoname naming series → tangkap docname sebenar (rollback
		# antara test memadamkan customer setiap kali).
		doc = frappe.get_doc({
			"doctype": "Customer",
			"customer_name": "Test Customer Save",
			"customer_type": "Individual",
			"customer_group": frappe.db.get_value(
				"Customer Group", {"is_group": 0}, "name") or "Individual",
			"territory": frappe.db.get_value("Territory", {"is_group": 0}, "name"),
		})
		doc.insert(ignore_permissions=True)
		self.customer_name = doc.name
		# User Operator (write role) — gate medan struktur mesti menolaknya.
		if not frappe.db.exists("Role", "Tour Operator"):
			frappe.get_doc({"doctype": "Role", "role_name": "Tour Operator"}).insert()
		self.operator = "test-cust-operator@example.test"
		if not frappe.db.exists("User", self.operator):
			frappe.get_doc({
				"doctype": "User",
				"email": self.operator,
				"first_name": "Test",
				"last_name": "Operator",
				"send_welcome_email": 0,
				"roles": [{"role": "Tour Operator"}],
			}).insert(ignore_permissions=True)
		# Contact ber-email lama — ujian "email lama kekal" (resolver
		# portal bergantung pada row itu).
		contact = frappe.get_doc({
			"doctype": "Contact",
			"first_name": "Test",
			"last_name": "Customer Save",
			"email_ids": [{"email_id": "old@example.test", "is_primary": 1}],
			"phone_nos": [{"phone": "+60-111111111", "is_primary_phone": 1}],
			"links": [{"link_doctype": "Customer",
				"link_name": self.customer_name}],
		})
		contact.insert(ignore_permissions=True)
		self.contact_name = contact.name

	def tearDown(self):
		frappe.set_user("Administrator")
		super().tearDown()

	def test_save_customer_info_rename_and_type(self):
		import json
		out = customer_admin.save_customer_info(json.dumps({
			"name": self.customer_name,
			"customer_name": "Test Customer Save Renamed",
			"customer_type": "Company",
		}))
		self.assertEqual(out["status"], "ok")
		cn, ctype = frappe.db.get_value("Customer", self.customer_name,
			["customer_name", "customer_type"])
		self.assertEqual(cn, "Test Customer Save Renamed")
		self.assertEqual(ctype, "Company")
		# Autoname naming series — nama dokumen TIDAK berubah.
		self.assertTrue(frappe.db.exists("Customer", self.customer_name))

	def test_structural_fields_require_manager(self):
		import json
		frappe.set_user(self.operator)
		# Operator boleh tulis (contact/address) — TAPI medan struktur
		# (type/group/disabled) manager-gated.
		with self.assertRaises(frappe.PermissionError):
			customer_admin.save_customer_info(json.dumps({
				"name": self.customer_name, "customer_type": "Company"}))
		with self.assertRaises(frappe.PermissionError):
			customer_admin.save_customer_info(json.dumps({
				"name": self.customer_name, "disabled": 1}))
		frappe.set_user("Administrator")
		# Manager lulus.
		out = customer_admin.save_customer_info(json.dumps({
			"name": self.customer_name, "disabled": 1}))
		self.assertEqual(out["status"], "ok")

	def test_save_customer_contact_keeps_old_email_row(self):
		# Email lama mesti KEKAL (dinyah-primary) — resolusi portal
		# Customer-by-email bergantung padanya.
		out = customer_admin.save_customer_contact(
			self.customer_name, email="new@example.test",
			phone="+60-222222222")
		self.assertEqual(out["status"], "ok")
		emails = frappe.get_all("Contact Email",
			filters={"parent": out["contact"]},
			fields=["email_id", "is_primary"], order_by="is_primary desc")
		self.assertEqual(len(emails), 2)
		self.assertEqual(emails[0]["email_id"], "new@example.test")
		self.assertEqual(emails[0]["is_primary"], 1)
		self.assertEqual(emails[1]["email_id"], "old@example.test")
		self.assertEqual(emails[1]["is_primary"], 0)

	def test_save_customer_address_upsert_billing(self):
		import json
		out = customer_admin.save_customer_address(self.customer_name, json.dumps({
			"address_line1": "Jalan Test 1", "city": "Kuala Lumpur",
			"state": "Wilayah Persekutuan", "postcode": "50000",
			"country": "Malaysia",
		}))
		self.assertEqual(out["status"], "ok")
		addr = frappe.db.get_value("Address", out["address"],
			["address_type", "is_primary_address", "address_line1"], as_dict=True)
		self.assertEqual(addr.address_type, "Billing")
		self.assertEqual(addr.is_primary_address, 1)
		self.assertEqual(addr.address_line1, "Jalan Test 1")
		# Pointer primary customer diset (helper yang sama dgn wizard).
		pointer = frappe.db.get_value("Customer", self.customer_name,
			"customer_primary_address")
		self.assertEqual(pointer, out["address"])
		# Upsert kedua KEMASKINI alamat sama (bukan duplikasi).
		out2 = customer_admin.save_customer_address(self.customer_name, json.dumps({
			"address_line1": "Jalan Test 2", "city": "Kuala Lumpur",
			"postcode": "50000", "country": "Malaysia",
		}))
		self.assertEqual(out2["address"], out["address"])
		linked = frappe.db.count("Dynamic Link",
			{"parenttype": "Address", "link_doctype": "Customer",
			"link_name": self.customer_name})
		self.assertEqual(linked, 1)

	def test_save_customer_address_requires_country(self):
		import json
		with self.assertRaises(frappe.ValidationError):
			# Negara tidak dikenali → helper _upsert_customer_billing_address
			# melempar (jangan simpan alamat rosak).
			customer_admin.save_customer_address(self.customer_name, json.dumps({
				"address_line1": "X", "city": "Y",
				"country": "Atlantis"}))
