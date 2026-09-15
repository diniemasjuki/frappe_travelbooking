"""Nyah-penduakan Trip Package.package_code sebelum model sync.

Schema baharu menanda package_code sebagai unique. Kod dijana automatic
daripada (trip + singkatan package_type + airport/currency), jadi dua
pakej Cruise Only MYR untuk trip yang sama menghasilkan kod sama dan
menyebabkan migrate gagal:

    "package_code field cannot be set as unique in tabTrip Package,
     as there are non-unique existing values"

Patch berjalan PRE-model-sync supaya unique index boleh ditambah.
Peraturan: bagi setiap kumpulan pendua, dokumen TERLAMA (creation asc)
kekal dengan kod asal; yang lain diberi suffix "-2", "-3", ... . Field
tiada erti lookup (booking rujuk pakej melalui name), jadi suffix selamat.

Idempotent: bila tiada lagi pendua, patch tidak buat apa-apa.
"""

import frappe


def execute():
	duplicates = frappe.db.sql(
		"""
		SELECT package_code
		FROM `tabTrip Package`
		WHERE IFNULL(package_code, '') != ''
		GROUP BY package_code
		HAVING COUNT(*) > 1
		""",
		as_dict=True,
	)

	for row in duplicates:
		code = row.package_code
		names = frappe.get_all(
			"Trip Package",
			filters={"package_code": code},
			pluck="name",
			order_by="creation asc, modified asc, name asc",
		)

		# Yang terlama kekal dengan kod asal; yang lain diberi suffix berurutan.
		seq = 2
		for name in names[1:]:
			new_code = f"{code}-{seq}"
			while frappe.db.exists("Trip Package", {"package_code": new_code}):
				seq += 1
				new_code = f"{code}-{seq}"
			frappe.db.set_value(
				"Trip Package", name, "package_code", new_code, update_modified=False
			)
			seq += 1
