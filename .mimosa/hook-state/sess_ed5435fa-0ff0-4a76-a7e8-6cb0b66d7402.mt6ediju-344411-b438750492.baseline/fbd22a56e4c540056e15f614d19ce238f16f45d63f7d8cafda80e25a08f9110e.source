# travel_booking/api/so_helpers.py
#
# Helper-helper berkaitan Sales Order (SO), Customer, Payment Entry,
# dan auto-invoice. Semua fungsi di sini INTERNAL (tiada @whitelist)
# — dipanggil oleh booking_engine.py dan email_service.py sahaja.
#
# Modul ni TIDAK import email_service.py (elak circular import) —
# booking_engine.py yang jadi "orchestrator" yang panggil kedua-duanya.

import frappe

from travel_booking.api._helpers import get_company_currency
from travel_booking.api.constants import TRAVEL_ITEM_CODE


# ══════════════════════════════════════════════
# SO RESOLUTION (Booking <-> Sales Order link)
# ══════════════════════════════════════════════

def _resolve_booking_from_so(so_name):
    """Cari nama Booking yang berkaitan dengan SO ni, terus melalui
    Sales Order.custom_booking. Pulang None kalau tiada kaitan.
    """
    return frappe.db.get_value("Sales Order", so_name, "custom_booking")


def _get_all_booking_sales_orders(booking_name, include_cancelled=False):
    """Semua SO yang berkaitan booking ni, melalui Sales Order.custom_booking
    (satu-satunya sumber rujukan — utama dan addon setara secara struktur).
    Secara default, SO Cancelled (docstatus=2) DIKECUALIKEN — supaya tak
    masuk kiraan Total/Payment Status/booking_status/waterfall allocation.
    Guna include_cancelled=True HANYA untuk paparan UI (transparency),
    bukan untuk logic status atau pembayaran.
    """
    filters = {"custom_booking": booking_name}
    if not include_cancelled:
        filters["docstatus"] = ["!=", 2]
    return frappe.get_all("Sales Order", filters=filters, pluck="name")


def _get_primary_so(booking_name):
    """SO 'utama' (cabin booking asal) — ditakrif sebagai SO PERTAMA yang
    dicipta untuk booking ni (creation paling awal), bukan field berasingan.
    Ini gantikan Booking.sales_order sepenuhnya — one-to-many standard
    (Sales Order.custom_booking → Booking), bukan rujukan dua-hala.
    """
    return frappe.db.get_value(
        "Sales Order", {"custom_booking": booking_name},
        "name", order_by="creation asc"
    )


def _compute_payment_status(paid, total):
    """Kira nilai Payment Status (field 'payment_status' pada Booking, BUKAN
    virtual) dari jumlah dibayar vs jumlah keseluruhan SO. Refund status
    (Request Refund/Pending Refund/Refunded) TIDAK dikira di sini — ia
    ditetapkan secara berasingan melalui proses cancel/refund (rujuk
    _cancel_booking_cascade dan proses refund manual admin).
    """
    if paid <= 0:
        return "Pending"
    elif paid >= total - 0.001:
        return "Paid"
    return "Partially Paid"


# ══════════════════════════════════════════════
# CUSTOMER CREATION
# ══════════════════════════════════════════════

def _find_customer_by_email_raw(email):
    """Cari Customer name melalui email — query terus ke DB tanpa bergantung
    pada get_customer_by_email() (yang mungkin ada logic tambahan/cache yang
    menyebabkan ia gagal jumpa Customer yang sebenarnya wujud).

    Return: customer name (str) atau None.
    """
    result = frappe.db.sql("""
        SELECT dl.link_name
        FROM `tabContact Email` ce
        INNER JOIN `tabDynamic Link` dl ON dl.parent = ce.parent AND dl.parenttype = 'Contact'
        WHERE ce.email_id = %s AND dl.link_doctype = 'Customer'
        LIMIT 1
    """, email)
    return result[0][0] if result else None


