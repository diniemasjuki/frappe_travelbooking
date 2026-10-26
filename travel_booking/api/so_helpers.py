# travel_booking/api/so_helpers.py
#
# Helper-helper berkaitan Sales Order (SO), Customer, Payment Entry,
# dan auto-invoice. Semua fungsi di sini INTERNAL (tiada @whitelist)
# — dipanggil oleh booking_engine.py dan email_service.py sahaja.
#
# Modul ni TIDAK import email_service.py (elak circular import) —
# booking_engine.py yang jadi "orchestrator" yang panggil kedua-duanya.

import frappe
from frappe import _
from frappe.utils import getdate

from travel_booking.api._helpers import get_company_currency
from travel_booking.api.constants import TRAVEL_ITEM_CODE
from travel_booking.utils.upload_normalize import _decode_and_normalize_upload


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
    # PENTING: kalau Contact dah wujud (cth dijana automatik oleh Frappe
    # semasa signup Google Social Login), JANGAN sekadar skip — Contact
    # tu tiada link Customer, dan tanpa link get_customer_by_email()
    # pulangkan None → customer TAK NAMPAK booking mereka dalam portal
    # /traveller (_get_customer() throw PermissionError). Append link
    # Customer ke Contact sedia ada.
    existing_contact = frappe.db.sql("""
        SELECT parent FROM `tabContact Email`
        WHERE email_id = %s AND parenttype = 'Contact'
        LIMIT 1
    """, email) if email else []

    if existing_contact:
        _ensure_contact_customer_link(existing_contact[0][0], customer.name)
    else:
        try:
            contact = frappe.get_doc({
                "doctype":    "Contact",
                "first_name": billing.get("full_name"),
                "email_ids":  [{"email_id": email, "is_primary": 1}],
                "phone_nos":  [{"phone": billing.get("phone"), "is_primary_phone": 1}],
                "links":      [{"link_doctype": "Customer", "link_name": customer.name}],
            })
            contact.insert(ignore_permissions=True)
        except (frappe.QueryDeadlockError, frappe.db.InternalError):
            # Race with Frappe's create_contact BG job — contact mungkin
            # sah dah wujud sekarang (job tu menang race). Pastikan link
            # Customer tetap terpasang pada contact yang wujud tu,
            # jangan biarkan putus (contact tanpa link = portal booking
            # list customer terus kosong).
            raced = frappe.db.sql("""
                SELECT parent FROM `tabContact Email`
                WHERE email_id = %s AND parenttype = 'Contact'
                LIMIT 1
            """, email)
            if raced:
                _ensure_contact_customer_link(raced[0][0], customer.name)

    return customer.name


def _ensure_contact_customer_link(contact_name, customer_name):
    """Append Dynamic Link Contact→Customer kalau tiada (idempotent).

    Contact yang dijana automatik oleh Frappe (signup Google / create_contact
    BG job) tiada sebarang link Customer. Portal resolver
    (get_customer_by_email → _get_customer) bergantung SEPENUHNYA pada link
    ni untuk padankan User login → Customer → Booking. Fungsi ni jambatan
    yang hilang: pastikan link wujud, tak kira siapa cipta Contact tu.
    """
    try:
        contact = frappe.get_doc("Contact", contact_name)
        already = any(
            l.link_doctype == "Customer" and l.link_name == customer_name
            for l in (contact.links or [])
        )
        if not already:
            contact.append("links", {
                "link_doctype": "Customer",
                "link_name":    customer_name,
            })
            contact.flags.ignore_permissions = True
            contact.save()
    except Exception:
        # Gagal memasang link TAK sepatutnya gagalkan penciptaan booking —
        # tapi kalau berlaku, customer akan hilang dari portal. Log utk
        # admin nampak & boleh patch manual (bukan senyap).
        frappe.log_error(
            title="Contact-Customer Link FAILED",
            message="Failed to link Contact {0} -> Customer {1}".format(
                contact_name, customer_name),
        )


