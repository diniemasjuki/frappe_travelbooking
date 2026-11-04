# travel_booking/utils/offer_factory.py
#
# Faktori Package Offer (F2) — SATU laluan penciptaan offer daripada
# Travel Package (salin matriks harga daripada templat + jana baris
# inventori daripada paksi ber-sifat "inventory").
#
# Diguna oleh:
#   - patch v40 (migrasi TGD → offer, dengan seed allotment/sold)
#   - api/package_admin.generate_offer_from_template (offer baharu oleh staf)
#
# Prinsip: offer TIDAK meniru data ops (jadual kapal/penerbangan dirujuk);
# yang disalin hanyalah TEMPLET HARGA + INVENTORI (kerana itu berubah
# per-keberangkatan).

import frappe

AGE_OPTIONS = [
	("ADULT", "Adult (12+)"), ("CHILD", "Child (5-11)"),
	("INFANT", "Infant (0-23mo)"), ("TODDLER", "Toddler (2-4)"),
]

STATUS_EDITORIAL_MAP = {
	"Active": "Active", "Pending Review": "Draft", "Cancelled": "Cancelled",
	"Running": "Active", "Sailing": "Active", "Full": "Active",
	"Closed": "Active", "Completed": "Active",
}
STATUS_OPERATIONAL_MAP = {
	"Active": "Scheduled", "Pending Review": "Scheduled", "Cancelled": "Scheduled",
	"Running": "Running", "Sailing": "Sailing", "Full": "Full",
	"Closed": "Closed", "Completed": "Completed",
}


def _inventory_axes(pkg):
	"""Paksi ber-sifat inventory, tersusun ikut sort_order — menentukan
	format kanonik inventory_key."""
	axes = [ax for ax in (pkg.variant_axes or []) if ax.nature == "inventory"]
	return sorted(axes, key=lambda a: (a.sort_order or 0))


def _options_by_axis(pkg):
	opts: dict = {}
	for o in (pkg.variant_options or []):
		opts.setdefault(o.axis_code, []).append(o)
	for code in opts:
		opts[code].sort(key=lambda o: (o.sort_order or 0))
	return opts


def inventory_keys_for(pkg):
	"""Set inventory_key sah untuk pakej — hasil darab Cartesius paksi
	inventory (cth: 'cabin:BALCONY', 'cabin:BALCONY|occ:TWIN')."""
	axes = _inventory_axes(pkg)
	if not axes:
		return []
	opts = _options_by_axis(pkg)
	combo = [{}]
	for ax in axes:
		new = []
		for base in combo:
			for o in opts.get(ax.axis_code, []):
				item = dict(base)
				item[ax.axis_code] = o.option_code
				new.append(item)
		combo = new
	keys = []
	for item in combo:
		key = "|".join(f"{ax}:{item[ax]}" for ax in (a.axis_code for a in axes) if ax in item)
		if key:
			keys.append(key)
	return keys


