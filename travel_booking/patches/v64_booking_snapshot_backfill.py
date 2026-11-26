"""Patch v64: Backfill snapshot operasional Booking offer-mode.

Medan snapshot Booking (departure_date, return_date, cruise_start/end,
is_cruise_only, package_type, total_days/total_night) dahulu fetch_from
TGD/Trip Package — offer booking (struktur baharu F5) dicipta dengan
nilai kosong/stale. confirm_booking kini stamp eksplisit; patch ni
backfill booking SEDIA ADA (hanya medan kosong — idempoten).
"""
import frappe
from frappe.utils import date_diff


def execute():
	fixed = 0
	rows = frappe.db.sql("""
		SELECT b.name, o.departure_date, o.return_date,
		       o.sailing_start, o.sailing_end, o.offer_name,
		       b.trip_date
		FROM `tabBooking` b
		INNER JOIN `tabPackage Offer` o ON o.name = b.package_offer
		WHERE IFNULL(b.package_offer, '') != ''
	""", as_dict=True)
	for r in rows:
		updates = {}
		if not frappe.db.get_value("Booking", r.name, "departure_date"):
			updates["departure_date"] = r.departure_date
		if not frappe.db.get_value("Booking", r.name, "return_date"):
			updates["return_date"] = r.return_date
		if not frappe.db.get_value("Booking", r.name, "cruise_start"):
			updates["cruise_start"] = r.sailing_start
		if not frappe.db.get_value("Booking", r.name, "cruise_end"):
			updates["cruise_end"] = r.sailing_end
		if not frappe.db.get_value("Booking", r.name, "package_type"):
			updates["package_type"] = r.offer_name
		# is_cruise_only: TGD anchor satu-satunya sumber
		if not frappe.db.get_value("Booking", r.name, "is_cruise_only"):
			if r.trip_date:
				updates["is_cruise_only"] = frappe.db.get_value(
					"Trip Group Date", r.trip_date, "is_cruise_only") or 0
		# total_days/night: kira daripada tarikh
		if (r.departure_date and r.return_date
				and not frappe.db.get_value("Booking", r.name, "total_days")):
			updates["total_days"] = date_diff(r.return_date, r.departure_date) + 1
			updates["total_night"] = date_diff(r.return_date, r.departure_date)
		if updates:
			frappe.db.set_value("Booking", r.name, updates)
			fixed += 1

	frappe.db.commit()
	print(f"v64 booking snapshot backfill: {fixed} booking dikemas kini")
