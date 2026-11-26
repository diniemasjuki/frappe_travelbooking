"""Patch v63: Sambungan penuh Booking → Trip / Travel Date.

Booking struktur baharu (F5 offer-mode) dicipta tanpa trip_name/trip_title
(hanya diisi kod versi lama) dan tiada link terus ke Travel Date — jadual
Booking nampak "tak connected" pada Desk. Patch ni backfill:

  1. Booking ber-package_offer → travel_date (dari offer), trip_name
     (dari Travel Date.trip), trip_title (dari Trip.trip_name).
  2. Booking legacy yang trip_name kosong tapi trip_date terisi →
     trip_name/trip_title daripada TGD.

Idempoten — hanya isi medan yang kosong.
"""
import frappe


def execute():
	fixed = 0

	# ── 1) Booking offer-mode ──
	rows = frappe.db.sql("""
		SELECT b.name, o.travel_date, td.trip
		FROM `tabBooking` b
		INNER JOIN `tabPackage Offer` o ON o.name = b.package_offer
		INNER JOIN `tabTravel Date` td ON td.name = o.travel_date
		WHERE IFNULL(b.trip_name, '') = ''
		  AND IFNULL(b.package_offer, '') != ''
	""", as_dict=True)
	for r in rows:
		trip_title = frappe.db.get_value("Trip", r.trip, "trip_name") or ""
		frappe.db.set_value("Booking", r.name, {
			"trip_name": r.trip,
			"trip_title": trip_title,
			"travel_date": r.travel_date,
		})
		fixed += 1

	# ── 2) Booking legacy tanpa trip_name ──
	rows = frappe.db.sql("""
		SELECT b.name, tgd.trip
		FROM `tabBooking` b
		INNER JOIN `tabTrip Group Date` tgd ON tgd.name = b.trip_date
		WHERE IFNULL(b.trip_name, '') = ''
		  AND IFNULL(b.trip_date, '') != ''
	""", as_dict=True)
	for r in rows:
		trip_title = frappe.db.get_value("Trip", r.trip, "trip_name") or ""
		frappe.db.set_value("Booking", r.name, {
			"trip_name": r.trip,
			"trip_title": trip_title,
		})
		fixed += 1

	frappe.db.commit()
	print(f"v63 booking trip linkage: {fixed} booking dibackfill")
