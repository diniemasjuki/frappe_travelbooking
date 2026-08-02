<p><!DOCTYPE html></p>

<html>
<head>
  <meta charset="UTF-8">
  <title>Traveller Document Verified – {{ doc.name }}</title>
  <style>
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background-color: #f9fafb;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 20px auto;
      background: #ffffff;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid #e0e0e0;
    }
    .header {
      background: #c8e6c9; /* hijau pastel lembut */
      color: #333333;
      padding: 20px;
      text-align: center;
    }
    .content {
      padding: 25px;
      color: #444444;
      line-height: 1.6;
    }
    .button {
      display: inline-block;
      padding: 12px 20px;
      margin-top: 20px;
      background: #81d4fa; /* biru pastel */
      color: #ffffff;
      text-decoration: none;
      border-radius: 6px;
      font-weight: bold;
    }
    .button:hover {
      background: #4fc3f7;
    }
    .footer {
      background: #f3f4f6;
      text-align: center;
      padding: 15px;
      font-size: 12px;
      color: #777777;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>Traveller Document Verified ✅</h2>
    </div>
    <div class="content">
      <p>Hi {{ doc.customer_name }},</p>
      <p>We are pleased to inform you that your traveller document with Reference: <strong>{{ doc.name }}</strong> has been <strong>successfully verified</strong>.</p>
      <p>Your booking is now fully confirmed. You may proceed with the next steps of your travel plan with confidence.</p>
      {% if doc.booking_link %}
      <a href="{{ doc.booking_link }}" class="button">View Booking Details</a>
      {% endif %}
    </div>
    <div class="footer">
      &copy; {{ frappe.utils.nowdate() }} Rarecation Travel. Wishing you a smooth journey ahead.
    </div>
  </div>
</body>
</html>
