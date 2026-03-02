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
        if (msg.id === myId) {
          ws.off('message', handler);
          resolve(msg);
        }
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  };
  
  await send('Runtime.enable');
  
  // Listen for ALL errors
  const errors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push({
        text: msg.params.exceptionDetails.text,
        description: msg.params.exceptionDetails.exception?.description?.substring(0, 500),
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      if (msg.params.type === 'error' || msg.params.type === 'warn') {
        errors.push({
          type: 'console.' + msg.params.type,
          args: msg.params.args.map(a => (a.value || a.description || '').substring(0, 300)).join(' '),
        });
      }
    }
  });
  
  // Check current state
  const r1 = await send('Runtime.evaluate', {
    expression: `document.getElementById('root').innerHTML.length`
  });
  console.log('Root innerHTML length:', r1.result?.result?.value);
  
  // If root is empty, reload
  if (r1.result?.result?.value === 0) {
    console.log('Root is empty, reloading...');
    await send('Page.enable');
    await send('Page.reload');
    await new Promise(r => setTimeout(r, 3000));
  }
  
  // Now check root content
  const r2 = await send('Runtime.evaluate', {
    expression: `document.getElementById('root').innerHTML.substring(0, 2000)`
  });
  console.log('\\nRoot HTML (first 2000 chars):');
  console.log(r2.result?.result?.value);
  
  // Check if React error boundary caught something
  const r3 = await send('Runtime.evaluate', {
    expression: `(function() {
      var root = document.getElementById('root');
      var allText = root ? root.textContent : '';
      return JSON.stringify({
        textLength: allText.length,
        firstText: allText.substring(0, 500),
        childCount: root ? root.children.length : 0,
        firstChildTag: root && root.children[0] ? root.children[0].tagName : 'NONE',
        firstChildClass: root && root.children[0] ? root.children[0].className : 'NONE',
      });
    })()`
  });
  console.log('\\nDOM_STATE:', r3.result?.result?.value);
  
  if (errors.length > 0) {
    console.log('\\nCAPTURED ERRORS:');
    errors.forEach((e,i) => console.log(`  ${i}:`, JSON.stringify(e)));
  }
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
