# Copyright (c) 2026, WargaPrihatin and Contributors
# See license.txt

"""Resolver itinerary efektif — hierarki warisan:

    Trip (template asal)
      ← Travel Date  (overwrite_itinerary + table sendiri)
      ← Package Offer (overwrite_itinerary + table sendiri)

Model "reuse + checkbox overwrite": Travel Date / Package Offer memegang
child table `Trip Itinerary` sendiri (parenttype mengasingkan baris
daripada baris Trip — semua SQL sedia ada menapis parenttype='Trip').
Baris sendiri HANYA diguna bila `overwrite_itinerary` ditanda DAN table
berisi; sebaliknya waris aras atas. Checkbox ditanda tetapi table kosong
→ fallback senyap ke warisan (UI Travel Manager memaparkan hint).

Offer mewarisi TD *efektif* (bukan terus Trip): jika TD overwrite,
salinan induk offer ialah hasil TD itu.

SEMUA bacaan itinerary berbeza-tarikh/pakej wajib lalui modul ini
satu pintu — jangan query `tabTrip Itinerary` parenttype Travel Date /
Package Offer di tempat lain.
"""

import frappe
from frappe.utils import cint

# Kolum child yang dibenarkan keluar-masuk (save admin + bacaan).
# [Nov 2026] segment dibuang daripada doctype Trip Itinerary — itinerary
# dirender flat (tiada header Pre/Cruise/Post-Cruise lagi).
ITINERARY_CHILD_FIELDS = (
	"day", "day_title", "destination_point",
	"meals", "day_image", "description",
)

ITINERARY_PARENTTYPES = ("Travel Date", "Package Offer")


def normalize_itinerary_row(r) -> dict:
	"""Dict seragam untuk semua aras."""
	return {
		"day": r.get("day") or 0,
		"day_title": r.get("day_title") or "",
		"destination_point": r.get("destination_point") or "",
		"meals": r.get("meals") or "",
		"day_image": r.get("day_image") or "",
		"description": r.get("description") or "",
	}


def get_own_itinerary(parenttype: str, name: str) -> list[dict]:
	"""Baris itinerary MILIK dokumen itu sahaja (tanpa warisan) — baca
	murah terus dari child table ikut `idx` (susunan editor), tanpa load
	doc penuh. Parenttype menerima 'Trip' / 'Travel Date' / 'Package
	Offer'."""
	if not name:
		return []
	rows = frappe.get_all(
		"Trip Itinerary",
		filters={"parent": name, "parenttype": parenttype},
		fields=list(ITINERARY_CHILD_FIELDS),
		order_by="idx asc",
	)
	return [normalize_itinerary_row(r) for r in rows]


def _uses_own_itinerary(parenttype: str, name: str, own_rows: list) -> bool:
	"""Kedua-dua syarat overwrite: flag ditanda DAN table berisi.
	(flag tanpa baris → waris; baris tanpa flag → disimpan sebagai draf,
	tetap waris.)"""
	if not name or not own_rows:
		return False
	return bool(cint(frappe.db.get_value(parenttype, name, "overwrite_itinerary")))


def get_effective_itinerary(trip: str, travel_date: str | None = None,
							offer: str | None = None) -> dict:
	"""Itinerary efektif ikut rantaian Trip ← Travel Date ← Package Offer.

	Pulangkan ``{"rows": [...], "source": "trip"|"travel_date"|
	"package_offer"}`` — rows disusun ikut `day` (pariti render website,
	trip.py:167)."""
	# Aras 3: Package Offer
	if offer:
		own = get_own_itinerary("Package Offer", offer)
		if _uses_own_itinerary("Package Offer", offer, own):
			return {"rows": _sort_by_day(own), "source": "package_offer"}
	# Aras 2: Travel Date
	if travel_date:
		own = get_own_itinerary("Travel Date", travel_date)
		if _uses_own_itinerary("Travel Date", travel_date, own):
			return {"rows": _sort_by_day(own), "source": "travel_date"}
	# Aras 1: Trip — template asal (sentiasa ada fallback, walau kosong).
	return {"rows": _sort_by_day(get_own_itinerary("Trip", trip)), "source": "trip"}


def _sort_by_day(rows: list[dict]) -> list[dict]:
	return sorted(rows, key=lambda r: r.get("day") or 0)


