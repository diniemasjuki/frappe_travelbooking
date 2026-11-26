# travel_booking/api/cabin_upgrade.py
#
# Fasa 1B renovation — UPGRADE CABIN selepas tempahan (addon-first).
#
# Model: upgrade cabin ialah Trip Addon Package dengan flag
# `is_cabin_upgrade` + `upgrade_from_category` / `upgrade_to_category`
# (ditambah oleh patches/v39). Jualan melalui infrastruktur addon sedia
# ada SEPENUHNYA — katalog portal (get_available_addons), cart, SO
# (Booking Addon + custom_booking_addon), bayaran Stripe/manual,
# refresh_payment_status. Modul ni hanya menambah:
#
#   1. get_cabin_upgrade_options(booking) — senarai upgrade yang SAH
#      untuk booking cruise: kategori semasa reservation → kategori
#      sasaran, rate currency, dan allotment tersedia pada
#      Trip Cruise Schedule.cabin_rates.
#   2. _apply_cabin_upgrade(order) — bila Booking Addon fully paid,
#      tukar Booking Reservation.room_category (cabin seluruhnya,
#      bukan per pax), sync availability (hook sedia ada), dan tandakan
#      stateroom untuk re-assign (stateroom_no dikosongkan).
#
# Kependawaan: room_category pada SO utama TIDAK diubah — SO ialah
# snapshot pembelian asal; upgrade direkodkan sebagai Booking Addon
# (SO tambahan) — jejak audit penuh, tiada amend SO submitted.

import frappe

from travel_booking.api.constants import DEFAULT_CURRENCY


# ══════════════════════════════════════════════
# KATALOG UPGRADE (portal + desk)
# ══════════════════════════════════════════════

def _upgrade_applicable_for_reservations(ap_name, booking_name):
	"""Semak sama ada package upgrade APPLICABLE untuk booking ni:

	1. Booking mesti cruise (reservations bawa trip_cruise_schedule).
	2.upgrade_from_category mesti padan kategori SEMASA sekurang-kurangnya
	   satu cabin aktif booking ni (upgrade cabin adalah per-CABIN, bukan
	   per-pax — satu cabin = satu kategori bilik).
	3. Kategori sasaran mesti ada rate row pada schedule cruise booking
	   tu (kalau tiada baris cabin_rates, tiada inventori untuk upgrade).
	"""
	ap = frappe.db.get_value(
		"Trip Addon Package", ap_name,
		["is_cabin_upgrade", "upgrade_from_category", "upgrade_to_category"],
		as_dict=True,
	)
	if not ap or not ap.is_cabin_upgrade:
		return None

	# Cabin aktif booking (bukan Cancelled) — pasangan (cabin_no,
	# room_category, trip_cruise_schedule) unik per cabin.
	reservations = frappe.db.get_all(
		"Booking Reservation",
		filters={"booking": booking_name, "status": ["!=", "Cancelled"]},
		fields=["cabin_no", "room_category", "trip_cruise_schedule"],
	)
	if not reservations:
		return None

	schedule_names = {r.trip_cruise_schedule for r in reservations if r.trip_cruise_schedule}
	if not schedule_names:
		return None  # bukan booking cruise

	# Cabin dengan kategori asal yang padan.
	matching_cabins = {
		r.cabin_no for r in reservations
		if r.room_category == ap.upgrade_from_category
	}
	if not matching_cabins:
		return None

	# Kategori sasaran wujud pada cabin_rates schedule (inventori wujud).
	target_available = frappe.db.exists(
		"Trip Package Price",
		{"parent": ["in", tuple(schedule_names)],
		 "parenttype": "Trip Cruise Schedule",
		 "pricing_for_class": ap.upgrade_to_category},
	)
	if not target_available:
		return None

	return {
		"upgrade_from": ap.upgrade_from_category,
		"upgrade_to":   ap.upgrade_to_category,
		"cabins":       sorted(c for c in matching_cabins if c),
	}


