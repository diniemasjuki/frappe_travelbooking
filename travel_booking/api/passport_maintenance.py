# travel_booking/api/passport_maintenance.py
#
# Penyelenggaraan fail imej passport (PII) Traveller:
#
#   cleanup_expired_passport_images()  — DAILY HOOK (hooks.py scheduler
#     'daily'). Passport yang tamat tempoh <6 bulan dari hari ini (atau
#     sudah tamat) tidak lagi sah untuk kebanyakan perjalanan (peraturan
#     6-bulan) → imej/attachment passport dipadam dan status Traveller
#     ditukar ke 'Open for Update' supaya customer hantar semula.
#
#   make_passport_files_private()  — DOCUMENT CHECK / pemulihan: cari
#     semua fail imej passport yang masih PUBLIC (URL /files/...) dan
#     tukarkannya kepada private (pindah fizikal ke private/files +
#     kemaskini URL pada SEMUA field yang merujuk). Boleh dipanggil
#     semula bila-bila masa — idempotent; hanya fail public diproses.
#
#     Cara panggil:
#       bench --site <site> execute travel_booking.api.passport_maintenance.make_passport_files_private
#     atau dari Desk (perlu System Manager):
#       /api/method/travel_booking.api.passport_maintenance.make_passport_files_private

import frappe
from frappe.utils import add_months, nowdate

# Medan (doctype, fieldname) yang boleh merujuk URL fail imej passport —
# peta lengkap untuk penukaran URL bila fail dijadikan private/dipadam.
_PASSPORT_URL_FIELDS = (
	("Traveller", "passport_image"),
	("Traveller", "visa_photo"),
	("Booking Reservation", "traveller_passportimg"),
)


def _url_still_referenced(url: str) -> bool:
	"""True jika URL fail masih dirujuk mana-mana medan attach."""
	for doctype, fieldname in _PASSPORT_URL_FIELDS:
		if frappe.db.count(doctype, {fieldname: url}):
			return True
	return False


def _ensure_private_url(url: str) -> str:
	"""Pastikan fail pada URL ini PRIVATE; pulangkan URL muktamad.

	Fail yang sudah private (/private/files/...) dikembalikan tanpa
	perubahan. Fail public diflip melalui File.save(is_private=1) —
	Frappe pindahkan fizikal ke private/files, tulis semula file_url dan
	kemaskini medan attach target; rujukan lain (Traveller + snapshot
	reservation) dialih melalui SQL. Idempotent."""
	if not url or url.startswith("/private/files/"):
		return url
	primary, new_url = None, url
	for fd in frappe.get_all("File",
			filters={"file_url": url, "is_private": 0}, pluck="name"):
		if primary is None:
			doc = frappe.get_doc("File", fd)
			doc.is_private = 1
			doc.save(ignore_permissions=True)
			primary = fd
			new_url = doc.file_url
		else:
			# Duplikat URL lama — fizikal sudah berpindah; alih terus.
			frappe.db.set_value("File", fd,
				{"is_private": 1, "file_url": new_url}, update_modified=False)
	if primary:
		for doctype, fieldname in _PASSPORT_URL_FIELDS:
			frappe.db.sql(
				f"""UPDATE `tab{doctype}`
				   SET `{fieldname}` = %(new)s WHERE `{fieldname}` = %(old)s""",
				{"new": new_url, "old": url})
	return new_url


# ══════════════════════════════════════════════
# DAILY: padam imej passport hampir/sudah tamat tempoh
# ══════════════════════════════════════════════

def cleanup_expired_passport_images() -> dict:
	"""Auto-delete gambar/attachment passport yang hampir tamat tempoh.

	Syarat: tarikh hari ini KURANG daripada 6 bulan dari tarikh tamat
	passport (passport_expiry <= hari ini + 6 bulan — termasuk yang sudah
	tamat). Tindakan per traveller:
	  1. Kosongkan snapshot traveller_passportimg pada Booking Reservation.
	  2. Kosongkan Traveller.passport_image.
	  3. Padam dokumen File (fizikal dipadam Frappe bila tiada duplikat).
	  4. Set status Traveller = 'Open for Update'.
	  5. Sebar 'Open for Update' ke document_status SEMUA Booking
	     Reservation traveller ini (buka semula slot portal/guest link).
	Idempotent — traveller tanpa imej hanya dapat status 'Open for Update'."""
	threshold = add_months(nowdate(), 6)
	# Tarikh kosong/legacy '0000-00-00' diketepikan (jangan padam imej
	# rekod yang tarikh expirynya tidak sah).
	rows = frappe.get_all("Traveller",
		filters=[["passport_expiry", ">", "0001-01-01"],
			["passport_expiry", "<=", threshold]],
		fields=["name", "passport_expiry"])

	done, skipped = [], []
	for r in rows:
		name = r.name
		try:
			image = frappe.db.get_value("Traveller", name, "passport_image") or ""
			deleted_files = 0
			if image:
				# Kosongkan rujukan DULU (guard File.on_trash menolak padam
				# bila dokumen attach masih membawa URL itu).
				frappe.db.sql(
					"""UPDATE `tabBooking Reservation`
					   SET traveller_passportimg = ''
					   WHERE traveller = %(t)s AND traveller_passportimg = %(url)s""",
					{"t": name, "url": image})
				frappe.db.set_value("Traveller", name, "passport_image", "")
				# URL dikongsi rekod lain → jangan padam fail (link mati).
				if not _url_still_referenced(image):
					for fname in frappe.get_all("File",
							filters={"file_url": image}, pluck="name"):
						frappe.delete_doc("File", fname, ignore_permissions=True)
						deleted_files += 1
				else:
					skipped.append({"traveller": name, "reason": "file shared", "url": image})
			frappe.db.set_value("Traveller", name, "status", "Open for Update")
			# Sebar status ke SEMUA Booking Reservation traveller ini.
			# db.set_value TIDAK memicu Traveller.on_update (sync_status_
			# to_reservations) — tanpa sebaran ini mirror document_status
			# kekal "Verified" (locked) pada portal/guest link, jadi customer
			# TIDAK dapat hantar passport baharu walaupun hook sudah minta.
			# Status aliran reservation turut dikira semula (Open for
			# Update bukan status "dokumen siap" → slot masuk Waiting
			# Document, atau Document Expired bila departure dah dekat).
			from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
				recompute_reservation_status,
			)
			for res_name in frappe.get_all("Booking Reservation",
					filters={"traveller": name}, pluck="name"):
				frappe.db.set_value("Booking Reservation", res_name,
					"document_status", "Open for Update", update_modified=False)
				recompute_reservation_status(res_name)
			frappe.db.commit()
			done.append({"traveller": name, "expiry": str(r.passport_expiry),
				"files_deleted": deleted_files})
		except Exception:
			frappe.db.rollback()
			skipped.append({"traveller": name, "reason": "error"})
			frappe.log_error(title="cleanup_expired_passport_images failed",
				message=f"Traveller {name}")

	frappe.logger("passport_maintenance").info(
		{"event": "cleanup_expired_passport_images", "threshold": str(threshold),
		 "processed": len(done), "skipped": len(skipped)})
	return {"threshold": str(threshold), "processed": done, "skipped": skipped}


