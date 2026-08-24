# travel_booking/install.py
#
# before_install — Frappe panggil ni SEBELUM travel_booking dipasang ke site.
# after_install  — Frappe panggil ni SELEPAS travel_booking dipasang.
#
# Kedua-duanya idempotent (selamat dipanggil berulang — cth semama `bench
# --site xxx migrate` selepas upgrade Frappe/ERPNext). Setiap langkah
# semak kewujudan rekod dulu sebelum cipta, jadi tak akan duplikat.
#
# PENTING: TIDAK ubah/migrate mana-mana DocType JSON di sini — install hook
# cuma cipta DATA lalai (rekod-rekod individual) yang app bergantung untuk
# berfungsi penuh, BUKAN perubahan schema.

import frappe


def before_install():
	"""Sahkan ERPNext sedia ada sebelum travel_booking dipasang.

	travel_booking bergantung penuh kepada ERPNext — Customer, Sales Order,
	Payment Entry, Sales Invoice, Item, Currency Exchange, Price List, dsb.

	GUNA frappe.get_installed_apps() — BUKAN frappe.db.exists("Installed
	Application", ...) — sebab query DB terus ke Installed Application
	boleh pulangkan False palsu semasa konteks install (timing/naming
	berbeza merentasi versi Frappe), walhal ERPNext memang dah dipasang.
	frappe.get_installed_apps() baca dari cache/session yang dah stabil.

	NOTA: required_apps = ["erpnext"] dalam hooks.py dah enforce check ni
	di peringkat framework Frappe. before_install ni cuma fallback tambahan
	untuk mesej yang lebih jelas kalau somehow check framework lepas.
	"""
	if "erpnext" not in frappe.get_installed_apps():
		frappe.throw(
			"ERPNext must be installed before installing Travel Booking. "
			"Please run: bench --site <site> install-app erpnext"
		)


def after_install():
	"""Cipta rekod-rekod lalai yang travel_booking bergantung untuk berfungsi.

	Semua langkah idempotent — selamat dipanggil berulang (migrate/upgrade)
	tanpa cipta duplikat. Tidak sentuh schema DocType langsung.
	"""
	_create_customer_portal_role()
	_create_travel_item()
	_create_default_travel_settings()
	_create_default_travel_website()
	_create_email_templates()
	_create_print_format()


# ══════════════════════════════════════════════
# 1. ROLE — "Customer" (portal)
# ══════════════════════════════════════════════

def _create_customer_portal_role():
	"""Role untuk pengguna portal (Website User) yang buat booking.
	Role ni di-assign kepada setiap User yang dicipta oleh
	_ensure_portal_user() dalam booking_engine.py.
	"""
	if frappe.db.exists("Role", "Customer"):
		return

	role = frappe.get_doc({
		"doctype":           "Role",
		"role_name":         "Customer",
		"home_page":         "/traveller_portal",
		"desk_access":       0,  # portal-only — tiada akses Desk
		"disabled":          0,
	})
	role.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 2. ITEM — "TRAVEL-PKG"
# ══════════════════════════════════════════════

def _create_travel_item():
	"""Item service "TRAVEL-PKG" yang guna untuk SEMUA baris Sales Order
	booking (pax dari semua jenis — Main Guest/Extra Bed/Infant/Voucher/
	Referral — kongsi item yang sama, rate berbeza per baris).

	Ini sama dengan _get_or_create_travel_item() di so_helpers.py — cipta di
	sini sekali gus semasa install supaya SO pertama tak perlu cipta on-the-
	fly (lebih bersih untuk audit awal).
	"""
	from travel_booking.api.constants import TRAVEL_ITEM_CODE

	if frappe.db.exists("Item", TRAVEL_ITEM_CODE):
		return

	frappe.get_doc({
		"doctype":                       "Item",
		"item_code":                     TRAVEL_ITEM_CODE,
		"item_name":                     "Travel Package",
		"item_group":                    "Services",
		"stock_uom":                     "Nos",
		"is_stock_item":                 0,
		"is_sales_item":                 1,
		"include_item_in_manufacturing": 0,
	}).insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 3. TRAVEL SETTINGS — lalai
