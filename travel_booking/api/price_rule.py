# travel_booking/api/price_rule.py
#
# Enjin Travel Price Rule — promosi "price slash" untuk paparan website,
# booking wizard dan penciptaan booking (SO net rate).
#
# Konsep:
#   - Rule disimpan dalam doctype Travel Price Rule (scope: trip, group
#     date, package, room category, guest type; diskaun: Percentage atau
#     Fixed Amount per currency; validity: tetingkap tarikh BOOKING +
#     optional min hari sebelum departure).
#   - Diskaun dikira SEUNIT (per pax guest type) supaya konsisten dengan
#     paparan per-pax dan baris Sales Order per-pax.
#   - BEST-ONLY: bila lebih dari satu rule match pada harga seunit yang
#     sama, hanya rule dengan potongan TERBESAR menang (tie-break ikut
#     priority DESC). Tiada stacking.
#   - Fixed Amount hanya berkesan pada package yang currency-nya ada row
#     dalam rule (guard sama macam Voucher Fixed Amount).
#
# Modul ni STANDALONE (hanya import frappe) dan read-only terhadap data
# supaya selamat dari circular import — caller (pricing.py, voucher.py,
# booking_engine.py, trip_catalog.py) yang menyediakan pricing_map.

import frappe
from frappe.utils import date_diff, flt, getdate

# Kunci harga (guest type) yang wujud pada Trip Package Price.
PRICE_KEYS = (
	"price_adult_single",
	"price_adult",
	"price_upperberth",
	"price_children",
	"price_toddler",
	"price_infant",
)


# ══════════════════════════════════════════════
# MUAT RULE
# ══════════════════════════════════════════════

def get_active_price_rules():
	"""Senarai rule aktif hari ini (is_active + within validity), sebagai
	bundle dict dengan scope & amounts siap di-parse. Cache per-request
	(frappe.local) — get_booking_details + confirm_booking + katalog dalam
	request yang sama tak ulang query."""
	cached = getattr(frappe.local, "_travel_price_rules", None)
	if cached is not None:
		return cached

	names = frappe.get_all(
		"Travel Price Rule",
		filters={
			"is_active": 1,
			"valid_from": ("<=", getdate()),
			"valid_until": (">=", getdate()),
		},
		pluck="name",
		order_by="priority DESC, creation ASC",
	)
	if not names:
		frappe.local._travel_price_rules = []
		return []

	rules = {
		r.name: r
		for r in frappe.get_all(
			"Travel Price Rule",
			filters={"name": ["in", names]},
			fields=[
				"name", "rule_name", "promo_label", "discount_type",
				"discount_percent", "priority", "min_days_before_departure",
			],
		)
	}

	def _scope(doctype, field):
		out = {}
		for r in frappe.get_all(
			doctype, filters={"parent": ["in", names]},
			fields=["parent", field],
		):
			out.setdefault(r.parent, set()).add(r[field])
		return out

	trips = _scope("Travel Price Rule Trip", "trip")
	gds = _scope("Travel Price Rule Group Date", "trip_group_date")
	pkgs = _scope("Travel Price Rule Package", "trip_package")
	rooms = _scope("Travel Price Rule Room Category", "room_category")
	guest_types = _scope("Travel Price Rule Guest Type", "price_key")

	amounts = {}
	for r in frappe.get_all(
		"Travel Price Rule Amount",
		filters={"parent": ["in", names]},
		fields=["parent", "currency", "amount"],
	):
		amounts.setdefault(r.parent, {})[r.currency] = flt(r.amount)

	bundles = []
	for name in names:  # kekal susunan priority DESC, creation ASC
		r = rules.get(name)
		if not r:
			continue
		bundles.append({
			"name": r.name,
			"label": r.promo_label or r.rule_name or r.name,
			"discount_type": r.discount_type,
			"discount_percent": flt(r.discount_percent),
			"amounts": amounts.get(r.name, {}),
			"trips": trips.get(r.name, set()),
			"group_dates": gds.get(r.name, set()),
			"packages": pkgs.get(r.name, set()),
			"room_categories": rooms.get(r.name, set()),
			"guest_types": guest_types.get(r.name, set()),
			"priority": flt(r.priority),
			"min_days": int(r.min_days_before_departure or 0),
		})

	frappe.local._travel_price_rules = bundles
	return bundles


def resolve_ctx(trip_package, trip_group_date=None):
	"""Bina context rule daripada package + group date:
	    {trip, trip_group_date, trip_package, currency, departure_date}
	2-3 query kecil — caller biasanya dah ada sebahagian data ni, tapi
	helper ni jaga supaya semua caller konsisten."""
	ctx = {"trip_package": trip_package, "trip_group_date": trip_group_date}
	if trip_package:
		tp = frappe.db.get_value(
			"Trip Package", trip_package, ["trip_link", "currency"], as_dict=True
		)
		if tp:
			ctx["trip"] = tp.trip_link
			ctx["currency"] = tp.currency
	if trip_group_date:
		td = frappe.db.get_value(
			"Trip Group Date", trip_group_date,
			["trip", "departure_date"], as_dict=True,
		)
		if td:
			ctx.setdefault("trip", td.trip)
			ctx["departure_date"] = td.departure_date
	return ctx


# ══════════════════════════════════════════════
# MATCHING + KIRAAN
# ══════════════════════════════════════════════

