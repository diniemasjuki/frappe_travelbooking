# travel_booking/utils/product_readiness.py
#
# Enjin Kesediaan Produk (P3 — Fasa A).
#
# SATU SUMBER definisi "ready" untuk staff — kondisi READY di sini SENADA
# dengan get_ready_bundle() di trip_catalog.py (kondisi katalog sebenar):
#   Trip.status = 'Active'
#   dan wujud ≥ 1 Trip Group Date: status Active + departure_date >= hari ini
#       dengan ≥ 1 Trip Package (status Active) yang PILIH group date itu.
#
# Nilai tambah berbanding katalog: katalog hanya PAPAR yang ready — enjin
# ini menceritakan KENAPA sesuatu trip TAK ready (senarai isu berperingkat
# error/warning) supaya staf boleh baiki sebelum produk hilang dari jualan.
#
# Semua pertanyaan di-BATCH (satu query per doctype dengan IN clause) —
# selamat untuk senarai ratusan trip.

import frappe
from frappe.utils import today


def _issue(level: str, code: str, message: str) -> dict:
	return {"level": level, "code": code, "message": message}


def _get_declared_currencies():
	"""Currency yang diisytihar dalam Travel Settings (rujuk currency_axis).
	Dipanggil lazy — enjin tak mahu depend pada settings bila tak perlu."""
	from travel_booking.api.currency_axis import get_declared_currencies
	return get_declared_currencies()


def get_trip_readiness(trip_name: str) -> dict:
	"""Kesediaan SATU trip — checklist penuh + senarai isu.

	Kondisi 'ready' senada get_ready_bundle() (rujuk docstring module).
	Warning tidak menyekat 'ready' — ia kualiti paparan (harga kosong,
	tak published, tarikh penuh), bukan pintu katalog.
	"""
	trip = frappe.db.get_value(
		"Trip", trip_name,
		["name", "trip_name", "status", "published", "is_a_cruise_trip"],
		as_dict=True,
	)
	if not trip:
		frappe.throw("Trip {0} not found".format(trip_name), frappe.DoesNotExistError)

	issues: list = []

	# ── Editorial status (paksi manusia) ──
	if trip.status != "Active":
		issues.append(_issue(
			"error", "TRIP_NOT_ACTIVE",
			"Trip status '{0}' — katalog hanya papar 'Active'.".format(trip.status),
		))
	if not trip.published:
		issues.append(_issue(
			"warning", "TRIP_NOT_PUBLISHED",
			"Trip belum published — tak muncul di website.",
		))

	# ── Pakej Active ──
	packages = frappe.get_all(
		"Trip Package",
		filters={"trip_link": trip.name, "status": "Active"},
		fields=["name", "package_type", "currency", "package_title"],
	)
	if not packages:
		issues.append(_issue(
			"error", "NO_ACTIVE_PACKAGE",
			"Tiada Trip Package Active untuk trip ini.",
		))

	declared = None
	for p in packages:
		price_count = frappe.db.count("Trip Package Price", {"parent": p.name})
		if not price_count:
			issues.append(_issue(
				"warning", "PKG_NO_PRICE",
				"Pakej '{0}' tiada baris harga — wizard papar pakej tanpa harga.".format(
					p.package_title or p.name),
			))
		if declared is None:
			declared = _get_declared_currencies()
		if declared and p.currency and p.currency not in declared:
			issues.append(_issue(
				"error", "PKG_CURRENCY_NOT_DECLARED",
				"Pakej '{0}': currency '{1}' tidak diisytihar dalam Travel Settings "
				"> Multi Currency Account.".format(p.package_title or p.name, p.currency),
			))
		if not frappe.db.count("Trip Package Group Date Select", {"parent": p.name}):
			issues.append(_issue(
				"warning", "PKG_NO_DATES_SELECTED",
				"Pakej '{0}' tidak memilih mana-mana group date — tak akan dipautkan "
				"ke tarikh berangkat.".format(p.package_title or p.name),
			))

	# ── Tarikh berangkat (kondisi katalog: Active + hadapan) ──
	dates = frappe.get_all(
		"Trip Group Date",
		filters={
			"trip": trip.name,
			"status": "Active",
			"departure_date": [">=", today()],
		},
		fields=["name", "trip_group_name", "departure_date",
				"max_participants", "current_participants"],
		order_by="departure_date asc",
	)
	if not dates:
		issues.append(_issue(
			"error", "NO_ACTIVE_DEPARTURE",
			"Tiada Trip Group Date 'Active' dengan tarikh berangkat hadapan.",
		))
	else:
		# Kondisi EXAK katalog: tarikh dianggap dipaut HANYA bila ≥ 1 pakej
		# Active memilihnya (JOIN + status Active — bukan kiraan buta select).
		date_names = [d.name for d in dates]
		linked = frappe.db.sql(
			"""
			SELECT DISTINCT sel.trip_group_date AS tgd
			FROM `tabTrip Package Group Date Select` sel
			JOIN `tabTrip Package` tp ON tp.name = sel.parent
			WHERE sel.trip_group_date IN %(dates)s AND tp.status = 'Active'
			""",
			{"dates": date_names},
			as_dict=True,
		)
		linked_dates = {r.tgd for r in linked}
		for d in dates:
			if d.name not in linked_dates:
				issues.append(_issue(
					"error", "DEPARTURE_ORPHAN",
					"Tarikh '{0}' ({1}) tiada pakej Active memilihnya — tak muncul "
					"dalam wizard.".format(d.trip_group_name or d.name, d.departure_date),
				))
			mx = int(d.max_participants or 0)
			if mx and int(d.current_participants or 0) >= mx:
				issues.append(_issue(
					"warning", "DEPARTURE_FULL",
					"Tarikh '{0}' penuh ({1}/{2} peserta).".format(
						d.trip_group_name or d.name,
						d.current_participants, mx),
				))

	# ── Cruise tambahan (info-level) ──
	if trip.is_a_cruise_trip:
		if not frappe.db.count(
				"Trip Cruise Schedule", {"trip_link": trip.name}):
			issues.append(_issue(
				"warning", "NO_CRUISE_SCHEDULE",
				"Cruise trip tanpa Trip Cruise Schedule — data operasi kapal "
				"(jadual/kadar kabin) tidak wujud.",
			))

	errors = [i for i in issues if i["level"] == "error"]
	warnings = [i for i in issues if i["level"] == "warning"]

	return {
		"trip": trip.name,
		"trip_name": trip.trip_name,
		"status": trip.status,
		"published": bool(trip.published),
		"is_cruise": bool(trip.is_a_cruise_trip),
		"active_departures": len(dates),
		"active_packages": len(packages),
		# 'ready' = kondisi katalog (error-level kosong) — EXAK get_ready_bundle
		"ready": not errors,
		"level": "ready" if not issues else ("warning" if not errors else "error"),
		"error_count": len(errors),
		"warning_count": len(warnings),
		"issues": issues,
	}


