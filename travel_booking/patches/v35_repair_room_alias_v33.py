"""Baiki kerosakan patch v33_room_alias_migrate pada data sedia ada.

PUNCA: v33 (versi asal) menganggap SETIAP room_id ≠ label auto sebagai
"nama tersuai" dan memindahkannya ke Booking Room Alias. Dua kelas data
tersalah tafsir:

1. PENEMPATAN OPEN SHARING MERENTAS BOOKING — reservation tetamu booking
   A yang membawa room_id bilik booking B ('<bnum_lain>-Room_<n>') BUKAN
   nama tersuai; ia penempatan sebenar. v33 memindahkannya ke alias DAN
   reset room_id reservation kepada ID bilik booking sendiri — tetamu
   itu kelihatan "sudah balik ke bilik asal" pada setiap paparan bilik
   (get_group_rooming group ikut room_id), sedangkan alias bilik booking
   A kini mengandungi ID mekanikal bilik B sebagai "nama" (label bercampur
   'X-Room_1 (Y-Room_1)' pada papan/modal).
2. AUTO ID DENGAN booking_number SALAH — v33 mengira label auto dari
   snapshot br.booking_number, yang kerap KOSONG pada rekod dicipta
   server-side (_activate_booking / cabin_sharing); fallback dia ialah
   docname Booking ('BK…'), jadi room_id sebenar 'R…-Room_1' nampak
   "berbeza" dan turut dipindahkan ke alias secara salah.

Patch ni (idempoten):
1. PADAM alias yang custom_name-nya berbentuk ID mekanikal
   ('…-Room_<n>') — semuanya sampah v33 (nama sebenar tidak pernah
   berbentuk ID; validate doctype kini menyekat bentuk ini).
2. PULIHKAN penempatan merentas booking: bagi setiap reservation aktif
   dengan cabin_no tapi room_id = ID AUTO bilik sendiri, SEMAK sama ada
   ADA penghuni lain (booking lain) yang room_id-nya menunjuk bilik
   sebenar booking ini — kalau ada dan reservation ini sepatutnya
   menyertai bilik itu (Open Sharing), tak boleh ditentukan secara
   automatik daripada data semata-mata; sebaliknya kes 1 di atas boleh
   dikesan daripada ALIAS yang baru dipadam: alias booking A membawa ID
   bilik B → reservation booking A yang membawa ID bilik B pada masa
   v33 ialah yang direset; pulihkan room_id reservation itu kepada ID
   bilik B.
3. Reset room_id reservation yang v33 "dibaiki" dengan docname Booking
   ('BK…-Room_n' — label auto versi salah) kepada auto ID betul
   (booking_number Booking).
"""

import re

import frappe

_ROOM_ID_RE = re.compile(r"^(.+)-Room_(\d+)$")


def execute():
	# 1. Kumpul alias sampah + padam. Simpan peta pemulihan:
	#    (booking_pemilik_alias, id_bilik_lain) → untuk langkah 2.
	restore_map = []   # [{booking, foreign_room_id, cabin_no}]
	junk = frappe.get_all("Booking Room Alias",
		fields=["name", "booking", "cabin_no", "custom_name"])
	for a in junk:
		m = _ROOM_ID_RE.match((a.custom_name or "").strip())
		if not m:
			continue
		restore_map.append({
			"booking": a.booking,
			"cabin_no": a.cabin_no,
			"foreign_room_id": a.custom_name.strip(),
		})
		frappe.delete_doc("Booking Room Alias", a.name,
			ignore_permissions=True, force=True)

	# 3. Reset room_id auto SALAH (docname Booking) → auto betul.
	#    room_id 'BK2610026-Room_1' pada booking dengan booking_number
	#    'RIUQRXL2610' sepatutnya 'RIUQRXL2610-Room_1'.
	for r in frappe.get_all("Booking Reservation",
			fields=["name", "booking", "cabin_no", "room_id"],
			filters={"room_id": ["like", "%-Room_%"]}):
		if not (r.booking and r.cabin_no and r.room_id):
			continue
		m = _ROOM_ID_RE.match(r.room_id)
		if not m:
			continue
		bnum = frappe.db.get_value("Booking", r.booking, "booking_number") or r.booking
		auto = "{0}-Room_{1}".format(bnum, r.cabin_no)
		if r.room_id == auto:
			continue
		if r.room_id.split("-Room_")[0] == r.booking:
			# label auto versi v33 salah (docname) — betulkan.
			frappe.db.set_value("Booking Reservation", r.name,
				"room_id", auto, update_modified=False)
		elif r.room_id.split("-Room_")[0] == bnum:
			# cabin dalam room_id ≠ cabin_no semasa — assign_room_id()
			# akan jana semula pada save berikut; kosongkan sahaja.
			frappe.db.set_value("Booking Reservation", r.name,
				"room_id", "", update_modified=False)

	# 2. Pulihkan penempatan merentas booking daripada rekod alias sampah:
	#    alias booking A (cabin c) membawa ID bilik B → cari reservation
	#    booking A, cabin c, yang room_id-nya sekarang ID AUTO bilik A
	#    sendiri (v33 telah meresetnya) → pulihkan kepada ID bilik B.
	#    (Room bilik B mesti masih wujud & berpenghuni — guard sama
	#    arrange_group_rooming.)
	for item in restore_map:
		rows = frappe.get_all("Booking Reservation",
			filters={"booking": item["booking"], "cabin_no": item["cabin_no"],
				"status": ["!=", "Cancelled"]},
			fields=["name", "room_id"])
		bnum = frappe.db.get_value("Booking", item["booking"],
			"booking_number") or item["booking"]
		auto_own = "{0}-Room_{1}".format(bnum, item["cabin_no"])
		target_exists = frappe.db.exists("Booking Reservation",
			{"room_id": item["foreign_room_id"], "status": ["!=", "Cancelled"]})
		if not target_exists:
			continue   # bilik sasaran sudah tak wujud — biar auto
		for r in rows:
			if (r.room_id or "") == auto_own:
				frappe.db.set_value("Booking Reservation", r.name,
					"room_id", item["foreign_room_id"], update_modified=False)

	frappe.db.commit()
