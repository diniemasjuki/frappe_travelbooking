# travel_booking/api/portal_traveller.py
# Traveller — Save, Wizard Lookup, Request Update
# ─────────────────────────────────────────────────

import base64
import io

import frappe
import qrcode
from travel_booking.api.portal_booking import _get_customer


# ══════════════════════════════════════════════
# SAVE RESERVATION (Traveller info)
# ══════════════════════════════════════════════

def _format_phone(phone):
    """Simpan nombor telefon sebagai "+ISD-nombor" (cth "+60-1156973287"),
    bukan E.164 tulen ("+601156973287").

    PUNCA BUG ASAL: implementasi lama guna regex yang WAJIBKAN sekurang-
    kurangnya satu SPACE literal antara dial code dan nombor
    (regex pattern: dial-code, diikuti \\s+, diikuti baki nombor),
    sesuai untuk format seperti "+60 1156973287". Tapi intl-tel-input's
    getNumber() (yang menghantar nilai phone dari portal_traveller.js/
    booking.js) pulangkan format E.164 TULEN TANPA SPACE — cth
    "+601156973287". Regex tu TAK PERNAH match format ni, jadi function
    jatuh ke fallback "return phone" (nombor asal TANPA dash) — dan
    Frappe's fieldtype Phone (Traveller.phone) perlukan format berdash
    untuk widget Desk render betul, dan boleh gagal validation senyap
    tanpa dash yang betul. Ini sebab customer isi phone di portal, tapi
    field Phone kekal kosong dalam rekod Traveller.

    Fix: guna phonenumbers.parse() (library yang SAMA dipakai Frappe's
    sendiri validate_phone_number_with_country_code() secara dalaman)
    untuk betul-betul parse dial code + national number, bukan cuba teka
    format guna regex. Corak ni disamakan dengan affiliate app punya
    AffiliateProfile._normalize_phone() (affiliate_profile.py) — yang
    memang berfungsi dengan baik untuk kes yang sama, jadi kekalkan satu
    pendekatan konsisten merentasi kedua-dua app.
    """
    if not phone:
        return ""

    phone = phone.strip()
    if "-" in phone:
        # Dah dalam format dijangka (cth dihantar terus dari widget yang
        # sudah normalize, atau simpanan sebelum ini) — jangan ganggu lagi.
        return phone

    try:
        from phonenumbers import parse as phonenumbers_parse

        parsed = phonenumbers_parse(phone)
        dial_code = str(parsed.country_code)
        national_number = str(parsed.national_number)
        return f"+{dial_code}-{national_number}"
    except Exception:
        # Tak dapat parse — pulangkan seadanya. Frappe's sendiri
        # validate_phone_number_with_country_code() (jalan lepas ni
        # semasa save) akan bagi ralat jelas kalau nombor tu memang
        # tak sah — tak perlu duplicate check di sini.
        return phone


def _normalize_id(value: str) -> str:
    """Normalisasi IC / nombor passport: buang semua simbol & space,
    uppercase — kekal [A-Z0-9] sahaja. Digunakan sebelum simpan DAN
    sebelum matching supaya rekod lama yang mungkin ada dash/space
    (cth "A-1234 5678") tetap padan dengan input bersih."""
    import re
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def _find_traveller_by_normalized(fieldname: str, value: str) -> str | None:
    """Cari Traveller ikut padanan normalized ([A-Z0-9]) pada medan ID
    (ic_number / passport_no). Rekod lama mungkin tersimpan dengan
    simbol, jadi perbandingan dibuat dalam Python selepas fetch —
    bukan filter DB terus."""
    normalized = _normalize_id(value)
    if not normalized:
        return None
    for name, stored in frappe.get_all(
        "Traveller",
        filters={fieldname: ["like", "%_%"], "docstatus": ["<", 2]},
        fields=["name", fieldname],
        as_list=True,
    ):
        if _normalize_id(stored) == normalized:
            return name
    return None


def _resolve_guest_token(token: str):
    """Sahkan token link guest passport — pulangkan (booking, slot, actor).

    Token disimpan pada Booking Reservation (passport_link_token, search_index).
    Reusable sehingga tamat tempoh (bukan one-time — guest boleh balik ubah
    maklumat). Slot yang sudah Verified (locked) tidak boleh diakses lagi.

    actor = email guest (untuk audit trail Comment) — bukan frappe.session.user
    (yang "Guest" untuk sesi tanpa login), supaya Comment merekod siapa sebenar
    yang ubah data (co-traveller via link) bukan "Guest" generik.
    """
    if not token:
        frappe.throw("Invalid passport link.", frappe.PermissionError)
    slot_name = frappe.db.get_value("Booking Reservation",
                                    {"passport_link_token": token}, "name")
    if not slot_name:
        frappe.throw("This passport link is invalid or has been revoked.",
                     frappe.PermissionError)
    slot = frappe.db.get_value(
        "Booking Reservation", slot_name,
        ["name", "booking", "document_status", "traveller",
         "passport_link_email", "passport_link_expires_on"], as_dict=True
    )
    # Expiry WAJIB — token tanpa tarikh tamat (legacy/NULL) dianggap
    # expired supaya tidak menjadi bearer token selama-lamanya.
    if not slot.passport_link_expires_on or \
       frappe.utils.get_datetime(slot.passport_link_expires_on) < frappe.utils.now_datetime():
        frappe.throw("This passport link has expired. Please request a new link.",
                     frappe.PermissionError)
    if slot.document_status == "Verified":
        frappe.throw("This slot has been verified by admin and cannot be edited.")
    booking = frappe.db.get_value(
        "Booking", slot.booking,
        ["name", "customer", "status", "booking_number"], as_dict=True
    )
    if not booking:
        frappe.throw("Booking not found.")
    actor = slot.passport_link_email or "guest"
    return booking, slot, actor


def _customer_traveller_names(customer_name: str) -> set:
    """Set Traveller docnames yang dimiliki customer (ada sekurang-kurangnya
    satu Booking Reservation pada booking customer tersebut).

    Digunakan utk scope lookup traveller (check_traveller_passport,
    wizard_lookup) supaya customer A tak boleh baca PII traveller customer B
    hanya dengan tahu IC/passport mereka (IDOR / cross-customer PII
    disclosure)."""
    rows = frappe.db.sql(
        """SELECT res.traveller
             FROM `tabBooking Reservation` res
             JOIN `tabBooking` b ON b.name = res.booking
            WHERE b.customer = %s AND res.traveller IS NOT NULL""",
        (customer_name,),
        as_list=True,
    )
    return {r[0] for r in rows if r[0]}