def _create_customer(billing):
    email = billing.get("email")

    # Cuba cari Customer sedia ada untuk email ni dulu — elakkan
    # DuplicateEntryError kalau Customer dah wujud (cth: dicipta manual
    # di Desk, atau get_customer_by_email() gagal jumpa sebab Contact
    # link putus). Kalau dah ada, guna semula.
    existing = _find_customer_by_email_raw(email) if email else None
    if existing:
        return existing

    customer = frappe.get_doc({
        "doctype":        "Customer",
        "customer_name":  billing.get("full_name"),
        "customer_type":  "Individual",
        "customer_group": frappe.db.get_single_value(
                            "Selling Settings", "customer_group") or "Individual",
        "territory":      frappe.db.get_single_value(
                            "Selling Settings", "territory") or "All Territories",
    })
    try:
        customer.insert(ignore_permissions=True)
    except frappe.DuplicateEntryError:
        # Race condition: Customer baru sahaja dicipta oleh request lain
        # (ataupun wujud tapi lookup atas gagal jumpa). Return yang sedia ada.
        frappe.clear_messages()
        existing = _find_customer_by_email_raw(email)
        if existing:
            return existing
        raise  # re-raise if we still can't find it

    # FIX: Check if Contact already exists for this email before creating
    # Prevents race condition/deadlock with Frappe's standard create_contact
    # background job which also tries to create Contact after User signup.
    # Only create Contact here if one doesn't already exist for this email.
    existing_contact = frappe.db.sql("""
        SELECT parent FROM `tabContact Email`
        WHERE email_id = %s AND parenttype = 'Contact'
        LIMIT 1
    """, email) if email else []

    if not existing_contact:
        try:
            contact = frappe.get_doc({
                "doctype":    "Contact",
                "first_name": billing.get("full_name"),
                "email_ids":  [{"email_id": email, "is_primary": 1}],
                "phone_nos":  [{"phone": billing.get("phone"), "is_primary_phone": 1}],
                "links":      [{"link_doctype": "Customer", "link_name": customer.name}],
            })
            contact.insert(ignore_permissions=True)
        except (frappe.QueryDeadlockError, frappe.db.InternalError) as e:
            # Race with Frappe's create_contact BG job — let it handle this.
            # Also catches raw MariaDB deadlock/timeout (errno 1213/1205/1020).
            pass

    return customer.name


def _ensure_customer_company_currency(customer_name):
    """Pastikan Customer.default_currency = company currency.

    Model app: SEMUA transaksi jualan/booking dalam COMPANY CURRENCY
    (harga pakej disimpan & dimasukkan dalam company currency; paparan
    currency lain diuruskan di layer display converter frontend). Jadi
    setiap customer travel_booking patutpunya default_currency = company
    currency. Kalau terisi lain (cth di-set manual di Desk dari model
    multi-currency lama), betulkan semula ke company currency + log untuk
    audit (bukan senyap — perubahan data manual admin patut nampak).

    Dipanggil dalam confirm_booking() SEBELUM SO dicipta. SO set
    currency=company_currency & conversion_rate=1.0 secara eksplisit
    jua, jadi ini cuma penjajar data customer (bukan gate kritikal).
    """
    if not customer_name:
        return
    company_currency = get_company_currency()
    current = frappe.db.get_value("Customer", customer_name, "default_currency")
    if current == company_currency:
        return
    frappe.db.set_value(
        "Customer", customer_name, "default_currency", company_currency, update_modified=False
    )
    if current:
        frappe.log_error(
            "Customer '" + str(customer_name) + "' had default_currency='" +
            str(current) + "' (likely set manually in Desk under the legacy "
            "multi-currency model). It was reset to company currency '" +
            str(company_currency) + "' — all travel_booking transactions are "
            "now in company currency (display-only currency conversion happens "
            "in the frontend converter, not in accounting).",
            "Customer Currency Reset to Company"
        )


# ══════════════════════════════════════════════
# SALES ORDER ITEMS
# ══════════════════════════════════════════════

