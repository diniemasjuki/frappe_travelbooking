# travel_booking/api/trip_manager.py
# Trip Manager — API untuk Desk Page /app/trip-manager.
#
# Satu page mengurus 3 doctype berasingan (Trip / Trip Group Date /
# Trip Package). PRINSIP PENTING: semua tulisan melalui
# frappe.get_doc + insert()/save() — JANGAN frappe.db.set_value —
# supaya validate() controller kekal berfungsi:
#   - auto-generate trip_group_name/code, package_code/title,
#     price_variant_code, total_days/nights
#   - validasi urutan tarikh & logic cruise (cruise-only sync
#     departure/return dengan sailing)
#   - autoname (naming_series organizer / TP.YY.MM.##)
#
# Field set_only_once (trip_organizer, package_type, airport_form,
# is_cruise_only, ...) hanya dihantar semasa CREATE — selepas itu
# Frappe freeze nilai lama (sama macam behaviour Desk form).

import frappe
from frappe import _
from frappe.utils import flt

MANAGER_ROLES = ("Tour Manager", "Tour Operator")
MANAGED_DOCTYPES = ("Trip", "Trip Group Date", "Trip Package")

TRIP_FIELDS = (
	"trip_name",
	"status",
	"published",
	"is_a_cruise_trip",
	"route",
	"trip_image",
	"description",
)

GROUP_DATE_FIELDS = (
	"departure_date",
	"return_date",
	"max_participants",
	"status",
	"trip_group_description",
)

PACKAGE_FIELDS = (
	"currency",
	"status",
	"package_description",
)

PRICE_FIELDS = (
	"price_adult_single",
	"price_adult",
	"price_upperberth",
	"price_children",
	"price_toddler",
	"price_infant",
)


def _require_manager() -> str:
	"""Gate role untuk SEMUA endpoint di fail ini. Page Desk dah
	ada roles dalam Page JSON (Tour Manager/Operator) — check ni
	defence-in-depth untuk panggilan API terus."""
	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw(_("Please log in to continue."), frappe.AuthenticationError)
	if not set(frappe.get_roles()) & set(MANAGER_ROLES):
		frappe.throw(
			_("Only Tour Manager / Tour Operator can access Trip Manager."),
			frappe.PermissionError,
		)
	return user


def _apply_cruise_fetch(doc: object) -> None:
	"""Populate field fetched dari Trip Cruise Schedule secara
	eksplisit (sailing, ship, port, kod). Desk buat ni client-side
	(link fetch) — API perlu buat sendiri supaya validate() Trip
	Group Date ada semua nilai untuk jananama group + sync tarikh
	cruise-only. Mapping sama seperti fetch_from dalam DocType."""
	if not doc.cruise_schedule:
		return
	sch = frappe.db.get_value(
		"Trip Cruise Schedule",
		doc.cruise_schedule,
		(
			"trip_link",
			"trip_code",
			"schedule_code",
			"ship_name",
			"ship_code",
			"sail_start",
			"sail_end",
			"port_start",
			"port_end",
			"total_days",
		),
		as_dict=True,
	)
	if not sch:
		frappe.throw(_("Cruise Schedule {0} not found.").format(doc.cruise_schedule))
	doc.cruise_trip = sch.trip_link
	doc.cruise_code = sch.trip_code
	doc.cruise_schedule_title = sch.schedule_code
	doc.ship_name = sch.ship_name
	doc.ship_code = sch.ship_code
	doc.sailing_start = sch.sail_start
	doc.sailing_end = sch.sail_end
	doc.embarkation_port = sch.port_start
	doc.disembarkation_port = sch.port_end
	doc.cruise_days = sch.total_days


@frappe.whitelist()
def get_managed_trips(status: str = "", q: str = "") -> list[dict]:
	"""Senarai Trip untuk sidebar + kiraan child (dates/packages).
	Raw SQL — role dah di-gate di atas."""
	_require_manager()
	conds, params = [], {"status": status, "q": f"%{q}%"}
	if status:
		conds.append("t.status = %(status)s")
	if q:
		conds.append("(t.trip_name LIKE %(q)s OR t.name LIKE %(q)s)")
	where = ("WHERE " + " AND ".join(conds)) if conds else ""

	return frappe.db.sql(
		f"""
		SELECT
			t.name, t.trip_name, t.trip_organizer, t.status, t.published,
			t.is_a_cruise_trip, t.trip_image, t.route, t.modified,
			(SELECT COUNT(*) FROM `tabTrip Group Date` gd
				WHERE gd.trip = t.name) AS date_count,
			(SELECT COUNT(*) FROM `tabTrip Package` tp
				WHERE tp.trip_link = t.name) AS package_count
		FROM `tabTrip` t
		{where}
		ORDER BY t.modified DESC
		""",
		params,
		as_dict=True,
	)