@frappe.whitelist(allow_guest=True)
def save_booking_traveller(booking_number: str, slot_name: str,
                            section: str = "passport",
                            ic_number: str = "", first_name: str = "",
                            last_name: str = "", full_name: str = "", gender: str = "",
                            date_of_birth: str = "", nationality: str = "",
                            passport_no: str = "", passport_expiry: str = "",
                            email: str = "", phone: str = "",
                            filedata: str = "", filename: str = "",
                            visa_filedata: str = "", visa_filename: str = "",
                            emergency_contact_name: str = "",
                            emergency_contact_phone: str = "",
                            emergency_contact_relationship: str = "",
                            dietary_requirements: str = "",
                            medical_conditions: str = "",
                            special_needs: str = "",
                            wheelchair_assistant: str = "",
                            medicine_treatment: str = "",
                            pdpa_consent: bool = False,
                            guest_token: str = ""):
    """Simpan maklumat traveller SECARA BERTAHAP IKUT SECTION.

    section = "passport" | "contact" | "health". Hanya medan milik
    section berkenanan dikemas kini — medan section lain tidak
    disentuh, jadi simpan Contact tidak memadam data Passport dsb.
    Section passport wajib didahulukan (cipta Traveller + link ke
    Booking Reservation); contact/health perlukan traveller yang
    sudah linked pada slot.
    """
    frappe.flags.ignore_permissions = True
    import base64

    # Dual-auth: guest passport-link (token) ATAU logged-in customer (session).
    # Resolve booking + slot + actor (siapa yang buat perubahan) sekali sahaja.
    # Path guest tak perlukan session/Customer — token sah yang sahkan akses ke
    # slot spesifik. Path session kekal guna _get_customer() + ownership macam
    # sebelum ni. PDPA & validation medan di bawah dikenakan ke KEDUA-DUA path.
    if guest_token:
        booking, slot, actor = _resolve_guest_token(guest_token)
        booking_number = booking.booking_number
        slot_name = slot.name
    else:
        customer_name = _get_customer()
        booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                      ["name", "customer", "status"], as_dict=True)
        if not booking:
            frappe.throw("Booking not found.")
        if booking.customer != customer_name:
            frappe.throw("Access denied.", frappe.PermissionError)
        slot = frappe.db.get_value(
            "Booking Reservation", slot_name,
            ["name", "booking", "document_status", "traveller"], as_dict=True
        )
        if not slot or slot.booking != booking.name:
            frappe.throw("Slot not found.")
        actor = frappe.session.user

    LOCKED_STATUSES = ["Verified"]
    if slot.document_status in LOCKED_STATUSES:
        frappe.throw("This slot has been verified by admin and cannot be edited.")

    # PDPA (Personal Data Protection Act 2010) — persetujuan WAJIB sebelum
    # simpan maklumat peribadi traveller (passport/IC/dokumen perjalanan).
    # Checkbox pada bar bawah form (link ke /traveller_portal/privacy);
    # server-side check supaya panggilan API terus (bypass frontend) tak
    # boleh langkau.
    if not pdpa_consent:
        frappe.throw(
            "Please accept the Privacy Notice to continue. "
            "We need your consent to store traveller and passport details "
            "for trip arrangements."
        )

    if section not in ("passport", "contact", "health"):
        frappe.throw("Invalid section.")

    ic_number = _normalize_id(ic_number)
    first_name = (first_name or "").strip()
    last_name  = (last_name  or "").strip()
    nationality = (nationality or "").strip()
    passport_no = _normalize_id(passport_no)
    emergency_contact_name         = (emergency_contact_name         or "").strip()
    emergency_contact_phone        = (emergency_contact_phone        or "").strip()
    emergency_contact_relationship = (emergency_contact_relationship or "").strip()

    # Nombor telefon — semak minimum panjang digit SEBELUM sampai ke
    # validation Frappe (mesej lebih jelas daripada "is not valid"
    # generik daripada library phonenumbers).
    import re
    # Contact section: email & phone WAJIB (bukan optional) — diperlukan
    # untuk menghubungi traveller sepanjang trip & pengesahan tempahan.
    if section == "contact":
        if not phone:
            frappe.throw("Phone number is required.")
        if not email:
            frappe.throw("Email is required.")
        frappe.utils.validate_email_address(email, throw=True)
    if phone and len(re.sub(r"\D", "", phone)) < 7:
        frappe.throw("The phone number seems too short. Please enter the full number.")
    if emergency_contact_phone and len(re.sub(r"\D", "", emergency_contact_phone)) < 7:
        frappe.throw("The emergency contact phone number seems too short.")
    if not emergency_contact_name and emergency_contact_phone:
        frappe.throw("Please fill in the emergency contact name as well.")
    if emergency_contact_name and not emergency_contact_phone:
        frappe.throw("Please fill in the emergency contact phone number as well.")

    if section == "passport":
        # Medan asas wajib — perlu untuk cipta dokumen Traveller yang
        # dinamakan ikut IC. full_name auto-dikira oleh controller
        # Traveller (before_save) dari first/last name.
        if not first_name:  frappe.throw("First name is required.")
        if not last_name:   frappe.throw("Last name is required.")
        if not ic_number:   frappe.throw("IC Number is required.")

        # Padanan normalized — rekod lama yang mungkin tersimpan dengan
        # simbol tetap dijumpai.
        existing = _find_traveller_by_normalized("ic_number", ic_number)

        if existing:
            # Elak traveller yang SAMA di-assign ke slot LAIN dalam booking
            # yang sama (cth IC sama termasuk secara tak sengaja untuk
            # Traveller berbeza).
            conflict = frappe.db.get_value(
                "Booking Reservation",
                {"booking": booking.name, "traveller": existing, "name": ["!=", slot_name]},
                "name"
            )
            if conflict:
                frappe.throw(
                    "This IC Number has already been used for another traveller in this booking "
                    "(" + conflict + "). Please check again \u2014 each traveller must have a different IC."
                )

        if existing:
            # doc.save() (BUKAN db.set_value()) — supaya controller Traveller
            # punya before_save() jalan (auto-kira full_name, age, age_category
            # dari date_of_birth; auto-detect title/gender dari nama Melayu).
            tvl = frappe.get_doc("Traveller", existing)
            tvl.first_name      = first_name
            tvl.last_name       = last_name
            tvl.nationality     = nationality
            tvl.ic_number       = ic_number
            tvl.passport_no     = passport_no
            tvl.passport_expiry = passport_expiry or None
            tvl.date_of_birth   = date_of_birth   or None
            if gender:
                tvl.gender = gender
            tvl.save(ignore_permissions=True)
            traveller_name = existing
        else:
            tvl = frappe.new_doc("Traveller")
            tvl.first_name      = first_name
            tvl.last_name       = last_name
            tvl.gender          = gender
            tvl.ic_number       = ic_number
            tvl.date_of_birth   = date_of_birth   or None
            tvl.nationality     = nationality
            tvl.passport_no     = passport_no
            tvl.passport_expiry = passport_expiry or None
            tvl.insert(ignore_permissions=True, ignore_mandatory=True)
            traveller_name = tvl.name
    else:
        # contact / health — traveller mesti sudah wujud & linked pada slot
        # (dicipta oleh save section passport).
        if not slot.traveller:
            frappe.throw(
                "Please complete and save the Passport section first."
            )
        traveller_name = slot.traveller
        tvl = frappe.get_doc("Traveller", traveller_name)
        if section == "contact":
            tvl.email           = email
            tvl.phone           = _format_phone(phone)
            tvl.emergency_contact_name         = emergency_contact_name
            tvl.emergency_contact_phone        = _format_phone(emergency_contact_phone)
            tvl.emergency_contact_relationship = emergency_contact_relationship
        else:  # health
            tvl.dietary_requirements = dietary_requirements
            tvl.medical_conditions   = medical_conditions
            tvl.special_needs        = special_needs
            tvl.wheelchair_assistant = wheelchair_assistant
            tvl.medicine_treatment  = medicine_treatment
        tvl.save(ignore_permissions=True)

    # PDPA — rekod persetujuan (audit trail) SEKALI sahaja per Traveller.
    # Disimpan sebagai Comment (doctype core Frappe — TIADA perubahan schema
    # diperlukan). Check kewujudan dulu supaya simpan berulang (edit maklumat
    # traveller) tak cipta duplicate consent log.
    _has_consent_log = frappe.db.exists("Comment", {
        "comment_type":       "Info",
        "reference_doctype":  "Traveller",
        "reference_name":     traveller_name,
        "content":            ("like", "%PDPA consent granted%"),
    })
    if not _has_consent_log:
        frappe.get_doc({
            "doctype":           "Comment",
            "comment_type":      "Info",
            "reference_doctype": "Traveller",
            "reference_name":    traveller_name,
            "content": (
                "PDPA consent granted via portal (Privacy Notice checkbox) — "
                + frappe.utils.now() + " by " + actor
            ),
        }).insert(ignore_permissions=True)

    # Link Traveller ke Booking Reservation (idempotent — selamat untuk
    # semua section). NOTA: full_name pada Booking Reservation adalah
    # fetch_from (traveller.full_name) — auto-terisi bila doc di-save()
    # penuh (bukan db.set_value()).
    res_doc = frappe.get_doc("Booking Reservation", slot_name)
    res_doc.traveller       = traveller_name
    res_doc.document_status = "Pending"
    res_doc.save(ignore_permissions=True)

    # Upload passport — hanya untuk section passport, simpan dalam
    # Traveller.passport_image
    if section == "passport" and filedata and filename:
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

    # Upload visa photo — hanya untuk section contact, simpan dalam
    # Traveller.visa_photo
    if section == "contact" and visa_filedata and visa_filename:
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

    frappe.db.commit()

    total_slots  = frappe.db.count("Booking Reservation", {"booking": booking_number})
    filled_count = frappe.db.count("Booking Reservation", {
        "booking":   booking_number,
        "traveller": ["!=", ""]
    })

    return {
        "status":       "ok",
        "section":      section,
        "slot_name":    slot_name,
        "traveller_id": traveller_name,
        "doc_status":   "Pending",
        "all_filled":   filled_count >= total_slots and total_slots > 0,
        "message":      "Traveller information saved successfully."
    }