# ══════════════════════════════════════════════

def _create_default_travel_settings():
	"""Travel Settings adalah Single doctype (satu rekod sahaja). Cipta
	rekod kosong lalai supaya admin boleh terus buka & konfigurasi di
	Desk tanpa crash (beberapa field dibaca oleh app guna getattr()
	dengan fallback, jadi rekod kosong masih selamat).
	"""
	if frappe.db.exists("Travel Settings", "Travel Settings"):
		return

	settings = frappe.get_doc({
		"doctype":                   "Travel Settings",
		# Lalai-lalai yang paling selamat/umum:
		"default_deposit_percent":   20,
		"otp_expiry_minutes":        10,
		"email_verified_session_minutes": 30,
	})
	settings.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 3b. TRAVEL WEBSITE — lalai (singleton)
# ══════════════════════════════════════════════

def _create_default_travel_website():
	"""Travel Website adalah Single doctype (satu rekod). Seed dengan
	keseluruhan kandungan hardcoded yang asal daripada cruise.html,
	tour.html, public_nav.html, public_footer.html — supaya halaman
	awam kelihatan sama sebelum dan selepas refactor config-driven.

	Footer link /destinations (404 lama) dibetulkan → /cruises + /tours.
	"""
	doc = frappe.get_doc("Travel Website", "Travel Website")
	if doc.cruise_hero_tag:
		return  # sudah di-seed

	menu = [
		{"label": "Tour", "url": "/tour", "active_nav_key": "tour",
		 "open_in_new_tab": 0, "is_active": 1, "sort_order": 1},
		{"label": "Cruise", "url": "/cruise", "active_nav_key": "cruise",
		 "open_in_new_tab": 0, "is_active": 1, "sort_order": 2},
		{"label": "All Trip", "url": "/trips", "active_nav_key": "trips",
		 "open_in_new_tab": 0, "is_active": 1, "sort_order": 3},
	]
	nav_cta_label = "Manage Booking"
	nav_cta_url = "/traveller_portal"

	footer_links = [
		{"column_title": "Explore", "label": "All Trips", "url": "/trips",
		 "is_active": 1, "sort_order": 1},
		{"column_title": "Explore", "label": "Cruises", "url": "/cruises",
		 "is_active": 1, "sort_order": 2},
		{"column_title": "Explore", "label": "Tours", "url": "/tours",
		 "is_active": 1, "sort_order": 3},
		{"column_title": "Explore", "label": "My Bookings", "url": "/traveller_portal",
		 "is_active": 1, "sort_order": 4},
	]

	cruise_benefits = [
		{"icon": "ti-utensils", "title": "All-Inclusive Dining",
		 "description": "Gourmet meals from around the world. Specialty restaurants, casual buffets, and 24-hour room service included in every package.",
		 "is_active": 1, "sort_order": 1},
		{"icon": "ti-theater", "title": "World-Class Entertainment",
		 "description": "Broadway-style shows, live music, casinos, and themed parties every night. Entertainment that rivals top land resorts.",
		 "is_active": 1, "sort_order": 2},
		{"icon": "ti-building-arch", "title": "Luxury Accommodations",
		 "description": "From cozy interior staterooms to expansive suites with private balconies. Your floating hotel offers unparalleled comfort at sea.",
		 "is_active": 1, "sort_order": 3},
		{"icon": "ti-map-2", "title": "Multiple Destinations",
		 "description": "Wake up in a new port every day. Visit multiple countries without repacking. The most efficient way to see the world.",
		 "is_active": 1, "sort_order": 4},
		{"icon": "ti-kids", "title": "Kids Cruise Free*",
		 "description": "Select voyages offer complimentary passage for children. Dedicated kids' clubs and family activities keep everyone entertained.",
		 "is_active": 1, "sort_order": 5},
		{"icon": "ti-headset", "title": "24/7 Concierge",
		 "description": "Our travel specialists support you before, during, and after your voyage. Shore excursion bookings, special requests — we handle it all.",
		 "is_active": 1, "sort_order": 6},
	]
	cruise_testimonials = [
		{"rating": 5, "quote": "The Mediterranean cruise exceeded all expectations. The ship was immaculate, food phenomenal, and the Greek island stops were absolutely magical.",
		 "author": "Amina & Family", "context_label": "Mediterranean Voyage · Aug 2025", "sort_order": 1},
		{"rating": 5, "quote": "First-time cruisers here — Rarecation made everything seamless. The kids club was a lifesaver! Already booked our Alaska cruise for next year.",
		 "author": "The Tan Family", "context_label": "Caribbean Explorer · Jul 2025", "sort_order": 2},
		{"rating": 5, "quote": "Anniversary trip of a lifetime. Balcony cabin, specialty dining every night, and the Northern Lights from deck — unforgettable.",
		 "author": "David & Sarah M.", "context_label": "Norwegian Fjords · Jun 2025", "sort_order": 3},
	]

	tour_benefits = [
		{"icon": "ti-user-heart", "title": "Expert Local Guides",
		 "description": "Knowledgeable, passionate guides who bring each destination to life. Gain insights only locals know — from hidden gems to cultural context.",
		 "is_active": 1, "sort_order": 1},
		{"icon": "ti-building-hotel", "title": "Handpicked Hotels",
		 "description": "From boutique stays to 5-star resorts, we select accommodations for comfort, location, and character. Rest well after every adventure.",
		 "is_active": 1, "sort_order": 2},
		{"icon": "ti-world", "title": "Cultural Immersion",
		 "description": "Go beyond tourist spots. Cook with locals, visit artisans, and experience traditions that define each destination's soul.",
		 "is_active": 1, "sort_order": 3},
		{"icon": "ti-users-group", "title": "Small Group Sizes",
		 "description": "Intimate groups of 8–16 travellers mean personal attention, flexible pacing, and authentic interactions — never a herd.",
		 "is_active": 1, "sort_order": 4},
		{"icon": "ti-route", "title": "Flexible Itineraries",
		 "description": "Balanced schedules with free time to explore. Optional excursions let you customise each day to your interests and energy.",
		 "is_active": 1, "sort_order": 5},
		{"icon": "ti-headset", "title": "24/7 Support",
		 "description": "From pre-departure planning to on-the-ground assistance, our team is one call away — anytime, anywhere in the world.",
		 "is_active": 1, "sort_order": 6},
	]
	tour_testimonials = [
		{"rating": 5, "quote": "The Japan cultural tour was beyond expectations. Our guide knew every hidden temple and the best local restaurants. The ryokan stay was unforgettable.",
		 "author": "Mei Ling & Family", "context_label": "Japan Cultural Journey · Apr 2025", "sort_order": 1},
		{"rating": 5, "quote": "Turkey exceeded all our expectations. From hot air balloons in Cappadocia to the markets of Istanbul — every day was a new adventure. Perfectly organised.",
		 "author": "The Rahman Family", "context_label": "Turkey Explorer · May 2025", "sort_order": 2},
		{"rating": 5, "quote": "Our Europe multi-country tour was seamless. Hotels were centrally located, guides were knowledgeable, and the small group felt like travelling with friends.",
		 "author": "Aisha & Kamal", "context_label": "European Grand Tour · Jun 2025", "sort_order": 3},
	]

	data = {
		"doctype": "Travel Website",

		# ── Common tab ──
		"website_logo": "",
		"footer_tagline": "Cruise & travel experiences, curated.",
		"footer_links": footer_links,
		"support_email": "contact@rpwp.my",
		"copyright_text": "Rarecation. All rights reserved.",
		"social_facebook": "",
		"social_instagram": "",
		"social_whatsapp": "",

		# ── Cruise tab ──
		"cruise_menu": menu,
		"cruise_nav_cta_label": nav_cta_label,
		"cruise_nav_cta_url": nav_cta_url,
		"cruise_hero_tag": "✦ Set Sail on Extraordinary Voyages",
		"cruise_hero_title": "Discover Your Perfect<br/><em>Cruise Adventure</em>",
		"cruise_hero_intro": "Explore breathtaking destinations aboard world-class luxury liners. All-inclusive dining, entertainment, and unforgettable experiences await.",
		"cruise_hero_search_label": "Search Cruises",
		"cruise_hero_stats": [
			{"stat_value": "500+", "stat_label": "Voyages", "sort_order": 1},
			{"stat_value": "50+", "stat_label": "Destinations", "sort_order": 2},
			{"stat_value": "98%", "stat_label": "Happy Travellers", "sort_order": 3},
		],
		"cruise_featured_tag": "Featured Voyages",
		"cruise_featured_title": "Most Popular Cruises",
		"cruise_featured_subtitle": "Hand-picked itineraries favoured by our seasoned travellers",
		"cruise_featured_cta_label": "View All Cruises →",
		"cruise_featured_cta_url": "/cruises",
		"cruise_whyus_tag": "Why Choose Us",
		"cruise_whyus_title": "The Rarecation Difference",
		"cruise_whyus_subtitle": "Everything you need, all included — no hidden surprises",
		"cruise_benefits": cruise_benefits,
		"cruise_dest_tag": "Explore",
		"cruise_dest_title": "Sought-After Destinations",
		"cruise_dest_subtitle": "Discover the world's most spectacular ports of call",
		"cruise_testi_tag": "Traveller Stories",
		"cruise_testi_title": "What Our Guests Say",
		"cruise_testi_subtitle": "Real experiences from real cruisers",
		"cruise_testimonials": cruise_testimonials,
		"cruise_cta_icon": "ti-sail-boat",
		"cruise_cta_tag": "Your Voyage Awaits",
		"cruise_cta_title": "Ready to Set Sail?",
		"cruise_cta_body": "Your perfect cruise is just a few clicks away. Start exploring today.",
		"cruise_cta_primary_label": "Browse Cruises",
		"cruise_cta_primary_url": "/cruises",
		"cruise_cta_secondary_label": "View All Trips",
		"cruise_cta_secondary_url": "/trips",

		# ── Tour tab ──
		"tour_menu": menu,
		"tour_nav_cta_label": nav_cta_label,
		"tour_nav_cta_url": nav_cta_url,
		"tour_hero_tag": "✦ Discover the World, One Journey at a Time",
		"tour_hero_title": "Explore the World<br/><em>Beyond the Seas</em>",
		"tour_hero_intro": "From ancient cities to breathtaking landscapes — curated international tours designed for the curious traveller. Expert guides, handpicked hotels, and authentic local experiences.",
		"tour_hero_search_label": "Search Tours",
		"tour_hero_stats": [
			{"stat_value": "300+", "stat_label": "Tours", "sort_order": 1},
			{"stat_value": "40+", "stat_label": "Countries", "sort_order": 2},
			{"stat_value": "95%", "stat_label": "Happy Travellers", "sort_order": 3},
		],
		"tour_featured_tag": "Featured Journeys",
		"tour_featured_title": "Most Popular Tours",
		"tour_featured_subtitle": "Hand-picked itineraries loved by our travellers worldwide",
		"tour_featured_cta_label": "View All Tours →",
		"tour_featured_cta_url": "/tours",
		"tour_whyus_tag": "Why Choose Us",
		"tour_whyus_title": "The Rarecation Difference",
		"tour_whyus_subtitle": "Thoughtfully crafted tours with authentic experiences at every stop",
		"tour_benefits": tour_benefits,
		"tour_dest_tag": "Explore",
		"tour_dest_title": "Sought-After Destinations",
		"tour_dest_subtitle": "Discover the world's most captivating travel destinations",
		"tour_testi_tag": "Traveller Stories",
		"tour_testi_title": "What Our Guests Say",
		"tour_testi_subtitle": "Real experiences from real travellers",
		"tour_testimonials": tour_testimonials,
		"tour_cta_icon": "ti-mountain",
		"tour_cta_tag": "Your Adventure Awaits",
		"tour_cta_title": "Ready to Explore?",
		"tour_cta_body": "Your next adventure is just a few clicks away. Start discovering today.",
		"tour_cta_primary_label": "Browse Tours",
		"tour_cta_primary_url": "/tours",
		"tour_cta_secondary_label": "View All Trips",
		"tour_cta_secondary_url": "/trips",
	}
	data.pop("doctype", None)
	doc.update(data)
	doc.flags.ignore_mandatory = True
	doc.save(ignore_permissions=True)

