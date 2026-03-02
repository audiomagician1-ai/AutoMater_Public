const http = require('http');
const WebSocket = require('ws');

async function main() {
  // Get debug target
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  
  const target = targets.find(t => t.type === 'page');
  if (!target) { console.log('No page target found'); process.exit(1); }
  
  console.log('Connecting to:', target.webSocketDebuggerUrl);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  
  socket.on('open', () => {
    console.log('Connected! Enabling Runtime & Log...');
    socket.send(JSON.stringify({id:1, method:'Runtime.enable'}));
    socket.send(JSON.stringify({id:2, method:'Log.enable'}));
    socket.send(JSON.stringify({id:3, method:'Console.enable'}));
    console.log('Monitoring... Click into the project now. Will capture for 30s.');
  });

  let msgs = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      const text = ex.exception?.description || ex.text || JSON.stringify(ex);
      console.log('\n!!! EXCEPTION:', text.substring(0, 2000));
      msgs.push({type:'exception', text: text.substring(0, 3000)});
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params.args.map(a => a.value || a.description || a.type).join(' ');
      if (args.includes('error') || args.includes('Error') || args.includes('warn') || msg.params.type === 'error' || msg.params.type === 'warn') {
        console.log(`[${msg.params.type}]`, args.substring(0, 500));
        msgs.push({type: msg.params.type, text: args.substring(0, 1000)});
      }
    } else if (msg.method === 'Log.entryAdded') {
      const entry = msg.params.entry;
      if (entry.level === 'error' || entry.level === 'warning') {
        console.log(`[LOG ${entry.level}]`, entry.text?.substring(0, 500));
        msgs.push({type: entry.level, text: entry.text?.substring(0, 1000)});
      }
    }
  });

  socket.on('error', (err) => { console.error('WS error:', err.message); });
  
  setTimeout(() => {
    console.log('\n=== Summary: captured', msgs.length, 'error/warning messages ===');
    msgs.forEach((m, i) => console.log(`\n--- [${i}] ${m.type} ---\n${m.text}`));
    socket.close();
    process.exit(0);
  }, 30000);
}

main().catch(e => { console.error(e); process.exit(1); });