def _traveller_payload(traveller, ic_fallback: str = "") -> dict:
    """Medan Traveller yang dihantar balik ke form portal (dipakai oleh
    wizard_lookup DAN check_traveller_passport — kekal satu senarai)."""
    return {
        "ic_number":       traveller.get("ic_number") or ic_fallback,
        "full_name":       traveller.get("full_name")      or "",
        "first_name":      traveller.get("first_name")     or "",
        "last_name":       traveller.get("last_name")      or "",
        "gender":          traveller.get("gender")         or "",
        "date_of_birth":   str(traveller.get("date_of_birth")) if traveller.get("date_of_birth") else "",
        "nationality":     traveller.get("nationality")    or "",
        "phone":           traveller.get("phone")          or "",
        "email":           traveller.get("email")          or "",
        "passport_no":     traveller.get("passport_no")    or "",
        "passport_expiry": str(traveller.get("passport_expiry")) if traveller.get("passport_expiry") else "",
        "emergency_contact_name":         traveller.get("emergency_contact_name")         or "",
        "emergency_contact_phone":        traveller.get("emergency_contact_phone")        or "",
        "emergency_contact_relationship": traveller.get("emergency_contact_relationship") or "",
        "dietary_requirements":   traveller.get("dietary_requirements")   or "",
        "medical_conditions":     traveller.get("medical_conditions")     or "",
        "special_needs":          traveller.get("special_needs")          or "",
        "wheelchair_assistant":   traveller.get("wheelchair_assistant")   or "",
        "medicine_treatment":     traveller.get("medicine_treatment")     or "",
    }


# ══════════════════════════════════════════════
# PASSPORT IMAGE MATCH (Langkah 1 wizard — upload dulu)
# ══════════════════════════════════════════════

