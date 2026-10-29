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
		status: DF.Literal["Incomplete", "Pending Verification", "Verified", "Open for Update", "Expired"]
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

	def on_update(self):
		self.sync_status_to_reservations()
		self.sync_trip_flags_to_reservations()
		# Emel pemakluman "Pending Verification" DIURUS oleh Notification
		# Desk "Passport Submission" (event Value Change pada field status +
		# condition doc.status == "Pending Verification") — BUKAN kod di
		# sini, elak emel berganda. Template/recipient diedit di Desk:
		# /app/notification/Passport%20Submission

	# ── Flow status dokumen ─────────────────────────────────────────────
	# Incomplete → (borang wajib lengkap, auto) → Pending Verification →
	# admin: Verified / Expired (manual); passport hampir/beliau tamat
	# tempoh (hook harian) → Open for Update → traveller isi semula →
	# Pending Verification lagi. Status "Valid" & "Rejected" DIBUANG
	# daripada proses (selari options doctype).
	PENDING_VERIFICATION = "Pending Verification"
	# Status yang boleh naik automatik ke Pending Verification bila borang
	# lengkap: kosong/Incomplete (baru) & Open for Update (re-upload lepas
	# expired). Status keputusan admin — Verified / Expired — TIDAK
	# pernah diketuk automatik.
	PROMOTABLE_STATUSES = ("", "Incomplete", "Open for Update")

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
		Open for Update) — status keputusan admin (Verified/Expired) dihormati.

		flags.keep_manual_status — keputusan status EXPLISIT admin (cth. Quick
		Status modal Booking Manager → update_traveller_status): auto-promote
		DILANGKAHI supaya 'Open for Update' yang admin paksakan tidak serta-
		merta dibalikkan semula (aliran auto portal re-upload kekal normal).
		"""
		if self.flags.get("keep_manual_status"):
			return
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

		Status aliran reservation (Waiting Document / Document Completed
		/ Document Expired) turut dikira semula — perubahan status
		Traveller ialah pencetus utama peralihan dokumen pada aliran itu.
		"""
		old = self.get_doc_before_save()
		if old and old.status == self.status:
			return
		# Import dalam fungsi — elak circular import (reservation modul
		# tidak import traveller, tapi senang selamat).
		from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
			recompute_reservation_status,
		)
		for name in frappe.get_all("Booking Reservation",
				filters={"traveller": self.name}, pluck="name"):
			frappe.db.set_value("Booking Reservation", name,
				"document_status", self.status, update_modified=False)
			recompute_reservation_status(name)

	def sync_trip_flags_to_reservations(self):
		"""Sebar perubahan DOB / passport_expiry ke penanda klasifikasi trip
		(birthday_on_trip / passport_to_expire_on_trip) SEMUA reservation
		traveller ini — reservation tak disave bila Traveller dikemaskini,
		jadi penandanya mesti dikira semula dari luar (corak sama dengan
		sync_status_to_reservations). Skip bila kedua-dua medan tak berubah.
		"""
		old = self.get_doc_before_save()
		if old and old.date_of_birth == self.date_of_birth \
				and old.passport_expiry == self.passport_expiry:
			return
		from travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation import (
			recompute_reservation_trip_flags,
		)
		for name in frappe.get_all("Booking Reservation",
				filters={"traveller": self.name}, pluck="name"):
			recompute_reservation_trip_flags(name)
  
	def set_icnumber(self):
		self.ic_number = self.ic_number.replace(" ","").replace("-","")
  	

	def set_uppercase(self):
		text_fields = [
			"first_name", "last_name", "full_name",
			"ic_number", "passport_no",
			"emergency_contact_name", "emergency_contact_relationship",
			# Alamat SENGAJA TIDAK dipaksa uppercase — user taip bebas;
			# berkuatkuasa pada SEMUA laluan simpan (Desk, modal admin
			# Manage Booking, borang portal traveller / guest passport /
			# on-behalf) kerana semuanya melalui doctype ini.
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