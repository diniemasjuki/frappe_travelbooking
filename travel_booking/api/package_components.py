# travel_booking/api/package_components.py
#
# Fasa 2A renovation — PACKAGE COMPOSITION (BOM-style).
#
# Trip Package.components (child: Trip Package Component) kini sumber
# kebenaran komposisi pakej — gabungan alacarte elemen produk:
#   Cruise Segment / Flight / Activity / Transfer / Merchandise / Misc.
# Setiap komponen ada inclusion_mode:
#   - Included                → menjana SO line tambahan semasa checkout
#   - Optional (pre-trip)     → (fasa depan) pilihan pra-trip di wizard
#   - Post-booking Addon      → muncul dalam katalog addon portal
#
# Modul ni membekalkan:
#   get_included_component_lines(trip_package, pax_count, currency)
#     — senarai dict SO-item lines untuk komponen Included (barang
#       fizikal merchandise & activity priced), dipanggil oleh
#       booking_engine.confirm_booking selepas _build_so_items.
#   get_component_summary(trip_package)
#     — ringkasan komposisi untuk paparan (trip detail / desk).
#
# PRINSIP HARGA: komponen Included TIDAK menambah harga tanpa kebenaran
# eksplisit. Hanya komponen dengan harga eksplisit (merchandise item
# price / misc_amount / addon package rate) dijual sebagai baris berbayar;
# komponen dokumentasi (cruise segment, flight) TIDAK menjana baris —
# kos cruise/flight sudah termaktub dalam package_pricing utama.
# Corak ini mengekalkan idiom "SO rate eksplisit dari sumber DB".

import frappe

from travel_booking.api.constants import (
	ADDON_PACKAGE_ITEM_CODE,
	TRAVEL_ITEM_CODE,
)


def get_component_summary(trip_package):
	"""Ringkasan komposisi pakej — [{component_type, label, inclusion_mode,
	qty, per_pax}] untuk paparan desk/trip detail. Kosong untuk pakej tanpa
	komposisi (semua pakej lama)."""
	rows = frappe.db.get_all(
		"Trip Package Component",
		filters={"parent": trip_package, "parenttype": "Trip Package"},
		fields=["component_type", "inclusion_mode", "qty", "per_pax",
		        "cruise_schedule", "flight", "trip_addon_package",
		        "merchandise_item", "misc_description"],
		order_by="idx",
	)
	out = []
	for r in rows:
		out.append({
			"component_type": r.component_type,
			"inclusion_mode": r.inclusion_mode,
			"qty":           r.qty or 1,
			"per_pax":       bool(r.per_pax),
			"label":         _component_label(r),
		})
	return out


def _component_label(r):
	"""Label paparan untuk satu baris komponen.
	NOTE: Cruise/Flight BUKAN komponen pakej (properti TGD — rujuk
	get_derived_components); label di sini untuk komposisi sahaja."""
	if r.component_type in ("Activity", "Excursion", "Transfer") and r.trip_addon_package:
		ap = frappe.db.get_value(
			"Trip Addon Package", r.trip_addon_package,
			["addon_title", "addon_package_name"], as_dict=True)
		if ap:
			return (ap.addon_title or "") + (
				" — " + ap.addon_package_name if ap.addon_package_name else "")
		return r.trip_addon_package
	if r.component_type == "Merchandise" and r.merchandise_item:
		return frappe.db.get_value("Item", r.merchandise_item, "item_name") or r.merchandise_item
	if r.misc_description:
		return r.misc_description
	return r.component_type


def get_included_component_lines(trip_package, pax_count, currency):
	"""Bina SO item lines untuk komponen 'Included' pakej ni.

	Dipanggil oleh confirm_booking selepas baris cabin utama — komponen
	berbayar sahaja menjadi baris SO:

	- Merchandise (per_pax) → qty = qty × pax_count; rate dari Item Price
	  (price list currency) — item stok akan dikendalikan Fasa 3.
	- Merchandise (booking) → qty = qty.
	- Misc dengan misc_amount → baris priced (rate eksplisit).
	- Activity/Transfer priced (trip_addon_package rate currency) → baris.
	- Cruise Segment / Flight → DOKUMENTASI sahaja (harga termaktub dalam
	  package_pricing) — tiada baris.

	Return [] bila tiada apa-apa untuk dijual. Semua rate diselesaikan
	dari DB (server-side), bukan payload.
	"""
	if not trip_package:
		return []
	pax_count = max(int(pax_count or 0), 0)

	rows = frappe.db.get_all(
		"Trip Package Component",
		filters={"parent": trip_package, "parenttype": "Trip Package",
		         "inclusion_mode": "Included"},
		fields=["name", "component_type", "qty", "per_pax",
		        "merchandise_item", "trip_addon_package",
		        "misc_description", "misc_amount", "item_code_override"],
		order_by="idx",
	)

	lines = []
	for r in rows:
		qty = int(r.qty or 1)
		if r.per_pax:
			qty = qty * max(pax_count, 1)

		if r.component_type == "Merchandise" and r.merchandise_item:
			line = _merchandise_line(r, qty, currency)
			if line:
				lines.append(line)
		elif r.component_type == "Miscellaneous" and (r.misc_description or "").strip():
			if float(r.misc_amount or 0) > 0:
				lines.append(_misc_line(r, qty, currency))
		elif r.component_type in ("Activity", "Excursion", "Transfer") and r.trip_addon_package:
			line = _priced_addon_line(r, qty, currency)
			if line:
				lines.append(line)
		# Optional / Post-booking Addon — bukan baris SO di sini.
	return lines