def _dhash(image_content: bytes):
    """Perceptual hash (difference hash, 64-bit) bagi imej passport.

    Guna Pillow (sudah menjadi dependency Frappe). Imej di-resize ke
    9x8 grayscale; bit hash = perbandingan piksel jiran. Padanan
    hamming distance yang kecil = imej hampir sama walaupun scan
    berbeza resolusi/ketagangan ringan.
    """
    import io
    from PIL import Image

    img = Image.open(io.BytesIO(image_content)).convert("L").resize((9, 8))
    pixels = list(img.getdata())
    bits = 0
    for row in range(8):
        for col in range(8):
            left = pixels[row * 9 + col]
            right = pixels[row * 9 + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def _hamming_distance(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def _mrz_date(yy: str, mm: str, dd: str, future: bool = False) -> str:
    """YYMMDD MRZ → YYYY-MM-DD.

    future=True untuk tarikh LUPUT (sentiasa hadapan ±10 tahun): kalau tahun
    terhasil sudah lepas, tambah 100 (cth '30' pada 2026 → 2030, bukan 1930).
    future=False untuk tarikh lahir (sentiasa lampau).
    """
    import datetime

    if not (yy.isdigit() and mm.isdigit() and dd.isdigit()):
        return ""
    yyyy = 2000 + int(yy)
    if not future and yyyy > datetime.date.today().year:
        yyyy -= 100
    if future and yyyy < datetime.date.today().year:
        yyyy += 100
    return f"{yyyy}-{mm}-{dd}"


def _parse_mrz_line(name_part: str) -> tuple:
    """'SURNAME<<GIVEN<NAMES' → (first_name, last_name) title-case.

    Dua penanganan khas untuk misread OCR biasa pada MRZ:
    1. Filler '<' kerap salah dibaca sebagai huruf berulang ('CCC',
       'XX', 'KK') — cth 'P<MYS<<MUHAMAD...' terbaca 'CCC<MUHAMAD...'.
       Token yang HANYA satu huruf berulang tak wujud dalam nama betul,
       jadi ia dibuang.
    2. Passport Malaysia tiada surname — nama penuh berada dalam satu
       medan (tiada pemisah '<<'). Kalau tiada BIN/BINTI pemisah jelas,
       pecahkan ikut penanda Melayu: sebelum BIN/BINTI → first_name,
       'Bin/Binti ...' → last_name (selari placeholder form
       'Ahmad' / 'bin Razali').
    """
    import re

    def _clean(s: str) -> str:
        return " ".join(t for t in s.replace("<", " ").split()
                        if not re.fullmatch(r"(.)\1+", t))

    parts = name_part.split("<<", 1)
    last_name  = _clean(parts[0])
    first_name = _clean(parts[1]) if len(parts) > 1 else ""

    if len(parts) == 1 or not last_name or not first_name:
        # Satu medan nama sahaja — gabungkan dahulu, baru pecahkan.
        whole = " ".join(x for x in (first_name, last_name) if x)
        m = re.search(r"\b(BIN|BINTI|BTE)\b", whole, flags=re.IGNORECASE)
        if m:
            first_name, last_name = whole[:m.start()].strip(), whole[m.start():].strip()
        else:
            first_name, last_name = whole, ""
    return first_name.title(), last_name.title()


# Nationality MRZ (alpha-3 ICAO) → nama Country Frappe. Cover negara
# yang kerap muncul pada passport pelanggan tempatan/serantau + major
# dunia; yang tiada di sini jatuh kepada fallback DB (paduan 2 huruf
# pertama alpha-3 dengan Country.code alpha-2).
_MRZ_ALPHA3_TO_COUNTRY = {
    "MYS": "Malaysia", "SGP": "Singapore", "IDN": "Indonesia",
    "THA": "Thailand", "BRN": "Brunei", "KHM": "Cambodia",
    "VNM": "Vietnam", "PHL": "Philippines", "MMR": "Myanmar",
    "LAO": "Laos", "CHN": "China", "HKG": "Hong Kong", "MAC": "Macau",
    "TWN": "Taiwan", "JPN": "Japan", "KOR": "South Korea",
    "IND": "India", "PAK": "Pakistan", "BGD": "Bangladesh",
    "LKA": "Sri Lanka", "NPL": "Nepal", "SAU": "Saudi Arabia",
    "ARE": "United Arab Emirates", "OMN": "Oman", "QAT": "Qatar",
    "KWT": "Kuwait", "BHR": "Bahrain", "EGY": "Egypt", "JOR": "Jordan",
    "TUR": "Turkey", "IRN": "Iran", "IRQ": "Iraq", "SYR": "Syria",
    "LBN": "Lebanon", "YEM": "Yemen", "GBR": "United Kingdom",
    "USA": "United States", "AUS": "Australia", "NZL": "New Zealand",
    "CAN": "Canada", "FRA": "France", "DEU": "Germany", "ITA": "Italy",
    "ESP": "Spain", "PRT": "Portugal", "NLD": "Netherlands",
    "BEL": "Belgium", "CHE": "Switzerland", "AUT": "Austria",
    "SWE": "Sweden", "NOR": "Norway", "DNK": "Denmark", "FIN": "Finland",
    "ISL": "Iceland", "IRL": "Ireland", "RUS": "Russia", "UKR": "Ukraine",
    "KAZ": "Kazakhstan", "UZB": "Uzbekistan", "ZAF": "South Africa",
    "MAR": "Morocco", "TUN": "Tunisia", "DZA": "Algeria", "NGA": "Nigeria",
    "KEN": "Kenya", "ETH": "Ethiopia", "GHA": "Ghana",
}


def _country_from_mrz(alpha3: str) -> str:
    """MRZ nationality (alpha-3, cth 'MYS') → nama Country Frappe.
    Fallback DB: padan 2 huruf pertama dengan Country.code (alpha-2)."""
    alpha3 = (alpha3 or "").strip("< ").upper()
    if len(alpha3) != 3:
        return ""
    if alpha3 in _MRZ_ALPHA3_TO_COUNTRY:
        return _MRZ_ALPHA3_TO_COUNTRY[alpha3]
    for variant in (alpha3[:2].upper(), alpha3[:2].lower()):
        name = frappe.db.get_value("Country", {"code": variant}, "name")
        if name:
            return name
    return ""


def _extract_mrz(text: str) -> dict:
    """Cari & parse blok MRZ (TD3 passport 44-char / TD1 30-char) dari teks OCR.

    MRZ lebih dipercayai daripada OCR visual biasa sebab fon OCR-B standard
    antarabangsa + format kedudukan tetap. Nombor IC Malaysia TIADA dalam MRZ
    passport — IC di cari berasingan daripada teks OCR (lih. _ocr_passport).
    """
    import re

    extracted = {}
    # Baris MRZ: sekurang-kurangnya 2 '<' dan 25+ char alfanumerik/<.
    lines = [re.sub(r"[^A-Z0-9<]", "", ln.strip().upper())
             for ln in text.upper().splitlines()]
    lines = [ln for ln in lines if ln.count("<") >= 2 and len(ln) >= 25]

    for i, ln in enumerate(lines):
        # TD3 (passport biasa): 2 baris x 44 char
        if 40 <= len(ln) <= 44 and ln.startswith("P<") and i + 1 < len(lines):
            l2 = lines[i + 1]
            if len(l2) < 20:
                continue
            first_name, last_name = _parse_mrz_line(ln[5:])
            extracted.update({
                "first_name":       first_name,
                "last_name":        last_name,
                "full_name":        (first_name + " " + last_name).strip(),
                "passport_no":      l2[0:9].replace("<", "").strip(),
                "date_of_birth":    _mrz_date(l2[13:15], l2[15:17], l2[17:19]),
                "gender":           {"M": "Male", "F": "Female"}.get(l2[20:21], ""),
                "passport_expiry":  _mrz_date(l2[21:23], l2[23:25], l2[25:27], future=True),
                "nationality_code": ln[2:5],
            })
            break
        # TD1 (kad passport sesetengah negara): 3 baris x 30 char
        if 27 <= len(ln) <= 30 and i + 2 < len(lines) and ln[:1] in ("I", "A", "C"):
            l2, l3 = lines[i + 1], lines[i + 2]
            if len(l2) < 15:
                continue
            first_name, last_name = _parse_mrz_line(l3)
            extracted.update({
                "first_name":       first_name,
                "last_name":        last_name,
                "full_name":        (first_name + " " + last_name).strip(),
                "passport_no":      ln[5:12].replace("<", "").strip() if len(ln) >= 12 else "",
                "date_of_birth":    _mrz_date(l2[0:2], l2[2:4], l2[4:6]),
                "gender":           {"M": "Male", "F": "Female"}.get(l2[7:8], ""),
                "passport_expiry":  _mrz_date(l2[8:10], l2[10:12], l2[12:14], future=True),
                "nationality_code": ln[2:5],
            })
            break
    return extracted


def _binarize(im, threshold: int = None):
    """Autocontrast + adaptive threshold → imej B/W bersih (terbaik untuk OCR MRZ).

    Fon OCR-B pada passport kontras tinggi (teks gelap di atas latar putih).
    
    Improvements:
    - Adaptive threshold (Otsu's method fallback) bila fixed threshold gagal
    - Multiple threshold attempts (120, 140, 160) untuk pelbagai kondisi cahaya
    - CLAHE (Contrast Limited Adaptive Histogram Equalization) untuk
      tangani glare/pencahayaan tidak sekata
    """
    from PIL import ImageOps, ImageFilter
    import numpy as np

    # Convert to grayscale
    gray = im.convert("L") if im.mode != "L" else im

    # Apply CLAHE-like contrast enhancement using PIL's autocontrast
    # This helps with uneven lighting and glare on laminated passports
    enhanced = ImageOps.autocontrast(gray, cutoff=2)

    if threshold:
        # Use provided/fixed threshold
        return enhanced.point(lambda x: 255 if x > threshold else 0, "L")
    
    # Try Otsu-like automatic threshold using histogram
    import array
    
    hist = enhanced.histogram()
    # Simple Otsu approximation: find threshold that maximizes inter-class variance
    total = sum(hist)
    sum_total = sum(i * h for i, h in enumerate(hist))
    
    sum_bg = 0.0
    weight_bg = 0.0
    weight_fg = 0.0
    max_variance = 0.0
    best_threshold = 140  # default fallback

    for t in range(256):
        weight_bg += hist[t]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        
        sum_bg += t * hist[t]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_total - sum_bg) / weight_fg
        
        variance = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if variance > max_variance:
            max_variance = variance
            best_threshold = t

    return enhanced.point(lambda x: 255 if x > best_threshold else 0, "L")


def _binarize_multi(im):
    """Generate multiple binarized versions with different thresholds.
    
    Returns list of (threshold_label, image) tuples for trying multiple
    OCR passes — different thresholds work better for different 
    lighting conditions (glare vs shadow vs normal).
    """
    variants = []
    
    # Standard auto-threshold (Otsu)
    variants.append(("auto", _binarize(im)))
    
    # Fixed thresholds for common scenarios
    for thresh in [120, 140, 160, 180]:
        variants.append((f"t{thresh}", _binarize(im, threshold=thresh)))
    
    # High contrast version (for glare-heavy images)
    from PIL import ImageOps
    gray = im.convert("L") if im.mode != "L" else im
    high_contrast = ImageOps.autocontrast(gray, cutoff=5)
    variants.append(("high_contrast", high_contrast.point(lambda x: 255 if x > 130 else 0, "L")))
    
    # Inverted (for dark backgrounds or negative images)
    inverted = ImageOps.invert(gray)
    variants.append(("inverted", _binarize(inverted)))
    
    return variants


def _deskew_image(im):
    """Detect and correct skew/rotation in passport image.
    
    Passport photos are often taken at slight angles. This function:
    1. Detects text lines using Hough transform or projection profile
    2. Calculates skew angle
    3. Rotates image to correct the skew
    
    Returns deskewed image (or original if detection fails).
    """
    try:
        import numpy as np
        from PIL import Image
        
        # Convert to grayscale
        gray = np.array(im.convert("L"))
        
        # Simple approach: try common angles (-10 to +10 degrees) and find
        # one with maximum horizontal projection variance (text lines aligned)
        best_angle = 0
        max_score = -1
        
        # Only check small angles (passports rarely rotated more than 15°)
        for angle in range(-15, 16, 1):
            # Rotate image
            from PIL import Image as PILImage
            rotated = im.rotate(angle, resample=PILImage.BICUBIC, expand=False)
            arr = np.array(rotated.convert("L"))
            
            # Calculate horizontal projection (sum of pixels per row)
            proj = np.sum(arr < 128, axis=1)
            
            # Score: variance of projection (higher = clearer text lines)
            score = np.var(proj)
            
            if score > max_score:
                max_score = score
                best_angle = angle
        
        # Only apply correction if angle is significant (>2°)
        if abs(best_angle) > 2:
            from PIL import Image as PILImage
            return im.rotate(best_angle, resample=PILImage.BICUBIC, expand=True)
        
        return im
        
    except Exception:
        # If deskew fails, return original image
        return im


def _enhance_for_ocr(im):
    """Apply multiple enhancements to improve OCR accuracy on passport images.
    
    Enhancements applied:
    1. Deskew (fix rotation)
    2. Sharpen (fix blur)
    3. Denoise (reduce graininess)
    4. Resize to optimal size for Tesseract
    """
    from PIL import Image, ImageFilter, ImageOps
    
    # Step 1: Deskew
    im = _deskew_image(im)
    
    # Step 2: Ensure minimum size for good OCR
    if im.width < 1500:
        ratio = 1500 / im.width
        im = im.resize((1500, max(1, int(im.height * ratio))), Image.LANCZOS)
    
    # Step 3: Sharpen slightly (helps with mild blur)
    im = im.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
    
    # Step 4: Light denoise (median filter reduces salt-and-pepper noise)
    im = im.filter(ImageFilter.MedianFilter(size=3))
    
    return im


def _parse_visual_date(s: str) -> str:
    """'01 JAN 1990' / '01/01/1990' → '1990-01-01'. Pulang '' kalau gagal.

    Untuk medan visual passport (bukan MRZ) — format berbeza ikut negara.
    """
    import datetime
    import re

    s = s.strip().upper()
    _MONTHS = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
               "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
    m = re.match(r"(\d{1,2})\s*([A-Z]{3})\s*(\d{4})", s)
    if m:
        dd, mon = int(m.group(1)), _MONTHS.get(m.group(2))
        yyyy = int(m.group(3))
        if mon:
            try:
                return datetime.date(yyyy, mon, dd).isoformat()
            except ValueError:
                return ""
    m = re.match(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", s)
    if m:
        dd, mm = int(m.group(1)), int(m.group(2))
        yyyy = int(m.group(3))
        if yyyy < 100:
            yyyy += 2000 if yyyy <= 30 else 1900
        try:
            return datetime.date(yyyy, mm, dd).isoformat()
        except ValueError:
            return ""
    return ""


def _extract_visual_fallback(extracted: dict, text: str) -> None:
    """Fallback apabila MRZ gagal: ekstrak medan daripada teks visual OCR
    (bahagian mesra-baca passport — label + nilai).

    Kurang可靠 daripada MRZ (format berbeza ikut negara) tetapi lebih baik
    daripada kosong — customer masih perlu semak. Hanya isi medan yang
    MASIH KOSONG (jangan timpa MRZ yang berjaya).
    """
    import re

    raw = text.upper()

    # Passport no: label "PASSPORT NO" / "NO PASPORT" / "NO." diikuti
    # alfanumerik (cth A12345678, K1234567).
    if not extracted.get("passport_no"):
        m = re.search(
            r"(?:PASSPORT\s*NO\.?|NO\.?\s*PASPORT|NO\.)\s*:?\s*([A-Z]{0,2}\d{6,9})\b",
            raw,
        )
        if m:
            extracted["passport_no"] = m.group(1)

    # DOB: label "DATE OF BIRTH" / "TARIKH LAHIR".
    if not extracted.get("date_of_birth"):
        m = re.search(
            r"(?:DATE\s*OF\s*BIRTH|TARIKH\s*LAHIR)\s*:?\s*"
            r"(\d{1,2}\s*[A-Z]{3}\s*\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
            raw,
        )
        if m:
            extracted["date_of_birth"] = _parse_visual_date(m.group(1))

    # Expiry: label "DATE OF EXPIRY" / "EXPIRY" / "TAMAT TEMPOH".
    if not extracted.get("passport_expiry"):
        m = re.search(
            r"(?:DATE\s*OF\s*EXPIRY|EXPIRY|TAMAT\s*TEMPOH)\s*:?\s*"
            r"(\d{1,2}\s*[A-Z]{3}\s*\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
            raw,
        )
        if m:
            extracted["passport_expiry"] = _parse_visual_date(m.group(1))

    # Gender: label "SEX" / "JANTINA" + M/F.
    if not extracted.get("gender"):
        m = re.search(r"(?:\bSEX\b|\bJANTINA\b)\s*:?\s*([MF])\b", raw)
        if m:
            extracted["gender"] = {"M": "Male", "F": "Female"}.get(m.group(1), "")


def _ocr_passport(content: bytes) -> dict:
    """OCR gambar passport guna tesseract (binary sistem, bahasa 'eng').

    Strategi berlapis KONSERVATIF untuk tangkap medan diperlukan dari passport:
    
    PREPROCESSING (MINIMAL):
    - Resize ke minimum 1200px lebar (Tesseract perlsa saiz besar)
    - Grayscale + binarize standard (autocontrast + fixed threshold)

    BINARIZATION (DUA VARIANT SAHAJA):
    - Threshold 140 (standard, terbukti berfungsi)
    - Threshold 130 (sedikit lebih rendah untuk gambar gelap)

    PSM MODES (3 SAHAJA):
    - PSM 6: Assume uniform block of text (MRZ lines) — UTAMA
    - PSM 11: Sparse text — sekunder
    - PSM 4: Single column — fallback

    CROP ZONE:
    - 35% bawah (MRZ zone standard) — sama seperti original
    
    Ini adalah versi SELAMAT yang mengekalkan approach asal tanpa over-engineering.
    """
    import io
    import os
    import re
    import subprocess
    import tempfile

    from PIL import Image, ImageOps

    MRZ_CFG = ["-c", "tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<"]

    extracted = {}
    full_text = ""
    try:
        img = Image.open(io.BytesIO(content))
        
        # Resize minimum 1200px width (Tesseract perform better on larger images)
        if img.width < 1200:
            ratio = 1200 / img.width
            img = img.resize((1200, max(1, int(img.height * ratio))), Image.LANCZOS)
            
        gray = ImageOps.grayscale(img)

        # Crop bawah 35% — lokasi standard blok MRZ (ORIGINAL, tested)
        bottom = gray.crop((0, int(gray.height * 0.65), gray.width, gray.height))
        
        # Hanya DUA binarization variants (tidak terlalu banyak):
        # 1. Standard threshold 140 (original, proven)
        bw_standard = _binarize(bottom.resize((bottom.width * 2, bottom.height * 2)), threshold=140)
        # 2. Slightly lower threshold 130 (untuk gambar lebih gelap)
        bw_dark = _binarize(bottom.resize((bottom.width * 2, bottom.height * 2)), threshold=130)
        # 3. Full image grayscale (fallback visual)
        bw_full = _binarize(gray)

        with tempfile.TemporaryDirectory() as td:
            full_path = os.path.join(td, "full.png")
            mrz_path = os.path.join(td, "mrz.png")
            mrz_std_path = os.path.join(td, "mrz_std.png")
            mrz_dark_path = os.path.join(td, "mrz_dark.png")
            full_bw_path = os.path.join(td, "full_bw.png")
            
            gray.save(full_path)
            bottom.save(mrz_path)
            bw_standard.save(mrz_std_path)
            bw_dark.save(mrz_dark_path)
            bw_full.save(full_bw_path)

            # Pass list: PRIORITI + TERHAD (original order + sedikit variation)
            # Jangan terlalu banyak — 10 passes maksimum
            passes = [
                # Priority 1: MRZ zone with standard binarization (paling reliable)
                (mrz_std_path, "6",  MRZ_CFG, "MRZ-standard-PSM6"),
                (mrz_std_path, "11", MRZ_CFG, "MRZ-standard-PSM11"),
                # Priority 2: MRZ zone with darker threshold (for dark photos)
                (mrz_dark_path, "6",  MRZ_CFG, "MRZ-dark-PSM6"),
                (mrz_dark_path, "11", MRZ_CFG, "MRZ-dark-PSM11"),
                # Priority 3: MRZ zone grayscale (no binarization)
                (mrz_path,    "6",  MRZ_CFG, "MRZ-gray-PSM6"),
                (mrz_path,    "11", MRZ_CFG, "MRZ-gray-PSM11"),
                # Priority 4: Full image (visual fallback)
                (full_bw_path, "6",  [],      "FULL-bw-PSM6"),
                (full_bw_path, "11", [],      "FULL-bw-PSM11"),
                (full_path,    "6",  [],      "FULL-gray-PSM6"),
                (full_path,    "4",  [],      "FULL-gray-PSM4"),
            ]
            
            for path, psm, cfg, desc in passes:
                try:
                    proc = subprocess.run(
                        ["tesseract", path, "stdout", "-l", "eng", "--psm", psm] + cfg,
                        capture_output=True, timeout=30,
                    )
                except Exception:
                    continue
                text = proc.stdout.decode("utf-8", "ignore")
                full_text += "\n" + text
                
                # Try MRZ extraction — stop at first good result
                if not extracted.get("passport_no"):
                    result = _extract_mrz(text)
                    if result and result.get("passport_no"):
                        extracted.update(result)
                        frappe.logger.debug(f"✓ Passport OCR success via {desc}")

        # Final attempt: extract from accumulated full text
        if not extracted.get("passport_no"):
            extracted = _extract_mrz(full_text) or extracted

        # IC Malaysia (NRIC 12 digit) — dicari dalam keseluruhan teks OCR
        m = re.search(r"\b(\d{6}[-\s]?\d{2}[-\s]?\d{4})\b", full_text)
        if m:
            extracted["ic_number"] = re.sub(r"\D", "", m.group(1))

        # Fallback visual: kalau MRZ gagal beri medan utama
        if not extracted.get("passport_no"):
            _extract_visual_fallback(extracted, full_text)
            
        # Log hasil
        if extracted:
            frappe.logger.info(f"Passport OCR extracted: {list(extracted.keys())}")
        else:
            frappe.logger.warning(f"Passport OCR failed. Text length: {len(full_text)}")

    except Exception:
        frappe.log_error(title="Passport OCR failed",
                         message=frappe.get_traceback())

    return extracted


@frappe.whitelist(allow_guest=True)
def check_traveller_passport(filedata: str, guest_token: str = ""):
    """Langkah 1 wizard: customer/guest muat naik gambar passport DULU.

    Server bandingkan imej dengan passport_image Traveller sedia ada
    (exact sha256 + perceptual dhash). Kalau jumpa padanan → return
    status "found" + maklumat penuh traveller untuk prefill form
    (return customer). Kalau tak → status "new".

    Dual-auth: guest passport-link (token) ATAU logged-in customer
    (session). Guest mula di Langkah 1 sama seperti customer — upload
    passport utk OCR recognition + matching traveller terdahulu.

    Nota: tidak persist apa-apa — upload sebenar tetap berlaku masa
    save_booking_traveller. Imj dihantar sebagai base64 data URL.
    """
    if guest_token:
        # Guest path — sahkan token (throw kalau invalid/expired/Verified).
        # booking.customer dipakai utk scope matching traveller (IDOR guard).
        booking, _slot, _actor = _resolve_guest_token(guest_token)
        customer_name = booking.customer
    else:
        customer_name = _get_customer()

    if not filedata:
        frappe.throw("Passport image is required.")

    import base64
    import hashlib

    if "," in filedata:
        filedata = filedata.split(",", 1)[1]
    try:
        content = base64.b64decode(filedata)
    except Exception:
        frappe.throw("Invalid image data.")

    try:
        upload_hash = _dhash(content)
    except Exception:
        frappe.throw("The file could not be read as an image. Please upload a JPG or PNG.")

    exact_hash = hashlib.sha256(content).hexdigest()

    # OCR/MRZ — ekstrak nama, nombor passport, DOB, gender, (IC jika jumpa)
    # daripada imej. Semua ID dinormalisasi ke [A-Z0-9] sebelum matching.
    # Padanan #1: nombor passport. #2: IC number. #3 (fallback terakhir):
    # padanan imej (sha256 exact / dhash perceptual) untuk rekod lama yang
    # ID-nya tidak dapat dibaca daripada passport.
    extracted = _ocr_passport(content)

    # Nationality MRZ (alpha-3) → nama Country Frappe supaya select
    # Nationality pada form boleh di-set terus.
    nat_code = (extracted.pop("nationality_code", "") or "").strip("< ")
    if nat_code:
        country = _country_from_mrz(nat_code)
        if country:
            extracted["nationality"] = country

    _MATCH_FIELDS = ["name", "ic_number", "full_name", "first_name", "last_name", "gender",
                     "date_of_birth", "nationality", "phone", "email",
                     "passport_no", "passport_expiry",
                     "emergency_contact_name", "emergency_contact_phone",
                     "emergency_contact_relationship", "dietary_requirements",
                     "medical_conditions", "special_needs",
                     "wheelchair_assistant", "medicine_treatment", "passport_image"]

    # IDOR guard: hanya boleh padan traveller pada booking customer ini.
    # Tanpa ni, customer A boleh dapat PII penuh traveller customer B
    # dengan tahu nombor passport/IC mereka sahaja.
    owned = _customer_traveller_names(customer_name)

    for match_field, match_value in (
        ("passport_no", _normalize_id(extracted.get("passport_no") or "")),
        ("ic_number",  _normalize_id(extracted.get("ic_number") or "")),
    ):
        if not match_value:
            continue
        traveller_name = _find_traveller_by_normalized(match_field, match_value)
        if traveller_name and traveller_name in owned:
            tvl = frappe.get_doc("Traveller", traveller_name)
            return {"status": "found", "data": _traveller_payload(tvl), "extracted": extracted}

    travellers = (
        frappe.get_all(
            "Traveller",
            # "%/files/%" memadankan "/files/..." (public) DAN
            # "/private/files/..." (private — macam semua upload portal,
            # is_private=1). Filter lama "/files/%" tertapis prefix, jadi
            # image-matching tak pernah berjalan untuk fail private.
            # D scoped kepada traveller customer ini (IDOR guard).
            filters={"name": ["in", list(owned)],
                     "passport_image": ["like", "%/files/%"],
                     "docstatus": ["<", 2]},
            fields=_MATCH_FIELDS,
        )
        if owned
        else []
    )

    for tvl in travellers:
        file_url = tvl.passport_image
        try:
            file_doc = frappe.get_doc("File", {"file_url": file_url})
            existing_content = file_doc.get_content()
        except Exception:
            continue

        matched = False
        if hashlib.sha256(existing_content).hexdigest() == exact_hash:
            matched = True
        else:
            try:
                if _hamming_distance(upload_hash, _dhash(existing_content)) <= 12:
                    matched = True
            except Exception:
                continue

        if matched:
            return {"status": "found", "data": _traveller_payload(tvl), "extracted": extracted}

    # Tiada padanan rekod DAN OCR gagal baca apa-apa medan utama → imej
    # berkemungkinan bukan halaman foto passport / terlalu kabur. Minta
    # customer upload semula (frontend tunjuk mesej, kekal di Langkah 1).
    if not any(extracted.get(k) for k in
               ("passport_no", "ic_number", "first_name", "full_name")):
        return {"status": "unreadable", "extracted": extracted}

    return {"status": "new", "extracted": extracted}


# ══════════════════════════════════════════════
# WIZARD LOOKUP
# ══════════════════════════════════════════════

@frappe.whitelist()
def wizard_lookup(ic_number: str, passport_no: str, full_name: str):
    """Verify traveller identity using IC + Passport + Full Name."""
    customer_name = _get_customer()

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
         "dietary_requirements", "medical_conditions", "special_needs",
         "wheelchair_assistant", "medicine_treatment"],
        as_dict=True
    )

    if not traveller:
        return {"status": "not_found"}

    # IDOR guard: traveller mesti milik customer (ada booking) sebelum PII
    # dipulangkan. Jangan dedah kewujudan rekod customer lain — balas
    # not_found supaya attacker tak tahu traveller itu wujud atau tidak.
    if traveller.name not in _customer_traveller_names(customer_name):
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
        "data": _traveller_payload(traveller, ic_fallback=ic_number),
    }


