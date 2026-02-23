import { createClient } from '@supabase/supabase-js';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const {
  SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN,
  CYBAKE_API_URL, CYBAKE_API_KEY, CYBAKE_API_VERSION = '2.0',
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  WEBHOOK_SECRET
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SHOPIFY_API_VERSION = '2025-01';

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  // Verify webhook secret
  const secret = req.headers.get('x-webhook-secret');
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  // Accept either a Shopify GID or numeric ID
  const orderId = body.order_id || body.id;
  if (!orderId) {
    return new Response(JSON.stringify({ error: 'Missing order_id' }), { status: 400 });
  }

  // Extract numeric ID from GID if needed (gid://shopify/Order/123456 → 123456)
  const numericId = String(orderId).replace(/^gid:\/\/shopify\/Order\//, '');
  const gid = `gid://shopify/Order/${numericId}`;

  try {
    // 1. Fetch full order from Shopify
    console.log(`=== PROCESSING ORDER ${numericId} ===`);
    console.log('Order name:', body.order_name);
    console.log('Token check:', SHOPIFY_ACCESS_TOKEN ? `${SHOPIFY_ACCESS_TOKEN.substring(0, 8)}...${SHOPIFY_ACCESS_TOKEN.substring(SHOPIFY_ACCESS_TOKEN.length - 4)} (length: ${SHOPIFY_ACCESS_TOKEN.length})` : 'MISSING');
    console.log('Store:', SHOPIFY_STORE);
    const order = await fetchShopifyOrder(gid);
    if (!order) {
      console.error('Order not found in Shopify for GID:', gid);
      await logImport({ shopify_order_id: numericId, order_number: body.order_name || 'Unknown', status: 'failed', error_message: 'Order not found in Shopify' });
      return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404 });
    }
    console.log('Shopify order fetched:', order.name, '| Tags:', order.tags?.join(', '));

    // 2. Check for duplicate (already imported)
    const existing = await checkDuplicate(numericId);
    if (existing) {
      console.log('Duplicate detected — already imported with Cybake ID:', existing.cybake_import_id);
      return new Response(JSON.stringify({ message: 'Order already imported', import_id: existing.cybake_import_id }), { status: 200 });
    }

    // 3. Transform to Cybake format
    const { payload, meta } = transformOrder(order);
    console.log('Transformed:', JSON.stringify(meta, null, 2));

    // 4. Validate
    const errors = validatePayload(payload);
    if (errors.length > 0) {
      const errorMsg = errors.join('; ');
      console.error('Validation failed:', errorMsg);
      await logImport({ ...meta, status: 'failed', error_message: `Validation: ${errorMsg}`, payload_sent: payload });
      await tagShopifyOrder(gid, 'Cybake-Failed');
      return new Response(JSON.stringify({ error: 'Validation failed', details: errors }), { status: 400 });
    }

    // 5. Send to Cybake
    const cybakeResult = await sendToCybake(payload);

    // 6. Log & tag
    if (cybakeResult.success) {
      await logImport({
        ...meta,
        status: 'success',
        cybake_import_id: cybakeResult.data?.ImportItemId,
        http_status: cybakeResult.httpStatus,
        payload_sent: payload,
        cybake_response: cybakeResult.data
      });
      await tagShopifyOrder(gid, 'Cybake-Imported');
    } else {
      await logImport({
        ...meta,
        status: 'failed',
        http_status: cybakeResult.httpStatus,
        error_message: cybakeResult.error,
        payload_sent: payload,
        cybake_response: cybakeResult.data
      });
      await tagShopifyOrder(gid, 'Cybake-Failed');
    }

    // Return 422 (not 5xx) so Shopify Flow won't retry — we handle retries ourselves
    return new Response(JSON.stringify({
      success: cybakeResult.success,
      order: meta.order_number,
      cybake_import_id: cybakeResult.data?.ImportItemId,
      error: cybakeResult.error || null
    }), { status: cybakeResult.success ? 200 : 422 });

  } catch (err) {
    console.error('Unhandled error:', err);
    await logImport({
      shopify_order_id: numericId,
      order_number: body.order_name || 'Unknown',
      status: 'failed',
      error_message: `System error: ${err.message}`
    });
    return new Response(JSON.stringify({ error: 'Internal server error', message: err.message }), { status: 422 });
  }
};

