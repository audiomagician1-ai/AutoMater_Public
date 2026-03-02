(async () => {
  const http = require('http');
  
  // Get debug targets
  const targets = await new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  
  const pageUrl = targets[0].webSocketDebuggerUrl;
  console.log('Target:', targets[0].url);
  
  // Use fetch to evaluate JS via HTTP endpoint
  const evalUrl = `http://localhost:9222/json/evaluate?${targets[0].id}`;
  
  // Use CDP HTTP endpoint to send commands
  const sendCommand = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({ method, params });
      const req = http.request({
        hostname: 'localhost',
        port: 9222,
        path: `/json/protocol`,
        method: 'GET',
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.end();
    });
  };
  
  // Just use the page's evaluate endpoint directly
  // Actually, let's use native Node net to connect to WebSocket minimally
  // Simplest approach: use http to hit the /json/version and targets
  console.log('Page URL:', targets[0].url);
  console.log('Title:', targets[0].title);
  
  // For console capture, we need WebSocket. Let's install ws quickly
  const { execSync } = require('child_process');
  try {
    execSync('npm install ws --no-save 2>&1', { cwd: process.cwd(), timeout: 15000 });
  } catch(e) {}
  
  const WebSocket = require('ws');
  const ws = new WebSocket(pageUrl);
  
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
  
  // Enable console/runtime
  await send('Runtime.enable');
  await send('Log.enable');
  
  // Collect exceptions for 1 second
  const errors = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push({ type: 'console.error', args: msg.params.args.map(a => a.value || a.description || '').join(' ') });
    }
  });
  
  // Evaluate page state
  const result = await send('Runtime.evaluate', {
    expression: `(function() {
      var root = document.getElementById('root');
      var rootHTML = root ? root.innerHTML.substring(0, 1000) : 'NO_ROOT';
      return JSON.stringify({
        url: location.href,
        rootChildCount: root ? root.childElementCount : -1,
        rootHTML: rootHTML,
      });
    })()`
  });
  console.log('PAGE_STATE:', result.result?.result?.value);
  
  // Wait a moment to catch any console errors
  await new Promise(r => setTimeout(r, 1500));
  
  if (errors.length > 0) {
    console.log('ERRORS_FOUND:', errors.length);
    errors.forEach((e, i) => console.log(`ERROR_${i}:`, JSON.stringify(e, null, 2)));
  } else {
    console.log('NO_ERRORS_CAUGHT');
  }
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