def _merchandise_line(r, qty, currency):
	"""Baris merchandise — item ERPNext sebenar (is_stock_item boleh 0/1).
	Rate dari Item Price price-list currency; kosong → baris RM0 (item
	diberi percuma dalam pakej — masih muncul pada SO supaya delivery
	dan pelanggan nampak)."""
	item_code = r.item_code_override or r.merchandise_item
	if not frappe.db.exists("Item", item_code):
		frappe.throw(
			"Merchandise item '{0}' in package components does not exist.".format(item_code),
			title="Invalid Package Component",
		)
	rate = _item_price(item_code, currency)
	label = frappe.db.get_value("Item", item_code, "item_name") or item_code
	return {
		"item_code":   item_code,
		"item_name":   label,
		"qty":         qty,
		"rate":        float(rate or 0),
		"uom":         "Nos",
		"description": "Package inclusion: " + label,
	}


def _misc_line(r, qty, currency):
	"""Baris Misc priced — item TRAVEL-PKG generik dengan rate eksplisit
	(cori cabin lines; description menjelaskan)."""
	label = (r.misc_description or "Package inclusion").strip()
	return {
		"item_code":   r.item_code_override or TRAVEL_ITEM_CODE,
		"item_name":   label,
		"qty":         qty,
		"rate":        float(r.misc_amount or 0),
		"uom":         "Nos",
		"description": "Package inclusion: " + label,
	}


def _priced_addon_line(r, qty, currency):
	"""Komponen Activity/Transfer yang MERUJUK Trip Addon Package berbayar
	dan di-include dalam pakej — jual sebagai baris 'Trip Addon Package'
	dengan rate currency pakej. Rate mesti wujud (disabled/missing →
	komponen dilangkau senyap dengan log — jangan gagalkan checkout
	kerana konfigurasi addon)."""
	rate = frappe.db.get_value(
		"Trip Addon Package Rate",
		{"parent": r.trip_addon_package, "parenttype": "Trip Addon Package",
		 "currency": currency, "enabled": 1},
		"unit_price",
	)
	if rate is None:
		frappe.log_error(
			title="Package Component - Missing Addon Rate",
			message="Trip Package component {0} references Trip Addon Package "
			"{1} without an enabled rate in {2} — component skipped at "
			"checkout.".format(r.name, r.trip_addon_package, currency),
		)
		return None
	label = frappe.db.get_value(
		"Trip Addon Package", r.trip_addon_package,
		"addon_title") or r.trip_addon_package
	return {
		"item_code":   r.item_code_override or ADDON_PACKAGE_ITEM_CODE,
		"item_name":   label,
		"qty":         qty,
		"rate":        float(rate or 0),
		"uom":         "Nos",
		"description": "Package inclusion: " + label,
	}


def _item_price(item_code, currency):
	"""Item Price untuk item merchandise dalam currency berikan — cari
	price list selling currency tu (Standard Selling fallback). Kosong =
	tiada harga tersedia (baris RM0)."""
	price_list = _price_list_for_currency(currency)
	if not price_list:
		return 0
	rate = frappe.db.get_value(
		"Item Price",
		{"item_code": item_code, "price_list": price_list,
		 "selling": 1},
		"price_list_rate",
	)
	if rate is None and price_list != "Standard Selling":
		rate = frappe.db.get_value(
			"Item Price",
			{"item_code": item_code, "price_list": "Standard Selling",
			 "selling": 1},
			"price_list_rate",
		)
	return float(rate or 0)


def _price_list_for_currency(currency):
	"""Price list selling untuk currency — dari paksi Travel Settings."""
	try:
		from travel_booking.api.currency_axis import currency_to_price_list
		return currency_to_price_list(currency)
	except Exception:
		return "Standard Selling"


# ══════════════════════════════════════════════
# DERIVED COMPONENTS — elemen fizikal dari TGD (patch v43)
# ══════════════════════════════════════════════

def get_derived_components(gd_name):
	"""Elemen fizikal perkhidmatan untuk satu Trip Group Date —
	DERIVE (bukan BOM pakej): cruise schedule + set penerbangan.

	Return [{component_type, label, sub_label}] — shape serasi
	get_component_summary rows supaya UI boleh gabungkan kedua-duanya.
	Kosong bila TGD tiada kedua-duanya.

	Single source untuk derive logic: trip page guna snapshot ter-embed
	dari trip_catalog (query pukal); fungsi ni untuk kegunaan desk /
	masa depan (satu TGD sahaja)."""
	if not gd_name or not frappe.db.exists("Trip Group Date", gd_name):
		return []

	out = []
	tgd = frappe.db.get_value(
		"Trip Group Date", gd_name,
		["cruise_schedule", "cruise_schedule_title",
		 "flight_schedule", "flight_schedule_title"],
		as_dict=True) or frappe._dict()

	if tgd.cruise_schedule:
		out.append({
			"component_type": "Cruise Segment",
			"label": tgd.cruise_schedule_title or tgd.cruise_schedule,
			"sub_label": "",
		})

	if tgd.flight_schedule:
		pnrs = frappe.db.sql("""
			SELECT f.pnr, f.airline, f.home_airport, f.destination_airport,
			       f.departure_date, f.ticket_type, fsf.role
			FROM `tabFlight Schedule Flight` fsf
			JOIN `tabFlight` f ON f.name = fsf.flight
			WHERE fsf.parent = %s AND fsf.parenttype = 'Flight Schedule'
			ORDER BY fsf.idx
		""", tgd.flight_schedule, as_dict=True)
		for p in pnrs:
			route = " → ".join(
				x for x in (p.home_airport, p.destination_airport) if x)
			bits = [b for b in (route, str(p.departure_date or ""),
			                    p.ticket_type or "") if b]
			out.append({
				"component_type": "Flight",
				"label": (p.pnr or "") + (": " + route if route else ""),
				"sub_label": " · ".join(bits[1:]) if len(bits) > 1 else "",
			})

	return out
