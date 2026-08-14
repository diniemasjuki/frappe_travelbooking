# travel_booking/api/email_service.py
#
# Semua fungsi berkaitan e-mel: pautan set-password, status booking
# (Pending/Accepted/Processing/Confirmed/Completed), dan resit bayaran.
#
# Pemisahan dari booking.py asal supaya stripe_checkout.py boleh import
# _send_status_email terus dari sini (bukan dari booking.py / booking_engine
# yang bergantung pada stripe_checkout — elak import membulat/circular import).

import frappe

from travel_booking.api.constants import PRINT_FORMAT_RECEIPT
from travel_booking.api._helpers import get_customer_email
from travel_booking.api.pricing import fmt_currency
from travel_booking.api.so_helpers import (
    _get_all_booking_sales_orders,
    _resolve_booking_from_so,
    _compute_payment_status,
)


# ══════════════════════════════════════════════
# SITE URL + SET-PASSWORD URL
# ══════════════════════════════════════════════

def get_site_url():
    """Domain untuk pautan emel — DINAMIK ikut domain sebenar customer guna
    untuk buat request (test.rpwp.my atau dev.rpwp.my — dua-dua hala ke
    site Frappe yang SAMA, sengaja tak override site_config.json punya
    'host_name' supaya migration/deployment site tak terjejas).

    Dipanggil dari konteks request customer sebenar (contoh: confirm_booking,
    forgot_password) -> guna domain request tu terus (frappe.local.request.host).
    Dipanggil dari konteks TANPA request customer (contoh: webhook Stripe —
    request datang dari Stripe, bukan browser customer; scheduled task;
    bench console) -> fallback ke frappe.utils.get_url() biasa (guna
    site_config.json punya host_name).
    """
    if getattr(frappe.local, "request", None) and frappe.local.request.host:
        protocol = "https://" if frappe.get_request_header("X-Forwarded-Proto", "") == "https" else "http://"
        return protocol + frappe.local.request.host
    return frappe.utils.get_url()


def _generate_set_password_url(email):
    """Reuse mekanisme reset_password_key sedia ada (forgot_password()) untuk
    pautan "Set Your Password" pertama kali — bukan sistem token berasingan.
    Tiada mode= dalam URL supaya set-password.html papar mod "first" (default).
    """
    reset_key = frappe.generate_hash(length=32)
    frappe.db.set_value("User", email, "reset_password_key", reset_key)
    site_url = get_site_url()
    return site_url + "/set-password?key=" + reset_key + "&email=" + email


# ══════════════════════════════════════════════
# SET-PASSWORD EMAIL
# ══════════════════════════════════════════════

def _send_set_password_email(email, first_name):
    """Emel BERASINGAN "Set Your Password" — dihantar SEKALI SAHAJA, terus
    selepas User portal baru dicipta (_ensure_portal_user() pulangkan True),
    TAK KIRA payment method atau status booking pertama customer tu.

    KESELAMATAN KEGAGALAN: jika emel set-password gagal dihantar (cth emel
    masuk spam, SMTP bounce, template hilang), customer TERKUNCI tanpa
    cara set password — akaun mereka wujud tapi password random tidak
    diketahui. Sebelum ni, kegagalan cuma diam log (frappe.log_error)
    yang admin jarang semak, jadi customer komplen "tak boleh login"
    tanpa siapa-siapa tahu punca sebenar. Sekarang: (a) cipta TODO utk
    admin supaya nampak kegagalan dalamDesk, dan (b) log dh dengan tahap
    lebih ketara.
    """
    try:
        context = {
            "first_name":       first_name,
            "set_password_url": _generate_set_password_url(email),
        }
        email_template = frappe.get_doc("Email Template", "Set Your Password")
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — biar Frappe guna default Outgoing
            # Email Account, sama macam send_otp(). Hardcode domain lain
            # dari domain sebenar site punca email silently gagal/masuk
            # spam (SPF/DKIM mismatch).
            subject=subject,
            message=message,
            now=True
        )
        return True
    except Exception as e:
        # Kegagalan dihantar emel set-password = customer berkemungkinan
        # TERKUNCI (User wujud, password random tak diketahui, tiada link
        # set-password sampai). Ini perlu perhatian admin SEGERA, bukan
        # sekadar log tersorok.
        frappe.log_error(
            "Set Your Password email FAILED for {0}: {1}\n"
            "Customer may be unable to log in to the portal. "
            "Alternative: send a manual magic link or set a new reset_password_key."
            .format(email, str(e)),
            "Booking Set-Password Email FAILED"
        )
        # Cipta TODO utk admin supaya nampak dalam Desk daily check.
        try:
            todo = frappe.get_doc({
                "doctype":  "ToDo",
                "status":   "Open",
                "priority": "High",
                "subject":  "Set Password email failed for {0}".format(email),
                "description": (
                    "The 'Set Your Password' email failed to send after a new booking.\n"
                    "Email: {0}\nError: {1}\n\n"
                    "Action: Contact the customer, or generate a magic link / "
                    "new reset_password_key from the portal forgot-password page."
                ).format(email, str(e)),
            })
            todo.flags.ignore_permissions = True
            todo.insert()
        except Exception:
            # Kalau TODO pun gagal, jangan crash booking — log_error di
            # atas dah cukup sebagai fallback record.
            pass
        return False


