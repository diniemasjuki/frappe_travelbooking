# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

from travel_booking.api.constants import get_max_cabins

# Option status yang sah pada doctype Traveller. document_status pada
# reservation ialah cermin DUA-HALA status ni (rujuk sync_document_status
# + Traveller.sync_status_to_reservations) — senarai ini mesti sepadan
# dengan options field Traveller.status, termasuk "Valid".
TRAVELLER_STATUS_OPTIONS = ("Incomplete", "Verified", "Open for Update", "Rejected", "Valid")


class BookingReservation(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		accomodation_info_sent: DF.Check
		action_for_accomodation: DF.Literal["No"]
		address_source: DF.Literal["", "From Booking", "Custom"]
		affiliate: DF.Link | None
		airline: DF.Link | None
		aroya_guest_no: DF.Int
		arrival_date: DF.Date | None
		b2b_partner: DF.Link | None
		booked_by: DF.Link | None
		booking: DF.Link | None
		booking_balance_amount: DF.Currency
		booking_channel: DF.Literal["Direct", "Staff", "Affiliate", "B2B"]
		booking_currency: DF.Data | None
		booking_number: DF.Data | None
		booking_paid_amount: DF.Currency
		booking_payment_status: DF.Literal["Pending", "Partially Paid", "Paid", "Request Refund", "Pending Refund", "Refunded"]
		booking_pre_discount_total: DF.Currency
		booking_price_rule_discount: DF.Currency
		booking_prog_payment: DF.Percent
		booking_referral_discount: DF.Currency
		booking_status: DF.Literal["Pending", "Accepted", "Processing", "Confirmed", "Completed", "Abandoned", "Cancelled"]
		booking_total_amount: DF.Currency
		booking_trip_name: DF.Link | None
		booking_voucher_discount: DF.Currency
		cabin_is_confirmed: DF.Check
		cabin_no: DF.Int
		checkout_method: DF.Literal["", "Online Payment Gateway", "Manual Transfer", "Held Booking"]
		company: DF.Link | None
		cruise_end: DF.Date | None
		cruise_start: DF.Date | None
		customer: DF.Data | None
		customer_email: DF.Data | None
		customer_message: DF.SmallText | None
		customer_phone: DF.Phone | None
		date_selection: DF.Link | None
		delegate_no: DF.Data | None
		departure_date: DF.Date | None
		departure_point: DF.Data | None
		document_status: DF.Literal["Incomplete", "Verified", "Open for Update", "Rejected", "Valid"]
		end_customer: DF.Link | None
		flight: DF.Link | None
		flight_announcement: DF.Literal["No Action", "Flight Confirmation", "Flight Retime", "Flight eTicket"]
		flight_departure_airport: DF.Link | None
		flight_departure_date: DF.Date | None
		flight_destination_airport: DF.Link | None
		flight_info_lock: DF.Check
		flight_itinerary: DF.TextEditor | None
		flight_return_date: DF.Date | None
		flight_ticket_type: DF.Data | None
		guest_address_line1: DF.Data | None
		guest_city: DF.Data | None
		guest_country: DF.Data | None
		guest_label: DF.Data | None
		guest_postcode: DF.Data | None
		guest_sequence: DF.Int
		guest_state: DF.Data | None
		is_a_cruise: DF.Check
		is_cruise_only: DF.Check
		naming_series: DF.Literal[".{booking}.-.#", "RES.YY.MM.###"]
		package_title: DF.Data | None
		package_type: DF.Data | None
		passport_link_email: DF.Data | None
		passport_link_expires_on: DF.Datetime | None
		passport_link_token: DF.Data | None
		pax_type: DF.Data | None
		referral_code_used: DF.Data | None
		room_category: DF.Link | None
		room_id: DF.Data | None
		room_privacy: DF.Literal["Private", "Open Sharing"]
		stateroom_no: DF.Data | None
		status: DF.Literal["Pending Review", "Confirmed", "Cancelled"]
		total_days: DF.ReadOnly | None
		total_nights: DF.ReadOnly | None
		traveller: DF.Link | None
		traveller_datebirth: DF.Date | None
		traveller_email: DF.Data | None
		traveller_full_name: DF.Data | None
		traveller_gender: DF.Literal[None]
		traveller_ic: DF.Data | None
		traveller_nationality: DF.Link | None
		traveller_passportexpiry: DF.Date | None
		traveller_passportimg: DF.AttachImage | None
		traveller_passportno: DF.Data | None
		trip_cruise_schedule: DF.Link | None
		trip_link: DF.Link | None
		trip_name: DF.Data | None
		trip_organizer: DF.Data | None
		trip_package: DF.Link | None
		trip_package_code: DF.Data | None
		voucher: DF.Link | None
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking Reservation"

	# Had maksimum cabin per booking — kini disumber-tunggu dari
	# travel_booking.api.constants.get_max_cabins() (bukan hardcoded di sini),
	# supaya admin boleh tukar nilai di Travel Settings tanpa sentuh kod.
	# Sebelum ni, nilai 8 diduplikasi di booking_reservation.py, booking.py,
	# dan booking.js — tiga tempat perlu dikemas kini serentak.
	#
	# booking.js (frontend) kekal hardcoded buat sementara — ia dimuat sebelum
	# sebarang panggilan API. Admin yang tukar nilai di Travel Settings perlu
	# kemaskini booking.js sekali buat masa ni.

	def validate(self):
		self.sync_document_status()
		self.assign_room_id()
		self.validate_cabin_capacity()
		self.sync_booking_money_snapshot()

	def sync_booking_money_snapshot(self):
		"""Snapshot kewangan Booking → reservation (currency, total, baki,
		paid). SEMUA field ni ialah snapshot TERSENDIRI — nilai Booking tak
		boleh di-fetch_from sebab sumbernya virtual property (dikira live
		dari Sales Order, tiada kolum DB), jadi nilai dikira di sini dan
		disimpan pada reservation.

		Fill-empty-only: nilai pertama (masa slot dicipta ATAU patch
		backfill v25) dikekalkan — snapshot ni memang direka beku; segar
		semula hanya bila field dikosongkan atau patch diulang. Sifar (0)
		IALAH nilai sah (booking lunas → baki 0), jadi "kosong" bermaksud
		None / string kosong SAHAJA, bukan falsy.
		"""
		if not self.booking:
			return
		filled = (
			self.booking_currency not in (None, "")
			and self.booking_total_amount is not None
			and self.booking_balance_amount is not None
			and self.booking_paid_amount is not None
		)
		if filled:
			return
		if not frappe.db.exists("Booking", self.booking):
			return

		booking = frappe.get_cached_doc("Booking", self.booking)
		if self.booking_currency in (None, ""):
			self.booking_currency = booking.currency
		if self.booking_total_amount is None:
			self.booking_total_amount = booking.total_amount
		if self.booking_balance_amount is None:
			self.booking_balance_amount = booking.balance_amount
		if self.booking_paid_amount is None:
			# Booking.paid_amount ialah field virtual berFORMULA
			# (options: "doc.total_amount - doc.balance_amount") — tiada
			# attribute Python, jadi kira ekspresi yang sama di sini.
			self.booking_paid_amount = (booking.total_amount or 0) - (booking.balance_amount or 0)

	def sync_document_status(self):
		"""Selaraskan document_status reservation dengan status Traveller.

		Field ni stored (bukan virtual) supaya BOLEH diedit terus dari
		form reservation — user tak payah buka dokumen Traveller asing.
		Perubahan boleh masuk dari mana-mana hala:
		- document_status diubah di reservation ni → tolak nilai ke
		  Traveller.status (semua option termasuk "Valid" ditolak —
		  senarai sama dengan options Traveller.status).
		- document_status kosong ATAU traveller baru ditukar → tarik
		  masuk status sedia ada Traveller.
		Perubahan dari sisi Traveller pula disebarkan oleh
		Traveller.sync_status_to_reservations(). Kedua-dua arah guna
		frappe.db.set_value(update_modified=False) — tiada gelung
		on_update dan modified dokumen sisi lain tak terusik.
		"""
		if not self.traveller:
			return
		traveller_status = frappe.db.get_value("Traveller", self.traveller, "status")
		old = self.get_doc_before_save()
		old_val = old.document_status if old else None
		traveller_changed = (old.traveller if old else None) != self.traveller

		if self.document_status and self.document_status != old_val:
			# user baru ubah document_status di reservation → tolak ke Traveller
			if self.document_status in TRAVELLER_STATUS_OPTIONS and traveller_status != self.document_status:
				frappe.db.set_value("Traveller", self.traveller, "status",
					self.document_status, update_modified=False)
		elif traveller_status and (not self.document_status or traveller_changed):
			self.document_status = traveller_status

	def assign_room_id(self):
		"""Auto Room ID = [booking_number] + "-Room_" + [cabin_no] —cth:
		"RTEOU462609-Room_2". Laksana pada validate() (INSERT dan SAVE
		setiap kali) supaya mana-mana jalan penciptaan (wizard portal,
		_activate_booking, ATAU admin manual di Desk) dapat ID yang sama,
		tanpa perlu ulang logik di setiap caller. Assign SEKALI SAHAJA:
		hanya bila room_id kosong — ID yang admin isi manual TIDAK
		ditimpa. Skip senyap bila booking/cabin_no kosong (rekod lama),
		selari dengan gaya validate_cabin_capacity().
		"""
		if self.room_id:
			return
		if not (self.booking and self.cabin_no):
			return

		# booking_number pada reservation ni fetch_from Booking — tapi
		# fetch_from hanya terisi bila link diset melalui UI; rekod yang
		# dicipta server-side (so_helpers._activate_booking) tinggal
		# kosong. Fallback ke DB, kemudian ke docname Booking (docname
		# sendiri pun rujukan sah kalau booking_number tiada).
		ref = self.booking_number
		if not ref:
			ref = frappe.db.get_value("Booking", self.booking, "booking_number")
		if not ref:
			ref = self.booking

		self.room_id = str(ref) + "-Room_" + str(self.cabin_no)

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

		Escape hatch 'force' (flags.skip_cabin_capacity_validation): dipasang
		oleh Resync & Regenerate (booking_hub.resync_booking force=True)
		SELEPAS admin dimaklumkan isu (cth room capacity limitation /
		mismatch room category) dan memilih proceed dengan overwrite —
		validasi NI sahaja di-skip; validasi lain (link, mandatory) kekal
		berjalan supaya force tidak menembus ralat data yang genuine.
		"""
		if self.flags.get("skip_cabin_capacity_validation"):
			return
		if not (self.booking and self.cabin_no and self.pax_type and self.room_category):
			return

		if self.cabin_no > get_max_cabins():
			frappe.throw(
				"Maximum " + str(get_max_cabins()) +
				" cabins are allowed per booking (Cabin No " +
				str(self.cabin_no) + " exceeds the limit)."
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
				"Cabin " + str(self.cabin_no) + " is already set as '" + str(mismatched[0].room_category) +
				"' — cannot change to '" + str(self.room_category) + "' for only some slots. " +
				"Update ALL records in this cabin at once to change the room type."
			)

		def _count(pax_type):
			n = sum(1 for s in siblings if s.pax_type == pax_type)
			if self.pax_type == pax_type:
				n += 1
			return n

		# Model: cruise=slot (Main Guest/Extra Bed), non-cruise=umur
		# (Adult/Children). Sumber Booking.is_a_cruise_trip (fetch_from
		# trip_date) — boleh dipercaya untuk rekod wizard mahupun admin Desk.
		is_cruise = bool(frappe.db.get_value("Booking", self.booking, "is_a_cruise_trip"))
		if is_cruise:
			main_guest_count = _count("Main Guest")
			extra_bed_count  = _count("Extra Bed")
		else:
			main_guest_count = _count("Adult")
			extra_bed_count  = _count("Children")
		infant_count = _count("Infant")

		info = frappe.db.get_value("Trip Price Category", self.room_category,
									["capacity", "max_capacity"], as_dict=True)
		if not info:
			frappe.throw("Invalid room category: " + str(self.room_category))

		capacity = int(info.capacity or 0)
		# max_capacity == 0 (eksplisit) -> UNLIMITED (overbooking cabin
		# dibenarkan). None/kosong -> fallback ke capacity (behavior sedia).
		# Bezakan None daripada 0 supaya pakej lama tak berubah tingkah laku.
		mc = info.max_capacity
		if mc is None:
			max_capacity = capacity
			unlimited = False
		else:
			max_capacity = int(mc)
			unlimited = (max_capacity == 0)

		cabin_label = "Cabin " + str(self.cabin_no) + " (" + str(self.room_category) + ")"

		if is_cruise:
			# SLOT: Extra Bed (upper berth) hanya sah bila Main Guest penuh
			# capacity dulu — cermin _validate_selection_capacity (cruise).
			if capacity > 0 and main_guest_count > capacity:
				frappe.throw(cabin_label + ": Main Guest exceeds the capacity (" + str(capacity) + ").")
			if extra_bed_count > 0 and capacity > 0 and main_guest_count != capacity:
				frappe.throw(cabin_label + ": Extra Bed is only valid when Main Guest is at full capacity (" + str(capacity) + ").")
			if infant_count > 0 and main_guest_count < 1:
				frappe.throw(cabin_label + ": Infant is only valid when there is at least 1 Main Guest.")
		else:
			# UMUR: Children dibenarkan bila-bila (tiada syarat "adult penuh").
			if extra_bed_count > 0 and main_guest_count < 1:
				frappe.throw(cabin_label + ": Children is only valid when there is at least 1 Adult.")
			if infant_count > 0 and main_guest_count < 1:
				frappe.throw(cabin_label + ": Infant is only valid when there is at least 1 Adult.")

		total = main_guest_count + extra_bed_count + infant_count
		if not unlimited and total > max_capacity:
			frappe.throw(cabin_label + ": total pax (" + str(total) + ") exceeds the maximum capacity (" + str(max_capacity) + ").")

	def before_insert(self):
		self.set_slot_label()
		self.set_guest_sequence()

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

	def set_guest_sequence(self):
		"""Guest Sequence = urutan tetamu DALAM cabin (booking + cabin_no):
		cabin 4-tetamu → 1,2,3,4; cabin seterusnya bermula 1 semula. Format
		rooming list kapal (Stateroom: Guest 1, Guest 2, ...).

		Dilaksana di before_insert supaya SEMUA laluan penciptaan terliput
		(wizard → _activate_booking, tambah traveller → cabin_sharing,
		atau admin manual di Desk). Assign SEKALI SAHAJA — nilai yang
		diisi manual admin TIDAK ditimpa. Slot Cancelled tidak dikira
		(nombor tak dibazorkan); skip senyap bila booking/cabin_no kosong
		(rekod lama), selari dengan gaya assign_room_id().
		"""
		if self.guest_sequence:
			return
		if not (self.booking and self.cabin_no):
			return
		self.guest_sequence = frappe.db.count("Booking Reservation", {
			"booking":     self.booking,
			"cabin_no":    self.cabin_no,
			"status":      ["!=", "Cancelled"],
		}) + 1

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