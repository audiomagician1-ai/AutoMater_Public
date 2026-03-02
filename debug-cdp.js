const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:9222/devtools/page/A7516948941FFE59A055866F0871E3CC');
ws.on('open', () => {
  // Enable Runtime and Log domains
  ws.send(JSON.stringify({id:1, method:'Runtime.enable'}));
  ws.send(JSON.stringify({id:2, method:'Log.enable'}));
  ws.send(JSON.stringify({id:3, method:'Console.enable'}));
  // Also evaluate to get any errors
  ws.send(JSON.stringify({id:10, method:'Runtime.evaluate', params:{expression:'JSON.stringify(window.__CONSOLE_ERRORS || [])'}}));
  // Get console messages by evaluating
  setTimeout(() => {
    ws.send(JSON.stringify({id:11, method:'Runtime.evaluate', params:{expression:
      (function() {
        try {
          // Try to get error from the page
          var el = document.querySelector('#root');
          return JSON.stringify({
            rootHTML: el ? el.innerHTML.substring(0, 500) : 'NO ROOT',
            bodyHTML: document.body.innerHTML.substring(0, 500),
          });
        } catch(e) { return e.message; }
      })()
    }}));
  }, 500);
});
let msgCount = 0;
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', JSON.stringify(msg.params.exceptionDetails, null, 2));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    console.log('CONSOLE_ERROR:', msg.params.args.map(a => a.value || a.description || JSON.stringify(a)).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    console.log('LOG_ERROR:', msg.params.entry.text);
  }
  if (msg.id === 11) {
    console.log('PAGE_STATE:', msg.result?.result?.value);
  }
  msgCount++;
  if (msgCount > 30) { ws.close(); process.exit(0); }
});
setTimeout(() => { ws.close(); process.exit(0); }, 3000);
