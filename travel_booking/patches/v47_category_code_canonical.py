import frappe


# Kod stabil untuk kategori cruise yang tiada category_code (Nov 2026).
# Konvensyen: inisial perkataan penting nama kategori, "(Khuzama)" dibuang,
# kekal unik dalam senarai Trip Price Category is_a_cruise=1.
_KOD_KATEGORI = {
	"Seaview Superior Cabin": "SSC",
	"Deluxe Suite (Khuzama)": "DS",
	"Grand Suite (Khuzama)": "GS",
	"Junior Suite (Khuzama)": "JS",
	"Premier Family Suite (Khuzama)": "PFS",
	"Premier Suite (Khuzama)": "PS",
	"Seaview Suite (Khuzama)": "SVS",
	"Superior Suite (Khuzama)": "SUPS",
	"Presidential Villa (Khuzama)": "PV",
	"Royal Villa (Khuzama)": "RV",
	"Signature Suite (Khuzama)": "SIG",
}


def execute():
	"""Peraturan relationship #1/#3 (Nov 2026): Trip Price Category sebagai
	SUMBER KANONIK price matrix & inventori.

	MASALAH (data dev): 11/16 kategori cruise TIADA category_code →
	option_code axis 'cabin' jatuh kepada NAMA PENUH → inventory_key jadi
	'cabin:Superior Suite (Khuzama)' & price_key 'Superior Suite
	(Khuzama)|ADULT' — pergantungan pada nama (rename = putus inventori)
	dan kunci hodah. Jambatan Variant Option.trip_price_category SELURUHNYA
	NULL (reka bentuk F5 tak pernah diisi).

	LANGKAH (idempoten):
	  1. Jana category_code untuk kategori cruise tanpa kod (peta tetap).
	  2. Backfill jambatan Variant Option.trip_price_category + tukar
	     option_code nama-panjang → kod (padan kategori ikut nama lama).
	  3. Tulis semula kunci kanonik: Sailing Inventory.inventory_key,
	     Offer Inventory.inventory_key, Offer Price.price_key & opt1,
	     Package Price Template.price_key & opt1 — 'cabin:<nama>' →
	     'cabin:<kod>', '<nama>|AGE' → '<kod>|AGE'.
	  4. Merge baris sailing yang menjadi sama selepas rewrite (cth dua
	     baris 'cabin:SSC' dari nama berbeza — tidak berlaku pada peta
	     sekarang, tapi guard tetap perlu).

	KESELAMATAN: tiada booking memegang snapshot kunci lama (disahkan 0
	pada dev sebelum patch); penulisan terus db.set_value tanpa trigger
	hook; setiap langkah boleh diulang (skip yang sudah betul)."""
	# ── Langkah 1: kod kategori ──
	for name, code in _KOD_KATEGORI.items():
		if not frappe.db.exists("Trip Price Category", name):
			continue
		cur = frappe.db.get_value("Trip Price Category", name, "category_code")
		if cur:
			if cur != code:
				frappe.log_error(
					title="v47: kod kategori berbeza dari peta",
					message="{} sedia ada kod '{}' (peta: '{}') — kekal "
							"kod sedia ada.".format(name, cur, code),
				)
			continue
		frappe.db.set_value("Trip Price Category", name,
							{"category_code": code}, update_modified=False)

	# nama → kod (selepas langkah 1)
	name_to_code = {
		n: (frappe.db.get_value("Trip Price Category", n, "category_code") or c)
		for n, c in _KOD_KATEGORI.items()
	}

	# ── Langkah 2: jambatan Variant Option + option_code kanonik ──
	bridged = 0
	for vo in frappe.get_all("Variant Option",
			filters={"axis_code": "cabin"},
			fields=["name", "option_code", "trip_price_category",
					"option_name", "parent"]):
		code = name_to_code.get(vo.option_code)
		if not code:
			# option_code dah berbentuk kod (BC/IC/dsb.) — hanya perlu
			# jambatan ikut kod → kategori.
			cat = frappe.db.get_value("Trip Price Category",
									  {"category_code": vo.option_code}, "name")
			if cat and not vo.trip_price_category:
				frappe.db.set_value("Variant Option", vo.name,
					{"trip_price_category": cat}, update_modified=False)
				bridged += 1
			continue
		# nama-panjang → kod + jambatan ke kategori asal.
		cat = frappe.db.get_value("Trip Price Category",
								  {"name": vo.option_code}, "name")
		frappe.db.set_value("Variant Option", vo.name, {
			"option_code": code,
			"trip_price_category": cat,
		}, update_modified=False)
		bridged += 1

	# ── Langkah 3: rewrite kunci kanonik ──
	rewritten = 0
	for old_name, code in name_to_code.items():
		# Sailing Inventory — merge jika baris kod sudah wujud (guard).
		for row in frappe.get_all("Sailing Inventory",
				filters={"inventory_key": "cabin:" + old_name},
				fields=["name", "cruise_schedule", "allotment", "sold",
						"allotment_partner"]):
			new_key = "cabin:" + code
			dup = frappe.db.get_value("Sailing Inventory", {
				"cruise_schedule": row.cruise_schedule,
				"inventory_key": new_key,
				"name": ["!=", row.name],
			})
			if dup:
				# gabung: allotment/sold dijumlah, partner kekal pada
				# baris dup (asumsi single-partner per kunci — model v1).
				d = frappe.db.get_value("Sailing Inventory", dup,
					["allotment", "sold"], as_dict=True)
				frappe.db.set_value("Sailing Inventory", dup, {
					"allotment": int(d.allotment or 0) + int(row.allotment or 0),
					"sold": int(d.sold or 0) + int(row.sold or 0),
				}, update_modified=False)
				frappe.db.set_value("Sailing Inventory", dup,
					"available",
					int(d.allotment or 0) + int(row.allotment or 0)
					- int(d.sold or 0) - int(row.sold or 0),
					update_modified=False)
				frappe.delete_doc("Sailing Inventory", row.name,
								  ignore_permissions=True, force=True)
			else:
				frappe.db.set_value("Sailing Inventory", row.name,
					"inventory_key", new_key, update_modified=False)
			rewritten += 1
		# Offer Inventory (shadow pra-fix) — rewrite senyap supaya
		# cross-check & dialog kekal konsisten.
		frappe.db.sql(
			"UPDATE `tabOffer Inventory` SET inventory_key = %s "
			"WHERE inventory_key = %s",
			("cabin:" + code, "cabin:" + old_name))
		# Offer Price + Package Price Template — price_key/opt1.
		# '<nama>|AGE' → '<kod>|AGE' (ganti segmen pertama sebelum '|').
		for dt in ("Offer Price", "Package Price Template"):
			frappe.db.sql(
				"UPDATE `tab{}` SET price_key = CONCAT(%s, '|', SUBSTRING_INDEX(price_key, '|', -1)) "
				"WHERE price_key LIKE %s".format(dt),
				(code, old_name + "|%"))
			frappe.db.sql(
				"UPDATE `tab{}` SET opt1 = %s WHERE opt1 = %s".format(dt),
				(code, old_name))

	frappe.db.commit()
	frappe.logger("patches").info({
		"patch": "v47_category_code_canonical",
		"kod_dijana": sum(1 for n, c in name_to_code.items() if c),
		"jambatan_variant_option": bridged,
		"kunci_ditulis": rewritten,
	})
