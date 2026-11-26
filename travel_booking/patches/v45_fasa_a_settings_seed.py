import frappe


def execute():
	"""Fasa A: seed nilai permulaan tetapan baharu ke tabSingles.

	KENAPA: frappe.db.get_single_value() TIDAK fallback ke default doctype
	JSON — sehingga admin buka & simpan Travel Settings, bacaan kod
	mendapat None (⇒ ciri 'dimatikan'). Seed di sini supaya kelakuan
	lalai aktif serta-merta:
	  - default_final_payment_days = 30 (amalan cruise industry)
	  - hold_expiry_hours          = 72 (courtesy hold 24-72 jam)
	  - enable_payment_reminders   = 1  (T-30/T-7/T-1)

	Hanya isi bila baris Singles BELUM wujud — nilai yang admin telah
	tetapkan (termasuk 0 = matikan ciri) dihormati sepenuhnya. Kod
	dah pun null-safe: 0/None = ciri berkenaan dimatikan tanpa error."""
	defaults = {
		"default_final_payment_days": "30",
		"hold_expiry_hours": "72",
		"enable_payment_reminders": "1",
	}
	for field, value in defaults.items():
		existing = frappe.db.sql(
			"SELECT value FROM `tabSingles` WHERE doctype = 'Travel Settings' AND field = %s",
			(field),
		)
		if not existing:
			frappe.db.sql(
				"INSERT INTO `tabSingles` (doctype, field, value) VALUES ('Travel Settings', %s, %s)",
				(field, value),
			)
	frappe.db.commit()
	frappe.clear_cache(doctype="Travel Settings")
