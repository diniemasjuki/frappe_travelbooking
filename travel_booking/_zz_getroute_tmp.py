import frappe
r = frappe.db.get_value("Trip", {"published": 1, "status": "Active"}, "route")
print("ROUTE:" + str(r))
