import { createClient } from '@supabase/supabase-js';

const {
  SHOPIFY_STORE, SHOPIFY_ACCESS_TOKEN,
  CYBAKE_API_URL, CYBAKE_API_KEY, CYBAKE_API_VERSION = '2.0',
  SUPABASE_URL, SUPABASE_SERVICE_KEY
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const SHOPIFY_API_VERSION = '2024-10';

export default async (req, context) => {
  // CORS headers for dashboard
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const logId = body.log_id;
  if (!logId) {
    return new Response(JSON.stringify({ error: 'Missing log_id' }), { status: 400, headers });
  }

  try {
    // 1. Get the failed log entry
    const { data: logEntry, error: fetchErr } = await supabase
      .from('import_logs')
      .select('*')
      .eq('id', logId)
      .single();

    if (fetchErr || !logEntry) {
      return new Response(JSON.stringify({ error: 'Log entry not found' }), { status: 404, headers });
    }

    if (logEntry.status === 'success') {
      return new Response(JSON.stringify({ error: 'Order already imported successfully' }), { status: 400, headers });
    }

    // 2. If we have the original payload, resend it. Otherwise refetch from Shopify.
    let payload = logEntry.payload_sent;

    if (!payload) {
      // Refetch from Shopify and rebuild
      const gid = `gid://shopify/Order/${logEntry.shopify_order_id}`;
      const order = await fetchShopifyOrder(gid);
      if (!order) {
        return new Response(JSON.stringify({ error: 'Order no longer exists in Shopify' }), { status: 404, headers });
      }
      // Dynamic import of transform logic would be ideal, but for simplicity we rebuild here
      return new Response(JSON.stringify({ error: 'No stored payload and rebuild not yet supported. Please re-trigger from Shopify.' }), { status: 400, headers });
    }

    // 3. Send to Cybake
    const res = await fetch(`${CYBAKE_API_URL}/api/home`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CYBAKE_API_KEY,
        'x-api-version': CYBAKE_API_VERSION
      },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    // 4. Update log entry
    if (res.ok) {
      await supabase.from('import_logs').update({
        status: 'success',
        cybake_import_id: data?.ImportItemId || null,
        http_status: res.status,
        cybake_response: data,
        error_message: null,
        retry_count: (logEntry.retry_count || 0) + 1
      }).eq('id', logId);

      // Update Shopify tag
      const gid = `gid://shopify/Order/${logEntry.shopify_order_id}`;
      await removeShopifyTag(gid, 'Cybake-Failed');
      await addShopifyTag(gid, 'Cybake-Imported');

      return new Response(JSON.stringify({
        success: true,
        order: logEntry.order_number,
        cybake_import_id: data?.ImportItemId
      }), { status: 200, headers });
    } else {
      await supabase.from('import_logs').update({
        http_status: res.status,
        error_message: `Retry failed - Cybake returned ${res.status}: ${text.substring(0, 500)}`,
        cybake_response: data,
        retry_count: (logEntry.retry_count || 0) + 1
      }).eq('id', logId);

      return new Response(JSON.stringify({
        success: false,
        order: logEntry.order_number,
        error: `Cybake returned ${res.status}`
      }), { status: 502, headers });
    }

  } catch (err) {
    console.error('Retry error:', err);
    return new Response(JSON.stringify({ error: 'Internal error', message: err.message }), { status: 500, headers });
  }
};

async function fetchShopifyOrder(gid) {
  const query = `query getOrder($id: ID!) {
    order(id: $id) { id legacyResourceId name }
  }`;

  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables: { id: gid } })
  });
  const json = await res.json();
  return json.data?.order || null;
}

async function addShopifyTag(gid, tag) {
  try {
    const mutation = `mutation addTag($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) { userErrors { message } }
    }`;
    await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ query: mutation, variables: { id: gid, tags: [tag] } })
    });
  } catch (err) { console.error('Tag add failed:', err.message); }
}

async function removeShopifyTag(gid, tag) {
  try {
    const mutation = `mutation removeTag($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) { userErrors { message } }
    }`;
    await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN },
      body: JSON.stringify({ query: mutation, variables: { id: gid, tags: [tag] } })
    });
  } catch (err) { console.error('Tag remove failed:', err.message); }
}
