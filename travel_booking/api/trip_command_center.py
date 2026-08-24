# travel_booking/api/trip_command_center.py
# Backend API untuk Trip Command Center (/app/trip-command-center)
#
# Menyediakan endpoints untuk:
# - Trip product management
# - Group date scheduling
# - Package/pricing management
# - Website settings & configuration
# - Cruise schedule management

import frappe
from frappe import _
from datetime import datetime


@frappe.whitelist()
def get_trips_list(search: str = None, status: str = None, is_cruise: str = None, limit: int = 50) -> dict:
	"""
	Return list of trips dengan pricing info menggunakan single optimized SQL JOIN.

	Query pattern:
	  SELECT ... FROM trip
	  LEFT JOIN trip-group-date (count active dates)
	  LEFT JOIN trip-package + trip-package-price (get min price)
	  WHERE [filters]
	  GROUP BY trip.name
	  ORDER BY creation DESC
	  LIMIT {limit}
	"""
	try:
		# Build WHERE clauses dynamically dengan parameter binding
		where_conditions = []
		params = []

		if status:
			where_conditions.append('t.status = %s')
			params.append(status)

		if is_cruise:
			where_conditions.append('t.is_a_cruise_trip = %s')
			params.append(int(is_cruise))

		if search:
			where_conditions.append('t.trip_name LIKE %s')
			params.append('%' + search + '%')

		where_clause = ''
		if where_conditions:
			where_clause = 'WHERE ' + ' AND '.join(where_conditions)

		# Single optimized SQL query dengan LEFT JOIN
		# Menggunakan parameter binding untuk keselamatan
		sql_query = """
			SELECT
				t.name,
				t.trip_name,
				t.route,
				t.published,
				t.status,
				t.is_a_cruise_trip,
				t.trip_image,
				t.creation,
				t.modified,

				-- Count active departure dates
				COUNT(DISTINCT CASE WHEN gd.status = 'Active' THEN gd.name END) AS dates_count,

				-- Get minimum price across all packages
				MIN(pp.min_pkg_price) AS min_price

			FROM `tabTrip` t

			-- LEFT JOIN trip group dates (count only)
			LEFT JOIN `tabTrip Group Date` gd ON gd.trip = t.name

			-- LEFT JOIN packages dengan subquery untuk dapatkan min price per package
			LEFT JOIN (
				SELECT
					tp.trip_link,
					tp.name as pkg_name,
					-- Minimum price dalam satu package (adult/single/children)
					LEAST(
						COALESCE(MIN(CASE WHEN ppp.price_adult > 0 THEN ppp.price_adult END), 999999999),
						COALESCE(MIN(CASE WHEN ppp.price_adult_single > 0 THEN ppp.price_adult_single END), 999999999),
						COALESCE(MIN(CASE WHEN ppp.price_children > 0 THEN ppp.price_children END), 999999999)
					) AS min_pkg_price
				FROM `tabTrip Package` tp
				LEFT JOIN `tabTrip Package Price` ppp ON ppp.parent = tp.name
				WHERE tp.status = 'Active'
				GROUP BY tp.name, tp.trip_link
			) pp ON pp.trip_link = t.name

			{where_clause}

			GROUP BY t.name, t.trip_name, t.route, t.published, t.status,
			         t.is_a_cruise_trip, t.trip_image, t.creation, t.modified

			ORDER BY t.creation DESC

			LIMIT %s
		""".format(where_clause=where_clause)

		# Add limit sebagai parameter terakhir
		params.append(int(limit))

		# Execute query dengan semua parameters bound
		trips_data = frappe.db.sql(sql_query, params, as_dict=True)

		# Transform results ke format yang dijangkakan frontend
		result = []
		for t in trips_data:
			if not t or not t.get('name'):
				continue

			trip_dict = {
				'name': t.name,
				'trip_name': t.trip_name or '',
				'route': t.route or '',
				'published': t.published,
				'status': t.status or 'Active',
				'is_a_cruise_trip': t.is_a_cruise_trip,
				'image': t.trip_image or '',
				'dates_count': t.dates_count or 0,
				'min_price': t.min_price if (t.min_price and t.min_price < 999999999) else 0,
				'creation': str(t.creation) if t.creation else '',
				'modified': str(t.modified) if t.modified else '',
			}
			result.append(trip_dict)

		return {'trips': result}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'TripCmd: Get Trips Error')
		return {'trips': []}