@frappe.whitelist()
def get_trip_bundle(trip: str) -> dict:
	"""Satu call = semua data editor untuk satu Trip:
	trip + group dates + packages (dgn child tables) + lookup lists.
	Frontend reload bundle ini selepas setiap save supaya paparan
	sentiasa konsisten dengan nilai auto-generate server."""
	_require_manager()
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip))

	trip_doc = frappe.get_doc("Trip", trip)

	dates = frappe.db.sql(
		"""
		SELECT
			name, trip_group_name, trip_group_code, status,
			departure_date, return_date, total_days, total_nights,
			max_participants, current_participants,
			is_cruise_only, cruise_schedule, sailing_start, sailing_end,
			ship_name, ship_code, cruise_days,
			embarkation_port, disembarkation_port, trip_group_description,
			modified
		FROM `tabTrip Group Date`
		WHERE trip = %s
		ORDER BY departure_date ASC, creation ASC
		""",
		trip,
		as_dict=True,
	)
	for d in dates:
		# max_participants == 0 -> UNLIMITED (None), sepadan dengan
		# available_slots @property TripGroupDate.
		d.available_slots = None if not (d.max_participants or 0) else (d.max_participants - d.current_participants)

	packages = frappe.get_all(
		"Trip Package",
		filters={"trip_link": trip},
		fields=(
			"name", "package_title", "package_code", "package_type",
			"airport_form", "currency", "status", "is_cruise_only",
			"package_description", "my_url", "trip_image", "modified",
		),
		order_by="creation ASC",
	)
	package_names = [p.name for p in packages]

	if package_names:
		date_links = frappe.get_all(
			"Trip Package Group Date Select",
			filters={"parent": ("in", package_names), "parenttype": "Trip Package"},
			fields=("parent", "trip_group_date"),
			order_by="idx ASC",
		)
		pricing = frappe.get_all(
			"Trip Package Price",
			filters={"parent": ("in", package_names), "parenttype": "Trip Package"},
			fields=("parent", "name", "idx", "pricing_for_class", *PRICE_FIELDS),
			order_by="idx ASC",
		)
	else:
		date_links, pricing = [], []

	for p in packages:
		p.dates = [r.trip_group_date for r in date_links if r.parent == p.name]
		p.pricing = [
			{"name": r.name, "pricing_for_class": r.pricing_for_class,
				**{f: r.get(f) for f in PRICE_FIELDS}}
			for r in pricing if r.parent == p.name
		]

	return {
		"trip": {
			"name": trip_doc.name,
			"trip_name": trip_doc.trip_name,
			"trip_organizer": trip_doc.trip_organizer,
			"status": trip_doc.status,
			"published": trip_doc.published,
			"is_a_cruise_trip": trip_doc.is_a_cruise_trip,
			"route": trip_doc.route,
			"trip_image": trip_doc.trip_image,
			"description": trip_doc.description,
			"destinations": [
				row.select_destination_point for row in trip_doc.destination_list
			],
			"itinerary": [
				{
					"day": row.day,
					"day_title": row.day_title,
					"destination_point": row.destination_point,
					"meals": row.meals,
					"day_image": row.day_image,
					"description": row.description,
				}
				for row in (trip_doc.itinerary or [])
			],
			"modified": trip_doc.modified,
		},
		"dates": dates,
		"packages": packages,
		"lookups": {
			"organizers": frappe.get_all(
				"Trip Organizer", fields=("name", "org_name"), order_by="org_name"
			),
			"destinations": frappe.get_all(
				"Trip Destination Point",
				fields=("name", "destination_name"),
				order_by="destination_name",
			),
			"airports": frappe.get_all(
				"Flight Airport",
				filters={"enable": 1},
				fields=("name", "airport_name", "airport_code", "currency"),
				order_by="airport_name",
			),
			"currencies": frappe.get_all(
				"Currency", fields=("name", "currency_name"), order_by="name"
			),
			"price_categories": frappe.get_all(
				"Trip Price Category",
				fields=("name", "category_name", "category_group", "gred",
					"is_a_cruise", "category_code"),
				order_by="category_name",
			),
			"cruise_schedules": frappe.get_all(
				"Trip Cruise Schedule",
				filters={"trip_link": trip},
				fields=("name", "schedule_code", "ship_name", "ship_code",
					"sail_start", "sail_end", "total_days",
					"port_start", "port_end", "trip_code", "trip_link"),
				order_by="sail_start",
			),
		},
	}