# ══════════════════════════════════════════════
# REQUEST DOCUMENT UPDATE
# ══════════════════════════════════════════════

@frappe.whitelist()
def request_document_update(slot_name: str):
    """Customer request to unlock a Verified slot for re-editing."""
    customer = _get_customer()

    slot = frappe.db.get_value(
        "Booking Reservation", slot_name,
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

    frappe.db.set_value("Booking Reservation", slot_name, "document_status", "Open for Update")
    frappe.db.commit()

    return {"status": "ok"}


@frappe.whitelist(allow_guest=True)
def confirm_traveller_documents(booking_number: str, slot_name: str,
                                guest_token: str = ""):
    """Butang pengesahan akhir (bar bawah form docs): customer ATAU guest
    (via token) sahkan semua maklumat traveller sudah lengkap. Validasi
    kelengkapan setiap section; set slot & Traveller kepada "Pending"
    (sedia disemak admin) + Comment audit (guna actor — session user
    atau guest email, BUKAN frappe.session.user yang "Guest" kosong)."""
    frappe.flags.ignore_permissions = True
    if guest_token:
        booking, slot, actor = _resolve_guest_token(guest_token)
        booking_number = booking.booking_number
        slot_name = slot.name
    else:
        customer = _get_customer()
        booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                      ["name", "customer"], as_dict=True)
        if not booking:
            frappe.throw("Booking not found.")
        if booking.customer != customer:
            frappe.throw("Access denied.", frappe.PermissionError)
        slot = frappe.db.get_value(
            "Booking Reservation", slot_name,
            ["name", "booking", "document_status", "traveller"], as_dict=True
        )
        if not slot or slot.booking != booking.name:
            frappe.throw("Slot not found.")
        actor = frappe.session.user

    if slot.document_status == "Verified":
        frappe.throw("This slot has been verified by admin and cannot be edited.")
    if not slot.traveller:
        frappe.throw(
            "Please complete and save the Passport section first."
        )

    tvl = frappe.get_doc("Traveller", slot.traveller)

    # Kelengkapan — cermin 3 section form.
    missing = []
    if not (tvl.first_name and tvl.last_name):
        missing.append("First & last name (Passport section)")
    if not _normalize_id(tvl.ic_number):
        missing.append("IC number (Passport section)")
    if not _normalize_id(tvl.passport_no):
        missing.append("Passport number (Passport section)")
    if not tvl.passport_expiry:
        missing.append("Passport expiry (Passport section)")
    if not tvl.passport_image:
        missing.append("Passport copy upload (Passport section)")
    if not tvl.phone:
        missing.append("Phone number (Contact Info section)")
    if not tvl.email:
        missing.append("Email (Contact Info section)")
    if not (tvl.emergency_contact_name and tvl.emergency_contact_phone):
        missing.append("Emergency contact (Contact Info section)")
    if missing:
        frappe.throw(
            "Some details are still incomplete:\n\u2022 " + "\n\u2022 ".join(missing)
        )

    tvl.status = "Pending"
    tvl.save(ignore_permissions=True)

    frappe.db.set_value("Booking Reservation", slot_name, "document_status", "Pending")

    frappe.get_doc({
        "doctype":           "Comment",
        "comment_type":      "Info",
        "reference_doctype": "Traveller",
        "reference_name":    tvl.name,
        "content": (
            "Documents confirmed complete by customer via portal — "
            + frappe.utils.now() + " by " + actor
        ),
    }).insert(ignore_permissions=True)

    frappe.db.commit()

    total_slots  = frappe.db.count("Booking Reservation", {"booking": booking.name})
    filled_count = frappe.db.count("Booking Reservation", {
        "booking":   booking.name,
        "traveller": ["!=", ""]
    })

    return {
        "status":     "ok",
        "slot_name":  slot_name,
        "doc_status": "Pending",
        "all_filled": filled_count >= total_slots and total_slots > 0,
    }