def _upsert_customer_billing_address(customer_name, billing):
    """Cipta/KEMASKINI Address 'Billing' (primary) Customer daripada data
    billing wizard /booknow — tujuan bil (Sales Order/invois mempunyai
    alamat lengkap di Desk).

    - Alamat 'Billing' sedia ada yang di-link ke Customer ini DIKEMASKINI,
      bukan didupkan — customer yang tempah semula dengan alamat baharu
      mengemas kini rekod billing mereka (satu Address 'Billing' aktif
      per Customer).
    - is_primary_address=1 → validate_preferred_address() Frappe
      menyah-aktifkan tanda primary pada alamat lain yang di-link ke
      Customer yang sama secara automatik.
    - Country MESTI nama canonical dokumen Country (Link field) —
      frontend hantar nilai dari dropdown Country, tapi resolusi
      case-insensitive di sini melindungi panggilan terus ke API. Negara
      yang tidak dikenali menggagalkan booking (throw) berbanding
      menyimpan alamat rosak; medan lain di-trim sebelum disimpan.

    Pulangkan docname Address. Bukan endpoint — helper dalaman
    confirm_booking().
    """
    country_input = (billing.get("country") or "").strip()
    country = frappe.db.get_value("Country", country_input, "name")
    if not country and country_input:
        row = frappe.db.sql(
            "SELECT name FROM `tabCountry` "
            "WHERE lower(name) = %s OR lower(country_name) = %s LIMIT 1",
            (country_input.lower(), country_input.lower()),
        )
        country = row[0][0] if row else None
    if not country:
        if not country_input:
            frappe.throw(
                "Country is required for the billing address. "
                "Please select a valid country."
            )
        frappe.throw(
            'Country "{0}" is not recognised. Please select a valid '
            "billing address country.".format(country_input)
        )

    values = {
        "address_line1":      (billing.get("address_line1") or "").strip(),
        "city":               (billing.get("city") or "").strip(),
        "state":              (billing.get("state") or "").strip(),
        "pincode":            (billing.get("postcode") or "").strip(),
        "country":            country,
        "is_primary_address": 1,
    }

    existing = frappe.db.sql("""
        SELECT a.name
        FROM `tabAddress` a
        JOIN `tabDynamic Link` dl
          ON dl.parent = a.name AND dl.parenttype = 'Address'
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
          AND a.address_type = 'Billing' AND a.disabled = 0
        ORDER BY a.is_primary_address DESC, a.creation ASC
        LIMIT 1
    """, (customer_name,))

    if existing:
        addr = frappe.get_doc("Address", existing[0][0])
        addr.update(values)
        addr.flags.ignore_permissions = True
        addr.save()
    else:
        customer_full = (
            frappe.db.get_value("Customer", customer_name, "customer_name")
            or customer_name
        )
        addr = frappe.get_doc({
            "doctype":       "Address",
            # autoname Address menghasilkan "<title>-<address_type>" —
            # title customer SAHAJA (tanpa akhiran " - Billing") supaya
            # nama akhirnya jadi "NAMA-Billing", bukan berulang.
            "address_title": customer_full,
            "address_type":  "Billing",
            **values,
            "links": [{"link_doctype": "Customer", "link_name": customer_name}],
        })
        addr.flags.ignore_permissions = True
        addr.insert()

    # Pointer 'primary address' Customer — supaya dokumen bil & paparan
    # Desk terus guna alamat ni. Address.on_update ERPNext sync medan
    # display primary_address hanya bila pointer dah menunjuk ke Address
    # ini, jadi keduanya ditulis di sini.
    frappe.db.set_value(
        "Customer", customer_name, "customer_primary_address", addr.name
    )
    from frappe.contacts.doctype.address.address import get_address_display
    frappe.db.set_value(
        "Customer", customer_name, "primary_address",
        get_address_display(addr.as_dict()), update_modified=False,
    )
    return addr.name


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
                                      trip_name, group_label, cabin_no,
                                      room_privacy=(sel.get("room_privacy") or "")))
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


def _so_line(item_code, room_category, pax_type, qty, rate, trip_name, group_label, cabin_no=1,
             room_privacy=""):
    cabin_tag = "Cabin " + str(cabin_no)
    line = {
        "item_code":   item_code,
        "item_name":   room_category + " (" + cabin_tag + ") \u2014 " + pax_type,
        "qty":         qty,
        "rate":        rate,
        "uom":         "Nos",
        "description": trip_name + " | " + group_label + " | " + room_category + " | " + cabin_tag + " | " + pax_type,
    }
    # Room privacy pilihan customer (cruise 1 main guest sahaja) — disimpan
    # pada SO line sebagai snapshot supaya _cabin_layout_from_so() boleh
    # alirkan nilai ni ke Booking Reservation.room_privacy masa booking
    # diaktifkan (SO = sumber tunggal). Kosong untuk line lain / pilihan lama.
    if room_privacy:
        line["custom_room_privacy"] = room_privacy
    return line


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
        # ERPNext's calculate_commission() only sums base_net_amount of
        # items whose grant_commission flag is set - without this the
        # affiliate app's Nett commission base would always compute 0.
        # (The Gross base sums positive line items directly and is
        # unaffected, but the flag is set here so both bases work.)
        "grant_commission":              1,
    }).insert(ignore_permissions=True)
    return item_code


# ══════════════════════════════════════════════
# SO CURRENCY + CONVERSION RATE (shared resolver)
# ══════════════════════════════════════════════

def _resolve_so_currency_and_rate(currency=None):
	"""Kembalikan (currency, company, price_list, conversion_rate) untuk
	cipta Sales Order — model multi-company sebenar.

	Currency yang diberi (currency NATIVE pakej/addon, dari DB bukan
	payload) menentukan company yang mengeluarkan SO/bil melalui paksi
	currency (Travel Settings > Multi Currency Account). SO sentiasa
	dalam company currency company berkenaan dengan conversion_rate=1.0
	— tiada conversion accounting (bukan currency converter).

	Kalau currency tidak diberi (caller lama), jatuh balik kepada
	company default + currency company default — behavior hari ini
	kekal untuk data sedia ada.
	"""
	from travel_booking.api.currency_axis import resolve_so_currency_context
	from travel_booking.api.constants import DEFAULT_SELLING_PRICE_LIST

	if not currency:
		# Caller lama tanpa currency — company default (behavior
		# pra-multi-company). Jangan resolve ikut axis supaya laman
		# tidak bergantung pada konfigurasi axis untuk path ini.
		default_company = frappe.db.get_single_value("Global Defaults", "default_company")
		return get_company_currency(), default_company, DEFAULT_SELLING_PRICE_LIST, 1.0

	return resolve_so_currency_context(currency)


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
                              fields=["description", "qty", "rate", "custom_room_privacy"],
                              order_by="idx")
    layout = {}
    for it in items:
        parts = (it.description or "").split(" | ")
        if len(parts) < 5:
            continue
        room_category = parts[2].strip()
        cabin_tag     = parts[3].strip()
        pax_type      = parts[4].strip()

        is_single_line = (pax_type == "Main Guest (Single)")
        if is_single_line:
            pax_type = "Main Guest"

        try:
            cabin_no = int(cabin_tag.lower().replace("cabin", "").strip())
        except Exception:
            continue
        if cabin_no not in layout:
            layout[cabin_no] = {"cabin_no": cabin_no, "room_category": room_category, "pax": 0,
                                "pax_breakdown": {}, "room_privacy": "", "single_rate": None}
        qty = int(it.qty or 0)
        layout[cabin_no]["pax"] += qty
        layout[cabin_no]["pax_breakdown"][pax_type] = layout[cabin_no]["pax_breakdown"].get(pax_type, 0) + qty
        # Room privacy (pilihan customer, cruise 1 main guest) — ambil nilai
        # bukan-kosong pertama untuk cabin ni (line "Main Guest (Single)").
        if not layout[cabin_no]["room_privacy"] and it.get("custom_room_privacy"):
            layout[cabin_no]["room_privacy"] = it["custom_room_privacy"]
        # Snapshot kadar single-supplement cabin ni — diguna oleh
        # cabin_sharing.py untuk kira kredit lebihan traveller tambahan.
        if is_single_line and layout[cabin_no]["single_rate"] is None:
            layout[cabin_no]["single_rate"] = float(it.rate or 0)
    return [layout[n] for n in sorted(layout.keys())]