@frappe.whitelist()
def room_categories(is_a_cruise: int = None, price_category: str = None) -> list:
	"""Senarai kategori rooming (Trip Price Category) untuk wizard Trip Baharu.
	Ditapis ikut price_category (Cruise/Tour/Hotel/Transport/Meal/Flight);
	param lama `is_a_cruise` (1/0) dipetakan ke Cruise/Tour untuk
	keserasian pemanggil sedia ada. Option_code paksi 'cabin' dalam Travel
	Package = category_code (atau docname jika kod kosong) — selari dengan
	peta jambatan offer_factory (cabin:CODE)."""
	_require_manager()
	filters = {}
	if price_category:
		filters["price_category"] = price_category
	elif is_a_cruise is not None:
		filters["price_category"] = "Cruise" if is_a_cruise else "Tour"
	return frappe.get_all(
		"Trip Price Category",
		filters=filters,
		fields=["name", "category_code", "category_group", "capacity",
			"max_capacity", "gred"],
		order_by="gred desc, name",
	)


@frappe.whitelist()
def room_category_info(code: str = None, name: str = None) -> dict:
	"""Maklumat PENUH satu kategori rooming (Trip Price Category) — untuk
	modal info pada kad Rooming Categories (Travel Date view). Carian ikut
	category_code dahulu (kunci kanonik v47), fallback nama kategori."""
	_require_manager()
	code = (code or "").strip()
	name = (name or "").strip()
	if not code and not name:
		frappe.throw(_("Code or name is required."))
	fields = ["name", "category_name", "category_code", "category_group",
			  "capacity", "max_capacity", "gred", "description",
			  "read_more_url", "youtube_url"]
	cat = None
	if code:
		cat = frappe.db.get_value("Trip Price Category",
								  {"category_code": code}, fields, as_dict=True)
	if not cat and name:
		cat = frappe.db.get_value("Trip Price Category",
								  {"name": name}, fields, as_dict=True)
	if not cat:
		# Rekod ringkas (kategori tiada dalam master — jangan pecahkan UI).
		return {"category_name": name or code, "category_code": code or ""}
	return cat


# Medan master Trip Price Category yang BOLEH dikemaskini melalui modal
# edit Rooming Type (Travel Manager) — senarai putih; medan lain (cth.
# price_category, room_profile) diurus di luar modal ini.
ROOM_CATEGORY_FIELDS = (
	"category_name", "category_code", "category_group",
	"capacity", "max_capacity", "gred", "description",
	"read_more_url", "youtube_url",
)


@frappe.whitelist(methods=["POST"])
def save_room_category(name: str, values: dict) -> dict:
	"""Kemaskini master Trip Price Category daripada modal info Rooming
	Type (kad Room Categories, Travel Manager). Medan senarai putih
	sahaja (ROOM_CATEGORY_FIELDS). Gate: Tour Manager sahaja — write
	doctype; Tour Operator baca sahaja, System Manager tiada peranan
	dalam senarai kebenaran doctype. doc.save() laksana validate + hooks."""
	frappe.only_for("Tour Manager")
	if not name or not frappe.db.exists("Trip Price Category", name):
		frappe.throw(_("Trip Price Category {0} not found").format(name))
	values = values or {}
	doc = frappe.get_doc("Trip Price Category", name)
	for f in ROOM_CATEGORY_FIELDS:
		if f in values:
			doc.set(f, values[f])
	doc.save()
	return {
		"name": doc.name,
		"category_name": doc.category_name,
		"category_code": doc.category_code,
	}