// ─── SHOPIFY API ──────────────────────────────────────────────────────────────
async function fetchShopifyOrder(gid) {
  const query = `query getOrder($id: ID!) {
    order(id: $id) {
      id
      legacyResourceId
      name
      tags
      note
      email
      phone
      createdAt
      customAttributes { key value }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount } }
      shippingAddress {
        name firstName lastName company
        address1 address2
        city province provinceCode
        zip country countryCode
        phone
      }
      lineItems(first: 100) {
        edges {
          node {
            id sku quantity title name
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

  const shopifyUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  console.log('Shopify GraphQL URL:', shopifyUrl);
  console.log('Request headers:', JSON.stringify({
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN ? `${SHOPIFY_ACCESS_TOKEN.substring(0, 8)}...(${SHOPIFY_ACCESS_TOKEN.length} chars)` : 'MISSING'
  }));

  const res = await fetch(shopifyUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables: { id: gid } })
  });

  console.log('Shopify response status:', res.status);
  console.log('Shopify response headers:', JSON.stringify(Object.fromEntries(res.headers.entries())));
  const json = await res.json();
  if (json.errors) {
    console.error('Shopify GraphQL errors:', JSON.stringify(json.errors, null, 2));
  }
  if (!json.data?.order) {
    console.error('No order in response. Full response:', JSON.stringify(json, null, 2).substring(0, 2000));
  }
  return json.data?.order || null;
}

async function tagShopifyOrder(gid, tag) {
  try {
    const mutation = `mutation addTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`;

    await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ query: mutation, variables: { id: gid, tags: [tag] } })
    });
  } catch (err) {
    console.error('Failed to tag order:', err.message);
  }
}

// ─── ORDER TRANSFORMATION ─────────────────────────────────────────────────────
function transformOrder(order) {
  const tags = order.tags || [];
  const tagsParsed = parseTags(tags);
  const lineItems = consolidateLineItems(order.lineItems?.edges || []);
  const shipping = order.shippingAddress || {};
  const shippingCost = parseFloat(order.totalShippingPriceSet?.shopMoney?.amount || '0');
  const orderTotal = parseFloat(order.currentTotalPriceSet?.shopMoney?.amount || '0');
  const numericId = order.legacyResourceId || order.id.replace(/^gid:\/\/shopify\/Order\//, '');

  // Build order note from tags
  const noteParts = [];
  if (tagsParsed.orderType) noteParts.push(tagsParsed.orderType);
  if (tagsParsed.dayOfWeek && tagsParsed.dateStr) {
    noteParts.push(`${tagsParsed.dayOfWeek}, ${tagsParsed.dateStr}`);
  } else if (tagsParsed.dateStr) {
    noteParts.push(tagsParsed.dateStr);
  }
  if (tagsParsed.timeWindow) noteParts.push(tagsParsed.timeWindow);
  if (tagsParsed.location) noteParts.push(tagsParsed.location);
  if (order.note && order.note.trim() && order.note.trim().toLowerCase() !== 'null') {
    noteParts.push(`Customer Note: ${order.note.trim()}`);
  }

  const deliveryDate = tagsParsed.deliveryDate || fallbackDeliveryDate(order);

  const payload = {
    HomeOrderOptions: {
      GroupInvoicesToHeadOffice: false,
      SendInvoicesToHeadOffice: false,
      ExportInvoicesToHeadOffice: false,
      HeadOfficeCompanyCode: null,
      OrderSource: 1,
      GroupOrderItems: false
    },
    Orders: [{
      ExternalUniqueIdentifier: `SHOPIFY-${order.name?.replace('#', '')}-${numericId}`,
      DeliveryCustomer: shipping.name || 'Unknown',
      DeliveryDate: deliveryDate,
      PurchaseOrderNumber: order.name || `SHOP-${numericId}`,
      OrderedDate: order.createdAt || new Date().toISOString(),
      OrderNote: noteParts.length > 0 ? noteParts.join(' | ') : null,
      Email: order.email || 'noemail@placeholder.com',
      Telephone: cleanPhone(shipping.phone || order.phone),
      AddressLineOne: shipping.address1 || 'N/A',
      AddressLineTwo: shipping.address2 || null,
      AddressLineThree: null,
      AddressCity: shipping.city || null,
      AddressCountry: shipping.country || null,
      AddressCounty: shipping.province || null,
      AddressPostcode: shipping.zip || 'N/A',
      Shipping: shippingCost,
      OrderLines: lineItems
    }]
  };

  const meta = {
    shopify_order_id: numericId,
    order_number: order.name || `#${numericId}`,
    customer_name: shipping.name || 'Unknown',
    customer_email: order.email,
    delivery_date: deliveryDate?.split('T')[0] || null,
    order_type: tagsParsed.orderType || 'Unknown',
    line_items_count: lineItems.length,
    order_total: orderTotal
  };

  return { payload, meta };
}