def _build_so_items(selections, pricing_map, trip_name="", group_label="", is_cruise=True):
    """Bina SO items dengan harga dari backend pricing_map.

    Cruise (is_cruise=True) — model SLOT (posisi bilik): Main Guest
    (single/twin) / Extra Bed / Infant. Harga ditentukan SLOT.
    Non-cruise (is_cruise=False) — model UMUR: Adult (price_adult) /
    Children (price_children) / Infant (price_infant), flat per pax (tiada
    single supplement). Field payload {main_guests, extra_beds, infants}
    sama — hanya field harga + label pax_type berbeza.
    """
    items        = []
    default_item = _get_or_create_travel_item()

    for cabin_no, sel in enumerate(selections, start=1):
        room_category = sel.get("room_category")
        main_guests   = int(sel.get("main_guests", 0))
        extra_beds    = int(sel.get("extra_beds", 0))
        infants       = int(sel.get("infants", 0))

        price = pricing_map.get(room_category)
        if not price:
            frappe.throw("Price not found for category: " + str(room_category))

        if is_cruise:
            if main_guests == 1:
                items.append(_so_line(default_item, room_category, "Main Guest (Single)",
                                      1, float(price.price_adult_single or 0),
                                      trip_name, group_label, cabin_no))
            elif main_guests >= 2:
                items.append(_so_line(default_item, room_category, "Main Guest",
                                      main_guests, float(price.price_adult or 0),
                                      trip_name, group_label, cabin_no))
            if extra_beds > 0:
                items.append(_so_line(default_item, room_category, "Extra Bed",
                                      extra_beds, float(price.price_upperberth or 0),
                                      trip_name, group_label, cabin_no))
        else:
            # Non-cruise: flat per pax, tiada single supplement.
            if main_guests > 0:
                items.append(_so_line(default_item, room_category, "Adult",
                                      main_guests, float(price.price_adult or 0),
                                      trip_name, group_label, cabin_no))
            if extra_beds > 0:
                items.append(_so_line(default_item, room_category, "Children",
                                      extra_beds, float(price.price_children or 0),
                                      trip_name, group_label, cabin_no))
        if infants > 0:
            items.append(_so_line(default_item, room_category, "Infant",
                                  infants, float(price.price_infant or 0),
                                  trip_name, group_label, cabin_no))
    return items


def _so_line(item_code, room_category, pax_type, qty, rate, trip_name, group_label, cabin_no=1):
    cabin_tag = "Cabin " + str(cabin_no)
    return {
        "item_code":   item_code,
        "item_name":   room_category + " (" + cabin_tag + ") \u2014 " + pax_type,
        "qty":         qty,
        "rate":        rate,
        "uom":         "Nos",
        "description": trip_name + " | " + group_label + " | " + room_category + " | " + cabin_tag + " | " + pax_type,
    }


def _get_or_create_travel_item(item_code=None, item_name=None):
    """item_code/item_name opsyenal — default kekal TRAVEL_ITEM_CODE (cabin
    booking, backward-compat penuh dengan semua caller sedia ada yang panggil
    tanpa argument). Dipanggil dengan ADDON_ITEM_CODE/INSURANCE_ITEM_CODE
    oleh api/addon_manager.py supaya laporan jualan admin boleh split ikut
    jenis item (rujuk constants.py).
    """
    item_code = item_code or TRAVEL_ITEM_CODE
    if frappe.db.exists("Item", item_code):
        return item_code

    frappe.get_doc({
        "doctype":                       "Item",
        "item_code":                     item_code,
        "item_name":                     item_name or item_code,
        "item_group":                    "Services",
        "stock_uom":                     "Nos",
        "is_stock_item":                 0,
        "is_sales_item":                 1,
        "include_item_in_manufacturing": 0,
    }).insert(ignore_permissions=True)
    return item_code


# ══════════════════════════════════════════════
# SO CURRENCY + CONVERSION RATE (shared resolver)
# ══════════════════════════════════════════════

def _resolve_so_currency_and_rate(currency=None):
    """Kembalikan (currency, conversion_rate) untuk cipta Sales Order.

    Keputusan senibina: SEMUA SO (booking utama + addon) dalam COMPANY
    CURRENCY dengan conversion_rate=1.0. Harga pakej/addon disimpan &
    dimasukkan dalam company currency; paparan currency lain diuruskan di
    layer display converter frontend, BUKAN di SO/accounting. Argumen
    `currency` dikekalkan (backward-compat caller sedia ada, cth
    api/addon_manager.py) tetapi diabaikan — sentiasa pulangkan company
    currency. Ini juga membuang kebergantungan pada rekod Currency Exchange
    untuk penciptaan SO: booking TIDAK gagal walaupun rate exchange belum
    diisi admin (rate hanya diperlukan untuk DISPLAY converter).
    """
    company_currency = get_company_currency()
    return company_currency, 1.0


