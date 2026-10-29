# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import add_months, getdate, nowdate

from travel_booking.api.constants import get_max_cabins

# Option status yang sah pada doctype Traveller. document_status pada
# reservation ialah cermin DUA-HALA status ni (rujuk sync_document_status
# + Traveller.sync_status_to_reservations) — senarai ini mesti sepadan
# dengan options field Traveller.status, TERMASUK "Pending Verification"
# (auto oleh Traveller.evaluate_document_status bila borang lengkap)
# — selari options doctype Traveller.
TRAVELLER_STATUS_OPTIONS = (
	"Incomplete", "Pending Verification", "Verified",
	"Open for Update", "Expired",
)

# ══════════════════════════════════════════════
# ALIRAN STATUS RESERVATION (auto kecuali Preparation Complete)
# ══════════════════════════════════════════════
#
# Waiting Document → Document Completed → (Document Expired) →
# Preparation Complete (manual admin, melekat) → Trip OnProgress →
# Completed / Cancelled.
#
# Status dikira oleh compute_auto_status() ikut KEUTAMAAN:
#   1. Cancelled         — Booking berstatus Cancelled
#   2. Completed         — Booking berstatus Completed
#   3. Completed         — hari ini sudah melepasi return_date trip
#   4. Trip OnProgress   — departure_date ≤ hari ini ≤ return_date
#   5. Document Expired  — luput passport < 6 bulan dari departure
#                          (peraturan 6 bulan, sama threshold dengan
#                          passport_maintenance) ATAU status Traveller
#                          "Open for Update" (dokumen dibuka semula —
#                          hook harian / admin Quick Status)
#   6. Document Completed — status Traveller: Verified / Valid /
#                          Pending Verification
#   7. Waiting Document  — tiada Traveller linked, atau status Traveller
#                          lain (Incomplete / Open for Update)
#
# Status MELEKAT (tak diketuk automatik):
#   - Preparation Complete — tanda manual admin bahawa persiapan slot ni
#     siap. Hanya peristiwa "lebih kuat" yang mengatasi: Document Expired,
#     Trip OnProgress, Completed, Cancelled (rujuk resolve_auto_status).
#   - Completed / Cancelled — terminal; hanya kemaskini eksplisit (patch,
#     admin) yang boleh hidupkan semula.
#
# Pencetus pengiraan:
#   - validate() reservation itu sendiri (setiap save)
#   - Traveller.status berubah → Traveller.sync_status_to_reservations()
#     → recompute_reservation_status()
#   - Booking → Completed (manual Desk/Hub ATAU mark_completed_trips)
#     → sync_status_for_booking()
#   - passport_maintenance.cleanup_expired_passport_images (hook harian)
#     → recompute_reservation_status()
#   - Jaring keselamatan harian: auto_update_reservation_statuses()
#     (hooks.py scheduler daily) — tangkap peralihan tarikh (Trip
#     OnProgress, 24-jam Completed, luput passport menjelang departure)
#     yang tak melibatkan sebarang save dokumen.


