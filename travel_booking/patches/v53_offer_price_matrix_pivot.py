"""Patch v53: Pivot Offer Price (matriks generik legacy) → Package
Offer.price_matrix (child Trip Package Price — sumber harga UTAMA offer,
Stage pricing Nov 2026).

Pemetaan age_option → lajur slot:
  ADULT   → price_adult + price_adult_single (model lama tiada single
            supplement berasingan — single = harga dewasa, selari dengan
            fallback _get_offer_pricing_map)
  CHILD   → price_children
  INFANT  → price_infant
  TODDLER → price_toddler
  price_upperberth → tiada padanan pada model lama (dibiarkan kosong —
  boleh diisi semula melalui import lajur penuh daripada cabin_rates).

IDEMPOTEN: hanya offer yang Price Matrix-nya KOSONG diproses. Offer
yang sudah ada baris matrix (edit manual/import selepas cutover) tidak
disentuh.
"""
import frappe

_AGE_COL = {
	"ADULT": ("price_adult", "price_adult_single"),
	"CHILD": ("price_children",),
	"INFANT": ("price_infant",),
	"TODDLER": ("price_toddler",),
}


def execute():
	offers = frappe.get_all(
		"Package Offer",
		filters={"name": ["in", frappe.get_all(
			"Offer Price", filters={"active": 1},
			pluck="parent", distinct=True)]},
		pluck="name",
	)
	# Kod kanonik v47 → docname Trip Price Category (pricing_for_class
	# ialah field Link — kod mentah yang tak resolve akan gagal
	# LinkValidationError semasa save).
	cat_by_code, cat_by_name = {}, {}
	for c in frappe.get_all("Trip Price Category",
			fields=["name", "category_code"]):
		if c.category_code:
			cat_by_code[c.category_code] = c.name
		cat_by_name[c.name] = c.name

	pivoted = 0
	for offer in offers:
		rows = frappe.get_all(
			"Trip Package Price",
			filters={"parent": offer, "parenttype": "Package Offer"},
			pluck="name",
		)
		if rows:
			continue  # matrix sudah wujud — jangan sentuh
		doc = frappe.get_doc("Package Offer", offer)
		cols = {}
		for p in frappe.get_all(
				"Offer Price", filters={"parent": offer, "active": 1},
				fields=["opt1", "age_option", "price"], order_by="age_option"):
			code = p.opt1 or (p.price_key or "").split("|")[0]
			if not code:
				continue
			row = cols.setdefault(code, {})
			for col in _AGE_COL.get(p.age_option or "ADULT", ()):
				if row.get(col) is None:
					row[col] = float(p.price or 0)
		if not cols:
			continue
		skipped = []
		for code, vals in cols.items():
			cat = cat_by_code.get(code) or cat_by_name.get(code)
			if not cat:
				skipped.append(code)
				continue
			doc.append("price_matrix", {"pricing_for_class": cat, **vals})
		if skipped:
			frappe.log_error(
				"Kod kategori tidak resolve (lengkap): "
				+ ", ".join(skipped),
				f"v53 pivot: {offer} — baris dilangkau",
			)
		try:
			doc.save(ignore_permissions=True)
			pivoted += 1
		except Exception:
			frappe.log_error(
				frappe.get_traceback(),
				f"v53 pivot gagal untuk {offer}",
			)
	frappe.db.commit()
	print(f"v53: {pivoted}/{len(offers)} offer dipivot ke Price Matrix")
