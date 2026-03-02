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
  await send('Debugger.enable');
  
  // Set pause on exceptions
  await send('Debugger.setPauseOnExceptions', { state: 'none' });
  
  const errors = [];
  const consoleErrors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const det = msg.params.exceptionDetails;
      errors.push({
        desc: det.exception?.description?.substring(0, 3000),
        stack: det.stackTrace?.callFrames?.slice(0, 5).map(f => {
          return `  ${f.functionName || '(anon)'} at line:${f.lineNumber} col:${f.columnNumber}`;
        }).join('\n'),
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => (a.value || a.description || '').substring(0, 1500)).join(' '));
    }
  });
  
  // Click the project card
  const r = await send('Runtime.evaluate', {
    expression: `(function() {
      var cards = document.querySelectorAll('[class*="cursor-pointer"]');
      for (var card of cards) {
        if (card.textContent.includes('SelfRevolution')) {
          card.click();
          return 'clicked SelfRevolution';
        }
      }
      return 'not found, cards: ' + cards.length;
    })()`
  });
  console.log('Click:', r.result?.result?.value);
  
  await new Promise(r => setTimeout(r, 4000));
  
  // Also check [ErrorBoundary] console.error messages
  console.log('\n=== EXCEPTIONS (' + errors.length + ') ===');
  errors.forEach((e, i) => {
    console.log('Exception ' + i + ':', e.desc?.substring(0, 500));
    if (e.stack) console.log(e.stack);
  });
  
  console.log('\n=== CONSOLE ERRORS (' + consoleErrors.length + ') ===');
  consoleErrors.forEach((e, i) => {
    console.log('ConsoleErr ' + i + ':', e.substring(0, 1000));
  });
  
  // Try to get React fiber info from the unminified source
  const r2 = await send('Runtime.evaluate', {
    expression: `(function() {
      // Try to find the erroring component by reading the React internal fiber
      var root = document.getElementById('root');
      var fiberKey = Object.keys(root).find(k => k.startsWith('__reactFiber'));
      if (!fiberKey) return 'No fiber found';
      var fiber = root[fiberKey];
      // Walk up to find error boundary
      var current = fiber;
      while (current) {
        if (current.memoizedState && current.memoizedState.hasError) {
          return 'ErrorBoundary found: ' + current.type?.name;
        }
        current = current.child || current.sibling;
      }
      return 'Fiber found but no error state. Root type: ' + (fiber?.type?.name || fiber?.type || 'unknown');
    })()`
  });
  console.log('\nFiber:', r2.result?.result?.value);
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