# ══════════════════════════════════════════════
# BOOKING STATUS EMAIL
# ══════════════════════════════════════════════

def _booking_email_context(booking_name):
    b = frappe.db.get_value("Booking", booking_name,
                            ["booking_number", "customer", "trip_date"],
                            as_dict=True)
    if not b:
        return None
    trip_name = ""
    group_name = ""
    if b.trip_date:
        td = frappe.db.get_value("Trip Group Date", b.trip_date, ["trip", "trip_group_name"], as_dict=True)
        if td:
            group_name = td.trip_group_name or ""
            trip_name = frappe.db.get_value("Trip", td.trip, "trip_name") or ""
    # NOTA: "Disable Rounded Total" kini global — standardize ke grand_total.
    grand_total   = 0
    advance_paid  = 0
    # MULTI-CURRENCY: SUM merentasi SEMUA SO untuk booking (utama + addon)
    # ni SELAMAT sebab guardrail reka bentuk — SEMUA SO untuk SATU booking
    # WAJIB currency yang sama (rujuk dokumen reka bentuk Seksyen 3), jadi
    # currency SO PERTAMA yang dijumpai dijadikan wakil untuk booking ni.
    currency = None
    for so_name in _get_all_booking_sales_orders(booking_name):
        so_vals = frappe.db.get_value("Sales Order", so_name,
                                      ["grand_total", "advance_paid", "currency"], as_dict=True)
        if so_vals:
            grand_total  += float(so_vals.grand_total or 0)
            advance_paid += so_vals.advance_paid or 0
            if not currency:
                currency = so_vals.currency
    return {
        "email":           get_customer_email(b.customer),
        "full_name":       frappe.db.get_value("Customer", b.customer, "customer_name") or "Customer",
        "booking_number":  b.booking_number,
        "trip_name":       trip_name,
        "group_name":      group_name,
        "grand_total":     grand_total,
        "advance_paid":    advance_paid,
        "currency":        currency or "MYR",
        "payment_status":  _compute_payment_status(advance_paid, grand_total),
    }


def _send_status_email(booking_name, status, email_override=None):
    """Email status: Pending / Accepted / Processing / Confirmed / Completed.
    Kandungan (subject + HTML lengkap termasuk shell/logo/footer) DITARIK
    dari Email Template doctype ("Booking Pending", "Booking Accepted", dsb.)
    — boleh diedit terus di Frappe Desk (Settings > Email Template) tanpa
    perlu sentuh kod. Function ni cuma sediakan context (data) dan hantar.

    Pautan portal disertakan untuk SEMUA status (bukan lagi booking_view+PIN).
    Emel "Set Your Password" untuk customer BAHARU dihantar BERASINGAN
    (rujuk _send_set_password_email(), dipanggil terus di confirm_booking()
    bila User baru dicipta) — bukan lagi disertakan bersyarat ke dalam
    emel status ni ikut flag is_new_user.
    """
    STATUS_TEMPLATE_MAP = {
        "Pending":    "Booking Pending",
        "Accepted":   "Booking Accepted",
        "Processing": "Booking Processing",
        "Confirmed":  "Booking Confirmed",
        "Completed":  "Booking Completed",
    }
    template_name = STATUS_TEMPLATE_MAP.get(status)
    if not template_name:
        return

    try:
        ctx = _booking_email_context(booking_name)
        if not ctx:
            return
        email = email_override or ctx["email"]
        if not email:
            return

        first_name  = ctx["full_name"].split()[0] if ctx["full_name"] else "Customer"
        site_url    = get_site_url()

        context = {
            "booking_number":   ctx["booking_number"],
            "first_name":       first_name,
            "trip_name":        ctx["trip_name"],
            "group_name":       ctx["group_name"],
            "total_fmt":        fmt_currency(ctx["grand_total"] or 0, ctx.get("currency")),
            # Pending: payment belum masuk, tak perlu papar Amount Paid/Payment
            # Status (dah jelas dari konteks) — kekalkan None untuk status ni.
            "amount_paid_fmt":  (fmt_currency(ctx.get("advance_paid") or 0, ctx.get("currency"))
                                  if status != "Pending" else None),
            "payment_status":   ctx["payment_status"] if status != "Pending" else None,
            "booking_url":      site_url + "/traveller_portal",
        }

        email_template = frappe.get_doc("Email Template", template_name)
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — rujuk nota di _send_set_password_email().
            subject=subject,
            message=message,
            now=True
        )
    except Exception as e:
        frappe.log_error("Status email (" + status + ") failed: " + str(e), "Booking Email Error")