def _create_email_templates():
	"""Template lalai untuk semua e-mel yang app hantar. Semua nama
	telegram dipanggil terus dalam email_service.py — kalau nama template
	berubah di sini, kemas kini pemetaan di _send_status_email() juga.

	Template ni cuma lalai — admin boleh (dan patut) edit/replace di Desk
	(Settings > Email Template) dengan HTML/branding sebenar Rarecruise.
	"""
	templates = [
		{
			"name":    "Set Your Password",
			"subject": "Set Your Password — Rarecruise",
			"use_html": 1,
			"response_html": _TPL_SET_PASSWORD,
		},
		{
			"name":    "Booking Pending",
			"subject": "Booking Pending — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_PENDING,
		},
		{
			"name":    "Booking Accepted",
			"subject": "Booking Confirmed — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_ACCEPTED,
		},
		{
			"name":    "Booking Processing",
			"subject": "Booking Update — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_PROCESSING,
		},
		{
			"name":    "Booking Confirmed",
			"subject": "Trip Confirmed — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_CONFIRMED,
		},
		{
			"name":    "Booking Completed",
			"subject": "Thank You for Travelling — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_COMPLETED,
		},
		{
			"name":    "Payment Receipt",
			"subject": "Payment Receipt — {{ booking_number }}",
			"use_html": 1,
			"response_html": _TPL_RECEIPT,
		},
	]

	for tpl in templates:
		if frappe.db.exists("Email Template", tpl["name"]):
			continue
		doc = frappe.get_doc({
			"doctype":    "Email Template",
			"name":       tpl["name"],
			"subject":    tpl["subject"],
			"use_html":   tpl.get("use_html", 1),
			"response_html": tpl["response_html"],
		})
		doc.insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# 5. PRINT FORMAT — "Rarecation Receipt"
