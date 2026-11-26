app_name = "travel_booking"
app_title = "Travel Booking Management"
app_publisher = "WargaPrihatin"
app_description = "Manage Traveller Booking Information"
app_email = "contact@rpwp.my"
app_license = "mit"

# Apps (desktop) screen + dock rail (v17 UI).
# add_to_apps_screen: tile di apps screen — tanpa ni app tak muncul langsung
# di desktop (lihat frappe.boot.get_app_data). route = Travel Manager —
# direktori 1st-layer (app bar + breadcrumb). Booking Management kini VIEW
# PENUH dalam page travel-manager (route 'booking' — v68, dipindah
# daripada page berasingan yang dahulu menggantikan manage-booking-app
# DEPREKAT). Icon dock pula datang dari
# dock/travel_booking/travel_booking.json (Dock standard, di-import oleh
# migrate) — bukan lagi fixture Desktop Icon lama.
app_home = "/desk/travel-manager"

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
# merentas section desk — kini tab Bookings view Booking Management
# (travel-manager/booking, v68) & section booking travel_manager;
# section lain kelak cukup panggil create() pada container masing-masing.
#
# ?v= — nginx hantar /assets dengan Cache-Control max-age=1 TAHUN, jadi
# pelayar pengguna tidak akan ambil salinan baharu selepas bench build
# sehingga URL berubah. SETIAP kali fail ini dibina semula, NAIKKAN nilai
# ?v= (timestamp cukup) supaya semua klien fetch versi terkini.
app_include_js = [
	"/assets/travel_booking/js/search_box.js?v=20261026-1",
	"/assets/travel_booking/js/booking_list.js?v=20261125-1",
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

# MONKEYPATCH create_contact (retry deadlock MariaDB error 1020) —
# diaktifkan LAZILY dari kod penggunaan: booking_engine._ensure_portal_user()
# dan so_helpers._create_customer() memanggil patch_create_contact.apply().
#
# JANGAN guna hook "app_init" untuk ni — hook itu TIDAK WUJUD dalam
# Frappe (tiada call site di core); konfigurasi lama di sini senyap mati
# dan patch tidak pernah diload (bug P1/H6). apply() idempotent — selamat
# dipanggil dalam setiap proses (web & rq worker).


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

# Kanak-kanak & dokumen berpaut yang PASTI dibersihkan semasa Booking
# dipadam — jangan biarkan mereka menyekat pemadaman Booking (link check
# berjalan SEBELUM on_trash):
#   - Booking Item / Booking Sales Order: child table Booking (cascade)
#   - Booking Reservation / Voucher Usage: dipadam eksplisit dalam
#     Booking.on_trash
# Yang TIDAK disenarai (Booking Addon, Affiliate Commission, Booking
# Cancellation Request, dsb.) KEKAL menyekat — aliran admin
# (_delete_booking_linked_docs / bulk_delete_bookings) yang membersihkannya
# supaya tiada rekod yatim.
ignore_links_on_delete = [
	"Booking Item",
	"Booking Sales Order",
	"Booking Reservation",
	"Voucher Usage",
]

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
	# SO ialah sumber kebenaran harga booking (registri
	# Booking.sales_orders — [Nov 2026] menggantikan SO.custom_booking).
	# Setiap perubahan SO — edit item pax/rate di Desk (draft mahupun
	# update-after-submit), diskaun tambahan, cancel, atau delete — mesti
	# disegerak balik ke field snapshot Booking (pre_discount_total,
	# payment_status, prog_payment, booked_pax) supaya paparan Booking
	# (dan gate overbooking SUM(booked_pax)) tak stale.
	# on_update berjalan juga semasa insert (SO addon dicipta lepas booking
	# wujud) — agregat booking terus berkembang ikut SO addon.
	# on_trash ada handler berasingan — selain recompute snapshot, ia juga
	# MEMBUANG baris registri Booking.sales_orders bagi SO dipadam (elak
	# link yatim pada child table).
	"Sales Order": {
		"on_update": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_update_after_submit": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_cancel": "travel_booking.api.booking_engine.on_sales_order_change",
		"on_trash": "travel_booking.api.booking_engine.on_sales_order_trash",
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
	# on_update berjalan selepas insert & setiap save.
	# [BUANG Nov 2026] sync_cruise_only_group_date — schedule tidak lagi
	# sync ke Trip Group Date (struktur lama); pautan baharu ialah
	# Travel Date.cruise_schedule. Tinggal recompute_cabin_availability:
	# normalisasi occupancy & availability SEMUA kelas cabin_rates bila
	# schedule disimpan (admin tambah/ganti baris → nilai terus selari
	# dengan reservasi sebenar).
	"Trip Cruise Schedule": {
		"on_update": [
			"travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.recompute_cabin_availability",
		],
	},
	# Optimisasi imej PUBLIC yang di-upload (galeri web, cover, day image,
	# meta OG) — resize max 1920px + mampat semula (utils/image_optimize.py).
	# Fail private (passport, resit, dokumen) TIDAK disentuh. after_insert
	# cukup — setiap upload/ganti fail = rekod File baharu.
	"File": {
		"after_insert": "travel_booking.utils.image_optimize.optimize_public_image",
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
		# Fasa A (G2): tamatkan tempahan 'Held Booking' (Pay Later) yang
		# lepas Booking.hold_expires_on — cancel penuh (cascade SO/PR
		# melalui on_booking_update) + pulangkan kuota Offer Inventory
		# melalui snapshot. Had 0 jam (Travel Settings) = dimatikan.
		"travel_booking.api.booking_engine.expire_held_bookings",
		# Fasa A (G4): emel peringatan bayaran baki T-30/T-7/T-1 sebelum
		# due date baris 'Balance Payment' pada SO payment_schedule.
		# Gate: Travel Settings.enable_payment_reminders (dedup log pada
		# Booking.payment_reminders_sent).
		"travel_booking.api.booking_engine.send_payment_schedule_reminders",
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
		# Setiap hari 00:20 (site time) — SENGAJA di-stagger 20 minit selepas
		# blok "daily" (yang laku tepat 00:00) supaya beban job malam tak
		# bercampur di satu titik (P2/W4). Semak & update status Trip Group
		# Date (Running / Completed / Closed / Full ikut tarikh & kapasiti).
		# Rujuk auto_update_trip_group_statuses().
		"20 0 * * *": [
				"travel_booking.module_travel_booking.doctype.trip_group_date.trip_group_date.auto_update_trip_group_statuses",
				"travel_booking.module_travel_booking.doctype.trip_cruise_schedule.trip_cruise_schedule.auto_update_cruise_schedule_statuses",
			],
		# 00:40 — paksi OPERASIONAL Package Offer (F4): Scheduled/Running/
		# Sailing/Full/Closed/Completed ikut tarikh & occupancy. Struktur
		# baharu — TGD lama kekal di-job 00:20 sehingga cutover penuh (F5).
		"40 0 * * *": [
				"travel_booking.module_trip_management.doctype.package_offer.package_offer.auto_update_offer_statuses",
			],
	},
}


# Automatically update python type annotations for this app
export_python_type_annotations = True

# Require all whitelisted methods to have type annotations
require_type_annotated_api_methods = True

# NOTA (P2/W4): blok hook "pages" DIBUANG — "pages" bukan hook Frappe
# (tiada get_hooks("pages") di core); pendaftaran page sebenar datang
# daripada sync fail page/*.json per module. Entri lama juga STALE:
# booking-hub & dashboard-reports tiada page JSON langsung, dan
# trip-command-center kini DIDEFINISIKAN sekali sahaja di
# module_admin_portal/page/trip_command_center/ (duplikasi lama di
# module_travel_booking telah dipadam).