@frappe.whitelist(allow_guest=True)
def get_countries():
    """Return list of countries dari Frappe Country doctype.

    allow_guest: data rujukan awam (tiada PII) — diperlukan supaya guest
    passport-link form (no session) boleh populate dropdown nationality."""
    return frappe.db.get_all(
        "Country",
        fields=["name", "country_name", "code"],
        order_by="country_name asc"
    )


# ══════════════════════════════════════════════
# GUEST PASSPORT LINK (#5) — co-traveller tanpa
# login isi maklumat penuh mereka via token link.
# ══════════════════════════════════════════════

# Role yang dibenarkan trigger guest link dari Desk (admin path).
_GUEST_LINK_ADMIN_ROLES = {"System Manager", "Tour Manager", "Tour Operator"}
_GUEST_LINK_EXPIRY_DAYS = 7


@frappe.whitelist()
def request_guest_passport_link(booking_number: str = "", slot_name: str = "",
                                email: str = ""):
    """Jana/hantar semula link passport untuk co-traveller (guest, no login).

    Dual-auth:
      - Admin (Desk): caller ada role Tour Manager/Tour Operator/System
        Manager → allow terus (tanpa rekod Customer).
      - Customer (portal): else _get_customer() + ownership booking.

    booking_number (RC code) kini tidak digunakan untuk lookup — slot_name
    (docname Booking Reservation) cukup untuk identifiable slot + parent
    Booking (slot.booking). Param kekal untuk keserasian panggilan portal
    lama. Token disimpan pada Booking Reservation (passport_link_token,
    search_index). Reusable sehingga expiry (default 7 hari). Re-call =
    regenerate (token lama di-overwrite → link lama invalidated).
    """
    frappe.flags.ignore_permissions = True
    email = (email or "").strip()
    if email:
        frappe.utils.validate_email_address(email, throw=True)

    # Resolve slot → booking (dari slot.booking). Membolehkan Desk (ada
    # slot_name = frm.doc.name) & portal (ada booking_number + slot_name)
    # guna endpoint yang sama.
    slot = frappe.db.get_value(
        "Booking Reservation", slot_name,
        ["name", "booking", "document_status", "traveller"], as_dict=True
    )
    if not slot:
        frappe.throw("Slot not found.")
    booking = frappe.db.get_value("Booking", slot.booking,
                                  ["name", "customer", "status", "trip_name"], as_dict=True)
    if not booking:
        frappe.throw("Booking not found.")

    roles = set(frappe.get_roles())
    if not (_GUEST_LINK_ADMIN_ROLES & roles):
        # Customer path — verify ownership.
        customer = _get_customer()
        if booking.customer != customer:
            frappe.throw("Access denied.", frappe.PermissionError)

    if slot.document_status == "Verified":
        frappe.throw("This slot has been verified by admin and cannot be edited.")

    token = frappe.generate_hash(length=32)
    expires_on = frappe.utils.add_to_date(frappe.utils.now_datetime(),
                                          days=_GUEST_LINK_EXPIRY_DAYS)

    frappe.db.set_value("Booking Reservation", slot_name, {
        "passport_link_token":      token,
        "passport_link_email":      email,
        "passport_link_expires_on": expires_on,
    })

    link = frappe.utils.get_url("/guest_passport?token=" + token)
    trip_name = booking.trip_name or "your trip"

    # Email opsional (corak "share me"): kalau email diberi, hantar link juga
    # sebagai fallback; jika tidak, caller (portal/Desk) terima link utk dikongsi
    # terus — WhatsApp / Web Share / salin. Orang sekarang lebih suka kongsi
    # link sendiri berbanding menaip email co-traveller.
    if email:
        frappe.sendmail(
            recipients=[email],
            subject="Submit your passport details — " + str(trip_name),
            message=(
                "<p>Hello,</p>"
                "<p>You've been invited to submit your passport and travel details for "
                "<strong>" + frappe.utils.escape_html(str(trip_name)) + "</strong>.</p>"
                "<p>Please use the secure link below to complete your information. "
                "The link is valid until " + frappe.utils.format_datetime(expires_on) + ".</p>"
                "<p style='margin:24px 0'>"
                "<a href='" + link + "' style='display:inline-block;padding:12px 24px;"
                "background:#2563eb;color:#fff;text-decoration:none;border-radius:6px'>"
                "Submit Passport Details</a></p>"
                "<p style='color:#6b7280;font-size:12px'>"
                "If you didn't expect this email, you can safely ignore it.</p>"
            ),
        )
        masked = email[:2] + "***" + email[email.index("@"):] if "@" in email else email
    else:
        masked = ""

    # ── Generate QR Code (base64 PNG data URI) ──
    qr = qrcode.QRCode(
        version=1, box_size=10, border=2,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
    )
    qr.add_data(link)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    qr_data_uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

    return {
        "status":       "sent" if email else "generated",
        "link":         link,
        "masked_email": masked,
        "expires_on":   str(expires_on),
        "qr_data_uri":  qr_data_uri,
    }


