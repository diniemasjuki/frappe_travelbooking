# travel_booking/api/cruise_schedule_admin.py
# Backend API untuk CRUISE SCHEDULE MANAGER
# (/app/travel-manager/cruise-schedule — seksyen travel_manager).
#
# Mengurus rekod Trip Cruise Schedule SEPENUHNYA tanpa akses borang
# doctype terus (arahan pemilik Nov 2026): senarai + penapis (bulan-tahun,
# port, status, carian), detail penuh (kadar kabin + tarikh/offer/reservasi
# berkaitan), cipta/simpan (validate doctype kekal jalan — schedule_code,
# auto-status, rule offer aktif) dan padam dengan semakan dependensi.
#
# Role gates (selari trip_command_center + permission doctype):
#   Baca  : System Manager, Tour Manager, Tour Operator, Accounts User
#   Tulis : System Manager, Tour Manager, Tour Operator
#   Padam : System Manager, Tour Manager   (Tour Operator tiada delete
#           pada doctype — permmissions Trip Cruise Schedule)

import json

import frappe
from frappe import _
from frappe.utils import get_first_day, get_last_day, getdate

# ══════════════════════════════════════════════
# PERMISSION GATES
# ══════════════════════════════════════════════

CRUISE_READ_ROLES = ["System Manager", "Tour Manager", "Tour Operator", "Accounts User"]
CRUISE_WRITE_ROLES = ["System Manager", "Tour Manager", "Tour Operator"]
CRUISE_DELETE_ROLES = ["System Manager", "Tour Manager"]

# Medan yang dibenarkan di-set oleh save_cruise_schedule — buang medan
# luar (name/naming/ownership) yang bukan milik pengguna.
SCHEDULE_FIELDS = [
	"ship_code", "ship_name", "cruise_line_company",
	"sail_start", "sail_end", "total_days", "total_nights",
	"port_start", "port_end", "status", "trip_code",
	"trip_name_cruise_company", "currency",
]

# Medan kadar kabin yang dibenarkan (child Trip Package Price —
# parenttype Trip Cruise Schedule). cabin_occupancy/cabin_available
# DIKIRA semula oleh hook recompute_cabin_availability, bukan input.
CABIN_FIELDS = [
	"pricing_for_class", "price_adult", "price_adult_single",
	"price_upperberth", "price_children", "price_toddler", "price_infant",
	"cabin_allotment",
]


def _check_roles(roles, context_label):
	if not frappe.session.user or frappe.session.user == "Guest":
		frappe.throw(_("Please login to access {0}").format(context_label), frappe.PermissionError)

	user_roles = frappe.get_roles()
	if not any(role in roles for role in user_roles):
		frappe.throw(
			_("You do not have permission to {0}. Required roles: {1}").format(
				context_label, ", ".join(roles)
			),
			frappe.PermissionError,
		)


def _require_read():
	_check_roles(CRUISE_READ_ROLES, _("Cruise Schedule Manager"))


def _require_write():
	_check_roles(CRUISE_WRITE_ROLES, _("manage cruise schedules"))


def _require_delete():
	_check_roles(CRUISE_DELETE_ROLES, _("delete cruise schedules"))


