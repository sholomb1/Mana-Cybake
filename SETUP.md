# Cybake Importer — Setup Guide

Complete setup guide for the Shopify → Cybake automated order import system.

## Architecture Overview

```
Shopify (new order) → Shopify Flow (webhook) → Netlify Function → Cybake API
                                                      ↓
                                                Supabase (logs)
                                                      ↓
                                          Dashboard (in Shopify Admin)
```

**Cost: $0/month** — all services use free tiers.

---

## Step 1: Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign up (free).
2. Click **New Project**.
3. Name it `cybake-importer`, choose a database password (save this), pick the nearest region.
4. Wait for the project to spin up (~2 minutes).
5. Go to **SQL Editor** (left sidebar), paste the contents of `supabase-schema.sql` and click **Run**.
6. Go to **Settings → API** and copy:
   - **Project URL** → this is your `SUPABASE_URL`
   - **anon (public) key** → this is your `SUPABASE_ANON_KEY`
   - **service_role (secret) key** → this is your `SUPABASE_SERVICE_KEY`

> ⚠️ Keep the service_role key secret. Never put it in client-side code.

---

## Step 2: Create a Shopify Custom App

1. In your Shopify admin, go to **Settings → Apps → Develop apps → Build apps in Dev Dashboard**.
2. Click **Create an app** and name it `Cybake Importer`.
3. Under **Configuration**, set the following **Admin API scopes**:
   - `read_orders`
   - `write_orders` (for tagging)
4. Set the **App URL** to your Netlify site URL (you'll update this after deploying — use `https://placeholder.com` for now).
5. Click **Release** to create a version, then **Install** the app.
6. Generate an access token using the client credentials flow. You will need:
   - **Client ID** and **Client Secret** from the app's configuration
   - Follow the [Shopify token generation docs](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin)
7. Save the access token — this is your `SHOPIFY_ACCESS_TOKEN`.

---

## Step 3: Deploy to Netlify

### Option A: Deploy via GitHub (recommended)

1. Create a GitHub account if you don't have one.
2. Create a new repository called `cybake-importer`.
3. Push all the project files to the repo.
4. Go to [app.netlify.com](https://app.netlify.com) and sign up with GitHub.
5. Click **Add New Site → Import from Git → GitHub**.
6. Select the `cybake-importer` repository.
7. Build settings should auto-detect from `netlify.toml`. Click **Deploy**.

### Option B: Deploy via CLI

```bash
npm install -g netlify-cli
cd cybake-importer
netlify login
netlify init
netlify deploy --prod
```

### Set Environment Variables

In Netlify dashboard → **Site settings → Environment variables**, add:

| Variable | Value |
|---|---|
| `SHOPIFY_STORE` | `yourstore.myshopify.com` |
| `SHOPIFY_ACCESS_TOKEN` | `shpat_xxxxxxxxxxxx` |
| `CYBAKE_API_URL` | `https://api-import-order.cybakeonline-staging.co.uk` |
| `CYBAKE_API_KEY` | `b169a8d0b55b4e25bbc3f5579dad0c32` |
| `CYBAKE_API_VERSION` | `2.0` |
| `SUPABASE_URL` | `https://xxxxxxxx.supabase.co` |
| `SUPABASE_SERVICE_KEY` | `eyJxxxxxxxx` |
| `WEBHOOK_SECRET` | (generate a random string, e.g. `my-secret-key-2026`) |

After adding variables, **redeploy** the site (Deploys → Trigger Deploy).

---

## Step 4: Update Shopify App URL

1. Go back to your Shopify app in the Dev Dashboard.
2. Update the **App URL** to: `https://your-site-name.netlify.app`
3. Release a new version.

Now when anyone clicks on "Cybake Importer" under **Apps** in Shopify admin, they'll see the dashboard.

---

## Step 5: Set Up Shopify Flow

1. In Shopify admin, go to **Settings → Shopify Flow** (or search for Flow).
2. Click **Create workflow**.
3. **Trigger**: Select **Order created**.
4. **Action**: Select **Send HTTP request** with:
   - **URL**: `https://your-site-name.netlify.app/.netlify/functions/import`
   - **Method**: `POST`
   - **Headers**:
     - `Content-Type`: `application/json`
     - `x-webhook-secret`: (the same secret you set in Netlify env vars)
   - **Body**:
     ```json
     {
       "order_id": "{{ order.id }}",
       "order_name": "{{ order.name }}"
     }
     ```
5. Click **Turn on workflow**.

---

## Step 6: Test the Integration

### Test 1: Verify the dashboard loads
- Go to Shopify admin → **Apps → Cybake Importer**
- You should see the empty dashboard

### Test 2: Place a test order
- Create a test order in Shopify with proper tags (date, time, order type, location)
- Shopify Flow should trigger within seconds
- Check the dashboard — the order should appear with Success or Failed status

### Test 3: Verify in Cybake
- Log into Cybake staging and confirm the order appeared
- Check that SKUs matched, customer was created, delivery date is correct

### Test 4: Test a failure scenario
- Create an order with an invalid/missing SKU
- Confirm it shows as Failed in the dashboard
- Try the Retry button after fixing the issue

---

## Switching to Production

When ready to go live, update these Netlify environment variables:

| Variable | Staging Value | Production Value |
|---|---|---|
| `CYBAKE_API_URL` | `https://api-import-order.cybakeonline-staging.co.uk` | `https://api-import-order.cybakeonline.co.uk` (confirm with Cybake) |
| `CYBAKE_API_KEY` | staging key | production key (get from Cybake) |

Redeploy after changing.

---

## Troubleshooting

**Orders not appearing in dashboard:**
- Check Shopify Flow → click on the workflow → view "Runs" tab for errors
- Check Netlify → Functions → `import` → view logs

**Orders failing with validation errors:**
- Missing delivery date: Tags field doesn't have a parseable date
- Missing SKU: Product doesn't have a SKU set in Shopify
- Missing address: Customer didn't provide shipping address

**Dashboard shows errors loading:**
- Check Supabase project is not paused (free tier pauses after 1 week inactivity)
- Verify SUPABASE_URL and SUPABASE_SERVICE_KEY in Netlify env vars

**Cybake returns errors:**
- Check that ProductIdentifier (SKU) values exist in Cybake
- Verify API key is valid with the API tester tool
- Check Cybake staging for any order creation issues

---

## File Reference

| File | Purpose |
|---|---|
| `netlify/functions/import.mjs` | Main webhook handler — transforms Shopify orders and sends to Cybake |
| `netlify/functions/retry.mjs` | Retry endpoint for failed imports |
| `netlify/functions/logs.mjs` | Dashboard API — queries Supabase for import logs |
| `public/index.html` | Dashboard UI — embedded in Shopify admin |
| `supabase-schema.sql` | Database schema — run in Supabase SQL Editor |
| `.env.example` | Template for all required environment variables |
| `netlify.toml` | Netlify build and header configuration |
