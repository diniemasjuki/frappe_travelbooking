# [Nov 2026] Medan `segment` dibuang daripada doctype Trip Itinerary —
# segmentasi Pre/Cruise/Post-Cruise ditamatkan; timeline website dirender
# FLAT. Kolum lama diturunkan (frappe migrate TIDAK auto-drop kolum).

import frappe


def execute():
	if frappe.db.has_column("Trip Itinerary", "segment"):
		frappe.db.sql_ddl("ALTER TABLE `tabTrip Itinerary` DROP COLUMN `segment`")
