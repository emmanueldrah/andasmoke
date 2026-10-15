const CDP = require('chrome-remote-interface');

(async () => {
  const target = process.argv[2] || 'http://127.0.0.1:3000';
  const out = process.argv[3] || 'tmp-audit/logo-check.png';
  const width = parseInt(process.argv[4] || '1440');
  const height = parseInt(process.argv[5] || '900');

  let client;
  try {
    client = await CDP({ host: '127.0.0.1', port: 9222 });
    const { Page, Runtime, Emulation } = client;

    await Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false });
    await Page.enable();
    await Page.navigate({ url: target });
    await Page.loadEventFired();
    await new Promise(r => setTimeout(r, 2500));

    const { data } = await Page.captureScreenshot({ format: 'png' });
    require('fs').writeFileSync(out, Buffer.from(data, 'base64'));
    console.log('Saved', out);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    if (client) await client.close();
  }
})();
