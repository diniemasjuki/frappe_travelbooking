import frappe
from frappe.utils.password import update_password


def run():
    # Set a test YouTube URL on TADD260801 (scenic cruise video)
    frappe.db.set_value("Trip Addon", "TADD260801", "youtube_video_url", "https://www.youtube.com/watch?v=ScMzIvxVIiE")
    frappe.db.commit()
    print("YouTube URL set on TADD260801")

    # Verify
    yt = frappe.db.get_value("Trip Addon", "TADD260801", "youtube_video_url")
    print(f"  Verified: {yt}")

    # Save original password hash for restore
    original = frappe.db.sql(
        "SELECT password FROM `__Auth` WHERE doctype='User' AND name='diniemasjuki@gmail.com' AND fieldname='password'",
        as_dict=True
    )
    if original:
        print(f"ORIGINAL_HASH_START:{original[0]['password']}:ORIGINAL_HASH_END")

    # Set temp password
    update_password("diniemasjuki@gmail.com", "Test@1234!")
    frappe.db.commit()
    print("Temp password set")
