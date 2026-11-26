# travel_booking/api/cabin_registry.py
#
# Fasa 4A renovation — REGISTRY BILIK FIZIKAL CRUISE.
#
# Doctype Cruise Cabin = registry stateroom fizikal per Trip Cruise
# Schedule (room_no, deck, room_category, status). Ia menjadi sumber
# kebenaran BILIK FIZIKAL — berbeza dari cabin_rates (Trip Package
# Price) yang kekal sumber kebenaran KELAS/harga/allotment.
#
# Modul ni membekalkan:
#   sync_reservation_to_registry(reservation doc/event)
#     — doc_events Booking Reservation: setiap kali stateroom_no /
#       trip_cruise_schedule berubah, refresh status registry bilik
#       lama + baharu (Assigned ↔ Available).
#
#   import_cabins_from_aroya(schedule)
#     — bina registry dari manifest Rooming Aroya (stateroom_no +
#       stateroom_category → room_category mapping terdekat).
#
#   get_registry_overview(schedule)
#     — ringkasan occupancy kelas: {registry, allotment, reserved,
#       available} untuk validasi admin.
#
#   validate_stateroom_assignment(schedule, room_no)
#     — digunakan oleh booking_hub.update_cabin_assignment: bilik mesti
#       wujud dalam registry (kalau registry telah di-import) dan tidak
#       Maintenance/Blocked.
#
# PRINSIP: registry OPSYENAL — schedule tanpa registry (belum import)
# kekal berfungsi seperti sedia ada (stateroom bebas). Sebaik registry
# di-import, assignment disahkan terhadapnya.

import frappe


# ══════════════════════════════════════════════
# SYNC (doc_events Booking Reservation)
# ══════════════════════════════════════════════

def sync_reservation_to_registry(doc, method=None):
	"""doc_events Booking Reservation (on_update / after_delete) —
	refresh status registry bilik fizikal yang terlibat dengan slot ni:
	bilik semasa (stateroom_no) dan bilik lama (sebelum perubahan)."""
	pairs = set()
	if getattr(doc, "trip_cruise_schedule", None) and getattr(doc, "stateroom_no", None):
		pairs.add((doc.trip_cruise_schedule, doc.stateroom_no))

	old = doc.get_doc_before_save() if hasattr(doc, "get_doc_before_save") else None
	if old is not None and getattr(old, "trip_cruise_schedule", None) and getattr(old, "stateroom_no", None):
		pairs.add((old.trip_cruise_schedule, old.stateroom_no))

	for schedule, room_no in sorted(pairs):
		refresh_cabin_status(schedule, room_no)


def refresh_cabin_status(schedule, room_no):
	"""Kira semula status satu bilik registry (kalau wujud). Skip senyap
	bila registry belum di-import untuk schedule tu — registry opsional."""
	name = frappe.db.exists(
		"Cruise Cabin", {"schedule": schedule, "room_no": room_no})
	if not name:
		return
	# Pengecualian manual: Maintenance/Blocked tidak ditulis balik.
	current = frappe.db.get_value("Cruise Cabin", name, "status")
	if current in ("Maintenance", "Blocked"):
		return
	assigned = frappe.db.count("Booking Reservation", {
		"trip_cruise_schedule": schedule,
		"stateroom_no": room_no,
		"status": ["!=", "Cancelled"],
	})
	frappe.db.set_value(
		"Cruise Cabin", name,
		{"status": "Assigned" if assigned else "Available"},
		update_modified=False)


# ══════════════════════════════════════════════
# IMPORT DARI MANIFEST AROYA
# ══════════════════════════════════════════════

def import_cabins_from_aroya(schedule):
	"""Bina registry Cruise Cabin untuk satu schedule daripada manifest
	Rooming Aroya (baris stateroom unik). room_category diselesaikan
	dari kategori cabin_rates schedule yang paling hampir namanya dengan
	stateroom_category manifest; tanpa padanan → kategori pertama
	cabin_rates + amaran.

	Return {created, skipped_existing, unmapped_categories}.
	Gate: Booking Hub role.
	"""
	_require_booking_manager()

	# Kategori tersedia pada schedule (dari cabin_rates)
	schedule_categories = [
		r.pricing_for_class for r in frappe.get_all(
			"Trip Package Price",
			filters={"parent": schedule, "parenttype": "Trip Cruise Schedule"},
			fields=["pricing_for_class"],
			order_by="idx",
		) if r.pricing_for_class
	]

	# Baris manifest unik (stateroom_no + kategori)
	manifest_rows = frappe.db.get_all(
		"Rooming Aroya",
		filters={"cruise_schedule": schedule},
		fields=["stateroom_no", "stateroom_category"],
		group_by="stateroom_no, stateroom_category",
	)

	created, skipped, unmapped = 0, 0, set()
	for row in manifest_rows:
		room_no = (row.stateroom_no or "").strip()
		if not room_no:
			continue
		if frappe.db.exists("Cruise Cabin", {"schedule": schedule, "room_no": room_no}):
			skipped += 1
			continue

		category = _resolve_category(
			row.stateroom_category, schedule_categories)
		if not category:
			unmapped.add(row.stateroom_category or "?")
			continue

		frappe.get_doc({
			"doctype":       "Cruise Cabin",
			"schedule":      schedule,
			"room_no":       room_no,
			"room_category": category,
		}).insert(ignore_permissions=True)
		created += 1

	# Refresh status semua bilik yang baru diimport
	for cabin in frappe.get_all(
			"Cruise Cabin", {"schedule": schedule}, pluck="name"):
		cabin_doc = frappe.get_doc("Cruise Cabin", cabin)
		cabin_doc.sync_status_from_reservations()
		cabin_doc.db_update_all()

	frappe.db.commit()
	return {
		"created":           created,
		"skipped_existing":  skipped,
		"unmapped_categories": sorted(unmapped),
	}


