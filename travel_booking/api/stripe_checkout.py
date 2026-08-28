# travel_booking/api/stripe_checkout.py
#
# Custom Stripe checkout — kita kawal UI (checkout.html) + redirect penuh.
# Payment Request tetap dicipta (untuk rekod + guna semula method set_as_paid
# yang sedia ada), tapi bayaran sebenar diproses terus dengan Stripe API
# (PaymentIntent) supaya kita boleh bina halaman checkout sendiri.
#
# SUMBER KEBENARAN status bayaran = WEBHOOK (server-to-server), BUKAN redirect
# browser. Redirect cuma untuk UX (bawa customer balik ke halaman betul).

import frappe
import stripe
from frappe import _

from travel_booking.api._helpers import get_customer_email


def _rate_limit(scope, max_requests, window_sec):
    """Rate limiting generik per-IP guna Redis cache (frappe.cache()).

    Pulangkan True kalau request ini DIBENARKAN (bawah had), False kalau
    dah melebihi had (caller patut frappe.throw atau return ignored).

    Corak ni sama dengan send_otp() di otp.py — key berasaskan scope + IP,
    counter + TTL eksplisit (bukan bergantung pada tingkah laku Redis SET
    yang tak jelas didokumenkan untuk TTL retention).
    """
    client_ip = frappe.local.request_ip or "unknown"
    key = "rate_" + scope + "_" + client_ip
    count = frappe.cache().get_value(key)
    if count and int(count) >= max_requests:
        return False
    frappe.cache().set_value(key, str(int(count or 0) + 1), expires_in_sec=window_sec)
    return True


def _get_stripe_settings(currency=None):
    """Selesaikan Stripe Settings (publishable_key/secret_key/webhook signing
    secret) + Payment Gateway Account daripada Travel Settings.currency_accounts
    (child table "Travel Currency Account" — satu baris per currency yang
    disokong: MYR, SGD, BND, dsb — rujuk dokumen reka bentuk multi-currency).

    PENTING — "Pilihan A" (satu akaun Stripe untuk SEMUA currency, bukan
    banyak Stripe Settings berasingan): setiap baris currency_accounts
    ada payment_gateway_account SENDIRI (untuk payment_account/ledger
    perakaunan yang betul ikut currency), tapi SEMUA baris tu sepatutnya
    berkongsi Payment Gateway (dan Stripe Settings — API key/webhook
    secret) yang SAMA. Jadi:

    - currency DIBEKALKAN (cth create_payment_intent, perlukan ledger
      account yang TEPAT untuk currency SO tu) -> cari baris currency_accounts
      yang currency-nya PADAN.
    - currency TIADA dibekalkan (webhook, checkout context, payment result
      — semua tempat yang cuma perlukan API key/webhook secret KONGSI,
      bukan ledger account spesifik) -> guna baris PERTAMA yang ada
      payment_gateway_account (mana-mana pun sepatutnya beri Stripe
      Settings yang SAMA, sebab kongsi Payment Gateway).

    Rantaian resolusi (sama macam sebelum ni, cuma sumber gateway_account
    sekarang dari child table, bukan field payment_gateway tunggal):
      Travel Settings.currency_accounts[i].payment_gateway_account
        -> Payment Gateway Account.payment_gateway  (Link -> Payment Gateway)
          -> Payment Gateway.gateway_controller      (nama Stripe Settings)
            -> Stripe Settings (publishable_key / secret_key /
                                 custom_webhook_signing_secret)

    Tambah currency baharu = tambah baris baharu di Travel Settings (Desk),
    TIADA keperluan code/deploy — konsisten dengan keperluan "reka bentuk
    sebarang currency" (bukan hardcode SGD/BND).
    """
    settings = frappe.get_cached_doc("Travel Settings")
    rows = settings.get("currency_accounts") or []
    if not rows:
        frappe.throw(
            "No Currency Account configured in Travel Settings "
            "(under 'Multi Currency Account'). Please contact admin."
        )

    gateway_account_name = None
    if currency:
        for row in rows:
            if row.currency == currency and row.payment_gateway_account:
                gateway_account_name = row.payment_gateway_account
                break
        if not gateway_account_name:
            frappe.throw(
                "No Payment Gateway Account configured for currency '" +
                str(currency) + "' in Travel Settings. Please contact admin."
            )
    else:
        for row in rows:
            if row.payment_gateway_account:
                gateway_account_name = row.payment_gateway_account
                break
        if not gateway_account_name:
            frappe.throw(
                "No Payment Gateway Account configured in any "
                "Currency Account row in Travel Settings. Please contact admin."
            )

    gateway_account = frappe.db.get_value(
        "Payment Gateway Account", gateway_account_name,
        ["name", "payment_gateway", "payment_account"], as_dict=True
    )
    if not gateway_account:
        frappe.throw(
            "Payment Gateway Account '" + str(gateway_account_name) +
            "' (set in Travel Settings) not found. Please contact admin."
        )

    settings_name = frappe.db.get_value(
        "Payment Gateway", gateway_account.payment_gateway, "gateway_controller"
    )
    if not settings_name or not frappe.db.exists("Stripe Settings", settings_name):
        frappe.throw(
            "Stripe Settings for Payment Gateway Account '" + gateway_account_name +
            "' not found. Please contact admin."
        )

    ss = frappe.get_doc("Stripe Settings", settings_name)
    return ss, gateway_account


def _get_all_stripe_settings():
    """SEMUA Stripe Settings BERBEZA yang dikonfigurasikan merentasi Travel
    Settings.currency_accounts — sokong model "Pilihan B" (akaun Stripe
    berasingan per currency, cth MYR + SGD; setiap baris currency_accounts
    point ke Payment Gateway Account → Stripe Settings sendiri).

    Kegunaan:
      - stripe_webhook(): event dari mana-mana akaun perlu verify signature
        dengan secret akaun YANG MENGAKAN event tu — loop semua sekali.
      - get_payment_result(): intent ID scoped kepada akaun yang mencipta
        dia — try retrieve dari setiap akaun sampai jumpa.

    Deduplicate ikut nama Stripe Settings supaya loop webhook tak verify
    secret yang sama berulang kali (cth semua row share satu gateway
    semasa "Pilihan A" — jadi list ni panjangnya 1, behaviour sama macam
    sebelum ni). Pulangkan [] kalau tiada konfigurasi sah (caller handle).
    """
    settings = frappe.get_cached_doc("Travel Settings")
    rows = settings.get("currency_accounts") or []

    out = []
    seen = set()
    for row in rows:
        if not row.payment_gateway_account:
            continue
        gateway_account = frappe.db.get_value(
            "Payment Gateway Account", row.payment_gateway_account,
            ["name", "payment_gateway", "payment_account"], as_dict=True
        )
        if not gateway_account:
            continue
        settings_name = frappe.db.get_value(
            "Payment Gateway", gateway_account.payment_gateway, "gateway_controller"
        )
        if not settings_name or not frappe.db.exists("Stripe Settings", settings_name):
            continue
        if settings_name in seen:
            continue
        seen.add(settings_name)
        out.append((frappe.get_doc("Stripe Settings", settings_name), gateway_account))
    return out


