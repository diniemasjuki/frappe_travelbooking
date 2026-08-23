app_name = "travel_booking"
app_title = "Travel Booking Management"
app_publisher = "WargaPrihatin"
app_description = "Manage Traveller Booking Information"
app_email = "contact@rpwp.my"
app_license = "mit"

# Send non-GET requests for this app's endpoints as native `application/json`
# bodies instead of form-encoded, per-key JSON-stringified values.
use_json_request_body = True

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


# Automatically update python controller files with type annotations for this app.
export_python_type_annotations = True

# Require all whitelisted methods to have type annotations
require_type_annotated_api_methods = True