def create_offer(package: str, values: dict, inventory_seeds: dict = None) -> str:
	"""Cipta Package Offer daripada Travel Package.

	:param package: nama Travel Package
	:param values: medan offer (departure_date wajib, dsb.) — status_editorial/
	    status_operational boleh dihantar (patch migrasi); default Draft/Scheduled
	:param inventory_seeds: {inventory_key: {"allotment": int, "sold": int}}
	    (patch migrasi); tanpa seeds → allotment/sold = 0
	:return: nama offer yang dicipta
	"""
	pkg = frappe.get_doc("Travel Package", package)
	data = {
		"doctype": "Package Offer",
		"naming_series": "OFF-.YYYY.-.####",
		"package": pkg.name,
	}
	data.update(values or {})
	offer = frappe.get_doc(data)

	# Salin matriks harga templat → offer (override per-offer kemudian)
	for t in (pkg.price_template or []):
		if not t.active:
			continue
		offer.append("prices", {
			"price_key": t.price_key,
			"opt1": t.opt1, "opt2": t.opt2, "opt3": t.opt3,
			"age_option": t.age_option,
			"currency": t.currency or pkg.default_currency,
			"price": t.price,
			"active": 1,
		})

	# Jana inventori per kombinasi paksi inventory — salin harga templat yang
	# sepadan JUGA sediakan allotment/sold dari seeds (patch migrasi)
	seeds = inventory_seeds or {}
	for key in inventory_keys_for(pkg):
		seed = seeds.get(key, {})
		offer.append("inventory", {
			"inventory_key": key,
			"allotment": int(seed.get("allotment") or 0),
			"sold": int(seed.get("sold") or 0),
		})

	# Komponen selesai — cruise_tour + flight (kalau ada)
	trip = None
	for c in (pkg.components or []):
		if c.component_type == "cruise_tour":
			trip = c.trip
	offer.append("components", {
		"component_type": "cruise_tour",
		"trip": trip,
		"cruise_schedule": offer.get("cruise_schedule"),
		"resolved_start": offer.departure_date,
		"resolved_end": offer.return_date,
	})
	if offer.get("flight"):
		offer.append("components", {
			"component_type": "flight",
			"flight": offer.flight,
			"resolved_start": offer.departure_date,
			"resolved_end": offer.departure_date,
		})

	offer.insert(ignore_permissions=True, ignore_links=True)
	return offer.name


def seeds_from_allotment(pkg, old_package_name: str) -> dict:
	"""Seed allotment daripada cabin_allotment harga lama (Trip Package Price)
	untuk pakej baharu — dipakai patch v40. sold di-backfill berasingan
	(dari reservasi) oleh patch."""
	seeds: dict = {}
	rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": old_package_name},
		fields=["pricing_for_class", "cabin_allotment"],
	)
	# category docname → option_code ( Variant Option paksi cabin pakej ni)
	code_map = {
		o.option_code: o.option_code
		for o in (pkg.variant_options or []) if o.axis_code == "cabin"
	}
	# option_code boleh jadi category_code ATAU docname (fallback v39) —
	# bina peta dua hala melalui Trip Price Category
	cat_names = frappe.get_all(
		"Trip Price Category", fields=["name", "category_code"]
	)
	docname_to_code = {
		c.name: (c.category_code or c.name) for c in cat_names
	}
	for o in (pkg.variant_options or []):
		if o.axis_code == "cabin":
			code_map[docname_to_code.get(o.option_code, o.option_code)] = o.option_code

	for r in rows:
		code = docname_to_code.get(r.pricing_for_class, r.pricing_for_class)
		opt = code_map.get(code)
		if not opt:
			continue
		key = f"cabin:{opt}"
		seeds[key] = {"allotment": int(r.cabin_allotment or 0), "sold": 0}
	return seeds


def sold_from_reservations(tgd_name: str, old_package_name: str = None) -> dict:
	"""Sold per cabin UNTUK SATU keberangkatan (TGD lama) — kiraan reservasi
	tak-cancelled melalui Booking.trip_date.

	FILTER PENTING (bug v40 #1): reservasi MILIK SATU pakej — tanpa filter
	`b.trip_package`, pakej FC dan CO yang sama-sama pilih TGD akan
	DUPLICAT-KIRA reservasi yang sama pada dua offer berbeza.
	Kembalikan {category_docname: n}."""
	values = {"tgd": tgd_name}
	package_filter = ""
	if old_package_name:
		values["pkg"] = old_package_name
		package_filter = "AND b.trip_package = %(pkg)s"
	rows = frappe.db.sql(
		f"""
		SELECT br.room_category AS cat, COUNT(*) AS n
		FROM `tabBooking Reservation` br
		INNER JOIN `tabBooking` b ON b.name = br.booking
		WHERE b.trip_date = %(tgd)s
		  {package_filter}
		  AND br.status != 'Cancelled'
		  AND br.room_category IS NOT NULL AND br.room_category != ''
		GROUP BY br.room_category
		""",
		values,
		as_dict=True,
	)
	return {r.cat: int(r.n) for r in rows}
