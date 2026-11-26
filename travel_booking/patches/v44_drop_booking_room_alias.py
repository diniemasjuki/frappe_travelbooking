"""Buang saki-baki doctype Booking Room Alias.

Feature nama paparan tersuai bilik (alias) telah dibuang sepenuhnya
daripada modul rooming — doctype tidak lagi wujud dalam kod app. Patch
ni memastikan SEMUA site konsisten: rekod DocType dipadam bila masih
ada (sesetengah site memadam secara manual), tabel orphan dijatuhkan.
Idempoten — selalu diulang pada site yang sudah bersih.
"""

import frappe


def execute():
	if frappe.db.exists("DocType", "Booking Room Alias"):
		frappe.delete_doc("DocType", "Booking Room Alias",
			ignore_permissions=True, force=True)
	frappe.db.sql_ddl("DROP TABLE IF EXISTS `tabBooking Room Alias`")