# ══════════════════════════════════════════════

def _create_print_format():
	"""Print Format untuk PDF resit — dipanggil oleh _receipt_pdf() di
	email_service.py dan get_document_pdf() di portal_payment.py.

	Cipta sebagai Custom Print Format (html-based) supaya admin boleh
	edit langsung di Desk (Print Format > Rarecation Receipt).
	"""
	from travel_booking.api.constants import PRINT_FORMAT_RECEIPT, PRINT_FORMAT_PROFORMA

	if not frappe.db.exists("Print Format", PRINT_FORMAT_RECEIPT):
		frappe.get_doc({
			"doctype":         "Print Format",
			"name":            PRINT_FORMAT_RECEIPT,
			"doc_type":        "Payment Entry",
			"print_format_type": "Jinja",
			"html": _PF_RECEIPT_HTML,
		}).insert(ignore_permissions=True)

	# Proforma (Sales Order) — download customer dari page Billing portal.
	if not frappe.db.exists("Print Format", PRINT_FORMAT_PROFORMA):
		frappe.get_doc({
			"doctype":         "Print Format",
			"name":            PRINT_FORMAT_PROFORMA,
			"doc_type":        "Sales Order",
			"print_format_type": "Jinja",
			"html": _PF_PROFORMA_HTML,
		}).insert(ignore_permissions=True)