@frappe.whitelist(allow_guest=True)
def verify_guest_token(token: str = ""):
    """Sahkan token & pulangkan konteks slot untuk guest form (allow_guest).

    Guest equivalent of get_booking_data scoped ke 1 slot: semua medan
    traveller untuk pre-fill form, status passport/visa, dan metadata
    booking (trip, departure) untuk header. Slot locked (Verified) ATAU
    token tamat tempoh → throw (via _resolve_guest_token).
    """
    frappe.flags.ignore_permissions = True
    booking, slot, _actor = _resolve_guest_token(token)

    trip_name      = frappe.db.get_value("Booking", booking.name, "trip_name") or ""
    departure_date = frappe.db.get_value("Booking", booking.name, "departure_date")

    ctx = {
        "mode":            "guest",
        "token":           token,
        "booking_number":  booking.booking_number,
        "slot_name":       slot.name,
        "slot_label":      "Guest Traveller",
        "trip_name":       trip_name,
        "departure_date":  str(departure_date) if departure_date else "",
        "document_status": slot.document_status or "Pending",
        "is_verified":     slot.document_status == "Verified",
        "traveller_id":    slot.traveller or "",
        "has_passport":    False,
        "has_visa_photo":  False,
        "passport_image":  "",
        "visa_photo":      "",
        "full_name":       "",
        "first_name":      "",
        "last_name":       "",
        "ic_number":       "",
        "passport_no":     "",
        "passport_expiry": "",
        "nationality":     "",
        "date_of_birth":   "",
        "email":           "",
        "phone":           "",
        "gender":          "",
        "emergency_contact_name":         "",
        "emergency_contact_phone":        "",
        "emergency_contact_relationship": "",
        "dietary_requirements": "",
        "medical_conditions":   "",
        "special_needs":        "",
    }

    if slot.traveller:
        t = frappe.db.get_value(
            "Traveller", slot.traveller,
            ["full_name", "first_name", "last_name", "ic_number", "passport_no",
             "passport_expiry", "nationality", "date_of_birth", "email", "phone",
             "gender", "passport_image", "visa_photo", "emergency_contact_name",
             "emergency_contact_phone", "emergency_contact_relationship",
             "dietary_requirements", "medical_conditions", "special_needs",
             "medicine_treatment", "wheelchair_assistant"],
            as_dict=True,
        )
        if t:
            ctx.update({
                "full_name":                       t.full_name or "",
                "first_name":                      t.first_name or "",
                "last_name":                       t.last_name or "",
                "ic_number":                       t.ic_number or "",
                "passport_no":                     t.passport_no or "",
                "passport_expiry":                 str(t.passport_expiry) if t.passport_expiry else "",
                "nationality":                     t.nationality or "",
                "date_of_birth":                   str(t.date_of_birth) if t.date_of_birth else "",
                "email":                           t.email or "",
                "phone":                           t.phone or "",
                "gender":                          t.gender or "",
                "has_passport":                    bool(t.passport_image),
                "has_visa_photo":                  bool(t.visa_photo),
                "passport_image":                  t.passport_image or "",
                "visa_photo":                      t.visa_photo or "",
                "emergency_contact_name":          t.emergency_contact_name or "",
                "emergency_contact_phone":         t.emergency_contact_phone or "",
                "emergency_contact_relationship":  t.emergency_contact_relationship or "",
                "dietary_requirements":            t.dietary_requirements or "",
                "medical_conditions":              t.medical_conditions or "",
                "special_needs":                   t.special_needs or "",
                "medicine_treatment":              t.medicine_treatment or "",
                "wheelchair_assistant":            t.wheelchair_assistant or "",
            })
            if t.full_name:
                ctx["slot_label"] = t.full_name

    return ctx


