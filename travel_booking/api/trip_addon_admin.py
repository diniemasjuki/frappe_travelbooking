# travel_booking/api/trip_addon_admin.py
# Backend API untuk TRIP ADDON MANAGER
# (/app/travel-manager/trip-addon — sub-menu Trip, seksyen travel_manager).
#
# Mengurus rekod Trip Addon (produk upsell) + Trip Addon Package (variant
# harga/scoping) SEPENUHNYA tanpa akses borang doctype terus (corak
# cruise_schedule_admin — arahan pemilik Nov 2026): senarai + penapis
# (carian, jenis, disable), detail penuh (pakej + rate multi-currency +
# scoping + jualan), cipta/simpan (validate doctype kekal jalan —
# rate currency diisytiharkan, scoping wajib bila Specific) dan padam
# dengan semakan dependensi.
#
# Role gates (selari cruise_schedule_admin + permission doctype):
#   Baca  : System Manager, Tour Manager, Tour Operator, Accounts User
#   Tulis : System Manager, Tour Manager, Tour Operator
#   Padam : System Manager, Tour Manager   (selari permissions Trip Addon
#           — Tour Operator tiada delete)

import json

import frappe
from frappe import _

# ══════════════════════════════════════════════
# PERMISSION GATES
# ══════════════════════════════════════════════

ADDON_READ_ROLES = ["System Manager", "Tour Manager", "Tour Operator", "Accounts User"]
ADDON_WRITE_ROLES = ["System Manager", "Tour Manager", "Tour Operator"]
ADDON_DELETE_ROLES = ["System Manager", "Tour Manager"]

# Medan Trip Addon yang dibenarkan di-set oleh save_trip_addon.
ADDON_FIELDS = [
	"addon_title", "addon_type", "addon_organizer", "disable",
	"cover_image", "youtube_video_url", "description",
]

# Medan Trip Addon Package yang dibenarkan oleh save_addon_package.
PACKAGE_FIELDS = [
	"addon", "addon_package_name", "status", "scope", "applicable_to",
	"validity_mode", "valid_from_offset_days", "valid_to_offset_days",
	"fixed_valid_from", "fixed_valid_to",
	"max_qty_per_booking", "max_total_qty",
	"sales_cutoff_enabled", "sales_cutoff_days_before_departure",
]

# Medan child yang dibenarkan (diganti keseluruhan — corak cabin_rates).
# RECONDITION Nov 2026: scoping kini Package Offer / Travel Date.
RATE_FIELDS = ["currency", "unit_price", "enabled"]
SCOPING_FIELDS = ["trip", "travel_date", "package_offer"]


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
	_check_roles(ADDON_READ_ROLES, _("Trip Addon Manager"))


def _require_write():
	_check_roles(ADDON_WRITE_ROLES, _("manage trip addons"))


def _require_delete():
	_check_roles(ADDON_DELETE_ROLES, _("delete trip addons"))