@frappe.whitelist()
def get_trip_dates(trip_name: str) -> dict:
	"""
	Get all group dates for a specific trip.
	"""
	try:
		# Graceful handling of missing/empty trip_name
		if not trip_name or not trip_name.strip():
			return {'trip': {}, 'dates': []}

		# Defensive: Validate trip_name is not a doctype name (common bug)
		if trip_name in ('Trip', 'Trip Group Date', 'Trip Package', 'Trip Package Price'):
			frappe.log_error(f'TripCmd: Invalid trip_name received: {trip_name}', 'TripCmd: Invalid Trip Name')
			return {'trip': {}, 'dates': [], 'error': f'Invalid trip identifier: {trip_name}'}

		# Check if trip actually exists before trying to get_doc
		if not frappe.db.exists('Trip', trip_name):
			frappe.log_error(f'TripCmd: Trip not found: {trip_name}', 'TripCmd: Trip Not Found')
			return {'trip': {}, 'dates': [], 'error': f'Trip {trip_name} not found'}

		trip = frappe.get_doc('Trip', trip_name)
		
		dates = frappe.get_all(
				'Trip Group Date',
				fields=[
					'name', 'departure_date', 'return_date',
					'sailing_start', 'sailing_end',  # ← Tambah sailing dates untuk cruise
					'ship_name', 'ship_code', 'max_participants', 'current_participants',
					'is_cruise_only', 'embarkation_port', 'disembarkation_port',
					'total_days', 'total_nights', 'status'
				],
				filters={'trip': trip_name},
				order_by='departure_date'
			)

		return {
				'trip': {
					'name': trip.name,
					'trip_name': trip.trip_name,
					'is_a_cruise_trip': trip.is_a_cruise_trip,
				},
				# Filter out null/invalid objects dan convert ke dict dengan selamat
				'dates': [
					(d.__dict__ if hasattr(d, '__dict__') and d.__dict__ else (d if d else {}))
					for d in dates
					if d  # Skip null values entirely
				]
			}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), f'TripCmd: Get Dates Error for {trip_name}')
		return {'trip': {}, 'dates': []}


@frappe.whitelist()
def get_trip_packages(trip_name: str) -> dict:
	"""
	Get all packages for a specific trip dengan pricing summary.
	"""
	try:
		# Graceful handling of missing/empty trip_name
		if not trip_name or not trip_name.strip():
			return {'packages': []}

		# Defensive: Validate trip_name is not a doctype name (common bug)
		if trip_name in ('Trip', 'Trip Group Date', 'Trip Package', 'Trip Package Price'):
			frappe.log_error(f'TripCmd: Invalid trip_name received: {trip_name}', 'TripCmd: Invalid Trip Name')
			return {'packages': [], 'error': f'Invalid trip identifier: {trip_name}'}

		# Check if trip actually exists before querying packages
		if not frappe.db.exists('Trip', trip_name):
			frappe.log_error(f'TripCmd: Trip not found: {trip_name}', 'TripCmd: Trip Not Found')
			return {'packages': [], 'error': f'Trip {trip_name} not found'}

		packages = frappe.get_all(
			'Trip Package',
			fields=[
				'name', 'package_title', 'package_type', 'airport_form',
				'currency', 'status'
			],
			filters={'trip_link': trip_name},
			order_by='creation'
		)

		result = []
		for p in packages:
			# Skip if package object is invalid
			if not p or not p.name:
				continue

			# Get minimum price from package price table
			prices = frappe.get_all(
				'Trip Package Price',
				fields=['price_adult', 'price_adult_single', 'price_children'],
				filters={'parent': p.name}
			)

			min_price = None
			for pr in prices:
				candidates = [pr.price_adult, pr.price_adult_single, pr.price_children]
				valid_prices = [x for x in candidates if x]
				if valid_prices:
					candidate_min = min(valid_prices)
					if min_price is None or candidate_min < min_price:
						min_price = candidate_min

			# Safely convert package to dict
			if hasattr(p, '__dict__') and p.__dict__:
				pkg_dict = {k: v for k, v in p.__dict__.items() if not k.startswith('_')}
			else:
				pkg_dict = dict(p) if p else {}

			pkg_dict['min_price'] = min_price or 0
			result.append(pkg_dict)

		return {'packages': result}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), f'TripCmd: Get Packages Error for {trip_name}')
		return {'packages': []}
		return {'packages': []}


