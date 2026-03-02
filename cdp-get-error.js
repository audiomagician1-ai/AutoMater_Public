const http = require('http');
const WebSocket = require('ws');

async function main() {
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  console.log('All targets:', targets.map(t => t.title + ' | ' + t.url).join('\n'));
  const target = targets.find(t => t.title === '智械母机 AutoMater' || t.url.includes('index.html'));
  if (!target) { console.log('No app target found'); process.exit(1); }
  console.log('Using target:', target.title, target.id);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  
  socket.on('open', () => {
    // Enable runtime first
    socket.send(JSON.stringify({id: 1, method: 'Runtime.enable'}));
    
    // Evaluate to get error info from the page
    socket.send(JSON.stringify({
      id: 2,
      method: 'Runtime.evaluate',
      params: {
        expression: `
          (function() {
            var root = document.getElementById('root');
            var body = document.body;
            return JSON.stringify({
              bodyHTML: body ? body.innerHTML.substring(0, 2000) : 'no body',
              rootHTML: root ? root.innerHTML.substring(0, 1000) : 'no root element',
              rootChildCount: root ? root.childNodes.length : -1,
              allDivs: document.querySelectorAll('div').length,
              title: document.title,
              url: window.location.href
            });
          })()
        `,
        returnByValue: true
      }
    }));
  });

  let errors = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.method === 'Runtime.exceptionThrown') {
      const ex = msg.params.exceptionDetails;
      const desc = ex.exception ? ex.exception.description : ex.text;
      errors.push(desc);
      console.log('\nEXCEPTION:', desc ? desc.substring(0, 3000) : JSON.stringify(ex));
    }
    
    if (msg.id === 2) {
      console.log('\nPage state:', msg.result?.result?.value || JSON.stringify(msg.result));
    }
  });

  setTimeout(() => {
    console.log('\n=== Total exceptions caught:', errors.length, '===');
    socket.close();
    process.exit(0);
  }, 5000);
}

main().catch(e => { console.error(e); process.exit(1); });