# ══════════════════════════════════════════════
# SENARAI + PENAPIS
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_trip_addons(search: str = None, addon_type: str = None,
		include_disabled: int = 1, limit: int = 500) -> dict:
	"""Senarai Trip Addon + kiraan agregat utk datatable.

	Penapis (semua opsional, digabung AND):
	  search           — substring pada addon_title/name/organizer
	  addon_type       — padanan tepat (Activity/Upgrade/Transfer/Other)
	  include_disabled — 0 = sorokkan addon berflag disable

	Agregat per baris: packages_count + active_packages (Trip Addon
	Package), sold_total (current_qty_sold), min_rate + min_rate_currency
	(baris rate enabled termurah — merentas currency, angka muktamad
	dipaparkan bersama kod currency).
	"""
	_require_read()

	filters = []
	params = []

	if search:
		filters.append(
			"""(a.addon_title LIKE %s OR a.name LIKE %s
				OR IFNULL(a.addon_organizer, '') LIKE %s)"""
		)
		like = f"%{search.strip()}%"
		params += [like] * 3

	if addon_type:
		filters.append("a.addon_type = %s")
		params.append(addon_type)

	if not int(include_disabled or 0):
		filters.append("a.disable = 0")

	where = ("WHERE " + " AND ".join(filters)) if filters else ""

	rows = frappe.db.sql(
		f"""
		SELECT a.name, a.addon_title, a.addon_type, a.addon_organizer,
			a.disable, a.cover_image, a.creation
		FROM `tabTrip Addon` a
		{where}
		ORDER BY a.disable asc, a.addon_type, a.addon_title
		LIMIT %s
		""",
		tuple(params + [int(limit)]),
		as_dict=True,
	)

	addons = []
	if rows:
		names = [r.name for r in rows]

		# Agregat pakej per addon (kiraan + jualan).
		pkg_agg = {
			r.addon: r for r in frappe.db.sql(
				"""
				SELECT addon, COUNT(name) AS packages_count,
					SUM(status = 'Active') AS active_packages,
					COALESCE(SUM(current_qty_sold), 0) AS sold_total
				FROM `tabTrip Addon Package`
				WHERE addon IN %(names)s
				GROUP BY addon
				""",
				{"names": names},
				as_dict=True,
			)
		}
		# Rate termurah (enabled) per addon — join pakej → rate rows.
		rate_agg = {
			r.addon: r for r in frappe.db.sql(
				"""
				SELECT p.addon, r.currency, r.unit_price
				FROM `tabTrip Addon Package Rate` r
				JOIN `tabTrip Addon Package` p ON p.name = r.parent
				WHERE r.parenttype = 'Trip Addon Package'
					AND r.enabled = 1 AND p.addon IN %(names)s
				ORDER BY r.unit_price asc
				""",
				{"names": names},
				as_dict=True,
			)
		}

		for r in rows:
			r.packages_count = int(pkg_agg.get(r.name, {}).get("packages_count") or 0)
			r.active_packages = int(pkg_agg.get(r.name, {}).get("active_packages") or 0)
			r.sold_total = int(pkg_agg.get(r.name, {}).get("sold_total") or 0)
			rr = rate_agg.get(r.name)
			r.min_rate = rr.unit_price if rr else None
			r.min_rate_currency = rr.currency if rr else None
			addons.append(r)

	return {"addons": addons}


# ══════════════════════════════════════════════
# DETAIL
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_trip_addon_detail(addon: str) -> dict:
	"""Detail SATU addon: rekod penuh + imej galeri + senarai pakej
	(rate multi-currency + scoping + jualan)."""
	_require_read()

	if not addon or not frappe.db.exists("Trip Addon", addon):
		frappe.throw(_("Trip Addon {0} not found").format(addon), frappe.DoesNotExistError)

	doc = frappe.get_doc("Trip Addon", addon).as_dict()

	# Galeri (medan maya — baris tabFile, corak addon_manager).
	gallery_images = [
		r.file_url for r in frappe.db.sql(
			"""
			SELECT file_url
			FROM tabFile
			WHERE attached_to_doctype = 'Trip Addon'
				AND attached_to_field = 'addon_gallery'
				AND is_private = 0 AND attached_to_name = %s
			ORDER BY creation ASC
			""",
			(addon,),
			as_dict=True,
		)
	]

	packages = frappe.get_all(
		"Trip Addon Package",
		filters={"addon": addon},
		fields=["name", "addon_package_name", "status", "scope", "applicable_to",
			"validity_mode", "valid_from_offset_days", "valid_to_offset_days",
			"fixed_valid_from", "fixed_valid_to", "max_qty_per_booking",
			"max_total_qty", "current_qty_sold", "sales_cutoff_enabled",
			"sales_cutoff_days_before_departure", "creation"],
		order_by="creation desc",
		limit=100,
	)

	if packages:
		pkg_names = [p.name for p in packages]

		# Rate rows + scoping rows + kiraan item jualan per pakej.
		rates_map = {}
		for r in frappe.get_all(
			"Trip Addon Package Rate",
			filters={"parenttype": "Trip Addon Package", "parent": ["in", pkg_names]},
			fields=["parent", "currency", "unit_price", "enabled"],
			order_by="idx asc",
		):
			rates_map.setdefault(r.parent, []).append(
				{"currency": r.currency, "unit_price": r.unit_price, "enabled": r.enabled}
			)
		scoping_map = {}
		for s in frappe.get_all(
			"Trip Scoping",
			filters={"parent": ["in", pkg_names], "parenttype": "Trip Addon Package"},
			fields=["parent", "trip", "trip_name", "travel_date", "travel_date_name",
				"package_offer", "offer_name"],
			order_by="idx asc",
		):
			scoping_map.setdefault(s.parent, []).append(s)
		sold_map = {
			r.addon_package: r.total for r in frappe.db.sql(
				"""
				SELECT addon_package, COUNT(name) AS total
				FROM `tabBooking Addon Item`
				WHERE addon_package IN %(names)s AND status != 'Cancelled'
				GROUP BY addon_package
				""",
				{"names": pkg_names},
				as_dict=True,
			)
		}

		for p in packages:
			p.currency_rates = rates_map.get(p.name, [])
			p.trip_scoping = scoping_map.get(p.name, [])
			p.sold_items = int(sold_map.get(p.name, 0))

	return {
		"addon": doc,
		"gallery_images": gallery_images,
		"packages": packages,
	}