# ══════════════════════════════════════════════
# SENARAI + PENAPIS
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_cruise_schedules(search: str = None, status: str = None,
		month: str = None, port: str = None, limit: int = 500) -> dict:
	"""Senarai Trip Cruise Schedule + kiraan agregat utk datatable.

	Penapis (semua opsional, digabung AND):
	  search — substring pada ship_code/ship_name/schedule_code/trip_code/
	           trip_name_cruise_company/name
	  status — padanan tepat status
	  month  — 'YYYY-MM' → sail_start DALAM bulan tersebut
	  port   — padanan tepat port_start ATAU port_end

	Agregat per baris: dates_count (Travel Date dipaut), offers_count
	(Package Offer), reservations (Booking Reservation aktif), cabin_count
	+ min_price (baris kadar kabin).
	"""
	_require_read()

	filters = []
	params = []

	if search:
		filters.append(
			"""(ship_code LIKE %s OR ship_name LIKE %s OR schedule_code LIKE %s
				OR trip_code LIKE %s OR trip_name_cruise_company LIKE %s OR name LIKE %s)"""
		)
		like = f"%{search.strip()}%"
		params += [like] * 6

	if status:
		filters.append("status = %s")
		params.append(status)

	if month:
		# 'YYYY-MM' → lingkungan tarikh bulan itu pada sail_start.
		mstart = get_first_day(f"{month}-01")
		mend = get_last_day(f"{month}-01")
		filters.append("sail_start BETWEEN %s AND %s")
		params += [mstart, mend]

	if port:
		filters.append("(port_start = %s OR port_end = %s)")
		params += [port, port]

	where = ("WHERE " + " AND ".join(filters)) if filters else ""

	rows = frappe.db.sql(
		f"""
		SELECT name, schedule_code, ship_code, ship_name, cruise_line_company,
			sail_start, sail_end, total_days, total_nights,
			port_start, port_end, status, trip_code, trip_name_cruise_company,
			currency, creation
		FROM `tabTrip Cruise Schedule`
		{where}
		ORDER BY sail_start DESC, creation DESC
		LIMIT %s
		""",
		tuple(params + [int(limit)]),
		as_dict=True,
	)

	schedules = []
	if rows:
		names = [r.name for r in rows]

		# Kadar kabin — kira kelas + harga terendah per schedule.
		cabin_agg = {
			r.parent: r for r in frappe.db.sql(
				"""
				SELECT parent, COUNT(name) AS cabin_count,
					MIN(NULLIF(price_adult, 0)) AS min_price
				FROM `tabTrip Package Price`
				WHERE parenttype = 'Trip Cruise Schedule' AND parent IN %(names)s
				GROUP BY parent
				""",
				{"names": names},
				as_dict=True,
			)
		}
		# Tarikh trip yang dipaut (Travel Date.cruise_schedule).
		dates_agg = {
			r.cruise_schedule: r.total for r in frappe.db.sql(
				"""
				SELECT cruise_schedule, COUNT(name) AS total
				FROM `tabTravel Date`
				WHERE cruise_schedule IN %(names)s
				GROUP BY cruise_schedule
				""",
				{"names": names},
				as_dict=True,
			)
		}
		# Offer editorial yang berkongsi inventori schedule ini.
		offers_agg = {
			r.cruise_schedule: r.total for r in frappe.db.sql(
				"""
				SELECT cruise_schedule, COUNT(name) AS total
				FROM `tabPackage Offer`
				WHERE cruise_schedule IN %(names)s
				GROUP BY cruise_schedule
				""",
				{"names": names},
				as_dict=True,
			)
		}
		# Reservasi AKTIF (bukan Cancelled) atas schedule ini.
		resv_agg = {
			r.trip_cruise_schedule: r.total for r in frappe.db.sql(
				"""
				SELECT trip_cruise_schedule, COUNT(name) AS total
				FROM `tabBooking Reservation`
				WHERE trip_cruise_schedule IN %(names)s AND status != 'Cancelled'
				GROUP BY trip_cruise_schedule
				""",
				{"names": names},
				as_dict=True,
			)
		}

		for r in rows:
			r.dates_count = int(dates_agg.get(r.name, 0))
			r.offers_count = int(offers_agg.get(r.name, 0))
			r.reservations = int(resv_agg.get(r.name, 0))
			r.cabin_count = int(cabin_agg.get(r.name, {}).get("cabin_count") or 0)
			r.min_price = cabin_agg.get(r.name, {}).get("min_price")
			schedules.append(r)

	return {"schedules": schedules}


@frappe.whitelist()
def get_cruise_schedule_detail(schedule: str) -> dict:
	"""Detail SATU schedule: rekod penuh + kadar kabin + senarai Travel
	Date / Package Offer / reservasi berkaitan + kiraan rooming."""
	_require_read()

	if not schedule or not frappe.db.exists("Trip Cruise Schedule", schedule):
		frappe.throw(_("Cruise Schedule {0} not found").format(schedule), frappe.DoesNotExistError)

	doc = frappe.get_doc("Trip Cruise Schedule", schedule)

	cabin_rates = frappe.get_all(
		"Trip Package Price",
		filters={"parenttype": "Trip Cruise Schedule", "parent": schedule},
		fields=["name", "pricing_for_class", "price_variant_code",
			"price_adult", "price_adult_single", "price_upperberth",
			"price_children", "price_toddler", "price_infant",
			"cabin_allotment", "cabin_occupancy", "cabin_available"],
		order_by="idx asc",
	)

	travel_dates = frappe.get_all(
		"Travel Date",
		filters={"cruise_schedule": schedule},
		fields=["name", "trip", "departure_date", "return_date",
			"status_editorial"],
		order_by="departure_date asc",
		limit=50,
	)

	offers = frappe.get_all(
		"Package Offer",
		filters={"cruise_schedule": schedule},
		fields=["name", "offer_name", "travel_date", "trip",
			"status_editorial"],
		order_by="creation desc",
		limit=50,
	)

	reservations = frappe.db.count(
		"Booking Reservation",
		filters={"trip_cruise_schedule": schedule, "status": ["!=", "Cancelled"]},
	)
	rooming = frappe.db.count("Rooming Aroya", {"cruise_schedule": schedule})

	return {
		"schedule": doc.as_dict(),
		"cabin_rates": cabin_rates,
		"travel_dates": travel_dates,
		"offers": offers,
		"reservations": reservations,
		"rooming": rooming,
	}


