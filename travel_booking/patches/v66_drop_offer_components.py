"""Patch v66: PADAM doctype Offer Component + baris yatim (v65-era).

Field `components` (Table → Offer Component, "Resolved Components") pada
Package Offer dibuang daripada doctype (Nov 2026). Audit kod: field ini
WRITE-ONLY — diisi offer_factory semasa offer dicipta, tetapi 0 pembaca
(komponen aktif dibaca terus daripada Trip.default_components). Patch ni
padam doctype child dan DROP jadual `tabOffer Component` bersama baris
snap-shot lama (idempoten — semak kewujudan dahulu).
"""
import frappe


def execute():
	# delete_doc padam metadata doctype SAHAJA — jadual child kekal
	# sebagai yatim, jadi DROP secara eksplisit.
	if frappe.db.exists("DocType", "Offer Component"):
		frappe.delete_doc("DocType", "Offer Component",
						  force=1, ignore_permissions=True)
		print("v66: doctype Offer Component dipadam")

	if frappe.db.sql("SHOW TABLES LIKE 'tabOffer Component'"):
		frappe.db.sql("DROP TABLE `tabOffer Component`")
		print("v66: jadual tabOffer Component di-drop")
	frappe.db.commit()
	print("v66: drop offer components selesai")
