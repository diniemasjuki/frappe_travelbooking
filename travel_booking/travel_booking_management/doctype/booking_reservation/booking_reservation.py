# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class BookingReservation(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		airline: DF.Link | None
		aroya_guest_no: DF.Int
		arrival_date: DF.Date | None
		booking: DF.Link | None
		booking_number: DF.Data | None
		cabin_is_confirmed: DF.Check
		cabin_no: DF.Int
		cruise_end: DF.Date | None
		cruise_start: DF.Date | None
		customer: DF.Data | None
		customer_email: DF.Data | None
		date_selection: DF.Link | None
		delegate_no: DF.Data | None
		departure_date: DF.Date | None
		departure_point: DF.Data | None
		document_status: DF.Literal["Pending", "Verified", "Open for Update", "Rejected", "Valid"]
		flight: DF.Link | None
		flight_announcement: DF.Literal["No Action", "Flight Confirmation", "Flight Retime", "Flight eTicket"]
		flight_departure_airport: DF.Link | None
		flight_departure_date: DF.Date | None
		flight_destination_airport: DF.Link | None
		flight_info_lock: DF.Check
		flight_itinerary: DF.TextEditor | None
		flight_return_date: DF.Date | None
		flight_ticket_type: DF.Data | None
		guest_label: DF.Data | None
		is_a_cruise: DF.Check
		is_cruise_only: DF.Check
		naming_series: DF.Literal[".{booking}.-.#", "RES.YY.MM.###"]
		package_title: DF.Data | None
		package_type: DF.Data | None
		pax_type: DF.Literal["Main Guest", "Extra Bed", "Infant"]
		room_category: DF.Link | None
		stateroom_no: DF.Data | None
		status: DF.Literal["Pending Review", "Confirmed", "Cancelled"]
		traveller: DF.Link | None
		traveller_datebirth: DF.Date | None
		traveller_full_name: DF.Data | None
		traveller_gender: DF.Literal[None]
		traveller_ic: DF.Data | None
		traveller_nationality: DF.Link | None
		traveller_passportexpiry: DF.Date | None
		traveller_passportimg: DF.AttachImage | None
		traveller_passportno: DF.Data | None
		trip_cruise_schedule: DF.Link | None
		trip_link: DF.Data | None
		trip_name: DF.Data | None
		trip_organizer: DF.Data | None
		trip_package: DF.Link | None
		trip_package_code: DF.Data | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Reservation"

	# Had maksimum cabin per booking — MESTI disegerakkan dengan
	# MAX_CABINS_PER_BOOKING dalam booking.js (frontend) dan
	# MAX_CABINS_PER_BOOKING dalam api/booking.py (_validate_selection_capacity),
	# supaya konsisten merentasi website wizard DAN admin manual di Desk.
	MAX_CABINS_PER_BOOKING = 8

	def validate(self):
		self.validate_cabin_capacity()

	def validate_cabin_capacity(self):
		"""Sahkan kapasiti cabin — jaring keselamatan di PERINGKAT DOCTYPE,
		jalan automatik tak kira cara rekod dicipta (website wizard ATAU
		admin manual di Desk). Mirror rules SAMA dengan
		_validate_selection_capacity() (api/booking.py) yang wizard guna,
		tapi kira dari REKOD SEBENAR (sibling Booking Reservation untuk
		booking+cabin_no yang sama), bukan dari input wizard mentah.

		Skip SENYAP (tiada throw) kalau cabin_no/pax_type/room_category/
		booking mana-mana kosong — elak pecahkan rekod LAMA yang tak
		punya field baharu ni terisi.
		"""
		if not (self.booking and self.cabin_no and self.pax_type and self.room_category):
			return

		if self.cabin_no > self.MAX_CABINS_PER_BOOKING:
			frappe.throw(
				"Maksimum " + str(self.MAX_CABINS_PER_BOOKING) +
				" cabin dibenarkan untuk satu booking (Cabin No " +
				str(self.cabin_no) + " melebihi had)."
			)

		# Kira sibling (rekod LAIN, bukan diri sendiri — dokumen ni belum
		# tersimpan lagi masa validate() jalan, jadi query di bawah TAK
		# akan jumpa diri sendiri; kita tambah diri sendiri manual dalam
		# kiraan supaya termasuk kes semasa).
		siblings = frappe.get_all(
			"Booking Reservation",
			filters={
				"booking":   self.booking,
				"cabin_no":  self.cabin_no,
				"name":      ["!=", self.name or ""],
			},
			fields=["pax_type", "room_category"],
		)

		# PENTING: room_category MESTI konsisten dalam satu cabin — satu
		# cabin FIZIKAL tak boleh jadi 2 jenis bilik serentak (beza dengan
		# stateroom_no, yang consistency check-nya kita TANGGUHKAN sengaja
		# — rujuk perbincangan sebelum ni). Kalau ada sibling dengan
		# room_category BERBEZA, block terus — jangan senyap terima label
		# dari slot PERTAMA sahaja (itu punca bug: admin isi "Balcony
		# Superior Cabin" untuk cabin_no yang sibling-nya sudah "Balcony
		# Cabin", tapi grouping portal cuma papar label slot pertama,
		# menyembunyikan percanggahan tanpa disedari).
		mismatched = [s for s in siblings if s.room_category and s.room_category != self.room_category]
		if mismatched:
			frappe.throw(
				"Cabin " + str(self.cabin_no) + " dah ditetapkan sebagai '" + str(mismatched[0].room_category) +
				"' — tak boleh tukar ke '" + str(self.room_category) + "' untuk sebahagian sahaja. " +
				"Kemaskini SEMUA rekod dalam cabin ni serentak kalau nak tukar jenis bilik."
			)

		def _count(pax_type):
			n = sum(1 for s in siblings if s.pax_type == pax_type)
			if self.pax_type == pax_type:
				n += 1
			return n

		main_guest_count = _count("Main Guest")
		extra_bed_count  = _count("Extra Bed")
		infant_count     = _count("Infant")

		info = frappe.db.get_value("Trip Price Category", self.room_category,
									["capacity", "max_capacity"], as_dict=True)
		if not info:
			frappe.throw("Kategori bilik tidak sah: " + str(self.room_category))

		capacity     = int(info.capacity or 0)
		max_capacity = int(info.max_capacity or capacity)

		cabin_label = "Cabin " + str(self.cabin_no) + " (" + str(self.room_category) + ")"

		if main_guest_count > capacity:
			frappe.throw(cabin_label + ": Main Guest melebihi had (" + str(capacity) + ").")
		if extra_bed_count > 0 and main_guest_count != capacity:
			frappe.throw(cabin_label + ": Extra Bed hanya sah bila Main Guest sudah penuh (" + str(capacity) + ").")
		if infant_count > 0 and main_guest_count < 1:
			frappe.throw(cabin_label + ": Infant hanya sah bila Main Guest sekurang-kurangnya 1.")

		total = main_guest_count + extra_bed_count + infant_count
		if total > max_capacity:
			frappe.throw(cabin_label + ": jumlah pax (" + str(total) + ") melebihi kapasiti maksimum (" + str(max_capacity) + ").")

	def before_insert(self):
		self.set_slot_label()

	def after_insert(self):
		self.refresh_related()

	def on_update(self):
		self.refresh_related()

	def on_trash(self):
		self.refresh_related()

	def set_slot_label(self):
		"""Auto 'Traveller N' ikut turutan dalam booking."""
		if self.guest_label:
			return
		existing = frappe.db.count("Booking Reservation", {"booking": self.booking})
		self.guest_label = "Traveller " + str(existing + 1)

	def refresh_related(self):
		"""Update Trip Group Date & Flight yang berkaitan."""
		old = self.get_doc_before_save()

		# --- Trip Group Date (via Booking) ---
		trip_group_date = frappe.db.get_value("Booking", self.booking, "trip_date")
		if trip_group_date:
			frappe.get_doc("Trip Group Date", trip_group_date).refresh_bookings()

		# --- Flight ---
		if self.flight:
			frappe.get_doc("Flight", self.flight).refresh_seats()
		if old and old.flight and old.flight != self.flight:
			frappe.get_doc("Flight", old.flight).refresh_seats()