# ══════════════════════════════════════════════
# CABIN LAYOUT (from Sales Order)
# ══════════════════════════════════════════════

def _cabin_layout_from_so(so_name):
    """Susunan cabin dari SO items (SO = sumber tunggal), ikut turutan cabin.
    description: 'Trip | Group Label | Room Category | Cabin N | Pax Type'.
    Return: [{cabin_no, room_category, pax, pax_breakdown}] disusun ikut
    cabin_no. pax_breakdown = {"Main Guest": 2, "Extra Bed": 1, ...} —
    pecahan pax_type SEBENAR yang customer beli untuk cabin ni, perlu
    untuk isi cabin_no/pax_type pada setiap Booking Reservation individu
    (rujuk _activate_booking()). 'pax' (jumlah keseluruhan) dikekalkan
    untuk backward compat dengan caller sedia ada (portal_booking.py
    Pass 2 grouping) yang cuma perlukan kuantiti, bukan breakdown.
    """
    items = frappe.db.get_all("Sales Order Item",
                              filters={"parent": so_name},
                              fields=["description", "qty"], order_by="idx")
    layout = {}
    for it in items:
        parts = (it.description or "").split(" | ")
        if len(parts) < 5:
            continue
        room_category = parts[2].strip()
        cabin_tag     = parts[3].strip()
        pax_type      = parts[4].strip()

        if pax_type == "Main Guest (Single)":
            pax_type = "Main Guest"

        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if cabin_no not in layout:
            layout[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category, "pax": 0, "pax_breakdown": {}}
        qty = int(it.qty or 0)
        layout[cabin_no]["pax"] += qty
        layout[cabin_no]["pax_breakdown"][pax_type] = layout[cabin_no]["pax_breakdown"].get(pax_type, 0) + qty
    return [layout[n] for n in sorted(layout.keys())]


def _activate_booking(booking_name):
    """Cipta Booking Reservation (status Confirmed) bila booking Confirmed.
    Idempotent. Reservation dicipta dengan room_category + cabin_no +
    pax_type terisi (bukan cuma room_category macam sebelum ni) — setiap
    slot individu terus tahu cabin & jenis pax dia dari mula, konsisten
    dengan apa customer beli di SO, dan sepadan dengan validate() capacity
    check baharu (rujuk booking_reservation.py) yang bergantung pada
    field-field ni. flight & stateroom_no tetap admin assign kemudian.
    Cabin layout diambil dari SO UTAMA (cabin booking asal), bukan addon SO.
    """
    if frappe.db.count("Booking Reservation", {"booking": booking_name}):
        return 0
    so_name = _get_primary_so(booking_name)
    if not so_name:
        return 0
    # is_a_cruise diwarisi dari Booking (field is_a_cruise_trip, fetch_from
    # trip_date.is_a_cruise_trip) supaya validate_cabin_capacity tahu model
    # mana (slot vs umur) yang perlu dipakai pada rekod Booking Reservation ni.
    is_cruise = bool(frappe.db.get_value("Booking", booking_name, "is_a_cruise_trip"))
    count = 0
    for cabin in _cabin_layout_from_so(so_name):
        # room_category datang dari TEKS description SO Item (rujuk
        # _cabin_layout_from_so) — snapshot dibekukan masa booking dicipta,
        # BUKAN Link live. Bila admin rename Trip Price Category terus di DB
        # (bukan via Frappe rename_doc, yang cascade ke semua rujukan Link),
        # teks description SO Item kekal nama LAMA → validate_links() throw
        # "Could not find Room Category: <nama lama>" LinkValidationError semasa
        # insert reservation ni. Kerana _activate_booking dipanggil dari hook
        # on_payment_entry_submit (semasa Payment Entry submit), exception ni
        # akan MENGROLL-BACK seluruh submit Payment Entry → bayaran customer
        # tak direkodkan walhal Stripe dah berjaya. Validasi di sini + skip
        # cabin bermasalah supaya bayaran tetap direkodkan; admin fix data
        # (rename balik ATAU kemaskini description SO Item) dan cipta reservation
        # manual. (Bukan truncate keseluruhan — cabin yang sah masih dicipta.)
        rc = cabin.get("room_category")
        if rc and not frappe.db.exists("Trip Price Category", rc):
            frappe.log_error(
                "Booking " + str(booking_name) + " (SO " + str(so_name) +
                ", Cabin " + str(cabin.get("cabin_no")) + "): room_category '" +
                str(rc) + "' dari SO Item description tidak wujud dalam Trip "
                "Price Category (kemungkinan telah direname terus di DB). "
                "Reservation untuk cabin ini di-skip supaya bayaran tetap "
                "direkodkan. Betulkan data dan cipta reservation manual.",
                "Booking Reservation - Stale Room Category"
            )
            continue
        for pax_type, qty in cabin.get("pax_breakdown", {}).items():
            for _ in range(int(qty)):
                frappe.get_doc({
                    "doctype":         "Booking Reservation",
                    "booking":         booking_name,
                    "room_category":   cabin.get("room_category"),
                    "cabin_no":        cabin.get("cabin_no"),
                    "pax_type":        pax_type,
                    "is_a_cruise":     is_cruise,
                    "status":          "Confirmed",
                    "document_status": "Pending",
                }).insert(ignore_permissions=True)
                count += 1
    return count