# ══════════════════════════════════════════════
# RECEIPT EMAIL
# ══════════════════════════════════════════════

def _receipt_pdf(pe_name):
    """Jana PDF resit dari Payment Entry guna Print Format 'Rarecation Receipt'.
    Sumber SAMA dengan portal (get_document_pdf) — resit email & portal align.
    """
    pf = frappe.db.get_value("Print Format", PRINT_FORMAT_RECEIPT, ["html"], as_dict=True)
    if not pf or not pf.get("html"):
        return None
    doc  = frappe.get_doc("Payment Entry", pe_name)
    html = frappe.render_template(pf["html"], {"doc": doc, "frappe": frappe})
    full_html = ('<!DOCTYPE html><html><head><meta charset="utf-8">'
                 '<style>@page{margin:0}body{margin:0;padding:0}</style></head><body>'
                 + html + '</body></html>')
    return frappe.utils.pdf.get_pdf(full_html)


def _send_receipt_email(pe_doc):
    """Email resit untuk satu Payment Entry (setiap bayaran = satu resit).
    Kandungan (subject + HTML) ditarik dari Email Template "Payment Receipt"
    — boleh diedit terus di Frappe Desk tanpa perlu sentuh kod.
    """
    try:
        if pe_doc.party_type != "Customer" or not pe_doc.party:
            return
        email = get_customer_email(pe_doc.party)
        if not email:
            return
        full_name  = frappe.db.get_value("Customer", pe_doc.party, "customer_name") or "Customer"
        first_name = full_name.split()[0] if full_name else "Customer"
        # MULTI-CURRENCY: pe_doc.paid_to_account_currency ialah currency
        # SEBENAR paid_amount ni direkodkan (field standard Payment Entry,
        # ditentukan oleh akaun 'paid_to' — currency-aware sejak fix
        # _create_manual_payment_entry()/create_payment_intent() rujuk
        # dokumen reka bentuk multi-currency) — sumber paling authoritative,
        # elak query tambahan ke Sales Order.
        amount_fmt = fmt_currency(pe_doc.paid_amount or 0, pe_doc.get("paid_to_account_currency"))

        so_name = ""
        for ref in (pe_doc.references or []):
            if ref.reference_doctype == "Sales Order":
                so_name = ref.reference_name
                break
        booking_number = ""
        if so_name:
            booking_name = _resolve_booking_from_so(so_name)
            if booking_name:
                booking_number = frappe.db.get_value("Booking", booking_name, "booking_number") or ""

        if not booking_number:
            return  # PE bukan berkaitan booking — jangan hantar resit Rarecation

        context = {
            "booking_number": booking_number or pe_doc.name,
            "first_name":     first_name,
            "amount_fmt":     amount_fmt,
        }

        email_template = frappe.get_doc("Email Template", "Payment Receipt")
        message = email_template.get_formatted_response(context)
        subject = frappe.render_template(email_template.subject, context)

        attachments = []
        pdf = _receipt_pdf(pe_doc.name)
        if pdf:
            attachments = [{"fname": "Receipt-" + pe_doc.name.replace("/", "-") + ".pdf", "fcontent": pdf}]

        frappe.sendmail(
            recipients=[email],
            # Sender TIDAK di-hardcode — rujuk nota di _send_set_password_email().
            subject=subject,
            message=message,
            attachments=attachments,
            now=True
        )
    except Exception as e:
        frappe.log_error("Receipt email failed: " + str(e), "Booking Email Error")
