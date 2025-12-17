const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function setupProxy(app) {
  // Existing upstream (warning messages)
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'https://app.driverschat.com',
      changeOrigin: true,
      secure: true,
      logLevel: 'warn',
    })
  );

  // Waze upstream (alerts)
  app.use(
    '/waze',
    createProxyMiddleware({
      target: 'https://www.waze.com',
      changeOrigin: true,
      secure: true,
      logLevel: 'warn',
      pathRewrite: {
        '^/waze': '',
      },
      onProxyReq: (proxyReq, req) => {
        // Waze may return 500 if User-Agent is missing/empty (common for some programmatic clients).
        if (!req.headers['user-agent']) {
          proxyReq.setHeader('user-agent', 'Mozilla/5.0');
        }
        if (!req.headers.accept) {
          proxyReq.setHeader('accept', 'application/json');
        }
      },
    })
  );
};