# ══════════════════════════════════════════════
# PAYMENT ENTRY (Manual Transfer)
# ══════════════════════════════════════════════

def _create_manual_payment_entry(so_name, customer_name, amount, receipt_data="", label="receipt", bank_transfer_ref=""):
    """Manual transfer — cipta Payment Entry DRAFT + attach resit.
    Draft (docstatus 0) = menunggu admin verify & submit. Corak sama dgn portal.
    """
    import base64
    from erpnext.accounts.party import get_party_account

    so = frappe.db.get_value("Sales Order", so_name, ["company", "currency"], as_dict=True)
    if not so:
        return None

    original_user = frappe.session.user
    frappe.set_user("Administrator")
    try:
        company = so.company or frappe.db.get_single_value("Global Defaults", "default_company")
        paid_to = None
        travel_settings = frappe.get_cached_doc("Travel Settings")
        for row in (travel_settings.get("currency_accounts") or []):
            if row.currency == so.currency and row.manual_transfer_paid_to_account:
                paid_to = row.manual_transfer_paid_to_account
                break
        if not paid_to:
            frappe.log_error(
                "Manual Transfer paid_to account not configured for currency '" +
                str(so.currency) + "' (SO " + so_name + "). Using fallback to the " +
                "first Bank-type Account for the company — please configure it in " +
                "Travel Settings > Multi Currency Account.",
                "Manual Transfer - Currency Account Missing"
            )
            paid_to = frappe.db.get_value("Account",
                {"account_type": "Bank", "company": company, "is_group": 0}, "name")
        party_account = get_party_account("Customer", customer_name, company)

        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        pe.posting_date    = frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = customer_name
        pe.party_account   = party_account
        pe.paid_from       = party_account
        pe.paid_to         = paid_to
        pe.paid_amount     = float(amount)
        pe.received_amount = float(amount)
        pe.reference_no    = bank_transfer_ref or so_name
        pe.reference_date  = frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "allocated_amount":  float(amount),
        })
        pe.remarks = "Manual transfer (booking) for " + so_name + \
                     (". Ref: " + bank_transfer_ref if bank_transfer_ref else "") + \
                     ". Pending verification."
        pe.insert(ignore_permissions=True)

        if receipt_data:
            ext = ".png"
            if receipt_data.startswith("data:"):
                head = receipt_data.split(",")[0]
                if "pdf" in head:
                    ext = ".pdf"
                elif "jpeg" in head or "jpg" in head:
                    ext = ".jpg"
                elif "png" in head:
                    ext = ".png"
                receipt_data = receipt_data.split(",")[1]
            file_content = base64.b64decode(receipt_data)
            frappe.get_doc({
                "doctype":             "File",
                "file_name":           label + ext,
                "attached_to_doctype": "Payment Entry",
                "attached_to_name":    pe.name,
                "is_private":          1,
                "content":             file_content
            }).insert(ignore_permissions=True)
        return pe.name
    except Exception as e:
        frappe.log_error("Manual payment entry (booking) failed: " + str(e), "Manual PE Error")
        return None
    finally:
        frappe.set_user(original_user)


