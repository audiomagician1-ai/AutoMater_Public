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
        desc: det.exception?.description?.substring(0, 3000),
        stack: det.stackTrace?.callFrames?.slice(0, 15).map(f => 
          `  ${f.functionName || '(anon)'} at ${f.url?.split('/').pop()}:${f.lineNumber}:${f.columnNumber}`
        ).join('\n'),
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({
        type: 'console.error',
        text: msg.params.args.map(a => (a.value || a.description || '').substring(0, 2000)).join('\n'),
      });
    }
  });
  
  // Check current page and click 
  const r1 = await send('Runtime.evaluate', {
    expression: `document.getElementById('root').textContent.substring(0, 200)`
  });
  console.log('Current text:', r1.result?.result?.value);
  
  // Click SelfRevolution
  const r2 = await send('Runtime.evaluate', {
    expression: `(function() {
      var allEls = document.querySelectorAll('div');
      var found = [];
      for (var el of allEls) {
        if (el.textContent.includes('SelfRevolution') && el.className.includes('cursor-pointer')) {
          found.push(el.textContent.substring(0, 80));
          el.click();
          return 'CLICKED: ' + el.textContent.substring(0, 80);
        }
      }
      // list all clickable items
      var cards = document.querySelectorAll('[class*="cursor-pointer"]');
      return 'No SelfRevolution. Cards: ' + cards.length + ', texts: ' + Array.from(cards).map(c => c.textContent.substring(0, 30)).join(' | ');
    })()`
  });
  console.log('Click:', r2.result?.result?.value);
  
  await new Promise(r => setTimeout(r, 3000));
  
  // Check DOM after click
  const r3 = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ htmlLen: document.getElementById('root').innerHTML.length, text: document.getElementById('root').textContent.substring(0, 300) })`
  });
  console.log('After click:', r3.result?.result?.value);
  
  console.log('\nErrors:', errors.length);
  errors.forEach((e, i) => {
    console.log('ERR' + i + ':', e.desc || e.text);
    if (e.stack) console.log(e.stack);
  });
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
