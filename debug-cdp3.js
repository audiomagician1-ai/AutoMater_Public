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
  
  // Check for JS errors by evaluating
  const r1 = await send('Runtime.evaluate', {
    expression: `(function() {
      // Check if React mounted
      var root = document.getElementById('root');
      var reactRoot = root?._reactRootContainer || root?.__reactContainer$;
      
      // Check all script tags
      var scripts = Array.from(document.querySelectorAll('script'));
      var scriptInfo = scripts.map(s => ({
        src: s.src,
        type: s.type,
        loaded: !s.onerror,
      }));
      
      // Look for any error overlay
      var errorOverlays = document.querySelectorAll('[class*="error"], [class*="Error"]');
      
      // Try to detect React keys on root
      var rootKeys = root ? Object.keys(root).filter(k => k.startsWith('__react')) : [];
      
      return JSON.stringify({
        rootExists: !!root,
        rootHTML: root ? root.innerHTML.substring(0, 200) : 'none',
        rootChildCount: root ? root.childElementCount : -1,
        hasReactRoot: !!reactRoot,
        reactKeys: rootKeys,
        scripts: scriptInfo,
        errorOverlays: errorOverlays.length,
        documentReadyState: document.readyState,
      }, null, 2);
    })()`
  });
  console.log('STATE:', r1.result?.result?.value);
  
  // Try to reload and catch errors this time
  // First, enable Runtime
  await send('Runtime.enable');
  
  // Now evaluate to look for any window.onerror captures
  const r2 = await send('Runtime.evaluate', {
    expression: `(function() {
      // Manually check if the JS module loaded at all
      return JSON.stringify({
        windowKeys: Object.keys(window).filter(k => k.startsWith('__')).slice(0, 20),
        hasAutomater: typeof window.automater !== 'undefined',
        automaterKeys: typeof window.automater !== 'undefined' ? Object.keys(window.automater) : [],
      });
    })()`
  });
  console.log('WINDOW:', r2.result?.result?.value);
  
  // Reload and catch errors
  console.log('\\n--- Reloading page to catch errors ---');
  await send('Runtime.enable');
  
  const errors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push({
        text: msg.params.exceptionDetails.text,
        description: msg.params.exceptionDetails.exception?.description?.substring(0, 500),
        url: msg.params.exceptionDetails.url,
        line: msg.params.exceptionDetails.lineNumber,
        col: msg.params.exceptionDetails.columnNumber,
      });
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({
        type: 'console.error',
        args: msg.params.args.map(a => (a.value || a.description || '').substring(0, 300)).join(' '),
      });
    }
  });
  
  await send('Page.enable');
  await send('Page.reload');
  
  // Wait for page to load and errors to appear
  await new Promise(r => setTimeout(r, 4000));
  
  console.log('\\nERRORS AFTER RELOAD:', errors.length);
  errors.forEach((e, i) => console.log(`ERR_${i}:`, JSON.stringify(e, null, 2)));
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
