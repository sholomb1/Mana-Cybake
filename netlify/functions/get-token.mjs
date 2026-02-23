export default async (req, context) => {
  try {
    const res = await fetch("https://ad0ugy-6g.myshopify.com/admin/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: "6c1fc7a5ebf667607bcd6291e3aca9f5",
        client_secret: "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",
        grant_type: "client_credentials"
      })
    });

    const status = res.status;
    const body = await res.text();

    return new Response(JSON.stringify({ status, body }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
