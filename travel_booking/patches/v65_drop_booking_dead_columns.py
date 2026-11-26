"""Patch v65: DROP kolum Booking yang medannya dibuang (v64-era).

Medan deprecated (0 pembaca kod — disahkan audit Nov 2026) dibuang
daripada doctype; sebahagian kolum DB kekal yatim. Patch ni DROP kolum
tersebut (idempoten — semak kewujudan dahulu).
"""
import frappe

_DEAD = [
	"trip_status",
	"trip_date_group_status",
	"trip_package_status",
	"trip_date_group_name",
	"trip_package_name",
	"order_summary",  # sudah drop pada sesetengah site — guard
]


def execute():
	dropped = []
	for col in _DEAD:
		has = frappe.db.sql(
			"SHOW COLUMNS FROM `tabBooking` LIKE %s", (col,))
		if has:
			frappe.db.sql(f"ALTER TABLE `tabBooking` DROP COLUMN `{col}`")
			dropped.append(col)
	frappe.db.commit()
	print(f"v65 drop booking dead columns: {dropped or 'tiada (idempoten)'}")
