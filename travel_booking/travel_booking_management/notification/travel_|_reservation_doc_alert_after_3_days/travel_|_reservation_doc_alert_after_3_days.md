<p><!DOCTYPE html></p>

<html>
<head>
  <meta charset="UTF-8">
  <title>Complete Your Reservation – {{ doc.name }}</title>
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
      background: #fff9c4; /* kuning pastel lembut */
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
      <h2>Action Required – Complete Your Reservation</h2>
    </div>
    <div class="content">
      <p>Hi {{ doc.customer_name }},</p>
      <p>We noticed that your reservation with Reference: <strong>{{ doc.name }}</strong> is still incomplete.</p>
      <p>To secure your booking, please complete the required reservation details as soon as possible. This will help us confirm your travel arrangements smoothly.</p>
      {% if doc.reservation_link %}
      <a href="{{ doc.reservation_link }}" class="button">Complete Reservation Now</a>
      {% endif %}
      <p>If you need assistance, our team is ready to help you with the process.</p>
    </div>
    <div class="footer">
      &copy; {{ frappe.utils.nowdate() }} Rarecation Travel. We look forward to serving you.
    </div>
  </div>
</body>
</html>
