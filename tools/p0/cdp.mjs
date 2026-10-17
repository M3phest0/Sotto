// Evaluate JavaScript in the running Tauri WebView2 via Chrome DevTools Protocol.
// Requires WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222.
// Usage: node tools/p0/cdp.mjs < expression.js   (expression read from stdin)
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const expression = Buffer.concat(chunks).toString('utf8')

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'))
if (!page) {
  console.error('no page target; targets=' + JSON.stringify(list.map((t) => t.url)))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

const id = 1
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== id) return
    clearTimeout(timer)
    resolve(msg)
  }
  ws.send(JSON.stringify({
    id,
    method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true, userGesture: true },
  }))
})

ws.close()
if (result.error) {
  console.error(JSON.stringify(result.error, null, 2))
  process.exit(2)
}
const r = result.result ?? {}
if (r.exceptionDetails) {
  console.error(JSON.stringify(r.exceptionDetails, null, 2))
  process.exit(3)
}
console.log(JSON.stringify(r.result?.value !== undefined ? r.result.value : r, null, 2))
