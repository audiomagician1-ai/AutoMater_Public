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
      errors.push({
        text: det.text,
        desc: det.exception?.description?.substring(0, 3000),
        stack: det.stackTrace?.callFrames?.map(f => `  ${f.functionName || '(anon)'} at ${f.url?.split('/').pop()}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({
        type: 'console.error',
        args: msg.params.args.map(a => (a.value || a.description || '').substring(0, 1000)).join('\n'),
      });
    }
  });
  
  // Click the project
  const r = await send('Runtime.evaluate', {
    expression: `(function() {
      var cards = document.querySelectorAll('[class*="cursor-pointer"]');
      for (var card of cards) {
        if (card.textContent.includes('SelfRevolution')) {
          card.click();
          return 'clicked SelfRevolution';
        }
      }
      if (cards.length > 0) { cards[0].click(); return 'clicked first card'; }
      return 'no cards';
    })()`
  });
  console.log('Click:', r.result?.result?.value);
  
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('\n=== ERRORS (' + errors.length + ') ===');
  errors.slice(0, 5).forEach((e, i) => {
    console.log('\n--- Error ' + i + ' ---');
    if (e.type) console.log('Type:', e.type);
    if (e.args) console.log('Args:', e.args.substring(0, 2000));
    if (e.text) console.log('Text:', e.text);
    if (e.stack) console.log('Stack:\n' + e.stack);
    if (e.desc) console.log('Desc:', e.desc.substring(0, 1500));
  });
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