@frappe.whitelist()
def create_payment_intent(sales_order: str, amount: float, source: str = "portal", booking_number: str = None, pr_amount: float = None, return_to: str = None):
    """Cipta Payment Request (rekod) + Stripe Payment Intent (bayaran sebenar).
    source: "wizard" (booking baru, guest) atau "portal" (customer login).
    Pulangkan info untuk checkout.html render Stripe Elements.

    SECURITY FIX (v2): Amount kini divalidasi server-side:
      - Verify ownership: hanya customer pemilik SO boleh cipta payment intent
      - Enforce minimum deposit (20% of grand_total dari Travel Settings)
      - Cap amount to outstanding balance (elak overpayment)

    'amount' = jumlah SEBENAR PaymentIntent Stripe (apa yang customer bayar
    dalam SATU transaksi kad).
    'pr_amount' (opsyenal) = jumlah untuk Payment Request ERPNext SAHAJA,
    di-cap kepada baki SO ni sendiri. Kalau tak diberi, default = amount.
    Payment Request TIDAK BOLEH melebihi baki SO rujukannya (ERPNext core
    validate_payment_request_amount() throw kalau begitu).

    'return_to' (opsyenal) — laluan portal untuk redirect balik selepas
    bayar (cth booking_billing?ref=...). Disahkan sanitI di sini juga
    (endpoint ni whitelisted sendiri — jangan percaya caller).
    """
    so = frappe.db.get_value("Sales Order", sales_order,
                             ["customer", "currency", "grand_total", "advance_paid"], as_dict=True)
    if not so:
        frappe.throw("Sales Order not found.")

    # ══════════════════════════════════════════════
    # SECURITY: Verify ownership — elak IDOR/payment hijacking.
    # Skip untuk source="wizard" (booking baru oleh Guest) — SO baru
    # dicipta oleh confirm_booking dalam request yang sama, ownership
    # implicit. check ni hanya untuk portal (customer login bayar SO
    # sedia ada).
    # ══════════════════════════════════════════════
    if source != "wizard":
        from travel_booking.api._helpers import get_customer_by_email
        session_customer = get_customer_by_email(frappe.session.user)
        if session_customer and session_customer != so.customer:
            frappe.throw(
                _("You do not have permission to make payments for this order."),
                title="Permission Denied"
            )

    amount = float(amount)
    if amount <= 0:
        frappe.throw("Invalid amount.")

    # Baki rujukan — standardize ke grand_total (rujuk nota "Disable
    # Rounded Total" global di atas).
    effective_so_total = float(so.grand_total or 0)
    outstanding = round(effective_so_total - float(so.advance_paid or 0), 2)

    # Jaring keselamatan float precision: 'amount' (jumlah SEBENAR caj
    # Stripe) yang caller kira secara berasingan (cth booking.py's
    # confirm_booking) patut sepadan dengan outstanding grand_total di
    # sini, tapi kita cap balik ke outstanding sebenar kalau ada lebihan
    # kecil (cth ralat float) untuk full-payment SO yang sama — supaya caj
    # kad dan rekod ERPNext SENTIASA padan.
    if amount > outstanding + 0.01 and abs(amount - float(so.grand_total or 0)) < 0.01:
        amount = max(outstanding, 0)
        if amount <= 0:
            frappe.throw("No balance to pay on this Sales Order.")

    # ══════════════════════════════════════════════
    # SECURITY: Enforce minimum deposit — elak bayar RM0.01
    # ══════════════════════════════════════════════
    try:
        settings = frappe.get_single("Travel Settings")
        min_deposit_pct = float(getattr(settings, 'default_deposit_percent', None) or 20)
        online_min = float(getattr(settings, "online_payment_min_amount", 0) or 0)
    except Exception:
        min_deposit_pct = 20  # fallback
        online_min = 0

    effective_so_total = float(so.grand_total or 0)
    min_deposit = round(effective_so_total * (min_deposit_pct / 100), 2)

    # Jika amount kurang dari minimum deposit (dan bukan full payment), reject
    if amount < min_deposit and abs(amount - effective_so_total) > 0.01:
        frappe.throw(
            _("Minimum payment is {0}% ({1}) of total order amount {2}. "
              "Please contact support for special arrangements.").format(
                min_deposit_pct,
                frappe.utils.fmt_currency(min_deposit, currency=so.currency or "MYR"),
                frappe.utils.fmt_currency(effective_so_total, currency=so.currency or "MYR")
            ),
            title="Amount Below Minimum"
        )

    # ══════════════════════════════════════════════
    # SECURITY: Online Payment minimum amount (Travel Settings).
    # Stripe ada minimum charge per currency; bila jumlah caj di bawah nilai
    # ni, reject supaya checkout tak gagal di hujung Stripe. 0 = dilumpuhkan.
    # ══════════════════════════════════════════════
    if online_min and amount < online_min:
        frappe.throw(
            _("Online payment requires a minimum of {0}.").format(
                frappe.utils.fmt_currency(online_min, currency=so.currency or "MYR")
            ),
            title="Below Online Payment Minimum"
        )

    # Cap amount to outstanding (elak overpayment)
    if amount > outstanding + 0.01:
        amount = outstanding

    pr_amount = float(pr_amount) if pr_amount is not None else amount
    if pr_amount <= 0:
        frappe.throw("Invalid amount.")

    # Cap pr_amount ke baki SEBENAR — elak validate_payment_request_amount()
    # throw disebabkan pr_amount kita sedikit melebihi baki (ralat float).
    if pr_amount > outstanding + 0.01:
        pr_amount = max(outstanding, 0)
    if pr_amount <= 0:
        frappe.throw("No balance to pay on this Sales Order.")

    currency = so.currency or "MYR"
    ss, gateway_account = _get_stripe_settings(currency)

    email = get_customer_email(so.customer)

    # PENTING: buang dulu Payment Request LAMA (submitted, docstatus=1) untuk
    # SO ini yang belum "Paid" — cth dari percubaan bayar sebelum ini yang
    # gagal/ditinggalkan tanpa selesai. ERPNext core
    # (get_existing_payment_request_amount) MENGUMPUL jumlah SEMUA Payment
    # Request submitted untuk SO yang sama (tak kira status), dan
    # validate_payment_request_amount() throw "Total Payment Request amount
    # cannot be greater than Sales Order amount" bila jumlah terkumpul tu
    # (+ request baru) melebihi baki SO — walaupun request baru sendiri sah.
    old_prs = frappe.get_all(
        "Payment Request",
        filters={
            "reference_doctype": "Sales Order",
            "reference_name":    sales_order,
            "docstatus":         1,
            "status":            ["!=", "Paid"],
        },
        pluck="name",
    )
    for old_pr_name in old_prs:
        try:
            old_pr = frappe.get_doc("Payment Request", old_pr_name)
            old_pr.flags.ignore_permissions = True
            old_pr.cancel()
        except Exception as e:
            frappe.log_error(
                "Failed to cancel old Payment Request " + old_pr_name + " for " + sales_order + ": " + str(e),
                "Payment Request Cleanup Error"
            )

    # Payment Request — rekod + guna semula method set_as_paid (ERPNext core)
    # yang dicetuskan oleh webhook selepas bayaran disahkan Stripe.
    # PENTING: payment_account/payment_gateway SENGAJA tidak diisi semasa
    # INSERT/SUBMIT (rujuk db_set() SELEPAS pr.submit() di bawah untuk
    # bila field ni sebenarnya diisi).
    # Payment Request ini cuma rekod + kenderaan untuk set_as_paid() via webhook —
    # kita TAK guna pr.get_payment_url() (checkout.html + Stripe PaymentIntent kita
    # sendiri yang jana URL bayaran). Kalau payment_account/payment_gateway diisi
    # SEBELUM submit(), ERPNext cuba resolve payment gateway controller semasa
    # submit() (before_submit -> set_payment_request_url() -> get_payment_url()) —
    # laluan ini rapuh terhadap ketidakserasian versi antara app 'payments' dan
    # 'erpnext', dan tiada exception handling yang lengkap di situ. Dengan kedua
    # field ni kosong SEMASA submit(), syarat "if self.payment_account and
    # self.payment_gateway" jadi False, laluan tu terus dilangkau — submit() jadi
    # selamat sepenuhnya. Field diisi SELEPAS submit() (via db_set(), tak
    # re-trigger validate()) supaya set_as_paid() (dipanggil kemudian via webhook)
    # tetap ada rujukan akaun yang betul — tanpa ni, ERPNext fallback ke akaun
    # Cash lalai company bila cipta Payment Entry, bukan akaun Bank/Stripe sebenar.
    #
    # grand_total guna pr_amount (dicap ke baki SO ni), BUKAN amount penuh —
    # kalau tidak validate_payment_request_amount() akan throw untuk booking
    # gabungan di mana amount penuh > baki SO tunggal ni.
    pr = frappe.get_doc({
        "doctype":                 "Payment Request",
        "payment_request_type":    "Inward",
        "party_type":              "Customer",
        "party":                   so.customer,
        "reference_doctype":       "Sales Order",
        "reference_name":          sales_order,
        "grand_total":             pr_amount,
        "currency":                currency,
        "email_to":                email or "",
        "mute_email":              1,
    })
    pr.insert(ignore_permissions=True)
    pr.submit()

    # PENTING: set payment_account/payment_gateway SELEPAS submit() (guna
    # db_set(), bukan sebelum/semasa insert) — db_set() terus tulis DB,
    # TAK re-trigger validate()/before_submit(), jadi laluan rapuh yang
    # sengaja kita elak (rujuk nota di atas) tetap tak tersentuh. Tanpa
    # ni, set_as_paid() (dipanggil KEMUDIAN via webhook selepas Stripe
    # sahkan bayaran) tiada rujukan akaun yang betul untuk Payment Entry
    # yang ia cipta — ERPNext fallback ke akaun Cash lalai company
    # (punca Payment Entry Online Payment tersalah papar "Cash" sebagai
    # Paid To, bukan akaun Bank/Stripe yang sepatutnya).
    pr.db_set("payment_account", gateway_account.payment_account, update_modified=False)
    pr.db_set("payment_gateway", gateway_account.payment_gateway, update_modified=False)

    stripe.api_key = ss.get_password("secret_key")

    intent = stripe.PaymentIntent.create(
        amount=int(round(amount * 100)),
        currency=currency.lower(),
        receipt_email=email or None,
        description="Rarecruise Payment — " + sales_order,
        metadata={
            "payment_request": pr.name,
            "sales_order":     sales_order,
            "source":          source,
            "booking_number":  booking_number or "",
        },
    )

    # PENTING: simpan pautan pr.name -> intent.id secara EKSPLISIT dalam cache.
    # Payment Request document di Frappe boleh DIPADAM (bukan sekadar
    # dibatalkan) — bila itu berlaku, nombor siri autoname (cth
    # "ACC/PRQ/2026/00037") akan DIGUNA SEMULA oleh Payment Request
    # BAHARU yang lain pada masa depan. Tapi Stripe metadata "payment_request"
    # pada PaymentIntent LAMA kekal menyimpan nombor siri yang sama — jadi
    # stripe.PaymentIntent.search(query="metadata['payment_request']:'X'")
    # boleh pulangkan BERBILANG PaymentIntent dari sesi/booking yang
    # LANGSUNG TAK BERKAITAN (nombor PR sama tapi document sebenar berbeza),
    # dan carian tu tiada jaminan susunan ikut tarikh terkini dahulu —
    # get_checkout_context() boleh terambil intent LAMA yang salah (amount
    # salah sepenuhnya). Cache ni jadi sumber kebenaran pautan pr -> intent
    # untuk PR SEMASA sahaja (bukan carian metadata yang ambigu merentasi
    # sejarah). TTL 2 jam cukup untuk customer settle checkout.
    frappe.cache().set_value(
        "checkout_intent_" + pr.name,
        intent.id,
        expires_in_sec=7200
    )

    frappe.db.commit()

    # 'ret' — laluan pulangan portal (sudah disahkan). checkout.js bawa
    # customer ke laluan ini selepas Stripe redirect balik; tanpa 'ret',
    # fallback /traveller_portal/transactions (tingkah laku lama).
    from urllib.parse import quote
    from travel_booking.api._helpers import sanitize_portal_return_path
    safe_return_to = sanitize_portal_return_path(return_to)

    checkout_url = frappe.utils.get_url(
        "/checkout?pr=" + quote(pr.name, safe="") +
        "&src=" + quote(source, safe="") +
        (("&ref=" + quote(booking_number, safe="")) if booking_number else "") +
        (("&ret=" + quote(safe_return_to, safe="")) if safe_return_to else "")
    )

    return {
        "status":           "ok",
        "payment_request":  pr.name,
        "checkout_url":     checkout_url,
    }


