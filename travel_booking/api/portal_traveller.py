# travel_booking/api/portal_traveller.py
# Traveller — Save, Wizard Lookup, Request Update
# ─────────────────────────────────────────────────

import frappe
from travel_booking.api.portal_booking import _get_customer


# ══════════════════════════════════════════════
# SAVE RESERVATION (Traveller info)
# ══════════════════════════════════════════════

def _format_phone(phone):
    """Format phone: '+60 1156973287' -> '+60-1156973287'."""
    if not phone:
        return ""
    phone = phone.strip()
    import re
    match = re.match(r'(\+\d{1,4})\s+(.+)', phone)
    if match:
        return match.group(1) + '-' + match.group(2).replace(' ', '')
    return phone


@frappe.whitelist()
def save_booking_traveller(booking_number, slot_name,
                            ic_number, first_name="",
                            last_name="", full_name="", gender="",
                            date_of_birth="", nationality="",
                            passport_no="", passport_expiry="",
                            email="", phone="",
                            filedata="", filename="",
                            visa_filedata="", visa_filename="",
                            emergency_contact_name="",
                            emergency_contact_phone="",
                            emergency_contact_relationship="",
                            dietary_requirements="",
                            medical_conditions="",
                            special_needs=""):
    frappe.flags.ignore_permissions = True
    import base64

    customer_name = _get_customer()

    ic_number = (ic_number or "").strip()
    first_name = (first_name or "").strip()
    last_name  = (last_name  or "").strip()
    nationality = (nationality or "").strip()
    passport_no = (passport_no or "").strip()
    emergency_contact_name         = (emergency_contact_name         or "").strip()
    emergency_contact_phone        = (emergency_contact_phone        or "").strip()
    emergency_contact_relationship = (emergency_contact_relationship or "").strip()

    # Validation server-side — CERMIN client-side (portal_traveller.js
    # saveTraveller), sebab client-side sahaja boleh dipintas (contoh
    # panggil API terus). Email/Phone/Health (dietary/medical/special
    # needs) KEKAL opsyenal — tak divalidate di sini.
    if not first_name:  frappe.throw("Nama pertama wajib diisi.")
    if not last_name:   frappe.throw("Nama akhir wajib diisi.")
    if not ic_number:   frappe.throw("IC Number wajib diisi.")
    if not nationality: frappe.throw("Kewarganegaraan wajib diisi.")
    if not date_of_birth: frappe.throw("Tarikh lahir wajib diisi.")
    if not gender:       frappe.throw("Jantina wajib dipilih.")

    # Nombor telefon (Phone/Emergency Contact Phone) — semak minimum panjang
    # digit SEBELUM sampai ke validation Frappe (fieldtype Phone guna library
    # 'phonenumbers' yang check kesahihan SEBENAR nombor tiap negara, bukan
    # sekadar format — nombor terlalu pendek akan ditolak dengan mesej generik
    # "is not valid" yang kurang jelas). Ini bagi mesej yang lebih membantu.
    import re
    if phone and len(re.sub(r"\D", "", phone)) < 7:
        frappe.throw("Nombor telefon nampak terlalu pendek. Sila masukkan nombor penuh.")
    if emergency_contact_phone and len(re.sub(r"\D", "", emergency_contact_phone)) < 7:
        frappe.throw("Nombor telefon kenalan kecemasan nampak terlalu pendek. Sila masukkan nombor penuh.")

    if not emergency_contact_name:         frappe.throw("Nama kenalan kecemasan wajib diisi.")
    if not emergency_contact_phone:        frappe.throw("Nombor telefon kenalan kecemasan wajib diisi.")
    if not emergency_contact_relationship: frappe.throw("Hubungan kenalan kecemasan wajib diisi.")
    if not passport_no:      frappe.throw("Nombor pasport wajib diisi.")
    if not passport_expiry:  frappe.throw("Tarikh luput pasport wajib diisi.")
    if not full_name:
        frappe.throw("Nama wajib diisi.")

    # Verify booking milik customer
    booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                  ["name", "customer", "status"], as_dict=True)
    if not booking:
        frappe.throw("Booking tidak ditemui.")
    if booking.customer != customer_name:
        frappe.throw("Akses ditolak.", frappe.PermissionError)

    # Kunci "Traveller Details di-lock sehingga Confirmed/Completed" DIBUANG —
    # traveller details boleh diisi bila-bila masa, tak kira status booking
    # atau payment_status (customer boleh isi maklumat traveller walaupun
    # bayaran belum selesai).

    # Verify slot (Reservation) milik booking ini
    slot = frappe.db.get_value(
        "Reservation", slot_name,
        ["name", "booking", "document_status"], as_dict=True
    )
    if not slot or slot.booking != booking.name:
        frappe.throw("Slot tidak ditemui.")

    LOCKED_STATUSES = ["Verified"]
    if slot.document_status in LOCKED_STATUSES:
        frappe.throw("Slot ini telah disahkan oleh admin dan tidak boleh diedit.")

    # Get or create Traveller
    existing = frappe.db.get_value("Traveller", {"ic_number": ic_number}, "name")

    if existing:
        # Elak traveller yang SAMA di-assign ke slot LAIN dalam booking yang sama
        # (cth IC sama termasuk secara tak sengaja untuk Traveller berbeza).
        conflict = frappe.db.get_value(
            "Reservation",
            {"booking": booking.name, "traveller": existing, "name": ["!=", slot_name]},
            "name"
        )
        if conflict:
            frappe.throw(
                "IC Number ini telah digunakan untuk traveller lain dalam booking ini "
                "(" + conflict + "). Sila semak semula \u2014 setiap traveller mesti IC berlainan."
            )

    # Mandatory: passport copy wajib (baru upload ATAU sudah wujud) — TERMASUK
    # infant, sebab pasport tetap diperlukan untuk perjalanan antarabangsa.
    # Visa Photo TAK wajib — admin akan semak & sahkan manual ikut keperluan
    # sebenar (contoh infant biasanya tak perlu visa photo formal).
    existing_passport = frappe.db.get_value("Traveller", existing, "passport_image") if existing else None
    if not filedata and not existing_passport:
        frappe.throw("Passport copy is required.")

    if existing:
        frappe.db.set_value("Traveller", existing, {
            "first_name":      first_name,
            "last_name":       last_name,
            "full_name":       full_name,
            "nationality":     nationality,
            "passport_no":     passport_no,
            "passport_expiry": passport_expiry or None,
            "date_of_birth":   date_of_birth   or None,
            "email":           email,
            "phone":           _format_phone(phone),
            "emergency_contact_name":         emergency_contact_name,
            "emergency_contact_phone":        _format_phone(emergency_contact_phone),
            "emergency_contact_relationship": emergency_contact_relationship,
            "dietary_requirements": dietary_requirements,
            "medical_conditions":   medical_conditions,
            "special_needs":        special_needs,
            **({} if not gender else {"gender": gender}),
        })
        traveller_name = existing
    else:
        tvl = frappe.new_doc("Traveller")
        tvl.first_name      = first_name
        tvl.last_name       = last_name
        tvl.full_name       = full_name
        tvl.gender          = gender
        tvl.ic_number       = ic_number
        tvl.date_of_birth   = date_of_birth   or None
        tvl.nationality     = nationality
        tvl.passport_no     = passport_no
        tvl.passport_expiry = passport_expiry or None
        tvl.email           = email
        tvl.phone           = _format_phone(phone)
        tvl.emergency_contact_name         = emergency_contact_name
        tvl.emergency_contact_phone        = _format_phone(emergency_contact_phone)
        tvl.emergency_contact_relationship = emergency_contact_relationship
        tvl.dietary_requirements = dietary_requirements
        tvl.medical_conditions   = medical_conditions
        tvl.special_needs        = special_needs
        tvl.insert(ignore_permissions=True, ignore_mandatory=True)
        traveller_name = tvl.name

    # Link Traveller ke Reservation. NOTA PENTING: field full_name/passport_no/
    # passport_expiry/nationality pada Reservation adalah fetch_from (rujuk
    # Traveller.xxx, fieldtype Data — dah dibetulkan dari Link sebelum ni)
    # — tapi fetch_from HANYA auto-trigger semasa submit form Desk atau
    # doc.save() penuh, BUKAN semasa frappe.db.set_value() (yang terus SQL,
    # bypass document lifecycle). Jadi field ni perlu diisi MANUAL di sini,
    # atau ia akan kekal kosong walau Traveller.full_name dll sudah betul.
    frappe.db.set_value("Reservation", slot_name, {
        "traveller":       traveller_name,
        "document_status": "Pending",
        "full_name":       full_name,
        "passport_no":     passport_no,
        "passport_expiry": passport_expiry or None,
        "nationality":     nationality,
    })

    # Upload passport — simpan dalam Traveller.passport_image
    if filedata and filename:
        if "," in filedata:
            filedata = filedata.split(",")[1]
        file_content = base64.b64decode(filedata)

        file_doc = frappe.get_doc({
            "doctype":             "File",
            "file_name":           filename,
            "attached_to_doctype": "Traveller",
            "attached_to_name":    traveller_name,
            "attached_to_field":   "passport_image",
            "is_private":          1,
            "content":             file_content
        })
        file_doc.insert(ignore_permissions=True)
        frappe.db.set_value("Traveller", traveller_name, "passport_image", file_doc.file_url)

    # Upload visa photo — simpan dalam Traveller.visa_photo
    if visa_filedata and visa_filename:
        if "," in visa_filedata:
            visa_filedata = visa_filedata.split(",")[1]
        visa_file_content = base64.b64decode(visa_filedata)

        visa_file_doc = frappe.get_doc({
            "doctype":             "File",
            "file_name":           visa_filename,
            "attached_to_doctype": "Traveller",
            "attached_to_name":    traveller_name,
            "attached_to_field":   "visa_photo",
            "is_private":          1,
            "content":             visa_file_content
        })
        visa_file_doc.insert(ignore_permissions=True)
        frappe.db.set_value("Traveller", traveller_name, "visa_photo", visa_file_doc.file_url)
        frappe.db.set_value("Traveller", traveller_name, "passport_image", file_doc.file_url)

    frappe.db.commit()

    total_slots  = frappe.db.count("Reservation", {"booking": booking_number})
    filled_count = frappe.db.count("Reservation", {
        "booking":   booking_number,
        "traveller": ["!=", ""]
    })

    return {
        "status":       "ok",
        "slot_name":    slot_name,
        "traveller_id": traveller_name,
        "doc_status":   "Pending",
        "all_filled":   filled_count >= total_slots and total_slots > 0,
        "message":      "Maklumat traveller berjaya disimpan."
    }


