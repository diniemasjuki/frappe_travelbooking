app_name = "travel_booking"
app_title = "Travel Booking Management"
app_publisher = "WargaPrihatin"
app_description = "Manage Traveller Booking Information"
app_email = "contact@rpwp.my"
app_license = "mit"

# Send non-GET requests for this app's endpoints as native `application/json`
# bodies instead of form-encoded, per-key JSON-stringified values.
use_json_request_body = True

# Apps
# ------------------

# travel_booking bergantung kepada ERPNext — Sales Order, Payment Entry,
# Customer, Sales Invoice, Currency Exchange, dsb. Frappe akan pastikan
# ERPNext dipasang sebelum travel_booking, dan akan tolak uninstall
# ERPNext selagi travel_booking masih aktif.
required_apps = ["erpnext"]

# Each item in the list will be shown as an app in the apps page
# add_to_apps_screen = [
# 	{
# 		"name": "travel_booking",
# 		"logo": "/assets/travel_booking/logo.png",
# 		"title": "Travel Booking Management",
# 		"route": "/travel_booking",
# 		"has_permission": "travel_booking.api.permission.has_app_permission",
# 	}
# ]

# Companion apps that extend a host app (instead of taking their own apps-screen icon) can pin
# their workspaces into the host app's workspace dock (rail) with this hook.
# add_app_to_rail = [
# 	{
# 		"app": "erpnext",
# 		"workspace": "My Workspace",
# 		"has_permission": "travel_booking.api.permission.has_app_permission",
# 	}
# ]

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/travel_booking/css/travel_booking.css"
# app_include_js = "/assets/travel_booking/js/travel_booking.js"

# include js, css files in header of web template
# web_include_css = "/assets/travel_booking/css/travel_booking.css"
# web_include_js = "/assets/travel_booking/js/travel_booking.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "travel_booking/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Svg Icons
# ------------------
# include app icons in desk
# app_include_icons = "travel_booking/public/icons.svg"

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
# 	"Role": "home_page"
# }

# Generators
# ----------

# Trip doctype mempunyai is_website_scritable dan WebsiteRouteGenerator pattern
# (rujuk trip.py controller) — Frappe auto-jana laluan web /<trip_name> untuk
# setiap rekod Trip yang published.
website_generators = ["Trip"]

# automatically load and sync documents of this doctype from downstream apps
# importable_doctypes = [doctype_1]

# Jinja
# ----------

# add methods and filters to jinja environment
# jinja = {
# 	"methods": "travel_booking.utils.jinja_methods",
# 	"filters": "travel_booking.utils.jinja_filters"
# }

# Installation
# ------------

# before_install sahkan ERPNext sedia ada sebelum travel_booking dipasang.
# after_install cipta rekod-rekod lalai yang app bergantung untuk berfungsi
# penuh (Travel Settings, Item TRAVEL-PKG, Email Templates, Print Format).
before_install = "travel_booking.install.before_install"
after_install = "travel_booking.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "travel_booking.uninstall.before_uninstall"
# after_uninstall = "travel_booking.uninstall.after_uninstall"

# Integration Setup
# ------------------
# To set up dependencies/integrations with other apps
# Name of the app being installed is passed as an argument

# before_app_install = "travel_booking.utils.before_app_install"
# after_app_install = "travel_booking.utils.after_app_install"

# Integration Cleanup
# -------------------
# To clean up dependencies/integrations with other apps
# Name of the app being uninstalled is passed as an argument

# before_app_uninstall = "travel_booking.utils.before_app_uninstall"
# after_app_uninstall = "travel_booking.utils.after_app_uninstall"

# Build
# ------------------
# To hook into the build process

# after_build = "travel_booking.build.after_build"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "travel_booking.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
# 	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
# 	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

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
		"on_update": "travel_booking.api.booking_engine.on_booking_update",
	},
}

# Scheduled Tasks
# ---------------

scheduler_events = {
	"daily": [
		"travel_booking.api.booking_engine.mark_completed_trips",
	],
}

# Testing
# -------

# before_tests = "travel_booking.install.before_tests"

# Extend DocType Class
# ------------------------------
#
# Specify custom mixins to extend the standard doctype controller.
# extend_doctype_class = {
# 	"Task": "travel_booking.custom.task.CustomTaskMixin"
# }

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
# 	"frappe.desk.doctype.event.event.get_events": "travel_booking.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
# 	"Task": "travel_booking.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Ignore links to specified DocTypes when deleting documents
# -----------------------------------------------------------

# ignore_links_on_delete = ["Communication", "ToDo"]

# Request Events
# ----------------
# before_request = ["travel_booking.utils.before_request"]
# after_request = ["travel_booking.utils.after_request"]

# Job Events
# ----------
# before_job = ["travel_booking.utils.before_job"]
# after_job = ["travel_booking.utils.after_job"]

# after_file_upload = ["travel_booking.utils.after_file_upload"]

# User Data Protection
# --------------------

# user_data_fields = [
# 	{
# 		"doctype": "{doctype_1}",
# 		"filter_by": "{filter_by}",
# 		"redact_fields": ["{field_1}", "{field_2}"],
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_2}",
# 		"filter_by": "{filter_by}",
# 		"partial": 1,
# 	},
# 	{
# 		"doctype": "{doctype_3}",
# 		"strict": False,
# 	},
# 	{
# 		"doctype": "{doctype_4}"
# 	}
# ]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
# 	"travel_booking.auth.validate"
# ]

# Automatically update python controller files with type annotations for this app.
export_python_type_annotations = True

# Require all whitelisted methods to have type annotations
require_type_annotated_api_methods = True

# default_log_clearing_doctypes = {
# 	"Logging DocType Name": 30  # days to retain logs
# }

# Translation
# ------------
# List of apps whose translatable strings should be excluded from this app's translations.
# ignore_translatable_strings_from = []