_CACHE_KEY = "tcc_website_settings"


@frappe.whitelist()
def get_website_settings() -> dict:
	"""
	Get comprehensive website configuration settings for Trip Command Center.
	Returns all branding, navigation, footer, and homepage section configurations.

	Cached per-site; invalidated when Travel Website document is saved.
	"""
	try:
		# Try cache first
		cache = frappe.cache()
		cached_settings = cache.get_value(_CACHE_KEY)
		if cached_settings is not None:
			return cached_settings

		# Build fresh settings
		settings = _build_website_settings()

		# Cache for 10 minutes (shorter than template cache since desk needs freshness)
		cache.set_value(_CACHE_KEY, settings, expires_in_sec=600)

		return settings

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'TripCmd: Website Settings Error')
		return _empty_website_settings()


def _build_website_settings() -> dict:
	"""Build complete website settings from Travel Website singleton."""
	try:
		wc = frappe.get_doc('Travel Website')
	except Exception:
		return _empty_website_settings()

	# Helper to process child tables with filtering and sorting
	def get_child_table(field_name, has_active=True):
		"""Get filtered and sorted child table rows."""
		rows = getattr(wc, field_name, None)
		if not rows:
			return []
		items = []
		for row in rows:
			# Skip inactive rows if field supports it
			if has_active and hasattr(row, 'is_active') and not row.is_active:
				continue
			items.append(row.as_dict() if hasattr(row, 'as_dict') else dict(row))
		# Sort by sort_order then idx
		items.sort(key=lambda x: (x.get('sort_order') or 0, x.get('idx') or 0))
		return items

	# Build footer links grouped by column
	footer_links = get_child_table('footer_links', has_active=False)
	footer_columns = _group_footer_columns(footer_links)

	return {
		# === BRANDING & IDENTITY ===
		'logo': wc.website_logo or '',

		# === FOOTER CONFIGURATION ===
		'footer_tagline': wc.footer_tagline or '',
		'footer_links': footer_links,
		'footer_columns': footer_columns,
		'support_email': wc.support_email or 'contact@rpwp.my',
		'copyright_text': wc.copyright_text or '',

		# === SOCIAL MEDIA ===
		'facebook': wc.social_facebook or '',
		'instagram': wc.social_instagram or '',
		'whatsapp': wc.social_whatsapp or '',

		# === CRUISE HOMEPAGE ===
		# Navigation
		'cruise_menu': get_child_table('cruise_menu'),
		'cruise_nav_cta_label': wc.cruise_nav_cta_label or 'Manage Booking',
		'cruise_nav_cta_url': wc.cruise_nav_cta_url or '/traveller_portal',

		# Hero Section
		'cruise_hero_tag': wc.cruise_hero_tag or '',
		'cruise_hero_title': wc.cruise_hero_title or '',
		'cruise_hero_intro': wc.cruise_hero_intro or '',
		'cruise_hero_search_label': wc.cruise_hero_search_label or 'Search Cruises',
		'cruise_hero_stats': get_child_table('cruise_hero_stats', has_active=False),

		# Featured Section
		'cruise_featured_tag': wc.cruise_featured_tag or '',
		'cruise_featured_title': wc.cruise_featured_title or '',
		'cruise_featured_subtitle': wc.cruise_featured_subtitle or '',
		'cruise_featured_cta_label': wc.cruise_featured_cta_label or 'View All Cruises',
		'cruise_featured_cta_url': wc.cruise_featured_cta_url or '/cruises',

		# Why Choose Us Section
		'cruise_whyus_tag': wc.cruise_whyus_tag or '',
		'cruise_whyus_title': wc.cruise_whyus_title or '',
		'cruise_whyus_subtitle': wc.cruise_whyus_subtitle or '',
		'cruise_benefits': get_child_table('cruise_benefits'),

		# Destinations Section
		'cruise_dest_tag': wc.cruise_dest_tag or '',
		'cruise_dest_title': wc.cruise_dest_title or '',
		'cruise_dest_subtitle': wc.cruise_dest_subtitle or '',

		# Testimonials Section
		'cruise_testi_tag': wc.cruise_testi_tag or '',
		'cruise_testi_title': wc.cruise_testi_title or '',
		'cruise_testi_subtitle': wc.cruise_testi_subtitle or '',
		'cruise_testimonials': get_child_table('cruise_testimonials', has_active=False),

		# Call-to-Action Block
		'cruise_cta_icon': wc.cruise_cta_icon or '',
		'cruise_cta_tag': wc.cruise_cta_tag or '',
		'cruise_cta_title': wc.cruise_cta_title or '',
		'cruise_cta_body': wc.cruise_cta_body or '',
		'cruise_cta_primary_label': wc.cruise_cta_primary_label or '',
		'cruise_cta_primary_url': wc.cruise_cta_primary_url or '',
		'cruise_cta_secondary_label': wc.cruise_cta_secondary_label or '',
		'cruise_cta_secondary_url': wc.cruise_cta_secondary_url or '',

		# === TOUR HOMEPAGE ===
		# Navigation
		'tour_menu': get_child_table('tour_menu'),
		'tour_nav_cta_label': wc.tour_nav_cta_label or 'Manage Booking',
		'tour_nav_cta_url': wc.tour_nav_cta_url or '/traveller_portal',

		# Hero Section
		'tour_hero_tag': wc.tour_hero_tag or '',
		'tour_hero_title': wc.tour_hero_title or '',
		'tour_hero_intro': wc.tour_hero_intro or '',
		'tour_hero_search_label': wc.tour_hero_search_label or 'Search Tours',
		'tour_hero_stats': get_child_table('tour_hero_stats', has_active=False),

		# Featured Section
		'tour_featured_tag': wc.tour_featured_tag or '',
		'tour_featured_title': wc.tour_featured_title or '',
		'tour_featured_subtitle': wc.tour_featured_subtitle or '',
		'tour_featured_cta_label': wc.tour_featured_cta_label or 'View All Tours',
		'tour_featured_cta_url': wc.tour_featured_cta_url or '/tours',

		# Why Choose Us Section
		'tour_whyus_tag': wc.tour_whyus_tag or '',
		'tour_whyus_title': wc.tour_whyus_title or '',
		'tour_whyus_subtitle': wc.tour_whyus_subtitle or '',
		'tour_benefits': get_child_table('tour_benefits'),

		# Destinations Section
		'tour_dest_tag': wc.tour_dest_tag or '',
		'tour_dest_title': wc.tour_dest_title or '',
		'tour_dest_subtitle': wc.tour_dest_subtitle or '',

		# Testimonials Section
		'tour_testi_tag': wc.tour_testi_tag or '',
		'tour_testi_title': wc.tour_testi_title or '',
		'tour_testi_subtitle': wc.tour_testi_subtitle or '',
		'tour_testimonials': get_child_table('tour_testimonials', has_active=False),

		# Call-to-Action Block
		'tour_cta_icon': wc.tour_cta_icon or '',
		'tour_cta_tag': wc.tour_cta_tag or '',
		'tour_cta_title': wc.tour_cta_title or '',
		'tour_cta_body': wc.tour_cta_body or '',
		'tour_cta_primary_label': wc.tour_cta_primary_label or '',
		'tour_cta_primary_url': wc.tour_cta_primary_url or '',
		'tour_cta_secondary_label': wc.tour_cta_secondary_label or '',
		'tour_cta_secondary_url': wc.tour_cta_secondary_url or '',
	}