def enrich_itinerary_rows(rows: list[dict], anchor_date=None) -> list[dict]:
	"""Resolve `destination_point` (Link) → destination_name + country
	dalam SATU query — corak sama Trip.get_context (trip.py:141-169).
	Mutate + pulangkan rows (kunci `destination_name`/`country` ditambah).

	anchor_date (opsyenal, Nov 2026): tarikh berlepas Day 1 — bila
	dibekal (render portal trip page), setiap baris diberi `day_date`
	= tarikh kalendar Day N (anchor + N−1 hari) diformat ikut
	Travel Website. Tanpa anchor (editor admin), `day_date` tidak
	ditambah."""
	dp_names = list({r["destination_point"] for r in rows if r.get("destination_point")})
	dp_map: dict = {}
	if dp_names:
		for dp in frappe.db.get_values(
			"Trip Destination Point", dp_names,
			["name", "destination_name", "destination_country"],
			as_dict=True,
		):
			dp_map[dp.name] = dp
	for r in rows:
		dp = dp_map.get(r.get("destination_point")) or {}
		r["destination_name"] = dp.get("destination_name") or r.get("destination_point") or ""
		r["country"] = dp.get("destination_country") or ""
	if anchor_date:
		from datetime import timedelta

		from frappe.utils import getdate

		from travel_booking.utils.website_config import web_date

		base = getdate(anchor_date)
		for r in rows:
			r["day_date"] = web_date(base + timedelta(days=cint(r.get("day") or 1) - 1))
	return rows


def get_itinerary_payload(trip: str, travel_date: str | None = None,
						  offer: str | None = None) -> dict:
	"""Payload lengkap untuk editor admin (Travel Manager): baris sendiri,
	flag overwrite, hasil efektif (enriched) + sumber untuk badge, dan
	rantaian INDUK (TANPA aras semasa) — sumber butang Salin / Add-from.

	Parent chain (Nov 2026 — arahan pemilik, factorized):
	  Travel Date   → induk = Trip
	  Package Offer → induk = Travel Date EFETIF (TD overwrite → baris TD;
	                  tiada → Trip) — resolver menyelesaikannya sendiri.
	Guna `offer` bila editor dibuka pada aras offer (parenttype
	'Package Offer'); jika tidak, `travel_date` ('Travel Date')."""
	own: list = []
	flag = 0
	if offer:
		own = get_own_itinerary("Package Offer", offer)
		flag = cint(frappe.db.get_value("Package Offer", offer, "overwrite_itinerary"))
	elif travel_date:
		own = get_own_itinerary("Travel Date", travel_date)
		flag = cint(frappe.db.get_value("Travel Date", travel_date, "overwrite_itinerary"))
	eff = get_effective_itinerary(trip, travel_date=travel_date, offer=offer)
	# Induk = hasil efektif rantaian TANPA aras semasa.
	if offer:
		par = get_effective_itinerary(trip, travel_date=travel_date)
	elif travel_date:
		par = get_effective_itinerary(trip)
	else:
		par = {"rows": [], "source": "trip"}
	return {
		"own_itinerary": own,
		"overwrite_itinerary": flag,
		"effective_itinerary": enrich_itinerary_rows(eff["rows"]),
		"itinerary_source": eff["source"],
		"parent_itinerary": enrich_itinerary_rows(par["rows"]),
		"parent_source": par["source"],
	}


def has_active_itinerary_override(trip: str) -> bool:
	"""Adakah mana-mana Travel Date / Package Offer trip ini mengatasi
	itinerary (flag + baris)? Dipakai page detail untuk render seksyen
	itinerary walaupun template Trip kosong — swap client-side akan
	mengisinya bila tarikh dipilih."""
	return bool(frappe.db.sql(
		"""
		SELECT 1
		FROM `tabTrip Itinerary` it
		JOIN `tabTravel Date` td
		  ON it.parenttype = 'Travel Date' AND it.parent = td.name
		WHERE td.trip = %s AND td.overwrite_itinerary = 1
		LIMIT 1
		""", (trip,),
	)) or bool(frappe.db.sql(
		"""
		SELECT 1
		FROM `tabTrip Itinerary` it
		JOIN `tabPackage Offer` o
		  ON it.parenttype = 'Package Offer' AND it.parent = o.name
		JOIN `tabTravel Date` td ON td.name = o.travel_date
		WHERE td.trip = %s AND o.overwrite_itinerary = 1
		LIMIT 1
		""", (trip,),
	))
