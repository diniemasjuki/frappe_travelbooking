"""Pulih data postcode yang tercemar URL fail passport.

Insiden (Okt 2026): URL fail passport (cth. /private/files/passport-....jpg)
tertulis ke dalam medan postcode — 3 kolum terkesan:

1. Traveller.postcode                     — ditulis semula borang guest
                                            (prefill URL → save → Traveller
                                            .postcode = URL; jejak Version
                                            owner "Guest").
2. Booking Reservation.traveller_postcode — snapshot fetch_from Traveller
                                            (menular dari #1).
3. Booking Reservation.guest_postcode     — kolum SNAPSHOT LEGACY guest_*
                                            (dibuang dari doctype pada patch
                                            era Okt 2027-10-27; kolum fizikal
                                            kekal & MASIH dibaca sebagai
                                            fallback prefill oleh
                                            verify_guest_token). 89 slot
                                            tercemar oleh batch tulis lama.

Pemulihan (keutamaan sumber sama seperti paparan portal traveller):

- Traveller.postcode URL            → dikosongkan (nilai sebenar tidak
                                      diketahui; borang wajib isi postcode
                                      semasa save seterusnya).
- traveller_postcode URL            → salin semula daripada Traveller.postcode
                                      (jika bersih), kalau tidak kosongkan.
- guest_postcode URL                → salin Traveller.postcode (jika bersih),
                                      kalau tidak kosongkan.

Semak & pulih hanya nilai yang MENYERUPAI URL fail (/files/... atau
/private/files/...) — postcode biasa tidak pernah bermula begitu. Idempoten:
nilai yang sudah bersih tidak disentuh. Kolum guest_* mungkin tiada pada
pemasangan baharu (dibuang dari meta) — dilindungi semakan kolum.
"""

import frappe

_URL_LIKE = ("/files/", "/private/files/")


def _is_url_like(value) -> bool:
	v = (value or "").strip()
	return v.startswith(_URL_LIKE)


def _column_exists(table: str, column: str) -> bool:
	return bool(frappe.db.sql(
		"""SELECT COUNT(*) FROM information_schema.COLUMNS
		   WHERE TABLE_SCHEMA = DATABASE()
		     AND TABLE_NAME = %s AND COLUMN_NAME = %s""",
		(table, column))[0][0])


def execute():
	# 1. Traveller.postcode — kosongkan nilai URL (sumber tidak diketahui).
	tvl_fixed = frappe.db.sql(
		"""UPDATE `tabTraveller`
		   SET postcode = ''
		   WHERE postcode LIKE '/files/%%' OR postcode LIKE '/private/files/%%'""")
	frappe.db.commit()

	# 2 & 3. Booking Reservation — snapshot traveller_postcode (meta) dan
	# kolum legacy guest_postcode: pulih daripada Traveller.postcode bersih.
	repair_counts = {}
	for column in ("traveller_postcode", "guest_postcode"):
		if not _column_exists("tabBooking Reservation", column):
			continue
		rows = frappe.db.sql(
			f"""SELECT res.name, res.traveller, t.postcode AS tvl_postcode
			    FROM `tabBooking Reservation` res
			    LEFT JOIN `tabTraveller` t ON t.name = res.traveller
			    WHERE res.`{column}` LIKE '/files/%%'
			       OR res.`{column}` LIKE '/private/files/%%'""",
			as_dict=True)
		fixed = 0
		for r in rows:
			clean = (r.tvl_postcode or "").strip()
			if _is_url_like(clean):
				clean = ""
			frappe.db.sql(
				f"""UPDATE `tabBooking Reservation`
				   SET `{column}` = %(v)s WHERE name = %(n)s""",
				{"v": clean, "n": r.name})
			fixed += 1
		if fixed:
			frappe.db.commit()
		repair_counts[column] = fixed

	frappe.logger("patches").info({
		"patch": "v38_repair_postcode_url_data",
		"traveller_postcode_cleared": tvl_fixed,
		**repair_counts,
	})