def _group_footer_columns(links: list) -> list:
	"""Group footer links by column_title for organized display."""
	columns = {}
	order = []
	for link in links:
		title = link.get('column_title') or 'Links'
		if title not in columns:
			columns[title] = []
			order.append(title)
		columns[title].append(link)
	return [{'title': t, 'links': columns[t]} for t in order]


def _empty_website_settings() -> dict:
	"""Return safe default settings when Travel Website doesn't exist."""
	empty_section = {
		'menu': [],
		'nav_cta_label': 'Manage Booking',
		'nav_cta_url': '/traveller_portal',
		'hero_tag': '',
		'hero_title': '',
		'hero_intro': '',
		'hero_search_label': '',
		'hero_stats': [],
		'featured_tag': '',
		'featured_title': '',
		'featured_subtitle': '',
		'featured_cta_label': '',
		'featured_cta_url': '',
		'whyus_tag': '',
		'whyus_title': '',
		'whyus_subtitle': '',
		'benefits': [],
		'dest_tag': '',
		'dest_title': '',
		'dest_subtitle': '',
		'testi_tag': '',
		'testi_title': '',
		'testi_subtitle': '',
		'testimonials': [],
		'cta_icon': '',
		'cta_tag': '',
		'cta_title': '',
		'cta_body': '',
		'cta_primary_label': '',
		'cta_primary_url': '',
		'cta_secondary_label': '',
		'cta_secondary_url': '',
	}

	return {
		'logo': '',
		'footer_tagline': '',
		'footer_links': [],
		'footer_columns': [],
		'support_email': 'contact@rpwp.my',
		'copyright_text': '',
		'facebook': '',
		'instagram': '',
		'whatsapp': '',
		# Cruise (copy empty section + overrides)
		**{f'cruise_{k}': v for k, v in empty_section.items()},
		**{'cruise_hero_search_label': 'Search Cruises', 'cruise_featured_cta_label': 'View All Cruises', 'cruise_featured_cta_url': '/cruises'},
		# Tour (copy empty section + overrides)
		**{f'tour_{k}': v for k, v in empty_section.items()},
		**{'tour_hero_search_label': 'Search Tours', 'tour_featured_cta_label': 'View All Tours', 'tour_featured_cta_url': '/tours'},
	}


