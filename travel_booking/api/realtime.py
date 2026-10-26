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
		allowed = bool(frappe.has_permission(doctype, ptype=ptype))
	else:
		# throw=False: tolakan (cth Guest cuba langganan room dokumen)
		# pulangkan False tanpa menaikkan PermissionError — tanpa ni
		# SETIAP tolakan melangganan realtime menulis traceback penuh
		# ke Error Log walaupun ia kelakhan normal socketio (server
		# mentafsir HTTP bukan-200 sebagai False, rujuk
		# frappe/realtime/auth.py Session.has_permission).
		allowed = bool(frappe.has_permission(doctype, doc=name, ptype=ptype))
	return allowed
