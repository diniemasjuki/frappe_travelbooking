import frappe


def execute():
	"""RESTRUKTUR HIERARKI (Nov 2026): Trip >> Travel Date >> Packages.

	MASALAH: offer melatakan tarikh (1 offer per TGD×pakej) tanpa entiti
	Travel Date — tiada peringkat tarikh dalam hierarki/Travel Manager.

	MIGRASI (idempoten):
	  1. Kumpulkan offer mengikut `legacy_tgd` (setiap TGD lama = satu
	     Travel Date). Offer tanpa legacy_tgd dikumpulkan ikut
	     (trip, departure_date, cruise_schedule).
	  2. Setiap kumpulan → SATU Travel Date: trip daripada pakej offer
	     (fallback TGD.trip), cruise_schedule + sailing/ship/port +
	     departure/return daripada nilai offer (v40 menyalinnya daripada
	     TGD — nilai yang sama untuk seisi kumpulan), legacy_tgd
	     provenance, status = majoriti status_editorial offer.
	  3. Stamping: offer.travel_date = nama Travel Date kumpulannya.
	     Controller Travel Date (sync_to_offers/ensure_sailing_inventory)
	     DIJALANKAN sekali selepas stamping supaya medan salinan betul-betul
	     sepadan & baris Sailing Inventory lengkap.

	KESELAMATAN: 0 booking memegang package_offer (disahkan pra-migrasi di
	dev); db.set_value terus tanpa hook; kumpulan diproses satu-satu dengan
	log — kegagalan tidak menghentikan kumpulan lain."""
	# (trip, departure_date, cruise_schedule|'') atau legacy_tgd → kumpulan
	groups = {}

	offers = frappe.get_all(
		"Package Offer",
		filters={"travel_date": ["is", "not set"]},
		fields=["name", "package", "legacy_tgd", "cruise_schedule",
				"departure_date", "return_date", "sailing_start",
				"sailing_end", "ship_name", "ship_code",
				"embarkation_port", "disembarkation_port",
				"days_before_closure", "status_editorial"],
		order_by="departure_date asc",
	)

	# trip per pakej (satu panggilan pukal).
	pkg_trip = {}
	for p in frappe.get_all("Travel Package", fields=["name", "trip"]):
		pkg_trip[p.name] = p.trip

	# Medan TGD lama (untuk fallback trip & tarikh lebih tepat).
	tgd_rows = {
		t.name: t for t in frappe.get_all(
			"Trip Group Date",
			fields=["name", "trip", "departure_date", "return_date",
					"cruise_schedule", "sailing_start", "sailing_end",
					"ship_name", "ship_code", "embarkation_port",
					"disembarkation_port", "days_before_closure"])
	}

	def _key(o):
		if o.legacy_tgd:
			return ("tgd", o.legacy_tgd)
		return ("combo", pkg_trip.get(o.package) or "",
				str(o.departure_date), o.cruise_schedule or "")

	for o in offers:
		groups.setdefault(_key(o), []).append(o)

	created, stamped, skipped, failed = 0, 0, 0, 0
	for key, members in sorted(groups.items(), key=lambda kv: str(kv[0])):
		try:
			# Nilai sumber: TGD (paling tepat) → offer pertama kumpulan.
			if key[0] == "tgd":
				tgd = tgd_rows.get(key[1])
				src_trip = (tgd.trip if tgd else None) or \
					pkg_trip.get(members[0].package)
				src = tgd or members[0]
				legacy_tgd = key[1]
			else:
				src_trip = key[1] or pkg_trip.get(members[0].package)
				src = members[0]
				legacy_tgd = None
			if not src_trip:
				frappe.log_error(
					title="v48: kumpulan tanpa trip — skip",
					message="key={}".format(key),
				)
				skipped += len(members)
				continue

			# Idempoten: cari Travel Date sedia ada (legacy_tgd atau
			# kombinasi trip+departure+schedule).
			existing = None
			if legacy_tgd:
				existing = frappe.db.get_value(
					"Travel Date", {"legacy_tgd": legacy_tgd})
			if not existing:
				existing = frappe.db.get_value("Travel Date", {
					"trip": src_trip,
					"departure_date": src.departure_date,
					"cruise_schedule": src.cruise_schedule or "",
				})
			if not existing:
				statuses = [m.status_editorial for m in members]
				majority = max(set(statuses), key=statuses.count)
				doc = frappe.get_doc({
					"doctype": "Travel Date",
					"trip": src_trip,
					"departure_date": src.departure_date,
					"return_date": src.return_date,
					"cruise_schedule": src.cruise_schedule,
					"days_before_closure": src.days_before_closure,
					"status_editorial": majority if majority in
						("Draft", "Active", "Cancelled") else "Draft",
					"legacy_tgd": legacy_tgd,
				})
				# Field sailing/ship/port diisi oleh controller._sync_from_schedule.
				doc.insert(ignore_permissions=True)
				existing = doc.name
				created += 1

			for m in members:
				frappe.db.set_value("Package Offer", m.name,
									"travel_date", existing,
									update_modified=False)
				stamped += 1
		except Exception as e:
			failed += 1
			frappe.log_error(
				title="v48 Travel Date migrate failed",
				message="key={} : {}".format(key, e),
			)

	# Jalankan sync controller sekali untuk semua Travel Date baharu
	# (medan salinan offer + baris Sailing Inventory lengkap).
	for td in frappe.get_all("Travel Date", pluck="name"):
		try:
			doc = frappe.get_doc("Travel Date", td)
			doc.sync_to_offers()
			if doc.cruise_schedule:
				doc.ensure_sailing_inventory()
		except Exception as e:
			frappe.log_error(
				title="v48 sync Travel Date gagal",
				message="{} : {}".format(td, e),
			)

	frappe.db.commit()
	frappe.logger("patches").info({
		"patch": "v48_travel_date_migrate",
		"travel_dates_created": created,
		"offers_stamped": stamped,
		"offers_skipped": skipped,
		"groups_failed": failed,
	})
