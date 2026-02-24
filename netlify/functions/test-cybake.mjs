const {
  CYBAKE_API_URL, CYBAKE_API_KEY, CYBAKE_API_VERSION = '2.0'
} = process.env;

export default async (req, context) => {
  const results = {};
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': CYBAKE_API_KEY,
    'x-api-version': CYBAKE_API_VERSION
  };

  // Try various possible endpoints
  const endpoints = [
    '/api/home',
    '/api/import',
    '/api/import/status',
    '/api/orders',
    '/api/home/status',
    '/api',
    '/swagger',
    '/swagger/v1/swagger.json',
    '/swagger/index.html'
  ];

  for (const path of endpoints) {
    try {
      const res = await fetch(`${CYBAKE_API_URL}${path}`, {
        method: 'GET',
        headers
      });
      const text = await res.text();
      results[path] = {
        status: res.status,
        body: text.substring(0, 500)
      };
    } catch (err) {
      results[path] = { error: err.message };
    }
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
