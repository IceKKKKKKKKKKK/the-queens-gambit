import http from "node:http";

const targetHost = "127.0.0.1";
const targetPort = 4317;

const identities = [
  { port: 4318, id: "qa-black", email: "black@qa.example", name: "黑方测试员" },
  { port: 4319, id: "qa-white", email: "white@qa.example", name: "白方测试员" },
  { port: 4320, id: "qa-spectator", email: "spectator@qa.example", name: "观战测试员" },
];

function forwardedHeaders(request, identity) {
  const headers = {
    ...request.headers,
    host: `${targetHost}:${targetPort}`,
    "oai-authenticated-user-id": identity.id,
    "oai-authenticated-user-email": identity.email,
    "oai-authenticated-user-full-name": encodeURIComponent(identity.name),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
  if (headers.origin) headers.origin = `http://${targetHost}:${targetPort}`;
  if (headers.referer) {
    const referer = new URL(headers.referer);
    headers.referer = `http://${targetHost}:${targetPort}${referer.pathname}${referer.search}`;
  }
  delete headers.connection;
  delete headers["proxy-connection"];
  return headers;
}

for (const identity of identities) {
  const server = http.createServer((request, response) => {
    const upstream = http.request(
      {
        hostname: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: forwardedHeaders(request, identity),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(`QA proxy upstream error: ${error.message}`);
    });
    request.pipe(upstream);
  });

  server.listen(identity.port, "127.0.0.1", () => {
    console.log(`QA identity ${identity.id} listening at http://127.0.0.1:${identity.port}`);
  });
}