class BookingReservation(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF

		accomodation_info_sent: DF.Check
		action_for_accomodation: DF.Literal["No"]
		affiliate: DF.ReadOnly | None
		airline: DF.Link | None
		aroya_guest_no: DF.Int
		arrival_date: DF.ReadOnly | None
		b2b_partner: DF.ReadOnly | None
		birthday_on_trip: DF.Check
		booked_by: DF.ReadOnly | None
		booking: DF.Link | None
		booking_balance_amount: DF.ReadOnly | None
		booking_channel: DF.ReadOnly | None
		booking_currency: DF.ReadOnly | None
		booking_number: DF.ReadOnly | None
		booking_paid_amount: DF.ReadOnly | None
		booking_payment_status: DF.ReadOnly | None
		booking_pre_discount_total: DF.ReadOnly | None
		booking_price_rule_discount: DF.ReadOnly | None
		booking_prog_payment: DF.ReadOnly | None
		booking_referral_discount: DF.ReadOnly | None
		booking_status: DF.ReadOnly | None
		booking_total_amount: DF.ReadOnly | None
		booking_trip_name: DF.ReadOnly | None
		booking_voucher_discount: DF.ReadOnly | None
		cabin_is_confirmed: DF.Check
		cabin_no: DF.Int
		checkout_method: DF.ReadOnly | None
		company: DF.ReadOnly | None
		cruise_end: DF.ReadOnly | None
		cruise_start: DF.ReadOnly | None
		customer: DF.ReadOnly | None
		customer_email: DF.ReadOnly | None
		customer_message: DF.SmallText | None
		customer_phone: DF.ReadOnly | None
		date_selection: DF.Link | None
		delegate_no: DF.Data | None
		departure_date: DF.ReadOnly | None
		departure_point: DF.ReadOnly | None
		document_status: DF.ReadOnly | None
		end_customer: DF.ReadOnly | None
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
		guest_sequence: DF.Int
		is_a_cruise: DF.ReadOnly | None
		is_cruise_only: DF.ReadOnly | None
		naming_series: DF.Literal[".{booking}.-.#", "RES.YY.MM.###"]
		package_title: DF.ReadOnly | None
		package_type: DF.ReadOnly | None
		passport_link_email: DF.Data | None
		passport_link_expires_on: DF.Datetime | None
		passport_link_token: DF.Data | None
		passport_to_expire_on_trip: DF.Check
		pax_type: DF.Data | None
		referral_code_used: DF.ReadOnly | None
		room_category: DF.Link | None
		room_id: DF.Data | None
		room_privacy: DF.Literal["Private", "Open Sharing"]
		stateroom_no: DF.Data | None
		status: DF.Literal["Waiting Document", "Document Completed", "Document Expired", "Preparation Completed", "Trip On Progress", "Completed", "Cancelled"]
		total_days: DF.ReadOnly | None
		total_nights: DF.ReadOnly | None
		traveller: DF.Link | None
		traveller_address_line1: DF.ReadOnly | None
		traveller_age_category: DF.ReadOnly | None
		traveller_city: DF.ReadOnly | None
		traveller_country: DF.ReadOnly | None
		traveller_datebirth: DF.ReadOnly | None
		traveller_email: DF.ReadOnly | None
		traveller_emergency_contact_name: DF.ReadOnly | None
		traveller_emergency_contact_phone: DF.ReadOnly | None
		traveller_emergency_contact_relationship: DF.ReadOnly | None
		traveller_first_name: DF.ReadOnly | None
		traveller_full_name: DF.ReadOnly | None
		traveller_gender: DF.ReadOnly | None
		traveller_ic: DF.ReadOnly | None
		traveller_last_name: DF.ReadOnly | None
		traveller_nationality: DF.ReadOnly | None
		traveller_passportexpiry: DF.ReadOnly | None
		traveller_passportimg: DF.ReadOnly | None
		traveller_passportno: DF.ReadOnly | None
		traveller_phone: DF.ReadOnly | None
		traveller_postcode: DF.ReadOnly | None
		traveller_state: DF.ReadOnly | None
		traveller_status: DF.ReadOnly | None
		traveller_title: DF.ReadOnly | None
		traveller_visa_photo: DF.ReadOnly | None
		traveller_wheelchair_assistant: DF.ReadOnly | None
		trip_cruise_schedule: DF.Link | None
		trip_link: DF.Link | None
		trip_name: DF.ReadOnly | None
		trip_organizer: DF.ReadOnly | None
		trip_package: DF.Link | None
		trip_package_code: DF.ReadOnly | None
		voucher: DF.ReadOnly | None
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
		# sync_document_status DULU — ia boleh menulis status baharu ke
		# Traveller (db.set_value, serta-merta) bila admin ubah mirror di
		# reservation; apply_auto_status mesti baca nilai Traveller yang
		# TELAH dikemas kini, bukan yang lama.
		self.sync_document_status()
		self.apply_auto_status()
		self.compute_trip_flags()
		self.assign_room_id()
		self.validate_cabin_capacity()
		self.sync_booking_money_snapshot()

	# ══════════════════════════════════════════════
	# PENANDA KLASIFIKASI TRIP (checkbox auto)
	# ══════════════════════════════════════════════

	def compute_trip_flags(self):
		"""Kira semula checkbox klasifikasi trip slot ni (setiap validate —
		INSERT & UPDATE, termasuk Data Import / kemaskini portal):

		- birthday_on_trip        — ulang tahun (bulan-hari) DOB traveller
		                           jatuh dalam tempoh departure–return.
		- passport_to_expire_on_trip — passport luput < 6 bulan dari
		                           departure (termasuk sudah luput).

		Sumber data sentiasa LIVE dari DB (Booking + Traveller), bukan
		snapshot fetch_from pada reservation — snapshot hanya segar bila
		link diset semula di UI; DB sentiasa nilai terkini selepas save
		dokumen sumber. Fallback ke snapshot hanya bila sumber live kosong
		(rekod lama / data separuh isi).
		"""
		dep, ret = None, None
		if self.booking and frappe.db.exists("Booking", self.booking):
			b = frappe.db.get_value("Booking", self.booking,
				["departure_date", "return_date"], as_dict=True)
			dep, ret = b.departure_date, b.return_date
		dep = dep or self.departure_date
		ret = ret or self.arrival_date

		dob, expiry = None, None
		if self.traveller and frappe.db.exists("Traveller", self.traveller):
			t = frappe.db.get_value("Traveller", self.traveller,
				["date_of_birth", "passport_expiry"], as_dict=True)
			dob, expiry = t.date_of_birth, t.passport_expiry
		dob = dob or self.traveller_datebirth
		expiry = expiry or self.traveller_passportexpiry

		self.birthday_on_trip = 1 if birthday_during_trip(dob, dep, ret) else 0
		self.passport_to_expire_on_trip = 1 if passport_expiring_before_departure(expiry, dep) else 0

	# ══════════════════════════════════════════════
	# ALIRAN STATUS AUTO — teras & pembantu kongsi
	# ══════════════════════════════════════════════

	# Status MELEKAT: Preparation Complete ialah tanda manual admin
	# ("persiapan slot ni siap") — pengiraan auto TIDAK menurunkannya
	# semula ke status dokumen; hanya peristiwa lebih kuat yang mengatasi
	# (Document Expired, Trip OnProgress, Completed, Cancelled — rujuk
	# resolve_auto_status()). Completed/Cancelled pula terminal.
	STICKY_STATUSES = ("Preparation Complete",)

	# Entri status Traveller yang dikira "dokumen siap". Pending
	# Verification dikira siap kerana borang sudah lengkap — tinggal
	# semakan admin (kanun: Waiting Document = dokumen BELUM lengkap).
	COMPLETED_DOC_STATUSES = ("Verified", "Pending Verification")

	def compute_auto_status(self) -> str | None:
		"""Kira status yang SEPATUTNYA untuk reservation ni ikut aliran
		auto. Pulangkan None hanya bila status semasa patut dikekalkan
		(sudah terminal ATAU Preparation Complete masih relevan).

		Tarikh rujukan ialah departure/return Booking (fetch_from Trip
		Group Date) — reservation ada snapshot departure_date/arrival_date
		sendiri, tapi fallback ke snapshot itu bila Booking kosong.
		"""
		booking_status = None
		dep, ret = None, None
		if self.booking and frappe.db.exists("Booking", self.booking):
			b = frappe.db.get_value("Booking", self.booking,
				["status", "departure_date", "return_date"], as_dict=True)
			booking_status = b.status
			dep, ret = b.departure_date, b.return_date
		dep = dep or self.departure_date
		ret = ret or self.arrival_date
		today = getdate(nowdate())

		# Cancelled ialah TERMINAL — booking Completed tak hidupkan semula
		# slot yang dibatalkan (Cancel > Complete). Hanya booking Cancelled
		# yang "mengesahkan" nilai itu (rule #1 di bawah).
		if self.status == "Cancelled" and booking_status != "Cancelled":
			return None

		# 1 & 2 — status booking memerintah (Cancel/Complete cascade).
		if booking_status == "Cancelled":
			return "Cancelled"
		if booking_status == "Completed":
			return "Completed"

		# 3 — trip sudah tamat (fallback bila booking takkan jadi Completed).
		# Selari dengan mark_completed_trips (return_date < hari ini) supaya
		# reservation tak lag dari bookingnya; tiada jurang "hari selepas
		# return" yang tergerak balik ke status dokumen.
		if ret and today > getdate(ret):
			return "Completed"

		# 4 — dalam tempoh trip.
		if dep and ret and getdate(dep) <= today <= getdate(ret):
			return "Trip OnProgress"

		# 5 — luput passport < 6 bulan dari departure (peraturan 6 bulan,
		# sama threshold dengan passport_maintenance.cleanup_expired_passport_images).
		tvl_status = frappe.db.get_value("Traveller", self.traveller, "status") if self.traveller else None
		if dep and self.traveller:
			expiry = frappe.db.get_value("Traveller", self.traveller, "passport_expiry")
			if expiry and getdate(expiry) < add_months(getdate(dep), -6):
				return "Document Expired"

		# 5b — Traveller "Open for Update" — dokumen tidak sah sehingga
		# traveller hantar semula (hook harian passport_maintenance membuka
		# semula borang bila passport hampir luput; admin juga boleh set
		# manual melalui dialog Quick Status pakej traveller). Slot
		# reservation traveller sedemikian terus "Document Expired";
		# selepas re-upload status Traveller naik "Pending Verification"
		# → rule #6 bawa balik "Document Completed".
		if tvl_status == "Open for Update":
			return "Document Expired"

		# Sticky: Preparation Complete kekal melainkan peristiwa lebih kuat
		# di atas menangkapnya. Completed/Cancelled dikekalkan juga (terminal)
		# bila tak ada rule yang mengatasi.
		if self.status in self.STICKY_STATUSES or self.status in ("Completed", "Cancelled"):
			return None

		# 6/7 — dokumen Traveller.
		if tvl_status in self.COMPLETED_DOC_STATUSES:
			return "Document Completed"
		return "Waiting Document"

	def apply_auto_status(self):
		"""Kira status auto dan set pada doc semasa save — pencetus utama
		bila reservation itu sendiri disimpan (slot baru, edit admin,
		cancel cascade yang save reservation satu-satu)."""
		new_status = self.compute_auto_status()
		if new_status and new_status != self.status:
			self.status = new_status

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
		  Traveller.status (option luar senarai ditolak —
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
		#
		# IDENTITI BILIK FIZIKAL: room_id eksplisit milik booking lain
		# (penempatan Open Sharing MERENTAS booking — rujuk
		# arrange_group_rooming) bermakna bilik fizikal tetamu ini ialah
		# bilik PEMILIK; sibling sebenar = SEMUA reservation yang membawa
		# room_id yang sama (tetamu booking lain + penghuni asal bilik
		# pemilik), BUKAN booking+cabin_no sendiri — kunci booking+cabin
		# akan tersilak kira penghuni bilik berbeza (bug: "Main Guest
		# exceeds the capacity" untuk perpindahan sah). Tanpa room_id
		# eksplisit: kekal booking+cabin_no (model asal).
		own_ref = self.booking_number
		if not own_ref and self.booking:
			own_ref = frappe.db.get_value("Booking", self.booking, "booking_number")
		own_ref = own_ref or self.booking
		explicit_foreign_room = None
		if self.room_id and "-Room_" in self.room_id:
			owner_ref = self.room_id.split("-Room_")[0]
			if owner_ref != own_ref:
				explicit_foreign_room = self.room_id

		if explicit_foreign_room:
			siblings = frappe.get_all(
				"Booking Reservation",
				filters={
					"room_id": explicit_foreign_room,
					"status":  ["!=", "Cancelled"],
					"name":    ["!=", self.name or ""],
				},
				fields=["pax_type", "room_category"],
			)
		else:
			# Bilik sendiri (booking+cabin). PENGHUNI MERENTAS BOOKING
			# DIKECUALIKAN — reservation yang membawa room_id milik booking
			# LAIN (Open Sharing) bukan penghuni bilik ini walaupun
			# cabin_no-nya kebetulan sama nombor dengan cabin sendiri
			# (cabin_no tetamu cross-booking mengikut cabin PEMILIK bilik,
			# bukan penomboran booking sendiri). Tanpa pengecualian ni,
			# kiraan kapasiti bilik sendiri tersilak masukkannya
			# (bug: "Main Guest exceeds the capacity" untuk save biasa).
			siblings = frappe.db.sql("""
				SELECT pax_type, room_category
				FROM `tabBooking Reservation`
				WHERE booking = %(booking)s
				  AND IFNULL(cabin_no, 0) = %(cabin_no)s
				  AND name != %(name)s
				  AND status != 'Cancelled'
				  AND (
				      room_id IS NULL OR room_id = ''
				      OR SUBSTRING_INDEX(room_id, '-Room_', 1) = %(own_ref)s
				  )
			""", {
				"booking": self.booking,
				"cabin_no": self.cabin_no,
				"name": self.name or "",
				"own_ref": own_ref,
			}, as_dict=True)

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

		# Label bilik fizikal — penempatan merentas booking papar room_id
		# pemilik (lebih tepat daripada "Cabin N" booking sendiri).
		cabin_label = (explicit_foreign_room if explicit_foreign_room
		               else "Cabin " + str(self.cabin_no)) + " (" + str(self.room_category) + ")"

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
		(rekod lama), selari dengan gaya assign_room_id(). PENGHUNI
		MERENTAS BOOKING tidak dikira — tetamu Open Sharing bawa room_id
		bilik booking lain (cabin_no ikut PEMILIK), bukan penghuni cabin
		penomboran booking sendiri.
		"""
		if self.guest_sequence:
			return
		if not (self.booking and self.cabin_no):
			return
		own_ref = self.booking_number
		if not own_ref:
			own_ref = frappe.db.get_value("Booking", self.booking, "booking_number")
		own_ref = own_ref or self.booking
		self.guest_sequence = frappe.db.sql("""
			SELECT COUNT(*)
			FROM `tabBooking Reservation`
			WHERE booking = %(booking)s
			  AND IFNULL(cabin_no, 0) = %(cabin_no)s
			  AND status != 'Cancelled'
			  AND (room_id IS NULL OR room_id = ''
			       OR SUBSTRING_INDEX(room_id, '-Room_', 1) = %(own_ref)s)
		""", {
			"booking": self.booking,
			"cabin_no": self.cabin_no,
			"own_ref": own_ref,
		})[0][0] + 1

	def refresh_related(self):
		"""Update Trip Group Date & Flight yang berkaitan.

		Boleh DITUNDA oleh caller batch — set doc.flags.skip_refresh_related
		= 1 sebelum save supaya N save dalam satu batch tidak menjalankan N
		refresh (arrange_group_rooming melakukannya: refresh_bookings /
		refresh_seats ialah kiraan idempoten, jadi caller menjalankan SATU
		refresh per trip group / flight di hujung batch, dalam transaksi
		yang sama — keputusan akhir seragam tanpa write amplification).
		"""
		if self.flags.get("skip_refresh_related"):
			return
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


# ══════════════════════════════════════════════
# ALIRAN STATUS AUTO — pencetus luar (module-level)
# ══════════════════════════════════════════════

# ── Penanda klasifikasi trip — helper TULEN (tiada akses DB) ──
# Sumber tunggal logik ulang tahun & peraturan 6 bulan; dipakai oleh
# compute_trip_flags() (validate reservation), Traveller.on_update cascade
# (sync_trip_flags_to_reservations), patch backfill v37, dan paparan API
# (api/manage_trip_booking._birthday_in_range melimpahkan ke sini).

def birthday_during_trip(dob, dep, ret) -> bool:
	"""True bila ulang tahun DOB (bulan-hari) jatuh dalam tempoh trip
	dep..ret. Tahun DOB diabaikan — disemak pada tahun departure & return
	(berbeza bila trip melintasi tahun baharu; 29 Feb digulung ke 28)."""
	try:
		d0, a, b = getdate(dob), getdate(dep), getdate(ret)
	except Exception:
		return False
	if not (d0 and a and b) or a > b:
		return False
	for y in {a.year, b.year}:
		try:
			bday = d0.replace(year=y)
		except ValueError:  # 29 Feb pada tahun bukan lompat
			bday = d0.replace(year=y, day=28)
		if a <= bday <= b:
			return True
	return False


def passport_expiring_before_departure(expiry, dep) -> bool:
	"""True bila passport luput KURANG dari 6 bulan dari tarikh departure
	(peraturan validity 6 bulan — termasuk passport yang sudah luput).
	Threshold berbeza dari rule #5 compute_auto_status (expiry < dep-6bln
	= sudah lama luput) — penanda ni lebih luas: apa-apa baki validity
	kurang dari 6 bulan pada hari berlepas ditandakan."""
	if not (expiry and dep):
		return False
	try:
		return getdate(expiry) < add_months(getdate(dep), 6)
	except Exception:
		return False


def recompute_reservation_trip_flags(reservation_name, doc=None):
	"""Kira semula penanda klasifikasi trip SATU reservation tanpa laluan
	save penuh (elak kesan sampingan validate — capacity check,
	refresh_related, dsb). Dipanggil bila DOB / passport_expiry Traveller
	berubah (Traveller.sync_trip_flags_to_reservations) dan oleh jaring
	harian auto_update_reservation_statuses (tangkap perubahan tarikh trip
	yang tak melalui sebarang save dokumen).

	doc (opsyenal) — instance reservation sedia dimuat caller (jaring
	harian); None → muat sendiri. Idempotent — hanya write bila nilai
	berubah."""
	try:
		d = doc or frappe.get_doc("Booking Reservation", reservation_name)
		# Nilai lama mesti dibaca SEBELUM compute_trip_flags() menimpa
		# field pada instance yang sama (d === doc bila caller hantar).
		old_b = d.birthday_on_trip or 0
		old_p = d.passport_to_expire_on_trip or 0
		d.compute_trip_flags()
		updates = {}
		if (d.birthday_on_trip or 0) != old_b:
			updates["birthday_on_trip"] = d.birthday_on_trip
		if (d.passport_to_expire_on_trip or 0) != old_p:
			updates["passport_to_expire_on_trip"] = d.passport_to_expire_on_trip
		if updates:
			frappe.db.set_value("Booking Reservation", reservation_name,
				updates, update_modified=False)
	except Exception:
		frappe.log_error(frappe.get_traceback(),
			"Reservation trip-flags recompute failed: " + str(reservation_name))


def recompute_reservation_status(reservation_name, new_status=None):
	"""Kira semula status SATU reservation tanpa laluan save penuh.

	Dipanggil bila sumber status berubah DI LUAR reservation: status
	Traveller berubah (sync_status_to_reservations), passport dibersihkan
	(cleanup_expired_passport_images), dsb. Guna doc instance ringkas
	(tanpa hooks validate penuh) supaya tiada kesan sampingan lain
	(room_id, guest sequence, refresh_related) terpicu semula.

	new_status (opsyenal) memaksa status tertentu tanpa kiraan — HANYA
	guna untuk peralihan yang sah dari mana-mana status (cth Cancelled
	oleh booking). Ia TIDAK mengatasi perlindungan terminal: reservation
	Completed/Cancelled takkan diketuk.
	"""
	doc = frappe.get_doc("Booking Reservation", reservation_name)
	status = new_status or doc.compute_auto_status()
	if not status:
		return
	# Terminal: Completed/Cancelled hanya bergerak bila booking Cancelled
	# "mengesahkan" Cancelled (compute_auto_status rule #1) — itu pun bila
	# status semasa dah sama, tiada write.
	if doc.status in ("Completed", "Cancelled"):
		return
	if status == doc.status:
		return
	frappe.db.set_value("Booking Reservation", reservation_name,
		"status", status, update_modified=False)


def sync_status_for_booking(booking_name, booking_status=None):
	"""Sebar peralihan status Booking ke SEMUA reservation aktifnya.

	Dipanggil bila Booking masuk 'Completed' (manual Desk/Hub ATAU
	scheduler mark_completed_trips) dan 'Cancelled' (jaringan untuk
	set_value langsung; cancel cascade yang save reservation satu-satu
	lalui validate() sendiri). Reservation terminal (Completed/Cancelled)
	tak diketuk ke belakang — recompute_reservation_status melindungi.

	booking_status (opsyenal) — status booking sedia diketahui caller
	(elak baca DB dua kali; cancel cascade hantar nilai in-memory Booking
	yang belum commit).
	"""
	if not booking_name or not frappe.db.exists("Booking", booking_name):
		return
	if booking_status is None:
		booking_status = frappe.db.get_value("Booking", booking_name, "status")
	if booking_status not in ("Completed", "Cancelled"):
		return
	for name in frappe.get_all("Booking Reservation",
			filters={"booking": booking_name}, pluck="name"):
		try:
			recompute_reservation_status(name, new_status=booking_status)
		except Exception:
			frappe.log_error(frappe.get_traceback(),
				"Reservation status sync failed: " + str(name))


def auto_update_reservation_statuses():
	"""Scheduled task (harian, hooks.py scheduler_events) — jaring keselamatan
	aliran status reservation: tangkap peralihan TARIKH yang tak melibatkan
	sebarang save dokumen (masuk tetingkap trip → Trip OnProgress, return
	dah lepas → Completed, luput passport menjelang departure → Document
	Expired) dan booking yang bertukar Completed/Cancelled tanpa melalui
	laluan berhook. Turut menyegarkan penanda klasifikasi trip
	(birthday_on_trip / passport_to_expire_on_trip) — tarikh trip yang
	diubah pada Trip Group Date tak memicu save reservation.
	Idempotent — rekod yang dah tepat dikira semula tanpa write.

	Pulangkan ringkasan {checked, changed} untuk log scheduler.
	"""
	names = frappe.get_all("Booking Reservation", pluck="name")
	changed = 0
	for name in names:
		try:
			doc = frappe.get_doc("Booking Reservation", name)
			before = doc.status
			new_status = doc.compute_auto_status()
			if new_status and new_status != doc.status:
				frappe.db.set_value("Booking Reservation", name,
					"status", new_status, update_modified=False)
				changed += 1
			# Penanda trip — same doc instance (tiada get_doc kedua).
			recompute_reservation_trip_flags(name, doc=doc)
		except Exception:
			frappe.log_error(frappe.get_traceback(),
				"Reservation auto-status failed: " + str(name))
	if changed:
		frappe.db.commit()
	return {"checked": len(names), "changed": changed}