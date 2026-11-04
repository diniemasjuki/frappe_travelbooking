"""Patch v39: migrasi salinan Trip Package → Travel Package (F1 struktur produk sasaran).

SENASIB (rujuk docs spesifikasi "Pakej = Komposisi × Varian"):
  - Trip Package            → Travel Package (trip_link→trip, package_type→package_template
                              [NILAI SAMA — tiada pemetaan], currency→default_currency,
                              status: Inactive→Retired)
  - Trip Package Price      → Package Price Template (KEMBANG wide→long: setiap baris kabin
                              × 4 umur (adult/children/infant/toddler) → 4 baris matriks)
  - Trip Price Category     → Variant Axis 'cabin' (inventory) + Variant Option
                              (option_code = category_code, fallback nama)
  - paksi 'age'             → standard tetap (ADULT/CHILD/INFANT/TODDLER)
  - komponen                → cruise_tour (semua) + flight (untuk Cruise + Flight / Fly Package,
                              tiada pautan Flight — Flight Request flow sedia ada kekal)

IDEMPOTENT & PRODUCTION-SAFE:
  - skip penuh bila Travel Package sudah ada data (re-run selamat)
  - skip penuh bila tiada Trip Package (site baharu / kosong)
  - kegagalan per-pakeg dilog dan diteruskan (satu rosak tidak menghentikan batch)
  - TIADA pemadaman/pengubahan data lama — old doctype dibekukan kemudian (F4)
"""
import frappe

STATUS_MAP = {"Active": "Active", "Pending Review": "Pending Review", "Inactive": "Retired"}
AGE_FIELDS = [
	("price_adult", "ADULT"),
	("price_children", "CHILD"),
	("price_infant", "INFANT"),
	("price_toddler", "TODDLER"),
]
AGE_OPTIONS = [
	("ADULT", "Adult (12+)"), ("CHILD", "Child (5-11)"),
	("INFANT", "Infant (0-23mo)"), ("TODDLER", "Toddler (2-4)"),
]


def execute():
	if frappe.db.count("Travel Package") > 0:
		print("v39: Travel Package sudah ada data — skip (idempotent)")
		return
	if not frappe.db.count("Trip Package"):
		print("v39: tiada Trip Package — tiada data untuk migrasi")
		return

	categories = {
		c.name: c
		for c in frappe.get_all(
			"Trip Price Category",
			fields=["name", "category_name", "category_code", "room_type"],
		)
	}

	migrated, failed = 0, 0
	packages = frappe.get_all(
		"Trip Package",
		fields=[
			"name", "trip_link", "status", "package_type", "currency",
			"package_title", "package_description", "price_review_required",
		],
		order_by="creation asc",
	)

	for tp in packages:
		try:
			_migrate_package(tp, categories)
			migrated += 1
		except Exception:
			failed += 1
			frappe.log_error(
				frappe.get_traceback(),
				f"v39: gagal migrasi Trip Package {tp.name}",
			)

	print(f"v39: {migrated} Travel Package dijana, {failed} gagal "
		  f"(daripada {len(packages)} Trip Package)")