def _resolve_category(manifest_category, schedule_categories):
	"""Padankan stateroom_category manifest → Trip Price Category
	schedule. Padanan longgar (substring dua hala, case-insensitive)."""
	if not manifest_category or not schedule_categories:
		return schedule_categories[0] if schedule_categories else None
	mc = manifest_category.strip().lower()
	# 1) Padanan tepat longgar
	for c in schedule_categories:
		if c.strip().lower() == mc:
			return c
	# 2) Substring dua hala
	for c in schedule_categories:
		cl = c.strip().lower()
		if mc in cl or cl in mc:
			return c
	# 3) Fallback kategori pertama — lebih baik daripada tiada bilik
	return schedule_categories[0] if schedule_categories else None


# ══════════════════════════════════════════════
# OVERVIEW & VALIDASI
# ══════════════════════════════════════════════

def get_registry_overview(schedule):
	"""Ringkasan registry vs allotment per kelas:
	[{room_category, registry_count, allotment, reserved, available}].
	registry_count < allotment → registry belum lengkap (amaran admin)."""
	registry = frappe.db.get_all(
		"Cruise Cabin", {"schedule": schedule},
		fields=["room_category", "status"])
	rates = frappe.get_all(
		"Trip Package Price",
		filters={"parent": schedule, "parenttype": "Trip Cruise Schedule"},
		fields=["pricing_for_class", "cabin_allotment",
		        "cabin_occupancy", "cabin_available"],
	)

	overview = {}
	for r in rates:
		if not r.pricing_for_class:
			continue
		overview[r.pricing_for_class] = {
			"room_category":   r.pricing_for_class,
			"allotment":       int(r.cabin_allotment or 0),
			"reserved":        int(r.cabin_occupancy or 0),
			"available":       r.cabin_available,
			"registry_count":  0,
			"registry_assigned": 0,
		}
	for c in registry:
		entry = overview.get(c.room_category)
		if entry is None:
			# Kategori tanpa rate row — masukkan dengan allotment 0
			entry = overview[c.room_category] = {
				"room_category": c.room_category, "allotment": 0,
				"reserved": 0, "available": None,
				"registry_count": 0, "registry_assigned": 0,
			}
		entry["registry_count"] += 1
		if c.status == "Assigned":
			entry["registry_assigned"] += 1

	return {
		"schedule": schedule,
		"registry_total": len(registry),
		"categories": sorted(overview.values(), key=lambda e: e["room_category"]),
	}


def validate_stateroom_assignment(schedule, room_no, reservation_name=None):
	"""Sahkan bilik fizikal sah untuk assignment. Dipanggil oleh
	booking_hub.update_cabin_assignment SEBELUM tulis stateroom_no.

	Return None bila OK; throw bila bilik tidak wujud dalam registry
	(yang telah diimport) atau berstatus Maintenance/Blocked.
	Schedule tanpa registry → no-op (registry opsional)."""
	if not schedule or not room_no:
		return
	name = frappe.db.exists(
		"Cruise Cabin", {"schedule": schedule, "room_no": room_no})
	if not name:
		# Registry belum diimport untuk schedule ni → tiada validasi
		if not frappe.db.count("Cruise Cabin", {"schedule": schedule}):
			return
		frappe.throw(
			"Stateroom {0} is not in the cabin registry of this schedule. "
			"Import the registry or add the cabin first.".format(room_no),
			title="Cabin Not In Registry",
		)
	status = frappe.db.get_value("Cruise Cabin", name, "status")
	if status == "Maintenance":
		frappe.throw(
			"Stateroom {0} is under maintenance.".format(room_no),
			title="Cabin Maintenance",
		)
	if status == "Blocked":
		frappe.throw(
			"Stateroom {0} is blocked.".format(room_no),
			title="Cabin Blocked",
		)


def _require_booking_manager():
	from travel_booking.api.booking_hub import _require_booking_manager
	_require_booking_manager()