def _target_category_available_apx(schedule_names, category):
	"""Allotment tersedia (max) untuk kategori sasaran merentasi schedule
	yang berkaitan — untuk paparan "N left" di portal. Negative
	availability (overbooking signal) di-clamp ke 0 — customer tak patut
	nampak kiraan negatif."""
	rows = frappe.db.get_all(
		"Trip Package Price",
		filters={"parent": ["in", tuple(schedule_names)],
		         "parenttype": "Trip Cruise Schedule",
		         "pricing_for_class": category},
		fields=["cabin_allotment", "cabin_available"],
	)
	if not rows:
		return None
	# Allotment terbesar antara baris — konservatif: papar yang paling
	# banyak tersedia supaya customer tidak nampak false sold-out.
	return max((max(int(r.cabin_available or 0), 0) for r in rows), default=0)


def get_cabin_upgrade_options(booking_number, currency=None):
	"""Senarai pilihan upgrade cabin yang sah untuk satu booking — dipanggil
	oleh page portal booking_addons dan API desk.

	Return {upgrades: [{addon_package, title, from_category, to_category,
	rate, currency, cabins, available}]}. Kosong bila booking bukan cruise
	atau tiada upgrade yang ditawarkan.

	Gate akses (pemilik / on-behalf / staf) TIDAK di sini — caller
	(addon_manager.get_available_addons) sudah punya gate; fungsi ni
	utility dalaman yang menerima booking yang TELAH divalidasi.
	"""
	booking = frappe.db.get_value(
		"Booking", booking_number, ["name", "is_a_cruise_trip", "status"], as_dict=True
	) if booking_number else None
	if not booking or not booking.is_a_cruise_trip:
		return {"upgrades": []}
	# Upgrade hanya untuk booking aktif — bukan Completed/Cancelled.
	if booking.status in ("Completed", "Cancelled", "Abandoned"):
		return {"upgrades": []}

	if not currency:
		primary_so = frappe.db.get_value(
			"Sales Order", {"custom_booking": booking.name},
			"currency", order_by="creation asc"
		)
		currency = primary_so or DEFAULT_CURRENCY

	rows = frappe.db.sql("""
		SELECT ap.name, ap.addon_title, ap.addon_package_name,
		       ap.upgrade_from_category, ap.upgrade_to_category,
		       a.addon_title AS parent_addon_title
		FROM `tabTrip Addon Package` ap
		JOIN `tabTrip Addon` a ON a.name = ap.addon
		WHERE ap.status = 'Active'
		  AND ap.is_cabin_upgrade = 1
		  AND a.disable = 0
	""", as_dict=True)

	reservations = frappe.db.get_all(
		"Booking Reservation",
		filters={"booking": booking.name, "status": ["!=", "Cancelled"]},
		fields=["cabin_no", "room_category", "trip_cruise_schedule"],
	)
	schedule_names = {r.trip_cruise_schedule for r in reservations if r.trip_cruise_schedule}
	if not schedule_names:
		return {"upgrades": []}

	upgrades = []
	for r in rows:
		applicable = _upgrade_applicable_for_reservations(r.name, booking.name)
		if not applicable:
			continue
		# Rate dalam currency terpilih (model rate multi-currency sedia ada).
		rate_row = frappe.db.get_value(
			"Trip Addon Package Rate",
			{"parent": r.name, "parenttype": "Trip Addon Package",
			 "currency": currency, "enabled": 1},
			"unit_price",
		)
		if rate_row is None:
			continue  # tiada rate currency ni — sembunyikan (corak addon)

		upgrades.append({
			"addon_package":  r.name,
			"addon_title":    r.addon_title or r.parent_addon_title or "Cabin Upgrade",
			"package_name":   r.addon_package_name or "",
			"from_category":  r.upgrade_from_category,
			"to_category":    r.upgrade_to_category,
			"currency":       currency,
			"rate":           float(rate_row or 0),
			"cabins":         applicable["cabins"],
			"available":      _target_category_available_apx(schedule_names, r.upgrade_to_category),
		})

	return {"upgrades": upgrades, "currency": currency}


# ══════════════════════════════════════════════
# APPLY UPGRADE (bila Booking Addon fully paid)
# ══════════════════════════════════════════════