@frappe.whitelist()
def get_published_trips() -> list:
	"""
	Get all published trips untuk website display.
	"""
	try:
		trips = frappe.get_all(
			'Trip',
			fields=['name', 'trip_name', 'route', 'published', 'is_a_cruise_trip', 'route'],
			filters={'published': 1},
			order_by='creation desc'
		)
		
		return [t.__dict__ if hasattr(t, '__dict__') else t for t in trips]

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'TripCmd: Published Trips Error')
		return []


@frappe.whitelist()
def get_cruise_schedules(trip_name: str) -> dict:
	"""
	Get cruise schedules for a trip.
	"""
	try:
		# Graceful handling of missing/empty trip_name
		if not trip_name or not trip_name.strip():
			return {'schedules': []}

		schedules = frappe.get_all(
			'Trip Cruise Schedule',
			fields=[
				'name', 'ship_code', 'ship_name',
				'sail_start', 'sail_end', 'port_start', 'port_end',
				'total_days', 'cruise_line_company'
			],
			filters={'trip_link': trip_name},
			order_by='sail_start'
		)

		result = []
		for s in schedules:
			# Get cabin rates count
			cabin_rates = frappe.get_all(
				'Trip Package Price',
				fields=['pricing_for_class', 'price_adult', 'price_adult_single'],
				filters={'parent': s.name}
			)
			
			sched_dict = {k: v for k, v in s.__dict__.items() if not k.startswith('_')} if hasattr(s, '__dict__') else dict(s)
			
			cabin_rate_data = {}
			if cabin_rates:
				for r in cabin_rates:
					cabin_rate_data[r.pricing_for_class] = {
						'adult': r.price_adult,
						'single': r.price_adult_single,
					}
			
			sched_dict['cabin_rates'] = cabin_rate_data
			result.append(sched_dict)

		return {'schedules': result}

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), f'TripCmd: Cruise Schedules Error for {trip_name}')
		return {'schedules': []}


@frappe.whitelist()
def update_website_setting(field: str, value: str) -> dict:
	"""
	Update individual website setting field.
	"""
	if not field:
		frappe.throw(_('Field name required'))

	try:
		wc = frappe.get_doc('Travel Website')
		if hasattr(wc, field):
			setattr(wc, field, value)
			wc.save(ignore_permissions=True)
			frappe.db.commit()
			
			return {
				'success': True,
				'message': _('Website setting updated'),
			}
		else:
			frappe.throw(_('Invalid field: {0}').format(field))

	except Exception as e:
		frappe.log_error(frappe.get_traceback(), 'TripCmd: Update Setting Error')
		frappe.throw(_('Failed to update setting: {0}').format(str(e)))