def _create_payment_url(customer_name, so_name, amount, booking_number):
    """Cipta Payment Intent (checkout kita sendiri) untuk online payment.
    Redirect selepas bayar dikawal oleh checkout.html -> balik ke wizard step Confirm.
    Status bayaran sebenar ditentukan oleh webhook (stripe_checkout.stripe_webhook),
    bukan redirect ini.
    """
    try:
        from travel_booking.api.stripe_checkout import create_payment_intent
        result = create_payment_intent(
            sales_order=so_name,
            amount=amount,
            source="wizard",
            booking_number=booking_number,
        )
        return result.get("checkout_url", "")
    except Exception as e:
        frappe.log_error("Payment checkout creation failed: " + str(e), "Payment URL Error")
        return ""


# ══════════════════════════════════════════════
# AUTO-INVOICE (per-SO, on fully paid)
# ══════════════════════════════════════════════

def _maybe_auto_invoice_so(so_name):
    """Auto-cipta Sales Invoice untuk SO ni sebaik ia fully paid (per-SO
    independent — TIDAK tunggu SO lain untuk booking yang sama settle
    sekali). Guna mekanisme ERPNext standard 'Get Advances Received' yang
    SAMA dengan yang admin guna manual (rujuk portal_payment.py punya
    nota tentang mekanisme ni) — supaya SEMUA Payment Entry sedia ada
    (deposit + baki, kalau berasingan) betul-betul di-allocate ke invois
    baharu, bukan reka logik allocation sendiri.

    Auto-invoice kegagalan TIDAK patahkan flow payment/booking — dibungkus
    try/except, log error untuk admin siasat/generate manual sebagai
    fallback, sebab bayaran & status booking dah SAH walau invois gagal
    auto-generate.
    """
    so = frappe.db.get_value(
        "Sales Order", so_name,
        ["grand_total", "advance_paid", "docstatus"], as_dict=True
    )
    if not so or so.docstatus != 1:
        return

    so_payment_status = _compute_payment_status(so.advance_paid or 0, float(so.grand_total or 0))
    if so_payment_status != "Paid":
        return

    existing_si = frappe.db.sql("""
        SELECT sii.parent
        FROM `tabSales Invoice Item` sii
        JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE sii.sales_order = %s AND si.docstatus != 2
        LIMIT 1
    """, so_name)
    existing_si = existing_si[0][0] if existing_si else None
    if existing_si:
        return

    try:
        from erpnext.selling.doctype.sales_order.mapper import make_sales_invoice

        _original_user = frappe.session.user
        frappe.set_user("Administrator")
        try:
            si = make_sales_invoice(so_name)
            si.flags.ignore_permissions = True
            si.set_posting_time = 1
            si.posting_date = frappe.utils.today()

            si.set_advances()

            # SO sentiasa company currency (conversion_rate=1) sekarang, jadi
            # expected_total = advance_paid terus — tiada lagi cabang
            # party_account_currency vs company_currency (semua converge ke
            # advance_paid * 1). allocated_amount juga dalam company currency.
            allocated_total = sum(float(a.allocated_amount or 0) for a in (si.advances or []))
            expected_total = float(so.advance_paid or 0)

            if abs(allocated_total - expected_total) > 0.01:
                frappe.log_error(
                    "Auto-invoice: set_advances() failed to allocate ALL payments "
                    "for SO " + so_name + " — expected " + str(expected_total) +
                    ", but only allocated " + str(allocated_total) +
                    "). SI NOT submitted (left as draft/not created) — requires manual "
                    "investigation (check Payment Entry party/currency for this SO) before "
                    "generating the invoice manually.",
                    "Auto Sales Invoice - Advance Mismatch"
                )
                return

            si.insert(ignore_permissions=True)
            si.submit()
        finally:
            frappe.set_user(_original_user)

    except Exception as e:
        frappe.log_error(
            "Auto-invoice failed for SO " + so_name + ": " + str(e),
            "Auto Sales Invoice Error"
        )