# ══════════════════════════════════════════════
# META — CURRENCY RATE (opsyen dialog pakej)
# ══════════════════════════════════════════════

@frappe.whitelist()
def get_rate_currency_options() -> list:
	"""Opsyen currency yang diisytiharkan (paksi axis) untuk baris rate
	dialog pakej — rate luar senarai ini akan ditolak oleh validate()
	Trip Addon Package, jadi terus hadkan pilihan di UI."""
	_require_read()

	from travel_booking.api.currency_axis import get_currency_options
	return get_currency_options()


# ══════════════════════════════════════════════
# SIMPAN (CIPTA / KEMASKINI)
# ══════════════════════════════════════════════

@frappe.whitelist()
def save_trip_addon(values: str) -> dict:
	"""Cipta / kemaskini Trip Addon (produk).

	`values` = JSON string; name kosong/null = CIPTA.
	Semua melalui doc.save() supaya constraint doctype kekal jalan
	(addon_title unik, naming series TADD.YY.MM.##).
	"""
	_require_write()

	data = json.loads(values) if isinstance(values, str) else (values or {})
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values payload"))

	name = (data.get("name") or "").strip()
	if name:
		if not frappe.db.exists("Trip Addon", name):
			frappe.throw(_("Trip Addon {0} not found").format(name), frappe.DoesNotExistError)
		doc = frappe.get_doc("Trip Addon", name)
	else:
		doc = frappe.new_doc("Trip Addon")

	for fieldname in ADDON_FIELDS:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))

	doc.save()

	return {"name": doc.name, "addon_title": doc.addon_title, "is_new": not name}