@frappe.whitelist(allow_guest=True)
def get_checkout_context(pr: str):
    """Dipanggil oleh checkout.html untuk dapatkan client_secret + publishable_key.
    Tak dedah secret_key — hanya client_secret (selamat untuk frontend, ikut design Stripe).

    SECURITY FIX (v2): Tambah rate limiting untuk elak enumerasi PR names.
    """
    # ══════════════════════════════════════════════
    # SECURITY: Rate limit — elak enumerate PR names (IDOR)
    # ══════════════════════════════════════════════
    if not _rate_limit("checkout_context", 20, 60):
        frappe.throw("Too many requests. Please try again later.")

    if not frappe.db.exists("Payment Request", pr):
        frappe.throw("Payment request not found.")

    pr_doc = frappe.get_doc("Payment Request", pr)
    if pr_doc.status == "Paid":
        return {"status": "already_paid"}

    # MULTI-ACCOUNT ("Pilihan B"): publishable key & API key MESTI dari
    # akaun Stripe yang SAMA yang mencipta PaymentIntent untuk currency ni
    # — resolve ikut currency PR (setiap row currency_accounts boleh point
    # ke Stripe Settings berbeza). Fallback ke resolution generik kalau PR
    # lama tiada currency (data legacy).
    if pr_doc.currency:
        ss, _ = _get_stripe_settings(pr_doc.currency)
    else:
        ss, _ = _get_stripe_settings()
    stripe.api_key = ss.get_password("secret_key")

    # PENTING: cari Payment Intent EKSAK guna cache pr.name -> intent.id yang
    # disimpan di create_payment_intent() (SUMBER KEBENARAN). TIDAK guna
    # stripe.PaymentIntent.search() lagi sebagai laluan utama — nombor siri
    # autoname Payment Request (cth "ACC/PRQ/2026/00037") boleh DIGUNA SEMULA
    # oleh Frappe selepas document lama dipadam, tapi metadata Stripe pada
    # PaymentIntent LAMA (dari booking/sesi lain yang langsung tak berkaitan)
    # kekal ada nombor PR yang sama — search() query metadata boleh pulangkan
    # >1 hasil merentasi sejarah yang tak berkaitan, tanpa jaminan susunan
    # ikut tarikh, dan get_checkout_context() boleh terambil intent SALAH
    # (amount lapuk dari booking lama). Cache ni elak isu tu sepenuhnya.
    intent = None
    cached_intent_id = frappe.cache().get_value("checkout_intent_" + pr)
    if cached_intent_id:
        try:
            candidate = stripe.PaymentIntent.retrieve(cached_intent_id)
            # Sahkan intent ni betul-betul untuk PR ini (double-check metadata,
            # bukan sekadar percaya cache buta) sebelum guna.
            if (candidate.metadata or {}).get("payment_request") == pr:
                intent = candidate
        except Exception:
            intent = None

    if not intent:
        # Fallback: cache miss/expired (cth checkout.html dibuka lama selepas
        # PaymentIntent dicipta). search() masih boleh silap dalam kes yang
        # sangat jarang (PR name recycled + cache dah expired serentak), tapi
        # ini jauh lebih baik daripada laluan utama sentiasa guna search().
        intents = stripe.PaymentIntent.search(
            query="metadata['payment_request']:'" + pr + "'"
        )
        if intents and intents.data:
            intent = intents.data[0]
        else:
            intent = stripe.PaymentIntent.create(
                amount=int(round(float(pr_doc.grand_total) * 100)),
                currency=(pr_doc.currency or "MYR").lower(),
                metadata={"payment_request": pr, "sales_order": pr_doc.reference_name},
            )
        frappe.cache().set_value("checkout_intent_" + pr, intent.id, expires_in_sec=7200)

    # PENTING: amount dipulangkan dari intent.amount (Stripe PaymentIntent
    # SEBENAR), BUKAN pr_doc.grand_total. pr_amount (di create_payment_intent())
    # boleh mengecapkan Payment Request ERPNext kepada baki SO tunggal supaya
    # lulus validate_payment_request_amount(), tapi PaymentIntent Stripe tetap
    # guna 'amount' PENUH yang customer sebenarnya bayar. pr_doc.grand_total
    # di sini boleh jadi lebih kecil dari yang customer patut dicaj — jangan
    # guna untuk paparan.
    return {
        "status":           "ok",
        "client_secret":    intent.client_secret,
        "publishable_key":  ss.publishable_key,
        "amount":           float(intent.amount) / 100.0,
        "currency":         pr_doc.currency or "MYR",
    }


