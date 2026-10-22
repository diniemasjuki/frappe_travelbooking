# Override frappe.realtime.has_permission — dipindahkan daripada modifikasi
# tempatan frappe core (frappe/realtime/__init__.py, telah direvert).
#
# Server socketio (frappe/realtime/auth.py) membuat HTTP call ke
# /api/method/frappe.realtime.has_permission bagi setiap semakan permission
# subscribe room. Bila desk membuka borang dokumen BARU, room dinamakan
# ikut docname lokal yang belum disimpan (`new-<doctype>-<rawak>`) — tiada
# rekod dalam DB, jadi semakan doc-level menimbulkan DoesNotExistError;
# permission aras doctype yang memerintah borang tersebut.
#
# Dipasang melalui hooks.py:
#   override_whitelisted_methods = {
#       "frappe.realtime.has_permission": "travel_booking.api.realtime.has_permission",
#   }

import frappe


@frappe.whitelist(allow_guest=True)
def has_permission(doctype: str, name: str, ptype: str = "read") -> bool:
	if name.startswith("new-"):
		# Dokumen belum pernah disimpan — gunakan semakan aras doctype.
		frappe.has_permission(doctype, ptype=ptype, throw=True)
	else:
		frappe.has_permission(doctype, doc=name, ptype=ptype, throw=True)
	return True
