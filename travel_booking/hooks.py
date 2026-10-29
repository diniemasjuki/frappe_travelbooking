app_name = "travel_booking"
app_title = "Travel Booking Management"
app_publisher = "WargaPrihatin"
app_description = "Manage Traveller Booking Information"
app_email = "contact@rpwp.my"
app_license = "mit"

# Apps (desktop) screen + dock rail (v17 UI).
# add_to_apps_screen: tile di apps screen — tanpa ni app tak muncul langsung
# di desktop (lihat frappe.boot.get_app_data). route = workspace "Travel Booking".
# Icon dock pula datang dari dock/travel_booking/travel_booking.json (Dock
# standard, di-import oleh migrate) — bukan lagi fixture Desktop Icon lama.
app_home = "/desk/manage-booking-app"

add_to_apps_screen = [
	{
		"name": "travel_booking",
		"logo": "/assets/travel_booking/img/logo-icon.png",
		"title": "Travel Booking",
		"route": app_home,
		"sequence_id": 3,
	}
]

# Send non-GET requests for this app's endpoints as native `application/json`
# bodies instead of form-encoded, per-key JSON-stringified values.
use_json_request_body = True

# Desk assets — paket generik senarai booking (window.TravelBookingBookingList):
# satu komponen drop-in (data + toolbar + render + event) yang diguna semula
# merentas section desk — kini tab Booking page Manage Booking App &
# Manage Booking Group; section lain kelak cukup panggil create() pada
# container masing-masing.
#
# ?v= — nginx hantar /assets dengan Cache-Control max-age=1 TAHUN, jadi
# pelayar pengguna tidak akan ambil salinan baharu selepas bench build
# sehingga URL berubah. SETIAP kali fail ini dibina semula, NAIKKAN nilai
# ?v= (timestamp cukup) supaya semua klien fetch versi terkini.
app_include_js = [
	"/assets/travel_booking/js/search_box.js?v=20261026-1",
	"/assets/travel_booking/js/booking_list.js?v=20261028-2",
]
app_include_css = [
	"/assets/travel_booking/css/search_box.css?v=20261026-1",
	"/assets/travel_booking/css/booking_list.css?v=20261024-2",
]

# Fix realtime has_permission untuk dokumen belum disimpan (room
# `new-<doctype>-...`) — dipindahkan daripada modifikasi frappe core
# (frappe/realtime/__init__.py, telah direvert; lihat api/realtime.py).
override_whitelisted_methods = {
	"frappe.realtime.has_permission": "travel_booking.api.realtime.has_permission",
}

# Patches (run once at app init, before any request handling)
app_init = "travel_booking.patches.patch_create_contact.apply"


# Jinja
# ----------

# asset_v(relpath) — token versi (mtime) untuk cache-busting JS/CSS portal:
#   ?v={{ asset_v('js/portal_billing.js') }}
# nginx cache assets setahun (max-age=31536000) — tanpa ni, perubahan JS
# tak sampai ke browser customer selepas deploy.
jinja = {
	"methods": ["travel_booking.utils.assets", "travel_booking.utils.website_config"],
}

# Installation
# ------------

# before_install sahkan ERPNext sedia ada sebelum travel_booking dipasang.
# after_install cipta rekod-rekod lalai yang app bergantung untuk berfungsi
# penuh (Travel Settings, Item TRAVEL-PKG, Email Templates, Print Format).
before_install = "travel_booking.install.before_install"
after_install = "travel_booking.install.after_install"

# Document Events
# ---------------
# Hook on document methods and events
#
# Rujuk terus ke booking_engine.py (bukan booking.py re-export layer) untuk
# elak overhead import modul yang tak diperlukan setiap kali hook berjalan.

