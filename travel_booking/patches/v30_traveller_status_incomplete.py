import frappe


def execute():
	"""Rename status Traveller 'Pending' → 'Incomplete' — termasuk
	cerminnya pada Booking Reservation.document_status (fetch_from
	traveller.status, diselaraskan sync_status_to_reservations)."""
	frappe.db.sql("""
		UPDATE `tabTraveller`
		SET status = 'Incomplete'
		WHERE status = 'Pending'
	""")
	frappe.db.sql("""
		UPDATE `tabBooking Reservation`
		SET document_status = 'Incomplete'
		WHERE document_status = 'Pending'
	""")
