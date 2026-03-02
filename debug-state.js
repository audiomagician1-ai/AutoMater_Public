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
  
  // Check current state
  const r = await send('Runtime.evaluate', {
    expression: `(function() {
      var root = document.getElementById('root');
      return JSON.stringify({
        htmlLen: root.innerHTML.length,
        text: root.textContent.substring(0, 300),
      });
    })()`
  });
  console.log(r.result?.result?.value);
  
  ws.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