doc_events = {
	"Payment Entry": {
		"on_submit": "travel_booking.api.booking_engine.on_payment_entry_submit",
		"on_cancel": "travel_booking.api.booking_engine.on_payment_entry_cancel",
	},
	"Booking": {
		"on_update": [
			"travel_booking.api.booking_engine.on_booking_update",
			# Billing address: cust_* Booking diedit → tulis balik ke
			# Address 'Billing' Customer (invois seterusnya ikut nilai itu).
			"travel_booking.api.billing_address_sync.on_booking_billing_address_update",
		],
	},
	# Billing address: Address 'Billing' Customer berubah → sebar ke medan
	# cust_* semua booking aktif customer itu (supaya export dari Booking
	# sentiasa sepadan dengan alamat yang dipakai invois). Invois yang dah
	# submit tidak disentuh.
	"Address": {
		"on_update": "travel_booking.api.billing_address_sync.on_billing_address_update",
	},
	# SO ialah sumber kebenaran harga booking (custom_booking → Booking).
	# Setiap perubahan SO — edit item pax/rate di Desk (draft mahupun
	# update-after-submit), diskaun tambahan, cancel, atau delete — mesti
	# disegerak balik ke field snapshot Booking (pre_discount_total,
	# payment_status, prog_payment, booked_pax) supaya paparan Booking
	# (dan gate overbooking SUM(booked_pax)) tak stale.
	# on_update berjalan juga semasa insert (SO addon dicipta lepas booking
	# wujud) — agregat booking terus berkembang ikut SO addon.
	"Sales Order": {
		"on_update": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_update_after_submit": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_cancel": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_trash": "travel_booking.api.booking_engine.on_sales_order_change",
	},
	# Sync occupancy & availability kabin pada Trip Cruise Schedule setiap
	# kali reservasi berubah. Pemetaan: reservation.trip_cruise_schedule +
	# reservation.room_category → baris cabin_rates (Trip Package Price)
	# dengan pricing_for_class yang sama. after_delete (bukan on_trash)
	# sebab baris dah didelete dari DB masa hook itu jadi — kiraan tak
	# termasuk rekod yang sedang dipadam.
	"Booking Reservation": {
		"after_insert": "travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.sync_cabin_availability",
		"on_update": "travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.sync_cabin_availability",
		"after_delete": "travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.sync_cabin_availability",
	},
	# on_update berjalan selepas insert & setiap save — sync Trip Group
	# Date "Cruise Only" dengan schedule: update group date sedia ada,
	# atau cipta baru jika belum ada (trip linked mesti wujud).
	# recompute_cabin_availability: normalisasi occupancy & availability
	# SEMUA kelas cabin_rates bila schedule disimpan (admin tambah/ganti
	# baris → nilai terus selari dengan reservasi sebenar).
	"Trip Cruise Schedule": {
		"on_update": [
			"travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.sync_cruise_only_group_date",
			"travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.recompute_cabin_availability",
		],
	},
}

# Scheduled Tasks
# ---------------

scheduler_events = {
	"daily": [
		"travel_booking.api.booking_engine.mark_completed_trips",
		# Auto-Abandoned: booking 'Pending' (tiada bayaran) yang melebihi had
		# hari di Travel Settings (pending_abandoned_days) ditukar ke
		# 'Abandoned'. Had 0 = ciri dimatikan (rujuk mark_abandoned_pending_bookings).
		"travel_booking.api.booking_engine.mark_abandoned_pending_bookings",
		# Jaring SO booking fully-paid yang tertinggal Sales Invoice (auto-
		# invois hook Payment Entry hanya dicuba SEKALI semasa submit — tanpa
		# jaringan ni satu kegagalan = invois hilang selamanya).
		"travel_booking.api.booking_engine.reconcile_missing_invoices",
		# Passport <6 bulan dari tamat tempoh (peraturan 6-bulan) → padam
		# imej/attachment passport & status Traveller 'Open for Update'
		# supaya customer hantar dokumen baharu (PII lama tidak disimpan).
		"travel_booking.api.passport_maintenance.cleanup_expired_passport_images",
		# Jaring keselamatan aliran status Booking Reservation: peralihan
		# tarikh (Trip OnProgress, 24-jam Completed, Document Expired
		# menjelang departure) tak melibatkan sebarang save dokumen —
		# hook ni kira semula status semua reservation setiap hari.
		"travel_booking.module_travel_booking.doctype.booking_reservation.booking_reservation.auto_update_reservation_statuses",
	],
	"cron": {
		# Setiap hari jam 12:00 malam (site time) — semak & update status
		# Trip Group Date (Running / Completed / Closed / Full ikut tarikh
		# & kapasiti). Rujuk auto_update_trip_group_statuses().
		"0 0 * * *": [
				"travel_booking.module_travel_booking.doctype.trip_group_date.trip_group_date.auto_update_trip_group_statuses",
				"travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.auto_update_cruise_schedule_statuses",
			],
	},
}


# Automatically update python type annotations for this app
export_python_type_annotations = True

# Require all whitelisted methods to have type annotations
require_type_annotated_api_methods = True

# Pages
# ------
# Frappe pages yang boleh diakses melalui /app/<page-name>

pages = [
	{
		'name': 'ongoing-today',
		'label': 'Ongoing Today',
		'icon': 'clock',
		'roles': ['System Manager', 'Tour Manager', 'Tour Operator', 'Accounts User'],
		'script': 'module_travel_booking.page.ongoing_today.ongoing_today',
	},
	{
		'name': 'trip-command-center',
		'label': 'Trip Command Center',
		'icon': 'plane',
		'roles': ['Tour Manager', 'Tour Operator'],
		'script': 'module_travel_booking.page.trip_command_center.trip_command_center',
	},
	{
		'name': 'booking-hub',
		'label': 'Booking Operations Hub',
		'icon': 'briefcase',
		'roles': ['Tour Manager', 'Tour Operator'],
		'script': 'module_travel_booking.page.booking_hub.booking_hub',
	},
	{
		'name': 'dashboard-reports',
		'label': 'Dashboard & Reports',
		'icon': 'chart',
		'roles': ['Tour Manager', 'Tour Operator'],
		'script': 'module_travel_booking.page.dashboard_reports.dashboard_reports',
	},
	{
			'name': 'travel-resources',
			'label': 'Travel Resources',
			'icon': 'users',
			'roles': ['Tour Manager', 'Tour Operator'],
			'script': 'resources_management.page.travel_resources.travel_resources',
		},
]