# ══════════════════════════════════════════════
# DOCUMENT CHECK: pastikan semua fail passport PRIVATE
# ══════════════════════════════════════════════

@frappe.whitelist()
def make_passport_files_private() -> dict:
	"""Tukar semua fail imej passport yang masih public kepada private.

	Sumber senarai: medan attach passport (Traveller.passport_image /
	visa_photo / Booking Reservation.traveller_passportimg) yang bermula
	'/files/' (public). Setiap URL:
	  1. File.save(is_private=1) — Frappe pindahkan fail fizikal ke
	     private/files & tulis semula file_url (kemaskini medan attach
	     target sekali).
	  2. Kemaskini URL pada semua medan lain yang merujuk URL lama
	     (Traveller + snapshot reservation) supaya tiada rujukan mati.
	  3. File lain yang berkongsi URL lama → tanda private & URL baharu
	     secara terus (fizikal telah berpindah pada langkah 1).
	Idempotent — fail yang sudah private tidak disentuh."""
	frappe.only_for("System Manager")

	old_urls = set()
	for doctype, fieldname in _PASSPORT_URL_FIELDS:
		old_urls.update(frappe.get_all(doctype,
			filters={fieldname: ("like", "/files/%")}, pluck=fieldname))
	if not old_urls:
		return {"checked": 0, "made_private": [], "errors": [],
			"remaining_public": []}

	made_private, errors = [], []
	for old_url in sorted(old_urls):
		file_docs = frappe.get_all("File", filters={"file_url": old_url},
			fields=["name", "is_private"])
		try:
			primary = None
			new_url = old_url
			for fd in file_docs:
				if fd.is_private:
					continue
				if primary is None:
					# Flip pertama melalui save() — pindah fizikal + tulis
					# semula URL + kemaskini medan attach target.
					doc = frappe.get_doc("File", fd.name)
					doc.is_private = 1
					doc.save(ignore_permissions=True)
					primary = fd.name
					new_url = doc.file_url
				else:
					# Duplikat URL lama — fizikal sudah berpindah; terus
					# tanda private & alih ke URL baharu (tanpa save penuh,
					# sumber public sudah tiada di disk).
					frappe.db.set_value("File", fd.name,
						{"is_private": 1, "file_url": new_url}, update_modified=False)
			if primary:
				# Alih semua rujukan URL lama → baharu (save() tadi hanya
				# kemaskini satu dokumen attach).
				for doctype, fieldname in _PASSPORT_URL_FIELDS:
					frappe.db.sql(
						f"""UPDATE `tab{doctype}`
						   SET `{fieldname}` = %(new)s
						   WHERE `{fieldname}` = %(old)s""",
						{"new": new_url, "old": old_url})
				made_private.append({"old": old_url, "new": new_url,
					"files": len(file_docs)})
			frappe.db.commit()
		except Exception:
			frappe.db.rollback()
			errors.append({"url": old_url, "error": "see Error Log"})
			frappe.log_error(title="make_passport_files_private failed",
				message=old_url)

	# Laporan akhir — mana-mana URL public yang tertinggal.
	remaining = []
	for doctype, fieldname in _PASSPORT_URL_FIELDS:
		remaining += [f"{doctype}.{fieldname}: {u}" for u in frappe.get_all(doctype,
			filters={fieldname: ("like", "/files/%")}, pluck=fieldname)]

	frappe.logger("passport_maintenance").info(
		{"event": "make_passport_files_private", "converted": len(made_private),
		 "errors": len(errors), "remaining_public": len(remaining)})
	return {"checked": len(old_urls), "made_private": made_private,
		"errors": errors, "remaining_public": remaining}