# ══════════════════════════════════════════════
# TEMPLATE HTML CONSTANTS (lalai ringkas — ganti dengan branding sebenar)
# ══════════════════════════════════════════════

# Setiap template guna Jinja variable yang disediakan oleh
# _send_status_email() / _send_set_password_email() di email_service.py.
# Rujuk context dict di situ untuk senarai variable yang tersedia.

_TPL_SET_PASSWORD = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Set Your Password</h2>
  <p>Hi {{ first_name }},</p>
  <p>Welcome to Rarecruise! Your portal account is ready. Please set your password to access your bookings and traveller details.</p>
  <p style="margin: 24px 0;">
    <a href="{{ set_password_url }}" style="display: inline-block; padding: 12px 32px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px; font-weight: bold;">Set Your Password</a>
  </p>
  <p style="color: #666; font-size: 12px;">If you did not create a booking, please ignore this email.</p>
</div>
"""

_TPL_PENDING = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Pending — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>We've received your booking for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>.</p>
  <p>Your booking is currently pending payment. You can complete your payment at any time through the portal.</p>
  <p><strong>Total:</strong> {{ total_fmt }}</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_ACCEPTED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Confirmed — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Great news! We've received your payment for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>.</p>
  <p><strong>Amount Paid:</strong> {{ amount_paid_fmt }}<br><strong>Payment Status:</strong> {{ payment_status }}</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_PROCESSING = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Booking Update — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Your booking for <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong> is now being processed. Our team is arranging your flights and cabin assignments.</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_CONFIRMED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Trip Confirmed — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>Your trip <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong> has been fully confirmed! Flight and cabin details are finalized.</p>
  <p style="margin: 24px 0;">
    <a href="{{ booking_url }}" style="display: inline-block; padding: 10px 28px; background: #B8860B; color: #fff; text-decoration: none; border-radius: 6px;">View Booking</a>
  </p>
</div>
"""