@frappe.whitelist()
def save_trip(payload: dict) -> dict:
	"""Create/update Trip. Create perlu trip_organizer (set_only_once).
	Route kosong → controller jana semula slug trips/<nama>."""
	_require_manager()
	payload = payload or {}

	if payload.get("name"):
		doc = frappe.get_doc("Trip", payload["name"])
		for f in TRIP_FIELDS:
			if f in payload:
				doc.set(f, payload[f])
	else:
		if not payload.get("trip_organizer"):
			frappe.throw(_("Trip Organizer is required for new Trip."))
		doc = frappe.get_doc(
			{
				"doctype": "Trip",
				"naming_series": "TRIP.YY.##",
				"trip_organizer": payload["trip_organizer"],
				**{f: payload.get(f) for f in TRIP_FIELDS},
			}
		)

	# destination_list: replace penuh — senarai nama destinasi
	doc.set(
		"destination_list",
		[
			{"select_destination_point": d}
			for d in (payload.get("destinations") or [])
			if d
		],
	)

	# itinerary: replace penuh — baris child table day-by-day.
	# [FIX Nov 2026] segment mesti ikut — dahulunya tergugur, menyebabkan
	# setiap save reset senyap Pre/Post-Cruise kepada default "Cruise".
	doc.set(
		"itinerary",
		[
			{
				"day": row.get("day"),
				"segment": row.get("segment"),
				"day_title": row.get("day_title"),
				"destination_point": row.get("destination_point"),
				"meals": row.get("meals"),
				"day_image": row.get("day_image"),
				"description": row.get("description"),
			}
			for row in (payload.get("itinerary") or [])
			if row
		],
	)

	if doc.is_new():
		doc.insert()
	else:
		doc.save()

	return {"name": doc.name, "route": doc.route, "published": doc.published}


@frappe.whitelist()
def save_group_date(payload: dict) -> dict:
	"""Create/update Trip Group Date. Nama group, kod & jumlah hari
	dijana validate() server — frontend tak hantar. Semasa create,
	naming_series/group_organizer/is_a_cruise_trip di-set eksplisit
	(mirrors fetch_from Desk) sebab naming_series adalah reqd."""
	_require_manager()
	payload = payload or {}

	if payload.get("name"):
		doc = frappe.get_doc("Trip Group Date", payload["name"])
		for f in GROUP_DATE_FIELDS:
			if f in payload:
				doc.set(f, payload[f])
	else:
		trip = payload.get("trip")
		if not trip or not frappe.db.exists("Trip", trip):
			frappe.throw(_("A valid Trip is required."))

		trip_organizer = frappe.db.get_value("Trip", trip, "trip_organizer")
		if not trip_organizer:
			frappe.throw(_("Trip {0} has no Trip Organizer.").format(trip))
		org_series = frappe.db.get_value("Trip Organizer", trip_organizer, "org_series")
		if not org_series:
			frappe.throw(
				_("Trip Organizer {0} has no Org Series — set it in the organizer master first.").format(trip_organizer)
			)

		doc = frappe.get_doc(
			{
				"doctype": "Trip Group Date",
				"trip": trip,
				"trip_name": frappe.db.get_value("Trip", trip, "trip_name"),
				"naming_series": org_series,
				"group_organizer": trip_organizer,
				"is_a_cruise_trip": frappe.db.get_value("Trip", trip, "is_a_cruise_trip"),
				# set_only_once — hanya berkesan semasa create
				"is_cruise_only": payload.get("is_cruise_only") or 0,
				**{f: payload.get(f) for f in GROUP_DATE_FIELDS},
			}
		)

	# cruise_schedule boleh ditukar selepas create (bukan set_only_once)
	if "cruise_schedule" in payload and doc.is_a_cruise_trip:
		doc.cruise_schedule = payload.get("cruise_schedule") or None
	_apply_cruise_fetch(doc)

	if doc.is_new():
		doc.insert()
	else:
		doc.save()

	return {
		"name": doc.name,
		"trip_group_name": doc.trip_group_name,
		"trip_group_code": doc.trip_group_code,
	}