# ══════════════════════════════════════════════
# WIZARD LOOKUP
# ══════════════════════════════════════════════

@frappe.whitelist()
def wizard_lookup(ic_number, passport_no, full_name):
    """Verify traveller identity using IC + Passport + Full Name."""
    _get_customer()

    ic_number   = (ic_number  or "").strip()
    passport_no = (passport_no or "").strip().upper()
    full_name   = (full_name  or "").strip()

    if not ic_number or not passport_no or not full_name:
        return {"status": "not_found"}

    traveller = frappe.db.get_value(
        "Traveller",
        {"ic_number": ic_number},
        ["name", "ic_number", "full_name", "first_name", "last_name", "gender",
         "date_of_birth", "nationality", "phone", "email",
         "passport_no", "passport_expiry",
         "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship",
         "dietary_requirements", "medical_conditions", "special_needs"],
        as_dict=True
    )

    if not traveller:
        return {"status": "not_found"}

    TITLES = [
        "haji", "hj", "hjh", "hajah", "dr", "prof", "dato",
        "datin", "tan sri", "puan sri", "ir", "engr",
        "mr", "mrs", "ms", "tn hj", "tn. hj"
    ]

    def strip_titles(name):
        n = name.lower().strip()
        for t in sorted(TITLES, key=len, reverse=True):
            n = n.replace(t + ".", "").replace(t + " ", "")
        return " ".join(n.split())

    def jaro_winkler(s1, s2):
        if s1 == s2: return 1.0
        l1, l2 = len(s1), len(s2)
        if l1 == 0 or l2 == 0: return 0.0
        match_dist = max(l1, l2) // 2 - 1
        s1_matches = [False] * l1
        s2_matches = [False] * l2
        matches = transpositions = 0
        for i in range(l1):
            start = max(0, i - match_dist)
            end   = min(i + match_dist + 1, l2)
            for j in range(start, end):
                if s2_matches[j] or s1[i] != s2[j]: continue
                s1_matches[i] = s2_matches[j] = True
                matches += 1
                break
        if matches == 0: return 0.0
        k = 0
        for i in range(l1):
            if not s1_matches[i]: continue
            while not s2_matches[k]: k += 1
            if s1[i] != s2[k]: transpositions += 1
            k += 1
        jaro = (matches/l1 + matches/l2 + (matches - transpositions/2)/matches) / 3
        prefix = 0
        for i in range(min(4, l1, l2)):
            if s1[i] == s2[i]: prefix += 1
            else: break
        return jaro + prefix * 0.1 * (1 - jaro)

    def token_sort_ratio(s1, s2):
        return jaro_winkler(" ".join(sorted(s1.split())), " ".join(sorted(s2.split())))

    input_name  = strip_titles(full_name)
    stored_name = strip_titles(traveller.full_name or "")

    score = max(jaro_winkler(input_name, stored_name), token_sort_ratio(input_name, stored_name))

    if score < 0.75:
        return {"status": "not_found"}

    passport_match = (traveller.passport_no or "").strip().upper() == passport_no
    status = "found" if passport_match else "passport_reset"

    return {
        "status": status,
        "data": {
            "ic_number":       traveller.get("ic_number") or ic_number,
            "full_name":       traveller.full_name      or "",
            "first_name":      traveller.first_name     or "",
            "last_name":       traveller.last_name      or "",
            "gender":          traveller.gender         or "",
            "date_of_birth":   str(traveller.date_of_birth) if traveller.date_of_birth else "",
            "nationality":     traveller.nationality    or "",
            "phone":           traveller.phone          or "",
            "email":           traveller.email          or "",
            "passport_no":     traveller.passport_no    or "",
            "passport_expiry": str(traveller.passport_expiry) if traveller.passport_expiry else "",
            "emergency_contact_name":         traveller.emergency_contact_name         or "",
            "emergency_contact_phone":        traveller.emergency_contact_phone        or "",
            "emergency_contact_relationship": traveller.emergency_contact_relationship or "",
            "dietary_requirements": traveller.dietary_requirements or "",
            "medical_conditions":   traveller.medical_conditions   or "",
            "special_needs":        traveller.special_needs        or "",
        }
    }


# ══════════════════════════════════════════════
# REQUEST DOCUMENT UPDATE
# ══════════════════════════════════════════════

@frappe.whitelist()
def request_document_update(slot_name):
    """Customer request to unlock a Verified slot for re-editing."""
    customer = _get_customer()

    slot = frappe.db.get_value(
        "Reservation", slot_name,
        ["name", "booking", "document_status"],
        as_dict=True
    )
    if not slot:
        frappe.throw("Slot not found")

    booking_customer = frappe.db.get_value("Booking", slot.booking, "customer")
    if booking_customer != customer:
        frappe.throw("Not permitted", frappe.PermissionError)

    if slot.document_status != "Verified":
        frappe.throw("Only Verified slots can request an update")

    frappe.db.set_value("Reservation", slot_name, "document_status", "Open for Update")
    frappe.db.commit()

    return {"status": "ok"}


@frappe.whitelist()
def get_countries():
    """Return list of countries dari Frappe Country doctype."""
    user_email = frappe.session.user
    if not user_email or user_email == "Guest":
        frappe.throw("Not permitted", frappe.PermissionError)

    return frappe.db.get_all(
        "Country",
        fields=["name", "country_name", "code"],
        order_by="country_name asc"
    )