_TPL_COMPLETED = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Thank You for Travelling — {{ booking_number }}</h2>
  <p>Hi {{ first_name }},</p>
  <p>We hope you enjoyed your trip <strong>{{ trip_name }}{% if group_name %} · {{ group_name }}{% endif %}</strong>!</p>
  <p>Thank you for choosing Rarecruise. We look forward to seeing you on your next adventure.</p>
</div>
"""

_TPL_RECEIPT = """\
<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
  <h2 style="color: #B8860B;">Payment Receipt</h2>
  <p>Hi {{ first_name }},</p>
  <p>We've received your payment of <strong>{{ amount_fmt }}</strong> for booking <strong>{{ booking_number }}</strong>.</p>
  <p>A detailed PDF receipt is attached to this email for your records.</p>
</div>
"""

_PF_RECEIPT_HTML = """\
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h2 style="color: #B8860B; text-align: center;">Rarecruise — Payment Receipt</h2>
  <hr>
  <p><strong>Receipt No:</strong> {{ doc.name }}</p>
  <p><strong>Date:</strong> {{ frappe.format_date(doc.posting_date) }}</p>
  <p><strong>Customer:</strong> {{ doc.party }}</p>
  <hr>
  <h3>Payment Details</h3>
  <p><strong>Amount:</strong> {{ frappe.format_value(doc.paid_amount, currency=doc.paid_to_account_currency) }}</p>
  <p><strong>Mode of Payment:</strong> {{ doc.mode_of_payment or 'N/A' }}</p>
  <p><strong>Reference No:</strong> {{ doc.reference_no or 'N/A' }}</p>
  <hr>
  <p style="color: #999; font-size: 12px; text-align: center;">This is a computer-generated receipt.</p>
