# Meltado Drive-In — order-to-car web app

Two web pages, no app download:

| Page | Who uses it | What it does |
|---|---|---|
| `index.html` | Customers in their cars (scan the billboard QR) | Opens straight on the menu. Customers add items, fill in their details and tap **Review order**. The app then checks they're within 500 m, shows a **confirm popup**, and after sending shows an **"Order sent"** popup and live status |
| `counter.html` | Billing-counter staff (tablet/laptop) | New orders appear instantly with a sound alert. Shows items, name, phone, car number and a Maps link to the car. Staff move orders **New → Entered in POS → Out for delivery**. The order moves to **Received by customer** only when the customer confirms it. |

**Customers can order again while earlier orders are on their way.** Each order is a separate card in **Your orders** at the top of the menu, with its own status and its own **"I've received order #…"** button. Orders are never merged; the counter shows each one separately and marks other orders from the same car with a small "Same car: #…" note.

**Delivery is confirmed by the customer, not the staff.** When an order is *Out for delivery*, the customer's screen shows an **"I've received my order"** button. Tapping it marks the order *Received* on the customer's screen and on the counter. Staff accounts cannot mark orders delivered; the database blocks it. If a customer doesn't confirm within 15 minutes, the counter flags the order. After 45 minutes it no longer stops that phone number from ordering again.

There's no online payment. Customers pay by UPI to the waiter at the car, and the bill comes from your existing POS.

---

## Try it right now (demo mode, no setup needed)

1. Unzip the folder and open `public/index.html` in Chrome.
2. Open `public/counter.html` in a **second tab of the same browser** and click **Open demo dashboard → Start receiving orders**.
3. On the customer tab, add items, open the cart, fill in your details and tap **Review order**. If your computer can't share a location near the cafe, click **"Demo only: continue without location"**. Then send the order. It shows up on the counter tab with a chime.

Demo mode keeps orders in that one browser. To have real phones send orders to the counter, set up the live version below. It takes about 30 minutes and is free for a cafe's volume.

---

## Go live (step by step)

### Step 1: Create the database (Supabase, free tier)
1. Go to **supabase.com**, sign up, and click **New project**. Choose the **Mumbai (ap-south-1)** region and save the database password somewhere safe.
2. Check the cafe's coordinates. `supabase/schema.sql` already has Meltado's approximate location (`28.6542, 77.3025`). Before launch, open Google Maps, long-press the cafe entrance, copy the exact numbers, and update that line (marked `approximate`) if they differ.
3. Save the file.
4. In Supabase, go to **SQL Editor → New query**, paste the whole file and click **Run**. You should see "Success".

### Step 2: Create the counter login
1. In Supabase go to **Authentication → Users → Add user → Create new user**. Use an email like `counter@meltado.in` and a strong password, and tick **Auto confirm**.
2. Go to **SQL Editor** and run this (use your own email):
   ```sql
   insert into public.staff (user_id, name)
   select id, 'Counter' from auth.users where email = 'counter@meltado.in';
   ```
   Only users in this `staff` list can see orders.

### Step 3: Connect the pages to the database
1. In Supabase go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.
2. Open `public/config.js` and paste them into `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Add `CAFE_PHONE` too if you want customers to see a "Call cafe" button.
   (The anon key is meant to be public. Security is handled by the database rules in `schema.sql`.)

### Step 4: Put it online (pick one)
- **Easiest, Netlify Drop:** go to app.netlify.com/drop and drag the `public` folder onto the page. You get an `https://….netlify.app` link.
- **AWS (good practice for your course), Amplify Hosting:** Amplify console → **Deploy without Git** → upload a zip of the `public` folder.
  You could also use S3 static website hosting + CloudFront, but you must use CloudFront because **location only works over HTTPS**.

### Step 5: QR code and counter screen
- Make a QR code for `https://YOUR-SITE/index.html` (any free QR generator works) and print it on the billboard.
- On the counter tablet, open `https://YOUR-SITE/counter.html`, log in and tap **Start receiving orders**. Keep it plugged in. If the browser can't keep the screen awake, set the device's display to *never sleep*.
- Don't put the counter link in the QR code.

---

## How it protects against fake orders
- **500 m check twice:** the phone checks GPS first, then the database checks the coordinates again before it accepts an order (`place_order` in `schema.sql`).
- **Up to 3 orders in progress per phone number and per device**, and at most **6 orders per number in 2 hours**. You can change these in Table Editor → `app_settings`.
- **Pause button** on the counter (`accepting_orders`) for when the kitchen is overloaded.
- **Optional SMS OTP:** this is built in but **off** by default. To turn it on:
  1. Supabase → Authentication → Providers → **Phone**: enable it and connect an SMS provider (Twilio, MessageBird, Vonage or Textlocal). Indian SMS also needs DLT template registration with the provider.
  2. Set `require_otp = true` in `app_settings`.
- Customers can't read or edit anyone's orders. They can only see their own order's status, using a secret token.

## Changing things
- **Menu and prices:** edit `public/menu.js`, then re-upload the `public` folder.
- **Radius / cafe location / limits:** Supabase → Table Editor → `app_settings`.
- **Colours:** top of `public/styles.css`.

## Files
```
public/
  index.html, customer.js   customer ordering page
  counter.html, counter.js  billing counter dashboard
  backend.js                talks to Supabase (or the demo store)
  menu.js                   Meltado 2026 menu
  config.js                 your settings
  styles.css                shared look
supabase/schema.sql         database, security rules, realtime
```
