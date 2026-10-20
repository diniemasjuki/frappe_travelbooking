import frappe

OLD_MODULE = "Travel Booking Management"
NEW_MODULE = "Module Travel Booking"
# Module Def lama yang folder/failnya telah dibuang daripada app — dipadam
# selepas semua doctype/rekod diserahkan kepada module baharu.
STALE_MODULES = [OLD_MODULE, "Travel Booking"]


def execute():
	"""Migrasi module 'Travel Booking Management' → 'Module Travel Booking'.

	Sinkronisasi fail (bench migrate) sudah mengemaskini 'module' pada
	DocType/Workspace/Sidebar/Notification/Page daripada JSON — gelung
	set_value di bawah ialah jaring keselamatan untuk rekod yang tidak
	disemak semula semasa sync (cth. rekod diubah suai secara manual di
	Desk). Nama jadual/data transaksi tidak disentuh.
	"""
	for doctype in (
		"DocType",
		"Workspace",
		"Sidebar",
		"Notification",
		"Page",
		"Report",
		"Dashboard Chart",
		"Print Format",
		"Telegram Notification",
		"Web Form",
		"Number Card",
	):
		if not frappe.db.exists("DocType", doctype):
			continue
		if not frappe.get_meta(doctype).has_field("module"):
			continue
		frappe.db.set_value(
			doctype,
			{"module": OLD_MODULE},
			"module",
			NEW_MODULE,
			update_modified=False,
		)

	for module in STALE_MODULES:
		if not frappe.db.exists("Module Def", module):
			continue
		# Jangan padam sekiranya masih ada doctype bernaung di bawahnya
		# (cth. sync belum selesai) — biarkan rekod Module Def sahaja.
		if frappe.db.count("DocType", {"module": module}):
			continue
		frappe.delete_doc("Module Def", module, force=True, ignore_permissions=True)
