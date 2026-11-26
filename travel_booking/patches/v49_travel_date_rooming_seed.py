import frappe


def execute():
	"""MODEL BERLAPIS (Nov 2026): seed child Travel Date Rooming (SLICE
	group) bagi setiap Travel Date cruise — dari kolam Sailing Inventory
	schedule tarikh itu (slice lalai = kuota kolam; gate pool menguatkuasa
	penghad keras merentas group semasa tempahan). Idempoten: kategori yang
	sudah ada di-skip."""
	created, tds = 0, 0
	for td in frappe.get_all(
			"Travel Date",
			filters={"cruise_schedule": ["is", "set"]},
			pluck="name"):
		tds += 1
		schedule = frappe.db.get_value("Travel Date", td, "cruise_schedule")
		existing = set(frappe.get_all(
			"Travel Date Rooming",
			filters={"parent": td, "parenttype": "Travel Date"},
			pluck="room_category"))
		for pool in frappe.get_all(
				"Sailing Inventory",
				filters={"cruise_schedule": schedule},
				fields=["inventory_key", "allotment"]):
			key = pool.inventory_key or ""
			code = key.split(":", 1)[1].split("|", 1)[0] if ":" in key else key
			if not code:
				continue
			cat = frappe.db.get_value(
				"Trip Price Category", {"category_code": code}, "name") \
				or frappe.db.get_value("Trip Price Category", {"name": code}, "name")
			if not cat or cat in existing:
				continue
			try:
				frappe.get_doc({
					"doctype": "Travel Date Rooming",
					"parent": td, "parenttype": "Travel Date",
					"parentfield": "rooming",
					"room_category": cat,
					"allotment": int(pool.allotment or 0),
					"sold": 0,
					"available": int(pool.allotment or 0),
				}).insert(ignore_permissions=True)
				existing.add(cat)
				created += 1
			except Exception as e:
				frappe.log_error(title="v49 seed rooming gagal",
								 message="{} : {}".format(td, e))
	frappe.db.commit()
	frappe.logger("patches").info({
		"patch": "v49_travel_date_rooming_seed",
		"travel_dates": tds, "rows_created": created})