</div>
"""

_PF_PROFORMA_HTML = """\
<div style="font-family: sans-serif; max-width: 700px; margin: 0 auto; padding: 16px;">
  <div style="text-align:center;border-bottom:3px solid #C9A84C;padding-bottom:12px;margin-bottom:8px;">
    <div style="font-family:'DM Serif Display',serif;font-size:26px;color:#C9A84C;">Rarecruise</div>
    <div style="font-size:18px;font-weight:bold;letter-spacing:2px;margin-top:8px;">PROFORMA INVOICE</div>
    <div style="font-size:11px;color:#991B1B;font-weight:bold;margin-top:4px;">THIS IS NOT A TAX INVOICE</div>
  </div>

  <table style="width:100%;font-size:13px;margin:16px 0;">
    <tr>
      <td style="vertical-align:top;width:50%;padding:0;">
        <strong>Bill To:</strong><br/>
        {{ doc.customer_name or doc.customer }}
      </td>
      <td style="vertical-align:top;width:50%;padding:0;">
        <strong>Proforma No:</strong> {{ doc.name }}<br/>
        <strong>Date:</strong> {{ frappe.format_date(doc.transaction_date) }}<br/>
        {% if doc.custom_booking %}
        {% set booking_no = frappe.db.get_value("Booking", doc.custom_booking, "booking_number") %}
        {% if booking_no %}<strong>Booking Ref:</strong> {{ booking_no }}<br/>{% endif %}
        {% endif %}
        <strong>Currency:</strong> {{ doc.currency }}
      </td>
    </tr>
  </table>

  <table style="width:100%;border-collapse:collapse;font-size:12px;">
    <thead>
      <tr style="background:#C9A84C;color:#fff;">
        <th style="padding:8px;text-align:left;">Description</th>
        <th style="padding:8px;text-align:center;">Qty</th>
        <th style="padding:8px;text-align:right;">Rate</th>
        <th style="padding:8px;text-align:right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      {% for item in doc.items %}
      <tr style="border-bottom:1px solid #E8E5DF;">
        <td style="padding:8px;">{{ item.item_name }}</td>
        <td style="padding:8px;text-align:center;">{{ item.qty|int }}</td>
        <td style="padding:8px;text-align:right;">{{ frappe.format_value(item.rate, currency=doc.currency) }}</td>
        <td style="padding:8px;text-align:right;">{{ frappe.format_value(item.amount, currency=doc.currency) }}</td>
      </tr>
      {% endfor %}
    </tbody>
  </table>

  <table style="width:100%;font-size:13px;margin-top:12px;">
    <tr>
      <td style="text-align:right;padding:4px 0;width:70%;"><strong>Grand Total:</strong></td>
      <td style="text-align:right;padding:4px 0;"><strong>{{ frappe.format_value(doc.grand_total, currency=doc.currency) }}</strong></td>
    </tr>
    {% if doc.advance_paid %}
    <tr>
      <td style="text-align:right;padding:4px 0;"><strong>Amount Paid:</strong></td>
      <td style="text-align:right;padding:4px 0;">{{ frappe.format_value(doc.advance_paid, currency=doc.currency) }}</td>
    </tr>
    <tr>
      <td style="text-align:right;padding:4px 0;"><strong>Balance Due:</strong></td>
      <td style="text-align:right;padding:4px 0;">{{ frappe.format_value(doc.grand_total - doc.advance_paid, currency=doc.currency) }}</td>
    </tr>
    {% endif %}
  </table>

  <p style="font-size:11px;color:#7D7A70;margin-top:20px;line-height:1.6;">
    This proforma invoice is issued for booking and payment reference purposes only.
    A formal tax invoice will be issued upon payment confirmation.
    Prices are quoted in {{ doc.currency }} and are valid for this booking only.
  </p>
</div>
"""