function parseTags(tags) {
  const timePattern = /\d{1,2}:\d{2}\s*[AP]M\s*-\s*\d{1,2}:\d{2}\s*[AP]M/i;
  const datePattern = /^\d{1,2}\s+\w{3,}\s+\d{4}$/;
  const orderTypes = ['local delivery', 'store pickup', 'shipping', 'delivery', 'pickup'];
  const ignoreTags = ['cybake-imported', 'cybake-failed', 'cybake-pending'];

  let timeWindow = null, dateStr = null, deliveryDate = null, orderType = null, location = null, dayOfWeek = null;

  for (const tag of tags) {
    const trimmed = tag.trim();
    // Skip our own system tags
    if (ignoreTags.includes(trimmed.toLowerCase())) continue;
    if (timePattern.test(trimmed)) {
      timeWindow = trimmed;
    } else if (datePattern.test(trimmed)) {
      dateStr = trimmed;
      const parsed = new Date(trimmed);
      if (!isNaN(parsed)) {
        deliveryDate = parsed.toISOString();
        dayOfWeek = parsed.toLocaleDateString('en-US', { weekday: 'long' });
      }
    } else if (orderTypes.some(ot => trimmed.toLowerCase().includes(ot))) {
      orderType = trimmed;
    } else if (!location) {
      location = trimmed;
    }
  }

  return { timeWindow, dateStr, deliveryDate, dayOfWeek, orderType, location };
}

function fallbackDeliveryDate(order) {
  const base = order.createdAt ? new Date(order.createdAt) : new Date();
  base.setDate(base.getDate() + 3);
  return base.toISOString();
}

function consolidateLineItems(edges) {
  const lineMap = {};

  for (const { node } of edges) {
    const sku = cleanSku(node.sku);
    if (!sku || !node.quantity || node.quantity <= 0) continue;

    const price = parseFloat(node.originalUnitPriceSet?.shopMoney?.amount || '0');

    if (lineMap[sku]) {
      lineMap[sku].Quantity += node.quantity;
      if (node.name && lineMap[sku].Note !== node.name) {
        lineMap[sku].Note += '; ' + node.name;
      }
    } else {
      lineMap[sku] = {
        ProductIdentifier: sku,
        Quantity: node.quantity,
        Price: price,
        Note: node.name || null
      };
    }
  }

  return Object.values(lineMap);
}