# ══════════════════════════════════════════════
# SIMPAN (CIPTA / KEMASKINI)
# ══════════════════════════════════════════════

@frappe.whitelist()
def save_cruise_schedule(values: str) -> dict:
	"""Cipta / kemaskini Trip Cruise Schedule + kadar kabin.

	`values` = JSON string:
	  name       — kosong/null = CIPTA, sebaliknya kemaskini rekod sedia
	  cabin_rates — array baris {pricing_for_class, price_*, cabin_allotment}

	Semua melalui doc.save() supaya validate() doctype kekal jalan:
	generasi schedule_code, auto-status ikut tarikh, kiraan hari/malam,
	dan rule "Active mesti ada offer aktif" (update sahaja).
	"""
	_require_write()

	data = json.loads(values) if isinstance(values, str) else (values or {})
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values payload"))

	schedule = (data.get("name") or "").strip()
	if schedule:
		if not frappe.db.exists("Trip Cruise Schedule", schedule):
			frappe.throw(_("Cruise Schedule {0} not found").format(schedule), frappe.DoesNotExistError)
		doc = frappe.get_doc("Trip Cruise Schedule", schedule)
	else:
		doc = frappe.new_doc("Trip Cruise Schedule")

	for fieldname in SCHEDULE_FIELDS:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))

	# Ganti keseluruhan baris kadar kabin (corak borang Frappe — baris
	# dibina semula; occupancy/available disusun semula oleh hook
	# recompute_cabin_availability selepas save).
	if "cabin_rates" in data:
		rates = data.get("cabin_rates") or []
		if not isinstance(rates, list):
			frappe.throw(_("cabin_rates must be a list"))
		doc.set("cabin_rates", [])
		for row in rates:
			if not isinstance(row, dict):
				continue
			clean = {k: row.get(k) for k in CABIN_FIELDS if k in row}
			if not clean.get("pricing_for_class"):
				continue  # baris tanpa kelas tidak bermakna — buang senyap
			doc.append("cabin_rates", clean)

	doc.save()

	return {
		"name": doc.name,
		"schedule_code": doc.schedule_code,
		"status": doc.status,
		"is_new": not schedule,
	}


# ══════════════════════════════════════════════
# PADAM
# ══════════════════════════════════════════════

@frappe.whitelist()
def delete_cruise_schedule(schedule: str) -> dict:
	"""Padam Trip Cruise Schedule SELEPAS semakan dependensi.

	DISEKAT bila schedule masih dipakai oleh mana-mana:
	  • Booking Reservation AKTIF (bukan Cancelled)
	  • Travel Date (pautan cruise_schedule)
	  • Package Offer (kongsi inventori kabin schedule ini)
	  • Rooming Aroya (rooming atas sailing ini)
	Message menyenaraikan kiraan supaya admin tahu apa perlu
	diselesaikan dahulu.
	"""
	_require_delete()

	if not schedule or not frappe.db.exists("Trip Cruise Schedule", schedule):
		frappe.throw(_("Cruise Schedule {0} not found").format(schedule), frappe.DoesNotExistError)

	blocked = []
	reservations = frappe.db.count(
		"Booking Reservation",
		filters={"trip_cruise_schedule": schedule, "status": ["!=", "Cancelled"]},
	)
	if reservations:
		blocked.append(_("{0} active booking reservation(s)").format(reservations))

	dates = frappe.get_all(
		"Travel Date", filters={"cruise_schedule": schedule}, pluck="name")
	if dates:
		blocked.append(_("{0} travel date(s): {1}").format(
			len(dates), ", ".join(dates[:5]) + ("…" if len(dates) > 5 else "")))

	offers = frappe.get_all(
		"Package Offer", filters={"cruise_schedule": schedule}, pluck="name")
	if offers:
		blocked.append(_("{0} package offer(s): {1}").format(
			len(offers), ", ".join(offers[:5]) + ("…" if len(offers) > 5 else "")))

	rooming = frappe.db.count("Rooming Aroya", {"cruise_schedule": schedule})
	if rooming:
		blocked.append(_("{0} rooming record(s)").format(rooming))

	if blocked:
		frappe.throw(
			_("Cannot delete cruise schedule {0} — still referenced by: {1}. "
				"Unlink or resolve these records first.").format(
				schedule, "; ".join(blocked)),
			title=_("Schedule In Use"),
		)

	frappe.delete_doc("Trip Cruise Schedule", schedule)

	return {"deleted": schedule}