@frappe.whitelist()
def save_package(payload: dict) -> dict:
	"""Create/update Trip Package. package_type / airport_form /
	is_cruise_only adalah set_only_once — hantar semasa create sahaja.
	Child tables replace-penuh; baris pricing sedia ada diguna semula
	(kekalkan row name bila pricing_for_class sama) supaya
	price_variant_code & history kekal stabil."""
	_require_manager()
	payload = payload or {}

	if payload.get("name"):
		doc = frappe.get_doc("Trip Package", payload["name"])
		for f in PACKAGE_FIELDS:
			if f in payload:
				doc.set(f, payload[f])
	else:
		trip_link = payload.get("trip_link")
		if not trip_link or not frappe.db.exists("Trip", trip_link):
			frappe.throw(_("A valid Trip is required."))
		if not payload.get("package_type"):
			frappe.throw(_("Package Type is required."))

		trip_vals = frappe.db.get_value(
			"Trip", trip_link, ("trip_name", "trip_organizer", "is_a_cruise_trip", "trip_image"),
			as_dict=True,
		)
		# PACKAGE_FIELDS termasuk currency; bina dahulu & pastikan default
		# MYR — elak `**` override yang hilangkan fallback (currency reqd).
		pkg_fields = {f: payload.get(f) for f in PACKAGE_FIELDS}
		if not pkg_fields.get("currency"):
			pkg_fields["currency"] = "MYR"
		doc = frappe.get_doc(
			{
				"doctype": "Trip Package",
				"trip_link": trip_link,
				"organizer_link": trip_vals.trip_organizer,
				"trip_name": trip_vals.trip_name,
				"trip_image": trip_vals.trip_image,
				"is_a_cruise_trip": trip_vals.is_a_cruise_trip,
				"is_cruise_only": payload.get("is_cruise_only") or 0,
				"package_type": payload["package_type"],
				"airport_form": payload.get("airport_form") or None,
				**pkg_fields,
			}
		)

	# Tarikh (M:N) — replace penuh dengan senarai nama Trip Group Date
	doc.set(
		"select_group_by_date",
		[
			{"trip_group_date": d}
			for d in (payload.get("dates") or [])
			if d
		],
	)

	# Pricing — reuse row sedia ada ikut pricing_for_class
	existing = {row.pricing_for_class: row for row in (doc.package_pricing or [])}
	new_rows = []
	for p in (payload.get("pricing") or []):
		cls = p.get("pricing_for_class")
		if not cls:
			continue
		if cls in existing:
			row = existing.pop(cls)
		else:
			row = {"pricing_for_class": cls}
		if isinstance(row, dict):
			row.update({f: flt(p.get(f)) for f in PRICE_FIELDS})
		else:
			for f in PRICE_FIELDS:
				row.set(f, flt(p.get(f)))
		new_rows.append(row)
	doc.set("package_pricing", new_rows)

	if doc.is_new():
		doc.insert()
	else:
		doc.save()

	return {
		"name": doc.name,
		"package_title": doc.package_title,
		"package_code": doc.package_code,
	}


@frappe.whitelist()
def delete_doc(doctype: str, name: str) -> dict:
	"""Delete Trip Group Date / Trip Package / Trip. frappe.delete_doc
	enforce permission delete (Tour Operator TIADA delete — dia akan
	dapat error) + link-integrity check (cth Group Date berbooking)."""
	_require_manager()
	if doctype not in MANAGED_DOCTYPES:
		frappe.throw(_("Deleting {0} is not allowed here.").format(doctype), frappe.PermissionError)

	frappe.delete_doc(doctype, name)
	return {"ok": True}


# ── TRIP WEBSITE CONTENT (Travel Manager — view website, Nov 2026) ──
# Urus kandungan tab Website doctype Trip TANPA akses terus borang Trip
# (elak pengguna menyentuh medan operasi: status, organizer, components,
# itinerary master dll). Skop = medan kandungan web + 5 child table
# kandungan + galeri (rekod File dilampir pada Trip).

WEBSITE_FIELDS = (
	"title",
	"route",
	# [Nov 2026] status trip — boleh dikemas kini dari kad CONTENT halaman
	# Website (row 2) tanpa akses borang Trip.
	"status",
	"published",
	"trip_image",
	"video_url",
	"description",
	"featured_trip",
	# [BUANG Nov 2026] itinerary_title / itinerary_caption — medan SEO
	# dipermudahkan (auto-fill) dan label laman web guna fallback template.
	"meta_title",
	"meta_description",
	"meta_image",
	"meta_noindex",
)

# child table → kolum yang dibenarkan disimpan (whitelist tegas).
# [Nov 2026] segment dibuang daripada doctype Trip Itinerary.
WEBSITE_CHILD_FIELDS = {
	# [FIX Nov 2026] day_image ditambah — dahulunya tergugur pada
	# round-trip (get_trip_website tak hantar → save_trip_website replace
	# penuh → imej hari hilang senyap setiap kali Website tab disimpan).
	"itinerary": ("day", "day_title", "destination_point",
		"meals", "day_image", "description"),
	"highlights": ("highlight",),
	"features": ("included", "feature"),
	"faqs": ("question", "answer"),
	"facilities": ("facility", "icon"),
}

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif")


