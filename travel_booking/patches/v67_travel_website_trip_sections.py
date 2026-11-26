"""Patch v67: Seed Trip Listing Sections homepage cruise (Travel Website).

Seksyen listing trip homepage /cruise kini dikawal child table
Website Trip Listing Section (Travel Website → Cruise Homepage →
Trip Listing Sections) — menggantikan auto-grouping kategori +
medan statik cruise_featured_* yang dibuang.

Site sedia ada belum ada baris → seed satu seksyen per Trip Category
cruise (is_cruise_trip=1) supaya homepage kekal berisi produk selepas
deploy. Label/tag seksyen diwarisi cruise_featured_tag lama jika ada
(nilai tabSingles kekal walaupun medan dah dibuang). Tiada kategori
cruise → tiada baris (homepage kosong sehingga admin konfigurasi).

IDEMPOTENT: hanya append bila child table kosong; jangan sentuh baris
yang admin sudah tambah. Clear cache config supaya homepage serta-merta
baca konfigurasi baharu.
"""
import frappe

from travel_booking.install import _default_cruise_trip_sections


def execute():
	if not frappe.db.exists("DocType", "Travel Website"):
		return

	doc = frappe.get_doc("Travel Website", "Travel Website")
	if doc.get("cruise_trip_sections"):
		print("v67: cruise_trip_sections sudah dikonfigurasi — skip")
		return

	rows = _default_cruise_trip_sections()
	if not rows:
		print("v67: tiada Trip Category cruise — tiada seed")
	else:
		# Warisi tag lama "Featured Voyages" jika pernah di-set sebelum
		# medan cruise_featured_tag dibuang (tabSingles kekal wujud).
		# db.get_value tak boleh guna pada tabSingles — dia tambah
		# ORDER BY creation yang tiada pada jadual itu.
		old_tag = frappe.db.sql(
			"SELECT `value` FROM `tabSingles`"
			" WHERE `doctype` = 'Travel Website' AND `field` = 'cruise_featured_tag'"
		)
		old_tag = (old_tag[0][0] if old_tag else "") or ""
		for row in rows:
			if old_tag:
				row["section_label"] = old_tag
			doc.append("cruise_trip_sections", row)
		doc.save(ignore_permissions=True)
		print(f"v67: {len(rows)} Trip Listing Section di-seed")

	# Homepage baca config melalui cache — kosongkan supaya baharu nampak.
	frappe.cache().delete_value("travel_website_config")
