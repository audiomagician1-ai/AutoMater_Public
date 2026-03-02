(async () => {
  const WebSocket = require('ws');
  const http = require('http');
  
  const targets = await new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise(resolve => ws.on('open', resolve));
  
  let id = 1;
  const send = (method, params = {}) => {
    return new Promise(resolve => {
      const myId = id++;
      const handler = (data) => {
        const msg = JSON.parse(data);
        if (msg.id === myId) { ws.off('message', handler); resolve(msg); }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  };
  
  await send('Runtime.enable');
  
  const errors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const det = msg.params.exceptionDetails;
      errors.push({ desc: det.exception?.description?.substring(0, 500) });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({ type: 'console.error', text: msg.params.args.map(a => (a.value || a.description || '').substring(0, 300)).join(' ') });
    }
  });
  
  // Verify project list loaded
  const r1 = await send('Runtime.evaluate', {
    expression: `document.getElementById('root').textContent.substring(0, 200)`
  });
  console.log('Before click:', r1.result?.result?.value);
  
  // Click project
  const r2 = await send('Runtime.evaluate', {
    expression: `(function() {
      var divs = document.querySelectorAll('div[class*="cursor-pointer"]');
      for (var d of divs) {
        if (d.textContent.includes('SelfRevolution')) { d.click(); return 'clicked'; }
      }
      return 'not found, divs=' + divs.length;
    })()`
  });
  console.log('Click:', r2.result?.result?.value);
  
  await new Promise(r => setTimeout(r, 4000));
  
  // Check after click
  const r3 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ htmlLen: document.getElementById('root').innerHTML.length, text: document.getElementById('root').textContent.substring(0, 300) })`
  });
  console.log('After click:', r3.result?.result?.value);
  
  console.log('Errors:', errors.length);
  errors.forEach((e, i) => console.log('ERR' + i + ':', JSON.stringify(e)));
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