def rule_matches(bundle, ctx, room_category=None, price_key=None):
	"""Rule match jika SETIAP scope yang diisi memenuhi context (scope
	kosong = semua). room_category/price_key hanya disemak bila rule
	mengskopkannya."""
	if not _scope_ok(bundle["trips"], ctx.get("trip")):
		return False
	if not _scope_ok(bundle["group_dates"], ctx.get("trip_group_date")):
		return False
	if not _scope_ok(bundle["packages"], ctx.get("trip_package")):
		return False
	if room_category is not None and not _scope_ok(
		bundle["room_categories"], room_category
	):
		return False
	if price_key is not None and bundle["guest_types"] and price_key not in bundle["guest_types"]:
		return False

	# Early-bird: min hari sebelum departure date group date.
	if bundle["min_days"] > 0:
		dep = ctx.get("departure_date")
		if not dep:
			return False
		if date_diff(dep, getdate()) < bundle["min_days"]:
			return False
	return True


def _scope_ok(values, target):
	return not values or (target in values)


def _unit_discount(bundle, base, currency):
	"""Potongan SEUNIT atas harga asal. None = rule tak boleh apply
	(harga kosong, atau Fixed Amount tanpa row currency ni)."""
	if base <= 0:
		return None
	if bundle["discount_type"] == "Percentage":
		return round(base * bundle["discount_percent"] / 100.0, 2)
	amt = bundle["amounts"].get(currency)
	if amt is None:
		return None
	return round(min(amt, base), 2)


def apply_price_rules(pricing_map, ctx):
	"""Apply rule atas pricing map ({room_category: row harga}).

	    KEMBALI (discounted_map, applied_info):
	    - discounted_map: salinan row dengan harga seunit dah dipotong
	      (best-only per room_category x price_key). Struktur attr sama
	      (price_adult dsb.) — sesuai terus untuk _price_selection /
	      _build_so_items tanpa perubahan.
	    - applied_info: {room_category: {price_key: {rule, label,
	      discount_type, value, original, discounted, saved}}}
	      — kosong {} bila tiada rule berkesan.
	"""
	rules = get_active_price_rules()
	if not rules:
		return pricing_map, {}

	currency = ctx.get("currency") or "MYR"
	discounted_map = {}
	applied_info = {}

	for room_category, price in (pricing_map or {}).items():
		row = frappe._dict(price)  # salinan — jangan mutasi row caller
		info = {}
		for key in PRICE_KEYS:
			base = round(flt(price.get(key) if hasattr(price, "get") else getattr(price, key, 0)), 2)
			if base <= 0:
				continue
			best = None
			for bundle in rules:  # priority DESC, creation ASC
				if not rule_matches(bundle, ctx, room_category, key):
					continue
				disc = _unit_discount(bundle, base, currency)
				if disc is None:
					continue
				if best is None or disc > best["saved"] + 1e-9:
					best = {
						"rule": bundle["name"],
						"label": bundle["label"],
						"discount_type": bundle["discount_type"],
						"value": (
							bundle["discount_percent"]
							if bundle["discount_type"] == "Percentage"
							else bundle["amounts"].get(currency)
						),
						"original": base,
						"discounted": round(base - disc, 2),
						"saved": disc,
					}
			if best:
				row[key] = best["discounted"]
				info[key] = best
		discounted_map[room_category] = row
		if info:
			applied_info[room_category] = info

	return discounted_map, applied_info


# ══════════════════════════════════════════════
# HELPER PAPARAN / SNAPSHOT
# ══════════════════════════════════════════════

def effective_unit_price(base, ctx, room_category, price_key):
	"""Harga seunit BERKESAN (promo) untuk satu room_category + price_key —
	best-only, selari apply_price_rules(). Untuk kiraan harga "from" di
	katalog/page detail yang tak bina pricing map penuh.

	    KEMBALI (discounted, label) — label None bila tiada rule berkesan.
	"""
	base = round(flt(base), 2)
	if base <= 0:
		return base, None
	best = None
	for bundle in get_active_price_rules():  # priority DESC, creation ASC
		if not rule_matches(bundle, ctx, room_category, price_key):
			continue
		disc = _unit_discount(bundle, base, ctx.get("currency") or "MYR")
		if disc is None:
			continue
		if best is None or disc > best[2] + 1e-9:
			best = (round(base - disc, 2), bundle["label"], disc)
	if best is None:
		return base, None
	return best[0], best[1]


def dominant_rule_info(room_info):
	"""Info rule 'dominan' satu kabin untuk paparan badge/slash —
	utamakan price_adult (paling visible), jika tiada ambil sebarang."""
	if not room_info:
		return None
	win = room_info.get("price_adult")
	if not win:
		for key in ("price_adult_single", "price_upperberth",
		            "price_children", "price_infant", "price_toddler"):
			if room_info.get(key):
				win = room_info[key]
				break
	if not win:
		win = next(iter(room_info.values()))
	return {
		"rule": win["rule"],
		"label": win["label"],
		"discount_type": win["discount_type"],
		"value": win["value"],
	}


def rule_snapshot(applied_info, currency=None):
	"""Snapshot JSON-able rule yang menang untuk disimpan pada Booking
	(applied_price_rules). Dedupe ikut rule — satu entri sekaligus
	senarai price_key yang dimenanginya."""
	if not applied_info:
		return None
	by_rule = {}
	for room_category, keys in applied_info.items():
		for price_key, win in keys.items():
			e = by_rule.setdefault(win["rule"], {
				"rule": win["rule"],
				"label": win["label"],
				"discount_type": win["discount_type"],
				"value": win["value"],
				"applied_to": [],
			})
			e["applied_to"].append(room_category + ":" + price_key)
	out = {
		"currency": currency,
		"rules": sorted(by_rule.values(), key=lambda r: r["rule"]),
	}
	return out
