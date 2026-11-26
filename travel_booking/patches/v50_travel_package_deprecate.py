import frappe


def execute():
	"""DEPRECATED PENUH Travel Package (Nov 2026 — keputusan pemilik):
	hierarki jualan = Trip >> Travel Date >> Package Offer (identiti sendiri).

	Migrasi idempoten:
	  1. Offer warisan yang masih kosong offer_name/offer_currency di-backfill
	     daripada Travel Package pautannya (nama + default_currency) supaya
	     SEMUA offer memenuhi kontrak identiti sendiri (enjin offer-mode).
	  2. Travel Package ditanda deprecated (banner Desk sudah dalam JSON)."""
	updated = 0
	for o in frappe.get_all(
			"Package Offer",
			fields=["name", "package", "offer_name", "offer_currency"],
			filters={"offer_currency": ["is", "not set"]}):
		if not o.package:
			continue
		vals = frappe.db.get_value(
			"Travel Package", o.package,
			["package_name", "default_currency"], as_dict=True)
		if not vals:
			continue
		frappe.db.set_value("Package Offer", o.name, {
			"offer_name": o.offer_name or vals.package_name,
			"offer_currency": vals.default_currency,
		}, update_modified=False)
		updated += 1
	frappe.db.commit()
	frappe.logger("patches").info({
		"patch": "v50_travel_package_deprecate",
		"offers_backfilled": updated})