def get_batch_readiness(trip_names: list = None, limit: int = 200) -> dict:
	"""Kesediaan BANYAK trip — semua query di-batch (IN clause).

	Kembalikan {trips: {name: ringkasan}, summary: {ready, warning, error}}.
	Ringkasan per-trip cukup untuk badge Command Center; detail isu guna
	get_trip_readiness() untuk satu trip.
	"""
	trip_filters = {}
	if trip_names:
		trip_filters["name"] = ["in", trip_names]

	trips = frappe.get_all(
		"Trip",
		filters=trip_filters,
		fields=["name", "trip_name", "status", "published", "is_a_cruise_trip"],
		order_by="trip_name asc",
		limit=limit,
	)
	if not trips:
		return {"trips": {}, "summary": {"ready": 0, "warning": 0, "error": 0}}

	names = [t.name for t in trips]

	packages = frappe.get_all(
		"Trip Package",
		filters={"trip_link": ["in", names], "status": "Active"},
		fields=["name", "trip_link", "currency", "package_title"],
	)
	pkg_by_trip: dict = {}
	for p in packages:
		pkg_by_trip.setdefault(p.trip_link, []).append(p)

	pkg_names = [p.name for p in packages]
	price_counts: dict = {}
	select_counts: dict = {}
	bad_currency_packages: dict = {}
	if pkg_names:
		for r in frappe.db.sql(
			"""SELECT parent, COUNT(*) AS c
			FROM `tabTrip Package Price`
			WHERE parent IN %(pkgs)s GROUP BY parent""",
			{"pkgs": pkg_names}, as_dict=True,
		):
			price_counts[r.parent] = r.c
		for r in frappe.db.sql(
			"""SELECT parent, COUNT(*) AS c
			FROM `tabTrip Package Group Date Select`
			WHERE parent IN %(pkgs)s GROUP BY parent""",
			{"pkgs": pkg_names}, as_dict=True,
		):
			select_counts[r.parent] = r.c

		declared = _get_declared_currencies()
		if declared:
			for p in packages:
				if p.currency and p.currency not in declared:
					bad_currency_packages.setdefault(p.trip_link, []).append(p)

	dates = frappe.get_all(
		"Trip Group Date",
		filters={
			"trip": ["in", names],
			"status": "Active",
			"departure_date": [">=", today()],
		},
		fields=["name", "trip", "trip_group_name", "departure_date",
				"max_participants", "current_participants"],
		order_by="departure_date asc",
	)
	dates_by_trip: dict = {}
	for d in dates:
		dates_by_trip.setdefault(d.trip, []).append(d)

	linked_dates_by_trip: dict = {}
	if dates:
		linked = frappe.db.sql(
			"""
			SELECT sel.trip_group_date AS tgd, tp.trip_link AS trip
			FROM `tabTrip Package Group Date Select` sel
			JOIN `tabTrip Package` tp ON tp.name = sel.parent
			WHERE sel.trip_group_date IN %(dates)s AND tp.status = 'Active'
			GROUP BY sel.trip_group_date, tp.trip_link
			""",
			{"dates": [d.name for d in dates]}, as_dict=True,
		)
		for r in linked:
			linked_dates_by_trip.setdefault(r.trip, set()).add(r.tgd)

	# NOTA: kiraan GROUP BY guna SQL mentah — get_all v17 sekat fungsi SQL
	# dalam fields ("SQL functions are not allowed as strings in SELECT").
	schedule_counts: dict = {}
	if names:
		for r in frappe.db.sql(
			"""SELECT trip_link, COUNT(*) AS c
			FROM `tabTrip Cruise Schedule`
			WHERE trip_link IN %(names)s GROUP BY trip_link""",
			{"names": names}, as_dict=True,
		):
			schedule_counts[r.trip_link] = r.c

	out: dict = {}
	tally = {"ready": 0, "warning": 0, "error": 0}
	for t in trips:
		pkgs = pkg_by_trip.get(t.name, [])
		tds = dates_by_trip.get(t.name, [])
		linked = linked_dates_by_trip.get(t.name, set())

		errors: list = []
		warnings: list = []

		if t.status != "Active":
			errors.append("TRIP_NOT_ACTIVE")
		if not pkgs:
			errors.append("NO_ACTIVE_PACKAGE")
		else:
			if not any(price_counts.get(p.name) for p in pkgs):
				warnings.append("PKG_NO_PRICE")
			for p in bad_currency_packages.get(t.name, []):
				errors.append("PKG_CURRENCY_NOT_DECLARED")
			if not any(select_counts.get(p.name) for p in pkgs):
				warnings.append("PKG_NO_DATES_SELECTED")
		if not tds:
			errors.append("NO_ACTIVE_DEPARTURE")
		else:
			orphans = [d for d in tds if d.name not in linked]
			if orphans:
				errors.append("DEPARTURE_ORPHAN")
			if any(
				int(d.max_participants or 0)
				and int(d.current_participants or 0) >= int(d.max_participants)
				for d in tds
			):
				warnings.append("DEPARTURE_FULL")
		if t.is_a_cruise_trip and not schedule_counts.get(t.name):
			warnings.append("NO_CRUISE_SCHEDULE")
		if not t.published:
			warnings.append("TRIP_NOT_PUBLISHED")

		ready = not errors
		level = "error" if errors else ("warning" if warnings else "ready")
		tally[level] += 1
		out[t.name] = {
			"trip": t.name,
			"trip_name": t.trip_name,
			"status": t.status,
			"ready": ready,
			"level": level,
			"error_count": len(errors),
			"warning_count": len(warnings),
			"errors": errors,
			"warnings": warnings,
			"active_departures": len(tds),
			"active_packages": len(pkgs),
		}

	return {"trips": out, "summary": tally}
