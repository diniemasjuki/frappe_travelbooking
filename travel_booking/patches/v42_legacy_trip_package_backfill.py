"""Patch v42: backfill provenance Travel Package.legacy_trip_package (F5).

Aliran tulis booking bila flag use_package_offers ON memerlukan peta
pakej baharu → Trip Package lama (rujuk resolve_legacy_from_offer).
Isi medan KOSONG SAHAJA (fill-empty-only, idempotent) melalui peta tajuk
yang sama dengan v39: package_name == (package_title or name) lama.
Pakej tanpa padanan dilog untuk tindakan manual.
"""
import frappe


def execute():
	title_to_old = {}
	for old in frappe.get_all("Trip Package", fields=["name", "package_title"]):
		title_to_old.setdefault(old.package_title or old.name, old.name)

	filled, unmatched = 0, []
	for pkg in frappe.get_all(
		"Travel Package",
		filters={"legacy_trip_package": ["is", "not set"]},
		fields=["name", "package_name"],
	):
		old_name = title_to_old.get(pkg.package_name)
		if old_name:
			frappe.db.set_value("Travel Package", pkg.name,
				"legacy_trip_package", old_name, update_modified=False)
			filled += 1
		else:
			unmatched.append(pkg.name)

	print(f"v42: {filled} legacy_trip_package di-backfill, "
		  f"{len(unmatched)} tanpa padanan")
	if unmatched:
		print(f"v42: manual check — {unmatched[:10]}")
