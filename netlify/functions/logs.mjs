import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export default async (req, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get('status'); // all, success, failed
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = parseInt(url.searchParams.get('limit') || '50');
  const search = url.searchParams.get('search');
  const offset = (page - 1) * limit;

  try {
    // Build query
    let query = supabase
      .from('import_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (search) {
      query = query.or(`order_number.ilike.%${search}%,customer_name.ilike.%${search}%`);
    }

    const { data, count, error } = await query;

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }

    // Get summary stats
    const { data: stats } = await supabase.rpc('get_import_stats').single();
    
    // If RPC doesn't exist, compute manually
    let summary;
    if (stats) {
      summary = stats;
    } else {
      const { count: totalCount } = await supabase.from('import_logs').select('*', { count: 'exact', head: true });
      const { count: successCount } = await supabase.from('import_logs').select('*', { count: 'exact', head: true }).eq('status', 'success');
      const { count: failedCount } = await supabase.from('import_logs').select('*', { count: 'exact', head: true }).eq('status', 'failed');
      summary = { total: totalCount || 0, success: successCount || 0, failed: failedCount || 0 };
    }

    return new Response(JSON.stringify({
      logs: data,
      total: count,
      page,
      limit,
      summary
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
