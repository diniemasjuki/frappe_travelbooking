import frappe


def execute():
	"""FIX relationship trip-package-offer (Nov 2026).

	MASALAH: v40 mencipta 1 offer per (TGD × pakej) dan menyalin inventori
	ke SETIAP offer — kabin fizikal yang sama dijual berulang kali merentas
	offer-offer sailing yang sama (cth AC01263: 5 offer × cabin:BC).

	FIX: naiktaraf inventori kabin ke paras SAILING (doctype baharu
	Sailing Inventory, 1 baris per (cruise_schedule × inventory_key)).
	Migrasi:
	  1. Setiap offer yang ada cruise_schedule: kumpulkan inventorinya
	     merentas SEMUA offer sailing yang sama → JUMLAH kanan jadi baris
	     Sailing Inventory (sold dijumlah sebab setiap offer menjejak
	     tempahannya sendiri; allotment dijumlah sebab staf dah isi
	     berulang pada setiap offer — jumlah itu ialah anggaran blok
	     terbaik; staf semak/baiki selepas ni).
	  2. Offer TANPA cruise_schedule: kekal guna Offer Inventory (tak
	     disentuh).

	KEKAL: Offer Inventory pada offer (bagai bayangan/shadow) TIDAK
	dipadam — kit semak lintas (cross_check_structure) & dialog Kuota &
	Harga masih baca dia sehingga UI dialihkan. Tulis-path (booking) sudah
	diarah ke Sailing Inventory oleh offer_factory.

	IDEMPOTEN: baris Sailing Inventory sedia ada di-skip per kunci;
	kegagalan per-sailing dilog & diteruskan."""
	from travel_booking.module_trip_management.doctype.sailing_inventory.sailing_inventory import (
		SailingInventory,
	)

	# (cruise_schedule, inventory_key) → agregat merentas offer sailing sama
	agg = {}
	offers = frappe.get_all(
		"Package Offer",
		filters={"cruise_schedule": ["is", "set"]},
		fields=["name", "cruise_schedule"],
	)
	for o in offers:
		for row in frappe.get_all(
			"Offer Inventory", filters={"parent": o.name},
			fields=["inventory_key", "allotment", "sold", "allotment_partner"],
		):
			k = (o.cruise_schedule, row.inventory_key)
			cur = agg.setdefault(k, {"allotment": 0, "sold": 0,
									"allotment_partner": row.allotment_partner})
			cur["allotment"] += int(row.allotment or 0)
			cur["sold"] += int(row.sold or 0)

	created, skipped = 0, 0
	for (schedule, key), vals in sorted(agg.items()):
		if frappe.db.exists("Sailing Inventory", {
				"cruise_schedule": schedule, "inventory_key": key}):
			skipped += 1
			continue
		try:
			# allotment >= sold WAJIB (controller validate). Data offer lama
			# boleh ada sold > 0 dengan allotment 0 (tempahan pra-kuota /
			# offer dicipta dengan seeds sold sahaja) — angkat allotment ke
			# sekurang-kurangnya sold supaya rekod sebenar TIDAK hilang.
			# Staf semak/baiki blok sebenar selepas ni di dialog Kuota & Harga.
			allot = max(vals["allotment"], vals["sold"])
			frappe.get_doc({
				"doctype": "Sailing Inventory",
				"cruise_schedule": schedule,
				"inventory_key": key,
				"allotment": allot,
				"sold": vals["sold"],
				"allotment_partner": vals.get("allotment_partner") or None,
			}).insert(ignore_permissions=True)
			created += 1
		except Exception as e:
			frappe.log_error(
				title="v46 Sailing Inventory migrate failed",
				message="{} / {}: {}".format(schedule, key, e),
			)

	frappe.db.commit()
	frappe.logger("patches").info({
		"patch": "v46_sailing_inventory_migrate",
		"sailings": len({s for s, _ in agg}),
		"rows_created": created,
		"rows_skipped": skipped,
	})