@frappe.whitelist(allow_guest=True)
def mark_checkout_timeout(pr: str):
    """Dipanggil oleh checkout.html bila countdown 5 minit tamat tanpa
    bayaran berjaya (customer tinggal page tu terbuka, tak siapkan bayaran).
    Hantar emel "Pending" (kalau belum) supaya customer dapat pautan untuk
    sambung bayaran dari portal kemudian. Idempotent — kalau booking dah
    "Accepted"/lebih (cth bayaran sempat berjaya serentak), tak buat apa-apa.
    Tak sentuh Payment Request/PaymentIntent Stripe — ia kekal, akan
    digantikan automatik bila customer cuba bayar semula dari portal.
    """
    # Rate limiting per-IP — endpoint ni allow_guest=True, jadi sesiapa boleh
    # panggil. Idempotent memang (booking yang dah Accepted diabaikan), tapi
    # tanpa had kadar, bot boleh flood trigger panggilan DB + email untuk
    # beribu-ribu Payment Request name yang teka. Had 5/minit/IP cukup untuk
    # customer sebenar (satu checkout = satu timeout) tapi cukup ketat untuk
    # block abuse. Corak sama dengan send_otp() di otp.py.
    if not _rate_limit("checkout_timeout", max_requests=5, window_sec=60):
        frappe.throw("Too many requests. Please try again shortly.")

    if not pr or not frappe.db.exists("Payment Request", pr):
        return {"status": "ignored"}

    pr_doc = frappe.db.get_value("Payment Request", pr, "reference_name")
    if not pr_doc:
        return {"status": "ignored"}

    booking_name = frappe.db.get_value("Sales Order", pr_doc, "custom_booking")
    if not booking_name:
        return {"status": "ignored"}

    status = frappe.db.get_value("Booking", booking_name, "status")
    if status != "Pending":
        return {"status": "ignored"}

    from travel_booking.api.email_service import _send_status_email
    _send_status_email(booking_name, "Pending")
    return {"status": "ok"}


