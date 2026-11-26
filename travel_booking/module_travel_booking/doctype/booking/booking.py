# Copyright (c) 2026, WargaPrihatin and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class Booking(Document):
	# begin: auto-generated types
	# This code is auto-generated. Do not modify anything in this block.

	from typing import TYPE_CHECKING

	if TYPE_CHECKING:
		from frappe.types import DF
		from travel_booking.module_travel_booking.doctype.booking_item.booking_item import BookingItem
		from travel_booking.module_travel_booking.doctype.booking_sales_order.booking_sales_order import BookingSalesOrder

		affiliate: DF.Link | None
		applied_price_rules: DF.JSON | None
		b2b_partner: DF.Link | None
		balance_amount: DF.Currency
		booked_by: DF.Link | None
		booked_pax: DF.Int
		booking_channel: DF.Literal["Direct", "Staff", "Affiliate", "B2B"]
		booking_number: DF.Data
		checkout_method: DF.Literal["", "Online Payment Gateway", "Manual Transfer", "Held Booking"]
		company: DF.Link | None
		cruise_end: DF.Date | None
		cruise_start: DF.Date | None
		currency: DF.Data | None
		cust_address_line1: DF.Data | None
		cust_city: DF.Data | None
		cust_country: DF.Link | None
		cust_email: DF.Data | None
		cust_postcode: DF.Data | None
		cust_state: DF.Data | None
		customer: DF.Link | None
		customer_message: DF.SmallText | None
		departure_date: DF.Date | None
		end_customer: DF.Link | None
		get_cust_booking_phone: DF.Phone | None
		hold_expires_on: DF.Datetime | None
		is_a_cruise_trip: DF.Check
		is_cruise_only: DF.Check
		items: DF.Table[BookingItem]
		naming_series: DF.Literal["BK.YY.MM.###"]
		package_offer: DF.Link | None
		package_type: DF.ReadOnly | None
		paid_amount: DF.Currency
		payment_due_amount: DF.Currency
		payment_reminders_sent: DF.JSON | None
		payment_status: DF.Literal["Pending", "Partially Paid", "Paid", "Request Refund", "Pending Refund", "Refunded", "Canceled"]
		pre_discount_total: DF.Currency
		price_rule_discount: DF.Currency
		prog_payment: DF.Percent
		referral_code_used: DF.Data | None
		referral_discount: DF.Currency
		return_date: DF.Date | None
		sales_orders: DF.Table[BookingSalesOrder]
		status: DF.Literal["Pending", "Accepted", "Processing", "Confirmed", "Completed", "Abandoned", "Cancelled"]
		terms_accepted: DF.Check
		terms_accepted_at: DF.Datetime | None
		terms_reference: DF.Link | None
		total_amount: DF.Currency
		total_days: DF.ReadOnly | None
		total_night: DF.ReadOnly | None
		trip_date: DF.Link | None
		trip_name: DF.ReadOnly | None
		trip_package: DF.Link | None
		trip_title: DF.ReadOnly | None
		voucher: DF.Link | None
		voucher_discount: DF.Currency
	# end: auto-generated types

	_DOCTYPE_NAME = "Booking"

	# Status bayaran yang menjejak proses refund — dikekalkan walaupun
	# booking telah dibatalkan (maklumat refund lebih spesifik daripada
	# label 'Canceled'). Cermin _REFUND_PAYMENT_STATES (booking_engine).
	REFUND_PAYMENT_STATES = ("Request Refund", "Pending Refund", "Refunded")

	def validate(self):
		# Payment status AUTO — syarat 4: booking Cancelled/Abandoned →
		# 'Canceled' (kecuali aliran refund sedang berjalan — status itu
		# lebih spesifik dan dikekalkan). Syarat 1-3 (Pending / Partially
		# Paid / Paid) dikira daripada agregat SO melalui
		# _recompute_booking_status() (hook Payment Entry / Sales Order) —
		# validate ini melindungi kes mana-mana laluan simpan lain (edit
		# Desk, bulk edit, update status) supaya label Canceled sentiasa
		# konsisten bila status booking bertukar.
		if self.status in ("Cancelled", "Abandoned") and (
				self.payment_status or "Pending") not in self.REFUND_PAYMENT_STATES:
			self.payment_status = "Canceled"

	
	@property
	def get_cust_phone(self):
		"""Phone customer TERKINI — dikira on-the-fly dari Customer (link
		field 'customer' di atas) -> Contact (melalui Dynamic Link), BUKAN
		snapshot yang disimpan semasa booking dicipta. Kalau customer
		update phone mereka kemudian (cth via portal), field ni terus
		ikut nilai TERKINI — elak data 'stale'/tak segerak dengan Contact
		sebenar. Guna get_customer_phone() (_helpers.py) — sumber
		kebenaran YANG SAMA dipakai send_otp() untuk auto-fill wizard.

		PENTING: nama property ialah 'get_cust_phone' — BERBEZA dari field
		snapshot 'get_cust_booking_phone' (Phone) yang ditulis SEKALI semasa
		booking dicipta (salinan sejarah, sama corak dengan cust_email).
		Property ni pula sentiasa live; guna field snapshot bila nilai
		masa booking diperlukan.
		"""
		from travel_booking.api._helpers import get_customer_phone
		if not self.customer:
			return ""
		return get_customer_phone(self.customer) or ""

	@property
	def currency(self):
		"""Currency SO UTAMA booking ni (cabin booking asal), untuk field
		'Currency' fieldtype lain (total_amount/balance_amount/
		pre_discount_total) papar symbol yang BETUL di Desk (bukan default
		currency asas company/MYR — rujuk 'options' field-field tu di
		booking.json, semua rujuk 'currency' ni).

		NOTA model multi-currency baharu: SO ADDON kini BOLEH dalam
		currency berbeza dari SO utama (customer bebas pilih rate currency
		addon) — setiap SO tetap dipegang company yang sepadan dengan
		currency-nya. total_amount/balance_amount menjumlah grand_total
		NATIVE setiap SO; bila ada SO addon dalam currency lain, jumlah
		tersebut bercampur currency — lihat detail per-SO di portal/billing
		untuk angka tepat. Fallback MYR kalau tiada SO lagi.
		"""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		from travel_booking.api.currency_axis import get_default_currency
		for so_name in _get_all_booking_sales_orders(self.name):
			so_currency = frappe.db.get_value("Sales Order", so_name, "currency")
			if so_currency:
				return so_currency
		return get_default_currency()

	@property
	def total_amount(self):
		"""Jumlah keseluruhan (SEMUA SO — utama + addon) berkaitan booking ni.

		NOTA: "Disable Rounded Total" kini dihidupkan SECARA GLOBAL di
		Selling Settings — semua SO (wizard mahupun addon manual di Desk)
		tak lagi guna rounded_total, jadi kita standardize terus ke
		grand_total sahaja (tak perlu fallback rounded_total or grand_total
		lagi merentasi seluruh app).
		"""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			so = frappe.db.get_value("Sales Order", so_name, "grand_total")
			total += float(so or 0)
		return total

	@property
	def balance_amount(self):
		"""Baki tertunggak (SEMUA SO — utama + addon) berkaitan booking ni.
		Rujuk nota "Disable Rounded Total" di total_amount().
		"""
		from travel_booking.api.booking import _get_all_booking_sales_orders
		total = 0
		paid  = 0
		for so_name in _get_all_booking_sales_orders(self.name):
			so = frappe.db.get_value("Sales Order", so_name, ["grand_total", "advance_paid"], as_dict=True)
			if so:
				total += float(so.grand_total or 0)
				paid  += so.advance_paid or 0
		return max(0, total - paid)

	@property
	def order_summary(self):
		"""Apa yang customer beli — SO UTAMA sahaja (cabin booking asal),
		BUKAN addon (excursion dll dipaparkan berasingan sebagai 'Add-ons').

		Format cermin 'Payment Summary' pada wizard booking (booking.js:
		buildOrderSummary()/buildStep1Summary()) — dikumpul ikut CABIN,
		dengan 'Cabin Fare' (jumlah) + pecahan 'Guest N: [label] — RM x'
		setiap orang, bukan sekadar senarai rata 'item_name x qty'
		seperti sebelum ini. Guest numbering reset setiap cabin baharu,
		sama pattern dengan wizard.

		FASA 0 (booking-centric): sumber utama ialah baris Booking Item
		(per traveller, SO utama sahaja) — fallback ke parse item_name SO
		untuk booking lama pra-backfill / SO manual admin.
		"""
		from travel_booking.api.booking import _get_primary_so
		primary_so = _get_primary_so(self.name)
		if not primary_so:
			return ""

		# MULTI-CURRENCY: symbol currency SO ni sendiri (rujuk dokumen
		# reka bentuk multi-currency) — SENGAJA baca dari doctype Currency
		# ERPNext (bukan hardcode "RM"), supaya order_summary papar betul
		# tak kira currency SO (MYR/SGD/BND/dsb).
		so_currency = frappe.db.get_value("Sales Order", primary_so, "currency") or "MYR"
		symbol = frappe.db.get_value("Currency", so_currency, "symbol") or so_currency

		cabins         = []
		cabin_map      = {}
		discount_lines = []

		def _cabin(label):
			if label not in cabin_map:
				cabin_map[label] = {"label": label, "fare": 0.0, "lines": []}
				cabins.append(cabin_map[label])
			return cabin_map[label]

		# ── Laluan utama: Booking Item (per traveller) ──
		bi = frappe.get_all("Booking Item",
							filters={"booking": self.name,
									 "sales_order": primary_so,
									 "status": ["!=", "Cancelled"]},
							fields=["room_category", "cabin_no", "pax_type",
									"rate_basis", "unit_price"],
							order_by="idx")
		if bi:
			for it in bi:
				# Label kad = format item_name SO ("Room Category (Cabin N)")
				# dan label pax cermin SO ("Main Guest (Single)") supaya
				# paparan KEKAL IDENTIK dengan laluan legacy di bawah.
				label = (it.room_category or "") + " (Cabin " + str(it.cabin_no or 0) + ")"
				pax_type = it.pax_type or ""
				if (it.rate_basis or "Standard") == "Single":
					pax_type = pax_type + " (Single)"
				cab = _cabin(label)
				rate = float(it.unit_price or 0)
				cab["fare"] += rate
				cab["lines"].append((pax_type, rate))
			# Baris diskaun legacy (rate negatif, pra-model PE deduction)
			# kekal dipaparkan supaya pariti dengan laluan legacy — Booking
			# Item sengaja tak menyimpan baris bukan-traveller.
			for it in frappe.db.get_all("Sales Order Item",
										filters={"parent": primary_so, "rate": ["<", 0]},
										fields=["item_name", "rate"], order_by="idx"):
				discount_lines.append((it.item_name or "", float(it.rate or 0)))
		else:
			# ── Fallback legacy: parse item_name SO utama ──
			items = frappe.db.get_all("Sales Order Item",
										filters={"parent": primary_so},
										fields=["item_name", "qty", "rate"], order_by="idx")
			if not items:
				return ""

			for it in items:
				name = it.item_name or ""
				rate = float(it.rate or 0)

				if rate < 0:
					discount_lines.append((name, rate))
					continue

				if "\u2014" in name:
					cabin_label, pax_type = name.split("\u2014", 1)
					cabin_label = cabin_label.strip()
					pax_type    = pax_type.strip()
				else:
					cabin_label, pax_type = name, ""

				cab = _cabin(cabin_label)
				qty = int(it.qty or 0)
				cab["fare"] += qty * rate
				for _ in range(qty):
					cab["lines"].append((pax_type, rate))

		out = []
		for c in cabins:
			out.append(c["label"])
			out.append("  Cabin Fare: {} {:,.2f}".format(symbol, c["fare"]))
			for i, (pax_type, rate) in enumerate(c["lines"], start=1):
				out.append("  Guest {}: {} \u2014 {} {:,.2f}".format(i, pax_type, symbol, rate))
			out.append("")  # baris kosong antara cabin, macam kad berasingan di wizard

		if discount_lines:
			for name, rate in discount_lines:
				out.append("{}: {} {:,.2f}".format(name, symbol, rate))
			out.append("")

		return "\n".join(out).rstrip()

	@property
	def total_pax(self):
		# Pax aktif = SEMUA reservation kecuali Cancelled (Waiting Document
		# masih tetamu yang datang — hanya pembatalan yang mengeluarkan pax).
		return frappe.db.count("Booking Reservation", {
			"booking": self.name, "status": ["!=", "Cancelled"]})

	@property
	def verified_pax(self):
		return frappe.db.count("Booking Reservation", {
			"booking": self.name, "status": ["!=", "Cancelled"],
			"document_status": "Verified"})

	@property
	def pending_pax(self):
		return frappe.db.count("Booking Reservation", {
			"booking": self.name, "status": ["!=", "Cancelled"],
			"document_status": "Incomplete"})

	def on_trash(self):
		"""Padam Booking Reservations berkaitan bila Booking dipadam — elak data yatim.

		CONSISTENCY FIX (P1/H5): dulu frappe.db.delete() pukal — hook
		after_delete reservation (sync_cabin_availability) dan on_trash
		(refresh_related) TIDAK terpicak, meninggalkan Trip Group Date
		current_participants, Flight.seats_occupied & occupancy kabin stale
		sampai reservation tak berkaitan berubah lain. Delete satu-per-satu
		supaya SEMUA hook dokumen berjalan.
		"""
		for res_name in frappe.get_all("Booking Reservation", {"booking": self.name}, pluck="name"):
			frappe.delete_doc("Booking Reservation", res_name, ignore_permissions=True)

		# Padam Voucher Usage records (release voucher)
		for vu in frappe.get_all("Voucher Usage", {"booking": self.name}, pluck="name"):
			try:
				frappe.delete_doc("Voucher Usage", vu, ignore_permissions=True)
			except Exception:
				# Jangan senyap (dulu except: pass) — kegagalan release
				# voucher bermakna kuota voucher tersadai kekal terpakai.
				# Log untuk tindakan admin, jangan gagalkan trash booking.
				frappe.log_error(
					frappe.get_traceback(),
					"Booking.on_trash: Voucher Usage delete failed",
				)