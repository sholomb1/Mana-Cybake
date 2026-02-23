export default async (req, context) => {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  const store = process.env.SHOPIFY_STORE;

  const results = {};

  // Test 1: Check env vars
  results.token_length = token ? token.length : 0;
  results.token_preview = token ? `${token.substring(0, 8)}...${token.substring(token.length - 4)}` : 'MISSING';
  results.store = store || 'MISSING';

  // Test 2: Try 2025-01
  const test1 = await testVersion(store, token, '2025-01');
  results['api_2025_01'] = test1;

  // Test 3: Try 2024-10
  const test2 = await testVersion(store, token, '2024-10');
  results['api_2024_10'] = test2;

  // Test 4: Try 2024-07
  const test3 = await testVersion(store, token, '2024-07');
  results['api_2024_07'] = test3;

  // Test 5: Try REST API instead of GraphQL
  try {
    const restRes = await fetch(`https://${store}/admin/api/2025-01/orders.json?limit=1`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const restBody = await restRes.text();
    results['rest_api'] = {
      status: restRes.status,
      body: restBody.substring(0, 500)
    };
  } catch (err) {
    results['rest_api'] = { error: err.message };
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

async function testVersion(store, token, version) {
  try {
    const res = await fetch(`https://${store}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query: '{ shop { name } }' })
    });
    const body = await res.text();
    return { status: res.status, body: body.substring(0, 500) };
  } catch (err) {
    return { error: err.message };
  }
}