@frappe.whitelist(allow_guest=True)
def cancel_checkout_payment(pr: str):
    """Batalkan Payment Request + Stripe PaymentIntent bila customer tekan
    "Back" di checkout.html (tukar kaedah bayar / cuba semula dari booknow).
    Dipanggil SEBELUM redirect kembali ke booknow/portal.

    Idempotent: kalau PR dah Paid/cancelled atau PaymentIntent dah selesai,
    tak buat apa-apa berbahaya — cuma pastikan PR lokal dibatalkan supaya
    SO bebas untuk Payment Request baharu bila customer cuba bayar semula.
    """
    # Rate limiting per-IP — endpoint allow_guest=True, PR name sequential
    # (boleh diteka). Had 10/minit/IP cukup untuk customer sebenar tapi block
    # enumerate/grief cancel PR orang lain. Corak sama dgn endpoint sebelah.
    if not _rate_limit("checkout_cancel", max_requests=10, window_sec=60):
        frappe.throw("Too many requests. Please try again shortly.")

    if not pr or not frappe.db.exists("Payment Request", pr):
        return {"status": "not_found"}

    pr_doc = frappe.get_doc("Payment Request", pr)

    # Guard: kalau dah Paid, JANGAN batalkan — bayaran dah berjaya, webhook dah
    # jalan. UI sembunyikan butang Back bila dah Paid, tapi ni defense-in-depth.
    if pr_doc.status == "Paid" or pr_doc.docstatus != 1:
        return {"status": "not_cancelled", "reason": pr_doc.status}

    # Cancel Stripe PaymentIntent dulu — elak customer selesaikan bayaran lama
    # selepas tekan Back. Intent ID di cache (sumber kebenaran, rujuk
    # get_checkout_context). Kalau tak boleh cancel (succeeded/processing),
    # abaikan — PR lokal tetap dibatalkan di bawah.
    try:
        if pr_doc.currency:
            ss, _ = _get_stripe_settings(pr_doc.currency)
        else:
            ss, _ = _get_stripe_settings()
        stripe.api_key = ss.get_password("secret_key")
        cached_intent_id = frappe.cache().get_value("checkout_intent_" + pr)
        if cached_intent_id:
            try:
                pi = stripe.PaymentIntent.retrieve(cached_intent_id)
                if pi.status not in ("succeeded", "processing", "canceled"):
                    stripe.PaymentIntent.cancel(
                        cached_intent_id,
                        cancellation_reason="requested_by_customer",
                    )
            except Exception:
                pass  # intent dah expired/berubah status — tak apa
        frappe.cache().delete_value("checkout_intent_" + pr)
    except Exception:
        # Stripe failure (settings tak resolve dll) JANGAN halang cancel PR lokal
        frappe.log_error(
            "Stripe cancel failed for PR " + str(pr),
            "Checkout Back Cancel Warning"
        )

    # Cancel Payment Request ERPNext (docstatus 1 -> 2 cancelled) supaya SO
    # bebas untuk Payment Request baharu bila customer cuba bayar semula.
    try:
        pr_doc.cancel()
    except Exception as e:
        frappe.log_error(
            "Failed to cancel Payment Request " + str(pr) + ": " + str(e),
            "Checkout Back Cancel Error"
        )

    frappe.db.commit()
    return {"status": "cancelled"}


