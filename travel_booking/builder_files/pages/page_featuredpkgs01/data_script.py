# Featured packages (server-render) — frappe.call ke API whitelisted
try:
    out = frappe.call(
        "travel_booking.utils.featured_catalog.api_featured_packages",
        vertical="cruise", limit=12)
    data.packages = (out or {}).get("packages") or []
except Exception:
    data.packages = []
