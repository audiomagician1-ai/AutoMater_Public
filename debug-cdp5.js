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
        type: 'exception',
        text: msg.params.exceptionDetails.text,
        desc: msg.params.exceptionDetails.exception?.description?.substring(0, 1000),
        url: msg.params.exceptionDetails.url,
        line: msg.params.exceptionDetails.lineNumber,
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const level = msg.params.type;
      if (level === 'error' || level === 'warn') {
        errors.push({
          type: 'console.' + level,
          args: msg.params.args.map(a => (a.value || a.description || '').substring(0, 500)).join(' '),
        });
      }
    }
  });
  
  console.log('Clicking the project card...');
  
  // Simulate clicking the project card by dispatching the enterProject action
  const r = await send('Runtime.evaluate', {
    expression: `(function() {
      // Find the project card and click it
      var cards = document.querySelectorAll('[class*="cursor-pointer"]');
      var clicked = false;
      for (var card of cards) {
        if (card.textContent.includes('SelfRevolution') || card.textContent.includes('AgentForge')) {
          card.click();
          clicked = true;
          break;
        }
      }
      return JSON.stringify({ clicked, cardsFound: cards.length });
    })()`
  });
  console.log('Click result:', r.result?.result?.value);
  
  // Wait for React to process
  await new Promise(r => setTimeout(r, 3000));
  
  // Check DOM state after click
  const r2 = await send('Runtime.evaluate', {
    expression: `(function() {
      var root = document.getElementById('root');
      return JSON.stringify({
        htmlLength: root.innerHTML.length,
        textContent: root.textContent.substring(0, 300),
        childCount: root.children.length,
        firstChildClass: root.children[0] ? root.children[0].className.substring(0, 100) : 'NONE',
        innerHTMLPreview: root.innerHTML.substring(0, 500),
      });
    })()`
  });
  console.log('\\nDOM after click:', r2.result?.result?.value);
  
  console.log('\\nTotal errors captured:', errors.length);
  errors.forEach((e, i) => {
    console.log('ERR_' + i + ':', JSON.stringify(e));
  });
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
