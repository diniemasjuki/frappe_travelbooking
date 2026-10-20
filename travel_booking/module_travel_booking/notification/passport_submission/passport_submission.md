<div style="font-family: sans-serif; border: 1px solid #e0e0e0; border-radius: 12px; overflow: hidden; max-width: 550px; margin: 20px auto; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">

    <div style="background-color: #409fff; color: #ffffff; padding: 20px; text-align: center;">
        <h2 style="margin: 0; font-size: 20px; letter-spacing: 1px; color: #ffffff; "><small>PASSPORT REGISTRATION <br/></small>RECEIVED</h2>
    </div>

    <div style="padding: 25px; color: #444; line-height: 1.6;">

        <p>Dear <strong>{{ doc.full_name }}</strong>,</p>

        <p>We have successfully received your passport details for your upcoming journey. Here is a summary of the information submitted:</p>

        <div style="background-color: #f8f9fa; border-left: 4px solid #ecf6ff; padding: 15px; margin: 20px 0;">
            <p style="margin: 5px 0;"><strong>First Name:</strong> {{ doc.first_name }}</p>
            <p style="margin: 5px 0;"><strong>Last Name:</strong> {{ doc.last_name }}</p>
            <p style="margin: 5px 0;"><strong>ID/IC/Mykad:</strong> {{ doc.ic_number }}</p>
            <p style="margin: 5px 0;"><strong>Date of Birth:</strong> {{ doc.date_of_birth }}</p>
            <p style="margin: 25px 0 0 0;"><strong>Passport Information</strong></p>
            <p style="margin: 5px 0;"><strong>Passport No:</strong> {{ doc.passport_no }}</p>
            <p style="margin: 5px 0;"><strong>Passport Expiry:</strong> {{ doc.passport_expiry }}</p>
            <p style="margin: 5px 0;"><strong>Nationality:</strong> {{ doc.nationality }}</p>
            <p style="margin: 25px 0 0 0;"><strong>Contact Information</strong></p>
            <p style="margin: 5px 0;"><strong>Phone No.:</strong> {{ doc.phone }}</p>
            <p style="margin: 5px 0;"><strong>Email:</strong> {{ doc.email }}</p>
        </div>

        <p>Our team now reviewing your documents. We will notify you if any further action is required.</p>

        <p style="margin-top: 30px;">Best Regards,<br>
        <strong>Rarecation Travel</strong></p>

    </div>

    <div style="background-color: #f1f1f1; padding: 10px; text-align: center; font-size: 11px; color: #999;">
        This is an automated notification by Rarecation Travel System.
    </div>

</div>