@frappe.whitelist()
def save_addon_package(values: str) -> dict:
	"""Cipta / kemaskini Trip Addon Package (variant harga/scoping).

	`values` = JSON string:
	  name           — kosong/null = CIPTA
	  currency_rates — array baris {currency, unit_price, enabled}
	  trip_scoping   — array baris {trip, travel_date, package_offer}
	                   (RECONDITION Nov 2026 — Package Offer / Travel Date)

	Child tables diganti keseluruhan (corak cabin_rates — baris dibina
	semula). validate() doctype kekal jalan: rate currency mesti
	diisytiharkan dalam axis & unik; scoping wajib bila Specific Trips.
	"""
	_require_write()

	data = json.loads(values) if isinstance(values, str) else (values or {})
	if not isinstance(data, dict):
		frappe.throw(_("Invalid values payload"))

	name = (data.get("name") or "").strip()
	if name:
		if not frappe.db.exists("Trip Addon Package", name):
			frappe.throw(_("Trip Addon Package {0} not found").format(name), frappe.DoesNotExistError)
		doc = frappe.get_doc("Trip Addon Package", name)
	else:
		doc = frappe.new_doc("Trip Addon Package")

	for fieldname in PACKAGE_FIELDS:
		if fieldname in data:
			doc.set(fieldname, data.get(fieldname))

	if "currency_rates" in data:
		rates = data.get("currency_rates") or []
		if not isinstance(rates, list):
			frappe.throw(_("currency_rates must be a list"))
		doc.set("currency_rates", [])
		for row in rates:
			if not isinstance(row, dict) or not row.get("currency"):
				continue  # baris tanpa currency tidak bermakna — buang senyap
			clean = {k: row.get(k) for k in RATE_FIELDS if k in row}
			doc.append("currency_rates", clean)

	if "trip_scoping" in data:
		scoping = data.get("trip_scoping") or []
		if not isinstance(scoping, list):
			frappe.throw(_("trip_scoping must be a list"))
		doc.set("trip_scoping", [])
		for row in scoping:
			if not isinstance(row, dict):
				continue
			# Baris kosong (tiada trip/travel date/offer) — buang senyap.
			if not any(row.get(k) for k in SCOPING_FIELDS):
				continue
			clean = {k: row.get(k) for k in SCOPING_FIELDS if k in row}
			doc.append("trip_scoping", clean)

	doc.save()

	return {"name": doc.name, "status": doc.status, "is_new": not name}


# ══════════════════════════════════════════════
# PADAM
# ══════════════════════════════════════════════

@frappe.whitelist()
def delete_addon_package(package: str) -> dict:
	"""Padam Trip Addon Package SELEPAS semakan dependensi.

	DISEKAT bila masih ada Booking Addon Item (sebarang status) yang
	merujuk pakej ini — baris jualan sejarah kekal berpaut pada pakej.
	"""
	_require_delete()

	if not package or not frappe.db.exists("Trip Addon Package", package):
		frappe.throw(_("Trip Addon Package {0} not found").format(package), frappe.DoesNotExistError)

	items = frappe.db.count("Booking Addon Item", {"addon_package": package})
	if items:
		frappe.throw(
			_("Cannot delete addon package {0} — still referenced by {1} booking "
				"addon item(s). Cancel/resolve those sales records first.").format(
				package, items),
			title=_("Package In Use"),
		)

	frappe.delete_doc("Trip Addon Package", package)
	return {"deleted": package}


@frappe.whitelist()
def delete_trip_addon(addon: str) -> dict:
	"""Padam Trip Addon SELEPAS semakan dependensi.

	DISEKAT bila masih ada Trip Addon Package (padam pakej dahulu) atau
	Booking Addon Item yang merujuk mana-mana pakej addon ini.
	"""
	_require_delete()

	if not addon or not frappe.db.exists("Trip Addon", addon):
		frappe.throw(_("Trip Addon {0} not found").format(addon), frappe.DoesNotExistError)

	packages = frappe.get_all(
		"Trip Addon Package", filters={"addon": addon}, pluck="name")
	if packages:
		frappe.throw(
			_("Cannot delete addon {0} — it still has {1} package(s): {2}. "
				"Delete the packages first.").format(
				addon, len(packages),
				", ".join(packages[:5]) + ("…" if len(packages) > 5 else "")),
			title=_("Addon In Use"),
		)

	items = frappe.db.count(
		"Booking Addon Item",
		{"addon": addon},
	)
	if items:
		frappe.throw(
			_("Cannot delete addon {0} — still referenced by {1} booking addon "
				"item(s).").format(addon, items),
			title=_("Addon In Use"),
		)

	frappe.delete_doc("Trip Addon", addon)
	return {"deleted": addon}