def _activate_booking(booking_name, force=False):
    """Cipta Booking Reservation bila booking Confirmed. Status slot
    dikira auto oleh BookingReservation.validate() ikut aliran status
    (rujuk compute_auto_status).
    Idempotent. Reservation dicipta dengan room_category + cabin_no +
    pax_type terisi (bukan cuma room_category macam sebelum ni) — setiap
    slot individu terus tahu cabin & jenis pax dia dari mula, konsisten
    dengan apa customer beli di SO, dan sepadan dengan validate() capacity
    check baharu (rujuk booking_reservation.py) yang bergantung pada
    field-field ni. flight & stateroom_no tetap admin assign kemudian.
    Cabin layout diambil dari SO UTAMA (cabin booking asal), bukan addon SO.

    'force' (hanya dari Resync & Regenerate selepas admin sahkan overwrite
    pada alert booking.js): pasang flags.skip_cabin_capacity_validation pada
    setiap slot sebelum insert — reservation diterima walaupun melepasi had
    kapasiti/mismatch cabin, atas tanggungjawab admin. Caller lain (hook
    Payment Entry, booking_engine) kekal laluan selamat tanpa force.
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
    # Alamat billing Booking → default alamat SETIAP slot reservation
    # (address_source "From Booking"). Copy SEKALI masa slot diaktifkan —
    # selepas itu admin boleh edit bebas / isi berasingan di Desk; tiada
    # sync automatik ke reservation (berbeza dari pasangan Booking ↔
    # Address customer yang sync dua-hala).
    _addr_fields = ("cust_address_line1", "cust_city", "cust_postcode",
                    "cust_state", "cust_country")
    booking_addr = frappe.db.get_value("Booking", booking_name, list(_addr_fields),
                                       as_dict=True) or {}
    has_booking_addr = any((booking_addr.get(f) or "").strip() for f in _addr_fields)
    reservation_addr = {
        "address_source":      "From Booking" if has_booking_addr else "",
        "guest_address_line1": booking_addr.get("cust_address_line1") or "",
        "guest_city":          booking_addr.get("cust_city") or "",
        "guest_postcode":      booking_addr.get("cust_postcode") or "",
        "guest_state":         booking_addr.get("cust_state") or "",
        "guest_country":       booking_addr.get("cust_country") or "",
    }
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
                title="Booking Reservation - Stale Room Category",
                message="Booking " + str(booking_name) + " (SO " + str(so_name) +
                ", Cabin " + str(cabin.get("cabin_no")) + "): room_category '" +
                str(rc) + "' dari SO Item description tidak wujud dalam Trip "
                "Price Category (kemungkinan telah direname terus di DB). "
                "Reservation untuk cabin ini di-skip supaya bayaran tetap "
                "direkodkan. Betulkan data dan cipta reservation manual.",
            )
            continue
        for pax_type, qty in cabin.get("pax_breakdown", {}).items():
            for _ in range(int(qty)):
                res = frappe.get_doc({
                    "doctype":         "Booking Reservation",
                    "booking":         booking_name,
                    "room_category":   cabin.get("room_category"),
                    "cabin_no":        cabin.get("cabin_no"),
                    "pax_type":        pax_type,
                    # Room privacy pilihan customer (snapshot SO) — "Private"
                    # / "Open Sharing". Kosong untuk booking lama / cabin
                    # multi-pax (pilihan hanya wujud untuk solo cruise).
                    "room_privacy":    cabin.get("room_privacy") or "",
                    "is_a_cruise":     is_cruise,
                    # Status auto dikira validate() ikut aliran status
                    # reservation — nilai awal ini diabaikan.
                    "status":          "Confirmed",
                    # 'Incomplete' (bukan 'Pending' — dihapus dari options
                    # bersama patch v30_traveller_status_incomplete; nilai
                    # lama menyebabkan ValidationError Select semasa insert,
                    # gagalkan penjanaan slot traveller).
                    "document_status": "Incomplete",
                    **reservation_addr,
                })
                if force:
                    res.flags.skip_cabin_capacity_validation = True
                res.insert(ignore_permissions=True)
                count += 1
    return count


# ══════════════════════════════════════════════
# CASHBACK → PAYMENT ENTRY DEDUCTION
# ══════════════════════════════════════════════

def _resolve_cashback_discount_account(company, currency):
    """Akaun Marketing Expenses untuk deduction cashback Manual Transfer,
    resolving ikut COMPANY dokumen (bukan global tunggal):

    1. Baris Travel Settings > Multi Currency Account yang match currency —
       field 'cashback_discount_account' (akaun milik company baris tu).
    2. Fallback: Travel Settings > Cashback Discount Account (global) —
       HANYA jika akaun tu milik company yang sama.

    Return None bila tiada akaun yang sah untuk company ni — caller
    bertanggungjawab log error / throw (ikut konteks: wizard boleh throw
    awal sebelum booking dicipta; portal fallback ke PE tanpa cashback).
    """
    def _account_company(acc):
        return frappe.db.get_value("Account", acc, "company")

    settings = frappe.get_cached_doc("Travel Settings")

    for row in (settings.get("currency_accounts") or []):
        acc = row.get("cashback_discount_account")
        if acc and row.get("currency") == currency and _account_company(acc) == company:
            return acc

    fallback = settings.get("cashback_discount_account")
    if fallback and _account_company(fallback) == company:
        return fallback
    return None


def _resolve_cashback_deduction(company, currency, so_name, cashback_percent, cash, gross_allocated,
                                other_deductions=0):
    """Kira baris DEDUCTION cashback Manual Transfer untuk Payment Entry.

    Model perakaunan (ERPNext Payment Entry, Receive, same-currency):
      paid_amount = received_amount = CASH sebenar customer transfer (net)
      references.allocated_amount = bahagian GROSS SO yang dibetulkan
      deductions.account          = Marketing Expenses company tersebut
      deductions.amount           = bahagian cashback (debit expense)

    ERPNext mewajibkan received + deductions = allocated (difference_amount
    mesti 0 semasa submit) — kombinasi di atas mengekalkan baki tu. Sebab
    tu SO cashback/discount KEKAL GROSS: kalau SO sudah di-discount (net),
    tiada gap untuk deduction menyerap dan PE mesti tidak seimbang.

    'other_deductions' ialah jumlah baris deduction LAIN dalam PE yang sama
    (cth diskaun voucher/referral order-level) — ditolak daripada jurang
    (gross_allocated − cash) supaya yang tinggal untuk cashback tepat.

    Return dict baris deductions ({account, amount, cost_center, description})
    — siap untuk pe.append("deductions", row) — atau None bila tidak layak /
    akaun tidak ditemui; caller WAJIB fallback allocate cash sahaja (behavior
    lama) supaya PE tetap seimbang; error di-log untuk admin.
    """
    cashback_amount = round(float(gross_allocated) - float(cash) - float(other_deductions or 0), 2)
    if cashback_amount <= 0:
        return None

    account = _resolve_cashback_discount_account(company, currency)
    if not account:
        frappe.log_error(
            title="Manual Transfer Cashback - Account Missing",
            message="Cashback deduction SKIPPED for manual Payment Entry against SO " +
            str(so_name) + " (company " + str(company) + ", currency " +
            str(currency) + "): no Cashback Discount Account configured for "
            "this company in Travel Settings (Multi Currency Account row or "
            "global fallback). Payment Entry will allocate the transferred "
            "amount without cashback — configure the account and adjust the "
            "draft PE before submitting.",
        )
        return None

    # ERPNext v17: Payment Entry Deduction.cost_center adalah wajib (reqd) —
    # guna cost center default company.
    return {
        "account":     account,
        "amount":      cashback_amount,
        "cost_center": frappe.db.get_value("Company", company, "cost_center"),
        "description": "Manual Transfer Cashback " + str(cashback_percent) + "%",
    }


# ══════════════════════════════════════════════
# DISKAUN ORDER-LEVEL (voucher/referral) → PE DEDUCTION
# ══════════════════════════════════════════════
# SO booking KEKAL GROSS (semua baris item rate positif — tiada pergantungan
# pada Selling Settings > Allow Negative rates). Jumlah diskaun voucher/
# referral disimpan pada BOOKING (voucher_discount / referral_discount,
# diakses melalui Sales Order.custom_booking) dan diserap sebagai baris
# DEDUCTION (debit) ke akaun Marketing Expenses company tersebut pada
# Payment Entry.
#
# Kelayakan CASHBACK Manual Transfer pula TRANSAKSIONAL — tidak disimpan
# pada mana-mana dokumen. Ia dibaca semasa bayaran: Booking.checkout_method
# (kaedah bayaran semasa checkout) == "Manual Transfer" DAN promosi masih
# aktif di Travel Settings, DAN bukan saluran B2B (harga net kontrak
# partner tiada slot promosi runcit). Menutup setting promosi terus
# menamatkan cashback untuk SEMUA booking — termasuk yang belum settle.

_ORDER_DISCOUNT_DESC_PREFIX = "Order Discount"


def _get_booking_discount_snapshot(so_name):
    """Diskaun order-level & kelayakan cashback suatu SO booking — voucher/
    referral_discount dari BOOKING (sumber kebenaran) melalui
    Sales Order.custom_booking; cashback_percent pula di-DERIVE semasa
    bayaran (benefit transaksional): Booking.checkout_method ==
    "Manual Transfer" DAN promosi aktif di Travel Settings DAN bukan B2B.
    Returns (voucher_discount, referral_discount, cashback_percent).

    SO tanpa pautan Booking (rekod lama/ dicipta manual di Desk) → sifar,
    sama seperti tingkah lama bila field diskaun kosong."""
    booking = frappe.db.get_value("Sales Order", so_name, "custom_booking")
    if not booking:
        return 0.0, 0.0, 0.0
    row = frappe.db.get_value(
        "Booking", booking,
        ["voucher_discount", "referral_discount", "checkout_method", "b2b_partner"],
        as_dict=True)
    if not row:
        return 0.0, 0.0, 0.0

    cashback_percent = 0.0
    if (row.checkout_method == "Manual Transfer" and not row.b2b_partner):
        settings = frappe.get_cached_doc("Travel Settings")
        if settings.manual_transfer_cashback_enabled:
            cashback_percent = float(settings.manual_transfer_cashback_percent or 0)

    return (
        float(row.voucher_discount or 0),
        float(row.referral_discount or 0),
        cashback_percent,
    )


def _get_order_discount_total(so_name):
    """Jumlah diskaun order-level (voucher + referral) SO, dalam currency SO.
    0 bila tiada (termasuk SO lama pra-refactor)."""
    voucher_discount, referral_discount, _pct = _get_booking_discount_snapshot(so_name)
    return round(voucher_discount + referral_discount, 2)


def _get_absorbed_order_discount(so_name, company, currency):
    """Bahagian diskaun order-level yang SUDAH diserap oleh Payment Entry
    terdahulu (draft + submitted; cancelled dikira bebas). Dua sumber:

      1. Baris deduction 'Order Discount ...' pada PE yang reference SO ni
         (laluan wizard Manual Transfer & portal).
      2. PE penyelesaian (paid_to = akaun Marketing Expenses) yang dibina
         oleh _create_discount_settlement_entry() untuk laluan Stripe —
         keseluruhan paid_amount nya ialah serapan diskaun.

    Dipanggil sebelum bina PE baharu supaya diskaun tak diserap dua kali
    (cth deposit wizard dah serap, bayaran baki portal tak patut serap lagi).
    """
    account = _resolve_cashback_discount_account(company, currency)
    if not account:
        return 0.0
    return float(frappe.db.sql("""
        SELECT COALESCE(SUM(x.amt), 0) FROM (
            SELECT SUM(ded.amount) AS amt
            FROM `tabPayment Entry Deduction` ded
            JOIN `tabPayment Entry` pe ON pe.name = ded.parent
            WHERE pe.docstatus < 2
              AND ded.account = %(acc)s
              AND ded.description LIKE %(prefix)s
              AND pe.name IN (
                  SELECT ref.parent FROM `tabPayment Entry Reference` ref
                  WHERE ref.reference_doctype = 'Sales Order'
                    AND ref.reference_name = %(so)s
              )
            UNION ALL
            SELECT SUM(pe.paid_amount) AS amt
            FROM `tabPayment Entry` pe
            WHERE pe.docstatus < 2
              AND pe.paid_to = %(acc)s
              AND pe.name IN (
                  SELECT ref.parent FROM `tabPayment Entry Reference` ref
                  WHERE ref.reference_doctype = 'Sales Order'
                    AND ref.reference_name = %(so)s
              )
        ) x
    """, {"acc": account, "so": so_name, "prefix": _ORDER_DISCOUNT_DESC_PREFIX + "%"})[0][0] or 0)


def _build_discount_deduction_rows(company, currency, so_name, components):
    """Bina BARIS DEDUCTION untuk diskaun order-level (voucher/referral).

    'components' ialah senarai (description, amount); baris dengan amount
    <= 0 digugurkan. Semua baris debit akaun Marketing Expenses company
    tersebut (sumber tunggal: _resolve_cashback_discount_account).

    Return (rows, total) — atau (None, 0) bila akaun tidak dijumpai; caller
    WAJIB fallback allocate cash sahaja (PE kekal seimbang) seperti corak
    cashback; error di-log untuk admin.
    """
    clean = [(str(desc), round(float(amt), 2)) for desc, amt in (components or [])
             if float(amt or 0) > 0]
    if not clean:
        return [], 0.0

    account = _resolve_cashback_discount_account(company, currency)
    if not account:
        frappe.log_error(
            title="Order Discount Deduction - Account Missing",
            message="Order discount deduction SKIPPED for Payment Entry against SO " +
            str(so_name) + " (company " + str(company) + ", currency " +
            str(currency) + "): no Cashback Discount Account configured for "
            "this company in Travel Settings (Multi Currency Account row or "
            "global fallback). The discount is NOT absorbed by this Payment "
            "Entry — it will be retried on the next payment.",
        )
        return None, 0.0

    cost_center = frappe.db.get_value("Company", company, "cost_center")
    rows = [{
        "account":     account,
        "amount":      amt,
        "cost_center": cost_center,
        "description": _ORDER_DISCOUNT_DESC_PREFIX + " (" + desc + ")",
    } for desc, amt in clean]
    return rows, round(sum(amt for _, amt in clean), 2)


def _settle_order_discount_residue(so_name):
    """Selesaikan BAKI diskaun order-level (voucher/referral) yang belum
    diserap mana-mana Payment Entry — khusus laluan Stripe.

    Payment Entry Stripe dicipta oleh ERPNext (Payment Request.set_as_paid)
    dan mengallocate CASH net sahaja — tiada ruang untuk deduction. Tanpa
    penyelesaian ni, SO bervoucher kekal baki walaupun customer dah bayar
    penuh secara net. PE pelengkap ni (Receive: Debtors → Marketing
    Expenses, reference SO allocated = residue) mendebit expense dan
    mengkreditkan baki customer SECUPLAH diskaun, sekaligus menaikkan
    advance_paid SO supaya settle tepat.

    Idempoten melalui _get_absorbed_order_discount() — dipanggil berulang
    (webhook + fallback wizard poll) tak akan mendablik serapan. Error
    DI-LOG sahaja (tidak pernah gagalkan pengesahan bayaran customer).
    Pulangkan nama PE atau None.
    """
    so = frappe.db.get_value(
        "Sales Order", so_name,
        ["company", "currency", "customer", "grand_total", "advance_paid"], as_dict=True)
    if not so:
        return None

    order_discount = _get_order_discount_total(so_name)
    if order_discount <= 0:
        return None

    company = so.company or frappe.db.get_single_value("Global Defaults", "default_company")
    residue = round(min(
        order_discount - _get_absorbed_order_discount(so_name, company, so.currency),
        float(so.grand_total or 0) - float(so.advance_paid or 0),
    ), 2)
    if residue <= 0:
        return None

    from erpnext.accounts.party import get_party_account

    original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        pe.posting_date    = frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = so.customer
        pe.party_account   = get_party_account("Customer", so.customer, company)
        pe.paid_from       = pe.party_account
        pe.paid_to         = _resolve_cashback_discount_account(company, so.currency)
        pe.paid_amount     = residue
        pe.received_amount = residue
        # ERPNext v17: GL pada akaun P&L (Marketing Expenses sbg paid_to)
        # WAJIB bawa cost center — set pada tahap dokumen.
        pe.cost_center     = frappe.db.get_value("Company", company, "cost_center")
        pe.reference_no    = so_name
        pe.reference_date  = frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            "allocated_amount":  residue,
        })
        pe.remarks = ("Order discount settlement (voucher/referral) for " +
                      str(so_name) + ".")
        pe.insert(ignore_permissions=True)
        pe.submit()
        return pe.name
    except Exception as e:
        frappe.log_error(
            title="Order Discount Settlement Error",
            message="Order discount settlement PE failed for SO " + str(so_name) +
            ": " + str(e))
        return None
    finally:
        frappe.local.session.user = original_user


# ══════════════════════════════════════════════
# PAYMENT ENTRY (Manual Transfer)
# ══════════════════════════════════════════════

def _safe_date(raw) -> str:
    """Koerk tarikh dari client kepada YYYY-MM-DD (format internal sistem).

    Pulangkan '' bila kosong/tak sah — caller fallback (cth today()).
    Nilai dari <input type="date"> sudah ISO, tapi panggilan terus API
    boleh hantar apa-apa, jadi sentiasa disahkan.
    """
    s = str(raw or "").strip()
    if not s:
        return ""
    try:
        return str(getdate(s))
    except Exception:
        return ""


def _create_manual_payment_entry(so_name, customer_name, amount, receipt_data="", label="receipt", bank_transfer_ref="",
                                 cashback_percent=0, allocated_amount=None, discount_components=None,
                                 payment_date="", note=""):
    """Manual transfer — cipta Payment Entry DRAFT + attach resit.
    Draft (docstatus 0) = menunggu admin verify & submit. Corak sama dgn portal.

    payment_date: tarikh transaksi bank customer (YYYY-MM-DD — format
    internal sistem; dipapar ikut format Travel Website di portal).
    Kosong → hari ini. note: nota/memo customer tentang transaksi (pilihan)
    — ditulis ke awal PE.remarks supaya admin nampak dahulu.

    CASHBACK (jika cashback_percent > 0): SO kekal GROSS dan PE membawa
    deduction ke akaun Marketing Expenses company tersebut (rujuk
    _resolve_cashback_deduction). 'amount' ialah CASH sebenar yang customer
    transfer (net cashback); 'allocated_amount' ialah bahagian GROSS SO yang
    dibetulkan (cash + cashback). allocated_amount kosong = tiada cashback
    (allocate terus cash — behavior lama, backward compatible).

    DISKAUN ORDER-LEVEL (voucher/referral): 'discount_components' ialah
    senarai (description, amount) — setiap satu menjadi baris deduction
    berasingan ke akaun Marketing Expenses (rujuk
    _build_discount_deduction_rows). allocated_amount kosong tapi komponen
    wujud → gross_allocated dikira semula = cash + jumlah komponen.
    allocated_amount terkurang dari cash + komponen → diangkat supaya PE
    sentiasa seimbang (received + deductions = allocated).
    """
    from erpnext.accounts.party import get_party_account

    so = frappe.db.get_value("Sales Order", so_name, ["company", "currency"], as_dict=True)
    if not so:
        return None

    original_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
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
                title="Manual Transfer - Currency Account Missing",
                message="Manual Transfer paid_to account not configured for currency '" +
                str(so.currency) + "' (SO " + so_name + "). Using fallback to the " +
                "first Bank-type Account for the company — please configure it in " +
                "Travel Settings > Multi Currency Account.",
            )
            # FIXED: fallback dulu ditulis SEMULA di luar blok if, menimpa
            # nilai paid_to dari Travel Settings walaupun ianya dijumpai —
            # menjadikan konfigurasi per-currency tidak pernah berkesan.
            # Kini fallback hanya berlaku bila TCA tiada baris untuk
            # currency SO berkenaan.
            paid_to = frappe.db.get_value(
                "Account", {"account_type": "Bank", "company": company, "is_group": 0}, "name"
            )
        party_account = get_party_account("Customer", customer_name, company)

        # CASHBACK + DISKAUN ORDER-LEVEL — kira bahagian gross, deduction &
        # akaun marketing SEBELUM bina PE supaya paid/allocated/deduction
        # sentiasa konsisten (PE kekal seimbang: received + deductions =
        # allocated).
        cash = round(float(amount), 2)
        disc_rows, disc_total = _build_discount_deduction_rows(
            company, so.currency, so_name, discount_components)
        gross_allocated = round(float(allocated_amount), 2) if allocated_amount else (
            cash + (disc_total or 0))
        if gross_allocated < cash + (disc_total or 0):
            # Guard: allocated tak boleh kurang dari cash + diskaun yang
            # mahu diserap — angkat supaya PE kekal seimbang.
            gross_allocated = cash + (disc_total or 0)
        cashback_row = None
        if cashback_percent > 0:
            cashback_row = _resolve_cashback_deduction(
                company, so.currency, so_name, cashback_percent, cash,
                gross_allocated, other_deductions=disc_total or 0)

        pe = frappe.new_doc("Payment Entry")
        pe.payment_type    = "Receive"
        pe.company         = company
        # Tarikh transaksi bank customer (dari resit) — sama kelakuan
        # submit_manual_payment() portal: posting_date = reference_date =
        # tarikh transaksi, fallback hari ini bila kosong/tak sah.
        pe.posting_date    = _safe_date(payment_date) or frappe.utils.today()
        pe.party_type      = "Customer"
        pe.party           = customer_name
        pe.party_account   = party_account
        pe.paid_from       = party_account
        pe.paid_to         = paid_to
        pe.paid_amount     = cash
        pe.received_amount = cash
        pe.reference_no    = bank_transfer_ref or so_name
        pe.reference_date  = _safe_date(payment_date) or frappe.utils.today()
        pe.append("references", {
            "reference_doctype": "Sales Order",
            "reference_name":    so_name,
            # Cashback/diskaun: allocate bahagian GROSS (cash + diskaun +
            # cashback) supaya deduction ke akaun marketing menyerap
            # perbezaan dan PE kekal seimbang (received + deductions =
            # allocated).
            "allocated_amount":  gross_allocated if (cashback_row or disc_rows) else cash,
        })
        if disc_rows:
            for _row in disc_rows:
                pe.append("deductions", _row)
        if cashback_row:
            pe.append("deductions", cashback_row)
        pe.remarks = "Manual transfer (booking) for " + so_name + \
        (". Ref: " + bank_transfer_ref if bank_transfer_ref else "")
        if note:
            pe.remarks += ". Note: " + note
        if disc_rows:
            pe.remarks += (". Order discount " + str(disc_total) + " " +
                           str(so.currency) + " deducted to Marketing Expenses (" +
                           disc_rows[0]["account"] + ").")
        if cashback_row:
            pe.remarks += (". Cashback " + str(cashback_percent) + "% (" +
                           str(cashback_row["amount"]) + " " + str(so.currency) +
                           ") deducted to Marketing Expenses (" +
                           cashback_row["account"] + ").")
        pe.remarks += ". Pending verification."
        pe.insert(ignore_permissions=True)

        if receipt_data:
            # STANDARDISASI UPLOAD (sama seperti passport/visa traveller &
            # resit portal): magic bytes + PDF → PNG halaman 1. Extension
            # data-URL hanya jadi petunjuk nama; jenis sebenar ditentukan
            # _decode_and_normalize_upload.
            ext = ".png"
            if receipt_data.startswith("data:"):
                head = receipt_data.split(",")[0]
                if "pdf" in head:
                    ext = ".pdf"
                elif "jpeg" in head or "jpg" in head:
                    ext = ".jpg"
                elif "png" in head:
                    ext = ".png"
            file_content, file_name = _decode_and_normalize_upload(receipt_data, label + ext, label="receipt")
            frappe.get_doc({ "doctype": "File", "file_name": file_name, "attached_to_doctype": "Payment Entry", "attached_to_name": pe.name, "is_private": 1, "content": file_content }).insert(ignore_permissions=True)

        # FIXED: return nama PE di luar blok receipt — sebelum ni `return
        # pe.name` hanya dalam `if receipt_data:`, jadi caller tanpa resit
        # (dan apa-apa caller yang mahu nama PE) dapat None walhal PE sudah
        # berjaya dicipta.
        return pe.name

    except Exception as e:
        # FIXED: Propagate error — resit pembayaran manual pelanggan HILANG jika di-silent
        # Caller (confirm_booking) patut throw supaya customer tahu perlu retry
        # Title mesti pendek (<140 aksara) — Error Log.method akan truncate/fail
        # jika message panjang dihantar sebagai positional pertama.
        frappe.log_error(
            title="Manual PE Error",
            message="Manual payment entry (booking) failed: " + str(e),
        )
        frappe.throw(
            _("Failed to save your payment receipt. Please try again or contact support. ({0})").format(str(e)),
            title="Payment Recording Failed"
        )
    
    finally:
        frappe.local.session.user = original_user


def _create_payment_url(customer_name, so_name, amount, booking_number):
    """Cipta Payment Intent (checkout kita sendiri) untuk online payment.
    Redirect selepas bayar dikawal oleh checkout.html -> balik ke wizard step Confirm.
    Status bayaran sebenar ditentukan oleh webhook (stripe_checkout.stripe_webhook),
    bukan redirect ini.

    Pulangkan tuple (checkout_url, error_message). error_message ialah None bila
    berjaya. Booking TIDAK di-rollback bila gagal — caller (confirm_booking)
    tetap commit supaya customer ada rekod booking dan boleh bayar lewat di portal.
    """
    try:
        from travel_booking.api.stripe_checkout import create_payment_intent
        result = create_payment_intent(
            sales_order=so_name,
            amount=amount,
            source="wizard",
            booking_number=booking_number,
        )
        return result.get("checkout_url", ""), None
    except frappe.ValidationError as e:
        frappe.log_error(title="Payment URL Error", message="Payment checkout creation failed: " + str(e))
        return "", str(e)
    except Exception as e:
        frappe.log_error(title="Payment URL Error", message="Payment checkout creation failed: " + str(e))
        return "", "Payment setup failed. Please complete your payment from the portal or contact support."


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
        from erpnext.accounts.services.payment_schedule import PaymentScheduleService

        _original_user = frappe.local.session.user
        frappe.local.session.user = "Administrator"
        try:
            si = make_sales_invoice(so_name)

            # make_sales_invoice mapper doesn't copy arbitrary custom fields
            # from SO to SI — copy the booking link fields manually so the SI
            # carries the same Booking + Booking Addon references as the SO.
            so_custom = frappe.db.get_value(
                "Sales Order", so_name,
                ["custom_booking", "custom_booking_addon", "apply_discount_on",
                 "additional_discount_percentage", "discount_amount"], as_dict=True
            )
            if so_custom:
                if so_custom.custom_booking:
                    si.custom_booking = so_custom.custom_booking
                if so_custom.custom_booking_addon:
                    si.custom_booking_addon = so_custom.custom_booking_addon
                # ADDITIONAL DISCOUNT (cashback manual transfer & harga net
                # B2B) — mapper ERPNext TIDAK menyalin medan diskaun SO→SI.
                # Tanpa ni, invois terhasil pada harga GROSS sedangkan
                # bayaran diterima pada NET → invois kekal berbaki palsu.
                if so_custom.apply_discount_on and float(so_custom.discount_amount or 0):
                    si.apply_discount_on = so_custom.apply_discount_on
                    si.additional_discount_percentage = \
                        so_custom.additional_discount_percentage
                    si.discount_amount = float(so_custom.discount_amount)
                    si.run_method("calculate_taxes_and_totals")

            si.flags.ignore_permissions = True
            si.set_posting_time = 1
            si.posting_date = frappe.utils.today()

            # Jadual bayaran dibawa mapper dari SO dengan due_date = tarikh
            # SO sendiri (SO booking tiada Payment Terms Template — terma
            # serta-merta). Posting date dimajak ke hari ni (bayaran akhir
            # selalunya hari/minggu selepas SO dicipta), jadi BINA SEMULA
            # jadual dari posting_date baharu — kalau tak, validate_due_date
            # ERPNext menolak invois dengan "Due Date cannot be before
            # Posting Date" dan auto-invoice gagal senyap untuk SEMUA
            # booking yang dibayar penuh lewat dari tarikh SO. due_date
            # juga direset dulu sebab set_payment_schedule guna
            # doc.due_date (bukan posting_date) untuk baris lalai.
            si.due_date = si.posting_date
            si.payment_schedule = []
            PaymentScheduleService(si).set_payment_schedule()
            PaymentScheduleService(si).set_due_date()

            # Accounts Settings "automatically_fetch_payment_terms" aktif di
            # site ini — set_payment_schedule tarik balik jadual dari SO
            # (due_date = tarikh SO, bukan posting_date). Apit mana-mana
            # tarikh lapuk ke posting_date supaya validate_due_date ERPNext
            # lulus; struktur/portion jadual kekal. getdate() wajib —
            # sched.due_date ialah datetime.date, posting_date string.
            posting = getdate(si.posting_date)
            for sched in (si.payment_schedule or []):
                if sched.due_date and getdate(sched.due_date) < posting:
                    sched.due_date = si.posting_date
            if getdate(si.due_date) < posting:
                si.due_date = si.posting_date

            si.set_advances()

            # SO sentiasa company currency (conversion_rate=1) sekarang, jadi
            # expected_total = advance_paid terus — tiada lagi cabang
            # party_account_currency vs company_currency (semua converge ke
            # advance_paid * 1). allocated_amount juga dalam company currency.
            allocated_total = sum(float(a.allocated_amount or 0) for a in (si.advances or []))
            expected_total = float(so.advance_paid or 0)

            if abs(allocated_total - expected_total) > 0.01:
                frappe.log_error(
                    title="Auto Sales Invoice - Advance Mismatch",
                    message="Auto-invoice: set_advances() failed to allocate ALL payments "
                    "for SO " + so_name + " — expected " + str(expected_total) +
                    ", but only allocated " + str(allocated_total) +
                    "). SI NOT submitted (left as draft/not created) — requires manual "
                    "investigation (check Payment Entry party/currency for this SO) before "
                    "generating the invoice manually.",
                )
                return

            si.insert(ignore_permissions=True)
            si.submit()
        finally:
            frappe.local.session.user = _original_user

    except Exception as e:
        frappe.log_error(
            title="Auto Sales Invoice Error",
            message="Auto-invoice failed for SO " + so_name + ": " + str(e),
        )