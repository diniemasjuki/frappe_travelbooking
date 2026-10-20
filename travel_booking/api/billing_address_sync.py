# travel_booking/api/billing_address_sync.py
#
# Sync dua-hala antara snapshot billing address pada Booking (cust_*) dan
# Address 'Billing' (primary) yang di-link ke Customer. SATU sumber
# kebenaran alamat billing ialah doctype Address — dokumen bil (Sales
# Order/invois) sentiasa tarik dari situ; medan cust_* pada Booking ialah
# cermin yang disegerak supaya export dari Booking sentiasa sepadan dengan
# alamat yang digunakan untuk billing.
#
#   ARAH 1 — Address.on_update → Booking (on_billing_address_update):
#     Alamat Billing customer berubah (edit admin di Desk, atau customer
#     booking semula di wizard dengan alamat baru) → cust_* SEMUA booking
#     aktif customer itu dikemas kini (kecuali Cancelled).
#
#   ARAH 2 — Booking.on_update → Address (on_booking_billing_address_update):
#     Admin betulkan cust_* di Booking → Address customer di-upsert;
#     invois SETERUSNYA terus guna nilai baharu.
#
#   INVOIS YANG DAH SUBMIT TIDAK DISentuh — ERPNext membekukan
#   address_display semasa invois disubmit; keperluan perakaunan (keputusan
#   produk: sync hanya Booking ↔ Address, dokumen kewangan terlanjur kekal).
#
# TIADA GELUNG: arah 1 menulis booking melalui frappe.db.set_value yang
# TIDAK memicu doc_events, dan arah 2 hanya berjalan bila cust_* Booking
# benar-benar berubah berbanding doc_before_save — kedua-dua guard itu
# memutus kitaran Address→Booking→Address secara deterministik.

import frappe

from travel_booking.api.so_helpers import _upsert_customer_billing_address

# Pasangan medan searah: (medan Address, medan snapshot Booking)
ADDRESS_FIELDS = ("address_line1", "city", "pincode", "state", "country")
BOOKING_FIELDS = ("cust_address_line1", "cust_city", "cust_postcode", "cust_state", "cust_country")


def _customer_links(address_doc):
    """Customer yang di-link pada dokumen Address ini (Dynamic Link rows)."""
    return [
        link.link_name
        for link in (address_doc.get("links") or [])
        if link.link_doctype == "Customer" and link.link_name
    ]


def _address_values(address_doc):
    """Nilai dokumen Address dalam bentuk medan snapshot Booking."""
    return {
        "cust_address_line1": (address_doc.get("address_line1") or "").strip(),
        "cust_city": (address_doc.get("city") or "").strip(),
        "cust_postcode": (address_doc.get("pincode") or "").strip(),
        "cust_state": (address_doc.get("state") or "").strip(),
        "cust_country": address_doc.get("country") or "",
    }


def on_billing_address_update(doc, method=None):
    """Hook Address.on_update — sebar alamat Billing terkini ke booking.

    Hanya address_type 'Billing' yang di-link ke Customer; hanya bila
    nilai alamat benar-benar berubah (save dokumen atas sebab lain —
    rename title dsb. — tidak mencetus penulisan booking). Address yang
    di-disable tidak disebarkan.
    """
    if doc.address_type != "Billing" or doc.get("disabled"):
        return
    customers = _customer_links(doc)
    if not customers:
        return

    old = doc.get_doc_before_save()
    if old is not None and all(
        (getattr(old, field, None) or "") == (getattr(doc, field, None) or "")
        for field in ADDRESS_FIELDS
    ):
        return  # alamat tidak berubah

    values = _address_values(doc)
    bookings = frappe.get_all(
        "Booking",
        filters={"status": ("!=", "Cancelled")},
        or_filters=[
            ["customer", "in", customers],
            ["end_customer", "in", customers],
        ],
        pluck="name",
    )
    if bookings:
        # db.set_value TIDAK memicu doc_events Booking — gelung terputus
        # di sini (arahan 2 tidak akan berjalan balik).
        frappe.db.set_value("Booking", {"name": ("in", bookings)}, values)


def on_booking_billing_address_update(doc, method=None):
    """Hook Booking.on_update — tulis balik cust_* ke Address customer.

    Hanya berjalan bila sekurang-kurangnya satu medan cust_* berubah
    berbanding doc_before_save (simpan booking untuk tukar status dll.
    tidak menyentuh Address). Customer sasaran ikut entiti bil yang sama
    dengan confirm_booking(): end_customer (B2B) jika ada, else customer.
    """
    old = doc.get_doc_before_save()
    if old is not None and all(
        (getattr(old, field, None) or "") == (getattr(doc, field, None) or "")
        for field in BOOKING_FIELDS
    ):
        return

    # Booking LANGSUNG tiada alamat (cth. ciptaan Desk/import tanpa alamat)
    # → tiada apa untuk sync; JANGAN paksa upsert dengan nilai kosong
    # (Country wajib pada Address — upsert kosong hanya akan throw dan
    # menyekat simpanan booking).
    if not any(
        (getattr(doc, field, None) or "").strip() for field in BOOKING_FIELDS
    ):
        return

    customer = doc.get("end_customer") or doc.get("customer")
    if not customer:
        return

    addr_name = _upsert_customer_billing_address(customer, {
        "address_line1": doc.get("cust_address_line1") or "",
        "city":           doc.get("cust_city") or "",
        "postcode":       doc.get("cust_postcode") or "",
        "state":          doc.get("cust_state") or "",
        "country":        doc.get("cust_country") or "",
    })

    # Normalisasi balik ke nilai canonical yang tersimpan pada Address
    # (cth. "malaysia" ditaip manual di Booking → "Malaysia" canonical
    # Country) supaya export Booking sentiasa sepadan dengan Address.
    # db.set_value TIDAK memicu doc_events — tiada gelung.
    addr = frappe.db.get_value("Address", addr_name, list(ADDRESS_FIELDS), as_dict=True)
    updates = {}
    for booking_field, address_field in zip(BOOKING_FIELDS, ADDRESS_FIELDS):
        canonical = (getattr(addr, address_field, None) or "") if addr else ""
        if (getattr(doc, booking_field, None) or "") != canonical:
            updates[booking_field] = canonical
            setattr(doc, booking_field, canonical)
    if updates:
        frappe.db.set_value("Booking", doc.name, updates, update_modified=False)