def _migrate_package(tp, categories):
	new = frappe.get_doc({
		"doctype": "Travel Package",
		"naming_series": "PKG-.YYYY.-.####",
		"package_name": (tp.package_title or tp.name)[:140],
		"status": STATUS_MAP.get(tp.status, "Draft"),
		"package_template": tp.package_type or "",
		"trip": tp.trip_link,
		"default_currency": tp.currency,
		"price_review_required": 1 if tp.price_review_required else 0,
		"package_description": tp.package_description,
	})

	# ── Komposisi: cruise_tour sentiasa; flight utk FC / FP ──
	new.append("components", {
		"component_type": "cruise_tour",
		"trip": tp.trip_link,
		"selection_mode": "customer_pick",
		"qty": 1,
		"mandatory": 1,
		"sort_order": 1,
	})
	if tp.package_type in ("Cruise + Flight", "Fly Package"):
		new.append("components", {
			"component_type": "flight",
			"selection_mode": "optional",
			"qty": 1,
			"mandatory": 0,
			"sort_order": 2,
		})

	# ── Paxi: cabin (inventory) + age (price, standard) ──
	new.append("variant_axes", {
		"axis_code": "cabin", "axis_name": "Cabin Category",
		"nature": "inventory", "required": 1, "slot": "opt1", "sort_order": 1,
	})
	new.append("variant_axes", {
		"axis_code": "age", "axis_name": "Age Level",
		"nature": "price", "required": 1, "sort_order": 90,
	})

	# ── Harga lama (wide) → kategori diguna + matriks (long) ──
	price_rows = frappe.get_all(
		"Trip Package Price",
		filters={"parent": tp.name},
		fields=["pricing_for_class", "price_adult", "price_children",
				"price_infant", "price_toddler"],
		order_by="idx asc",
	)

	used_cats = []
	for row in price_rows:
		cat = row.pricing_for_class
		if cat and cat not in used_cats:
			used_cats.append(cat)

	for cat_name in used_cats:
		cat = categories.get(cat_name, None)
		code = (getattr(cat, "category_code", None) if cat else None) or cat_name
		label = (getattr(cat, "category_name", None) if cat else None) or cat_name
		new.append("variant_options", {
			"axis_code": "cabin", "option_code": code[:140],
			"option_name": label[:140], "sort_order": len(new.variant_options),
		})

	for code, label in AGE_OPTIONS:
		new.append("variant_options", {
			"axis_code": "age", "option_code": code,
			"option_name": label, "sort_order": len(new.variant_options),
		})

	currency = tp.currency or "MYR"
	for row in price_rows:
		cat = categories.get(row.pricing_for_class)
		cat_code = (getattr(cat, "category_code", None) if cat else None) \
			or row.pricing_for_class or ""
		for fld, age_code in AGE_FIELDS:
			price = row.get(fld)
			if not price:
				continue
			new.append("price_template", {
				"opt1": cat_code, "age_option": age_code,
				"currency": currency, "price": price, "active": 1,
			})

	# price_key dikira oleh TravelPackage.validate
	new.insert(ignore_permissions=True, ignore_links=True)


def verify():
	"""Diff tepat sumber→dest untuk baris matriks harga (bukan auto-run oleh
	migrate — panggil manual: bench execute ...verify)."""
	from collections import defaultdict

	cat_codes = {
		c.name: (c.category_code or c.name)
		for c in frappe.get_all("Trip Price Category", fields=["name", "category_code"])
	}
	title_to_pkg = {}
	for p in frappe.get_all("Travel Package", fields=["name", "package_name"]):
		title_to_pkg.setdefault(p.package_name, p.name)

	src = defaultdict(int)
	unmatched = 0
	for tp in frappe.get_all("Trip Package", fields=["name", "package_title"]):
		new_name = title_to_pkg.get(tp.package_title or tp.name)
		if not new_name:
			unmatched += 1
			continue
		rows = frappe.get_all(
			"Trip Package Price",
			filters={"parent": tp.name},
			fields=["pricing_for_class", "price_adult", "price_children",
					"price_infant", "price_toddler"],
		)
		for r in rows:
			cc = cat_codes.get(r.pricing_for_class, r.pricing_for_class or "")
			for fld, age in AGE_FIELDS:
				if (r.get(fld) or 0) > 0:
					src[(new_name, cc, age)] += 1

	dst = defaultdict(int)
	for t in frappe.get_all("Package Price Template", fields=["parent", "opt1", "age_option"]):
		dst[(t.parent, t.opt1 or "", t.age_option or "")] += 1

	missing = {k: v - dst.get(k, 0) for k, v in src.items() if v > dst.get(k, 0)}
	extra = {k: dst[k] - v for k, v in dst.items() if dst[k] > v}

	print(f"unmatched old packages: {unmatched}")
	print(f"MISSING ({len(missing)} kunci):")
	for k, v in list(missing.items())[:20]:
		print("  -", k, "kurang", v)
	print(f"EXTRA ({len(extra)} kunci):")
	for k, v in list(extra.items())[:20]:
		print("  +", k, "lebih", v)
