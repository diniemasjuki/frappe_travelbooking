"""Buang doctype Share Slot Reservation — kembali ke stamp
Booking Reservation.sales_order (reka bentuk v15) untuk idempotensi
aktivasi slot traveller tambahan (rujuk api/cabin_sharing.py).

Latar: v17 memindahkan stamp ke junction Share Slot Reservation.
Reka bentuk junction dibuang — kod kini membaca & menulis stamp terus
pada slot Booking Reservation (field sales_order kembali dalam doctype
JSON, sync oleh model sync SEBELUM patch post_model_sync ni jalan).

Patch ni:
1. Backfill stamp daripada data junction sedia ada — setiap baris
   Share Slot Reservation di-stamp pada Booking Reservation
   berkenaan. Data audit slot SO ↔ reservation KEKAL, cuma lokasi
   simpanan berubah. Konflik (reservation dah ber-stamp SO lain)
   dilog ke Error Log, junction tetap dipadam — konflik tak mungkin
   dalam operasi normal (satu slot satu SO sumber).
2. Langkau syarat khusus site lama: kolum Booking
   Reservation.sales_order wajib wujud (hasil model sync doctype JSON
   baharu). Kalau tak wujud (sync belum berlaku / custom float), patch
   ni no-op supaya boleh diulang — JANGAN buat apa-apa destruktif
   tanpa stamp diselamatkan.
3. Buang kunci asing / kolum junction selepas stamp diselamatkan:
   DROP TABLE `tabShare Slot Reservation`. Rekod DocType itu sendiri
   dibuang oleh frappe.model.sync.remove_orphan_doctypes() di hujung
   bench migrate (fail JSON doctype dah tiada dari repo) — buangan
   metadata itu tidak menyentuh data, jadi DROP TABLE di sini ialah
   buangan data yang sahih.

Idempoten — selamat dijalankan berulang: table_exists guard pada setiap
langkah. Site baharu (junction tak pernah wujud) → no-op terus.
"""

import frappe

_JUNCTION = "Share Slot Reservation"


def execute():
	if not frappe.db.has_column("Booking Reservation", "sales_order"):
		# Model sync belum sync field stamp — jangan buat apa-apa; patch
		# tidak berdaftar sebagai gagal (site kekal berfungsi dengan kod
		# junction lama sehingga sync lengkap). Dalam amali, post_model_sync
		# sentiasa jalan SELEPAS sync doctype, jadi laluan ni luar biasa.
		return

	# 1. Backfill stamp daripada junction (kalau table masih wujud).
	if frappe.db.table_exists(_JUNCTION):
		rows = frappe.get_all(
			_JUNCTION,
			fields=["name", "sales_order", "booking_reservation", "booking"])
		for row in rows:
			res = row.booking_reservation
			if not res or not frappe.db.exists("Booking Reservation", res):
				continue
			existing = frappe.db.get_value("Booking Reservation", res, "sales_order")
			if existing:
				if existing != row.sales_order:
					frappe.log_error(
						"Remove Share Slot Reservation: reservation " + str(res)
						+ " sudah ber-stamp SO " + str(existing)
						+ " tetapi junction " + str(row.name)
						+ " membawa SO " + str(row.sales_order)
						+ ". Stamp sedia ada dikekalkan; semak manual.",
						"Remove Share Slot Reservation")
				continue
			frappe.db.set_value("Booking Reservation", res,
			                    "sales_order", row.sales_order or "",
			                    update_modified=False)

		# 2. Buang table junction — data telah dipindahkan ke stamp.
		frappe.db.sql_ddl("DROP TABLE IF EXISTS `tab%s`" % _JUNCTION)

	# Kunci meta "dalam flight": kalau rekod DocType junction masih ada
	# (fail JSON dah tiada — reaper akan buang di hujung migrate), buang
	# awal di sini supaya tiada codepath lain sempat menyentuhnya. delete_doc
	# DocType tidak drop table data — itu sebab DROP TABLE dilakukan
	# eksplisit di atas; kalau table telah dibuang, delete_doc tetap selamat.
	if frappe.db.exists("DocType", _JUNCTION):
		frappe.delete_doc("DocType", _JUNCTION, force=True,
		                  ignore_missing=True)
		frappe.db.commit()
