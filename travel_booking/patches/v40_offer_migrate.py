"""Patch v40: migrasi Trip Group Date → Package Offer (F2).

Pemetaan: SATU offer per (TGD × pakej yang memilihnya) — sebab inventori
dan harga adalah per-pakej. TGD yang dipilih 2 pakej (cth FC + CO) menghasil
2 offer (betul dalam semantik baharu).

SALIN: tarikh/sailing/kapal/pelabuhan (dari TGD), cruise_schedule (RUJUKAN
— sumber ops kekal satu), max/current_pax, days_before_closure.
STATUS: 8-status TGD → editorial (Active/Draft/Cancelled) + operational
(Scheduled/Running/Sailing/Full/Closed/Completed).
INVENTORI: allotment daripada Trip Package Price.cabin_allotment (per
kategori); sold = KIRAAN reservasi tak-cancelled melalui Booking.trip_date
— data SEBENAR, bukan anggaran.
HARGA: matriks disalin dari Travel Package.price_template (v39).

IDEMPOTENT & PRODUCTION-SAFE: skip bila offer sudah ada; kegagalan
per-offer dilog & diteruskan; tiada data lama disentuh.
"""
import frappe

from travel_booking.utils.offer_factory import (
	STATUS_EDITORIAL_MAP,
	STATUS_OPERATIONAL_MAP,
	create_offer,
	sold_from_reservations,
	seeds_from_allotment,
)


def execute():
	if frappe.db.count("Package Offer") > 0:
		print("v40: Package Offer sudah ada data — skip (idempotent)")
		return
	if not frappe.db.count("Trip Group Date"):
		print("v40: tiada Trip Group Date — tiada data untuk migrasi")
		return

	# peta pakej lama → baharu (kunci sama dengan v39: package_title atau name)
	title_to_new = {}
	for p in frappe.get_all("Travel Package", fields=["name", "package_name"]):
		title_to_new.setdefault(p.package_name, p.name)
	old_pkgs = {
		p.name: p
		for p in frappe.get_all("Trip Package", fields=["name", "package_title"])
	}

	created, skipped, failed = 0, 0, 0
	tgds = frappe.get_all("Trip Group Date", fields=["name"], order_by="departure_date asc")

	for tgd in tgds:
		selects = frappe.get_all(
			"Trip Package Group Date Select",
			filters={"trip_group_date": tgd.name},
			pluck="parent",
		)
		if not selects:
			skipped += 1
			continue

		tgd_doc = frappe.db.get_value(
			"Trip Group Date", tgd.name,
			["departure_date", "return_date", "sailing_start", "sailing_end",
			 "ship_name", "ship_code", "embarkation_port", "disembarkation_port",
			 "max_participants", "current_participants", "days_before_closure",
			 "cruise_schedule", "status", "trip_group_name"],
			as_dict=True,
		)
		for old_name in selects:
			old = old_pkgs.get(old_name)
			if not old:
				skipped += 1
				continue
			new_name = title_to_new.get(old.package_title or old.name)
			if not new_name:
				frappe.log_error(
					f"Pakej baharu tidak jumpa utk '{old.package_title or old.name}'",
					f"v40: skip {tgd.name}",
				)
				skipped += 1
				continue
			try:
				pkg = frappe.get_doc("Travel Package", new_name)

				# seeds: allotment (harga lama) + sold (reservasi sebenar,
				# DIFILTER ikut pakej — rujuk sold_from_reservations)
				sold_map = sold_from_reservations(tgd.name, old.name)
				seeds = seeds_from_allotment(pkg, old.name)
				code_to_docname = {}
				for o in (pkg.variant_options or []):
					if o.axis_code != "cabin":
						continue
					docname = frappe.db.get_value(
						"Trip Price Category",
						{"category_code": o.option_code},
						"name",
					) or (o.option_code if frappe.db.exists("Trip Price Category", o.option_code) else None)
					if docname:
						code_to_docname[o.option_code] = docname
				for opt_code, docname in code_to_docname.items():
					sold = sold_map.get(docname, 0)
					key = f"cabin:{opt_code}"
					if key in seeds:
						seeds[key]["sold"] = sold

				values = {
					"departure_date": tgd_doc.departure_date,
					"return_date": tgd_doc.return_date,
					"sailing_start": tgd_doc.sailing_start,
					"sailing_end": tgd_doc.sailing_end,
					"ship_name": tgd_doc.ship_name,
					"ship_code": tgd_doc.ship_code,
					"embarkation_port": tgd_doc.embarkation_port,
					"disembarkation_port": tgd_doc.disembarkation_port,
					"cruise_schedule": tgd_doc.cruise_schedule,
					"max_pax": int(tgd_doc.max_participants or 0),
					"current_pax": int(tgd_doc.current_participants or 0),
					"days_before_closure": int(tgd_doc.days_before_closure or 0),
					"status_editorial": STATUS_EDITORIAL_MAP.get(tgd_doc.status, "Draft"),
					"status_operational": STATUS_OPERATIONAL_MAP.get(tgd_doc.status, "Scheduled"),
					# provenance — rujukan silang lama→baharu (readiness F3,
					# recalc sold) — medan tersembunyi, read-only
					"legacy_tgd": tgd.name,
					"legacy_trip_package": old.name,
				}
				create_offer(new_name, values, inventory_seeds=seeds)
				created += 1
			except Exception:
				failed += 1
				frappe.log_error(frappe.get_traceback(), f"v40: gagal offer {tgd.name} × {old.name}")

	print(f"v40: {created} Package Offer dijana, {skipped} dilepasi, {failed} gagal")


def verify():
	"""Diff integriti selepas migrate (panggil manual)."""
	offers = frappe.get_all(
		"Package Offer",
		fields=["name", "package", "departure_date", "status_editorial",
				"status_operational", "max_pax"],
	)
	problems = []
	empty_prices = 0
	empty_inventory = 0
	total_sold = 0
	for o in offers:
		n_prices = frappe.db.count("Offer Price", {"parent": o.name})
		n_inv = frappe.db.count("Offer Inventory", {"parent": o.name})
		tmpl_active = frappe.db.count(
			"Package Price Template", {"parent": o.package, "active": 1}
		)
		if not n_prices:
			empty_prices += 1
		if n_prices != tmpl_active:
			problems.append(f"{o.name}: harga {n_prices} != templat aktif {tmpl_active}")
		if not n_inv:
			empty_inventory += 1
		total_sold += sum(
			int(r.sold or 0)
			for r in frappe.get_all("Offer Inventory", filters={"parent": o.name}, fields=["sold"])
		)

	print(f"offers: {len(offers)}")
	print(f"offer tanpa harga: {empty_prices}, tanpa inventori: {empty_inventory}")
	print(f"total sold (inventori): {total_sold}")
	print(f"masalah ({len(problems)}):")
	for p in problems[:20]:
		print("  -", p)