function cleanPhone(phone) {
  if (!phone) return null;
  return String(phone).replace(/^'+/, '').trim() || null;
}

function cleanSku(sku) {
  if (!sku) return null;
  let s = String(sku).trim();
  if (/^\d+\.0$/.test(s)) s = s.replace(/\.0$/, '');
  return s || null;
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────
function validatePayload(payload) {
  const errors = [];
  const order = payload.Orders?.[0];
  if (!order) return ['No order data'];

  if (!order.Email || order.Email === 'noemail@placeholder.com') errors.push('Missing email');
  if (!order.AddressLineOne || order.AddressLineOne === 'N/A') errors.push('Missing address');
  if (!order.AddressPostcode || order.AddressPostcode === 'N/A') errors.push('Missing postcode');
  if (!order.DeliveryDate) errors.push('Could not parse delivery date from tags');
  if (!order.OrderLines || order.OrderLines.length === 0) errors.push('No valid line items (missing SKUs?)');

  for (const line of (order.OrderLines || [])) {
    if (!line.ProductIdentifier) errors.push(`Line item missing SKU: ${line.Note || 'unknown'}`);
    if (!line.Quantity || line.Quantity <= 0) errors.push(`Invalid quantity for ${line.ProductIdentifier}`);
  }

  return errors;
}

// ─── CYBAKE API ───────────────────────────────────────────────────────────────
async function sendToCybake(payload) {
  const url = `${CYBAKE_API_URL}/api/home`;
  console.log('=== CYBAKE REQUEST ===');
  console.log('URL:', url);
  console.log('API Key (first 8):', CYBAKE_API_KEY?.substring(0, 8) + '...');
  console.log('API Version:', CYBAKE_API_VERSION);
  console.log('Payload orders:', payload.Orders?.length);
  console.log('First order ID:', payload.Orders?.[0]?.ExternalUniqueIdentifier);
  console.log('Full payload:', JSON.stringify(payload, null, 2));

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CYBAKE_API_KEY,
        'x-api-version': CYBAKE_API_VERSION
      },
      body: JSON.stringify(payload)
    });

    console.log('=== CYBAKE RESPONSE ===');
    console.log('Status:', res.status, res.statusText);
    console.log('Response headers:', JSON.stringify(Object.fromEntries(res.headers.entries())));

    const text = await res.text();
    console.log('Response body:', text.substring(0, 2000));

    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 2000) }; }

    if (res.ok) {
      console.log('=== CYBAKE SUCCESS ===');
      return { success: true, httpStatus: res.status, data };
    } else {
      const error = `Cybake returned ${res.status} ${res.statusText}: ${text.substring(0, 1000)}`;
      console.error('=== CYBAKE FAILURE ===');
      console.error(error);
      return { success: false, httpStatus: res.status, data, error };
    }
  } catch (err) {
    const error = `Network error calling ${url}: ${err.message}`;
    console.error('=== CYBAKE NETWORK ERROR ===');
    console.error(error);
    console.error('Stack:', err.stack);
    return { success: false, httpStatus: 0, data: null, error };
  }
}

// ─── SUPABASE LOGGING ─────────────────────────────────────────────────────────
async function logImport(data) {
  try {
    // Check if there's already a row for this order
    const { data: existing } = await supabase
      .from('import_logs')
      .select('id, status')
      .eq('shopify_order_id', data.shopify_order_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const row = {
      shopify_order_id: data.shopify_order_id,
      order_number: data.order_number || 'Unknown',
      customer_name: data.customer_name || null,
      customer_email: data.customer_email || null,
      delivery_date: data.delivery_date || null,
      order_type: data.order_type || null,
      line_items_count: data.line_items_count || 0,
      order_total: data.order_total || null,
      status: data.status,
      cybake_import_id: data.cybake_import_id || null,
      http_status: data.http_status || null,
      error_message: data.error_message?.substring(0, 5000) || null,
      payload_sent: data.payload_sent || null,
      cybake_response: data.cybake_response || null,
      updated_at: new Date().toISOString()
    };

    if (existing) {
      // Never overwrite a success with a failure
      if (existing.status === 'success' && data.status === 'failed') {
        console.log(`Skipping log update — order ${data.shopify_order_id} already succeeded`);
        return;
      }
      // Update existing row
      await supabase.from('import_logs').update(row).eq('id', existing.id);
      console.log(`Updated existing log entry ${existing.id} for order ${data.shopify_order_id}`);
    } else {
      // First time seeing this order — insert
      await supabase.from('import_logs').insert(row);
      console.log(`Created new log entry for order ${data.shopify_order_id}`);
    }
  } catch (err) {
    console.error('Failed to log to Supabase:', err.message);
  }
}

async function checkDuplicate(shopifyOrderId) {
  const { data } = await supabase
    .from('import_logs')
    .select('id, cybake_import_id')
    .eq('shopify_order_id', shopifyOrderId)
    .eq('status', 'success')
    .limit(1)
    .maybeSingle();
  return data;
}
