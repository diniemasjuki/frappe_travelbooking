# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import getdate, today


class Traveller(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		address_line1: DF.SmallText | None
		age: DF.Int
		age_category: DF.Literal["Adult", "Child", "Infant"]
		city: DF.Data | None
		country: DF.Link | None
		date_of_birth: DF.Date | None
		dietary_requirements: DF.Text | None
		document_verified: DF.Check
		email: DF.Data | None
		emergency_contact_name: DF.Data | None
		emergency_contact_phone: DF.Phone | None
		emergency_contact_relationship: DF.Data | None
		first_name: DF.Data
		full_name: DF.Data | None
		fullname_format: DF.Literal["First Name + Last Name", "Last Name + First Name"]
		gender: DF.Literal["Male", "Female"]
		ic_number: DF.Data
		ic_number_view: DF.Data | None
		last_name: DF.Data
		medical_conditions: DF.Text | None
		medicine_treatment: DF.Text | None
		nationality: DF.Link | None
		passport_expiry: DF.Date | None
		passport_image: DF.AttachImage | None
		passport_no: DF.Data | None
		phone: DF.Phone | None
		postcode: DF.Data | None
		state: DF.Data | None
		status: DF.Literal["Incomplete", "Pending Verification", "Verified", "Open for Update", "Rejected", "Valid"]
		title: DF.Literal["Mr", "Mrs"]
		visa_photo: DF.Attach | None
		wheelchair_assistant: DF.Literal["", "Not Required", "Long Walk Only", "All Time"]
	# end: auto-generated types

	
		_DOCTYPE_NAME = "Traveller"
 


	def before_save(self):
		self.set_uppercase()
		self.set_full_name()
		self.set_age_from_dob()
		self.set_age_category()
		self.set_title_and_gender_from_name()
		# Hook auto-update profil: title SENTIASA ikut gender terakhir
		# (Mr = Male, Mrs = Female). Jalankan SELEPAS set_title_and_gender_
		# from_name() supaya gender yang diinferens dari nama (bin/binti)
		# untuk rekod lama turut menetapkan title.
		self.set_title_from_gender()
		# Flow dokumen: borang wajib lengkap (kecuali kesihatan & gambar
		# visa — tidak wajib) → status auto "Pending Verification".
		self.evaluate_document_status()
		# Status masuk Verified → auto-centang kunci dokumen (checkbox
		# 'Document Verified' — medan maklumat jadi read-only di Desk).
		self.sync_verified_lock()

	def sync_verified_lock(self):
		"""Auto-enable checkbox 'Document Verified' apabila status naik ke
		Verified — kunci verified document (semua medan maklumat peribadi
		jadi read-only di Desk melalui read_only_depends_on).

		- Transisi sahaja: admin yang uncheck manual TIDAK akan
		  diterbalikkan pada setiap save semasa status kekal Verified.
		- Keluar dari Verified (Open for Update / Rejected) TIDAK
		  auto-uncheck — admin kekal kuasa penuh atas kunci manual.
		- 'age' mandatory bila kunci aktif (mandatory_depends_on) — jangan
		  centang bila umur belum terkira (DOB kosong) supaya save tidak
		  gagal; admin isi DOB dahulu, kunci tercentang pada save
		  seterusnya apabila status ditetapkan Verified semula."""
		if self.status != "Verified" or self.document_verified:
			return
		if not self.age:
			return
		old = self.get_doc_before_save()
		old_status = (old.status if old else "") or ""
		if old_status == "Verified":
			return
		self.document_verified = 1

	def on_update(self):
		self.sync_status_to_reservations()
		# Emel pemakluman "Pending Verification" DIURUS oleh Notification
		# Desk "Passport Submission" (event Value Change pada field status +
		# condition doc.status == "Pending Verification") — BUKAN kod di
		# sini, elak emel berganda. Template/recipient diedit di Desk:
		# /app/notification/Passport%20Submission

	# ── Flow status dokumen ─────────────────────────────────────────────
	# Incomplete → (borang wajib lengkap, auto) → Pending Verification →
	# admin: Verified / Valid / Rejected; expired passport (hook harian) →
	# Open for Update → traveller isi semula → Pending Verification lagi.
	PENDING_VERIFICATION = "Pending Verification"
	# Status yang boleh naik automatik ke Pending Verification bila borang
	# lengkap: kosong/Incomplete (baru), Open for Update (re-upload lepas
	# expired) & Rejected (customer betulkan dokumen). Status keputusan
	# admin — Verified / Valid — TIDAK pernah diketuk automatik.
	PROMOTABLE_STATUSES = ("", "Incomplete", "Open for Update", "Rejected")

	# Medan borang yang WAJIB terisi untuk lengkap — cermin gerbang portal
	# _traveller_missing_fields (section Passport + Contact). title/full_name/
	# umur TIDAK termasuk: diinferens automatik dalam before_save; admin
	# boleh set di Desk/modal.
	#
	# KELUAR DARIPADA REQUIREMENT (status naik "Pending Verification"
	# TANPA data ini — maklumat kesihatan bukan syarat kelengkapan):
	# - dietary_requirements   (Dietary Requirements)
	# - medical_conditions     (Medical Conditions)
	# - medicine_treatment     (Medicine / Treatment)
	# (wheelchair_assistant & visa_photo turut tidak wajib sejak asal.)
	MANDATORY_INFO_FIELDS = (
		"first_name", "last_name", "ic_number", "nationality",
		"date_of_birth", "gender", "passport_no", "passport_expiry",
		"passport_image", "email", "phone",
		"emergency_contact_name", "emergency_contact_phone",
		"address_line1", "city", "postcode", "state", "country",
	)

	def is_info_complete(self) -> bool:
		"""True bila SEMUA medan borang wajib terisi (bukan NULL/'') —
		maklumat kesihatan & gambar visa dikecualikan."""
		return all(str(getattr(self, f, None) or "").strip()
			for f in self.MANDATORY_INFO_FIELDS)

	def evaluate_document_status(self):
		"""Auto-promote status ke 'Pending Verification' bila borang wajib
		lengkap. Hanya dari status 'boleh naik' (kosong/Incomplete/
		Open for Update/Rejected) — status keputusan admin dihormati."""
		if self.status not in self.PROMOTABLE_STATUSES:
			return
		if self.is_info_complete():
			self.status = self.PENDING_VERIFICATION

	def sync_status_to_reservations(self):
		"""Sebar status ni ke rekod Booking Reservation traveller ini.

		document_status pada Booking Reservation ialah cermin status ni —
		boleh diedit dari kedua-dua borang (rujuk
		BookingReservation.sync_document_status). Guna
		frappe.db.set_value(update_modified=False): tak picu on_update
		reservation (elak gelung) dan tak usik modified reservation.
		"""
		old = self.get_doc_before_save()
		if old and old.status == self.status:
			return
		for name in frappe.get_all("Booking Reservation",
				filters={"traveller": self.name}, pluck="name"):
			frappe.db.set_value("Booking Reservation", name,
				"document_status", self.status, update_modified=False)
  
	def set_icnumber(self):
		self.ic_number = self.ic_number.replace(" ","").replace("-","")
  	

	def set_uppercase(self):
		text_fields = [
			"first_name", "last_name", "full_name",
			"ic_number", "passport_no",
			"emergency_contact_name", "emergency_contact_relationship",
			# Alamat — uppercase ikut konvensyen dokumen perjalanan;
			# dilaksana di doctype supaya SEMUA laluan edit (Desk, portal,
			# modal admin Manage Booking) dapat perlakuan sama.
			"address_line1", "city", "state", "postcode",
		]
		for field in text_fields:
			val = getattr(self, field, None)
			if val:
				setattr(self, field, val.upper())

	def set_full_name(self):
		first = (self.first_name or "").strip()
		last  = (self.last_name or "").strip()
		if self.fullname_format == "Last Name + First Name":
			combined = " ".join(filter(None, [last, first]))
		else:
			# Default: "First Name + Last Name" — juga fallback kalau
			# fullname_format belum dipilih/kosong.
			combined = " ".join(filter(None, [first, last]))
		if combined:
			self.full_name = combined

	def set_age_from_dob(self):
		if not self.date_of_birth:
			return
		try:
			dob = getdate(self.date_of_birth)
			today_dt = getdate(today())
			age = today_dt.year - dob.year
			if (today_dt.month, today_dt.day) < (dob.month, dob.day):
				age -= 1
			self.age = age if age >= 0 else 0
		except Exception:
			self.age = 0

	def set_age_category(self):
		# < 2 tahun = Infant, < 12 tahun = Child, 12 tahun ke atas = Adult.
		if self.age is None:
			return
		age = int(self.age)
		if age < 2:
			self.age_category = "Infant"
		elif age < 12:
			self.age_category = "Child"
		else:
			self.age_category = "Adult"

	def set_title_from_gender(self):
		# Title auto ikut gender — sentiasa dikemas kini pada setiap save
		# (Mr bila Male, Mrs bila Female). Gender kosong → title tak disentuh.
		if self.gender == "Male":
			self.title = "Mr"
		elif self.gender == "Female":
			self.title = "Mrs"

	def set_title_and_gender_from_name(self):
		name = (self.full_name or self.last_name or "").lower()
		if " binti " in name or name.startswith("binti "):
			if not self.title:  self.title = "Mrs"
			if not self.gender: self.gender = "Female"
		elif " bin " in name or name.startswith("bin "):
			if not self.title:  self.title = "Mr"
			if not self.gender: self.gender = "Male"