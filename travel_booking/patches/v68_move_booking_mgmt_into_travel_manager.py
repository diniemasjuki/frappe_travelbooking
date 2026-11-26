import frappe


def execute():
	"""v68 — Booking Management dipindah ke dalam page travel-manager.

	Page standalone "booking-management" (module Travel Management,
	ciptaan Nov 2026) dipindahkan sebagai view penuh dalam page
	travel-manager (route 'booking'). Page di-sync daripada fail —
	reaper migrate buang rekod standard apabila fail dipadam; patch ini
	pembersihan eksplisit (belt & braces) + buang Module Def "Travel
	Management" yang tinggal kosong.
	"""
	if frappe.db.exists("Page", "booking-management"):
		frappe.delete_doc("Page", "booking-management", force=1, ignore_missing=True)

	if frappe.db.exists("Module Def", "Travel Management"):
		frappe.delete_doc("Module Def", "Travel Management", force=1, ignore_missing=True)
