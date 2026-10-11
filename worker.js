export default {
  async fetch(request, env, ctx) {
    return new Response("MTProto Proxy Worker is running successfully!", {
      status: 200,
      headers: { "content-type": "text/plain;charset=UTF-8" }
    });
  },
};