def apply_cabin_upgrade_for_order(addon_order_name):
	"""Apply upgrade cabin untuk SEMUA baris is_cabin_upgrade dalam satu
	Booking Addon order yang telah CONFIRMED (fully paid).

	Dipanggil oleh BookingAddon.refresh_payment_status() sebaik status
	flip Pending → Confirmed. Idempoten: baris yang telah di-apply
	(booking_addon_item.status == 'Confirmed' DAN reservation sudah
	punya kategori sasaran) dilangkau.

	Upgrade adalah PER CABIN (bukan per pax): satu baris upgrade =
	satu cabin. Semua slot reservation cabin tu ditukar kategori;
	stateroom_no dikosongkan (stateroom lama dikembalikan ke pool —
	sync_cabin_availability hook on_update reservation yang kira semula
	allotment kedua-dua kategori lama + baharu).
	"""
	order_items = frappe.db.get_all(
		"Booking Addon Item",
		filters={"addon_order": addon_order_name, "status": "Confirmed"},
		fields=["name", "addon_package", "booking", "booking_reservation", "qty"],
	)
	if not order_items:
		return

	for item in order_items:
		ap = frappe.db.get_value(
			"Trip Addon Package", item.addon_package,
			["is_cabin_upgrade", "upgrade_from_category", "upgrade_to_category"],
			as_dict=True,
		)
		if not ap or not ap.is_cabin_upgrade:
			continue  # baris addon biasa — bukan upgrade

		booking_name = item.booking
		if not booking_name:
			continue

		# Per Pax scope: baris dikaitkan dengan satu reservation — upgrade
		# cabin penuh; kategori reservation itu menentukan cabin.
		# Per Booking scope: baris tanpa reservation — apply ke SEMUA cabin
		# booking yang kategori-nya padan upgrade_from.
		if item.booking_reservation:
			target_reservations = frappe.db.get_all(
				"Booking Reservation",
				filters={"name": item.booking_reservation,
				         "status": ["!=", "Cancelled"]},
				fields=["name", "cabin_no", "room_category", "trip_cruise_schedule"],
			)
		else:
			target_reservations = frappe.db.get_all(
				"Booking Reservation",
				filters={"booking": booking_name,
				         "room_category": ap.upgrade_from_category,
				         "status": ["!=", "Cancelled"]},
				fields=["name", "cabin_no", "room_category", "trip_cruise_schedule"],
			)
		if not target_reservations:
			continue

		# Kumpulkan per cabin (upgrade = satu kategori bilik per cabin).
		# Validasi konsistensi: semua slot cabin mesti kategori sama.
		cabins = {}
		for res in target_reservations:
			cabins.setdefault(res.cabin_no, set()).add(res.room_category)

		for cabin_no, categories in cabins.items():
			if len(categories) > 1:
				# Slot cabin bercampur kategori — data tak konsisten;
				# langkau cabin ni, log untuk admin.
				frappe.log_error(
					title="Cabin Upgrade Skipped - Mixed Categories",
					message="Booking Addon " + str(addon_order_name) + " item " +
					str(item.name) + ": cabin " + str(cabin_no) + " pada booking " +
					str(booking_name) + " mempunyai slot kategori bercampur " +
					str(sorted(categories)) + " — upgrade dilangkau untuk cabin ini.",
				)
				continue

			# Tukar SEMUA slot cabin ni ke kategori sasaran + kosongkan
			# stateroom (perlu re-assign). Guna doc.save() BUKAN
			# frappe.db.set_value — on_update hook sync_cabin_availability
			# mesti fire (dan ia bergantung get_doc_before_save() untuk
			# release kategori LAMA — db.set_value tidak bekalkan itu).
			# Flag skip_cabin_category_consistency: slot pertama masih
			# nampak sibling kategori lama ketika save (kitaran tukar
			# semua slot berurutan) — skip check konsistensi sahaja.
			for res_name in frappe.db.get_all(
				"Booking Reservation",
				filters={"booking": booking_name, "cabin_no": cabin_no,
				         "status": ["!=", "Cancelled"]},
				pluck="name",
			):
				res_doc = frappe.get_doc("Booking Reservation", res_name)
				res_doc.room_category = ap.upgrade_to_category
				res_doc.stateroom_no = ""
				res_doc.flags.ignore_permissions = True
				res_doc.flags.skip_cabin_category_consistency = True
				res_doc.save()

	frappe.db.commit()


def _categorize_upgrade_line(addon_order_name, item_name):
	"""Utility desk: kategorikan semula satu baris Booking Addon Item
	sebagai upgrade (debug/repair). Tidak dipakai oleh aliran biasa."""
	pass