def _trip_gallery(trip: str) -> list:
	"""Fail imej PUBLIC yang dilampir pada Trip (galeri web) — sumber sama
	dengan field Attachment Gallery di Desk; fail private tidak dihantar
	(URL /private/files/ perlu auth)."""
	files = frappe.get_all(
		"File",
		filters={
			"attached_to_doctype": "Trip",
			"attached_to_name": trip,
			"is_folder": 0,
			"is_private": 0,
		},
		fields=["name", "file_url"],
		order_by="creation asc",
		limit_page_length=0,
	)
	return [
		{"file_name": f.name, "file_url": f.file_url}
		for f in files
		if f.file_url and f.file_url.lower().endswith(_IMAGE_EXTS)
	]


@frappe.whitelist()
def get_trip_website(trip: str) -> dict:
	"""Baca penuh kandungan website satu Trip untuk halaman manage."""
	_require_manager()
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip))

	doc = frappe.get_doc("Trip", trip)
	out = {"trip": trip, "trip_name": doc.trip_name,
		"published": doc.published}
	for f in WEBSITE_FIELDS:
		out[f] = doc.get(f)
	out["gallery"] = _trip_gallery(trip)
	for key in WEBSITE_CHILD_FIELDS:
		out[key] = [
			{k: r.get(k) for k in WEBSITE_CHILD_FIELDS[key]}
			for r in (doc.get(key) or [])
		]
	return out


@frappe.whitelist()
def save_trip_website(payload: dict) -> dict:
	"""Simpan kandungan website Trip (scalar + child tables + kekal
	galeri — galeri diurus melalui upload/remove endpoint berasingan).
	Semua tulisan melalui doc.save() supaya validate() controller kekal
	berjalan (cth. auto-slug route bila kosong)."""
	_require_manager()
	payload = payload or {}
	trip = payload.get("trip")
	if not trip or not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip))

	doc = frappe.get_doc("Trip", trip)
	for f in WEBSITE_FIELDS:
		if f in payload:
			# Checkbox HTML menghantar "0"/"1" — normalisasikan ke bool.
			doc.set(f, payload[f] in (1, "1", True) if f in ("published", "featured_trip", "meta_noindex") else payload[f])

	for key, cols in WEBSITE_CHILD_FIELDS.items():
		if key in payload:
			rows = []
			for r in (payload.get(key) or []):
				row = {}
				for c in cols:
					v = r.get(c)
					if c == "day" and v not in (None, ""):
						v = int(flt(v))
					elif c == "included":
						v = 1 if v in (1, "1", True) else 0
					row[c] = v
				rows.append(row)
			doc.set(key, rows)

	doc.save()
	return {"ok": True, "route": doc.route}


@frappe.whitelist()
def remove_trip_gallery_file(trip: str, file_name: str) -> dict:
	"""Buang SATU fail imej daripada galeri Trip — hanya rekod File yang
	benar-benar dilampir pada trip itu (defence: user tak boleh padam fail
	lain dengan menyebut nama sewenangnya)."""
	_require_manager()
	if not frappe.db.exists("Trip", trip):
		frappe.throw(_("Trip {0} not found.").format(trip))
	f = frappe.db.get_value(
		"File", file_name,
		["name", "attached_to_doctype", "attached_to_name", "file_url", "owner"],
		as_dict=True,
	)
	if not f or f.attached_to_doctype != "Trip" or f.attached_to_name != trip:
		frappe.throw(_("File is not attached to this trip."), frappe.PermissionError)
	# Pemilik fail ATAU manager sahaja boleh buang.
	if f.owner != frappe.session.user and "Tour Manager" not in frappe.get_roles():
		frappe.throw(_("Only the file owner or a Tour Manager can remove this file."),
			frappe.PermissionError)
	frappe.delete_doc("File", f.name, ignore_permissions=True)
	return {"ok": True, "gallery": _trip_gallery(trip)}


@frappe.whitelist()
def get_faq_templates() -> list:
	"""Senarai FAQ template master (Trip FAQ Template — diurus di Desk)
	untuk butang "📋 Dari Template" kad FAQ halaman Website. Endpoint
	gated manager; bacaan melalui get_all (master content, bukan doc
	user-specific)."""
	_require_manager()
	return frappe.get_all(
		"Trip FAQ Template",
		filters={"question": ("is", "set")},
		fields=["question", "answer", "topic"],
		order_by="topic asc, creation asc",
		limit_page_length=0,
	)
