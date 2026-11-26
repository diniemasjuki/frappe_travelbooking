# travel_booking/api/traveller_admin.py
# API DIREKTORI TRAVELLER (Travel Manager > Booking Management > Traveller)
# — STAF SAHAJA.
#
# [Nov 2026] Direktori SEMUA profil traveller (doctype Traveller) untuk
# admin: senarai datatable (carian SERVER-SIDE — profil dibina dari
# portal /traveller & booking desk, jumlah auto-bertambah), penapis
# status/kewarganegaraan/kategori umur, agregat booking (bilangan +
# booking terkini melalui Booking Reservation.traveller).
#
# DOKTRIN (selari customer_admin.py):
#   • Bacaan = 4 role desk (TRIP_COMMAND_CENTER_ROLES) — profil traveller
#     membawa PII (emel, telefon, IC, paspport); tiada akses guest.
#   • Agregat SATU panggilan per kumpulan (bukan N+1); cap 1000 + `total`
#     utk amaran pemotongan (corak get_customers_directory /
#     get_dates_directory).
#   • Tiada tulis — direktori bacaan sahaja (mutasi profil kekal melalui
#     portal /traveller & flow booking sedia ada).

import frappe
from frappe.utils import cint

from travel_booking.api.trip_command_center import (
	TRIP_COMMAND_CENTER_ROLES,
	_check_command_center_roles,
)


def _require_traveller_admin():
	_check_command_center_roles(TRIP_COMMAND_CENTER_ROLES, "Traveller Directory")


@frappe.whitelist()
def get_travellers_directory(search: str = "", status: str = "",
							 nationality: str = "", age_category: str = "",
							 limit: int = 1000) -> dict:
	"""Direktori SEMUA profil traveller — halaman Traveller (sub-menu
	Booking Management, Nov 2026): datatable (carian SERVER-SIDE + penapis;
	sort/pagination/column-toggle client-side tmDataTable).

	Carian mencari nama/nama dokumen/IC/pasport/emel/telefon — jumlah
	profil auto-bertambah dari portal, jadi carian mesti di server
	(corak get_customers_directory). Cap 1000 baris + `total` utk amaran
	pemotongan.

	Agregat sekali panggilan per kumpulan (bukan N+1):
	  • bilangan booking + booking terkini (Booking Reservation.traveller —
	    DISTINCT booking; reservation Cancelled turut dikira — profil
	    tetap dipaut, selari semantik direktori customer).
	"""
	_require_traveller_admin()
	limit = max(1, min(cint(limit) or 1000, 1000))

	# Kondisi digabung dengan AND — JANGAN letak kondisi "OR" tanpa
	# kurungan (precedence AND > OR memecahkan penapis carian).
	conds = []
	params = {"limit": limit}
	if search:
		params["search"] = "%{}%".format((search or "").strip())
		conds.append("""(
			t.name LIKE %(search)s
			OR t.full_name LIKE %(search)s
			OR t.first_name LIKE %(search)s
			OR t.last_name LIKE %(search)s
			OR t.ic_number LIKE %(search)s
			OR t.passport_no LIKE %(search)s
			OR t.email LIKE %(search)s
			OR t.phone LIKE %(search)s
		)""")
	if status:
		params["status"] = status
		conds.append("t.status = %(status)s")
	if nationality:
		params["nationality"] = nationality
		conds.append("t.nationality = %(nationality)s")
	if age_category:
		params["age_category"] = age_category
		conds.append("t.age_category = %(age_category)s")
	where = " AND ".join(conds) or "1=1"

	travellers = frappe.db.sql(f"""
		SELECT t.name, t.full_name, t.first_name, t.last_name,
		       t.ic_number, t.passport_no, t.passport_expiry,
		       t.nationality, t.gender, t.date_of_birth, t.age,
		       t.age_category, t.email, t.phone, t.status, t.creation,
		       t.emergency_contact_name, t.emergency_contact_phone,
		       t.emergency_contact_relationship,
		       t.address_line1, t.city, t.postcode, t.state, t.country
		FROM `tabTraveller` t
		WHERE {where}
		ORDER BY t.creation DESC
		LIMIT %(limit)s
	""", params, as_dict=True)

	names = [t.name for t in travellers] or ["__none__"]
	total = frappe.db.sql(f"""
		SELECT COUNT(*) FROM `tabTraveller` t WHERE {where}
	""", params)[0][0]

	# Bilangan booking + booking terkini per traveller.
	bk_agg = {}
	for r in frappe.db.sql("""
		SELECT br.traveller AS traveller,
		       COUNT(DISTINCT br.booking) AS bookings,
		       MAX(b.creation) AS last_booking
		FROM `tabBooking Reservation` br
		INNER JOIN `tabBooking` b ON b.name = br.booking
		WHERE br.traveller IN %(names)s
		GROUP BY br.traveller
	""", {"names": names}, as_dict=True):
		bk_agg[r.traveller] = r

	for t in travellers:
		b = bk_agg.get(t.name)
		t["bookings"] = cint(b.bookings) if b else 0
		t["last_booking"] = str(b.last_booking) if b and b.last_booking else None

	return {"travellers": travellers, "total": cint(total)}