@frappe.whitelist(allow_guest=True, methods=["POST"])
def stripe_webhook():
    """Endpoint webhook Stripe — SUMBER KEBENARAN status bayaran.
    Berjalan server-to-server; tak bergantung pada redirect browser.

    MULTI-ACCOUNT ("Pilihan B"): setiap Stripe Settings yang dikonfigurasikan
    dalam Travel Settings.currency_accounts ada webhook signing secret
    sendiri (custom_webhook_signing_secret). KEDUA-DUA akaun (cth MYR + SGD)
    diarahkan hantar event ke endpoint yang sama, tapi setiap event hanya
    signed dengan secret akaun YANG MENGHANTAR — jadi kita try verify
    signature dengan setiap secret yang dikonfigurasikan sampai satu
    berjaya. Dengan satu akaun sahaja ("Pilihan A"), loop ni panjangnya 1
    dan behaviour sama macam sebelum ni.
    """
    payload    = frappe.request.data
    sig_header = frappe.request.headers.get("Stripe-Signature")

    all_settings = _get_all_stripe_settings()
    if not all_settings:
        frappe.log_error(
            "No Stripe account is configured in Travel Settings > "
            "Multi Currency Account. Webhook cannot be verified.",
            "Stripe Webhook Config Error"
        )
        frappe.local.response.http_status_code = 500
        return {"error": "webhook not configured"}

    # Kumpul secret sahaja (skip akaun yang tiada secret dikonfigurasikan —
    # event dari dia takkan pernah verify, tapi jangan block akaun lain).
    secrets = []
    for ss, _gateway_account in all_settings:
        secret = ss.get_password("custom_webhook_signing_secret", raise_exception=False)
        if secret:
            secrets.append((ss.name, secret))

    if not secrets:
        frappe.log_error(
            "No Webhook Signing Secret is configured on ANY Stripe Settings "
            "referenced by Travel Settings > Multi Currency Account.",
            "Stripe Webhook Config Error"
        )
        frappe.local.response.http_status_code = 500
        return {"error": "webhook not configured"}

    # Loop verify — event datang dari SATU akaun sahaja; secret akaun tu
    # yang akan lulus verification, yang lain pulang SignatureVerificationError.
    event = None
    for settings_name, webhook_secret in secrets:
        try:
            event = stripe.Webhook.construct_event(payload, sig_header, webhook_secret)
            break  # berjaya — event ni dari akaun 'settings_name'
        except ValueError:
            # Payload tak sah (bukan JSON betul) — sama untuk semua akaun,
            # tak perlu cuba yang lain.
            frappe.log_error("Invalid payload", "Stripe Webhook Error")
            frappe.local.response.http_status_code = 400
            return {"error": "invalid payload"}
        except stripe.error.SignatureVerificationError:
            continue  # bukan akaun ni — cuba secret seterusnya

    if event is None:
        frappe.log_error(
            "Invalid signature — no configured Stripe account verified this event. "
            "Check that the webhook signing secret on every Stripe Settings matches "
            "the Stripe Dashboard, and that this endpoint URL is registered under "
            "the correct Stripe account.",
            "Stripe Webhook Error"
        )
        frappe.local.response.http_status_code = 400
        return {"error": "invalid signature"}

    event_type = event.get("type")
    obj = event.get("data", {}).get("object", {})

    if event_type == "payment_intent.succeeded":
        _handle_payment_succeeded(obj)
    elif event_type == "payment_intent.payment_failed":
        _handle_payment_failed(obj)
    # Event lain diabaikan senyap (tak perlu tindakan).

    frappe.local.response.http_status_code = 200
    return {"status": "ok"}


def _mark_payment_request_paid(pr_name):
    """Tandakan Payment Request sebagai Paid (cipta Payment Entry via
    set_as_paid()) — idempotent, selamat dipanggil berulang kali.

    Guna DUA laluan berasingan:
      1. Webhook Stripe (_handle_payment_succeeded) — laluan UTAMA/normal.
      2. get_payment_result() sebagai FALLBACK — kalau customer redirect
         balik dan Stripe API sahkan bayaran 'succeeded', tapi Payment
         Request kita MASIH belum 'Paid' (webhook mungkin lambat sampai,
         gagal dihantar Stripe, atau tersekat/gagal diproses server kita
         atas sebab lain). Tanpa fallback ni, customer nampak "Payment
         successful" di skrin tapi booking/SO di sistem kita senyap kekal
         "Pending" — admin tak nampak bayaran ni langsung sehingga
         disedari secara manual.

    Pulangkan True kalau Payment Request itu SEKARANG "Paid" (sama ada
    baru sahaja ditandakan, atau memang dah "Paid" sebelum ni) — False
    kalau gagal/tidak wujud.
    """
    if not pr_name:
        return False

    # SERIALISASI panggilan serentak (webhook Stripe + fallback wizard poll)
    # untuk Payment Request yang SAMA. Tanpa serialisasi, kedua-duanya baca
    # status != "Paid" serentak, kedua-duanya jalankan set_as_paid() ->
    # create_payment_entry() -> kedua-duanya increment siri nama PE (tabSeries)
    # serentak -> MariaDB 1020 "Record has changed since last read in table
    # 'tabSeries'" (Frappe v17 guna SELECT current FROM tabSeries ... FOR UPDATE
    # utk naming series; bila dua transaction race, caller kedua dapat 1020).
    # Caller yang menang berjaya cipta PE + tandakan PR Paid; yang kalah 1020.
    # Disahkan pada ACC-PRQ-2026-00026/00027/00028: PR = Paid, PE wujud (1
    # sahaja, tiada pendua — 1020 abort insert caller kalah).
    #
    # PENYELESAIAN: SELECT ... FOR UPDATE pada baris PR utk serialize. TAPI awas
    # — get_payment_result dah baca pr.status (non-locking) lebih awal dalam
    # transaction yang sama, jadi baris PR dah masuk snapshot REPEATABLE READ.
    # FOR UPDATE (locking read) selepas tu akan throw 1020 "Record has changed
    # since last read in table 'tabPayment Request'" SENDIRI bila webhook ubah
    # baris tu — ia tak tunggu lock. Jadi kita ROLLBACK dulu: ini end transaction
    # sedia ada + mulakan transaction baru dgn snapshot SEGAR. FOR UPDATE jadi
    # bacaan pertama PR dlm transaction baru -> ia WAIT utk lock webhook (bukan
    # 1020). Lepas webhook commit (PR=Paid), kita baca "Paid" dan pulang True
    # TANPA panggil set_as_paid -> tiada 1020 tabSeries, tiada PE pendua, tiada
    # error log palsu. Rollback selamat: _rate_limit guna Redis (bukan DB), dan
    # kedua-dua caller (get_payment_result, _handle_payment_succeeded) hanya buat
    # bacaan sebelum panggil ni, jadi tiada apa-apa dibuang. db.sql tak semak
    # frappe permission, jadi Guest boleh pegang lock.

    # set_as_paid() → create_payment_entry() → get_party_account() →
    # account_perm_check() → frappe.has_permission("Account", ...). Laluan
    # webhook & wizard berjalan sebagai Guest; customer login portal pula
    # tiada role Accounts — kedua-duanya TIDAK LULUS semakan ini.
    #
    # frappe.flags.ignore_permissions = True SAHAJA tidak mencukupi: flag ni
    # dihormati oleh check_permission() (yang throw) dan insert/submit, TETAPI
    # frappe.has_permission() SENDIRI tidak check flag tersebut — ia hanya
    # short-circuit bila frappe.session.user == "Administrator" (rujuk
    # frappe/permissions.py). Jadi account_perm_check() throw
    # "User don't have permissions to select/read this account" walaupun
    # ignore_permissions sudah diset — inilah punca sebenar masalah permission
    # bayaran online (webhook Stripe + fallback get_payment_result).
    #
    # frappe.set_user("Administrator") BOLEH luluskan semakan ni, TAPI ia
    # memadam frappe.local.session.data DAN menulis-ganti session.sid (sentiasa
    # menjadi username, bukan token sid sebenar) → Session.update() di hujung
    # request menulis data sesi yang dikosongkan ke cache bawah sid sebenar
    # customer → sesi customer TERKORUPSI / terlogout (rujuk memory
    # frappe-set-user-corrupts-sessions). Restore via set_user(original_user)
    # tak pulihkan sid sebenar (set_user sentiasa set sid=username), jadi
    # pendekatan tu tak boleh dipakai untuk request authenticated.
    #
    # PENYELESAIAN: set frappe.local.session.user = "Administrator" SECARA
    # LANGSUNG (bukan set_user()) — ini sentuh HANYA .user, BUKAN .sid/.data
    # (frappe.local.session ialah self.data Session; update() tulis
    # self.data["data"] di bawah self.data["sid"] — kedua-duanya tak
    # disentuh). has_permission() short-circuit untuk Administrator →
    # account_perm_check lulus. .user dipulihkan dalam finally, supaya
    # Session.update() di hujung request menulis data sesi ASAL di bawah sid
    # ASAL → tiada korupsi sesi untuk Guest mahupun customer login.
    frappe.flags.ignore_permissions = True
    _orig_session_user = frappe.local.session.user
    frappe.local.session.user = "Administrator"
    try:
        # Rollback utk transaction/snapshot SEGAR supaya FOR UPDATE di bawah
        # jadi bacaan pertama PR -> ia WAIT utk lock (bukan 1020). Selamat kerana
        # caller hanya buat bacaan sebelum ni (rujuk komentar di atas).
        frappe.db.rollback()
        row = frappe.db.sql(
            "SELECT status FROM `tabPayment Request` WHERE name=%s FOR UPDATE",
            pr_name)
        if not row:
            return False  # PR tak wujud
        if row[0][0] == "Paid":
            return True  # caller lain (webhook) dah tandakan Paid semasa kita tunggu
        pr = frappe.get_doc("Payment Request", pr_name)
        pr.run_method("set_as_paid")
        frappe.db.commit()
        return True
    except Exception as e:
        frappe.db.rollback()
        # Safety net: kalau ada edge case di mana serialisasi tak sempat (cth
        # contention luar pada tabSeries), semak semula status committed — kalau
        # dah Paid, bayaran customer berjaya; pulangkan True, JANGAN log error
        # palsu yang buat customer nampak "not verified" sedangkan dah masuk.
        if frappe.db.get_value("Payment Request", pr_name, "status") == "Paid":
            return True
        frappe.log_error(
            "set_as_paid failed for " + pr_name + ": " + str(e),
            "Stripe Payment Entry Error")
        return False
    finally:
        frappe.local.session.user = _orig_session_user