# ══════════════════════════════════════════════
# FILE SERVING (#3) — gambar passport/visa disimpan
# is_private:1 pada Traveller; customer (tiada role Traveller) & guest
# (no session) tak boleh akses /private/files/... terus. Endpoint ni baca
# fail & pulangkan sebagai data URL base64 (selamat untuk <img src>).
# ══════════════════════════════════════════════

def _serve_traveller_file(traveller_name: str, field: str):
    """Baca fail lampiran (is_private) dari Traveller.<field> & pulangkan
    data URL base64. Dipanggil oleh get_slot_file (session) & get_guest_file
    (token) — kedua-duanya sudah sahkan akses sebelum panggil ni."""
    import base64
    import mimetypes

    if not traveller_name:
        return {"data_url": ""}
    file_url = frappe.db.get_value("Traveller", traveller_name, field)
    if not file_url:
        return {"data_url": ""}

    file_id = frappe.db.get_value("File", {"file_url": file_url}, "name")
    if not file_id:
        return {"data_url": ""}
    content = frappe.get_doc("File", file_id).get_content()
    if not content:
        return {"data_url": ""}

    mime, _ = mimetypes.guess_type(file_url)
    if not mime:
        mime = "application/octet-stream"
    b64 = base64.b64encode(content).decode("ascii")
    return {"data_url": "data:" + mime + ";base64," + b64}


@frappe.whitelist()
def get_slot_file(booking_number: str, slot_name: str, field: str = "passport_image"):
    """Pulangkan fail passport/visa (base64 data URL) untuk slot milik
    customer yang sedang login. field = "passport_image" | "visa_photo"."""
    frappe.flags.ignore_permissions = True
    if field not in ("passport_image", "visa_photo"):
        frappe.throw("Invalid file field.")

    customer = _get_customer()
    booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                  ["name", "customer"], as_dict=True)
    if not booking:
        frappe.throw("Booking not found.")
    if booking.customer != customer:
        frappe.throw("Access denied.", frappe.PermissionError)

    slot = frappe.db.get_value("Booking Reservation", slot_name,
                               ["name", "booking", "traveller"], as_dict=True)
    if not slot or slot.booking != booking.name:
        frappe.throw("Slot not found.")

    return _serve_traveller_file(slot.traveller, field)


@frappe.whitelist(allow_guest=True)
def get_guest_file(token: str = "", field: str = "passport_image"):
    """Pulangkan fail passport/visa (base64 data URL) untuk slot yang
    diakses guest via token link. Token sahkan akses (token + expiry +
    bukan Verified)."""
    frappe.flags.ignore_permissions = True
    if field not in ("passport_image", "visa_photo"):
        frappe.throw("Invalid file field.")

    _booking, slot, _actor = _resolve_guest_token(token)
    return _serve_traveller_file(slot.traveller, field)