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
  await send('Page.enable');
  
  const errors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const det = msg.params.exceptionDetails;
      errors.push({
        text: det.text,
        desc: det.exception?.description?.substring(0, 2000),
        url: det.url,
        line: det.lineNumber,
        col: det.columnNumber,
        stack: det.stackTrace?.callFrames?.map(f => `${f.functionName} (${f.url?.split('/').pop()}:${f.lineNumber}:${f.columnNumber})`).join('\n  '),
      });
    }
  });
  
  // Click the project card to enter project
  console.log('Clicking project card...');
  const r = await send('Runtime.evaluate', {
    expression: `(function() {
      var cards = document.querySelectorAll('[class*="cursor-pointer"]');
      for (var card of cards) {
        if (card.textContent.includes('SelfRevolution')) {
          card.click();
          return 'clicked SelfRevolution';
        }
      }
      // Try any card
      if (cards.length > 0) {
        cards[0].click();
        return 'clicked first card: ' + cards[0].textContent.substring(0, 50);
      }
      return 'no cards found';
    })()`
  });
  console.log('Result:', r.result?.result?.value);
  
  // Wait for errors
  await new Promise(r => setTimeout(r, 3000));
  
  console.log('\n=== ERRORS ===');
  console.log('Total:', errors.length);
  errors.forEach((e, i) => {
    console.log(`\n--- Error ${i} ---`);
    console.log('Text:', e.text);
    console.log('Stack:\n ', e.stack);
    if (e.desc) console.log('Desc:', e.desc.substring(0, 500));
  });
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