def _handle_payment_succeeded(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    if not pr_name or not frappe.db.exists("Payment Request", pr_name):
        frappe.log_error("Webhook: payment_request not found in metadata. PI: " +
                         str(payment_intent.get("id")), "Stripe Webhook")
        return
    _mark_payment_request_paid(pr_name)


def _handle_payment_failed(payment_intent):
    pr_name = (payment_intent.get("metadata") or {}).get("payment_request")
    frappe.log_error(
        "Payment failed for Payment Request " + str(pr_name) +
        " (PI: " + str(payment_intent.get("id")) + ")",
        "Stripe Payment Failed"
    )
    _notify_booking_pending_if_unpaid(payment_intent)


def _notify_booking_pending_if_unpaid(payment_intent):
    """Dipanggil bila Stripe confirm payment gagal (webhook) ATAU bila
    checkout.html punya timeout 5 minit tercapai tanpa bayaran berjaya
    (lihat mark_checkout_timeout()). Hantar emel "Pending" SEKALI SAHAJA —
    kalau booking dah "Accepted" atau lebih (bayaran lain dah settle
    serentak — cth retry berjaya di tab lain), jangan hantar apa-apa,
    supaya customer tak dapat emel "Pending" selepas "Accepted".
    """
    booking_number = (payment_intent.get("metadata") or {}).get("booking_number")
    if not booking_number:
        return

    booking = frappe.db.get_value("Booking", {"booking_number": booking_number},
                                  ["name", "status"], as_dict=True)
    if not booking or booking.status != "Pending":
        return

    from travel_booking.api.email_service import _send_status_email
    _send_status_email(booking.name, "Pending")


@frappe.whitelist(allow_guest=True)
def get_payment_result(payment_intent: str):
    """Dipanggil oleh halaman status bayaran portal (selepas redirect dari
    Stripe) untuk sahkan status SEBENAR bayaran — bukan sekadar percaya
    'redirect_status' dalam URL (Stripe sendiri tak menjamin parameter tu
    rasmi/selamat; ia boleh dipalsukan oleh sesiapa sekadar menukar URL).
    Kita ambil terus dari Stripe API guna 'payment_intent' id (turut
    disertakan Stripe dalam URL selepas redirect), lalu padankan dengan
    Payment Request/Sales Order kita untuk paparan yang boleh dipercayai.
    """
    # Rate limiting per-IP — endpoint ni allow_guest=True dan setiap panggilan
    # retrieve PaymentIntent dari Stripe API (network request keluar). Tanpa
    # had, bot boleh flood Stripe API guna payment_intent id yang teka/wujud,
    # buang kuota rate limit Stripe kita + beban server. Had 15/minit/IP
    # longgar cukup untuk customer sebenar (redirect status page mungkin
    # poll beberapa kali), tapi ketat cukup untuk block abuse. Corak sama
    # dengan send_otp() di otp.py.
    if not _rate_limit("payment_result", max_requests=15, window_sec=60):
        frappe.throw("Too many requests. Please try again shortly.")

    if not payment_intent:
        frappe.throw("Payment intent not found.")

    # MULTI-ACCOUNT ("Pilihan B"): PaymentIntent ID scoped kepada akaun Stripe
    # yang MENCIPTA dia — intent SGD tak wujud pada akaun MYR (resource
    # missing). Intent ID sahaja tak bawa maklumat akaun, jadi try retrieve
    # dari setiap akaun yang dikonfigurasikan sampai satu jumpa. Max N API
    # call (N = bilangan akaun, cth 2) — murah untuk redirect landing page.
    # Dengan satu akaun sahaja ("Pilihan A"), loop ni panjangnya 1 dan
    # behaviour sama macam sebelum ni.
    try:
        intent = None
        all_settings = _get_all_stripe_settings()
        if not all_settings:
            raise Exception("No Stripe account configured in Travel Settings currency accounts.")

        for ss, _gateway_account in all_settings:
            try:
                stripe.api_key = ss.get_password("secret_key")
                intent = stripe.PaymentIntent.retrieve(payment_intent)
                break  # jumpa — intent ni milik akaun ini
            except stripe.error.InvalidRequestError:
                # Intent tak wujud pada akaun ini — cuba akaun seterusnya.
                continue

        if intent is None:
            raise Exception(
                "PaymentIntent not found on any configured Stripe account " +
                "(" + str(len(all_settings)) + " account(s) checked)."
            )
    except Exception as e:
        # PENTING: log sebab sebenar kegagalan (bukan telan senyap) — supaya
        # admin boleh diagnos kenapa get_payment_result gagal walaupun
        # webhook Stripe sendiri dah berjaya proses PaymentIntent yang sama.
        frappe.log_error(
            "get_payment_result failed to retrieve intent " + str(payment_intent) +
            ". Error: " + str(e),
            "Payment Result Lookup Error"
        )
        return {
            "status": "unknown",
            "message": "Payment could not be verified. Please check under Transactions or contact admin.",
        }

    pr_name = (intent.metadata or {}).get("payment_request")
    so_name = (intent.metadata or {}).get("sales_order")
    booking_number = (intent.metadata or {}).get("booking_number") or ""

    # KESELAMATAN — verify pemilikan: endpoint ni allow_guest=True (Stripe
    # redirect balik bawa payment_intent di URL, customer MUNGKIN belum
    # login lagi selepas redirect). payment_intent id sendiri adalah rahsia
    # Stripe (27-char, tak boleh diteka) — jadi untuk Guest (redirect
    # langsung dari Stripe, sesi mungkin tak hadir selepas redirect cookies
    # tak sync), kita benarkan lookup kerana memiliki id = bukti indirect
    # pemilikan (hanya customer yang memulakan checkout tahu id).
    #
    # TAPI untuk user AUTHENTICATED yang cuba akses payment_intent ORANG
    # LAIN (cth admin/staff yang login, atau customer cuba teka id),
    # kita verify pemilikan via SO.custom_booking -> Booking.customer.
    # Ini elak pengguna yang authenticated "menyiasat" pembayaran customer
    # lain walaupun mereka tak patut nampak.
    user_email = frappe.session.user
    if user_email and user_email != "Guest" and so_name:
        from travel_booking.api._helpers import get_customer_by_email
        owner_customer = get_customer_by_email(user_email)
        so_customer = frappe.db.get_value("Sales Order", so_name, "customer") if frappe.db.exists("Sales Order", so_name) else None
        if owner_customer and so_customer and so_customer != owner_customer:
            frappe.log_error(
                "Access denied in get_payment_result: user {0} (customer={1}) attempted to access "
                "payment_intent {2} belonging to customer={3}".format(
                    user_email, owner_customer, payment_intent, so_customer
                ),
                "Payment Result Access Denied"
            )
            frappe.throw("Access denied.", frappe.PermissionError)

    trip_label = ""
    if so_name:
        bk = frappe.db.sql("""
            SELECT tm.trip_name AS trip_label, td.trip_group_name
            FROM `tabSales Order` so
            JOIN `tabBooking` b ON b.name = so.custom_booking
            LEFT JOIN `tabTrip Group Date`   td ON td.name = b.trip_date
            LEFT JOIN `tabTrip` tm ON tm.name = td.trip
            WHERE so.name = %s
            LIMIT 1
        """, so_name, as_dict=True)
        if bk:
            trip_label = bk[0].trip_label or ""
            if bk[0].trip_group_name:
                trip_label = trip_label + " · " + bk[0].trip_group_name

    # Stripe intent.status ialah SUMBER KEBENARAN sebenar (bukan redirect_status
    # URL). 'succeeded' = bayaran berjaya; 'processing' = masih diproses
    # (jarang untuk kad, biasa untuk kaedah bank tempatan); selainnya = gagal.
    if intent.status == "succeeded":
        result_status = "succeeded"
    elif intent.status == "processing":
        result_status = "processing"
    else:
        result_status = "failed"

    pr_status = frappe.db.get_value("Payment Request", pr_name, "status") if pr_name else None

    # PENTING — JARING KESELAMATAN untuk webhook yang terlepas/gagal sampai:
    # Stripe sendiri sahkan bayaran 'succeeded', tapi Payment Request kita
    # MASIH belum 'Paid' (webhook lambat, gagal dihantar Stripe, endpoint
    # tersekat, signing secret salah dikonfigurasikan tanpa disedari, dsb).
    # Tanpa semakan ni, customer akan redirect balik dan nampak "Payment
    # successful" di skrin — SEDANGKAN booking/SO di sistem kita senyap
    # kekal "Pending" (tiada Payment Entry, admin tak nampak bayaran ni
    # langsung). Kita panggil set_as_paid() di SINI sebagai fallback —
    # idempotent (rujuk _mark_payment_request_paid()), jadi selamat
    # walaupun webhook SEBENARNYA berjaya diproses serentak/lebih awal.
    if result_status == "succeeded" and pr_name and pr_status != "Paid":
        if _mark_payment_request_paid(pr_name):
            pr_status = "Paid"
        else:
            # set_as_paid() gagal (rujuk Error Log "Stripe Payment Entry
            # Error") — jangan sorok kegagalan ni dari customer/admin.
            # pr_verified akan kekal False dalam response, dan admin
            # nampak error tercatat untuk siasat manual.
            frappe.log_error(
                "get_payment_result: Stripe confirmed 'succeeded' for PI " +
                str(payment_intent) + " but set_as_paid() fallback FAILED " +
                "for Payment Request " + str(pr_name) + ". Manual review required.",
                "Payment Result - Webhook Miss Fallback Failed"
            )

    return {
        "status":          result_status,
        "amount":          float(intent.amount) / 100.0,
        "currency":        (intent.currency or "myr").upper(),
        "sales_order":     so_name or "",
        "trip_label":      trip_label,
        "booking_number":  booking_number,
        "payment_request": pr_name or "",
        "pr_verified":     pr_status == "Paid",
        "last_error":      (intent.last_payment_error or {}).get("message") if result_status == "failed" else "",
    }